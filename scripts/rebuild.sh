#!/usr/bin/env bash
# 重新构建工作区内所有包（tsc → lib/）。
# 注意：改完 plugins/*/src/** 必须 build，否则 dsh 仍加载 lib/ 下的旧产物。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[dsh-nacos-bridge] 构建插件..."
pnpm -r run build
echo "[dsh-nacos-bridge] 构建完成（lib/ 已同步 src/）"
