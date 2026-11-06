#!/bin/bash
# 用真实 Chrome（同一个 --proxy-server 参数）复刻 checkcc 的三条 no-cors 探测
rm -rf /root/probecache
timeout 40 google-chrome-stable --headless=new --no-sandbox --disable-gpu \
  --user-data-dir=/root/probecache \
  --proxy-server="$(cat /opt/config/local-proxy)" \
  --virtual-time-budget=20000 \
  --dump-dom "file:///mnt/e/Web/FuckCladue/build/probe.html" 2>/dev/null \
  | sed -n '/RESULT/,/<\/pre>/p'
