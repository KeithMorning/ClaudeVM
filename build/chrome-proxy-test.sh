#!/bin/bash
# 在真实发行版里验证：读取 local-proxy → 传给 Chrome → 能不能打开 claude.ai
# 注意：必须在容器内执行（脚本内容不会被 Git Bash 的路径转换污染）
set -u
EP="$(cat /opt/config/local-proxy)"
echo "local-proxy bytes: $(printf '%s' "$EP" | od -c | head -1)"
echo "len=${#EP}"
rm -rf /root/cptX
timeout 40 google-chrome-stable --headless=new --no-sandbox --disable-gpu \
  --user-data-dir=/root/cptX --proxy-server="$EP" --virtual-time-budget=8000 \
  --dump-dom https://claude.ai/login > /root/cx.html 2>/root/cx.err
echo "exit=$?"
echo "err: $(grep -o 'net::ERR_[A-Z_]*' /root/cx.err | head -1)"
echo "bytes: $(wc -c < /root/cx.html)"
grep -o '<title>[^<]*' /root/cx.html | head -2
