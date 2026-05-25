#!/usr/bin/env bash
set -e

echo "=== Synapse Integration Hub - Codespace Setup ==="

# ── Install all dependencies ──
echo "Installing root dependencies..."
npm install

echo "Installing frontend & backend dependencies..."
npm run install:all

# ── Write backend .env pointing to Docker services ──
echo "Configuring backend environment..."
cat > packages/backend/.env <<'EOF'
DATABASE_URL=postgresql://synapse:synapse@postgres:5432/synapse_db
REDIS_URL=redis://redis:6379
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
NODE_ENV=development
PORT=4000
LOG_LEVEL=info
EOF

# ── Run database migrations ──
echo "Running database migrations..."
cd packages/backend
npx drizzle-kit push --force
cd ../..

echo "=== Setup complete! Run 'npm run dev' to start. ==="
