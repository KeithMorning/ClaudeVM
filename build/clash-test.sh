#!/bin/bash
# 用真实的 Clash（Windows 侧 192.168.240.1:7897）验证 router 全量模式
GW="${1:-192.168.240.1}"
PORT="${2:-7897}"

cp -f /mnt/e/Web/FuckCladue/claude-vm/vm/scripts/proxy-router.js /opt/scripts/ 2>/dev/null
pkill -f proxy-router.js 2>/dev/null
sleep 0.6

echo "=========== 模式 A: all（全部经 Clash）==========="
UPSTREAM_PROXY="http://$GW:$PORT" PROXY_MODE=all PROXY_ROUTER_PORT=7890 \
  node /opt/scripts/proxy-router.js >/tmp/router-all.log 2>&1 &
sleep 1.2
sed -n '1,5p' /tmp/router-all.log

echo "--- /__router_status"
curl -s --max-time 5 http://127.0.0.1:7890/__router_status; echo

echo "--- 出口（经 router）"
curl -s --max-time 20 -x http://127.0.0.1:7890 https://ipinfo.io/json 2>/dev/null \
  | sed -n 's/.*"ip": *"\([^"]*\)".*/  IP   = \1/p;s/.*"city": *"\([^"]*\)".*/  CITY = \1/p;s/.*"org": *"\([^"]*\)".*/  ORG  = \1/p'

echo "--- api.anthropic.com"
curl -s -o /dev/null -w "  HTTP %{http_code}  %{time_total}s\n" --max-time 20 -x http://127.0.0.1:7890 https://api.anthropic.com/

echo "--- checkcc.org"
curl -s -o /dev/null -w "  HTTP %{http_code}  %{time_total}s\n" --max-time 25 -x http://127.0.0.1:7890 https://checkcc.org/
curl -sI --max-time 20 -x http://127.0.0.1:7890 https://checkcc.org/ 2>/dev/null | grep -i 'cf-ray' | sed 's/^/  /'

echo "--- 非白名单域名也走 Clash（本该是 Vultr 出口）"
curl -s --max-time 15 -x http://127.0.0.1:7890 https://www.gstatic.com/generate_204 -o /dev/null -w "  HTTP %{http_code}\n"

pkill -f proxy-router.js 2>/dev/null
sleep 0.6

echo
echo "=========== 模式 B: whitelist（回归，只有 Anthropic 走代理）==========="
UPSTREAM_PROXY="http://$GW:$PORT" PROXY_MODE=whitelist PROXY_ROUTER_PORT=7890 \
  node /opt/scripts/proxy-router.js >/tmp/router-wl.log 2>&1 &
sleep 1.2
sed -n '1,4p' /tmp/router-wl.log

echo "--- api.anthropic.com（应经 Clash，US 出口）"
curl -s -o /dev/null -w "  HTTP %{http_code}  %{time_total}s\n" --max-time 20 -x http://127.0.0.1:7890 https://api.anthropic.com/
echo "--- ipinfo.io（非白名单 → 应直连，中国出口）"
curl -s --max-time 15 -x http://127.0.0.1:7890 https://ipinfo.io/json 2>/dev/null \
  | sed -n 's/.*"ip": *"\([^"]*\)".*/  直连出口 IP = \1/p;s/.*"country": *"\([^"]*\)".*/  国家 = \1/p'

pkill -f proxy-router.js 2>/dev/null
echo "done"
