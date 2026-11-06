// 通过 CDP 截取 Electron 渲染层，保存 PNG（用 Node 内建 WebSocket，无需依赖）
const fs = require('fs');

const PORT = process.env.CDP_PORT || 9336;
const OUT = process.argv[2] || 'E:\\Web\\FuckCladue\\build\\ui-1.png';
const WANT = process.argv[3] || 'Claude VM';

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && (!WANT || x.title === WANT)) || list.find((x) => x.type === 'page');
  if (!t) { console.error('没有可用的 page 目标'); process.exit(1); }
  console.log('目标:', t.title, t.webSocketDebuggerUrl);

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }));

  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === myId) { ws.removeEventListener('message', onMsg); resolve(m.result); }
    };
    ws.addEventListener('message', onMsg);
    send(myId, method, params);
  });

  // 等一会儿让自动探测那 600ms 的延时跑完
  await new Promise((r) => setTimeout(r, 2500));
  const r = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(r.data, 'base64'));
  console.log('已保存', OUT);
  ws.close();
})();
