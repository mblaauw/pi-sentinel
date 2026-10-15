#!/usr/bin/env bash
# Create this project in the authenticated user's account; never guess the owner.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
command -v gh >/dev/null || { echo 'GitHub CLI (gh) is required.' >&2; exit 1; }
gh auth status
owner=$(gh api user --jq .login)
test -n "$owner"
git rev-parse --verify HEAD >/dev/null || { echo 'Commit the project before publishing.' >&2; exit 1; }
test -z "$(git status --porcelain)" || { echo 'Commit or resolve pending changes before publishing.' >&2; exit 1; }
if git remote get-url origin >/dev/null 2>&1; then
  echo 'An origin already exists. Inspect it before publishing.' >&2
  exit 1
fi
gh repo create "$owner/pi-sentinel" --public \
  --description 'Bounded autonomous Pi task workers for Kubernetes and internal model routers' \
  --source . --remote origin --push
gh repo view "$owner/pi-sentinel" --json nameWithOwner,url,visibility
