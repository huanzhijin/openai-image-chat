#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

URL="http://127.0.0.1:${PORT:-8787}"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "未找到 pnpm。请先安装：corepack enable && corepack prepare pnpm@latest --activate"
  exit 1
fi

if [ ! -d node_modules ]; then
  pnpm install
fi

pnpm build

echo "openai-image-chat 即将启动：$URL"
echo "停止服务：在当前终端按 Ctrl+C"
exec pnpm start
