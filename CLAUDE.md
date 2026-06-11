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

**Distribution is via `npx skills` (skills CLI), not scripts.** The repo is a pure data tree:
users install with the skills CLI (or plain copy), so never add install/setup scripts or any
user-facing executable as a management mechanism, and keep the `skills/<name>/SKILL.md` layout
the CLI discovers. (`scripts/` inside individual skills are upstream run-time helpers invoked by
the agent while using a skill — they are upstream content, not management tooling.)

**Why plugin-free (the reason this repo exists):** these skills must serve multiple agent CLIs
(Claude Code, opencode, …) whose agent/subagent systems differ. Registered agents are inherently
CLI-specific; embedded persona files plus a dispatch convention are portable. Never reintroduce a
dependency on any CLI's agent registry, and keep transform-injected text harness-neutral
(capability-based wording with graceful degradation), not Claude-Code-specific.

**Critical rule: `skills/` and `transform-manifest.json` are build outputs — a pure function of
upstream.** Do not hand-edit them. To change them, change the transform (`.deplugin/ce-transform.mjs`)
and regenerate, or wait for upstream. Hand-edits will be overwritten by the next sync and can fail
the structural gate (e.g. the dangling-agent-reference check).

## Commands

There is no package.json and no dependencies — plain Node (CI uses Node 22) and bash.

```bash
# Structural + integrity gate on the committed skills/ tree (CI runs this on every push/PR;
# it recomputes per-skill output hashes, so hand-edits of skills/ fail here)
node .deplugin/ce-validate.mjs

# Toolchain tests (fixture-based, no network; CI runs these too)
node .deplugin/test/run-tests.mjs

# Reproducible-build gate: re-clone the upstream commit pinned in the manifest, re-run the
# transform, assert the committed skills/ + manifest are byte-identical (needs network)
node .deplugin/ce-reproduce.mjs

# Full regeneration from the latest upstream compound-engineering-v* release + risk classification
# (needs network; pins the upstream commit SHA into the manifest; does NOT git-commit)
bash .deplugin/ce-sync.sh

# Transform directly from a local upstream checkout (optionally a subset of skills).
# The default exclude list lives in .deplugin/ce-exclude.txt; CE_EXCLUDE overrides it when set.
node .deplugin/ce-transform.mjs <SRC_PLUGIN_DIR> skills [skill1 skill2 ...]

# Classify old vs new manifest into a risk tier: nochange / automerge / pr
node .deplugin/ce-classify.mjs <oldManifest.json> <newManifest.json>
```

## Architecture

### The transform pipeline (`.deplugin/`)

`ce-sync.sh` orchestrates: resolve latest upstream `compound-engineering-v*` tag → shallow-clone →
`ce-transform.mjs` → `ce-classify.mjs`. Everything is deterministic; no LLM is involved.

Per skill, `ce-transform.mjs`:
1. Copies the upstream skill directory and deletes any `agents/` dir.
2. Computes the **transitive agent closure**: scans all skill text for any of the 43 upstream
   agent names (word-boundary match), then iterates to a fixpoint over the bodies of referenced
   agents (a persona that names another agent pulls it in too).
3. Embeds each closure agent as `references/personas/<name>.md`, prepending a prose
   "Operating constraints" header derived from the agent's original `tools:`/`model:` frontmatter.
   The header is **harness-neutral** (read-only ⇒ "prefer a read-only/explore-type subagent",
   otherwise general-purpose); constraints are **not runtime-enforced** once de-plugin-ified —
   that is the documented trade-off. Unparseable agent frontmatter fails the gate loudly rather
   than silently widening constraints.
4. Injects one convention block (marker `<!-- ce-deplugin:convention -->`) after the SKILL.md
   frontmatter — a **capability ladder**: dispatch the persona via a subagent tool if the harness
   has one, otherwise adopt the persona inline. Injection is idempotent and only happens when the
   closure is non-empty.
5. Writes per-skill provenance into `transform-manifest.json`: `sourceHash` (upstream skill files),
   `outputHash` (final emitted tree — recomputable from disk by the validate gate), `closure`,
   per-persona content hashes, read-only/write counts; plus top-level `upstream` repo/tag/commit.

Four upstream skills that only manage the plugin itself are excluded via
`.deplugin/ce-exclude.txt` (single source; `CE_EXCLUDE` env overrides):
`ce-setup`, `ce-update`, `ce-release-notes`, `ce-report-bug` (35 skills remain).

### Invariants checked by the gates

- No `agents/` directory anywhere under `skills/`.
- On-disk skills exactly match manifest skills (both directions), each with a `SKILL.md`.
- Persona files exactly equal the manifest closure set; every persona is referenced from the
  skill's non-persona text or another persona file (no orphans).
- Convention block present iff the closure is non-empty.
- Every persona file carries the "Operating constraints" header.
- No **dangling agent reference**: any upstream agent name appearing in a skill's non-persona
  text **or inside a persona body** must have a persona file.
- Per-skill `outputHash` recomputed from disk matches the manifest (hand-edits of the generated
  tree fail CI even without network).
- `ce-reproduce.mjs` (CI, needs network): the committed `skills/` + manifest are **byte-identical**
  to re-running the transform against the upstream commit pinned in the manifest — this catches
  even a hand-edit that also forged the manifest hashes.

### Risk-tiered upstream sync (`.github/workflows/`)

`sync-upstream.yml` runs weekly (and on demand): regenerate (pinning the upstream commit SHA),
re-validate, then act on the `ce-classify.mjs` decision:
- **automerge** — only content changed: skill body, **persona body** (per-persona hashes — without
  them, upstream agent edits would classify as `nochange` and be dropped), or emitted output, with
  closure sets identical and no skill added/removed → opens an **auto-merge PR** that merges once
  the validate checks pass (zero-touch, but auditable).
- **pr** — any structural signal (skill added/removed, closure changed) → opens a PR for human
  review, never auto-merged, because the gates cannot see semantic drift.

`validate.yml` runs the structural/integrity gate, the toolchain tests, and the
reproducible-build gate on every push to `main` and every PR.

### Layout

- `skills/<name>/SKILL.md` — the skill entry point (frontmatter + injected convention block).
- `skills/<name>/references/` — supporting docs; `references/personas/` holds the embedded agents.
- `transform-manifest.json` — provenance: upstream repo/tag/commit, agent universe, per-skill
  closure and source/output/persona hashes.
- `.deplugin/` — the toolchain: `ce-transform.mjs`, `ce-validate.mjs`, `ce-classify.mjs`,
  `ce-reproduce.mjs`, `ce-sync.sh` (bash is fine — maintainer/CI tooling only, never shipped;
  Windows is not served), shared `ce-lib.mjs`, `ce-exclude.txt`, and `test/` (fixtures + runner).
  This is the only hand-written code in the repository.
