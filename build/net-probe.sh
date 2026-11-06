#!/bin/bash
# 探测容器内到达 Windows 侧 Clash 的路径
for H in 192.168.240.1 10.36.226.147 192.168.17.1; do
  echo "=== $H:7897 ==="
  OUT=$(curl -s --max-time 8 -x "http://$H:7897" https://ipinfo.io/json 2>&1 | head -c 260)
  if [ -z "$OUT" ]; then echo "  (空/失败)"; else echo "  $OUT"; fi
  # 顺带看 TCP 是否通
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 3 "$H" 7897 >/dev/null 2>&1 && echo "  TCP: open" || echo "  TCP: closed"
  fi
done
