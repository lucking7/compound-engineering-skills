# compound-engineering-skills

Self-contained, **plugin-free** Claude Code skills, mechanically converted from
[EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin)
(MIT © Kieran Klaassen / Every — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)).

> 上游是一个 Claude Code **插件**,它的 skill 依赖插件根 `agents/` 目录里注册的子代理。
> 本仓库用一个确定性转换器把它们变成**自包含、无 `agents/` 目录**的纯技能 —— 每个 skill
> 直接 `cp` 即可用,不需要装整个插件。

## What this is

Each upstream skill that dispatched shared `ce-*` sub-agents is rewritten so it is
**self-contained**:

- the skill's agent dependency-closure is embedded as **persona files** under
  `skills/<skill>/references/personas/`;
- a standard *self-contained persona dispatch* convention block is injected at the
  top of each `SKILL.md`: when the skill names a `ce-*` specialist, the model reads
  `references/personas/<name>.md` and launches a generic sub-agent with that file
  as its instructions (`Explore` for read-only personas, `general-purpose` otherwise);
- **no `agents/` directory** exists anywhere — nothing needs to be registered.

35 skills are included (the 4 upstream skills that only manage the plugin itself —
`ce-setup`, `ce-update`, `ce-release-notes`, `ce-report-bug` — are omitted).

### Trade-off (read this)

With no `agents/` directory, personas run as generic sub-agents, so their original
`tools:` / `model:` frontmatter is **not enforced** by the runtime. Each persona file
restates its constraints in prose at the top, on a best-effort basis. This is the
inherent cost of full self-containment.

## Use

Install with the skills CLI (works across agent CLIs — Claude Code, opencode, …):

```bash
npx skills add lucking7/compound-engineering-skills
```

Or plain copy — each skill is a self-contained directory (a `SKILL.md` plus `references/`),
nothing to register and no install scripts:

```bash
# all of them
cp -R skills/* ~/.agents/skills/        # or ~/.claude/skills/
# or just one
cp -R skills/ce-optimize ~/.agents/skills/
```

## How it's built / kept in sync

Everything is a **pure function of upstream** — no hand-editing of the output.

| File | Role |
|------|------|
| `.deplugin/ce-transform.mjs` | the transform: upstream plugin → self-contained skills (deterministic, no LLM) |
| `.deplugin/ce-validate.mjs`  | structural + integrity gate on the committed `skills/` tree (CI, no upstream needed) |
| `.deplugin/ce-reproduce.mjs` | reproducible-build gate: rebuild from the pinned upstream commit, assert byte-identical |
| `.deplugin/ce-classify.mjs`  | diffs old vs new manifest → `nochange` / `automerge` / `pr` |
| `.deplugin/ce-sync.sh`       | regenerate from the latest upstream `compound-engineering-v*` release, then classify |
| `.deplugin/ce-lib.mjs` / `ce-exclude.txt` | shared helpers / single-source skill exclude list |
| `.deplugin/test/`            | fixture-based tests for the toolchain (run in CI) |
| `transform-manifest.json`    | provenance: upstream repo+tag+**commit SHA**, per-skill closure, source/output/persona hashes |

Regenerate locally:

```bash
bash .deplugin/ce-sync.sh        # clones latest upstream release, rebuilds skills/, prints the risk tier
```

### Automatic upstream sync

`.github/workflows/sync-upstream.yml` runs weekly (and on demand). It regenerates from
the latest upstream release (pinned to a commit SHA recorded in the manifest), runs the
gates, then applies a **deterministic risk tier**:

- **content-only** change (skill or persona body text only; closure sets identical) →
  an **auto-merge PR**: merges without human action once the validate checks pass, but
  leaves a reviewable audit trail;
- **structural** change (a skill added/removed, or an agent closure changed) → opened as
  a **PR for human review** — never auto-merged, because the gates cannot see
  *semantic* drift (a renamed/split persona, a new dispatch idiom).

No LLM and no extra secrets are involved — only the built-in `GITHUB_TOKEN`.

`.github/workflows/validate.yml` runs on every push and PR: the structural/integrity gate
(which recomputes per-skill output hashes, so hand-edits of `skills/` fail CI), the
toolchain tests, and the **reproducible-build gate** — it re-clones the pinned upstream
commit, re-runs the transform, and asserts the committed tree is byte-identical.
