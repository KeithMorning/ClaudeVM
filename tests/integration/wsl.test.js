'use strict';
// L3 集成测试：需要本机有 WSL2 且已导入 claude-vm 发行版，否则自动 skip。
//
// 安全约定（务必遵守）：
//   1. lock→unlock 测试会真实修改容器内核路由表 —— 只允许在环境「未运行」时执行
//      （/run/claude-vm/ready 为空）。正在运行的会话的熔断不能被测试解锁。
//   2. 每个改路由的用例都在 finally 里兜底 unlock，并以「默认路由已恢复」收尾断言。
//   3. 跑之前请先在应用里点「停止」。
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { loadSegment } = require('../loader');

const DISTRO = 'claude-vm';

// wsl.exe 执行 Linux 命令时输出是透传的 UTF-8；只有 wsl.exe 自己的输出（-l 等）是 UTF-16LE
function wsl(args, timeoutMs = 60000) {
  const r = spawnSync('wsl.exe', ['-d', DISTRO, '-u', 'root', '--', ...args], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
  });
  return { ok: r.status === 0, stdout: (r.stdout || ''), stderr: (r.stderr || '') };
}

function detectDistro() {
  try {
    const r = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 20000 });
    if (r.status !== 0) return false;
    const { decodeChunk } = loadSegment('decodeChunk');
    const { cleanWslList } = loadSegment('cleanWslList');
    const names = cleanWslList(decodeChunk(r.stdout));
    return names.some((n) => n.toLowerCase() === DISTRO);
  } catch {
    return false;
  }
}
const WSL_OK = detectDistro();
const WSL_SKIP = WSL_OK ? undefined : '本机没有 WSL2 或未导入 claude-vm 发行版';

// 环境是否空闲（ready 标记为空 = 没有正在运行的会话）
function envIdle() {
  const r = wsl(['bash', '-c', 'cat /run/claude-vm/ready 2>/dev/null'], 30000);
  return String(r.stdout).trim() === '';
}

test('容器内 /proc/net/route 可解析出网关或直连候选', { skip: WSL_SKIP }, () => {
  const { parseRouteTable } = loadSegment('routeFns');
  const r = wsl(['cat', '/proc/net/route']);
  assert.ok(r.ok, `读取失败: ${r.stderr}`);
  const rt = parseRouteTable(r.stdout);
  assert.ok(rt.gw || rt.subnets.length > 0, `既无默认路由也无直连段: ${JSON.stringify(rt)}`);
});

test('net-guard.py status 输出结构化 JSON 且字段齐全', { skip: WSL_SKIP }, () => {
  const r = wsl(['python3', '/opt/scripts/net-guard.py', 'status']);
  assert.ok(r.ok, `net-guard.py 不可用: ${r.stderr}`);
  const st = JSON.parse(r.stdout);
  for (const k of ['locked', 'default_v4', 'ipv6_disabled']) {
    assert.ok(k in st, `status 缺少字段 ${k}`);
  }
});

test('坑 15 回归：lock→status→unlock 往返，默认路由可精确还原', { skip: WSL_SKIP }, (t) => {
  if (!envIdle()) return t.skip('环境正在运行（ready 非空）—— 不会对活会话的熔断下手，先点「停止」');
  const { parseRouteTable } = loadSegment('routeFns');

  const rt0 = parseRouteTable(wsl(['cat', '/proc/net/route']).stdout);
  const proxyHost = rt0.gw || rt0.subnets[0];
  assert.ok(proxyHost, '拿不到任何网关候选，无法构造 lock 参数');

  const lock = JSON.parse(wsl(['python3', '/opt/scripts/net-guard.py', 'lock', `http://${proxyHost}:7897`]).stdout);
  assert.strictEqual(lock.ok, true, `lock 失败: ${JSON.stringify(lock)}`);

  const st = JSON.parse(wsl(['python3', '/opt/scripts/net-guard.py', 'status']).stdout);
  assert.strictEqual(st.locked, true, '锁定后 status 应为 locked');

  const lockedRoute = wsl(['cat', '/proc/net/route']).stdout;
  assert.ok(!/^eth0\t00000000\t/m.test(lockedRoute), '锁定后不应存在默认路由');

  try {
    const unlock = JSON.parse(wsl(['python3', '/opt/scripts/net-guard.py', 'unlock']).stdout);
    assert.strictEqual(unlock.ok, true, `unlock 失败: ${JSON.stringify(unlock)}`);
    assert.strictEqual(unlock.locked, false);

    const restored = wsl(['cat', '/proc/net/route']).stdout;
    assert.ok(/^eth0\t00000000\t[0-9A-F]{8}\t/m.test(restored), 'unlock 后默认路由必须回来 —— 这是 1.0.30 死锁的复原路径');
  } finally {
    // 兜底：断言失败也先把网络还原，绝不让测试环境留在熔断态
    wsl(['python3', '/opt/scripts/net-guard.py', 'unlock']);
  }
});

test('「停止→启动」核心链路：熔断态路由下仍能推出宿主地址（坑 15 端到端）', { skip: WSL_SKIP }, (t) => {
  if (!envIdle()) return t.skip('环境正在运行 —— 跳过破坏性路由测试');
  const { parseRouteTable } = loadSegment('routeFns');

  const rt0 = parseRouteTable(wsl(['cat', '/proc/net/route']).stdout);
  const proxyHost = rt0.gw || rt0.subnets[0];
  assert.ok(proxyHost);
  try {
    wsl(['python3', '/opt/scripts/net-guard.py', 'lock', `http://${proxyHost}:7897`]);

    // 模拟 1.0.30 事故现场：默认路由已被删，此时解析仍要给出可用宿主地址
    const locked = parseRouteTable(wsl(['cat', '/proc/net/route']).stdout);
    assert.strictEqual(locked.gw, null, '前置：默认路由确实已被删');

    const lp = wsl(['bash', '-c', 'cat /opt/config/local-proxy 2>/dev/null']).stdout.trim();
    const cached = /^http:\/\/(\d+\.\d+\.\d+\.\d+):/.exec(lp);
    const viaSubnet = locked.subnets.includes(proxyHost);
    assert.ok(viaSubnet || (cached && cached[1] === proxyHost),
      `熔断态下必须还能推出宿主 ${proxyHost}: subnets=${JSON.stringify(locked.subnets)} local-proxy=${lp}`);
  } finally {
    wsl(['python3', '/opt/scripts/net-guard.py', 'unlock']);
  }
});

test('check-env.sh --json 输出可被解析（自检链路可用）', { skip: WSL_SKIP }, () => {
  const r = wsl(['/opt/scripts/check-env.sh', '--json'], 120000);
  if (!r.ok || !r.stdout.trim()) {
    // 环境未运行时 check-env 允许降级，但脚本本身必须能跑完
    assert.ok(r.stderr.length === 0 || r.ok, `check-env.sh 执行失败: ${r.stderr.slice(0, 200)}`);
    return;
  }
  const out = JSON.parse(r.stdout);
  assert.ok(typeof out === 'object' && out !== null);
});
