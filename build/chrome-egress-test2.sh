#!/bin/bash
# 每个 Chrome 用独立 user-data-dir，避免单实例锁导致静默失败
run() {
  local tag="$1"; shift
  local dir="/tmp/cprof-$tag"
  rm -rf "$dir" 2>/dev/null
  echo "=== $tag ==="
  timeout 40 google-chrome-stable --headless=new --no-sandbox --disable-gpu \
    --user-data-dir="$dir" --virtual-time-budget=8000 --dump-dom "$@" \
    https://ipinfo.io/json 2>/tmp/err-$tag.txt > /tmp/out-$tag.html
  echo "exit=$?"
  tr -d '\n' < /tmp/out-$tag.html | grep -oE '"ip": *"[^"]*"|"org": *"[^"]*"' | head -2
  [ -s /tmp/err-$tag.txt ] && echo "stderr: $(head -c 160 /tmp/err-$tag.txt)"
  echo
}

run env-only
run withflag --proxy-server=http://127.0.0.1:7890
run withflag-noscheme --proxy-server=127.0.0.1:7890

echo "=== 当前 shell 的代理环境变量 ==="
env | grep -iE "^(http|https|all|no)_proxy" || echo "(无)"
echo "=== /etc/environment ==="
grep -i proxy /etc/environment 2>/dev/null || echo "(无)"
