'use strict';
// L1 单元测试：/proc/net/route 解析 —— 坑 15 的核心。
// 网络熔断会删掉默认路由（00000000 行），解析必须在那之后仍能给出可用候选。
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSegment } = require('../loader');

const { hexIpLE, ipToInt, intToIp, parseRouteTable } = loadSegment('routeFns');

// 与真实 /proc/net/route 完全同构的样例（列宽用制表符分隔）
const HEADER = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';
// 正常态：有默认路由（Gateway=01F0A8C0）+ 直连 192.168.240.0/20 + DNS 主机路由 /32
const ROUTE_NORMAL = [
  HEADER,
  'eth0\t00000000\t01F0A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0',
  'eth0\t00F0A8C0\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0',
  'eth0\tFEFF0A0A\t00000000\t0005\t0\t0\t0\tFFFFFFFF\t0\t0\t0', // 10.10.255.254/32
  'lo\t0000007F\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0',   // 127.0.0.0/8
].join('\n');
// 熔断态：默认路由被 net-guard 删掉，只剩直连段与主机路由（1.0.30 事故现场）
const ROUTE_LOCKED = ROUTE_NORMAL.split('\n').filter((l) => !/^eth0\t00000000\t/.test(l)).join('\n');

test('hexIpLE: /proc/net/route 的小端十六进制转点分 IP', () => {
  assert.strictEqual(hexIpLE('01F0A8C0'), '192.168.240.1');
  assert.strictEqual(hexIpLE('00F0A8C0'), '192.168.240.0');
  assert.strictEqual(hexIpLE('0000007F'), '127.0.0.0');
});

test('ipToInt / intToIp: 互逆且对 WSL 网段正确', () => {
  const ip = '192.168.240.1';
  assert.strictEqual(intToIp(ipToInt(ip)), ip);
  assert.strictEqual(ipToInt('0.0.0.0'), 0);
  assert.strictEqual(intToIp(0xffffffff), '255.255.255.255');
});

test('parseRouteTable: 正常态识别默认网关与直连网段 .1', () => {
  const rt = parseRouteTable(ROUTE_NORMAL);
  assert.strictEqual(rt.gw, '192.168.240.1');
  assert.ok(rt.subnets.includes('192.168.240.1'), `subnets 应含直连网段: ${JSON.stringify(rt.subnets)}`);
});

test('parseRouteTable: 熔断态（无默认路由）gw 为 null，直连段 .1 仍在（坑 15）', () => {
  const rt = parseRouteTable(ROUTE_LOCKED);
  assert.strictEqual(rt.gw, null);
  assert.ok(rt.subnets.includes('192.168.240.1'), '直连网段推断是熔断态的唯一网关来源');
});

test('parseRouteTable: /32 主机路由与回环段不进候选', () => {
  const rt = parseRouteTable(ROUTE_NORMAL);
  assert.ok(!rt.subnets.includes('10.10.255.255'), '/32 不做 .1 推断');
  assert.ok(!rt.subnets.some((s) => s.startsWith('127.')), '回环不进候选');
});

test('parseRouteTable: 表头 / 畸形行被忽略，空输入安全', () => {
  assert.deepStrictEqual(parseRouteTable(''), { gw: null, subnets: [] });
  assert.deepStrictEqual(parseRouteTable(HEADER), { gw: null, subnets: [] });
  assert.deepStrictEqual(parseRouteTable('garbage\n\neth0\tXX\tYY\t0001'), { gw: null, subnets: [] });
});

test('parseRouteTable: link-local 169.254 不进候选', () => {
  const txt = [
    HEADER,
    'eth0\tFEA9A9C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0', // 169.254.169.254/24 类段
  ].join('\n');
  const rt = parseRouteTable(txt);
  assert.ok(!rt.subnets.some((s) => s.startsWith('169.254.')), `link-local 不应入选: ${JSON.stringify(rt.subnets)}`);
});
