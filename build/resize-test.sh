#!/usr/bin/env bash
# 验证 resizeSession：用指定窗口尺寸打开串流页，看远端 X 分辨率是否跟着变。
# 分辨率跟着变 = 1:1 像素（清晰）；不变 = 画面被拉伸（发虚）。
W="${1:-1200}"
H="${2:-700}"
rm -rf /root/cpr
timeout 28 google-chrome-stable --headless=new --no-sandbox --disable-gpu \
  --user-data-dir=/root/cpr --window-size="${W},${H}" \
  --screenshot=/tmp/rs.png "http://127.0.0.1:6080/desktop.html" >/dev/null 2>&1 &
CPID=$!
sleep 11
echo "== 期望 ${W}x${H} =="
DISPLAY=:1 xrandr 2>/dev/null | sed -n '1,2p'
wait $CPID 2>/dev/null
ls -l /tmp/rs.png 2>/dev/null | awk '{print "截图:", $5, "字节"}'
