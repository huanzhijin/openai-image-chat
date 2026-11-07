#!/usr/bin/env bash
set -euo pipefail

SERVICE="openai-image-chat.service"
URL="http://127.0.0.1:8787"
LAN_URL="http://192.168.5.107:8787"

systemctl --user restart "$SERVICE"

ok=0
for _ in {1..20}; do
  if curl -fsS --max-time 1 "$URL/api/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 0.5
done

if [ "$ok" -ne 1 ]; then
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "openai-image-chat 启动失败" "服务未通过健康检查，请查看 journalctl --user -u openai-image-chat.service -n 50"
  fi
  echo "openai-image-chat 启动失败。"
  echo "请执行：journalctl --user -u openai-image-chat.service -n 50 --no-pager"
  read -r -p "按 Enter 关闭窗口..." _ || true
  exit 1
fi

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &
fi

if command -v notify-send >/dev/null 2>&1; then
  notify-send "openai-image-chat 已启动" "本机：$URL\n局域网：$LAN_URL"
fi

echo "openai-image-chat 已启动。"
echo "本机：$URL"
echo "局域网：$LAN_URL"
