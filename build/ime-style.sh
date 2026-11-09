#!/usr/bin/env bash
# 诊断 5：Rime 的 preedit 显示策略 + fcitx5 可配置项
R=/root/.local/share/fcitx5/rime
echo "=== Rime 配置里所有 preedit / style 相关项 ==="
grep -rn 'inline_preedit\|^style:\|preedit\|display_tray_icon\|candidate' \
  "$R"/*.yaml "$R"/custom/*.yaml 2>/dev/null | head -60
echo "=== build/fcitx5.yaml（Rime 部署时生成的 fcitx5 侧配置） ==="
cat "$R/build/fcitx5.yaml" 2>/dev/null
echo "=== schema 里 style 段 ==="
grep -n -A20 '^style:' "$R/wanxiang_pure.schema.yaml" 2>/dev/null | head -25
echo "=== 万象 default.yaml 的 menu 段（page_size 口径） ==="
grep -n -A6 '^menu:' "$R/default.yaml" 2>/dev/null | head -10
echo "=== 当前生效的 page_size（custom） ==="
cat "$R/default.custom.yaml" 2>/dev/null
echo "=== fcitx5 核心库里的 preedit 配置键 ==="
python3 - <<'PY'
import re, os, glob
paths = ['/usr/lib/x86_64-linux-gnu/libFcitx5Core.so.7',
         '/usr/lib/x86_64-linux-gnu/gtk-3.0/3.0.0/immodules/im-fcitx5.so',
         '/usr/lib/x86_64-linux-gnu/fcitx5/librime.so']
for p in paths:
    if not os.path.exists(p):
        for q in glob.glob('/usr/lib/x86_64-linux-gnu/fcitx5/*rime*'):
            if 'rime' in p:
                p = q
                break
    if not os.path.exists(p):
        print('(缺) %s' % p); continue
    d = open(p, 'rb').read()
    keys = set()
    for s in re.findall(rb'[ -~]{4,70}', d):
        t = s.decode('ascii', 'ignore')
        if re.search(r'preedit|inapplication|inline|candidate|hide', t, re.I):
            if len(t) < 70 and not t.startswith('/') and not t.startswith('_Z'):
                keys.add(t)
    print('--- %s' % p)
    for t in sorted(keys)[:40]:
        print('   ', t)
PY
echo "=== fcitx5-rime 的用户 conf 是否有模板 ==="
find /usr/share/fcitx5 -type f -name '*.conf' | xargs grep -ln 'Preedit\|preedit' 2>/dev/null | head -10
