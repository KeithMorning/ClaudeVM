'use strict';
// L1 单元测试：代理解析三件套 —— 坑 8 的重灾区。
// 历史事故：Chrome 的 --proxy-server 只认 host:port，URL 对象的 href 会把空路径补成
// "/"，得到 http://h:p/ → Chrome 直接 ERR_NO_SUPPORTED_PROXIES。
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSegment } = require('../loader');

test('isLoopbackHost: 认出全部回环写法（含大小写与空值）', () => {
  const { isLoopbackHost } = loadSegment('proxyFns');
  for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '']) {
    assert.strictEqual(isLoopbackHost(h), true, `应判定为回环: ${JSON.stringify(h)}`);
  }
  for (const h of ['192.168.240.1', 'example.com', '0.0.0.0']) {
    assert.strictEqual(isLoopbackHost(h), false, `不应判定为回环: ${h}`);
  }
});

test('stripSlash: 剥掉代理地址尾部斜杠（坑 8）', () => {
  const { stripSlash } = loadSegment('proxyFns');
  assert.strictEqual(stripSlash('http://h:7897/'), 'http://h:7897');
  assert.strictEqual(stripSlash('http://h:7897///'), 'http://h:7897');
  assert.strictEqual(stripSlash('  http://h:7897/  '), 'http://h:7897');
});

test('stripSlash: 空值安全', () => {
  const { stripSlash } = loadSegment('proxyFns');
  assert.strictEqual(stripSlash(''), '');
  assert.strictEqual(stripSlash(null), '');
});

test('parseProxy: 裸 host:port 自动补 http:// 且 href 不带尾斜杠', () => {
  const { parseProxy } = loadSegment('proxyFns');
  const p = parseProxy('127.0.0.1:7897');
  assert.strictEqual(p.host, '127.0.0.1');
  assert.strictEqual(p.port, 7897);
  assert.strictEqual(p.protocol, 'http:');
  assert.strictEqual(p.href, 'http://127.0.0.1:7897');
});

test('parseProxy: 用户输入的尾斜杠也被剥掉（Chrome 可用性）', () => {
  const { parseProxy } = loadSegment('proxyFns');
  const p = parseProxy('http://proxy.example.com:8080/');
  assert.strictEqual(p.href, 'http://proxy.example.com:8080');
});

test('parseProxy: https 默认端口 443，http 默认 80', () => {
  const { parseProxy } = loadSegment('proxyFns');
  assert.strictEqual(parseProxy('https://h.example.com').port, 443);
  assert.strictEqual(parseProxy('http://h.example.com').port, 80);
});

test('parseProxy: 保留非根路径', () => {
  const { parseProxy } = loadSegment('proxyFns');
  const p = parseProxy('http://h.example.com:3128/path');
  assert.strictEqual(p.href, 'http://h.example.com:3128/path');
});

test('parseProxy: 带凭据与主机名', () => {
  const { parseProxy } = loadSegment('proxyFns');
  const p = parseProxy('http://user:pass@10.0.0.8:10809');
  assert.strictEqual(p.host, '10.0.0.8');
  assert.strictEqual(p.port, 10809);
});

test('parseProxy: 无法解析的输入返回 null', () => {
  const { parseProxy } = loadSegment('proxyFns');
  assert.strictEqual(parseProxy(''), null);
  assert.strictEqual(parseProxy(null), null);
  assert.strictEqual(parseProxy('not a url at all ###'), null);
});
