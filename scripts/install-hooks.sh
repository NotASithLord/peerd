#!/usr/bin/env bash
# Install the pre-push hook: runs `bun run preflight` (the same gate CI
# runs) before every push, so main stays green even while GitHub Actions
# can't start runners. Opt-in — run once per clone:
#
#   scripts/install-hooks.sh
#
# Skip the hook for a one-off push with `git push --no-verify`.
set -euo pipefail
cd "$(dirname "$0")/.."

# Resolve the real hooks dir via git, not a hardcoded .git/hooks: in a
# linked worktree `.git` is a FILE (gitdir pointer), and a repo may set
# core.hooksPath elsewhere. `git rev-parse --git-path hooks` handles both.
HOOKS_DIR="$(git rev-parse --git-path hooks)"
mkdir -p "$HOOKS_DIR"
HOOK="$HOOKS_DIR/pre-push"

cat > "$HOOK" <<'EOF'
#!/bin/sh
# Installed by scripts/install-hooks.sh — preflight before push.
# GUI git clients (Tower, Fork, GitHub Desktop) launch from launchd and
# may lack ~/.bun/bin on PATH; add common locations so `bun` resolves.
PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
if ! command -v bun >/dev/null 2>&1; then
  echo "pre-push: bun not found on PATH — run preflight manually (bun run preflight) or push with --no-verify" >&2
  exit 1
fi
cd "$(git rev-parse --show-toplevel)" && bun run preflight
EOF
chmod +x "$HOOK"
echo "installed $HOOK (bypass once with: git push --no-verify)"
