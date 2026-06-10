# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

优先用中文回复用户（代码、commit message、生成的 skills 内容除外）。

## What this repository is

Self-contained, plugin-free Claude Code skills, **mechanically generated** from the upstream
[EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin).
The upstream plugin's skills dispatch shared sub-agents registered in a plugin-level `agents/`
directory; the deterministic transform in `.deplugin/` rewrites each skill so its agent
dependency-closure is embedded as persona files and no `agents/` directory exists anywhere.

**Critical rule: `skills/` and `transform-manifest.json` are build outputs — a pure function of
upstream.** Do not hand-edit them. To change them, change the transform (`.deplugin/ce-transform.mjs`)
and regenerate, or wait for upstream. Hand-edits will be overwritten by the next sync and can fail
the structural gate (e.g. the dangling-agent-reference check).

## Commands

There is no package.json and no dependencies — plain Node (CI uses Node 22) and bash.

```bash
# Structural gate on the committed skills/ tree (this is what CI runs on every push/PR)
node .deplugin/ce-validate.mjs

# Full regeneration from the latest upstream compound-engineering-v* release + risk classification
# (needs network + gh or git ls-remote; does NOT git-commit — the caller decides)
bash .deplugin/ce-sync.sh

# Transform directly from a local upstream checkout (optionally a subset of skills)
CE_EXCLUDE="ce-setup,ce-update,ce-release-notes,ce-report-bug" \
  node .deplugin/ce-transform.mjs <SRC_PLUGIN_DIR> skills [skill1 skill2 ...]

# Classify old vs new manifest into a risk tier: nochange / automerge / pr
node .deplugin/ce-classify.mjs <oldManifest.json> <newManifest.json>
```

There are no tests beyond the gates: `ce-transform.mjs` runs a per-skill gate at the end of every
transform (exits non-zero on failure), and `ce-validate.mjs` is the standalone gate that needs no
upstream checkout.

## Architecture

### The transform pipeline (`.deplugin/`)

`ce-sync.sh` orchestrates: resolve latest upstream `compound-engineering-v*` tag → shallow-clone →
`ce-transform.mjs` → `ce-classify.mjs`. Everything is deterministic; no LLM is involved.

Per skill, `ce-transform.mjs`:
1. Copies the upstream skill directory and deletes any `agents/` dir.
2. Computes the **agent closure**: scans all skill text for any of the 43 upstream agent names
   (word-boundary match, longest-first).
3. Embeds each closure agent as `references/personas/<name>.md`, prepending a prose
   "Operating constraints" header derived from the agent's original `tools:`/`model:` frontmatter
   (read-only ⇒ dispatch as `Explore`, otherwise `general-purpose`). These constraints are
   **not runtime-enforced** once de-plugin-ified — that is the documented trade-off.
4. Injects one convention block (marker `<!-- ce-deplugin:convention -->`) after the SKILL.md
   frontmatter, telling the model how to dispatch personas via the Task/Agent tool. Injection is
   idempotent and only happens when the closure is non-empty.
5. Writes per-skill provenance into `transform-manifest.json`: `sourceHash`, `closure`, persona
   info, read-only/write counts.

Four upstream skills that only manage the plugin itself are excluded via `CE_EXCLUDE`:
`ce-setup`, `ce-update`, `ce-release-notes`, `ce-report-bug` (35 skills remain).

### Invariants checked by the gates

- No `agents/` directory anywhere under `skills/`.
- On-disk skills exactly match manifest skills.
- Persona files exactly equal the manifest closure set; every persona name is referenced
  somewhere in the skill's non-persona text (no orphans).
- Convention block present iff the closure is non-empty.
- Every persona file carries the "Operating constraints" header.
- No **dangling agent reference**: any upstream agent name appearing in a skill's non-persona
  text must have a persona file (catches hand-tampering and transform misses).

### Risk-tiered upstream sync (`.github/workflows/`)

`sync-upstream.yml` runs weekly (and on demand): regenerate, re-validate, then act on the
`ce-classify.mjs` decision:
- **automerge** — only skill/persona body text changed (closure sets identical, no skill
  added/removed) → committed straight to `main`.
- **pr** — any structural signal (skill added/removed, closure changed) → opens a PR for human
  review, never auto-merged, because the structural gate cannot see semantic drift.

`validate.yml` runs `ce-validate.mjs` on every push to `main` and every PR.

### Layout

- `skills/<name>/SKILL.md` — the skill entry point (frontmatter + injected convention block).
- `skills/<name>/references/` — supporting docs; `references/personas/` holds the embedded agents.
- `transform-manifest.json` — provenance: agent universe, per-skill closure and content hash.
- `.deplugin/` — the four-file toolchain described above. This is the only hand-written code
  in the repository.
