#!/bin/bash
# 多源出口 IP 对比：确认「所有渠道看到的是同一个出口」，而不是链路分叉
P="http://192.168.240.1:7897"
for u in "https://api.ipify.org" "https://ifconfig.me/ip" "https://ipinfo.io/ip" \
         "https://1.1.1.1/cdn-cgi/trace" "https://api.myip.com"; do
  printf '%-32s ' "$u"
  curl -s --max-time 10 -x "$P" "$u" | tr '\n' ' ' | head -c 110
  echo
done
echo
echo "== DoH 走的解析器 =="
curl -s --max-time 10 -x "$P" https://1.1.1.1/cdn-cgi/trace | grep -E '^(ip|loc|colo|warp)=' | tr '\n' ' '
echo
echo "== 系统 DNS =="
cat /etc/resolv.conf | grep -v '^#'
