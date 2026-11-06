#!/usr/bin/env bash
SRC=/mnt/e/Web/FuckCladue/claude-desktop/runtime/scripts
for f in "$SRC"/*; do [ -f "$f" ] || continue; b=$(basename "$f"); cp -f "$f" "/opt/scripts/.$b.tmp" && mv -f "/opt/scripts/.$b.tmp" "/opt/scripts/$b"; done
chmod +x /opt/scripts/*.sh

echo "=== A 台北 locale 现场生成 ==="
LANG_WANT=zh_TW.UTF-8
if ! locale -a 2>/dev/null | tr 'A-Z' 'a-z' | grep -q '^zh_tw'; then
  sed -i -E 's/^# *(zh_TW\.UTF-8)/\1/' /etc/locale.gen
  locale-gen >/dev/null 2>&1 && echo "locale-gen OK" || echo "locale-gen FAIL"
fi
locale -a 2>/dev/null | grep -i zh_tw || echo "仍缺 zh_TW"

echo "=== B rime-setup.sh ==="
INPUT_METHOD=rime /opt/scripts/rime-setup.sh
echo "配置: $(cat /root/.config/ibus/rime/default.custom.yaml 2>/dev/null | tr '\n' ' ')"

echo "=== C ibus XIM（本会话常驻）==="
pkill -x ibus-daemon 2>/dev/null || true; sleep 1
export DISPLAY=:0 LANG=zh_TW.UTF-8 XMODIFIERS=@im=ibus GTK_IM_MODULE=ibus QT_IM_MODULE=ibus
ibus-daemon -d --xim >/tmp/ibus-test.log 2>&1
sleep 4
echo "XIM: $(xprop -root XIM_SERVERS 2>/dev/null | head -1)"
echo "engine: $(ibus engine 2>/dev/null | head -1)"

echo "=== D Chrome 语言推导 ==="
bash -c 'LANG=zh_TW.UTF-8; case "$LANG" in zh_TW*) echo "zh-TW";; esac'

echo "=== E 台北画像自检（只看地区与输入法项）==="
TZ=Asia/Taipei LANG=zh_TW.UTF-8 LC_ALL=zh_TW.UTF-8 LANGUAGE=zh_TW:zh \
DISPLAY_MODE=wslg INPUT_METHOD=rime XMODIFIERS=@im=ibus \
/opt/scripts/check-env.sh --json 2>/dev/null > /tmp/check-taipei.json
python3 - <<'PY'
import json
s=open('/tmp/check-taipei.json',encoding='utf-8',errors='replace').read()
d=json.loads(s[s.find('{'):s.rfind('}')+1])
print('summary:',d.get('summary'),'checkcc:',d.get('checkcc'))
for g in d['groups']:
    for it in g['items']:
        if any(k in it['label'] for k in ['系统时区','系统语言','语言包','浏览器语言','中文输入法','网络熔断']):
            print(f"  [{it['status']:4}] {it['label']}: {it['value'][:52]}")
PY
