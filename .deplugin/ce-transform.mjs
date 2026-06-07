#!/usr/bin/env node
// ce-transform.mjs — pure-function transform: CE plugin -> self-contained skills (NO agents/ dir).
// Deterministic. No LLM. Re-runnable for upstream sync (regenerate, don't patch).
//
// Usage: node ce-transform.mjs <SRC_PLUGIN_DIR> <OUT_DIR> [skill1 skill2 ...]
//   SRC_PLUGIN_DIR = .../compound-engineering/<version>  (contains skills/ and agents/)
//   OUT_DIR        = where to emit skills-only output
//   [skills]       = optional subset; default = all skills
//
// Per skill: copy skill dir -> compute agent closure by scanning for the 43 agent names ->
//   embed each closure agent body into references/personas/<name>.md (with a prose constraint
//   header generated from its frontmatter) -> inject ONE convention block at top of SKILL.md ->
//   guarantee NO agents/ dir -> emit manifest. Then run the validation gate.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [, , SRC, OUT, ...only] = process.argv;
if (!SRC || !OUT) { console.error('usage: node ce-transform.mjs <SRC_PLUGIN_DIR> <OUT_DIR> [skills...]'); process.exit(2); }

const SKILLS_DIR = path.join(SRC, 'skills');
const AGENTS_DIR = path.join(SRC, 'agents');

// CE_EXCLUDE: comma-separated skills to drop (stable across upstream additions).
// CE_MANIFEST: where to write the provenance manifest (default: OUT/transform-manifest.json).
const EXCLUDE = (process.env.CE_EXCLUDE || '').split(',').map(s => s.trim()).filter(Boolean);
const MANIFEST = process.env.CE_MANIFEST || path.join(OUT, 'transform-manifest.json');

const CONVENTION_MARKER = '<!-- ce-deplugin:convention -->';
const CONVENTION = `${CONVENTION_MARKER}
## Self-contained persona dispatch (no \`agents/\` directory)

This skill is self-contained: its specialist personas live under \`references/personas/\` and it depends on **no** registered subagent and **no** \`agents/\` directory.

Whenever the steps below name a \`ce-*\` specialist — e.g. \`Task ce-<specialist>(args)\`, "dispatch \`ce-<specialist>\`", or a persona-catalog entry:
1. Read \`references/personas/<name>.md\`.
2. Launch a subagent via the Task/Agent tool, passing that file's **entire contents as the subagent's instructions**, then append the specific args/context the step gives.
3. \`subagent_type\`: use **\`Explore\`** if the persona's "Operating constraints" line says read-only; otherwise **\`general-purpose\`**.
4. Honor the persona's "Operating constraints" line in your instruction to the subagent (tool/model limits are NOT otherwise enforced once de-plugin-ified).
Dispatch independent personas in parallel from the **main thread**; personas never spawn further subagents.
`;

// ---- helpers ----
async function listDir(d) { try { return await fs.readdir(d); } catch { return []; } }
async function walk(dir, acc = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc); else acc.push(p);
  }
  return acc;
}
async function copyDir(src, dst) { await fs.cp(src, dst, { recursive: true }); }
function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12); }

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: md };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (mm) fm[mm[1]] = mm[2].replace(/^["']|["']$/g, '').trim();
  }
  return { fm, body: m[2] };
}
function isReadOnly(toolsLine) {
  if (!toolsLine) return false;               // no tools => inherits ALL (incl Write/Task) => general-purpose
  return !/(Write|Edit|NotebookEdit|MultiEdit)/.test(toolsLine);
}

