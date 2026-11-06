// 独立复刻 main.js 的 detectProxy()，验证 Windows 侧探测逻辑
const net = require('net');
const { execFile } = require('child_process');

const PROXY_CANDIDATES = [7897, 7890, 7891, 7899, 10809, 10808, 1080, 8118, 8888, 2080, 2081, 20171];

function waitPort(port, timeoutMs, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const s = net.connect(port, host);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

function curlText(url, proxyUrl, timeoutSec = 8) {
  return new Promise((resolve) => {
    const args = ['-sS', '--max-time', String(timeoutSec)];
    if (proxyUrl) args.push('-x', proxyUrl);
    args.push(url);
    execFile('curl', args, { timeout: timeoutSec * 1000 + 2500, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

(async () => {
  const t0 = Date.now();
  const flags = await Promise.all(PROXY_CANDIDATES.map((port) => waitPort(port, 250, '127.0.0.1')));
  const listening = PROXY_CANDIDATES.filter((_, i) => flags[i]);
  console.log('监听中的候选端口:', listening.length ? listening.join(', ') : '(无)');
  if (!listening.length) { console.log('=> found:false'); return; }

  for (const port of listening) {
    const url = `http://127.0.0.1:${port}`;
    const body = await curlText('https://ipinfo.io/json', url, 8);
    if (!body) { console.log(`  ${port}: 请求失败`); continue; }
    let info = {};
    try { info = JSON.parse(body); } catch { console.log(`  ${port}: 返回不是 JSON`); continue; }
    if (!info.ip) { console.log(`  ${port}: 无 ip 字段`); continue; }
    console.log(`  ${port}: OK`);
    console.log('=> found:true', {
      port, url,
      checked: [info.ip, info.org, info.city].filter(Boolean).join(' · '),
    });
    console.log('耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    return;
  }
  console.log('=> found:false, all:', listening.map(p => '127.0.0.1:' + p));
})();
