#!/bin/bash
rm -rf /root/fontcache
timeout 40 google-chrome-stable --headless=new --no-sandbox --disable-gpu \
  --user-data-dir=/root/fontcache \
  --proxy-server="$(cat /opt/config/local-proxy)" \
  --virtual-time-budget=6000 \
  --dump-dom "file:///mnt/e/Web/FuckCladue/build/font-probe.html" 2>/dev/null \
  | sed -n '/RESULT/,/<\/pre>/p'
echo "== 截图 =="
timeout 40 google-chrome-stable --headless=new --no-sandbox --disable-gpu \
  --user-data-dir=/root/fontcache --window-size=1200,320 \
  --proxy-server="$(cat /opt/config/local-proxy)" \
  --virtual-time-budget=6000 \
  --screenshot=/mnt/e/Web/FuckCladue/build/font-render.png \
  "file:///mnt/e/Web/FuckCladue/build/font-probe.html" >/dev/null 2>&1
ls -l /mnt/e/Web/FuckCladue/build/font-render.png
