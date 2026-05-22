#!/bin/bash
set -e

echo "🚀 Skiff Setup Script"
echo ""

# Check Node.js version
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 20+ from https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Node.js version must be 20 or higher. You have: $(node -v)"
    exit 1
fi
echo "✅ Node.js $(node -v) found"

# Check pnpm
if ! command -v pnpm &> /dev/null; then
    echo "📦 pnpm not found. Installing..."
    npm install -g pnpm@9
fi
echo "✅ pnpm $(pnpm -v) found"

# Install dependencies
echo ""
echo "📦 Installing dependencies (this may take 30-60 seconds)..."
pnpm install

# Verify build
echo ""
echo "🔨 Verifying build..."
pnpm typecheck
pnpm build

echo ""
echo "✅ Setup complete!"
echo ""
echo "To start Skiff:"
echo "  pnpm dev"
echo ""
echo "Then open http://localhost:5173 in your browser."
