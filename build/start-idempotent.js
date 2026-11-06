// 验证「重复点启动」不会再重建虚拟机：连调三次 start，看是否走接管分支。
// 配置直接取应用自己的（getConfig），避免与真实配置不一致造成误判。
const PORT = process.env.CDP_PORT || 9335;

async function evalInPage(expr) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find((x) => x.type === 'page');
  if (!t) throw new Error('没有可用的 page 目标');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const out = await new Promise((resolve, reject) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) {
        if (m.result && m.result.exceptionDetails) reject(new Error(JSON.stringify(m.result.exceptionDetails)));
        else resolve(m.result && m.result.result ? m.result.result.value : null);
      }
    });
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 },
    }));
  });
  ws.close();
  return out;
}

(async () => {
  const expr = `(async () => {
    const cfg = await window.api.getConfig();
    const t0 = Date.now();
    const r = await window.api.start(cfg);
    return JSON.stringify({ ms: Date.now() - t0, ok: r.ok, resumed: !!r.resumed,
      notes: r.notes || [], err: (r.error || '').slice(0, 160), workspace: cfg.workspace });
  })()`;
  for (let i = 1; i <= 3; i++) {
    const r = JSON.parse(await evalInPage(expr));
    console.log(`第 ${i} 次 start: ${JSON.stringify(r)}`);
    await new Promise((r2) => setTimeout(r2, 1000));
  }
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
