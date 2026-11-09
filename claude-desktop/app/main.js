'use strict';
// Claude VM 桌面主进程
// 负责：窗口、配置持久化、通过 WSL 管理 Linux 运行时（导入/启动/停止/自检）
const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { execFile, spawn } = require('child_process');
// 平台后端：Windows → WSL2，macOS/Linux → 容器（Docker/OrbStack）。
// 平台差异全部收敛在 lib/vm-backend.js，本文件不再直接碰 wsl.exe 之外的平台 API。
// 注意：必须取 getBackend() 的**实例** —— 方法（runGuest/ensureImage/…）挂在实例上，
// 只 require 模块拿到的是导出表，调用会直接 TypeError（1.0.32 就是这么把启动搞挂的）。
const backend = require('./lib/vm-backend').getBackend();

const DISTRO = 'claude-vm';
const NOVNC_PORT = 6080;
const ROUTER_PORT = 7890;   // 容器内白名单路由端口（与 entrypoint 保持一致）
const VNC_PASS = 'claudevm';
// 运行时脚本 / 界面资源有变更时 +1。它进配置指纹，保证升级后第一次点「启动」
// 不会去「接管」一个由旧脚本拉起的会话 —— 那些会话里的 openbox、entrypoint、
// 字体、代理规则全是旧版的，接管等于永远不生效。
const RUNTIME_REV = 9;
// 白名单：从 claude CLI 二进制里实际提取到的运行期域名
// （code.claude.com / platform.claude.com 是 OAuth 登录与 API key 控制台，
//   漏掉会让登录流量走直连，与 API 出口形成「两个国家」的矛盾信号）
// checkcc.org / cleanup.io 是第三方「环境体检」站点：必须一起走代理，
// 否则它看到的是直连出口 IP，与 Anthropic 侧看到的对不上，交叉验证必然失败。
// cloudflare-dns.com / dns.google：浏览器 DNS-over-HTTPS，让域名解析也发生在代理那侧，
// 否则本地运营商 DNS 会把「DNS 地区 ≠ 出口地区」判成风险项。
const DEFAULT_WHITELIST = '.anthropic.com,.claude.com,.claude.ai,.claudeusercontent.com,clau.de,.checkcc.org,.cleanup.io,cloudflare-dns.com,dns.google';
const LEGACY_WHITELIST = '.anthropic.com,.claude.ai,.claudeusercontent.com';
const LEGACY_WHITELISTS = [
  LEGACY_WHITELIST,
  '.anthropic.com,.claude.com,.claude.ai,.claudeusercontent.com,clau.de',
  '.anthropic.com,.claude.com,.claude.ai,.claudeusercontent.com,clau.de,.checkcc.org,.cleanup.io',
];

let win = null;
let runtimeProc = null;
// 主动停止/退出时收到的 exit 不是异常，不该弹「意外退出」提示
let stopping = false;

// ---------- 单实例 ----------
// 双击两次图标不该起两套运行时去抢同一个发行版和 6080 端口 ——
// 那种情况表现成「白屏 / 连不上」，用户完全没法自己看出来。
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

// ---------- 路径与配置 ----------
const userDir = () => app.getPath('userData');
const cfgPath = () => path.join(userDir(), 'config.json');
const dataDir = () => path.join(userDir(), 'runtime');
// 上次「成功拉起桌面」时用的配置指纹。用来判断现在这台虚拟机是不是就按这份配置起的 ——
// 是的话，重复点「启动」应当直接接管，而不是先杀掉整台 VM 再重建。
const lastStartPath = () => path.join(userDir(), 'last-start.json');

// ---------- 日志 ----------
// 运行时是 spawn 出去的 wsl.exe，以前用 stdio:'ignore' 把它的输出全丢了 ——
// 出问题只能靠用户截图猜。现在统一落盘，诊断包也读这里。
const logDir = () => path.join(userDir(), 'logs');
const logFile = () => path.join(logDir(), 'vm.log');
let logStream = null;

function rotateLogs() {
  try {
    const files = fs.readdirSync(logDir())
      .filter((f) => /^vm-\d+\.log$/.test(f))
      .sort()
      .reverse();
    files.slice(2).forEach((f) => { try { fs.unlinkSync(path.join(logDir(), f)); } catch {} });
  } catch {}
}

function openLog() {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    const f = logFile();
    let size = 0;
    try { size = fs.statSync(f).size; } catch {}
    if (size > 4 * 1024 * 1024) {
      try { fs.renameSync(f, path.join(logDir(), `vm-${Date.now()}.log`)); } catch {}
      rotateLogs();
    }
    logStream = fs.createWriteStream(f, { flags: 'a' });
  } catch { logStream = null; }
}

// wsl.exe 自己的消息是 UTF-16LE（带大量 \0），Linux 程序的输出是 UTF-8 —— 混在一起
function decodeChunk(buf) {
  const head = buf.subarray(0, Math.min(256, buf.length));
  if (head.includes(0)) {
    try { return buf.toString('utf16le'); } catch {}
  }
  return buf.toString('utf8');
}

function log(tag, msg) {
  const body = String(msg == null ? '' : msg).replace(/\s+$/, '');
  if (!body) return;
  const line = `[${new Date().toISOString()}] [${tag}] ${body}`;
  try { if (logStream) logStream.write(line + '\n'); } catch {}
}

// 代理地址里可能带 user:pass，日志和诊断包都要先脱敏
function redact(u) {
  const s = String(u || '');
  return s.replace(/\/\/[^/@\s]+@/, '//***@');
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { return {}; }
}

