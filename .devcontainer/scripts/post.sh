#!/bin/bash
set -euo pipefail

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  postCreate setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ---------------- Rokit (retry on GitHub timeouts) ----------------
echo "→ Installing rokit tools..."
for i in 1 2 3; do
    rokit install --no-trust-check && break
    echo "  Attempt $i/3 failed — retrying in 5s..."
    sleep 5
    if [ $i -eq 3 ]; then
        echo "  ⚠ rokit install failed after 3 attempts, continuing..."
    fi
done

# ---------------- Bun deps ----------------
echo "→ Installing bun dependencies..."
bun install --force

# ---------------- Claude Code ----------------
echo "→ Installing Claude Code..."
npm install -g @anthropic-ai/claude-code

echo ""
echo "✓ postCreate complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
