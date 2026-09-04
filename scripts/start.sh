#!/usr/bin/env bash
# 启动 dsh web（叠加 runtime/cordis.yml，可选 security.yml）
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "缺少 .env：请先 cp .env.example .env 并填入密钥" >&2
  exit 1
fi

set -a; . ./.env; set +a
# dsh 启动器保留变量（DSH_*、DEEPSEEK_BASE_URL 等）不能写入 .env，放 .env.export
if [ -f .env.export ]; then
  set -a; . ./.env.export; set +a
fi

# 防呆：插件 src 比 lib 新时（改了源码没 build），提示先 rebuild，避免加载旧产物
STALE=0
for dir in plugins/*/; do
  [ -d "$dir/src" ] || continue
  [ -d "$dir/lib" ] || continue
  SRC_NEWEST=$(find "$dir/src" -name '*.ts' -exec stat -f '%m %N' {} \; 2>/dev/null | sort -rn | head -1 | cut -d' ' -f1)
  LIB_NEWEST=$(find "$dir/lib" -name '*.js' -exec stat -f '%m %N' {} \; 2>/dev/null | sort -rn | head -1 | cut -d' ' -f1)
  if [ -n "$SRC_NEWEST" ] && [ -n "$LIB_NEWEST" ] && [ "$SRC_NEWEST" -gt "$LIB_NEWEST" ]; then
    echo "⚠️  检测到未构建的插件改动：$dir"
    echo "    源码比 lib/ 产物新。请先执行 ./scripts/rebuild.sh（或 ./scripts/restart.sh）再启动。"
    STALE=1
  fi
done
if [ "$STALE" -eq 1 ]; then
  echo "启动中止：插件产物与源码不同步。" >&2
  exit 1
fi

# 叠加安全配置（若存在）：生产/服务器或需要收敛权限时启用
PATCHES=("$PWD/runtime/cordis.yml")
if [ -f "$PWD/runtime/security.yml" ]; then
  echo "[dsh-nacos-bridge] 已叠加安全配置 runtime/security.yml（高权限能力已禁用）"
  PATCHES+=("$PWD/runtime/security.yml")
fi

PATCH_ARGS=()
for p in "${PATCHES[@]}"; do
  PATCH_ARGS+=(--patch "$p")
done

exec dsh web "${PATCH_ARGS[@]}"
