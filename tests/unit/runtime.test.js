'use strict';
// L1 单元测试：运行时存活判定（坑 13 假活）与配置指纹（坑 13 RUNTIME_REV）。
// 事故回放（坑 13）：runtimeAlive 只看 /run/claude-vm/ready 标记，进程全退了标记还在，
// 应用于是「接管一具尸体」—— 不同步脚本、不重建会话，1.0.27 的修复一直进不了 VM。
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSegment, mkLogCollector } = require('../loader');

function buildRuntime({ ready, procs, portUp }) {
  const collector = mkLogCollector();
  const runWsl = async (args) => {
    const cmd = String(args.join(' '));
    if (cmd.includes('/run/claude-vm/ready')) return { ok: true, stdout: `${ready || ''}\n`, stderr: '' };
    if (cmd.includes('pgrep -x Xtigervnc')) return { ok: true, stdout: `${procs || 'DEAD'}\n`, stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const { runtimeAlive } = loadSegment('runtimeAlive', {
    runWsl, DISTRO: 'claude-vm', log: collector.log, waitPort: async () => !!portUp, NOVNC_PORT: 6080,
  });
  return { runtimeAlive, collector };
}

test('wslg 模式：ready=wslg 判活', async () => {
  const { runtimeAlive } = buildRuntime({ ready: 'wslg' });
  assert.strictEqual(await runtimeAlive('wslg'), true);
});

test('wslg 模式：标记为 desktop 或为空都判死', async () => {
  const a = buildRuntime({ ready: 'desktop' });
  const b = buildRuntime({ ready: '' });
  assert.strictEqual(await a.runtimeAlive('wslg'), false);
  assert.strictEqual(await b.runtimeAlive('wslg'), false);
});

test('desktop 模式：标记还在但进程全退 → 假活，判死（坑 13）', async () => {
  const { runtimeAlive, collector } = buildRuntime({ ready: 'desktop', procs: 'DEAD', portUp: false });
  assert.strictEqual(await runtimeAlive('desktop'), false);
  assert.ok(
    collector.lines.some((l) => l.includes('桌面进程缺失')),
    '假活必须留日志，否则排障时无从判断为什么重建',
  );
});

test('desktop 模式：进程在但串流端口没监听 → 仍判死', async () => {
  const { runtimeAlive } = buildRuntime({ ready: 'desktop', procs: 'RUNNING', portUp: false });
  assert.strictEqual(await runtimeAlive('desktop'), false);
});

test('desktop 模式：进程与端口都在 → 判活', async () => {
  const { runtimeAlive } = buildRuntime({ ready: 'desktop', procs: 'RUNNING', portUp: true });
  assert.strictEqual(await runtimeAlive('desktop'), true);
});

test('desktop 模式：无标记且进程全退 → 判死', async () => {
  const { runtimeAlive } = buildRuntime({ ready: '', procs: 'DEAD', portUp: false });
  assert.strictEqual(await runtimeAlive('desktop'), false);
});

// ---------- 配置指纹 ----------

function fingerprintDeps() {
  const { normalizeWinPath } = loadSegment('normalizeWinPath');
  const pathStub = { join: (...a) => a.join('/').replace(/\\/g, '/') };
  const appStub = { getPath: () => '/home/u' };
  const { defaultConfig } = loadSegment('defaultConfig', {
    path: pathStub, app: appStub, DEFAULT_WHITELIST: '.anthropic.com',
  });
  const { mergeCfg } = loadSegment('mergeCfg', { defaultConfig, normalizeWinPath });
  return { mergeCfg };
}

const baseCfg = {
  tz: 'Asia/Taipei', lang: 'zh_TW.UTF-8', proxy: 'http://127.0.0.1:7897',
  proxyMode: 'all', whitelist: '.anthropic.com', workspace: 'C:\\w\\p',
  displayMode: 'desktop', netGuard: 'strict', inputMethod: 'rime',
};

test('cfgFingerprint: workspace 写法漂移不改变指纹（经 mergeCfg 规范化）', () => {
  const { mergeCfg } = fingerprintDeps();
  const { cfgFingerprint } = loadSegment('cfgFingerprint', { RUNTIME_REV: 5 });
  const a = cfgFingerprint(mergeCfg({ ...baseCfg, workspace: 'C:\\w\\p' }));
  const b = cfgFingerprint(mergeCfg({ ...baseCfg, workspace: 'C:/w//p' }));
  assert.strictEqual(a, b, '同一工作区的不同写法必须产生同一指纹，否则会反复重建');
});

test('cfgFingerprint: 熔断开关 / 显示模式 / 输入法 / 时区 任一变化都改变指纹', () => {
  const { mergeCfg } = fingerprintDeps();
  const { cfgFingerprint } = loadSegment('cfgFingerprint', { RUNTIME_REV: 5 });
  const fp = (patch) => cfgFingerprint(mergeCfg({ ...baseCfg, ...patch }));
  const base = fp({});
  assert.notStrictEqual(fp({ netGuard: 'off' }), base, '熔断改内核路由表，必须重建');
  assert.notStrictEqual(fp({ displayMode: 'wslg' }), base, '显示模式换整套后端');
  assert.notStrictEqual(fp({ inputMethod: 'off' }), base, '输入法要重起 ibus');
  assert.notStrictEqual(fp({ tz: 'America/New_York' }), base);
  assert.notStrictEqual(fp({ proxy: 'http://127.0.0.1:7890' }), base);
});

test('cfgFingerprint: RUNTIME_REV 变化改变指纹（坑 13：升级强制重建）', () => {
  const { mergeCfg } = fingerprintDeps();
  const merged = mergeCfg(baseCfg);
  const rev5 = loadSegment('cfgFingerprint', { RUNTIME_REV: 5 }).cfgFingerprint(merged);
  const rev6 = loadSegment('cfgFingerprint', { RUNTIME_REV: 6 }).cfgFingerprint(merged);
  assert.notStrictEqual(rev5, rev6, '改脚本/资源不加 RUNTIME_REV 会导致新版接管旧会话');
});
