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

step "1/10 Typecheck server..."
npm --prefix server run typecheck || fail "Server typecheck failed"

step "2/10 Typecheck client..."
npm --prefix client run typecheck || fail "Client typecheck failed"

step "3/10 Lint server..."
npm --prefix server run lint || fail "Server lint failed"

step "4/10 Lint client..."
npm --prefix client run lint || fail "Client lint failed"

step "5/10 Test server..."
npm --prefix server run test -- --reporter=dot || fail "Server tests failed"

step "6/10 Test client..."
npm --prefix client run test:run -- --reporter=dot || fail "Client tests failed"

step "7/10 Typecheck mcp..."
npm --prefix mcp run typecheck || fail "MCP typecheck failed"

step "8/10 Test mcp..."
npm --prefix mcp run test -- --reporter=dot || fail "MCP tests failed"

step "9/10 Build server..."
npm --prefix server run build || fail "Server build failed"

step "10/10 Build client..."
VITE_API_BASE=/api/v1 npm --prefix client run build || fail "Client build failed"

echo -e "${GREEN}[ci-check] ✓ All checks passed — safe to push.${NC}"
