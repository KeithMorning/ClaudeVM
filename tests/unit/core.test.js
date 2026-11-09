'use strict';
// L1 单元测试：基础纯函数（编码 / 脱敏 / 路径规范 / 配置合并）
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSegment } = require('../loader');

test('decodeChunk: 纯 UTF-8 输出按 UTF-8 解码', () => {
  const { decodeChunk } = loadSegment('decodeChunk');
  assert.strictEqual(decodeChunk(Buffer.from('hello 世界', 'utf8')), 'hello 世界');
});

test('decodeChunk: 头部含 0x00 判定 wsl.exe 的 UTF-16LE 输出', () => {
  const { decodeChunk } = loadSegment('decodeChunk');
  // wsl.exe 输出 UTF-16LE（每个 ASCII 字符后跟一个 \0）
  assert.strictEqual(decodeChunk(Buffer.from('Ubuntu', 'utf16le')), 'Ubuntu');
});

test('redact: 抹掉代理 URL 里的 user:pass 凭据', () => {
  const { redact } = loadSegment('redact');
  assert.strictEqual(redact('http://user:pass@example.com:8080'), 'http://***@example.com:8080');
});

test('redact: 没有凭据的地址原样返回', () => {
  const { redact } = loadSegment('redact');
  assert.strictEqual(redact('http://192.168.240.1:7897'), 'http://192.168.240.1:7897');
});

test('redact: 空值安全', () => {
  const { redact } = loadSegment('redact');
  assert.strictEqual(redact(''), '');
  assert.strictEqual(redact(null), '');
  assert.strictEqual(redact(undefined), '');
});

test('normalizeWinPath: 正斜杠与重复反斜杠收敛（指纹漂移坑）', () => {
  const { normalizeWinPath } = loadSegment('normalizeWinPath');
  assert.strictEqual(normalizeWinPath('C:\\Users\\\\x\\\\y'), 'C:\\Users\\x\\y');
  assert.strictEqual(normalizeWinPath('C:/Users/x/y'), 'C:\\Users\\x\\y');
});

test('normalizeWinPath: UNC 路径保留开头的双反斜杠', () => {
  const { normalizeWinPath } = loadSegment('normalizeWinPath');
  assert.strictEqual(normalizeWinPath('\\\\server\\share\\dir'), '\\\\server\\share\\dir');
});

test('normalizeWinPath: 去首尾空白，空串安全', () => {
  const { normalizeWinPath } = loadSegment('normalizeWinPath');
  assert.strictEqual(normalizeWinPath('  C:\\a\\b  '), 'C:\\a\\b');
  assert.strictEqual(normalizeWinPath(''), '');
});

test('mergeCfg: 保存值覆盖默认值，workspace 被规范化', () => {
  const { normalizeWinPath } = loadSegment('normalizeWinPath');
  const pathStub = { join: (...a) => a.join('/').replace(/\\/g, '/') };
  const appStub = { getPath: () => '/home/u' };
  const { defaultConfig } = loadSegment('defaultConfig', {
    path: pathStub, app: appStub, DEFAULT_WHITELIST: '.anthropic.com',
  });
  const { mergeCfg } = loadSegment('mergeCfg', { defaultConfig, normalizeWinPath });

  const cfg = mergeCfg({ proxy: 'http://127.0.0.1:7897', workspace: 'C:/w s//p' });
  assert.strictEqual(cfg.proxy, 'http://127.0.0.1:7897');
  assert.strictEqual(cfg.workspace, 'C:\\w s\\p');
  // 未提供的字段取默认
  assert.strictEqual(cfg.tz, 'Asia/Taipei');
  // macOS 没有 WSLg，mergeCfg 会强制 desktop；其它平台保留默认 wslg
  assert.strictEqual(cfg.displayMode, process.platform === 'darwin' ? 'desktop' : 'wslg');
  assert.strictEqual(cfg.netGuard, 'strict');
});

test('normalizeWinPath: POSIX 路径只收敛斜杠，不做反斜杠替换', () => {
  const { normalizeWinPath } = loadSegment('normalizeWinPath');
  assert.strictEqual(normalizeWinPath('/Users/keith//claude-workspace'), '/Users/keith/claude-workspace');
  assert.strictEqual(normalizeWinPath('/Users/keith/ws/'), '/Users/keith/ws');
  assert.strictEqual(normalizeWinPath('/'), '/');
});

test('toWslPath: Windows 盘符路径转 /mnt/<小写盘符>/…', () => {
  const { toWslPath } = loadSegment('toWslPath');
  assert.strictEqual(toWslPath('E:\\Web\\FuckCladue'), '/mnt/e/Web/FuckCladue');
  assert.strictEqual(toWslPath('e:/Users/x'), '/mnt/e/Users/x');
});

test('toWslPath: 已是 WSL 路径或空值原样返回', () => {
  const { toWslPath } = loadSegment('toWslPath');
  assert.strictEqual(toWslPath('/opt/scripts/x.sh'), '/opt/scripts/x.sh');
  assert.strictEqual(toWslPath(''), '');
});

test('cleanWslList: wsl.exe 的 UTF-16LE 空字节与空行全部清洗', () => {
  const { cleanWslList } = loadSegment('cleanWslList');
  assert.deepStrictEqual(cleanWslList('a\0b\r\n\r\n c\n \n'), ['ab', 'c']);
});
