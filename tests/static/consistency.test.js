'use strict';
// L2 静态一致性测试：不运行任何环境，只验证「仓库里的东西是对的」。
// 这一层是本项目最便宜的回归防线 —— 历史上 15 个坑里大半能在这里拦住：
//   坑 12 openbox Close context、坑 13 两侧脚本漂移 / RUNTIME_REV、
//   坑 14 entrypoint 兜底与输入法位置、坑 15 stopRuntime 顺序。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, MAIN_SRC, readRel, loadSegment } = require('../loader');

const VM_SCRIPTS = path.join(ROOT, 'claude-vm', 'vm', 'scripts');
const RUNTIME_SCRIPTS = path.join(ROOT, 'claude-desktop', 'runtime', 'scripts');
const VM_ASSETS = path.join(ROOT, 'claude-vm', 'vm', 'assets');
const RUNTIME_ASSETS = path.join(ROOT, 'claude-desktop', 'runtime', 'assets');

function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }
function scriptFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(sh|py|js)$/.test(f)) : null;
}

// 克隆后的机器上 runtime/scripts 不存在（被 .gitignore 排除，构建时由 sync-scripts 生成）。
// 测试在这里自动补一次同步，让一致性检查在任何机器上都能跑。
test('前置：runtime/scripts 缺失时自动同步（克隆后首次跑测试）', () => {
  const files = scriptFiles(RUNTIME_SCRIPTS);
  if (files && files.length > 0) return;
  const r = spawnSync(process.execPath, ['scripts/sync-scripts.js'], {
    cwd: path.join(ROOT, 'claude-desktop'), encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `sync-scripts 失败:\n${r.stdout}\n${r.stderr}`);
  assert.ok((scriptFiles(RUNTIME_SCRIPTS) || []).length > 0, '同步后仍为空');
});

test('坑 13：镜像与打包副本的运行时脚本逐字节一致（修复在包里 ≠ 修复在环境里）', () => {
  const names = scriptFiles(VM_SCRIPTS);
  assert.ok(names.length >= 15, `镜像脚本数量异常: ${names.length}`);
  for (const f of names) {
    const a = fs.readFileSync(path.join(VM_SCRIPTS, f));
    const b = fs.readFileSync(path.join(RUNTIME_SCRIPTS, f));
    assert.ok(a.equals(b), `claude-vm/vm/scripts/${f} 与 claude-desktop/runtime/scripts/${f} 不一致 —— 打包会带上旧脚本`);
  }
});

test('坑 13：副本里不得出现真源之外的脚本（防手改副本漂移）', () => {
  const vm = new Set(scriptFiles(VM_SCRIPTS));
  const extra = scriptFiles(RUNTIME_SCRIPTS).filter((f) => !vm.has(f));
  assert.deepStrictEqual(extra, [], `真源在 claude-vm/vm/scripts/，副本里出现未知文件: ${extra.join(', ')}`);
});

test('界面资源按 sync-scripts 清单逐字节一致（单一真源，清单本身即 spec）', () => {
  // 从 sync-scripts.js 提取 ASSETS 映射表，避免测试与实现双份维护
  const syncSrc = readRel('claude-desktop/scripts/sync-scripts.js');
  const pairs = [...syncSrc.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 6, `ASSETS 清单数量异常: ${pairs.length}`);
  for (const [from, to] of pairs) {
    const src = path.join(ROOT, 'claude-vm', 'vm', from);
    assert.ok(fs.existsSync(src), `清单源缺失: claude-vm/vm/${from}`);
    const dst = path.join(RUNTIME_ASSETS, to);
    assert.ok(fs.existsSync(dst), `副本缺失: runtime/assets/${to}（先跑 npm run sync-scripts）`);
    const a = fs.readFileSync(src);
    const b = fs.readFileSync(dst);
    assert.ok(a.equals(b), `资源不一致: claude-vm/vm/${from} ≠ runtime/assets/${to}`);
  }
});

// ---------- 工具可用性（缺失则相应检查跳过） ----------
function findTool(candidates, probeArgs) {
  for (const c of candidates) {
    try {
      const r = spawnSync(c, probeArgs, { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0) return c;
    } catch { /* 继续 */ }
  }
  return null;
}
const BASH = findTool(['bash', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'], ['-c', 'echo ok']);
const PYTHON = findTool(['python', 'python3'], ['-c', 'print("ok")']);

test('所有 .sh 语法检查（bash -n）', { skip: !BASH && 'bash 不可用，跳过语法检查' }, () => {
  for (const f of scriptFiles(VM_SCRIPTS).filter((f) => f.endsWith('.sh'))) {
    const r = spawnSync(BASH, ['-n', `claude-vm/vm/scripts/${f}`], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${f} 语法错误:\n${r.stdout}${r.stderr}`);
  }
});

test('所有 .py 语法检查（ast.parse）', { skip: !PYTHON && 'python 不可用，跳过语法检查' }, () => {
  for (const f of scriptFiles(VM_SCRIPTS).filter((f) => f.endsWith('.py'))) {
    const code = 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())';
    const r = spawnSync(PYTHON, ['-c', code, `claude-vm/vm/scripts/${f}`], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${f} 语法错误:\n${r.stdout}${r.stderr}`);
  }
});

test('openbox 配置可被 XML 解析', { skip: !PYTHON && 'python 不可用，跳过 XML 解析' }, () => {
  const code = 'import sys,xml.etree.ElementTree as ET;ET.parse(sys.argv[1])';
  const r = spawnSync(PYTHON, ['-c', code, 'claude-vm/vm/config/openbox-rc.xml'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `openbox-rc.xml 不是合法 XML:\n${r.stdout}${r.stderr}`);
});

// ---------- 行为规格断言：把「踩过的坑」固化成源码级 spec ----------
const ep = () => readRel('claude-vm/vm/scripts/entrypoint.sh');

test('坑 14：entrypoint 的 wait 有 sleep infinity 兜底（会话猝死）', () => {
  assert.match(ep(), /sleep infinity &/, 'desktop 分支必须挂住 wait，否则任一组件退出即会话死亡');
});

test('坑 14：输入法段位于 DISPLAY=:1 之后（XIM 注册错 X server）', () => {
  const s = ep();
  const inputSection = s.indexOf('# 2.45) 中文输入法');
  const displayExport = s.indexOf('export DISPLAY=:1');
  assert.ok(inputSection > 0, '找不到输入法段标记 # 2.45)');
  assert.ok(displayExport > 0, '找不到 export DISPLAY=:1');
  assert.ok(inputSection > displayExport, 'ibus 必须在 DISPLAY 确定后启动，否则 XIM 注册到 WSLg :0');
});

test('坑 14：Chrome 启动前清理 SingletonLock（Profile 被别的主机占用）', () => {
  assert.match(ep(), /SingletonLock/, 'entrypoint 桌面启动段应清陈旧 Chrome 锁');
  const chrome = readRel('claude-vm/vm/scripts/chrome-login.sh');
  assert.match(chrome, /SingletonLock/, 'chrome-login.sh 也要清（桌面图标路径）');
});

test('坑 14：desktop-guard 自愈清单覆盖四个组件', () => {
  const g = readRel('claude-vm/vm/scripts/desktop-guard.sh');
  for (const k of ['Xtigervnc', 'openbox', 'websockify', 'XIM_SERVERS']) {
    assert.ok(g.includes(k), `desktop-guard.sh 缺少组件 ${k}`);
  }
});

test('坑 12：openbox 配置用官方 Close context，无错误命名', () => {
  const xml = readRel('claude-vm/vm/config/openbox-rc.xml');
  assert.match(xml, /context name="Close"/);
  assert.doesNotMatch(xml, /context name="CloseButton"/, 'CloseButton 是臆造的 context 名，Openbox 不认');
});

test('坑 15：net-guard.py 的 unlock 报错不再误导「重启会自动恢复」', () => {
  const py = readRel('claude-vm/vm/scripts/net-guard.py');
  assert.doesNotMatch(py, /重启虚拟环境会自动恢复/, 'wsl --terminate 不恢复路由，这句是错的');
  assert.match(py, /wsl --shutdown/, '正确指引应是 wsl --shutdown');
});

test('坑 13：main.js 的 RUNTIME_REV 为正整数并参与指纹', () => {
  assert.match(MAIN_SRC, /const RUNTIME_REV = \d+;/);
  const { cfgFingerprint } = loadSegment('cfgFingerprint', { RUNTIME_REV: 1 });
  assert.ok(cfgFingerprint({}).includes('rev'), '指纹必须含 rev，否则升级会接管旧会话');
});

test('坑 13：desktop 存活判定必须查真实进程（不能只看 ready 标记）', () => {
  assert.ok(MAIN_SRC.includes('pgrep -x Xtigervnc'), 'runtimeAlive 应 pgrep 常驻进程');
});

test('坑 15：stopRuntime 先 unlock 再 kill（顺序不可颠倒）', () => {
  const start = MAIN_SRC.indexOf('async function stopRuntime()');
  const end = MAIN_SRC.indexOf('async function checkEnv()');
  assert.ok(start > 0 && end > start, '找不到 stopRuntime 函数体');
  const body = MAIN_SRC.slice(start, end);
  const unlockIdx = body.indexOf("'unlock'");
  const killIdx = body.indexOf('runtimeProc.kill()');
  assert.ok(unlockIdx > 0, 'stopRuntime 应调用 net-guard.py unlock');
  assert.ok(killIdx > unlockIdx, 'unlock 必须先于 runtimeProc.kill()：kill 后 /run 会话消失，原始路由记录就没了');
});

test('坑 15：网关发现不再依赖默认路由（旧 wslGateway 已移除）', () => {
  assert.ok(!MAIN_SRC.includes('wslGateway'), 'wslGateway 只认默认路由，是坑 15 死锁的根因');
  assert.ok(MAIN_SRC.includes('wslHostCandidates'), '应使用多来源候选解析');
  assert.ok(MAIN_SRC.includes('parseRouteTable'), '应解析 /proc/net/route 直连段');
  assert.ok(MAIN_SRC.includes('/opt/config/local-proxy'), '应读取上次成功的宿主地址');
});

// ---------- 工程基本面 ----------
test('package.json 版本与构建入口完整', () => {
  const pkg = JSON.parse(readRel('claude-desktop/package.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '版本号应是 x.y.z');
  assert.ok(pkg.scripts['dist:win'], '必须有 dist:win');
  assert.ok(pkg.scripts['sync-scripts'], '必须有 sync-scripts（pre 钩子依赖它）');
  assert.ok(fs.existsSync(path.join(ROOT, 'claude-desktop', 'app', 'main.js')));
});

test('换行策略：.gitattributes 强制 LF（Linux 脚本防 CRLF 中毒）', () => {
  const ga = readRel('.gitattributes');
  assert.match(ga, /\* text=auto eol=lf/);
  assert.match(ga, /\.sh\s+text eol=lf/);
  assert.match(ga, /\.ttf\s+binary/);
});

test('忽略策略：2.4G 构建缓存被排除，但打包图标放行', () => {
  const gi = readRel('.gitignore');
  assert.match(gi, /claude-desktop\/build\/\*/);
  assert.match(gi, /!claude-desktop\/build\/icon\.png/);
  assert.ok(fs.existsSync(path.join(ROOT, 'claude-desktop', 'build', 'icon.png')), 'icon.png 必须存在，否则克隆后打包失败');
});
