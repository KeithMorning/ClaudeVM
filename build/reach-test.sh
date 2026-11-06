#!/bin/bash
# 复刻 checkcc 的三个可达性探测（no-cors fetch 等价于「拿到响应头就算成功」）
P="http://192.168.240.1:7897"
for u in https://claude.ai/ https://www.anthropic.com/ https://api.anthropic.com/; do
  printf '%-28s ' "$u"
  curl -s -o /dev/null -x "$P" --max-time 10 \
    -w 'dns=%{time_namelookup}s conn=%{time_connect}s tls=%{time_appconnect}s ttfb=%{time_starttransfer}s total=%{time_total}s code=%{http_code}\n' "$u"
done
echo
echo "== 连续三次 claude.ai，看是否首次慢 =="
for i in 1 2 3; do
  printf 'try%s ' "$i"
  curl -s -o /dev/null -x "$P" --max-time 10 -w 'ttfb=%{time_starttransfer}s total=%{time_total}s\n' https://claude.ai/
done
