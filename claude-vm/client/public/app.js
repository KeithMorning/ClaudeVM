async function refresh() {
  try {
    const r = await fetch('/api/status').then(r => r.json());
    document.getElementById('status').textContent = r.running ? '● 虚拟环境运行中' : '○ 已停止';
  } catch {}
}

document.getElementById('check').onclick = async () => {
  const el = document.getElementById('result');
  el.textContent = '运行中…';
  const r = await fetch('/api/check', { method: 'POST' }).then(r => r.json());
  el.textContent = r.ok ? r.out : ('错误: ' + r.out);
};

document.getElementById('stop').onclick = async () => {
  await fetch('/api/stop', { method: 'POST' });
  refresh();
};

refresh();
setInterval(refresh, 5000);
