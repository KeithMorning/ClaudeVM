#!/bin/bash
# 同一时刻、同一条链路，做两件事：
#   A. 我们自己按 checkcc 的方式去问那几个 IP 情报源（浏览器走的就是这些）
#   B. 调 checkcc 的接口，看它对这些源给出的结论
# 两份数据放一起，就能判断「是谁算错了」。
P="$(cat /opt/config/local-proxy 2>/dev/null)"
[ -n "$P" ] || P="http://192.168.240.1:7897"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
OUT=/mnt/e/Web/FuckCladue/build

echo "代理: $P"
echo
echo "=== A. 我们自己问这些源（都经同一代理） ==="
printf '%-22s ' "api.ipify.org";  curl -s --max-time 12 -x "$P" https://api.ipify.org; echo
printf '%-22s ' "ipinfo.io/ip";   curl -s --max-time 12 -x "$P" https://ipinfo.io/ip; echo
printf '%-22s ' "api.ip.sb/ip";   curl -s --max-time 12 -x "$P" https://api.ip.sb/ip; echo
printf '%-22s ' "ipwho.is";       curl -s --max-time 12 -x "$P" https://ipwho.is/ | sed -n 's/.*"ip":"\([^"]*\)".*/\1/p'; echo
printf '%-22s ' "ping0.cc";       curl -s --max-time 12 -x "$P" -H 'Referer: https://checkcc.org/' https://ping0.cc/geo/jsonp/cbx | head -c 160; echo
printf '%-22s ' "1.1.1.1 colo";   curl -s --max-time 12 -x "$P" https://1.1.1.1/cdn-cgi/trace | grep -E '^(ip|loc|colo)=' | tr '\n' ' '; echo
echo
echo "=== B. checkcc 接口的原始返回（脱敏前） ==="
curl -s --max-time 30 -x "$P" \
  -H "User-Agent: $UA" -H "Referer: https://checkcc.org/" -H "Accept: */*" \
  -H "Accept-Language: zh-CN,zh;q=0.9" \
  "https://api.checkcc.org/check?region=auto&lang=zh-CN&t=$(date +%s)000" \
  -o "$OUT/cc_api_now.json"
echo "已保存 $(wc -c < "$OUT/cc_api_now.json") 字节 → cc_api_now.json"
echo
echo "=== C. 系统 DNS ==="
grep -v '^#' /etc/resolv.conf | grep -v '^$'
echo "解析 claude.ai → $(getent hosts claude.ai | head -2 | tr '\n' ' ')"
echo "解析 ipinfo.io  → $(getent hosts ipinfo.io | head -1)"
