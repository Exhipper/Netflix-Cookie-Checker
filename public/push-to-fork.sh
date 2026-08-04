#!/usr/bin/env bash
#
# push-to-fork.sh — Extract the web app archive and push it to your GitHub fork
#
# Usage:
#   chmod +x push-to-fork.sh
#   ./push-to-fork.sh
#
# Prerequisites:
#   - git installed
#   - Your fork cloned locally: git clone https://github.com/Exhipper/Netflix-Cookie-Checker.git
#
set -euo pipefail

FORK_URL="https://github.com/Exhipper/Netflix-Cookie-Checker.git"
ARCHIVE="netflix-cookie-checker-webapp.tar.gz"
CLONE_DIR="Netflix-Cookie-Checker"

echo "=== Netflix Cookie Checker — Push Web App to Fork ==="
echo ""

# Step 1: Clone the fork (or use existing clone)
if [ -d "$CLONE_DIR" ]; then
  echo "[1/4] Using existing clone at ./$CLONE_DIR"
  cd "$CLONE_DIR"
  git pull --ff-only origin main 2>/dev/null || git pull --ff-only origin master 2>/dev/null || true
else
  echo "[1/4] Cloning your fork..."
  git clone "$FORK_URL" "$CLONE_DIR"
  cd "$CLONE_DIR"
fi

# Detect default branch
BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "main")
echo "      Branch: $BRANCH"

# Step 2: Create a new branch for the web app
WEB_BRANCH="web-app"
echo ""
echo "[2/4] Creating branch '$WEB_BRANCH'..."
git checkout -b "$WEB_BRANCH" 2>/dev/null || git checkout "$WEB_BRANCH"

# Step 3: Extract archive files into the repo
echo ""
echo "[3/4] Extracting web app files..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/$ARCHIVE" ]; then
  tar xzf "$SCRIPT_DIR/$ARCHIVE" -C .
else
  echo "ERROR: $ARCHIVE not found next to this script."
  echo "       Make sure the archive is in the same directory as this script."
  exit 1
fi

echo "      Files added:"
git add -A
git status --short | head -20
echo "      ... ($(git status --short | wc -l) files total)"

# Step 4: Commit and push
echo ""
echo "[4/4] Committing and pushing..."
git commit -m "Add Netflix Cookie Checker web app (React + Express)

- Full-stack web app with React frontend and Express API server
- Ports all Python checker logic to TypeScript
- PostgreSQL database for run history and results
- Features: cookie checking, proxy support, nfToken generation,
  notifications (webhook + Telegram), dashboard with stats,
  run history, settings panel
- Deploy-ready for Render.com (render.yaml included)"

echo ""
echo "Pushing to your fork..."
git push -u origin "$WEB_BRANCH"

echo ""
echo "=== Done! ==="
echo ""
echo "Your web app is now on a branch '$WEB_BRANCH' in your fork."
echo "To merge it into your main branch, go to:"
echo "  https://github.com/Exhipper/Netflix-Cookie-Checker/pull/new/$WEB_BRANCH"
echo ""
echo "Or merge locally:"
echo "  git checkout $BRANCH"
echo "  git merge $WEB_BRANCH"
echo "  git push origin $BRANCH"
echo ""
echo "Then deploy on Render.com using your fork as the source repo."
