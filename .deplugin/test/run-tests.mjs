#!/usr/bin/env node
// run-tests.mjs — fixture-based tests for the .deplugin toolchain (the only hand-written
// code in this repo). Covers: transitive closure, persona embedding, harness-neutral
// injected text, frontmatter parsing (block lists, flow lists, block scalars, loud failure
// — including agents NO skill references), determinism, every validate-gate tamper case
// (incl. the trust anchor and stray files), the validate/reproduce boundary (a
// manifest-consistent forge passes validate, reproduce catches it — exercised against a
// local file:// upstream), and classify's risk tiers incl. provenance-only advance.
//
// Usage: node .deplugin/test/run-tests.mjs

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const TOOLS = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`ok   - ${name}`);
  else { failures++; console.error(`FAIL - ${name}${extra ? `\n       ${extra}` : ''}`); }
}
const run = (args, env = {}) => spawnSync('node', args, { encoding: 'utf8', env: { ...process.env, ...env } });
const read = p => fs.readFile(p, 'utf8');
const exists = async p => { try { await fs.access(p); return true; } catch { return false; } };

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ce-tests-'));
try {
  // ---------- transform on the good fixture ----------
  const repoA = path.join(work, 'a');
  const tr1 = run([path.join(TOOLS, 'ce-transform.mjs'), path.join(FIX, 'upstream'), path.join(repoA, 'skills')], {
    CE_EXCLUDE: 's-skip',
    CE_MANIFEST: path.join(repoA, 'transform-manifest.json'),
    CE_UPSTREAM_REPO: 'example/fixture', CE_UPSTREAM_TAG: 'v0.0.1', CE_UPSTREAM_COMMIT: 'deadbeef',
  });
  check('transform: exits 0 on good fixture', tr1.status === 0, tr1.stdout + tr1.stderr);

  const manifest = JSON.parse(await read(path.join(repoA, 'transform-manifest.json')));
  check('transform: excluded skill is dropped', !manifest.skills['s-skip'] && !(await exists(path.join(repoA, 'skills', 's-skip'))));
  check('transform: upstream provenance stamped', manifest.upstream.repo === 'example/fixture' && manifest.upstream.commit === 'deadbeef');

  // transitive closure: ce-gamma only via ce-alpha's body; ce-delta only via references/extra.md
  check('closure: transitive + reference-file scan', JSON.stringify(manifest.skills['s-one'].closure) === JSON.stringify(['ce-alpha', 'ce-beta', 'ce-delta', 'ce-gamma']),
    JSON.stringify(manifest.skills['s-one'].closure));
  check('closure: empty for skill with no refs', manifest.skills['s-two'].closure.length === 0);
  check('manifest: per-persona content hashes present', ['ce-alpha', 'ce-beta', 'ce-gamma', 'ce-delta'].every(n => /^[0-9a-f]{12}$/.test(manifest.skills['s-one'].personas[n]?.hash || '')));
  check('manifest: outputHash present', /^[0-9a-f]{12}$/.test(manifest.skills['s-one'].outputHash) && /^[0-9a-f]{12}$/.test(manifest.skills['s-two'].outputHash));

  const sOneMd = await read(path.join(repoA, 'skills', 's-one', 'SKILL.md'));
  const sTwoMd = await read(path.join(repoA, 'skills', 's-two', 'SKILL.md'));
  check('convention: injected iff closure non-empty', sOneMd.includes('ce-deplugin:convention') && !sTwoMd.includes('ce-deplugin:convention'));
  check('s-two: no personas dir', !(await exists(path.join(repoA, 'skills', 's-two', 'references', 'personas'))));

  // harness-neutral injected text: must offer BOTH a subagent path and an inline fallback
  check('portability: convention has subagent branch', /If your harness can launch subagents/.test(sOneMd));
  check('portability: convention has inline fallback', /If your harness cannot launch subagents/.test(sOneMd));

  const alpha = await read(path.join(repoA, 'skills', 's-one', 'references', 'personas', 'ce-alpha.md'));
  const beta = await read(path.join(repoA, 'skills', 's-one', 'references', 'personas', 'ce-beta.md'));
  const gamma = await read(path.join(repoA, 'skills', 's-one', 'references', 'personas', 'ce-gamma.md'));
  const delta = await read(path.join(repoA, 'skills', 's-one', 'references', 'personas', 'ce-delta.md'));
  check('persona: header present + read-only classified', alpha.includes('Operating constraints') && alpha.includes('Read-only: YES'));
  check('persona: write agent classified as general-purpose', beta.includes('Read-only: no'));
  check('persona: YAML block-list tools parsed', gamma.includes('Read-only: YES') && gamma.includes('Allowed tools: Read, Grep'));
  check('persona: missing tools => inherits all', delta.includes('Read-only: no') && delta.includes('(originally inherited all)'));
  const eps = await read(path.join(repoA, 'skills', 's-three', 'references', 'personas', 'ce-epsilon.md'));
  check('persona: literal block-scalar tools parsed onto the classification path', eps.includes('Read-only: YES') && eps.includes('Allowed tools: Read, Grep, WebSearch'), eps.split('\n')[0]);

  // ---------- determinism: run twice, byte-identical ----------
  const repoB = path.join(work, 'b');
  run([path.join(TOOLS, 'ce-transform.mjs'), path.join(FIX, 'upstream'), path.join(repoB, 'skills')], {
    CE_EXCLUDE: 's-skip',
    CE_MANIFEST: path.join(repoB, 'transform-manifest.json'),
    CE_UPSTREAM_REPO: 'example/fixture', CE_UPSTREAM_TAG: 'v0.0.1', CE_UPSTREAM_COMMIT: 'deadbeef',
  });
  check('determinism: identical manifest on re-run', (await read(path.join(repoA, 'transform-manifest.json'))) === (await read(path.join(repoB, 'transform-manifest.json'))));

  // ---------- validate: passes on fresh output, fails on every tamper class ----------
  // (fixtures are generated from 'example/fixture', so the trust anchor is overridden to match)
  const FIXTURE_ANCHOR = { CE_EXPECTED_UPSTREAM_REPO: 'example/fixture' };
  const v0 = run([path.join(TOOLS, 'ce-validate.mjs'), repoA], FIXTURE_ANCHOR);
  check('validate: passes on fresh output', v0.status === 0, v0.stderr);

  async function tamperedCopy(name, mutate) {
    const dst = path.join(work, name);
    await fs.cp(repoA, dst, { recursive: true });
    await mutate(dst);
    return run([path.join(TOOLS, 'ce-validate.mjs'), dst], FIXTURE_ANCHOR);
  }
  const t1 = await tamperedCopy('t1', async d => fs.appendFile(path.join(d, 'skills', 's-two', 'SKILL.md'), '\nAlso dispatch ce-gamma.\n'));
  check('validate: catches dangling ref in skill text', t1.status !== 0 && /dangling/.test(t1.stderr), t1.stderr);
  const t2 = await tamperedCopy('t2', async d => fs.rm(path.join(d, 'skills', 's-one', 'references', 'personas', 'ce-beta.md')));
  check('validate: catches persona/closure mismatch', t2.status !== 0 && /!= closure/.test(t2.stderr), t2.stderr);
  const t3 = await tamperedCopy('t3', async d => fs.appendFile(path.join(d, 'skills', 's-one', 'references', 'personas', 'ce-beta.md'), '\nhand-edited\n'));
  check('validate: catches hand-edited output (outputHash)', t3.status !== 0 && /outputHash mismatch/.test(t3.stderr), t3.stderr);
  const t4 = await tamperedCopy('t4', async d => fs.mkdir(path.join(d, 'skills', 's-one', 'agents'), { recursive: true }));
  check('validate: catches agents/ dir', t4.status !== 0 && /agents\/ dir present/.test(t4.stderr), t4.stderr);
  const t5 = await tamperedCopy('t5', async d => {
    // remove every reference to ce-gamma outside its own persona file -> orphan
    const p = path.join(d, 'skills', 's-one', 'references', 'personas', 'ce-alpha.md');
    await fs.writeFile(p, (await read(p)).replace(/ce-gamma/g, 'the checklist'));
  });
  check('validate: catches orphan persona', t5.status !== 0 && /orphan persona ce-gamma/.test(t5.stderr), t5.stderr);
  const t6 = await tamperedCopy('t6', async d => {
    // persona body referencing an agent with no persona file -> dangling via persona text
    await fs.appendFile(path.join(d, 'skills', 's-two', 'SKILL.md'), ''); // keep s-two clean
    const p = path.join(d, 'skills', 's-one', 'references', 'personas', 'ce-delta.md');
    await fs.appendFile(p, '\nEscalate to ce-omega when unsure.\n');
    const m = JSON.parse(await read(path.join(d, 'transform-manifest.json')));
    m.agentNames.push('ce-omega');
    await fs.writeFile(path.join(d, 'transform-manifest.json'), JSON.stringify(m, null, 2) + '\n');
  });
  check('validate: catches dangling ref inside persona body', t6.status !== 0 && /dangling agent reference 'ce-omega'/.test(t6.stderr), t6.stderr);
  const t7 = await tamperedCopy('t7', async d => {
    const p = path.join(d, 'transform-manifest.json');
    const m = JSON.parse(await read(p));
    m.upstream.repo = 'evil/look-alike-fork';
    await fs.writeFile(p, JSON.stringify(m, null, 2) + '\n');
  });
  check('validate: rejects manifest pointing at an unexpected upstream (trust anchor)', t7.status !== 0 && /expected 'example\/fixture'/.test(t7.stderr), t7.stderr);
  const t8 = await tamperedCopy('t8', async d => fs.writeFile(path.join(d, 'skills', 'planted.md'), 'rogue\n'));
  check('validate: catches stray file directly under skills/', t8.status !== 0 && /stray file directly under skills\//.test(t8.stderr), t8.stderr);

  // ---------- classify: the three risk tiers ----------
  const old = path.join(work, 'old.json'), neu = path.join(work, 'neu.json');
  const base = JSON.parse(await read(path.join(repoA, 'transform-manifest.json')));
  const classify = async (mutate) => {
    const m2 = JSON.parse(JSON.stringify(base));
    await mutate(m2);
    await fs.writeFile(old, JSON.stringify(base));
    await fs.writeFile(neu, JSON.stringify(m2));
    const r = run([path.join(TOOLS, 'ce-classify.mjs'), old, neu]);
    return JSON.parse(r.stdout).decision;
  };
  check('classify: nochange', (await classify(() => {})) === 'nochange');
  check('classify: skill body edit -> automerge', (await classify(m => { m.skills['s-two'].sourceHash = 'ffffffffffff'; m.skills['s-two'].outputHash = 'ffffffffffff'; })) === 'automerge');
  check('classify: persona body edit -> automerge (was the silent-drop bug)', (await classify(m => { m.skills['s-one'].personas['ce-alpha'].hash = 'ffffffffffff'; m.skills['s-one'].outputHash = 'ffffffffffff'; })) === 'automerge');
  check('classify: closure change -> pr', (await classify(m => { m.skills['s-one'].closure = ['ce-alpha', 'ce-beta', 'ce-delta']; })) === 'pr');
  check('classify: skill added -> pr', (await classify(m => { m.skills['s-new'] = m.skills['s-two']; })) === 'pr');
  check('classify: provenance-only advance -> automerge (pin must not go stale)', (await classify(m => { m.upstream = { ...m.upstream, tag: 'v0.0.2', commit: 'cafebabe' }; })) === 'automerge');

  // ---------- the validate BOUNDARY and the reproduce backstop (local file:// upstream) ----------
  const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const upGit = path.join(work, 'upstream-git');
  await fs.mkdir(path.join(upGit, 'plugins'), { recursive: true });
  await fs.cp(path.join(FIX, 'upstream'), path.join(upGit, 'plugins', 'compound-engineering'), { recursive: true });
  git(['init', '-q'], upGit); git(['add', '-A'], upGit); git(['commit', '-qm', 'fixture'], upGit); git(['tag', 'fixture-v1'], upGit);
  const sha = git(['rev-parse', 'HEAD'], upGit).stdout.trim();

  // a "committed" repo pinned to that local upstream, built with the DEFAULT exclude list
  // (reproduce always uses the default list, so the pinned build must too)
  const repoR = path.join(work, 'r');
  const envR = { ...process.env, CE_MANIFEST: path.join(repoR, 'transform-manifest.json'), CE_UPSTREAM_REPO: 'example/fixture', CE_UPSTREAM_TAG: 'fixture-v1', CE_UPSTREAM_COMMIT: sha };
  delete envR.CE_EXCLUDE;
  const trR = spawnSync('node', [path.join(TOOLS, 'ce-transform.mjs'), path.join(upGit, 'plugins', 'compound-engineering'), path.join(repoR, 'skills')], { encoding: 'utf8', env: envR });
  check('reproduce setup: pinned repo builds', trR.status === 0, trR.stdout + trR.stderr);

  const REPRO_ENV = { ...FIXTURE_ANCHOR, CE_UPSTREAM_URL: url.pathToFileURL(upGit).href };
  const rep1 = run([path.join(TOOLS, 'ce-reproduce.mjs'), repoR], REPRO_ENV);
  check('reproduce: PASS against the pinned local upstream', rep1.status === 0, rep1.stdout + rep1.stderr);

  // manifest-consistent forge: edit a persona AND recompute outputHash with the same lib.
  // ce-validate alone PASSES — that is its documented boundary — and ce-reproduce catches it.
  const { hashTree } = await import(url.pathToFileURL(path.join(TOOLS, 'ce-lib.mjs')).href);
  const forged = path.join(work, 'forged');
  await fs.cp(repoR, forged, { recursive: true });
  await fs.appendFile(path.join(forged, 'skills', 's-one', 'references', 'personas', 'ce-alpha.md'), '\nInjected instruction.\n');
  const fm2 = JSON.parse(await read(path.join(forged, 'transform-manifest.json')));
  fm2.skills['s-one'].outputHash = await hashTree(path.join(forged, 'skills', 's-one'));
  await fs.writeFile(path.join(forged, 'transform-manifest.json'), JSON.stringify(fm2, null, 2) + '\n');
  const vF = run([path.join(TOOLS, 'ce-validate.mjs'), forged], FIXTURE_ANCHOR);
  check('validate boundary: manifest-consistent forge passes validate alone (documented limit)', vF.status === 0, vF.stderr);
  const rep2 = run([path.join(TOOLS, 'ce-reproduce.mjs'), forged], REPRO_ENV);
  check('reproduce: catches the manifest-consistent forge', rep2.status !== 0 && /content differs|transform-manifest\.json differs/.test(rep2.stdout + rep2.stderr), rep2.stdout + rep2.stderr);

  // ---------- malformed frontmatter must fail loudly, not degrade silently ----------
  const bad = run([path.join(TOOLS, 'ce-transform.mjs'), path.join(FIX, 'upstream-bad'), path.join(work, 'bad', 'skills')], {
    CE_EXCLUDE: '', CE_MANIFEST: path.join(work, 'bad', 'transform-manifest.json'),
  });
  check('transform: malformed agent frontmatter fails the gate', bad.status !== 0 && /unparseable frontmatter/.test(bad.stdout + bad.stderr), bad.stdout + bad.stderr);

  // malformed agent that NO skill references must also fail loudly (was dead-code fmErrors)
  const badU = path.join(work, 'upstream-bad2');
  await fs.cp(path.join(FIX, 'upstream'), badU, { recursive: true });
  await fs.cp(path.join(FIX, 'upstream-bad', 'agents', 'ce-bad.md'), path.join(badU, 'agents', 'ce-unref.md'));
  const bad2 = run([path.join(TOOLS, 'ce-transform.mjs'), badU, path.join(work, 'bad2', 'skills')], {
    CE_EXCLUDE: '', CE_MANIFEST: path.join(work, 'bad2', 'transform-manifest.json'),
  });
  check('transform: malformed frontmatter fails even when NO skill references the agent', bad2.status !== 0 && /unreferenced by any skill/.test(bad2.stdout + bad2.stderr), bad2.stdout + bad2.stderr);
} finally {
  await fs.rm(work, { recursive: true, force: true });
}

console.log(failures ? `\nTESTS FAIL (${failures} failure${failures > 1 ? 's' : ''})` : '\nTESTS PASS ✅');
process.exit(failures ? 1 : 0);