function mergeCfg(saved) {
  const c = { ...defaultConfig(), ...saved };
  // 读出来就收敛成规范路径：界面里显示的、以及后续算指纹用的都是同一个值
  if (c.workspace) c.workspace = normalizeWinPath(c.workspace);
  // macOS 没有 WSLg，只有串流桌面一条路（选项在渲染层也会隐藏）
  if (process.platform === 'darwin') c.displayMode = 'desktop';
  return c;
}
// 路径里混进多余的斜杠（粘贴、转义、手打都可能）会让指纹每次都不一样，
// 进而被当成「配置已变更」反复重建虚拟机。写盘前统一收敛成规范形式。
function normalizeWinPath(p) {
  const s = String(p || '').trim();
  if (!s) return s;
  // POSIX 路径（macOS / Linux 工作区）：只收敛重复斜杠，
  // 不能做下面的反斜杠替换 —— /Users/x 会被改成 \Users\x，指纹和挂载全错。
  if (s.startsWith('/')) return s.replace(/\/{2,}/g, '/').replace(/^(.+)\/$/, '$1');
  const unified = s.replace(/\//g, '\\');
  // UNC（\\server\share）要保留开头两个反斜杠
  if (/^\\\\./.test(unified)) return '\\\\' + unified.replace(/^\\+/, '');
  return unified.replace(/\\{2,}/g, '\\');
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  const clean = { ...cfg };
  if (clean.workspace) clean.workspace = normalizeWinPath(clean.workspace);
  fs.writeFileSync(cfgPath(), JSON.stringify(clean, null, 2));
  return clean;
}

function defaultConfig() {
  return {
    // 默认按「中国台湾地区·台北的用户挂 VPN」建模：UTC+8 作息对齐中文用户，
    // 又不在检测站点名的 Asia/Shanghai 等中国时区名单内。
    region: 'tw-taipei',
    tz: 'Asia/Taipei',
    lang: 'zh_TW.UTF-8',
    proxy: '',
    // all      —— 全部流量交给用户自己的代理，由它按自己的规则分流（默认）
    // whitelist —— 只有白名单域名走代理，其余直连
    proxyMode: 'all',
    whitelist: DEFAULT_WHITELIST,
    workspace: path.join(app.getPath('home'), 'claude-workspace'),
    // wslg    —— 默认。Linux 应用是 Windows 原生窗口，日常只在终端里跑 Claude Code。
    // desktop —— 保留 noVNC 串流桌面（也是 Mac 上唯一可嵌进应用窗口的图形方案）。
    displayMode: 'wslg',
    // strict —— 删默认路由 + 关 IPv6，代理是唯一出口，代理断了网络就是断的（默认）
    // off    —— 退回旧行为，代理断开时会回落到本机直连，有暴露真实环境的风险
    netGuard: 'strict',
    // 出口落在 CN/HK/MO 时是否硬阻断（0 = 只提示仍放行，用于「国内中转+境外落地」这类链）
    netGuardStrictRegion: true,
    // rime —— IBus + Rime 万象拼音词库，输入法跑在 VM 内，经 XIM 提交给 xterm
    inputMethod: 'off',
  };
}

function rootfsPath() {
  const dev = path.join(__dirname, '..', 'runtime', 'rootfs.tar.gz');
  if (fs.existsSync(dev)) return dev;
  return path.join(process.resourcesPath, 'rootfs.tar.gz');
}

// 运行时脚本目录：打包后在 resources/scripts，开发时在 runtime/scripts
function scriptsDir() {
  const dev = path.join(__dirname, '..', 'runtime', 'scripts');
  if (fs.existsSync(dev)) return dev;
  const packed = path.join(process.resourcesPath, 'scripts');
  if (fs.existsSync(packed)) return packed;
  return null;
}

// 界面资源目录：串流页 / 欢迎页这些也会随版本改动，必须和脚本一起更新，
// 否则用户装新版后看到的还是镜像里那份旧页面。
function assetsDir() {
  const dev = path.join(__dirname, '..', 'runtime', 'assets');
  if (fs.existsSync(dev)) return dev;
  const packed = path.join(process.resourcesPath, 'assets');
  if (fs.existsSync(packed)) return packed;
  return null;
}

// 把最新的 entrypoint / proxy-router / check-env 同步进已导入的发行版。
// 否则用户装过旧版后，发行版里一直是旧脚本，改了也生效不了。
async function syncScripts() {
  const dir = scriptsDir();
  if (!dir) return { ok: false, reason: 'scripts-missing' };
  // guest 侧路径由后端给：WSL 是 /mnt/c/...，容器是只读挂载点 /mnt/sync-scripts
  const wslDir = backend.guestScriptsPath(dir);
  const asDir = assetsDir();
  // 资源拷到 /opt/assets，由 entrypoint 覆盖到 /usr/share/novnc 等最终位置
  // 末尾不要带分号：下面用 '; ' 拼接，多一个分号会变成 ';;' —— bash 语法错误，
  // 整条同步命令直接失败（1.0.19 起每次启动报「脚本同步失败」就是这个），
  // 而且脚本一个都不会更新。踩过一次，别再加回去。
  const assetsCmd = asDir
    ? `mkdir -p /opt/assets && cp -rf '${backend.guestAssetsPath(asDir)}/.' /opt/assets/ 2>/dev/null`
    : '';
  // openbox 配置热更新：不必等 entrypoint 重启，点一次「启动」就让标题栏按钮修复生效。
  // 1.0.27 的教训：只把新配置放进 /opt/assets，可 VM 里跑的还是旧版 entrypoint
  // （它固定从 /opt/config 读），于是 ~/.config/openbox/rc.xml 每次启动都被覆盖回旧版，
  // 用户装了新版却依然点不动 ✕。所以这里把**旧版回退源**也一并更新。
  const openboxHotfix = [
    'if [ -f /opt/assets/config/openbox-rc.xml ]; then',
    'mkdir -p /root/.config/openbox;',
    'cp -f /opt/assets/config/openbox-rc.xml /root/.config/openbox/rc.xml;',
    'cp -f /opt/assets/config/openbox-rc.xml /opt/config/openbox-rc.xml;',
    "pgrep -x openbox >/dev/null 2>&1 && DISPLAY=:1 openbox --reconfigure >/dev/null 2>&1 || true;",
    'fi',
  ].join(' ');
  // 原子替换脚本：先写临时文件再 mv（同分区 rename 是原子的）。
  // 原来直接 `cp -f`，那是**就地截断**再写 —— 如果此刻虚拟机正在跑，它的 bash 已经
  // 打开了 entrypoint.sh 在逐行读，截断后读取位置会错开半个字符，
  // 于是把注释里的中文当成命令执行，脚本以 127 退出，整个 VM 跟着挂掉。
  // 实测日志：`entrypoint.sh: line 337: $'\200断就会留下': command not found`。
  const sh = [
    'mkdir -p /opt/scripts',
    `for f in '${wslDir}'/*; do b=$(basename "$f"); cp -f "$f" "/opt/scripts/.$b.tmp" 2>/dev/null && mv -f "/opt/scripts/.$b.tmp" "/opt/scripts/$b"; done`,
    'chmod +x /opt/scripts/*.sh 2>/dev/null',
    assetsCmd,
    openboxHotfix,
    'echo SYNCED',
  ].filter(Boolean).join('; ');
  const r = await runWsl(['bash', '-c', sh], { timeout: 30000 });
  return { ok: /SYNCED/.test(r.stdout) };
}

// Windows 路径 -> WSL 内 /mnt/x/... 路径
function toWslPath(p) {
  if (!p) return '';
  const s = p.replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(s);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
  return s;
}

// ---------- WSL 调用 ----------
// 名字保留 runWsl（测试切片按此名注入桩），语义已是「在 guest 内执行命令」：
// args 为 guest 内 argv（如 ['bash', '-c', sh]），由后端翻译成 wsl.exe / docker exec。
// 历史调用形如 ['bash', '-c', sh]，1.0.32 起
// 只传 guest 部分，平台前缀由 lib/vm-backend.js 拼。
function runWsl(args, opts = {}) {
  return backend.runGuest(args, opts);
}

// WSL / 容器运行时可用性预检：区分「根本没装」与「装了但跑不起来」
async function probeWsl() {
  return backend.probe();
}


function cleanWslList(s) {
  return s.replace(/\0/g, '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

async function distroExists() {
  return backend.imageExists();
}

function waitPort(port, timeoutMs, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const s = net.connect(port, host);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(tick, 700);
      });
    };
    tick();
  });
}

// ---------- 上游代理地址解析 ----------
// 关键：WSL2 默认 NAT 网络下，容器内的 127.0.0.1 ≠ Windows 的 127.0.0.1。
// 用户在界面里填本机代理（如 http://127.0.0.1:7890）时，容器内这个地址
// 恰好可能是 router 自身 → 代理自环。这里自动探测并换成宿主网关地址。
function isLoopbackHost(h) {
  const s = (h || '').toLowerCase();
  return s === 'localhost' || s === '127.0.0.1' || s === '::1' || s === '';
}

// Chrome 的 --proxy-server 只认 host:port，遇到 "http://h:p/" 这种尾斜杠会
// 直接报 ERR_NO_SUPPORTED_PROXIES；curl 却完全不在意。所有出入代理地址的地方
// 都过一遍这个函数，避免「命令行能用、浏览器不能用」的割裂。
const stripSlash = (u) => String(u || '').trim().replace(/\/+$/, '');

function parseProxy(s) {
  let v = (s || '').trim();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'http://' + v;
  try {
    const u = new URL(v);
    const port = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
    // 不能用 u.href：它会把空路径补成 "/"，得到 http://h:p/ 这种带尾斜杠的写法。
    // curl 不在意，但 Chrome 的 --proxy-server 会直接判成 ERR_NO_SUPPORTED_PROXIES
    // —— 表现为「自检全绿、浏览器一片 This site can't be reached」。
    const pathPart = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return { href: `${u.protocol}//${u.host}${pathPart}`, host: u.hostname, port, protocol: u.protocol };
  } catch { return null; }
}

