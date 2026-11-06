#!/usr/bin/env bash
SRC=/mnt/e/Web/FuckCladue/claude-desktop/runtime/scripts
G=/opt/scripts/net-guard.py
S=/opt/scripts/net-guard.sh
ST=/run/claude-vm/net-guard.state
P=http://192.168.240.1:7897
mkdir -p /opt/scripts
for f in "$SRC"/*; do [ -f "$f" ] || continue; b=$(basename "$f"); cp -f "$f" "/opt/scripts/.$b.tmp" && mv -f "/opt/scripts/.$b.tmp" "/opt/scripts/$b"; done
chmod +x /opt/scripts/*.sh
cleanup() {
  echo "=== CLEANUP ==="
  [ -n "$DPID" ] && kill "$DPID" 2>/dev/null
  sleep 1
  echo "$P" > /opt/config/local-proxy
  python3 "$G" unlock
}
trap cleanup EXIT

echo "=== A 正常代理：启动 daemon ==="
NET_GUARD=strict NET_GUARD_INTERVAL=2 nohup "$S" >/tmp/guard-a.log 2>&1 & DPID=$!
sleep 9
cat "$ST"
echo "--- 直连 ---"; curl -s --noproxy '*' --max-time 4 https://ipinfo.io/ip && echo " !!!泄漏!!! " || echo " OK 已断"
echo "--- 代理 ---"; curl -s -x "$P" --max-time 10 https://ipinfo.io/ip; echo

echo "=== B 模拟 WSL 重新加回默认路由 ==="
python3 "$G" unlock >/dev/null
sleep 1; echo "刚加回: $(python3 "$G" status)"
sleep 6; echo "6 秒后: $(python3 "$G" status)"
echo "state=$(sed -n 's/^state=//p' "$ST")"

echo "=== C 代理换成不可用端口（模拟代理断了/没配好）==="
kill "$DPID" 2>/dev/null; sleep 1
echo "http://192.168.240.1:1" > /opt/config/local-proxy
NET_GUARD=strict NET_GUARD_INTERVAL=2 nohup "$S" >/tmp/guard-c.log 2>&1 & DPID=$!
sleep 9
echo "--- state ---"; cat "$ST"
echo "--- 直连（必须仍断）---"; curl -s --noproxy '*' --max-time 4 https://ipinfo.io/ip && echo " !!!泄漏!!! " || echo " OK 已断"
echo "--- 内核状态 ---"; python3 "$G" status
