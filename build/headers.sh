#!/bin/bash
P="http://192.168.240.1:7897"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
for u in https://claude.ai/ https://www.anthropic.com/; do
  echo "== $u"
  curl -sI -x "$P" -A "$UA" --max-time 10 "$u" \
    | grep -iE '^(HTTP|cross-origin|location|cf-mitigated|server|content-type|alt-svc|strict-transport|set-cookie)' | cut -c1-110
  echo
done
