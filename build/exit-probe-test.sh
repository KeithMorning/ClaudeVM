#!/bin/bash
# 复刻 entrypoint 里的出口探测片段，确认 sed 解析能吃到 compact JSON
GW="${1:-192.168.240.1}"
PORT="${2:-7897}"
cp -f /mnt/e/Web/FuckCladue/claude-vm/vm/scripts/proxy-router.js /opt/scripts/ 2>/dev/null
pkill -f proxy-router.js 2>/dev/null
sleep 0.5
UPSTREAM_PROXY="http://$GW:$PORT" PROXY_MODE=all PROXY_ROUTER_PORT=7890 \
  node /opt/scripts/proxy-router.js >/tmp/router.log 2>&1 &
sleep 1.2

ROUTER_PORT=7890
mkdir -p /run/claude-vm
_j=$(curl -s --max-time 12 -x "http://127.0.0.1:${ROUTER_PORT}" https://ipinfo.io/json 2>/dev/null)
echo "--- 原始 JSON 前 120 字符"
printf '%s\n' "$_j" | head -c 120; echo
_ip=$(printf '%s' "$_j" | sed -n 's/.*"ip": *"\([^"]*\)".*/\1/p')
_org=$(printf '%s' "$_j" | sed -n 's/.*"org": *"\([^"]*\)".*/\1/p')
_city=$(printf '%s' "$_j" | sed -n 's/.*"city": *"\([^"]*\)".*/\1/p')
echo "--- 解析结果"
echo "ip=[$_ip] city=[$_city] org=[$_org]"
{
  echo "state=up"
  echo "exit_ip=${_ip}"
  echo "exit_org=${_org}"
  echo "exit_city=${_city}"
  echo "mode=${PROXY_MODE:-all}"
} > /run/claude-vm/exit.state
echo "--- exit.state"
cat /run/claude-vm/exit.state

echo
echo "=== 模拟 compact JSON（Clash 有时压缩输出）==="
C='{"ip":"1.2.3.4","city":"Foo","org":"AS1 Bar"}'
echo "ip=[$(printf '%s' "$C" | sed -n 's/.*"ip": *"\([^"]*\)".*/\1/p')]"
echo "org=[$(printf '%s' "$C" | sed -n 's/.*"org": *"\([^"]*\)".*/\1/p')]"

pkill -f proxy-router.js 2>/dev/null
echo done