// ---------- 本机代理自动探测 ----------
// 目标：用户不用知道「端口是多少」这件事。
// Clash Verge 默认混合端口 7897，Clash for Windows 7890，v2rayN 10809，
// SS/SSR 1080，Privoxy 8118 —— 按命中概率排序，逐个做真实的代理请求验证。
// 只监听不等于能用（防火墙、只允许本机回环、端口被占用都会骗人），
// 所以必须发一次真正的 CONNECT + 取回 JSON 才算通过。
const PROXY_CANDIDATES = [7897, 7890, 7891, 7899, 10809, 10808, 1080, 8118, 8888, 2080, 2081, 20171];

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

async function detectProxy() {
  // 1) 先筛出真正在监听的端口。并发扫，12 个端口的开销≈扫 1 个（约 0.5s）；
  //    顺序扫会累加到 5 秒以上，点「自动检测」的感觉就变成卡住了。
  const flags = await Promise.all(
    PROXY_CANDIDATES.map((port) => waitPort(port, 250, '127.0.0.1'))
  );
  const listening = PROXY_CANDIDATES.filter((_, i) => flags[i]);
  if (!listening.length) return { found: false, all: [] };

  // 2) 逐个发真实请求，第一个能出网的即为答案
  for (const port of listening) {
    const url = `http://127.0.0.1:${port}`;
    const body = await curlText('https://ipinfo.io/json', url, 8);
    if (!body) continue;
    let info = {};
    try { info = JSON.parse(body); } catch { continue; }
    if (!info.ip) continue;
    return {
      found: true,
      port,
      url,
      exit: info,
      checked: [info.ip, info.org, info.city].filter(Boolean).join(' · '),
    };
  }
  // 端口在听，但都不像个能用的代理
  return { found: false, all: listening.map((p) => `127.0.0.1:${p}`) };
}

//   · 只冷启动一次发行版，避免多次 `wsl -d` 叠加超时
//   · 脚本用 base64 传入，绕开 wsl.exe / bash 的多重引号问题
const PROBE_JS = `
const net = require('net');
const hosts = __HOSTS__;
const port = __PORT__;
const ok = [];
let left = hosts.length;
const fin = () => { console.log('OK:' + ok.join(',')); process.exit(0); };
setTimeout(fin, 8000);
hosts.forEach((h) => {
  let settled = false;
  const done = () => { if (settled) return; settled = true; if (--left === 0) fin(); };
  const s = net.connect({ host: h, port: port });
  s.setTimeout(2500);
  s.on('connect', () => { ok.push(h); s.destroy(); done(); });
  s.on('timeout', () => { s.destroy(); done(); });
  s.on('error', () => { done(); });
});
`;

// 返回 { reach: [可达地址], err: 探测本身失败的原因（null 表示探测正常执行） }
async function wslProbeHosts(hosts, port) {
  if (!hosts.length) return { reach: [], err: null };
  const js = PROBE_JS.replace('__HOSTS__', JSON.stringify(hosts)).replace('__PORT__', String(port));
  const b64 = Buffer.from(js, 'utf8').toString('base64');
  const sh = `echo ${b64} | base64 -d > /tmp/proxy-probe.js && node /tmp/proxy-probe.js`;
  const r = await runWsl(['bash', '-c', sh], { timeout: 30000 });
  const m = /OK:(.*)/.exec(r.stdout || '');
  if (!m) {
    // 探测脚本没跑起来（node 缺失 / 发行版没起来）：把真实错误带出去，
    // 不要伪装成“代理只允许本机访问”
    const raw = (r.stderr || r.stdout || '').trim();
    return { reach: [], err: raw.split('\n').filter(Boolean).slice(-2).join(' ') || '探测脚本未返回结果' };
  }
  return { reach: m[1].split(',').map(s => s.trim()).filter(Boolean), err: null };
}

// 容器内可见的「Windows 宿主地址」候选。
// 坑：网络熔断（net-guard）为了实现 fail-closed 会用 netlink 删掉默认路由，
// 而 `wsl --terminate` 只终止发行版、**不会重建网络命名空间**，那条默认路由
// 就一直缺失；只有 `wsl --shutdown` 才会恢复。旧版只读默认路由算网关，
// 于是「停止 → 启动」必定在 resolveUpstream 失败，连 spawn 都走不到 ——
// 环境起不来，路由也永远没机会被重建，形成死锁。
// 所以这里同时取三个来源，全部交给 wslProbeHosts 做真实 TCP 连通性校验，
// 只采用真正能连上代理端口的那个地址，猜错也不会把流量送错地方。
const ROUTE_MARK = '__NET_ROUTE__';
const PROXY_MARK = '__LOCAL_PROXY__';
// 容器后端（Docker Desktop / OrbStack）给宿主提供的 DNS 别名，路由表里推不出来；
// 无条件进候选，靠真实 TCP 探测把关（WSL 下这两个名字解析不了，自然被过滤）。
const HOST_ALIAS_CANDIDATES = ['host.docker.internal', 'host.orb.internal'];

