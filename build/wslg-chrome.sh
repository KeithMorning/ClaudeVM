#!/usr/bin/env bash
# 验证 Chrome 在 WSLg（DISPLAY=:0）下能带代理启动
export DISPLAY=:0
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
EP=$(cat /opt/config/local-proxy 2>/dev/null)
echo "代理端点 = [$EP]"

rm -rf /tmp/wslg-chrome
nohup google-chrome-stable \
  --no-sandbox --disable-dev-shm-usage \
  --user-data-dir=/tmp/wslg-chrome \
  --proxy-server="$EP" \
  --window-size=1100,760 \
  --no-first-run --no-default-browser-check \
  https://claude.ai/login >/tmp/wslg-chrome.log 2>&1 &
sleep 8
echo "=== 进程 ==="
pgrep -af "user-data-dir=/tmp/wslg-chrome" | head -2
echo "=== 日志中的错误 ==="
grep -oE "ERR_[A-Z_]+|Failed to [a-z ]{0,30}" /tmp/wslg-chrome.log 2>/dev/null | sort -u | head -6
echo "=== :0 上的窗口（xdotool 缺失则用 xwininfo）==="
xwininfo -root -tree 2>/dev/null | grep -i "chrome" | head -3
