#!/usr/bin/env bash
cp /opt/config/runtime-env /tmp/runtime-env.bak 2>/dev/null || true
python3 - <<'PY'
p='/opt/config/runtime-env'
try: s=open(p,encoding='utf-8').read()
except: s=''
import re
s=re.sub(r"^export TZ=.*$", "export TZ='Asia/Taipei'", s, flags=re.M)
s=re.sub(r"^export LANG=.*$", "export LANG='zh_TW.UTF-8'", s, flags=re.M)
s=re.sub(r"^export LC_ALL=.*$", "export LC_ALL='zh_TW.UTF-8'", s, flags=re.M)
s=re.sub(r"^export LANGUAGE=.*$", "export LANGUAGE='zh_TW:zh'", s, flags=re.M)
open(p,'w',encoding='utf-8').write(s)
PY
echo "=== 台北时区文件 ==="; ls -l /usr/share/zoneinfo/Asia/Taipei 2>/dev/null && echo OK || echo MISSING
echo "=== 台北画像自检 ==="
/opt/scripts/check-env.sh --json 2>/dev/null > /tmp/check-tp2.json
python3 - <<'PY'
import json
s=open('/tmp/check-tp2.json',encoding='utf-8',errors='replace').read()
d=json.loads(s[s.find('{'):s.rfind('}')+1])
print('summary:',d.get('summary'),'| checkcc:',d.get('checkcc'),'| tz:',d.get('tz'),'| lang:',d.get('lang'))
for g in d['groups']:
    for it in g['items']:
        if any(k in it['label'] for k in ['系统时区','系统语言','语言包','浏览器语言','中文输入法']):
            print(f"  [{it['status']:4}] {it['label']}: {it['value'][:50]}")
PY
cp /tmp/runtime-env.bak /opt/config/runtime-env 2>/dev/null || true
echo "=== 已恢复 runtime-env ==="
