#!/usr/bin/env bash
echo "=== 复现所需工具 ==="
for c in Xvfb Xtigervnc xdotool import scrot xwd openbox lxterminal xterm fcitx5 fcitx5-remote dbus-launch dbus-daemon python3 x11vnc websockify; do
  p=$(command -v "$c" 2>/dev/null)
  echo "$c = ${p:-MISSING}"
done
echo "=== rime build 产物 ==="
B=/root/.local/share/fcitx5/rime/build
ls -la "$B" 2>/dev/null | head -25
echo "=== prism.bin 里是否出现各编码（明文音节探测） ==="
python3 - <<'PY'
import os, re
p = '/root/.local/share/fcitx5/rime/build/wanxiang_pure.prism.bin'
if not os.path.exists(p):
    print('(prism.bin 不存在)')
else:
    d = open(p, 'rb').read()
    strs = set(re.findall(rb'[a-z]{1,10}', d))
    for s in ('f', 'ff', 'fff', 'ffff', 'fa', 'fu', 'fan', 'fang', 'wo', 'ni', 'nihao'):
        print('%-8s %s' % (s, '命中' if s.encode() in strs else '未命中'))
    print('prism size =', len(d))
PY
echo "=== 系统里可用的截图/窗口工具（dpkg） ==="
dpkg -l 2>/dev/null | grep -iE 'x11-apps|xdotool|imagemagick|scrot|tigervnc|xvfb' | awk '{print $2, $3}'
