#!/usr/bin/env node
// ce-reproduce.mjs — reproducible-build gate.
// Proves the committed skills/ tree IS the pure function of the pinned upstream:
// clone the upstream repo at the commit recorded in transform-manifest.json, re-run
// the transform with the current toolchain, and assert the output is byte-identical
// to what is committed (skills tree AND manifest). Any hand-edit — even one that
// also forged the manifest hashes — fails here.
//
// Needs network (git clone). The structural gate (ce-validate.mjs) covers the
// no-network case.
//
// Usage: node .deplugin/ce-reproduce.mjs [REPO_ROOT]

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { walkFiles, EXPECTED_UPSTREAM_REPO } from './ce-lib.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = process.argv[2] || path.resolve(HERE, '..');
const MANIFEST = path.join(REPO, 'transform-manifest.json');

const fail = msg => { console.error(`REPRODUCE FAIL: ${msg}`); process.exit(1); };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
const { repo, tag, commit } = manifest.upstream || {};
if (!repo || !tag || !commit) fail('manifest.upstream is incomplete (repo/tag/commit) — regenerate via ce-sync.sh');
// trust anchor: never reproduce from a repo the manifest merely *claims* — a forged manifest
// pointing at a look-alike fork must fail here, not be laundered into a PASS.
if (repo !== EXPECTED_UPSTREAM_REPO) fail(`manifest.upstream.repo is '${repo}' — expected '${EXPECTED_UPSTREAM_REPO}'; refusing to reproduce from an unexpected upstream`);
// clone-URL override exists ONLY so the fixture tests can point at a local file:// repo;
// an override is never silent in a real run
const UPSTREAM_URL = process.env.CE_UPSTREAM_URL || `https://github.com/${repo}`;
if (process.env.CE_UPSTREAM_URL) console.error(`NOTE: upstream clone URL overridden: CE_UPSTREAM_URL=${process.env.CE_UPSTREAM_URL}`);
if (process.env.CE_EXPECTED_UPSTREAM_REPO) console.error(`NOTE: trust anchor overridden: CE_EXPECTED_UPSTREAM_REPO=${process.env.CE_EXPECTED_UPSTREAM_REPO}`);

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ce-reproduce-'));
try {
  // 1) clone the pinned upstream and verify the commit
  const clone = run('git', ['clone', '--depth', '1', '--branch', tag, UPSTREAM_URL, path.join(work, 'up')]);
  if (clone.status !== 0) fail(`clone of ${repo}@${tag} failed:\n${clone.stderr}`);
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: path.join(work, 'up') }).stdout.trim();
  if (head !== commit) fail(`upstream tag ${tag} now points at ${head}, manifest pins ${commit} — tag moved?`);

  const src = path.join(work, 'up', 'plugins', 'compound-engineering');
  try { await fs.access(path.join(src, 'skills')); await fs.access(path.join(src, 'agents')); }
  catch { fail('upstream layout changed (no plugins/compound-engineering/{skills,agents})'); }

  // 2) re-run the transform with the current toolchain (default exclude list)
  const outDir = path.join(work, 'skills');
  const outManifest = path.join(work, 'transform-manifest.json');
  const env = { ...process.env, CE_MANIFEST: outManifest, CE_UPSTREAM_REPO: repo, CE_UPSTREAM_TAG: tag, CE_UPSTREAM_COMMIT: commit };
  delete env.CE_EXCLUDE; // always use the committed default exclude list
  const tr = run('node', [path.join(HERE, 'ce-transform.mjs'), src, outDir], { env });
  process.stdout.write(tr.stdout || '');
  if (tr.status !== 0) fail(`transform failed:\n${tr.stderr}`);

  // 3) byte-compare the regenerated tree against the committed one
  const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
  const committed = new Map();
  for (const f of await walkFiles(path.join(REPO, 'skills'))) committed.set(rel(path.join(REPO, 'skills'), f), f);
  const rebuilt = new Map();
  for (const f of await walkFiles(outDir)) rebuilt.set(rel(outDir, f), f);

  const diffs = [];
  for (const [r] of committed) if (!rebuilt.has(r)) diffs.push(`only in committed tree: ${r}`);
  for (const [r] of rebuilt) if (!committed.has(r)) diffs.push(`only in rebuilt tree:   ${r}`);
  for (const [r, f] of committed) {
    if (!rebuilt.has(r)) continue;
    const [a, b] = await Promise.all([fs.readFile(f, 'utf8'), fs.readFile(rebuilt.get(r), 'utf8')]);
    if (a !== b) diffs.push(`content differs: ${r}`);
  }
  const [mA, mB] = await Promise.all([fs.readFile(MANIFEST, 'utf8'), fs.readFile(outManifest, 'utf8')]);
  if (mA !== mB) diffs.push('transform-manifest.json differs');

  if (diffs.length) fail(`committed output is NOT the pure function of ${repo}@${tag} (${commit.slice(0, 12)}):\n  - ${diffs.slice(0, 50).join('\n  - ')}${diffs.length > 50 ? `\n  … and ${diffs.length - 50} more` : ''}`);
  console.log(`REPRODUCE PASS ✅  skills/ + manifest are byte-identical to transform(${repo}@${tag} @ ${commit.slice(0, 12)})`);
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
