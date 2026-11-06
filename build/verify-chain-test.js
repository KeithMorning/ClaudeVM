// 复刻 main.js 里的校验逻辑（execFile('wsl.exe', args) 无 MSYS 干扰），
// 直接在真实发行版里跑一遍，确认「读 local-proxy → 走代理 → 拿状态码 / 出口」都对。
const { execFile } = require('child_process');

const DISTRO = 'claude-vm';

function runWsl(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('wsl.exe', args, { maxBuffer: 1024 * 1024 * 32, windowsHide: true, ...opts },
      (err, stdout, stderr) => resolve({
        ok: !err,
        stdout: stdout || '',
        stderr: stderr || '',
      }));
  });
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function containerProxyEndpoint(fallback) {
  const r = await runWsl(['-d', DISTRO, '-u', 'root', '--', 'bash', '-c',
    'cat /opt/config/local-proxy 2>/dev/null'], { timeout: 15000 });
  const v = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  return /^[a-z0-9]+:\/\//i.test(v) ? v : fallback;
}

async function verifyProxyChain(ep) {
  const p = shellQuote(ep);
  const one = async (url, to) => {
    const sh = `curl -s -o /dev/null -w "%{http_code}" --max-time ${to} -x ${p} ${url}`;
    const r = await runWsl(['-d', DISTRO, '-u', 'root', '--', 'bash', '-c', sh], { timeout: (to + 8) * 1000 });
    return String(r.stdout || '').trim();
  };
  const code = await one('https://api.anthropic.com', 12);
  if (code && code !== '000') return { code, proxyAlive: true };
  const probe = await one('http://cp.cloudflare.com/generate_204', 8);
  return { code: code || '000', proxyAlive: !!probe && probe !== '000' };
}

async function verifyExitViaRouter(ep) {
  const sh =
    `curl -s --max-time 10 -x ${shellQuote(ep)} https://ipinfo.io/json ` +
    `| sed -n 's/.*"ip": *"\\([^"]*\\)".*/ip=\\1/p;` +
    `s/.*"city": *"\\([^"]*\\)".*/city=\\1/p;` +
    `s/.*"org": *"\\([^"]*\\)".*/org=\\1/p'`;
  const r = await runWsl(['-d', DISTRO, '-u', 'root', '--', 'bash', '-c', sh], { timeout: 20000 });
  const out = {};
  for (const line of String(r.stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out.ip ? out : null;
}

(async () => {
  const fallback = process.argv[2] || 'http://127.0.0.1:7890';
  const t0 = Date.now();
  const ep = await containerProxyEndpoint(fallback);
  console.log('endpoint =', ep, '(', Date.now() - t0, 'ms )');
  const chain = await verifyProxyChain(ep);
  console.log('chain    =', JSON.stringify(chain));
  const exit = await verifyExitViaRouter(ep);
  console.log('exit     =', JSON.stringify(exit));
  console.log('判定     =', chain.code && chain.code !== '000' ? '链路通过' : '链路失败');
  console.log('总耗时   =', Date.now() - t0, 'ms');
})();
