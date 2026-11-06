'use strict';
// L1 单元测试：resolveUpstream 上游代理解析链 —— 坑 15 的直接回归测试。
// 事故回放：网络熔断删默认路由后，「停止→启动」必现
// 「代理在本机可以连上，但容器内连不到它」，且报错误导用户去开 Allow LAN。
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSegment } = require('../loader');

const { isLoopbackHost, stripSlash, parseProxy } = loadSegment('proxyFns');
const { PROBE_JS } = loadSegment('probeJs');

const HEADER = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask';
const ROUTE_NORMAL = [
  HEADER,
  'eth0\t00000000\t01F0A8C0\t0003\t0\t0\t0\t00000000',
  'eth0\t00F0A8C0\t00000000\t0001\t0\t0\t0\t00F0FFFF',
].join('\n');
const ROUTE_LOCKED = ROUTE_NORMAL.split('\n').filter((l) => !/^eth0\t00000000\t/.test(l)).join('\n');

// 组装一条真实的解析链：runWsl 按「命令关键词」路由到预置输出。
function build({ routeTxt = ROUTE_NORMAL, localProxy = '', reach = [], probeErr = null, routeStdout = null, waitPortUp = true }) {
  const runWsl = async (args) => {
    const cmd = String(args.join(' '));
    if (cmd.includes('/proc/net/route')) {
      // routeStdout 用来模拟「路由表读取失败」（无标记输出）
      const out = routeStdout != null ? routeStdout
        : `__NET_ROUTE__\n${routeTxt}\n__LOCAL_PROXY__\n${localProxy}\n`;
      return { ok: true, stdout: out, stderr: routeStdout != null ? 'wsl: 拉起失败' : '' };
    }
    if (cmd.includes('proxy-probe.js')) {
      if (probeErr) return { ok: false, stdout: '', stderr: probeErr };
      return { ok: true, stdout: 'OK:' + reach.join(',') + '\n', stderr: '' };
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  const { wslProbeHosts } = loadSegment('probeHosts', { runWsl, PROBE_JS, DISTRO: 'claude-vm' });
  const seg = loadSegment('upstream', {
    isLoopbackHost, parseProxy, stripSlash, runWsl, DISTRO: 'claude-vm',
    waitPort: async () => waitPortUp, log: () => {}, ROUTER_PORT: 7890, wslProbeHosts, PROBE_JS,
  });
  return seg;
}

test('正常态：默认路由网关可达 → 映射为宿主地址', async () => {
  const { resolveUpstream } = build({ reach: ['192.168.240.1'] });
  const r = await resolveUpstream('http://127.0.0.1:7897', null);
  assert.strictEqual(r.url, 'http://192.168.240.1:7897');
  assert.ok(!r.error);
  assert.ok(r.note.includes('192.168.240.1:7897'));
});

test('熔断态（坑 15）：默认路由没了，靠直连网段/缓存地址仍能解析成功', async () => {
  const { resolveUpstream } = build({
    routeTxt: ROUTE_LOCKED,
    localProxy: 'http://192.168.240.1:7897',
    reach: ['192.168.240.1'],
  });
  const r = await resolveUpstream('http://127.0.0.1:7897', null);
  assert.strictEqual(r.url, 'http://192.168.240.1:7897');
  assert.ok(!r.error, `不应报错: ${r.error}`);
});

test('熔断态 + 全部不可达：报错文案区分「熔断锁定」与「Allow LAN」', async () => {
  const { resolveUpstream } = build({ routeTxt: ROUTE_LOCKED, reach: [] });
  const r = await resolveUpstream('http://127.0.0.1:7897', null);
  assert.ok(r.error, '应返回 error');
  assert.ok(r.error.includes('容器内没有默认路由'), '应说明熔断锁定是预期状态: ' + r.error);
  assert.ok(r.error.includes('Allow LAN'), '应保留 Allow LAN 的真实排查建议');
});

test('镜像网络模式：127.0.0.1 直达宿主时原样返回', async () => {
  const { resolveUpstream } = build({ reach: ['127.0.0.1'] });
  const r = await resolveUpstream('http://127.0.0.1:7897', null);
  assert.strictEqual(r.url, 'http://127.0.0.1:7897');
});

test('端口与容器内 router 相同（7890）时，127.0.0.1 不参与探测（防假阳性）', async () => {
  const { resolveUpstream } = build({ reach: [] });
  const r = await resolveUpstream('http://127.0.0.1:7890', null);
  assert.ok(r.error);
  const tried = /容器内尝试过 (.+)/.exec(r.error);
  assert.ok(tried, '错误信息应列出已尝试地址');
  assert.ok(!tried[1].includes('127.0.0.1'), `127.0.0.1 不应参与探测: ${tried[1]}`);
});

test('Windows 侧端口没监听：直接告知而不是误导', async () => {
  const { resolveUpstream } = build({ waitPortUp: false });
  const r = await resolveUpstream('http://127.0.0.1:7897', null);
  assert.ok(r.error && r.error.includes('没有代理在监听'));
});

test('容器内探测脚本本身失败：如实报「环境探测失败」', async () => {
  const { resolveUpstream } = build({ probeErr: 'node: command not found' });
  const r = await resolveUpstream('http://127.0.0.1:7897', null);
  assert.ok(r.error && r.error.includes('环境探测失败'), r.error);
  assert.ok(r.error.includes('node: command not found'), '应带上真实错误');
});

test('路由表读取失败（发行版起不来）：同样归入环境探测失败', async () => {
  const { resolveUpstream } = build({ routeStdout: '' });
  const r = await resolveUpstream('http://127.0.0.1:7897', null);
  assert.ok(r.error && r.error.includes('环境探测失败'), r.error);
});

test('wslHostCandidates: local-proxy 里的域名与回环不作为缓存候选', async () => {
  const { wslHostCandidates } = build({
    routeTxt: ROUTE_LOCKED,
    localProxy: 'http://proxy.example.com:7897',
    reach: ['192.168.240.1'],
  });
  const info = await wslHostCandidates();
  assert.strictEqual(info.cached, null, '域名不进缓存候选');
  assert.strictEqual(info.gw, null);
  assert.strictEqual(info.routeLocked, true);
  assert.ok(info.subnets.includes('192.168.240.1'));
});

test('wslHostCandidates: 熔断态的缓存地址能被正确读出', async () => {
  const { wslHostCandidates } = build({
    routeTxt: ROUTE_LOCKED,
    localProxy: 'http://192.168.240.1:7897',
  });
  const info = await wslHostCandidates();
  assert.strictEqual(info.cached, '192.168.240.1');
  assert.strictEqual(info.err, null);
});

test('非回环的远程代理地址直接透传，不做容器内映射', async () => {
  const { resolveUpstream } = build({ reach: [] });
  const r = await resolveUpstream('http://proxy.example.com:8080', null);
  assert.strictEqual(r.url, 'http://proxy.example.com:8080');
});
