#!/usr/bin/env bash
set -e

# ── Configure VITE_API_URL for Codespaces port forwarding ──
# In Codespaces, each port gets a unique public URL.
# The frontend needs to know the backend's public URL.
if [ -n "$CODESPACE_NAME" ]; then
  DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  API_URL="https://${CODESPACE_NAME}-4000.${DOMAIN}"

  echo "Codespace detected. Setting VITE_API_URL=${API_URL}"
  echo "VITE_API_URL=${API_URL}" > packages/frontend/.env.local
else
  echo "Not running in Codespaces. Using default API URL."
fi
