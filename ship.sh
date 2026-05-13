#!/bin/bash
# ============================================================
# ship.sh
# SHIP workflow — commit, branch, push for any sprint.
# Usage: ./ship.sh SPRINT_NAME "optional commit message"
# Example: ./ship.sh 1A
#          ./ship.sh 1B "fix parser patterns"
# ============================================================

set -euo pipefail

SPRINT="${1:-}"
MESSAGE="${2:-}"

if [[ -z "$SPRINT" ]]; then
  echo "Usage: ./ship.sh SPRINT_NAME [\"commit message\"]"
  echo "Example: ./ship.sh 1A"
  exit 1
fi

BRANCH="sprint-${SPRINT}"
DEFAULT_MSG="Sprint ${SPRINT} — SHIP"
COMMIT_MSG="${MESSAGE:-$DEFAULT_MSG}"

echo "🚢 Shipping Sprint ${SPRINT}..."
echo ""

# ── Step 1: Check git status ──────────────────────────────
echo "── Git status:"
git status
echo ""

# ── Step 2: Stage all tracked + new script files ─────────
git add gmail-to-openbrain.ts brain-import.sh list-senders.ts ship.sh .gitignore README.md 2>/dev/null || true
git add -u  # stage any modified tracked files

echo "── Staged files:"
git diff --cached --name-only
echo ""

# ── Step 3: Commit ───────────────────────────────────────
git commit -m "$COMMIT_MSG" || echo "Nothing new to commit"

# ── Step 4: Create or update sprint branch ───────────────
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "── Branch $BRANCH already exists — updating"
  git checkout "$BRANCH"
  git merge main --no-edit
  git checkout main
else
  echo "── Creating branch: $BRANCH"
  git checkout -b "$BRANCH"
  git checkout main
fi

# ── Step 5: Push main and branch ─────────────────────────
echo "── Pushing main..."
git push origin main

echo "── Pushing branch $BRANCH..."
git push origin "$BRANCH" 2>/dev/null || git push -u origin "$BRANCH"

echo ""
echo "✅ Sprint ${SPRINT} shipped!"
echo "   Branch : $BRANCH"
echo "   Commit : $COMMIT_MSG"
echo "   Repo   : https://github.com/grahambinks/open-brain-importer"
