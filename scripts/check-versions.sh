#!/usr/bin/env bash
# CLAUDE.md requires four places to move together on every release. Nothing
# enforced that, and the dashboard shows one of them to the operator — so a
# missed edit means the UI reports a version that isn't what is running.
#
# Usage: scripts/check-versions.sh
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
note() { echo "  ✗ $*"; fail=1; }

backend=$(node -p "require('./packages/backend/package.json').version")
frontend=$(node -p "require('./packages/frontend/package.json').version")

echo "Checking version consistency (backend package.json = ${backend})"

[[ "$frontend" == "$backend" ]] \
  || note "packages/frontend/package.json is ${frontend}, expected ${backend}"

# The sidebar footer string the operator actually sees.
layout=packages/frontend/src/components/layout/Layout.tsx
grep -q "v${backend}" "$layout" \
  || note "${layout} does not mention v${backend}"

# Keep-a-Changelog heading for this release.
grep -qE "^## \[${backend}\]" CHANGELOG.md \
  || note "CHANGELOG.md has no '## [${backend}]' section"

# The array that drives the dashboard's About panel.
notes=packages/frontend/src/data/releaseNotes.ts
grep -qE "version: '${backend}'" "$notes" \
  || note "${notes} has no entry for ${backend}"

# The newest CHANGELOG heading should be the version we are shipping, so a
# stale top entry can't slip through while the four above all agree.
newest=$(grep -oE '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' CHANGELOG.md | head -1 | tr -d '#[] ')
[[ "$newest" == "$backend" ]] \
  || note "newest CHANGELOG entry is ${newest}, expected ${backend}"

if [[ $fail -eq 0 ]]; then
  echo "  ✓ all four locations agree on ${backend}"
else
  echo
  echo "See the 'Before every commit — mandatory version bump' section of CLAUDE.md."
  exit 1
fi
