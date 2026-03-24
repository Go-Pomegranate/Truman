#!/usr/bin/env bash
# Usage: bash scripts/release.sh [patch|minor|major]
# Default: patch

set -euo pipefail

BUMP="${1:-patch}"

echo "==> Bumping version ($BUMP)..."
npm version "$BUMP"

echo "==> Building..."
pnpm build

echo "==> Publishing to npm..."
npm publish --access public --auth-type=web

echo "==> Pushing to GitHub..."
git push --follow-tags

echo ""
echo "Done! Published $(node -p "require('./package.json').version") to npm."
