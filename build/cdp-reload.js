// 让正在运行的 Electron 渲染层重新加载（改完 CSS/HTML 后不必重启应用）
const PORT = process.env.CDP_PORT || 9333;

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find((x) => x.type === 'page');
  if (!t) { console.error('没有可用的 page 目标'); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } }));
  await new Promise((r) => setTimeout(r, 1200));
  console.log('reloaded:', t.title);
  ws.close();
})();