function hexIpLE(hex) {
  const n = parseInt(hex, 16);                     // /proc/net/route 是小端序
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.');
}
const ipToInt = (ip) => ip.split('.').reduce((a, b) => ((a << 8) + Number(b)) >>> 0, 0);
const intToIp = (n) => [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');

// 从 /proc/net/route 解析：默认路由网关 + 各直连网段的首个地址（WSL2 NAT 网关惯例是 .1）
function parseRouteTable(routeTxt) {
  const res = { gw: null, subnets: [] };
  for (const line of String(routeTxt || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    const [dest, gwHex, mask] = [f[1], f[2], f[7]];
    if (![dest, gwHex, mask].every((h) => /^[0-9A-Fa-f]{8}$/.test(h))) continue;
    if (dest === '00000000') {
      if (gwHex !== '00000000') res.gw = hexIpLE(gwHex);
      continue;
    }
    if (gwHex !== '00000000') continue;            // 只看直连网段
    const maskIp = hexIpLE(mask);
    if (maskIp === '255.255.255.255' || maskIp === '0.0.0.0') continue;
    const netIp = hexIpLE(dest);
    if (netIp.startsWith('127.') || netIp.startsWith('169.254.')) continue;
    const first = intToIp((ipToInt(netIp) & ipToInt(maskIp)) + 1);
    if (!res.subnets.includes(first)) res.subnets.push(first);
  }
  return res;
}

async function wslHostCandidates() {
  // 一次 wsl 调用同时取路由表与上次成功写入的宿主代理地址，省一次冷启动。
  const sh = `echo ${ROUTE_MARK}; cat /proc/net/route 2>/dev/null; echo ${PROXY_MARK}; cat /opt/config/local-proxy 2>/dev/null`;
  const r = await runWsl(['bash', '-c', sh], { timeout: 20000 });
  const out = String(r.stdout || '');
  if (!out.includes(ROUTE_MARK)) {
    return { gw: null, subnets: [], cached: null, routeLocked: true,
      err: String(r.stderr || '').trim() || '无法读取容器内 /proc/net/route' };
  }
  const [routePart, proxyPart = ''] = out.split(PROXY_MARK);
  const rt = parseRouteTable(routePart.replace(ROUTE_MARK, ''));
  // /opt/config/local-proxy 由 entrypoint 写入，形如 http://192.168.240.1:7897
  const m = /^[a-z]+:\/\/([^\s/:]+)/i.exec(proxyPart.trim());
  const cached = m && !isLoopbackHost(m[1]) && /^\d+\.\d+\.\d+\.\d+$/.test(m[1]) ? m[1] : null;
  return { gw: rt.gw, subnets: rt.subnets, cached, routeLocked: !rt.gw, err: null };
}

// 返回 { url, note } 或 { error }
async function resolveUpstream(cfgProxy, progress) {
  const p = parseProxy(cfgProxy);
  if (!p) {
    return { url: stripSlash((cfgProxy || '').trim()), note: '代理地址无法解析，已按原样传入（建议格式 http://host:port）。' };
  }
  // 非本机地址（远程代理）直接用
  if (!isLoopbackHost(p.host)) return { url: stripSlash(p.href), note: '' };

  // 先确认 Windows 上确实有代理在监听
  if (!(await waitPort(p.port, 2000, '127.0.0.1'))) {
    return { error: `本机 127.0.0.1:${p.port} 上没有代理在监听。\n请先启动代理软件，并确认端口号是否正确。` };
  }

  progress && progress('正在检测代理在容器内的可达地址…');
  const info = await wslHostCandidates(); // 顺带把发行版拉起来
  if (info.err) {
    log('start', `容器内路由表读取失败：${info.err}`);
  } else if (!info.gw) {
    log('start', '容器内无默认路由（网络熔断锁定）；网关改由直连网段 / 上次成功地址推断');
  }
  const cands = [];
  for (const h of [info.gw, info.cached, ...info.subnets, ...HOST_ALIAS_CANDIDATES]) {
    if (h && !isLoopbackHost(h) && !cands.includes(h)) cands.push(h);
  }
  // 端口与容器内 router 相同的话，127.0.0.1 会命中 router 自己造成假阳性，跳过
  if (p.port !== ROUTER_PORT) cands.push('127.0.0.1');

  const probe = await wslProbeHosts(cands, p.port);
  const reach = probe.reach;

  // NAT 模式：第一个实测可达的非回环地址就是 Windows 宿主。
  // 候选里有推断值，所以必须靠真实 TCP 连通性把关，不能直接用没验证过的 IP。
  const host = cands.find((h) => !isLoopbackHost(h) && reach.includes(h));
  if (host) {
    const u = new URL(p.href);
    u.hostname = host;
    return {
      url: stripSlash(u.href),
      note: `代理已映射为宿主地址 ${host}:${p.port}（虚拟环境里的 127.0.0.1 指向环境自身，不是宿主机）。`,
    };
  }
  // 镜像网络模式：容器内 127.0.0.1 直接就是宿主
  if (reach.includes('127.0.0.1')) return { url: stripSlash(p.href), note: '' };

  // 探测本身没跑起来：如实报告，不要误导用户去改代理设置
  const envErr = info.err || probe.err;
  if (envErr) {
    return {
      error: [
        '无法检测代理在容器内的可达性（环境探测失败，不是代理的问题）。',
        '',
        `容器内执行探测时出错：${envErr}`,
        '请点「停止」再点「启动」重试；若反复失败，说明虚拟环境没有正常启动。',
      ].join('\n'),
    };
  }

  const lines = [
    '代理在本机可以连上，但容器内连不到它。',
    '',
    '诊断：',
    `  · Windows 侧 127.0.0.1:${p.port} 监听正常`,
    info.routeLocked
      ? '  · 容器内没有默认路由（网络熔断锁定了路由表，属预期状态，不是发行版没启动）'
      : `  · 已识别宿主网关 ${info.gw}`,
    `  · 容器内尝试过 ${cands.join(' / ')}，均不可达`,
    '',
    '最常见原因：代理软件只接受本机访问。请打开它的',
    '「允许局域网连接 / Allow LAN」（或把监听地址改成 0.0.0.0），',
    '保存后回到这里重新点「启动虚拟环境」。',
  ];
  if (info.gw) {
    lines.push(
      '',
      `也可以直接把上面的代理地址填成 http://${info.gw}:${p.port}（同样是 Allow LAN 生效才通）。`,
    );
  }
  return { error: lines.join('\n') };
}


// ---------- 运行时操作 ----------
async function ensureImported(onProgress) {
  // 后端负责全部差异：WSL 走 wsl --import，容器走 docker import + 实例创建/拉起
  return backend.ensureImage(rootfsPath(), {
    dataDir: dataDir(),
    scriptsDir: scriptsDir(),
    assetsDir: assetsDir(),
    novncPort: NOVNC_PORT,
    onProgress,
  });
}

// 看某个端口在宿主上被谁占着（Windows: netstat+tasklist，macOS/Linux: lsof）
function winPortOwner(port) {
  return backend.hostPortOwner(port);
}

// 启动前确认端口没被别人占：占着的话 noVNC 永远起不来，最后只会报「90 秒未就绪」
async function portConflict(port) {
  const busy = await waitPort(port, 300);
  if (!busy) return null;
  // 可能是我们上一轮留下的发行版还在跑（应用重启但环境没停），那不算冲突
  const probe = await runWsl(['bash', '-c',
    'pgrep -f websockify >/dev/null 2>&1 && echo ours'], { timeout: 15000 });
  if ((probe.stdout || '').includes('ours')) return null;
  return await winPortOwner(port);
}

// ---------- 幂等启动 ----------
// 环境是否已经按「指定模式」跑着。
//   desktop —— 6080 可连 + 容器里确实有我们的 websockify（只看端口会被别的程序骗到）
//   wslg    —— 不监听任何端口，改看 entrypoint 写的就绪标记 + 会话常驻进程
// 标记内容是模式名，切换模式时会被判为「不活着」，从而触发重建而不是错误接管。
async function runtimeAlive(displayMode = 'desktop') {
  const r = await runWsl(['bash', '-c',
    'cat /run/claude-vm/ready 2>/dev/null'], { timeout: 15000 });
  const ready = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  if (displayMode === 'wslg') {
    // WSLg 窗口随 WSL 会话存活，会话一停标记就失效（发行版变 Stopped）。
    return ready === 'wslg';
  }
  // desktop 模式：**不能只看就绪标记**。/run 是 tmpfs，WSL 会话没被销毁时标记会一直
  // 留着，哪怕 Xtigervnc/openbox/websockify 早就全退了。以前 `if (ready === 'desktop')
  // return true` 会把一具「假活」的桌面判成运行中，于是 startRuntime 走幂等接管、
  // 直接 return —— 既不同步新脚本，也不重建会话。1.0.27 的 openbox 关闭按钮修复
  // 就是这样一直没进虚拟机：用户装了新版，点的仍是旧配置画的 ✕。
  // 所以这里必须真的查三个常驻进程 + 串流端口。
  const p = await runWsl(['bash', '-c',
    "pgrep -x Xtigervnc >/dev/null 2>&1 && pgrep -x openbox >/dev/null 2>&1 && ps -eo args= | grep -q '[w]ebsockify' && echo RUNNING || echo DEAD"],
    { timeout: 15000 });
  const procsUp = /RUNNING/.test(String(p.stdout || ''));
  if (!procsUp) {
    log('runtime', '桌面进程缺失（Xtigervnc / openbox / websockify），就绪标记即便还在也判为假活，需要重建');
    return false;
  }
  // 进程都在还不够：串流端口没监听，用户看到的仍是打不开的页面。
  return await waitPort(NOVNC_PORT, 2500);
}

// 影响运行时行为的配置项。改了任意一项都必须重建，没改就有资格接管。
// displayMode 必须算进来：切换显示模式要换整套后端，不能直接接管。
function cfgFingerprint(cfg) {
  return JSON.stringify({
    tz: cfg.tz || '',
    lang: cfg.lang || '',
    proxy: (cfg.proxy || '').trim(),
    mode: cfg.proxyMode || 'all',
    wl: cfg.whitelist || '',
    ws: cfg.workspace || '',
    dm: cfg.displayMode === 'desktop' ? 'desktop' : 'wslg',
    // 熔断开关改变的是内核路由表，不能"接管"旧会话，必须重建
    ng: cfg.netGuard === 'off' ? 'off' : 'strict',
    // 输入法要重起 ibus-daemon 并改 XMODIFIERS，同样必须重建会话
    im: cfg.inputMethod === 'rime' ? 'rime' : 'off',
    // 脚本/资源修订号：升级后强制重建一次，别接管旧脚本拉起的会话
    rev: RUNTIME_REV,
  });
}

const readLastFingerprint = () => {
  try { return fs.readFileSync(lastStartPath(), 'utf8'); } catch { return ''; }
};

// 等 entrypoint 写完就绪标记。WSLg 模式没有端口可等，必须用这个信号。
// 同时避免「上一次运行留下的旧标记」骗过本次：标记内容带上模式名，且只在
// 本次 spawn 之后开始计时才认；真旧文件会在 stopRuntime 里被清掉。
async function waitReadyMarker(displayMode, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await runWsl(['bash', '-c',
      'cat /run/claude-vm/ready 2>/dev/null'], { timeout: 12000 });
    const v = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    if (v === displayMode) return true;
    await new Promise((res) => setTimeout(res, 700));
  }
  return false;
}

async function startRuntime(cfg, onProgress) {
  // 统一路径写法后再算指纹：否则 "C://Users//x" 和 "C:\Users\x" 会被当成两份不同配置，
  // 每次启动都判「配置已变更」而重建虚拟机。
  cfg = { ...cfg, workspace: normalizeWinPath(cfg.workspace || defaultConfig().workspace) };

  const imp = await ensureImported(onProgress);
  if (!imp.ok) return imp;

  // 已经在跑、而且配置没变 → 接管，什么都不用做。
  // 以前这里是无条件 spawn，而 spawn 之前会 runtimeProc.kill()，entrypoint 里
  // 又 pkill 一遍 Xtigervnc / websockify —— 于是「启动」被触发第二次时，
  // 整台 VM 先被杀掉、桌面消失、再重新建起来，看起来就是「VM 关机又重启」。
  const displayMode = cfg.displayMode === 'desktop' ? 'desktop' : 'wslg';
  const fp = cfgFingerprint(cfg);
  const lastFp = readLastFingerprint();
  const alive = await runtimeAlive(displayMode);
  if (lastFp === fp && alive) {
    log('start', `环境已在运行（${displayMode}）且配置未变，直接接管（不重建虚拟机）`);
    // 接管 ≠ 什么都不做。以前这里直接 return，把 syncScripts() 一起跳过了 —— 装了新版
    // 客户端只要旧会话还活着，新脚本 / 新资源就永远进不了 VM。1.0.27 的 openbox
    // 关闭按钮修复就是这样失效的：安装包里有，虚拟机里没有。
    // 同步用「临时文件 + mv」原子替换，运行中 bash 已打开的 inode 不受影响，
    // 对活会话执行是安全的（1.0.19 那个 cp -f 就地截断的事故已经修过）。
    const resumedSync = await syncScripts();
    return {
      ok: true,
      resumed: true,
      imported: imp.imported,
      displayMode,
      host: '127.0.0.1',
      notes: [
        `环境已在运行（${displayMode} 模式），已直接接管，没有重启虚拟机。`,
        resumedSync.ok ? '已顺带同步最新运行时脚本与窗口配置。' : '',
      ].filter(Boolean),
      warnings: resumedSync.ok ? [] : ['运行时脚本同步失败，界面可能仍用旧配置；可点「停止」再「启动」。'],
    };
  }
  // 不接管时把原因写清楚，否则日志里只看到「又启动了一次」，
  // 完全无法判断这次重建是配置变了还是探测失败。
  log('start', alive
    ? '配置已变更（时区/语言/代理/模式/白名单/工作区），按新配置重建运行时'
    : '探测不到正在运行的桌面，按全新启动处理');

  log('start', `版本 ${app.getVersion()}｜代理 ${redact(cfg.proxy) || '未配置'}｜分流 ${cfg.proxyMode || 'all'}｜显示 ${displayMode}｜网络熔断 ${cfg.netGuard === 'off' ? 'off' : 'strict'}`);

  // 6080 只有串流桌面模式会用；WSLg 模式不监听端口，做这个检查纯属误报。
  const conflict = displayMode === 'desktop' ? await portConflict(NOVNC_PORT) : null;
  if (conflict) {
    log('start', `端口 ${NOVNC_PORT} 被占用：${conflict.name} PID ${conflict.pid}`);
    return {
      ok: false,
      error: [
        `端口 ${NOVNC_PORT} 已被其他程序占用，虚拟桌面的串流服务无法启动。`,
        '',
        `占用者：${conflict.name}（PID ${conflict.pid}）`,
        conflict.line,
        '',
        `请关闭该程序后重试；如果你想留着自己用，先把它改成别的端口 —— ${NOVNC_PORT} 是这台虚拟机桌面要用的。`,
      ].join('\n'),
    };
  }

  // 发行版已存在时也要把最新脚本推进去（否则装了旧版会一直用旧 router）
  onProgress && onProgress('同步运行时脚本…');
  const sync = await syncScripts();

  const ws = cfg.workspace || defaultConfig().workspace;
  try { fs.mkdirSync(ws, { recursive: true }); } catch {}

  // 上游代理：本机回环地址需要换成容器可见的宿主地址，否则会自环
  const notes = [];
  const warnings = [];
  let upstream = (cfg.proxy || '').trim();
  if (upstream) {
    const res = await resolveUpstream(upstream, onProgress);
    if (res.error) {
      // 以前这里直接返回，日志里什么都不留 —— 用户看到「启动失败」，
      // 我们事后完全不知道卡在哪一步，只能猜。
      log('start', `上游代理解析失败：${String(res.error).split('\n').filter(Boolean)[0] || '未知'}`);
      return { ok: false, error: res.error };
    }
    upstream = stripSlash(res.url);
    if (res.note) notes.push(res.note);
  } else {
    // 没代理基本等于用不了：Claude 不支持的地区直接登录失败。
    // 这里不拦，因为确实有人本来就在支持地区；但必须把话说清楚。
    warnings.push('没有配置代理，虚拟机将直接用本机网络出网。若你所在地区不在 Claude 支持范围内，登录会失败 —— 这不是环境问题。');
  }

  if (!sync.ok && sync.reason !== 'scripts-missing') {
    warnings.push('运行时脚本同步失败，环境可能仍在用旧脚本。可点「停止」后重新启动；反复失败请删除发行版让程序重新导入。');
  }

  // 先抹掉旧就绪标记：否则「同模式重启」时 waitReadyMarker 会被上一轮的标记
  // 立刻满足，把还没起来的环境当成已经就绪。
  await runWsl(['bash', '-c',
    'rm -f /run/claude-vm/ready'], { timeout: 12000 });

  onProgress && onProgress('启动虚拟环境…');
  const proxyMode = cfg.proxyMode === 'whitelist' ? 'whitelist' : 'all';
  // guest 侧工作区路径由后端换算：WSL 是 /mnt/c/...，容器是 /mnt/host-users/...
  const guestWs = backend.guestWorkspacePath(ws);
  if (!guestWs) {
    return {
      ok: false,
      error: [
        `工作区路径无法映射进虚拟环境：${ws}`,
        '',
        '容器后端只共享 /Users 与 /Volumes 下的目录（Docker Desktop / OrbStack 默认共享范围）。',
        '请把工作区换到你的用户目录（如 ~/claude-workspace）下再试。',
      ].join('\n'),
    };
  }
  const env = {
    TZ: cfg.tz || 'America/New_York',
    LANG: cfg.lang || 'en_US.UTF-8',
    LC_ALL: cfg.lang || 'en_US.UTF-8',
    NOVNC_PORT: String(NOVNC_PORT),
    DISPLAY_MODE: displayMode,
    UPSTREAM_PROXY: upstream,
    PROXY_MODE: proxyMode,
    PROXY_WHITELIST: cfg.whitelist || DEFAULT_WHITELIST,
    NET_GUARD: cfg.netGuard === 'off' ? 'off' : 'strict',
    NET_GUARD_STRICT_REGION: cfg.netGuardStrictRegion === false ? '0' : '1',
    INPUT_METHOD: cfg.inputMethod === 'rime' ? 'rime' : 'off',
    WORKSPACE: guestWs,
  };

  if (runtimeProc) { try { runtimeProc.kill(); } catch {} }
  log('start', `spawn: ${backend.id} ${displayMode} ` +
    Object.entries(env).filter(([k]) => k !== 'UPSTREAM_PROXY').map(([k, v]) => `${k}=${v}`).join(' '));
  const proc = backend.spawnEntry(env);
  runtimeProc = proc;
  // 记下「这台 VM 是按这份配置起的」，供下次启动判断能否直接接管
  try { fs.writeFileSync(lastStartPath(), fp); } catch {}
  proc.stdout.on('data', (b) => log('vm', decodeChunk(b)));
  proc.stderr.on('data', (b) => log('vm!', decodeChunk(b)));
  proc.on('error', (e) => log('vm!', `spawn 失败：${e && e.message}`));
  proc.on('exit', (code) => {
    log('vm', `运行时进程退出 code=${code}`);
    if (runtimeProc === proc) runtimeProc = null;
    // 之前这里只写日志：虚拟机已经没了，界面还显示「运行中」，用户点什么都没反应，
    // 只能关掉应用重开 —— 那才是最容易被当成「重启」的体验。
    // 主动点「停止」时不该报异常，用 stopping 区分。
    if (!stopping) {
      try {
        if (win && !win.isDestroyed()) win.webContents.send('runtime:exited', { code });
      } catch {}
    }
  });

  const host = '127.0.0.1';
  let ready;
  if (displayMode === 'desktop') {
    // noVNC 只监听发行版内的 127.0.0.1（Windows 的 localhost 转发能通），
    // 所以这里只等本机回环；不再退到发行版 IP —— 那条路在加固后本来就通不了。
    ready = await waitPort(NOVNC_PORT, 50000, host);
  } else {
    ready = await waitReadyMarker('wslg', 50000);
  }
  if (!ready) {
    log('start', `${displayMode} 模式 50 秒内未就绪`);
    return {
      ok: false,
      error: displayMode === 'desktop'
        ? [
            '虚拟桌面在 50 秒内没有就绪。',
            '',
            '可以按顺序试：① 点「停止」再「启动」；② 点侧栏「导出诊断包」，把文件里的日志发给我。',
            '（如果系统提示 6080 端口被占用，先关掉占用它的程序。）',
          ].join('\n')
        : [
            'WSLg 环境在 50 秒内没有就绪。',
            '',
            'WSLg 需要 Windows 11，或 Windows 10 21H2/22H2（内部版本 19044+）并安装商店版 WSL。',
            '可在 PowerShell 执行 wsl --version 看有没有 WSLg version 一行。',
            '',
            '也可以把「显示模式」切回「串流桌面」先继续使用，或导出诊断包查看日志。',
          ].join('\n'),
    };
  }
  log('start', `${displayMode} 就绪 host=${host}`);

  // 启动后校验「容器 → 代理 → Anthropic」整条链路，
  // 不通要明确告诉用户，而不是让他在 Chrome 里慢慢试。
  let exit = null;
  if (upstream) {
    onProgress && onProgress('校验代理链路…');
    // 关键：校验必须用「容器里实际生效的那个代理地址」。
    // 全量模式（默认）下容器直接把上游当代理，根本没有 127.0.0.1:7890 这个
    // router；写死 router 端口只会拿到 000，把一条好链路报成故障。
    const fallbackEp = proxyMode === 'all' ? upstream : `http://127.0.0.1:${ROUTER_PORT}`;
    const ep = await containerProxyEndpoint(fallbackEp);

    const chain = await verifyProxyChain(ep);
    if (!chain.code || chain.code === '000') {
      const why = chain.proxyAlive
        ? `代理 ${ep} 本身可连，但经它访问 api.anthropic.com 没有响应（上游节点可能屏蔽了该域名）。`
        : `容器内连不上代理 ${ep} —— 多半是代理软件没开「允许局域网连接 / Allow LAN」，或该端口此刻不可用。`;
      warnings.push(`代理链路校验失败：${why} 可点「运行环境自检」查看逐项结果。`);
    } else {
      notes.push(`代理链路校验通过（api.anthropic.com 返回 HTTP ${chain.code}）。`);
    }

    // 出口是启动期的关键事实：用户改完代理配置，最想立刻知道「现在从哪儿出去」。
    exit = await verifyExitViaRouter(ep);
    if (exit && exit.ip) {
      const bits = [exit.ip];
      if (exit.city) bits.push(exit.city);
      if (exit.org) bits.push(exit.org);
      notes.push(`当前出口：${bits.join(' · ')}`);
      // Vultr / DigitalOcean / AWS 这类云厂商网段会被识别为「数据中心出口」。
      // 这是代理节点本身的属性、用户改不了，也是绝大多数商业代理的常态，
      // 所以按「信息」而非「警告」呈现 —— 否则程序每次启动都是红脸，属于误报。
      if (/constant company|vultr|digitalocean|amazon|google llc|microsoft|hetzner|ovh|linode/i.test(exit.org || '')) {
        notes.push('出口属于数据中心网段（这是代理节点自带的属性，非本地问题）；环境体检的「出口类型」一项会因此扣分，想改只能换住宅/ISP 节点。');
      }
    } else if (chain.code && chain.code !== '000') {
      // 链路是通的，只是查不到归属信息（ipinfo 被限流 / 只放行 Anthropic）。
      // 这不该报成「代理不通」，否则又是一次误报。
      warnings.push('代理链路正常，但没能读到出口 IP 归属（ipinfo.io 可能被代理规则拦掉或限流），不影响使用。');
    } else {
      warnings.push('没能读到出口 IP：上游此刻不通，或代理只放行了特定域名。');
    }
  }

  for (const n of notes) log('note', n);
  for (const w of warnings) log('warn', w);

  if (displayMode === 'wslg') {
    notes.push('显示模式：WSLg 原生窗口。终端窗口已弹出；中文用宿主输入法打好后复制，在终端里 Ctrl+Shift+V 粘贴。');
  }
  // 守卫结论随启动结果一起带回界面：预检没过时用户第一眼就该看到「网络已切断」，
  // 而不是等自检或轮询才发现。
  const guard = await readNetGuard();
  if (guard) {
    if (guard.state === 'blocked') warnings.push(`网络守卫：${guard.message || guard.reason || '预检未通过，网络保持切断'}`);
    else if (guard.state === 'off') warnings.push('网络熔断已关闭：代理断开时流量会直连出网，存在暴露真实环境的风险。');
  }
  return { ok: true, imported: imp.imported, displayMode, host, notes, warnings, exit, guard };
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// 读取 /run/claude-vm/net-guard.state（KV）。守卫的全部结论都落在这里：
//   state=guarded|blocked|proxy_down|off、reason、message、exit_ip、ts 心跳。
// 界面每几秒轮询一次，代理断开/恢复能立刻反映出来。
async function readNetGuard() {
  try {
    const r = await runWsl(['bash', '-c',
      'cat /run/claude-vm/net-guard.state 2>/dev/null'], { timeout: 12000 });
    const out = {};
    for (const line of String(r.stdout || '').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
    }
    return out.state ? out : null;
  } catch { return null; }
}

// 容器内实际生效的代理地址。entrypoint 会把它写进 /opt/config/local-proxy：
//   · 全量模式 → 上游本身（如 http://192.168.240.1:7897/）
//   · 白名单模式 → http://127.0.0.1:7890（本地 router）
// 读文件而不是自己推算，是为了跟运行环境所见完全一致；读不到再用 fallback。
async function containerProxyEndpoint(fallback) {
  const r = await runWsl(['bash', '-c',
    'cat /opt/config/local-proxy 2>/dev/null'], { timeout: 15000 });
  const v = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  return /^[a-z0-9]+:\/\//i.test(v) ? v : fallback;
}

// 经指定代理访问 Anthropic，返回 { code, proxyAlive }
// code === "000" 表示没拿到响应；proxyAlive 再用一条纯 HTTP 请求区分
// 「代理本身不可达」与「代理通、但目标域名被拦」，好给出不同的建议。
async function verifyProxyChain(ep) {
  const p = shellQuote(ep);
  const one = async (url, to) => {
    const sh = `curl -s -o /dev/null -w "%{http_code}" --max-time ${to} -x ${p} ${url}`;
    const r = await runWsl(['bash', '-c', sh], { timeout: (to + 8) * 1000 });
    return String(r.stdout || '').trim();
  };
  const code = await one('https://api.anthropic.com', 12);
  if (code && code !== '000') return { code, proxyAlive: true };
  const probe = await one('http://cp.cloudflare.com/generate_204', 8);
  return { code: code || '000', proxyAlive: !!probe && probe !== '000' };
}

// 经同一个代理端点查一次真实出口（IP / 城市 / 归属）
async function verifyExitViaRouter(ep) {
  const sh =
    `curl -s --max-time 10 -x ${shellQuote(ep)} https://ipinfo.io/json ` +
    `| sed -n 's/.*"ip": *"\\([^"]*\\)".*/ip=\\1/p;` +
    `s/.*"city": *"\\([^"]*\\)".*/city=\\1/p;` +
    `s/.*"org": *"\\([^"]*\\)".*/org=\\1/p'`;
  const r = await runWsl(['bash', '-c', sh], { timeout: 20000 });
  const out = {};
  for (const line of String(r.stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out.ip ? out : null;
}

async function stopRuntime() {
  log('stop', '用户点击停止');
  stopping = true;
  // 主动停止是受控收尾：先还原被网络熔断删掉的默认路由。
  // 顺序必须在 kill 之前 —— /run 是 tmpfs，runtimeProc 一停，
  // /run/claude-vm/net-guard.orig（原始路由记录）就随会话消失；
  // 而 `wsl --terminate` 只终止发行版、不重建网络命名空间，
  // 被删的默认路由会残留到下次启动。fail-closed 的「不 unlock」
  // 只针对守卫意外死亡，用户点停止时环境本来就要下线，解锁是安全的。
  try {
    const u = await runWsl(['python3',
      '/opt/scripts/net-guard.py', 'unlock'], { timeout: 12000 });
    log('stop', /"ok":\s*true/.test(u.stdout || '')
      ? '已还原默认路由（熔断解锁）'
      : '熔断解锁跳过：无原始路由记录或脚本缺失（不影响停止）');
  } catch (e) {
    log('stop', `熔断解锁跳过：${e && e.message}`);
  }
  try { if (runtimeProc) { runtimeProc.kill(); runtimeProc = null; } } catch {}
  // 先抹掉就绪标记，再终止实例：否则停掉之后标记还在，
  // 下次启动的 runtimeAlive() 会把已经停掉的环境误判成「还活着」。
  await runWsl(['bash', '-c',
    'rm -f /run/claude-vm/ready'], { timeout: 12000 });
  await backend.stopAll();
  // 环境已经没了，指纹作废 —— 下次必须是真正的重建
  try { fs.unlinkSync(lastStartPath()); } catch {}
  setTimeout(() => { stopping = false; }, 3000);
  return { ok: true };
}

// 自检：优先取结构化 JSON（界面按维度渲染），失败则回退到纯文本
async function checkEnv() {
  if (!(await distroExists())) {
    return {
      ok: false,
      needStart: true,
      error: '虚拟环境还没有创建。\n请先点「启动虚拟环境」，等桌面出现后再运行自检。',
    };
  }

  // check-env.sh 是「新开的 WSL 会话」，继承不到 entrypoint 里 export 的变量。
  // 把当前显示模式显式传进去，它才知道该检查 6080/websockify 还是 WSLg 会话。
  const dm = loadConfig().displayMode === 'desktop' ? 'desktop' : 'wslg';
  const run = (extra) => runWsl(
    ['env', `DISPLAY_MODE=${dm}`,
      '/opt/scripts/check-env.sh', ...extra],
    { timeout: 120000 },
  );

  const r = await run(['--json']);
  const raw = (r.stdout + '\n' + r.stderr).trim();

  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try {
      const data = JSON.parse(raw.slice(s, e + 1));
      if (data && Array.isArray(data.groups)) {
        const sm = data.summary || {};
        log('check', `自检 通过 ${sm.pass || 0} / 注意 ${sm.warn || 0} / 失败 ${sm.fail || 0}`);
        for (const g of data.groups) {
          for (const it of g.items || []) {
            if (it.status && it.status !== 'pass') log('check', `${it.status}｜${it.label}｜${it.value}`);
          }
        }
        return { ok: true, data, raw };
      }
    } catch { /* 落到下面的文本回退 */ }
  }

  // 脚本可能是旧版（不支持 --json），用文本模式再跑一次
  const t = await run([]);
  const text = (t.stdout + '\n' + t.stderr).trim();
  if (!text) {
    return {
      ok: false,
      needStart: true,
      error: '自检没有返回任何输出，虚拟环境可能未在运行。\n请先点「启动虚拟环境」，等桌面出现后再自检。',
    };
  }
  return { ok: false, out: text, error: '自检脚本版本较旧，暂时以原始输出显示。重新启动程序会自动同步最新脚本。' };
}

// ---------- WSLg 窗口（wslg 模式弹原生窗口；desktop 模式开在串流桌面里）----------
// 用 nohup + & 让窗口进程脱离这一次 exec 会话；整个会话由 entrypoint 的
// sleep infinity 兜住，所以关掉窗口不会让实例停止，随时可以再开一个。
async function openWslgWindow(script) {
  const dm = loadConfig().displayMode === 'desktop' ? 'desktop' : 'wslg';
  // desktop 模式（含 macOS）的窗口全在 :1（Xtigervnc）上；wslg 才是 :0 + Pulse
  const disp = dm === 'desktop' ? ':1' : ':0';
  const pulse = dm === 'desktop' ? '' : ' PULSE_SERVER=unix:/mnt/wslg/PulseServer';
  const sh = `. /opt/config/runtime-env 2>/dev/null; ` +
    `export DISPLAY=${disp}${pulse}; ` +
    `nohup ${shellQuote('/opt/scripts/' + script)} >/tmp/wslg-window.log 2>&1 & echo launched`;
  const r = await runWsl(['bash', '-c', sh], { timeout: 20000 });
  return { ok: /launched/.test(r.stdout) };
}

// 沿用容器内已有的登录态；不做任何自动授权动作。
async function authStatus() {
  const sh = `. /opt/config/runtime-env 2>/dev/null; timeout 20 claude auth status 2>/dev/null`;
  const r = await runWsl(['bash', '-c', sh], { timeout: 30000 });
  const raw = String(r.stdout || '').trim();
  let loggedIn = false, method = 'none';
  try {
    const d = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    loggedIn = d.loggedIn === true;
    method = d.authMethod || 'none';
  } catch {
    // 老版本 claude 没有 auth status：退回到「有没有凭据文件」的粗判
    const f = await runWsl(['bash', '-c',
      'test -s /root/.claude/.credentials.json && echo yes'], { timeout: 15000 });
    loggedIn = /yes/.test(f.stdout || '');
    if (loggedIn) method = 'credential-file';
  }
  return { ok: true, loggedIn, method };
}

// ---------- IPC ----------
ipcMain.handle('config:get', () => {
  const firstRun = !fs.existsSync(cfgPath());
  const saved = loadConfig();
  // 老版本的默认白名单不完整，平滑升级到新默认值（用户自定义过的不动）
  if (!saved.whitelist || LEGACY_WHITELISTS.includes(saved.whitelist.trim())) {
    saved.whitelist = DEFAULT_WHITELIST;
    try { saveConfig({ ...defaultConfig(), ...saved }); } catch {}
  }
  // _platform 供渲染层隐藏不适用的选项（macOS 无 WSLg）
  return { ...mergeCfg(saved), _firstRun: firstRun, _platform: process.platform };
});
ipcMain.handle('config:save', (_e, cfg) => { saveConfig(cfg); return { ok: true }; });
ipcMain.handle('proxy:detect', async () => detectProxy());

// 剪贴板必须由主进程来做：Electron 20+ 的 preload 默认在 sandbox 里跑，
// 只能拿到 contextBridge / ipcRenderer / webFrame，`clipboard` 是 undefined。
// 之前 preload 里直接调 clipboard.writeText，异常又被 try/catch 吞了 —— 剪贴板桥一直是坏的。
ipcMain.handle('clip:read', () => { try { return clipboard.readText(); } catch { return ''; } });
ipcMain.handle('clip:write', (_e, t) => { try { clipboard.writeText(String(t == null ? '' : t)); } catch {} return true; });

ipcMain.handle('runtime:status', async () => {
  const imported = await distroExists();
  const dm = loadConfig().displayMode === 'desktop' ? 'desktop' : 'wslg';
  // wslg 模式没有端口可探测，用就绪标记 + 常驻会话判断
  const running = imported && (
    dm === 'wslg'
      ? (!!runtimeProc || (await runtimeAlive('wslg')))
      : ((await waitPort(NOVNC_PORT, 800)) || !!runtimeProc)
  );
  return { imported, running, displayMode: dm };
});

ipcMain.handle('runtime:start', async (e, cfg) => {
  saveConfig(cfg);
  const send = (msg) => { try { e.sender.send('runtime:progress', msg); } catch {} };
  return startRuntime(cfg, send);
});

ipcMain.handle('runtime:stop', async () => stopRuntime());
ipcMain.handle('runtime:check', async () => checkEnv());
// 网络守卫状态（fail-closed 熔断 / 代理断开 / 预检结论），界面轮询用
ipcMain.handle('net:status', async () => readNetGuard());
ipcMain.handle('wsl:probe', async () => probeWsl());
// WSLg 模式下的窗口操作：再开一个 Claude Code 终端 / 打开一次性授权页
ipcMain.handle('terminal:open', async () => openWslgWindow('run-claude.sh'));
ipcMain.handle('terminal:shell', async () => openWslgWindow('run-terminal.sh'));
ipcMain.handle('auth:status', async () => authStatus());
ipcMain.handle('auth:login', async () => openWslgWindow('chrome-login.sh'));

ipcMain.handle('workspace:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('workspace:open', (_e, p) => { if (p) shell.openPath(p); });

// ---------- 诊断包 ----------
// 目标：用户出问题时点一下，就能把「我看到的东西」原样交出来，
// 而不是靠他描述、我猜。内容全部是本地事实，代理口令先脱敏。
async function buildDiag() {
  const cfg = loadConfig();
  const parts = [];
  parts.push(`Claude VM 诊断包  ${new Date().toISOString()}`);
  parts.push(`应用版本 ${app.getVersion()} ｜ Electron ${process.versions.electron} ｜ Node ${process.versions.node}`);
  parts.push(`${process.platform === 'darwin' ? 'macOS' : 'Windows'} ${process.getSystemVersion()} ｜ ${process.arch} ｜ 后端 ${backend.id} ｜ 显示模式 ${cfg.displayMode === 'desktop' ? 'desktop(noVNC)' : 'wslg'}`);
  parts.push(`数据目录 ${dataDir()}`);
  parts.push('');
  parts.push('--- 配置（口令已脱敏） ---');
  parts.push(JSON.stringify({ ...cfg, proxy: redact(cfg.proxy) }, null, 2));
  parts.push('');
  parts.push('--- 运行时实例 ---');
  parts.push((await backend.diagInfo()) || '(无)');
  parts.push('');
  parts.push(`--- 端口 ${NOVNC_PORT} ---`);
  const owner = await winPortOwner(NOVNC_PORT);
  parts.push(owner ? `${owner.name} (PID ${owner.pid})  ${owner.line}` : '未监听');
  parts.push('');
  parts.push('--- 环境自检（--json） ---');
  try {
    const c = await checkEnv();
    parts.push((c && (c.raw || c.error)) || '（无输出）');
  } catch (e) {
    parts.push(`自检失败：${e && e.message}`);
  }
  parts.push('');
  parts.push('--- 日志（末尾 400 行） ---');
  try {
    const lines = fs.readFileSync(logFile(), 'utf8').split(/\r?\n/);
    parts.push(lines.slice(-400).join('\n'));
  } catch {
    parts.push('（暂无日志）');
  }
  return parts.join('\n');
}

ipcMain.handle('diag:export', async () => {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const r = await dialog.showSaveDialog(win, {
    title: '保存诊断包',
    defaultPath: path.join(app.getPath('downloads'), `claude-vm-diag-${stamp}.txt`),
    filters: [{ name: '文本文件', extensions: ['txt'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, await buildDiag(), 'utf8');
    log('diag', `导出诊断包 → ${r.filePath}`);
    return { ok: true, file: r.filePath };
  } catch (e) {
    log('diag', `导出失败：${e && e.message}`);
    return { ok: false, error: e && e.message };
  }
});
ipcMain.handle('diag:openLogs', () => { try { shell.openPath(logDir()); } catch {} return { ok: true }; });
// 只把内容返回给渲染层，不弹保存框（自测/预览用，也方便以后做「复制诊断信息」）
ipcMain.handle('diag:preview', async () => ({ ok: true, text: await buildDiag() }));

// ---------- 窗口 ----------
function createWindow() {
  // 窗口默认尺寸按屏幕来，别再写死 1280x860 —— 那比大多数屏幕的可用区域还小，
  // 桌面会被迫在这么小的画布里显示，用户第一眼就觉得「不如本机」。
  // 取工作区的 82%/86%（避开任务栏与侧栏），上限 1600x1000。
  let winW = 1440, winH = 900;
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    winW = Math.min(1600, Math.max(1100, Math.round(wa.width * 0.82)));
    winH = Math.min(1000, Math.max(700, Math.round(wa.height * 0.86)));
  } catch {}

  win = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#14161a',
    title: 'Claude VM',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.setMenuBarVisibility(false);
  // 光隐藏菜单栏不够：Electron 默认菜单的加速键仍然生效，于是虚拟机里按 Ctrl+W
  //（Chrome 关标签页）会直接把整个应用关掉、连带杀掉 VM；Ctrl+R / Ctrl+Shift+I 同理。
  // 这是「像在自己电脑上一样用」最直接的破坏，所以整份菜单直接摘掉。
  try { Menu.setApplicationMenu(null); } catch {}
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  if (!gotSingleLock) return;                 // 第二个实例：直接退出，不再建窗口
  openLog();
  log('app', `启动 v${app.getVersion()}｜Electron ${process.versions.electron}｜${process.getSystemVersion()}`);
  // 应用自身的 webview 只访问 localhost，强制直连，避免系统代理把 127.0.0.1 也代理掉
  try { await session.defaultSession.setProxy({ mode: 'direct' }); } catch {}
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  log('app', '退出');
  stopping = true;
  try { if (runtimeProc) runtimeProc.kill(); } catch {}
});
