#!/usr/bin/env bash
# ce-sync.sh — REGENERATE the skills/ tree from the latest upstream release. Pure function: no patch, no merge.
# Resolves the latest `compound-engineering-v*` release tag, shallow-clones upstream at it, runs the transform,
# then classifies the change (nochange / automerge / pr). Does NOT git-commit — the caller (you, or the Action) decides.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
UPSTREAM_REPO="EveryInc/compound-engineering-plugin"
EXCLUDE="ce-setup,ce-update,ce-release-notes,ce-report-bug"   # the 4 plugin-self-referential skills
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# 1) back up the currently-committed manifest (becomes the "old" side of the diff)
OLD_MANIFEST="$WORK/old-manifest.json"
cp "$REPO/transform-manifest.json" "$OLD_MANIFEST" 2>/dev/null || echo '{"skills":{}}' > "$OLD_MANIFEST"

# 2) resolve latest upstream `compound-engineering-v*` release tag (gh, with git ls-remote fallback)
TAG="$(gh api "repos/$UPSTREAM_REPO/releases" --jq '[.[].tag_name | select(startswith("compound-engineering-v"))][0]' 2>/dev/null || true)"
if [ -z "${TAG:-}" ] || [ "$TAG" = "null" ]; then
  TAG="$(git ls-remote --tags "https://github.com/$UPSTREAM_REPO" 'compound-engineering-v*' \
        | sed 's#.*refs/tags/##; s/\^{}//' | sort -V -u | tail -1)"
fi
[ -n "${TAG:-}" ] || { echo "ERROR: could not resolve an upstream compound-engineering-v* tag"; exit 1; }
echo "Upstream tag: $TAG"

# 3) shallow clone upstream at that tag
git clone --depth 1 --branch "$TAG" "https://github.com/$UPSTREAM_REPO" "$WORK/up" >/dev/null 2>&1
SRC="$WORK/up/plugins/compound-engineering"
[ -d "$SRC/skills" ] && [ -d "$SRC/agents" ] || { echo "ERROR: upstream layout changed (no plugins/compound-engineering/{skills,agents}) — needs human review"; exit 1; }

# 4) regenerate skills/ + new manifest at repo root (transform exits non-zero on any gate failure)
CE_EXCLUDE="$EXCLUDE" CE_MANIFEST="$REPO/transform-manifest.json" \
  node "$HERE/ce-transform.mjs" "$SRC" "$REPO/skills"

# stamp the upstream tag into the manifest for provenance
node -e "const fs=require('fs');const p='$REPO/transform-manifest.json';const m=JSON.parse(fs.readFileSync(p));m.upstreamTag='$TAG';fs.writeFileSync(p,JSON.stringify(m,null,2));"

# 5) classify old vs new -> decision (also writes to \$GITHUB_OUTPUT when in CI)
echo
echo "=== risk classification ==="
node "$HERE/ce-classify.mjs" "$OLD_MANIFEST" "$REPO/transform-manifest.json"
