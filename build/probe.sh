#!/bin/bash
# 端到端验证 noVNC 剪贴板：页面连上后推文本，容器内 xclip 读出
SRC=/mnt/e/Web/FuckCladue/claude-vm/vm/config/novnc/desktop.html
cp "$SRC" /usr/share/novnc/desktop.html
# xclip 必须读虚拟机自己那块屏；默认 DISPLAY 可能指向外面的 :0
export DISPLAY=:1

cat > /usr/share/novnc/__clip.html <<'HTML'
<!DOCTYPE html><html><head><meta charset="utf-8"><title>clip</title>
<style>html,body{margin:0;height:100%;background:#0d1017}</style></head><body>
<div id="screen" style="position:fixed;inset:0"></div>
<script type="module">
import RFB from './core/rfb.js';
const port = location.port || '6080';
console.log('BOOT');
let rfb;
try {
  rfb = new RFB(document.getElementById('screen'),
    `ws://${location.hostname}:${port}/websockify`, { credentials: { password: '' }, shared: true });
  rfb.scaleViewport = true;
  console.log('RFB_CONSTRUCTED state=' + rfb._rfb_connection_state + ' viewOnly=' + rfb._viewOnly);
} catch (e) { console.log('CONSTRUCT_FAIL ' + e.message); }
if (rfb) {
  rfb.addEventListener('connect', () => {
    console.log('CONNECTED state=' + rfb._rfb_connection_state);
    setTimeout(() => {
      try { rfb.clipboardPasteFrom('HELLO-FROM-HOST'); console.log('SENT state=' + rfb._rfb_connection_state); }
      catch (e) { console.log('SEND_FAIL ' + e.message); }
    }, 800);
  });
  rfb.addEventListener('disconnect', (e) => console.log('DISCONNECT ' + JSON.stringify(e.detail)));
  rfb.addEventListener('clipboard', (e) => console.log('GOT_CLIP ' + JSON.stringify(e.detail.text)));
}
</script></body></html>
HTML

# 关键：不要用 xclip 去「清空」剪贴板 —— 那会让 xclip 抢占 selection owner，
# 之后 Xvnc 收到 ClientCutText 也抢不回来，测试就永远是空。
pkill -f 'xclip -selection' 2>/dev/null || true
sleep 0.3
timeout 25 google-chrome-stable --headless=new --no-sandbox --disable-gpu \
  --enable-logging=stderr --v=0 --window-size=1280,800 \
  "http://127.0.0.1:6080/__clip.html" >/dev/null 2>/tmp/clip.log &
CH=$!

FOUND=""
for i in $(seq 1 30); do
  V=$(xclip -o -selection clipboard 2>/dev/null)
  case "$V" in *HELLO-FROM-HOST*) FOUND="$V"; echo "命中@$((i*500))ms: $V"; break ;; esac
  sleep 0.5
done
kill $CH 2>/dev/null; wait $CH 2>/dev/null
[ -z "$FOUND" ] && echo "未命中，X 剪贴板当前: [$(xclip -o -selection clipboard 2>/dev/null)]"

echo "--- 页面 console:"
grep -oE '"(BOOT|RFB_CONSTRUCTED|CONSTRUCT_FAIL|CONNECTED|SENT|SEND_FAIL|DISCONNECT|GOT_CLIP).*' /tmp/clip.log | head -20
rm -f /usr/share/novnc/__clip.html
