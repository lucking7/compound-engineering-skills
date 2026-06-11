#!/usr/bin/env node
// ce-classify.mjs — deterministic risk tier for an upstream sync.
// Compares the PREVIOUS (committed) manifest against the freshly-generated one and decides:
//   nochange  — nothing changed
//   automerge — ONLY content changed: skill body text, persona body text, or the emitted
//               output (closure sets identical, no skill add/remove) -> safe to auto-merge
//   pr        — ANY structural signal (skill added/removed, an agent added/removed/renamed
//               in any closure) -> open PR for human review
//
// Content comparison covers sourceHash (upstream skill files), per-persona hashes
// (upstream agent files — WITHOUT this, agent-body edits would classify as `nochange`
// and be silently dropped by the sync), and outputHash (the emitted tree).
//
// Usage: node .deplugin/ce-classify.mjs <oldManifest.json> <newManifest.json>
// Emits JSON to stdout and, if $GITHUB_OUTPUT is set, writes decision/summary for the workflow.

import { promises as fs } from 'node:fs';

const [, , oldPath, newPath] = process.argv;
if (!oldPath || !newPath) { console.error('usage: ce-classify.mjs <oldManifest> <newManifest>'); process.exit(2); }

const load = async p => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return { skills: {} }; } };
const old = await load(oldPath);
const neu = await load(newPath);
const oldS = old.skills || {}, newS = neu.skills || {};
const eqSet = (a = [], b = []) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
// stable content signature; tolerates old-schema manifests missing the newer hash fields
const contentSig = (s = {}) => JSON.stringify([
  s.sourceHash ?? null,
  s.outputHash ?? null,
  Object.entries(s.personas || {}).map(([k, v]) => [k, v.hash ?? null]).sort(),
]);

const added = Object.keys(newS).filter(s => !oldS[s]);
const removed = Object.keys(oldS).filter(s => !newS[s]);
const closureChanged = [];   // structural
const contentChanged = [];   // body-only (skill text, persona text, or emitted output)
for (const s of Object.keys(newS)) {
  if (!oldS[s]) continue;
  if (!eqSet(oldS[s].closure, newS[s].closure)) closureChanged.push(s);
  else if (contentSig(oldS[s]) !== contentSig(newS[s])) contentChanged.push(s);
}

const structural = added.length || removed.length || closureChanged.length;
const decision = structural ? 'pr' : (contentChanged.length ? 'automerge' : 'nochange');

const reasons = [];
if (added.length) reasons.push(`skills added: ${added.join(', ')}`);
if (removed.length) reasons.push(`skills removed: ${removed.join(', ')}`);
if (closureChanged.length) reasons.push(`agent-closure changed (agent add/remove/rename): ${closureChanged.join(', ')}`);
if (contentChanged.length) reasons.push(`content-only edits: ${contentChanged.join(', ')}`);
if (!reasons.length) reasons.push('no changes');

const out = { decision, added, removed, closureChanged, contentChanged, reasons };
console.log(JSON.stringify(out, null, 2));

if (process.env.GITHUB_OUTPUT) {
  const summary = reasons.join('; ').replace(/\n/g, ' ');
  await fs.appendFile(process.env.GITHUB_OUTPUT, `decision=${decision}\nsummary=${summary}\n`);
}
