#!/bin/bash
# ─────────────────────────────────────────────
# PLOS — Personal Life Operating System
# One-click start script
# ─────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/plos-backend"

echo ""
echo "  🚀 PLOS — Personal Life Operating System"
echo "  ─────────────────────────────────────────"
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "  ❌ Node.js not found."
  echo "     Install from: https://nodejs.org  (LTS version)"
  exit 1
fi

echo "  Node.js: $(node -v)"

# Always reinstall to ensure native bindings match this Mac's architecture
echo "  📦 Installing / rebuilding dependencies for this platform..."
cd "$BACKEND_DIR" && npm install --silent
echo "  ✅ Dependencies ready"
echo ""

# Kill any existing server on port 3000
lsof -ti:3000 | xargs kill -9 2>/dev/null

# Start
echo "  🌐 Backend: http://localhost:3000"
echo "  📊 App:     http://localhost:3000/plos-saas.html"
echo ""
echo "  Opening in browser..."
sleep 1
open "http://localhost:3000/plos-saas.html" 2>/dev/null &

echo "  Press Ctrl+C to stop the server."
echo ""

node server.js || node --experimental-sqlite server.js
