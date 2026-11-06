const PORT = process.env.CDP_PORT || 9335;
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find((x) => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const out = await new Promise((res, rej) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      if (m.result?.exceptionDetails) rej(new Error(JSON.stringify(m.result.exceptionDetails)));
      else res(m.result?.result?.value);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(async()=>{const c=await window.api.getConfig();const t0=Date.now();const r=await window.api.start(c);return JSON.stringify({ms:Date.now()-t0,ok:r.ok,resumed:!!r.resumed,err:(r.error||'').slice(0,150)})})()`,
      awaitPromise: true, returnByValue: true, timeout: 120000 } }));
  });
  console.log(out);
  ws.close();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
