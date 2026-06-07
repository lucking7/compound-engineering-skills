#!/usr/bin/env node
// ce-validate.mjs — standalone STRUCTURAL gate on the committed skills/ tree.
// No upstream needed (this is the CI gate run on every push/PR).
// Asserts the de-plugin-ify invariants against transform-manifest.json + the on-disk skills/.
//
// Usage: node .deplugin/ce-validate.mjs [REPO_ROOT]   (default: repo root inferred from this file)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = process.argv[2] || path.resolve(HERE, '..');
const SKILLS = path.join(REPO, 'skills');
const MANIFEST = path.join(REPO, 'transform-manifest.json');
const MARKER = '<!-- ce-deplugin:convention -->';

async function walk(dir, acc = []) {
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { acc.push({ dir: p }); await walk(p, acc); } else acc.push({ file: p });
  }
  return acc;
}
const eqSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

const errors = [];
const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
const agentNames = manifest.agentNames || [];   // full upstream agent universe (for dangling-ref detection)

// 1) no agents/ directory anywhere under skills/
for (const n of await walk(SKILLS)) {
  if (n.dir && path.basename(n.dir) === 'agents') errors.push(`agents/ dir present: ${path.relative(REPO, n.dir)}`);
}

// 2) on-disk skills match manifest skills
const onDisk = (await fs.readdir(SKILLS, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
for (const s of onDisk) if (!manifest.skills[s]) errors.push(`skill on disk but not in manifest: ${s}`);

// 3) per-skill invariants
for (const [skill, m] of Object.entries(manifest.skills)) {
  const skillDir = path.join(SKILLS, skill);
  const skillMd = path.join(skillDir, 'SKILL.md');
  let md = '';
  try { md = await fs.readFile(skillMd, 'utf8'); } catch { errors.push(`${skill}: missing SKILL.md`); continue; }
  const personasDir = path.join(skillDir, 'references', 'personas');
  let personaFiles = [];
  try { personaFiles = (await fs.readdir(personasDir)).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')); } catch {}

  const closure = m.closure || [];
  // convention block present iff there is a closure
  if (closure.length && !md.includes(MARKER)) errors.push(`${skill}: convention block missing`);
  if (!closure.length && personaFiles.length) errors.push(`${skill}: personas present but manifest closure empty`);
  // persona files exactly == closure set
  if (!eqSet(personaFiles, closure)) errors.push(`${skill}: persona files ${JSON.stringify(personaFiles.sort())} != closure ${JSON.stringify([...closure].sort())}`);
  // each persona name appears in skill text somewhere (no orphan)
  const blob = md; // SKILL.md mentions; closure was derived from full skill text, SKILL.md is where dispatch lives
  for (const n of closure) {
    const inSkill = blob.includes(n) || (await walk(skillDir)).some(() => false);
    if (!blob.includes(n)) {
      // fall back: scan all skill files (some dispatch lives in references/*.md)
      const files = (await walk(skillDir)).filter(x => x.file && !x.file.includes('/personas/')).map(x => x.file);
      const texts = await Promise.all(files.map(f => fs.readFile(f, 'utf8').catch(() => '')));
      if (!texts.some(t => t.includes(n))) errors.push(`${skill}: orphan persona ${n} (name not referenced in skill text)`);
    }
  }
  // each persona file carries the Operating-constraints header
  for (const n of personaFiles) {
    const body = await fs.readFile(path.join(personasDir, `${n}.md`), 'utf8');
    if (!body.includes('Operating constraints')) errors.push(`${skill}: persona ${n} missing Operating-constraints header`);
  }

  // no DANGLING agent reference: any real upstream agent name appearing in the skill's
  // (non-persona) text must have a persona. Catches hand-tampering or a transform-closure miss.
  if (agentNames.length) {
    const nonPersona = (await walk(skillDir))
      .filter(x => x.file && !x.file.includes(`${path.sep}personas${path.sep}`)).map(x => x.file);
    const text = (await Promise.all(nonPersona.map(f => fs.readFile(f, 'utf8').catch(() => '')))).join('\n');
    for (const a of agentNames) {
      if (!closure.includes(a) && new RegExp(`\\b${a}\\b`).test(text)) {
        errors.push(`${skill}: dangling agent reference '${a}' (named in skill text but no persona)`);
      }
    }
  }
}

const total = Object.keys(manifest.skills).length;
if (errors.length) {
  console.error(`GATE FAIL (${errors.length}) on ${total} skills:\n  - ${errors.join('\n  - ')}`);
  process.exit(1);
}
console.log(`GATE PASS ✅  ${total} skills validated (no agents/ dir, persona<->closure parity, convention injected, no orphans, constraint headers present)`);
