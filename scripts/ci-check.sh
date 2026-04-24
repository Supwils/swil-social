#!/usr/bin/env bash
# 手动运行 CI 检查，与 GitHub Actions 保持一致
# 用法：./scripts/ci-check.sh

set -euo pipefail

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() {
  echo -e "${RED}[ci-check] ✗ $1${NC}"
  exit 1
}

step() {
  echo -e "${YELLOW}[ci-check] $1${NC}"
}

step "1/4 Typecheck server..."
npm --prefix server run typecheck || fail "Server typecheck failed"

step "2/4 Typecheck client..."
npm --prefix client run typecheck || fail "Client typecheck failed"

step "3/4 Build server..."
npm --prefix server run build || fail "Server build failed"

step "4/4 Build client..."
VITE_API_BASE=/api/v1 npm --prefix client run build || fail "Client build failed"

echo -e "${GREEN}[ci-check] ✓ All checks passed — safe to push.${NC}"
