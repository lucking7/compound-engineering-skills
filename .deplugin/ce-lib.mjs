// ce-lib.mjs — shared helpers for the .deplugin toolchain (transform / validate / reproduce).
// Everything here must stay deterministic: sorted walks, stable hashing, no timestamps.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha1 = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

// The ONLY upstream this repo may be generated from. Both gates assert the manifest's
// provenance against it, so a forged manifest cannot redirect the reproducible-build
// (or a reviewer's trust) to a look-alike fork. Env override exists ONLY for the
// fixture tests; CI runs without it and therefore enforces the constant.
export const EXPECTED_UPSTREAM_REPO =
  process.env.CE_EXPECTED_UPSTREAM_REPO || 'EveryInc/compound-engineering-plugin';

export const eqSet = (a = [], b = []) =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

// Depth-first file walk with entries sorted by name, so any hash built from the
// result is independent of filesystem readdir order.
export async function walkFiles(dir, acc = []) {
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(p, acc); else acc.push(p);
  }
  return acc;
}

export async function walkDirs(dir, acc = []) {
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    acc.push(p);
    await walkDirs(p, acc);
  }
  return acc;
}

// Deterministic content hash of a directory tree: sorted relative paths + contents.
// Recomputable from disk by the validate gate (tamper detection without upstream).
export async function hashTree(root) {
  const files = await walkFiles(root);
  const parts = [];
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    parts.push(rel + '\0' + (await fs.readFile(f, 'utf8')) + '\0');
  }
  return sha1(parts.join(''));
}

// Minimal YAML frontmatter parser for the agent/skill files we control.
// Supports: scalar values, flow lists [a, b], block lists (- item), and
// folded/literal scalars (>, |). Anything else is reported in `errors` so the
// caller can FAIL LOUDLY instead of silently mis-reading constraints like `tools:`.
export function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: md, errors: [] };
  const fm = {};
  const errors = [];
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) { errors.push(`unparseable frontmatter line: ${line.trim()}`); continue; }
    const key = kv[1];
    let val = kv[2].trim();
    if (val === '') {
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, ''));
        j++;
      }
      fm[key] = items.join(', ');
      i = j - 1;
    } else if (/^[>|][+-]?$/.test(val)) {
      // folded/literal block scalar: consume the indented continuation lines
      const chunk = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === '')) {
        chunk.push(lines[j].trim());
        j++;
      }
      fm[key] = chunk.join(' ').trim();
      i = j - 1;
    } else if (/^\[.*\]$/.test(val)) {
      fm[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean).join(', ');
    } else {
      fm[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { fm, body: m[2], errors };
}

// Default skill-exclusion list lives in one place: .deplugin/ce-exclude.txt
// (one name per line, # comments allowed). CE_EXCLUDE env overrides when SET.
export async function readDefaultExclude(deplugDir) {
  try {
    const txt = await fs.readFile(path.join(deplugDir, 'ce-exclude.txt'), 'utf8');
    return txt.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  } catch { return []; }
}
