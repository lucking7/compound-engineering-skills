#!/usr/bin/env node
// ce-transform.mjs — pure-function transform: CE plugin -> self-contained skills (NO agents/ dir).
// Deterministic. No LLM. Re-runnable for upstream sync (regenerate, don't patch).
//
// Usage: node ce-transform.mjs <SRC_PLUGIN_DIR> <OUT_DIR> [skill1 skill2 ...]
//   SRC_PLUGIN_DIR = .../compound-engineering/<version>  (contains skills/ and agents/)
//   OUT_DIR        = where to emit skills-only output
//   [skills]       = optional subset; default = all skills
//
// Env:
//   CE_EXCLUDE          comma-separated skills to drop (default: .deplugin/ce-exclude.txt)
//   CE_MANIFEST         manifest path (default: OUT/transform-manifest.json)
//   CE_UPSTREAM_REPO / CE_UPSTREAM_TAG / CE_UPSTREAM_COMMIT
//                       provenance stamped into the manifest (set by ce-sync.sh)
//
// Per skill: copy skill dir -> compute the TRANSITIVE agent closure (skill text, then
//   fixpoint over the bodies of referenced agents) -> embed each closure agent into
//   references/personas/<name>.md with a harness-neutral constraint header -> inject ONE
//   harness-neutral convention block at top of SKILL.md -> guarantee NO agents/ dir ->
//   record sourceHash (pre-embedding), outputHash (final tree) and per-persona content
//   hashes in the manifest. Then run the validation gate.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { sha1, walkFiles, hashTree, parseFrontmatter, readDefaultExclude } from './ce-lib.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const [, , SRC, OUT, ...only] = process.argv;
if (!SRC || !OUT) { console.error('usage: node ce-transform.mjs <SRC_PLUGIN_DIR> <OUT_DIR> [skills...]'); process.exit(2); }

const SKILLS_DIR = path.join(SRC, 'skills');
const AGENTS_DIR = path.join(SRC, 'agents');
const MANIFEST = process.env.CE_MANIFEST || path.join(OUT, 'transform-manifest.json');

const CONVENTION_MARKER = '<!-- ce-deplugin:convention -->';
// Harness-neutral by design: these skills serve multiple agent CLIs (Claude Code,
// opencode, ...) whose subagent systems differ. The dispatch ladder degrades
// gracefully: subagent tool if the harness has one, inline adoption otherwise.
// Never make a single CLI's tool names the only path.
const CONVENTION = `${CONVENTION_MARKER}
## Self-contained persona dispatch (no \`agents/\` directory)

This skill is self-contained: its specialist personas live under \`references/personas/\` and it depends on **no** registered subagent and **no** \`agents/\` directory.

Whenever the steps below name a \`ce-*\` specialist — e.g. \`Task ce-<specialist>(args)\`, "dispatch \`ce-<specialist>\`", or a persona-catalog entry:
1. Read \`references/personas/<name>.md\`.
2. **If your harness can launch subagents** (a Task/agent-dispatch tool or equivalent), launch one, passing that file's **entire contents as the subagent's instructions**, then append the specific args/context the step gives. When the persona's "Operating constraints" line says read-only, prefer a read-only/explore-type subagent if your harness offers one; otherwise use a general-purpose subagent.
3. **If your harness cannot launch subagents**, apply the persona inline: adopt the persona file as your own instructions for that step, complete it, then return to this skill's flow.
4. Honor the persona's "Operating constraints" line in either mode (tool/model limits are NOT otherwise enforced once de-plugin-ified).
Dispatch independent personas in parallel when your harness supports it; personas never spawn further subagents.
`;

async function listDir(d) { try { return (await fs.readdir(d)).sort(); } catch { return []; } }
async function copyDir(src, dst) { await fs.cp(src, dst, { recursive: true }); }

function isReadOnly(toolsLine) {
  if (!toolsLine) return false;               // no tools => inherits ALL (incl Write/Task) => general-purpose
  return !/(Write|Edit|NotebookEdit|MultiEdit)/.test(toolsLine);
}

function personaHeader(name, fm, readOnly) {
  const mode = readOnly
    ? 'YES — prefer a read-only/explore-type subagent if your harness offers one (e.g. Claude Code `Explore`), else a general-purpose subagent with write tools forbidden'
    : 'no — use a general-purpose subagent (or apply inline if your harness has no subagents)';
  return (
    `> **Operating constraints (de-plugin-ified persona \`${name}\`).** ` +
    `Read-only: ${mode}. ` +
    `Allowed tools: ${fm.tools || '(originally inherited all)'}. Model: ${fm.model || 'inherit'}. ` +
    `Stay strictly within these limits; they are not enforced by the runtime once de-plugin-ified.\n\n`
  );
}

