#!/usr/bin/env node
// ce-validate.mjs — standalone STRUCTURAL + INTEGRITY gate on the committed skills/ tree.
// No upstream needed (this is the CI gate run on every push/PR).
// Asserts the de-plugin-ify invariants against transform-manifest.json + the on-disk skills/:
//   1. no agents/ directory anywhere under skills/
//   2. on-disk skills == manifest skills (both directions), each with a SKILL.md
//   3. convention block present iff the closure is non-empty
//   4. persona files exactly == the manifest closure set
//   5. every persona file carries the Operating-constraints header
//   6. no ORPHAN persona: each closure member is referenced from the skill's
//      non-persona text or from another persona file (not only itself)
//   7. no DANGLING agent reference: any upstream agent name appearing in the skill's
//      non-persona text OR in any persona body must be in the closure
//   8. outputHash recomputed from disk == manifest (detects hand-edits of build output)
//
// Usage: node .deplugin/ce-validate.mjs [REPO_ROOT]   (default: repo root inferred from this file)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { walkFiles, walkDirs, hashTree, eqSet, EXPECTED_UPSTREAM_REPO } from './ce-lib.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = process.argv[2] || path.resolve(HERE, '..');
const SKILLS = path.join(REPO, 'skills');
const MANIFEST = path.join(REPO, 'transform-manifest.json');
const MARKER = '<!-- ce-deplugin:convention -->';

// an override is never silent in a real run (fixture-test escape hatch only — never set in CI)
if (process.env.CE_EXPECTED_UPSTREAM_REPO) {
  console.error(`NOTE: trust anchor overridden: CE_EXPECTED_UPSTREAM_REPO=${process.env.CE_EXPECTED_UPSTREAM_REPO}`);
}

const errors = [];
const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));

// 0) trust anchor: the provenance must name the one expected upstream. A manifest that
//    points anywhere else (or nowhere) is treated as forged, not merely unprovenanced —
//    otherwise redirecting `upstream.repo` to a fork would pass both gates.
if ((manifest.upstream || {}).repo !== EXPECTED_UPSTREAM_REPO) {
  errors.push(`manifest.upstream.repo is '${manifest.upstream?.repo ?? '(missing)'}' — expected '${EXPECTED_UPSTREAM_REPO}'`);
}

const agentNames = manifest.agentNames || [];   // full upstream agent universe
const nameRe = {};
for (const n of agentNames) nameRe[n] = new RegExp(`\\b${n}\\b`);

// 1) no agents/ directory anywhere under skills/
for (const d of await walkDirs(SKILLS)) {
  if (path.basename(d) === 'agents') errors.push(`agents/ dir present: ${path.relative(REPO, d)}`);
}

// 2) on-disk skills == manifest skills (both directions); skills/ holds ONLY skill dirs —
//    a stray file planted directly under skills/ belongs to no skill, so no outputHash covers it
const skillEnts = await fs.readdir(SKILLS, { withFileTypes: true });
for (const e of skillEnts) {
  // dotfiles and *.tmp are gitignored local noise (.DS_Store, editor scratch), not tamper —
  // flagging them would fail the LOCAL gate on files git considers nonexistent
  if (e.name.startsWith('.') || e.name.endsWith('.tmp')) continue;
  if (!e.isDirectory()) errors.push(`stray file directly under skills/: ${e.name} (skills/ holds only generated skill dirs)`);
}
const onDisk = skillEnts.filter(e => e.isDirectory()).map(e => e.name);
for (const s of onDisk) if (!manifest.skills[s]) errors.push(`skill on disk but not in manifest: ${s}`);
for (const s of Object.keys(manifest.skills)) if (!onDisk.includes(s)) errors.push(`skill in manifest but not on disk: ${s}`);

// 3-8) per-skill invariants
for (const [skill, m] of Object.entries(manifest.skills)) {
  const skillDir = path.join(SKILLS, skill);
  let md = '';
  try { md = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'); }
  catch { errors.push(`${skill}: missing SKILL.md`); continue; }

  const personasDir = path.join(skillDir, 'references', 'personas');
  let personaFiles = [];
  try { personaFiles = (await fs.readdir(personasDir)).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')); } catch {}
  const closure = m.closure || [];

  // convention block present iff there is a closure
  if (closure.length && !md.includes(MARKER)) errors.push(`${skill}: convention block missing`);
  if (!closure.length && md.includes(MARKER)) errors.push(`${skill}: convention block present but closure empty`);

  // persona files exactly == closure set
  if (!eqSet(personaFiles, closure)) {
    errors.push(`${skill}: persona files ${JSON.stringify([...personaFiles].sort())} != closure ${JSON.stringify([...closure].sort())}`);
  }

  // gather text: non-persona skill files, and each persona body separately
  const allFiles = await walkFiles(skillDir);
  const isPersonaFile = f => f.includes(`${path.sep}personas${path.sep}`);
  const nonPersonaText = (await Promise.all(
    allFiles.filter(f => !isPersonaFile(f)).map(f => fs.readFile(f, 'utf8').catch(() => ''))
  )).join('\n');
  const personaText = {};
  for (const n of personaFiles) {
    personaText[n] = await fs.readFile(path.join(personasDir, `${n}.md`), 'utf8').catch(() => '');
    if (!personaText[n].includes('Operating constraints')) errors.push(`${skill}: persona ${n} missing Operating-constraints header`);
  }

  // 6) orphan: closure member must be referenced outside its own persona file
  for (const n of closure) {
    const referenced = (nameRe[n] || new RegExp(`\\b${n}\\b`)).test(nonPersonaText)
      || personaFiles.some(p => p !== n && nameRe[n]?.test(personaText[p] || ''));
    if (!referenced) errors.push(`${skill}: orphan persona ${n} (referenced only by itself, if at all)`);
  }

  // 7) dangling: any universe agent name in non-persona OR persona text must have a persona.
  //    (Persona text matters: an embedded persona that names a missing specialist would
  //    send the model to a file that does not exist.)
  for (const a of agentNames) {
    if (closure.includes(a)) continue;
    const inNonPersona = nameRe[a].test(nonPersonaText);
    const inPersona = personaFiles.some(p => nameRe[a].test(personaText[p] || ''));
    if (inNonPersona || inPersona) {
      errors.push(`${skill}: dangling agent reference '${a}' (named in ${inNonPersona ? 'skill text' : 'a persona body'} but no persona file)`);
    }
  }

  // 8) build-output integrity: recompute the final-tree hash from disk
  if (m.outputHash) {
    const got = await hashTree(skillDir);
    if (got !== m.outputHash) errors.push(`${skill}: outputHash mismatch (manifest ${m.outputHash}, disk ${got}) — skills/ is generated, do not hand-edit`);
  } else {
    errors.push(`${skill}: manifest entry has no outputHash (regenerate with the current transform)`);
  }
}

const total = Object.keys(manifest.skills).length;
if (errors.length) {
  console.error(`GATE FAIL (${errors.length}) on ${total} skills:\n  - ${errors.join('\n  - ')}`);
  process.exit(1);
}
const up = manifest.upstream || {};
console.log(`GATE PASS ✅  ${total} skills validated (provenance anchored to ${EXPECTED_UPSTREAM_REPO}, no agents/ dir or stray files, persona<->closure parity, convention iff closure, no orphans/danglings incl. persona text, output hashes match)`
  + (up.tag ? `  [upstream ${up.tag} @ ${String(up.commit).slice(0, 12)}]` : ''));
