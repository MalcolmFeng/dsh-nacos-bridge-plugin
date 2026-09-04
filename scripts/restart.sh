#!/usr/bin/env bash
# 重建插件并重启 dsh web（改完插件源码后用它，避免加载旧产物）。
# 等价于：./scripts/rebuild.sh && ./scripts/start.sh（start 会先杀掉旧进程）
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/rebuild.sh

echo "[dsh-nacos-bridge] 停止旧进程..."
pkill -f "dsh web" 2>/dev/null || true
sleep 2

echo "[dsh-nacos-bridge] 重启 dsh web..."
exec ./scripts/start.sh
