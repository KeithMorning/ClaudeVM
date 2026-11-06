#!/bin/bash
# 验证上行：虚拟机内复制 -> Xvnc ServerCutText -> 页面 clipboard 事件 -> __clipTaken()
export DISPLAY=:1
cp /mnt/e/Web/FuckCladue/claude-vm/vm/config/novnc/desktop.html /usr/share/novnc/desktop.html

cat > /usr/share/novnc/__up.html <<'HTML'
<!DOCTYPE html><html><head><meta charset="utf-8"><title>up</title>
<style>html,body{margin:0;height:100%;background:#0d1017}</style></head><body>
<div id="screen" style="position:fixed;inset:0"></div>
<script type="module">
import RFB from './core/rfb.js';
const rfb = new RFB(document.getElementById('screen'),
  `ws://${location.hostname}:${location.port || '6080'}/websockify`,
  { credentials: { password: '' }, shared: true });
rfb.scaleViewport = true;
rfb.addEventListener('connect', () => console.log('CONNECTED'));
rfb.addEventListener('clipboard', (e) => console.log('GOT_CLIP ' + JSON.stringify(e.detail.text)));
</script></body></html>
HTML

pkill -f 'xclip -selection' 2>/dev/null; sleep 0.2
timeout 25 google-chrome-stable --headless=new --no-sandbox --disable-gpu \
  --enable-logging=stderr --v=0 --window-size=1280,800 \
  "http://127.0.0.1:6080/__up.html" >/dev/null 2>/tmp/up.log &
CH=$!

sleep 5                     # 等页面连上
echo "[写入 guest 剪贴板]"
printf 'REPLY-FROM-GUEST' | timeout 3 xclip -selection clipboard -i 2>/dev/null || true
sleep 3
echo "[取走 __clipTaken 的等价物] 直接从 X 读: [$(timeout 2 xclip -o -selection clipboard 2>/dev/null)]"
kill $CH 2>/dev/null; wait $CH 2>/dev/null

echo "--- 页面 console:"
grep -oE '"(CONNECTED|GOT_CLIP).*' /tmp/up.log | head -10
pkill -f 'xclip -selection' 2>/dev/null
rm -f /usr/share/novnc/__up.html