async function main() {
  const EXCLUDE = process.env.CE_EXCLUDE !== undefined
    ? process.env.CE_EXCLUDE.split(',').map(s => s.trim()).filter(Boolean)
    : await readDefaultExclude(HERE);

  const agentFiles = (await listDir(AGENTS_DIR)).filter(f => f.endsWith('.md'));
  const AGENT_NAMES = agentFiles.map(f => f.replace(/\.md$/, ''));
  const nameRe = {};
  for (const n of AGENT_NAMES) nameRe[n] = new RegExp(`\\b${n}\\b`);

  const agentRaw = {};    // full upstream file (identity / persona hash)
  const agentParsed = {}; // { fm, body, errors }
  const fmErrors = [];    // [name, error] — folded into the gate below (unreferenced agents too)
  for (const n of AGENT_NAMES) {
    agentRaw[n] = await fs.readFile(path.join(AGENTS_DIR, `${n}.md`), 'utf8');
    agentParsed[n] = parseFrontmatter(agentRaw[n]);
    for (const e of agentParsed[n].errors) fmErrors.push([n, e]);
  }

  let skills = (await listDir(SKILLS_DIR)).filter(s => !s.startsWith('.'));
  if (only.length) skills = skills.filter(s => only.includes(s));
  if (EXCLUDE.length) skills = skills.filter(s => !EXCLUDE.includes(s));

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const manifest = {
    upstream: {
      repo: process.env.CE_UPSTREAM_REPO || null,
      tag: process.env.CE_UPSTREAM_TAG || null,
      commit: process.env.CE_UPSTREAM_COMMIT || null,
    },
    agentNames: AGENT_NAMES,
    skills: {},
  };
  const gateErrors = [];
  const allClosures = new Set();

  for (const skill of skills) {
    const srcSkill = path.join(SKILLS_DIR, skill);
    const outSkill = path.join(OUT, skill);
    await copyDir(srcSkill, outSkill);

    // guarantee no agents/ dir leaked in
    await fs.rm(path.join(outSkill, 'agents'), { recursive: true, force: true });

    // sourceHash: the upstream skill tree, pre-embedding (sorted, path-aware)
    const sourceHash = await hashTree(outSkill);

    // TRANSITIVE closure: seed from all skill text, then fixpoint over the bodies
    // of referenced agents (a persona that names another agent pulls it in too —
    // otherwise the embedded persona would point at a file that does not exist).
    const files = await walkFiles(outSkill);
    const blob = (await Promise.all(files.map(f => fs.readFile(f, 'utf8').catch(() => '')))).join('\n');
    const closure = new Set(AGENT_NAMES.filter(n => nameRe[n].test(blob)));
    for (let grew = true; grew;) {
      grew = false;
      for (const n of [...closure]) {
        for (const m of AGENT_NAMES) {
          if (!closure.has(m) && nameRe[m].test(agentParsed[n].body)) { closure.add(m); grew = true; }
        }
      }
    }
    const closureList = [...closure].sort();
    for (const n of closureList) allClosures.add(n);

    // gate: a closure agent with unparseable frontmatter must fail the build,
    // not silently degrade its constraints
    for (const n of closureList) {
      for (const e of agentParsed[n].errors) gateErrors.push(`${skill}: closure agent ${n} has ${e}`);
    }

    // embed personas
    const personasDir = path.join(outSkill, 'references', 'personas');
    if (closureList.length) await fs.mkdir(personasDir, { recursive: true });
    const personaInfo = {};
    for (const n of closureList) {
      const { fm, body } = agentParsed[n];
      const ro = isReadOnly(fm.tools);
      personaInfo[n] = { readOnly: ro, model: fm.model || 'inherit', tools: fm.tools || '(inherits all)', hash: sha1(agentRaw[n]) };
      await fs.writeFile(path.join(personasDir, `${n}.md`), personaHeader(n, fm, ro) + body);
    }

    // inject convention block at top of SKILL.md (idempotent, only when needed)
    const skillMdPath = path.join(outSkill, 'SKILL.md');
    let md = await fs.readFile(skillMdPath, 'utf8');
    if (!md.includes(CONVENTION_MARKER) && closureList.length) {
      const fmEnd = md.indexOf('\n---', 3);
      if (md.startsWith('---') && fmEnd !== -1) {
        const cut = fmEnd + 4; // after closing '---\n'
        md = md.slice(0, cut) + '\n' + CONVENTION + '\n' + md.slice(cut);
      } else {
        md = CONVENTION + '\n' + md;
      }
      await fs.writeFile(skillMdPath, md);
    }

    // ---- validation gate (per skill, on the fresh output) ----
    if (closureList.length && !md.includes(CONVENTION_MARKER)) gateErrors.push(`${skill}: convention block missing`);
    for (const n of closureList) {
      try { await fs.access(path.join(personasDir, `${n}.md`)); }
      catch { gateErrors.push(`${skill}: missing persona file for ${n}`); }
    }
    try { await fs.access(path.join(outSkill, 'agents')); gateErrors.push(`${skill}: agents/ dir present!`); } catch {}
    try { await fs.access(skillMdPath); } catch { gateErrors.push(`${skill}: missing SKILL.md`); }

    manifest.skills[skill] = {
      sourceHash,
      outputHash: await hashTree(outSkill),
      closure: closureList,
      personas: personaInfo,
      readOnlyCount: closureList.filter(n => personaInfo[n].readOnly).length,
      writeCount: closureList.filter(n => !personaInfo[n].readOnly).length,
    };
  }

  // a malformed agent OUTSIDE every closure must also fail loudly — today it ships nothing,
  // but it would silently mis-embed the day a skill starts referencing it
  for (const [n, e] of fmErrors) {
    if (!allClosures.has(n)) gateErrors.push(`agent ${n} (unreferenced by any skill) has ${e}`);
  }

  await fs.mkdir(path.dirname(MANIFEST), { recursive: true });
  await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

  // report
  const lines = [];
  lines.push(`Transformed ${Object.keys(manifest.skills).length} skill(s) -> ${OUT}`);
  for (const [s, m] of Object.entries(manifest.skills)) {
    lines.push(`  ${s}: closure=${m.closure.length} (readonly=${m.readOnlyCount}, write=${m.writeCount}) src=${m.sourceHash} out=${m.outputHash}`);
  }
  lines.push('');
  lines.push(gateErrors.length
    ? `GATE FAIL (${gateErrors.length}):\n  - ${gateErrors.join('\n  - ')}`
    : 'GATE PASS ✅  (no agents/ dir, every closure agent embedded, convention injected, ALL agent frontmatter — referenced or not — parsed cleanly)');
  console.log(lines.join('\n'));
  process.exit(gateErrors.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(3); });
