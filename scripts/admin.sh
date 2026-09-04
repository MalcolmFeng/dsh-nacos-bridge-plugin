#!/usr/bin/env bash
# 启动桥接层管控台（读 bridge 运行态 + 代理 Nacos + 联调）
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d apps/admin-server/lib ]; then
  echo "管控台未构建，先构建..." >&2
  pnpm --filter dsh-nacos-bridge-admin run build
fi

set -a; . ./.env 2>/dev/null; set +a

exec node apps/admin-server/lib/index.js
