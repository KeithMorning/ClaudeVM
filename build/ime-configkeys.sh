#!/usr/bin/env bash
# 诊断 4：从二进制/模板里挖 fcitx5 classicui 的可用配置键（无需运行 fcitx5）
PY=$(command -v python3)
echo "=== fcitx5 自带 conf 模板 ==="
find /usr/share/fcitx5 -maxdepth 3 -type f \( -name '*.conf' -o -name '*.conf.in' \) 2>/dev/null | head -40
echo "=== classicui.so 里含 preedit/candidate/hide/show 的字符串 ==="
"$PY" - <<'PY'
import re, os
p = '/usr/lib/x86_64-linux-gnu/fcitx5/libclassicui.so'
if not os.path.exists(p):
    print('(libclassicui.so 不存在)')
else:
    data = open(p, 'rb').read()
    found = set()
    for s in re.findall(rb'[ -~]{4,90}', data):
        t = s.decode('ascii', 'ignore')
        if re.search(r'preedit|candidate|hide|hidden|empty|show|window|always', t, re.I):
            if len(t) < 90 and not t.startswith('/'):
                found.add(t)
    for t in sorted(found)[:120]:
        print(t)
PY
echo "=== 所有 addon 的 conf 模板里含 preedit 的 ==="
grep -rni 'preedit\|candidate' /usr/share/fcitx5 2>/dev/null | head -40
echo "=== fcitx5-rime 的 addon 配置模板 ==="
find /usr/share/fcitx5 -iname '*rime*' -type f 2>/dev/null | head -20
for f in $(find /usr/share/fcitx5 -iname '*rime*.conf' -type f 2>/dev/null | head -3); do echo "--- $f"; cat "$f"; done
