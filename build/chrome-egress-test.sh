#!/bin/bash
# 用无头 Chrome 复现「浏览器这一层的出口」，对比带/不带 --proxy-server
echo "=== A. Chrome 不带代理标志（模拟从欢迎页/手工开的窗口）==="
timeout 30 google-chrome-stable --headless=new --no-sandbox --disable-gpu \
  --virtual-time-budget=6000 --dump-dom https://ipinfo.io/json 2>/dev/null \
  | tr -d '\n' | head -c 200
echo; echo

echo "=== B. Chrome 带 --proxy-server=127.0.0.1:7890（chrome-login.sh 的做法）==="
timeout 30 google-chrome-stable --headless=new --no-sandbox --disable-gpu \
  --proxy-server=http://127.0.0.1:7890 \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  --virtual-time-budget=6000 --dump-dom https://ipinfo.io/json 2>/dev/null \
  | tr -d '\n' | head -c 200
echo; echo

echo "=== C. 带代理访问 checkcc.org，看页面标题能否正常拿到 ==="
timeout 30 google-chrome-stable --headless=new --no-sandbox --disable-gpu \
  --proxy-server=http://127.0.0.1:7890 \
  --virtual-time-budget=8000 --dump-dom https://checkcc.org/ 2>/dev/null \
  | grep -oE '<title>[^<]*</title>' | head -2
