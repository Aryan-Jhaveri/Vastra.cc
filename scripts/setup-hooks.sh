#!/usr/bin/env bash
# Installs shared git hooks from .github/hooks/ into .git/hooks/
# Run once after cloning: bash scripts/setup-hooks.sh

set -e
REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_SRC="$REPO_ROOT/.github/hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

for hook in "$HOOKS_SRC"/*; do
  name=$(basename "$hook")
  cp "$hook" "$HOOKS_DST/$name"
  chmod +x "$HOOKS_DST/$name"
  echo "  installed .git/hooks/$name"
done

echo "Git hooks installed."