async function main() {
  const agentFiles = (await listDir(AGENTS_DIR)).filter(f => f.endsWith('.md'));
  const AGENT_NAMES = agentFiles.map(f => f.replace(/\.md$/, ''));
  // longest-first so substring names don't shadow (none do here, but safe)
  const sortedNames = [...AGENT_NAMES].sort((a, b) => b.length - a.length);
  const agentCache = {};
  for (const n of AGENT_NAMES) agentCache[n] = await fs.readFile(path.join(AGENTS_DIR, `${n}.md`), 'utf8');

  let skills = (await listDir(SKILLS_DIR)).filter(s => !s.startsWith('.'));
  if (only.length) skills = skills.filter(s => only.includes(s));
  if (EXCLUDE.length) skills = skills.filter(s => !EXCLUDE.includes(s));

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const manifest = { generatedFrom: SRC, agentNames: AGENT_NAMES, skills: {} };
  const gateErrors = [];

  for (const skill of skills) {
    const srcSkill = path.join(SKILLS_DIR, skill);
    const outSkill = path.join(OUT, skill);
    await copyDir(srcSkill, outSkill);

    // guarantee no agents/ dir leaked in
    await fs.rm(path.join(outSkill, 'agents'), { recursive: true, force: true });

    // compute closure: scan every output file for agent names
    const files = await walk(outSkill);
    const blob = (await Promise.all(files.map(f => fs.readFile(f, 'utf8').catch(() => '')))).join('\n');
    const closure = sortedNames.filter(n => new RegExp(`\\b${n}\\b`).test(blob));

    // embed personas
    const personasDir = path.join(outSkill, 'references', 'personas');
    if (closure.length) await fs.mkdir(personasDir, { recursive: true });
    const personaInfo = {};
    for (const n of closure) {
      const { fm, body } = parseFrontmatter(agentCache[n]);
      const ro = isReadOnly(fm.tools);
      personaInfo[n] = { readOnly: ro, model: fm.model || 'inherit', tools: fm.tools || '(inherits all)' };
      const header =
        `> **Operating constraints (de-plugin-ified persona \`${n}\`).** ` +
        `Read-only: ${ro ? 'YES — dispatch as subagent_type: Explore' : 'no — dispatch as subagent_type: general-purpose'}. ` +
        `Allowed tools: ${fm.tools || '(originally inherited all)'}. Model: ${fm.model || 'inherit'}. ` +
        `Stay strictly within these limits; they are not enforced by the runtime once de-plugin-ified.\n\n`;
      await fs.writeFile(path.join(personasDir, `${n}.md`), header + body);
    }

    // inject convention block at top of SKILL.md (idempotent)
    const skillMdPath = path.join(outSkill, 'SKILL.md');
    let md = await fs.readFile(skillMdPath, 'utf8');
    if (!md.includes(CONVENTION_MARKER) && closure.length) {
      const fmEnd = md.indexOf('\n---', 3);
      if (md.startsWith('---') && fmEnd !== -1) {
        const cut = fmEnd + 4; // after closing '---\n'
        md = md.slice(0, cut) + '\n' + CONVENTION + '\n' + md.slice(cut);
      } else {
        md = CONVENTION + '\n' + md;
      }
      await fs.writeFile(skillMdPath, md);
    }

    // ---- validation gate (per skill) ----
    if (closure.length && !md.includes(CONVENTION_MARKER)) gateErrors.push(`${skill}: convention block missing`);
    for (const n of closure) {
      try { await fs.access(path.join(personasDir, `${n}.md`)); }
      catch { gateErrors.push(`${skill}: missing persona file for ${n}`); }
    }
    // orphan personas (persona present but name never appears in skill text)
    for (const n of closure) {
      if (!new RegExp(`\\b${n}\\b`).test(md + blob)) gateErrors.push(`${skill}: orphan persona ${n}`);
    }
    // no agents/ dir
    try { await fs.access(path.join(outSkill, 'agents')); gateErrors.push(`${skill}: agents/ dir present!`); } catch {}

    manifest.skills[skill] = {
      sourceHash: sha1(blob),
      closure,
      personas: personaInfo,
      readOnlyCount: closure.filter(n => personaInfo[n].readOnly).length,
      writeCount: closure.filter(n => !personaInfo[n].readOnly).length,
    };
  }

  await fs.mkdir(path.dirname(MANIFEST), { recursive: true });
  await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2));

  // report
  const lines = [];
  lines.push(`Transformed ${Object.keys(manifest.skills).length} skill(s) -> ${OUT}`);
  for (const [s, m] of Object.entries(manifest.skills)) {
    lines.push(`  ${s}: closure=${m.closure.length} (readonly→Explore=${m.readOnlyCount}, write→general-purpose=${m.writeCount}) hash=${m.sourceHash}`);
  }
  lines.push('');
  lines.push(gateErrors.length ? `GATE FAIL (${gateErrors.length}):\n  - ${gateErrors.join('\n  - ')}` : 'GATE PASS ✅  (no agents/ dir, every dispatch name has a persona, no orphans, convention injected)');
  console.log(lines.join('\n'));
  process.exit(gateErrors.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(3); });
