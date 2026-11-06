// 对 webview（noVNC 画布）目标做区域放大截图
const fs = require('fs');
const PORT = process.env.CDP_PORT || 9333;
const OUT = process.argv[2];
const [x, y, w, h] = (process.argv[4] || '0,0,800,600').split(',').map(Number);

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find((q) => q.type === 'webview');
  if (!t) { console.error('没有 webview 目标'); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === myId) { ws.removeEventListener('message', onMsg); resolve(m.result); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const r = await call('Page.captureScreenshot', {
    format: 'png',
    clip: { x, y, width: w, height: h, scale: 2 },
  });
  if (!r || !r.data) { console.error('截图失败', r); process.exit(1); }
  fs.writeFileSync(OUT, Buffer.from(r.data, 'base64'));
  console.log('已保存', OUT);
  ws.close();
})();
