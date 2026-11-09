'use strict';
// L1 单元测试：vm-backend 纯函数 —— 平台选择、工作区映射、docker create 参数。
// 这个模块是「纯函数抽到 app/lib 后直接 require」的第一个实例（tests/README 的重构方向），
// 不需要 loader 切片，也没有 Electron 依赖。
const { test } = require('node:test');
const assert = require('node:assert');
const B = require('../../claude-desktop/app/lib/vm-backend');

test('pickBackendId: win32 → wsl，其余平台 → container', () => {
  assert.strictEqual(B.pickBackendId('win32'), 'wsl');
  assert.strictEqual(B.pickBackendId('darwin'), 'container');
  assert.strictEqual(B.pickBackendId('linux'), 'container');
});

test('guestWorkspacePathFor: /Users 与 /Volumes 映射到挂载点', () => {
  assert.strictEqual(B.guestWorkspacePathFor('/Users/keith/ws'), '/mnt/host-users/keith/ws');
  assert.strictEqual(B.guestWorkspacePathFor('/Volumes/SSD/proj'), '/mnt/host-volumes/SSD/proj');
});

test('guestWorkspacePathFor: 挂载范围之外返回 null（由调用方报错，不猜）', () => {
  assert.strictEqual(B.guestWorkspacePathFor('/opt/other'), null);
  assert.strictEqual(B.guestWorkspacePathFor(''), null);
  assert.strictEqual(B.guestWorkspacePathFor(null), null);
});

test('buildCreateArgs: 必须包含安全与运行必需的旗标', () => {
  const args = B.buildCreateArgs({
    scriptsDir: '/app/runtime/scripts',
    assetsDir: '/app/runtime/assets',
    novncPort: 6080,
    specHash: 'abc',
  });
  const s = args.join(' ');
  assert.ok(s.includes('--init'), 'tini 做 PID1，docker stop 才能干净收尾');
  assert.ok(s.includes('--shm-size=1g'), 'Chrome 需要大 /dev/shm');
  assert.ok(s.includes('NET_ADMIN'), 'net-guard 熔断需要 netlink 权限');
  assert.ok(s.includes('127.0.0.1:6080:6080'), 'noVNC 端口只发布到本机回环');
  assert.ok(s.includes('claudevm-home:/root'), '/root 必须在命名卷上，重建实例不丢凭据');
  assert.ok(s.includes('/app/runtime/scripts:/mnt/sync-scripts:ro'), '脚本目录只读挂载');
  assert.ok(s.includes('claudevm.spec=abc'), '规格指纹要进 label，挂载源变化时触发重建');
  assert.ok(s.includes('sleep infinity'), 'PID1 是占位进程，entrypoint 走 docker exec');
});

test('buildCreateArgs: 未给 scripts/assets 目录时不产生空挂载', () => {
  const args = B.buildCreateArgs({ specHash: '' });
  assert.ok(!args.join(' ').includes(':/mnt/sync-scripts'), '不应出现空的挂载源');
});

test('specHashFor: 挂载源任一变化都会改变指纹', () => {
  assert.strictEqual(B.specHashFor('a', 'b'), 'a|b');
  assert.notStrictEqual(B.specHashFor('a', 'b'), B.specHashFor('a', 'c'));
  assert.notStrictEqual(B.specHashFor('a', 'b'), B.specHashFor('x', 'b'));
});

test('getBackend: 本机平台返回对应后端且接口齐全', () => {
  const backend = B.getBackend();
  assert.strictEqual(backend.id, B.pickBackendId(process.platform));
  for (const m of ['probe', 'runGuest', 'imageExists', 'ensureImage', 'spawnEntry',
    'stopAll', 'diagInfo', 'guestScriptsPath', 'guestAssetsPath', 'guestWorkspacePath',
    'extraHostCandidates', 'hostPortOwner']) {
    assert.ok(typeof backend[m] === 'function', `缺少接口 ${m}`);
  }
});
