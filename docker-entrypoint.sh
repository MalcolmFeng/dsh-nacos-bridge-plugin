#!/usr/bin/env bash
# 启动 dsh web（叠加 dsh-nacos-bridge 装配 cordis.yml）
set -euo pipefail
cd /app

# 加载环境（DSH_* / DEEPSEEK_BASE_URL 只能 export）
set -a
if [ -f /app/runtime/.env ]; then . /app/runtime/.env; fi
set +a

# 启动 dsh web（前台，作为主进程）
exec dsh web --patch /app/runtime/cordis.yml
