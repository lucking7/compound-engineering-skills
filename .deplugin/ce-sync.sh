#!/usr/bin/env bash
# ce-sync.sh — REGENERATE the skills/ tree from the latest upstream release. Pure function: no patch, no merge.
# Resolves the latest `compound-engineering-v*` tag AND its commit SHA (pinned into the manifest for the
# reproducible-build gate), shallow-clones upstream at it, runs the transform, then classifies the change
# (nochange / automerge / pr). Does NOT git-commit — the caller (you, or the Action) decides.
# Maintainer/CI tooling only — never shipped to users (distribution is `npx skills` / plain copy).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
UPSTREAM_REPO="EveryInc/compound-engineering-plugin"
EXCLUDE="$(grep -v '^#' "$HERE/ce-exclude.txt" | grep -v '^$' | paste -sd, -)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# 1) back up the currently-committed manifest (becomes the "old" side of the diff)
OLD_MANIFEST="$WORK/old-manifest.json"
cp "$REPO/transform-manifest.json" "$OLD_MANIFEST" 2>/dev/null || echo '{"skills":{}}' > "$OLD_MANIFEST"

# 2) resolve latest upstream `compound-engineering-v*` tag + its commit SHA (peeled for annotated tags)
TAG="$(git ls-remote --tags "https://github.com/$UPSTREAM_REPO" 'compound-engineering-v*' \
      | sed 's#.*refs/tags/##; s/\^{}//' | sort -V -u | tail -1)"
[ -n "${TAG:-}" ] || { echo "ERROR: could not resolve an upstream compound-engineering-v* tag"; exit 1; }
COMMIT="$(git ls-remote "https://github.com/$UPSTREAM_REPO" "refs/tags/$TAG^{}" | awk '{print $1}')"
[ -n "${COMMIT:-}" ] || COMMIT="$(git ls-remote "https://github.com/$UPSTREAM_REPO" "refs/tags/$TAG" | awk '{print $1}')"
[ -n "${COMMIT:-}" ] || { echo "ERROR: could not resolve commit for tag $TAG"; exit 1; }
echo "Upstream: $TAG @ $COMMIT"

# 3) shallow clone upstream at that tag and verify the pinned commit
git clone --depth 1 --branch "$TAG" "https://github.com/$UPSTREAM_REPO" "$WORK/up" >/dev/null 2>&1
HEAD_SHA="$(git -C "$WORK/up" rev-parse HEAD)"
[ "$HEAD_SHA" = "$COMMIT" ] || { echo "ERROR: clone HEAD $HEAD_SHA != resolved tag commit $COMMIT"; exit 1; }
SRC="$WORK/up/plugins/compound-engineering"
[ -d "$SRC/skills" ] && [ -d "$SRC/agents" ] || { echo "ERROR: upstream layout changed (no plugins/compound-engineering/{skills,agents}) — needs human review"; exit 1; }

# 4) regenerate skills/ + new manifest at repo root (transform exits non-zero on any gate failure);
#    provenance (repo/tag/commit) is stamped into the manifest by the transform itself
CE_EXCLUDE="$EXCLUDE" CE_MANIFEST="$REPO/transform-manifest.json" \
CE_UPSTREAM_REPO="$UPSTREAM_REPO" CE_UPSTREAM_TAG="$TAG" CE_UPSTREAM_COMMIT="$COMMIT" \
  node "$HERE/ce-transform.mjs" "$SRC" "$REPO/skills"

# 5) classify old vs new -> decision (also writes to $GITHUB_OUTPUT when in CI)
echo
echo "=== risk classification ==="
node "$HERE/ce-classify.mjs" "$OLD_MANIFEST" "$REPO/transform-manifest.json"
