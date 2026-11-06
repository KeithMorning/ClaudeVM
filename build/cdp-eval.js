// 在渲染层里执行一段 JS 并把结果打印出来（自测用，避免反复截图猜）
const PORT = process.env.CDP_PORT || 9333;
const EXPR = process.argv[2] || '1+1';
const TIMEOUT = Number(process.env.CDP_TIMEOUT || 60000);

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find((x) => x.type === 'page');
  if (!t) { console.error('没有可用的 page 目标'); process.exit(1); }
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

  const r = await call('Runtime.evaluate', {
    expression: EXPR, awaitPromise: true, returnByValue: true, timeout: TIMEOUT,
  });
  if (r && r.exceptionDetails) console.log('异常:', JSON.stringify(r.exceptionDetails).slice(0, 800));
  else console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 1));
  ws.close();
})();
