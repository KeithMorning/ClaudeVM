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
const { ROOT, MAIN_SRC, readRel, existsRel, loadSegment } = require('../loader');

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

test('坑 14：输入法段位于 DISPLAY=:1 之后（注册到错误 X server）', () => {
  const s = ep();
  const inputSection = s.indexOf('# 2.45) 中文输入法');
  const displayExport = s.indexOf('export DISPLAY=:1');
  assert.ok(inputSection > 0, '找不到输入法段标记 # 2.45)');
  assert.ok(displayExport > 0, '找不到 export DISPLAY=:1');
  assert.ok(inputSection > displayExport, '输入法服务必须在 DISPLAY 确定后启动，否则注册到 WSLg :0');
});

test('坑 14：Chrome 启动前清理 SingletonLock（Profile 被别的主机占用）', () => {
  assert.match(ep(), /SingletonLock/, 'entrypoint 桌面启动段应清陈旧 Chrome 锁');
  const chrome = readRel('claude-vm/vm/scripts/chrome-login.sh');
  assert.match(chrome, /SingletonLock/, 'chrome-login.sh 也要清（桌面图标路径）');
});

test('坑 14：desktop-guard 自愈清单覆盖四个组件', () => {
  const g = readRel('claude-vm/vm/scripts/desktop-guard.sh');
  for (const k of ['Xtigervnc', 'openbox', 'websockify', 'fcitx5-remote']) {
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


test('坑 16：终端启动器走 GTK 原生输入（不再用 xterm / XIM 资源）', () => {
  for (const f of ['run-terminal.sh', 'run-claude.sh']) {
    const src = readRel(`claude-vm/vm/scripts/${f}`);
    // 只检查可执行行：注释里会保留 XIM 的历史说明，不该被当成残留资源
    const code = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.match(code, /exec lxterminal/, `${f} 应使用 lxterminal`);
    assert.match(code, /--no-remote/, `${f} 应禁用实例复用`);
    assert.doesNotMatch(code, /exec xterm|XTerm\*inputMethod|preeditType/, `${f} 不应残留 XIM 资源`);
  }
});

test('坑 16：rime-setup 按需装 GTK 输入模块与终端（1.0.34 起 fcitx5）', () => {
  const src = readRel('claude-vm/vm/scripts/rime-setup.sh');
  for (const k of ['fcitx5', 'fcitx5-rime', 'fcitx5-frontend-gtk3', 'lxterminal', 'im-fcitx5.so']) {
    assert.ok(src.includes(k), `rime-setup.sh 缺少 ${k}`);
  }
  assert.match(src, /--no-install-recommends/, '不能带进中文字体包（checkcc 字体名单）');
});

test('坑 16：entrypoint 部署 lxterminal 配色配置', () => {
  const src = readRel('claude-vm/vm/scripts/entrypoint.sh');
  assert.match(src, /cp -f \/opt\/config\/lxterminal\.conf ~\/\.config\/lxterminal\//);
});

test('坑 16：自检先查 GTK im module，缺了要给出明确提示', () => {
  const src = readRel('claude-vm/vm/scripts/check-env.sh');
  assert.ok(src.includes('im-fcitx5.so'), '自检应检查 GTK 原生模块');
  assert.ok(src.includes('缺 GTK 输入模块'), '缺失时提示要具体，不能只说服务未就绪');
});

// ---------- 输入法壳换 fcitx5（1.0.34） ----------

test('坑 18：fcitx5 依赖 D-Bus 会话，entrypoint 必须显式起总线', () => {
  const s = ep();
  assert.match(s, /DBUS_SESSION_BUS_ADDRESS/, 'entrypoint 应管理 D-Bus 会话地址');
  assert.match(s, /dbus-launch|dbus-daemon/, '应显式启动 session bus（fcitx5 不能 autolaunch）');
  assert.match(s, /fcitx5-remote/, '就绪探测用 fcitx5-remote（XIM atom 已不适用）');
  assert.match(s, /GTK_IM_MODULE="fcitx"/, 'GTK_IM_MODULE 应指向 fcitx');
});

test('坑 18：fcitx5 启动后必须激活并切 rime（否则按键透传成 ASCII）', () => {
  const s = ep();
  assert.match(s, /fcitx5-remote -o/, '必须显式激活输入法（默认可能是关闭态）');
  assert.match(s, /fcitx5-remote -s rime/, '必须切到 rime 引擎');
});

test('坑 18：D-Bus 就绪必须早于 desktop-guard（guard 探活走 fcitx5-remote）', () => {
  const s = ep();
  const dbusIdx = s.indexOf('export DBUS_SESSION_BUS_ADDRESS');
  const guardIdx = s.indexOf('nohup /opt/scripts/desktop-guard.sh');
  assert.ok(dbusIdx > 0 && guardIdx > 0, '找不到 D-Bus 导出或 guard 启动标记');
  assert.ok(dbusIdx < guardIdx,
    'D-Bus 导出必须在 guard 启动之前，否则 guard 的 fcitx5-remote 永远失败、4 秒一轮杀掉 fcitx5');
});

test('坑 18：万象词库部署在 fcitx5-rime 数据目录，老 ibus 数据可迁移', () => {
  const src = readRel('claude-vm/vm/scripts/rime-setup.sh');
  assert.match(src, /RIME_DIR=\/root\/\.local\/share\/fcitx5\/rime/,
    'fcitx5-rime 的用户数据目录是 ~/.local/share/fcitx5/rime');
  assert.match(src, /OLD_RIME_DIR/, '应迁移 ibus 时代的词库，不能让用户重新编译 146MB');
  assert.match(src, /config\/fcitx5\/profile/, '默认引擎 rime 要写进 fcitx5 profile');
});

// ---------- 平台抽象（1.0.32 起支持 macOS） ----------

test('平台抽象：差异收敛在 vm-backend，main.js 不直接 spawn wsl.exe', () => {
  assert.ok(MAIN_SRC.includes("require('./lib/vm-backend').getBackend()"),
    'main.js 必须绑定 getBackend() 实例 —— 只 require 模块拿不到方法，调用即 TypeError（1.0.32 启动回归的根因）');
  assert.ok(existsRel('claude-desktop/app/lib/vm-backend.js'), 'vm-backend.js 必须存在');
  assert.doesNotMatch(MAIN_SRC, /spawn\('wsl\.exe'/, 'spawn 应走 backend.spawnEntry');
  const vb = readRel('claude-desktop/app/lib/vm-backend.js');
  for (const k of ['pickBackendId', 'createContainerBackend', 'createWslBackend', 'getBackend']) {
    assert.ok(vb.includes(k), `vm-backend.js 缺少 ${k}`);
  }
});

test('平台抽象：容器模式 noVNC 发布到 0.0.0.0（websockify 绑回环会连不上）', () => {
  const vb = readRel('claude-desktop/app/lib/vm-backend.js');
  assert.match(vb, /NOVNC_BIND: '0\.0\.0\.0'/);
  assert.match(ep(), /\$\{NOVNC_BIND:-127\.0\.0\.1\}/, 'entrypoint 必须尊重 NOVNC_BIND');
});

test('工程基本面：dist:mac 构建入口存在（macOS 支持）', () => {
  const pkg = JSON.parse(readRel('claude-desktop/package.json'));
  assert.ok(pkg.scripts['dist:mac'], '必须有 dist:mac');
});

test('坑 17：entrypoint 必须重设 XDG_RUNTIME_DIR（WSLg 目录属主不匹配会卡死 GTK）', () => {
  const s = ep();
  assert.match(s, /export XDG_RUNTIME_DIR=\/tmp\/claude-vm-runtime/,
    'root 会话必须用自己属主的运行时目录，否则 GTK3 应用窗口永不出现');
  assert.match(s, /chmod 700 "\$XDG_RUNTIME_DIR"/);
  assert.match(s, /echo "export XDG_RUNTIME_DIR=/, '落盘 runtime-env 供菜单启动的应用继承');
});

// ---------- 候选窗字形（1.0.35） ----------

test('坑 19：rime-setup 必须装覆盖 CJK 扩展 B 区的字体（否则候选窗画方框）', () => {
  const s = readRel('claude-vm/vm/scripts/rime-setup.sh');
  // 只检查可执行行：注释里会解释「为什么禁用 fonts-noto-cjk-extra」，不该被当成实际安装
  const code = s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.match(code, /fonts-hanazono/, '缺了它 U+20000+ 生僻候选无字形');
  assert.match(code, /fc-list ':charset=20000'/, 'need 检查应按「码位有没有字体覆盖」判定');
  assert.match(code, /fc-cache -f/, '装完必须刷新 fontconfig 缓存');
  assert.doesNotMatch(code, /fonts-noto-cjk-extra/,
    '214MB 且家族名 "Noto Sans CJK SC/TC" 命中 checkcc 名单，不能用');
});

test('坑 19：自检字体名单未因新增字体而放松', () => {
  const s = readRel('claude-vm/vm/scripts/check-env.sh');
  assert.ok(s.includes('Noto Sans CJK SC') && s.includes('WenQuanYi Micro Hei'),
    '指纹名单必须保持完整，换字体不能靠删名单蒙混');
  assert.doesNotMatch(s, /Hanazono|HanaMin|花園明朝/, '自检不该把合规字体误列入名单');
});
