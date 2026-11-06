#!/usr/bin/env bash
SRC=/mnt/e/Web/FuckCladue/claude-desktop/runtime/scripts
G=/opt/scripts/net-guard.py
S=/opt/scripts/net-guard.sh
ST=/run/claude-vm/net-guard.state
P=http://192.168.240.1:7897
for f in "$SRC"/*; do [ -f "$f" ] || continue; b=$(basename "$f"); cp -f "$f" "/opt/scripts/.$b.tmp" && mv -f "/opt/scripts/.$b.tmp" "/opt/scripts/$b"; done
chmod +x /opt/scripts/*.sh
# 彻底清掉上一轮脱离父 shell 的 nohup 守卫
pkill -9 -f '/opt/scripts/net-guard.sh' 2>/dev/null || true
sleep 1
rm -f /run/claude-vm/net-guard.pid
python3 "$G" unlock >/dev/null 2>&1
cleanup() {
  echo "=== CLEANUP ==="
  pkill -9 -f '/opt/scripts/net-guard.sh' 2>/dev/null || true
  sleep 1
  rm -f /run/claude-vm/net-guard.pid
  echo "$P" > /opt/config/local-proxy
  python3 "$G" unlock
}
trap cleanup EXIT

echo "=== 场景：代理端口配错 / 代理软件没开 ==="
echo "http://192.168.240.1:1" > /opt/config/local-proxy
NET_GUARD=strict NET_GUARD_INTERVAL=2 nohup "$S" >/tmp/guard-fail.log 2>&1 &
sleep 14
echo "--- 状态文件 ---"; cat "$ST"
echo "--- 直连（必须断）---"; curl -s --noproxy '*' --max-time 4 https://ipinfo.io/ip && echo " !!!泄漏!!! " || echo " OK 已断"
echo "--- 内核路由 ---"; python3 "$G" status
echo "--- 守卫日志 ---"; tail -6 /tmp/guard-fail.log
