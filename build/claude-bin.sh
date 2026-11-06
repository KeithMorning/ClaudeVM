#!/bin/bash
N=/usr/local/lib/nodejs/node-v20.18.1-linux-x64
echo "== $N/bin =="
ls -l "$N/bin"
echo
echo "== bin/claude 头部 =="
head -c 120 "$N/bin/claude" 2>/dev/null | cat -v; echo
echo
echo "== claude-code 包的 bin 字段 =="
python3 - <<'PY' 2>/dev/null || sed -n 's/.*"bin":\s*\({[^}]*}\).*/\1/p' "$N/lib/node_modules/@anthropic-ai/claude-code/package.json"
import json
p="/usr/local/lib/nodejs/node-v20.18.1-linux-x64/lib/node_modules/@anthropic-ai/claude-code/package.json"
print(json.load(open(p)).get("bin"))
PY
