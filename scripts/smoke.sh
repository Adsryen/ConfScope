#!/usr/bin/env bash
# ConfScope 桌面壳冒烟脚本
# 用法: bash scripts/smoke.sh
# 验证: Go 编译、前端构建、测试通过

set -euo pipefail

echo "=== ConfScope 冒烟检查 ==="
echo ""

# 1. Go 编译
echo "[1/4] Go 编译..."
go vet ./...
go build -o /dev/null .
echo "  ✅ Go 编译通过"

# 2. Go 测试
echo "[2/4] Go 测试..."
go test ./internal/... -count=1 > /dev/null
echo "  ✅ Go 测试通过"

# 3. 前端类型检查
echo "[3/4] 前端类型检查..."
pnpm typecheck > /dev/null 2>&1
echo "  ✅ 类型检查通过"

# 4. 前端测试
echo "[4/4] 前端测试..."
pnpm test > /dev/null 2>&1
echo "  ✅ 前端测试通过"

echo ""
echo "=== 冒烟完成 ✅ ==="