'use strict';
// 源码切片加载器：把 claude-desktop/app/main.js 的纯函数段提取出来做单元测试。
//
// 为什么不直接 require main.js：它是 Electron 主进程模块，顶部 require('electron')，
// 在纯 Node 环境会立刻抛错。理想态是把纯函数抽到独立 lib/ 模块（见 tests/README.md
// 的重构建议）；在那之前用「起止标记切片 + new Function 注入依赖」过渡。
// 关键约束：每个 start/end 标记在 main.js 里必须唯一，loader 启动时全量校验，
// 源码改动破坏了切片会得到明确的失败信息，而不是静默测错对象。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MAIN_PATH = path.join(ROOT, 'claude-desktop', 'app', 'main.js');
const MAIN_SRC = fs.readFileSync(MAIN_PATH, 'utf8');

// 每段：start / end 为源码中的唯一标记（end 不含在切片里）；
// fns 为要导出的标识符；deps 为该段引用、需要注入的标识符。
const SEGMENTS = {
  decodeChunk: {
    start: 'function decodeChunk(buf) {', end: 'function log(tag, msg) {',
    fns: ['decodeChunk'], deps: [],
  },
  redact: {
    start: '// 代理地址里可能带 user:pass', end: 'function loadConfig()',
    fns: ['redact'], deps: [],
  },
  normalizeWinPath: {
    start: '// 路径里混进多余的斜杠', end: 'function saveConfig(cfg) {',
    fns: ['normalizeWinPath'], deps: [],
  },
  mergeCfg: {
    start: 'function mergeCfg(saved) {', end: '// 路径里混进多余的斜杠',
    fns: ['mergeCfg'], deps: ['defaultConfig', 'normalizeWinPath'],
  },
  defaultConfig: {
    start: 'function defaultConfig() {', end: 'function rootfsPath()',
    fns: ['defaultConfig'], deps: ['path', 'app', 'DEFAULT_WHITELIST'],
  },
  toWslPath: {
    start: 'function toWslPath(p) {', end: '// ---------- WSL 调用 ----------',
    fns: ['toWslPath'], deps: [],
  },
  cleanWslList: {
    start: 'function cleanWslList(s) {', end: 'async function distroExists()',
    fns: ['cleanWslList'], deps: [],
  },
  proxyFns: {
    start: 'function isLoopbackHost(h) {', end: '// ---------- 本机代理自动探测 ----------',
    fns: ['isLoopbackHost', 'stripSlash', 'parseProxy'], deps: [],
  },
  probeJs: {
    start: 'const PROBE_JS =', end: '// 返回 { reach: [可达地址], err:',
    fns: ['PROBE_JS'], deps: [],
  },
  probeHosts: {
    start: 'async function wslProbeHosts(', end: '// 容器内可见的',
    fns: ['wslProbeHosts'], deps: ['runWsl', 'PROBE_JS', 'DISTRO'],
  },
  routeFns: {
    start: 'function hexIpLE(hex) {', end: 'async function wslHostCandidates()',
    fns: ['hexIpLE', 'ipToInt', 'intToIp', 'parseRouteTable'], deps: [],
  },
  upstream: {
    start: 'const ROUTE_MARK =', end: '// ---------- 运行时操作 ----------',
    fns: ['ROUTE_MARK', 'PROXY_MARK', 'parseRouteTable', 'wslHostCandidates', 'resolveUpstream'],
    deps: ['isLoopbackHost', 'parseProxy', 'stripSlash', 'runWsl', 'DISTRO',
      'waitPort', 'log', 'ROUTER_PORT', 'wslProbeHosts', 'PROBE_JS'],
  },
  runtimeAlive: {
    start: 'async function runtimeAlive(displayMode', end: '// 影响运行时行为的配置项',
    fns: ['runtimeAlive'], deps: ['runWsl', 'DISTRO', 'log', 'waitPort', 'NOVNC_PORT'],
  },
  cfgFingerprint: {
    start: '// 影响运行时行为的配置项', end: 'const readLastFingerprint =',
    fns: ['cfgFingerprint'], deps: ['RUNTIME_REV'],
  },
};

// 启动即校验所有标记唯一存在：切错了立刻死，绝不静默。
for (const [name, seg] of Object.entries(SEGMENTS)) {
  const countStart = MAIN_SRC.split(seg.start).length - 1;
  const countEnd = MAIN_SRC.split(seg.end).length - 1;
  if (countStart !== 1) throw new Error(`段 ${name} 起始标记出现 ${countStart} 次: ${seg.start}`);
  if (countEnd !== 1) throw new Error(`段 ${name} 结束标记出现 ${countEnd} 次: ${seg.end}`);
}

function loadSegment(name, deps) {
  const seg = SEGMENTS[name];
  if (!seg) throw new Error(`未知段: ${name}`);
  const missing = seg.deps.filter((d) => !(d in deps));
  if (missing.length) throw new Error(`段 ${name} 缺少依赖: ${missing.join(', ')}`);
  const i = MAIN_SRC.indexOf(seg.start);
  const j = MAIN_SRC.indexOf(seg.end, i + 1);
  const code = MAIN_SRC.slice(i, j);
  const exports_ = 'return { ' + seg.fns.map((n) => `${JSON.stringify(n)}: ${n}`).join(', ') + ' };';
  const factory = new Function(...seg.deps, code + '\n' + exports_);
  return factory(...seg.deps.map((d) => deps[d]));
}

// 常用桩：一个可编程的 runWsl —— 按「命令里包含的关键字」路由到预置输出。
function mkRunWsl(handler) {
  return async (args, _opts) => handler(String(args.join(' ')), args);
}

// 常用桩：不落盘的 log 收集器
function mkLogCollector() {
  const lines = [];
  const log = (tag, msg) => { lines.push(`[${tag}] ${msg}`); };
  return { log, lines };
}

module.exports = {
  ROOT,
  MAIN_SRC,
  MAIN_PATH,
  loadSegment,
  mkRunWsl,
  mkLogCollector,
  readRel: (p) => fs.readFileSync(path.join(ROOT, p), 'utf8'),
  existsRel: (p) => fs.existsSync(path.join(ROOT, p)),
};
