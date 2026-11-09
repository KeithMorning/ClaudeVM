'use strict';
// vm-backend.js —— 虚拟机后端抽象（无 Electron 依赖，单元测试可直接 require）
//
// Windows：WSL2（wsl.exe），发行版由 rootfs.tar.gz 用 wsl --import 导入。
// macOS / Linux：容器（docker / podman CLI），同一个 rootfs.tar.gz 直接 docker import 成镜像。
//   为什么是容器而不是 Lima/虚拟机：
//   1) rootfs.tar.gz 零格式转换就能成镜像（Lima 需要先做成可引导磁盘，Mac 本地没有 ext4 工具链）；
//   2) Apple Silicon 上 Docker Desktop / OrbStack 用 Rosetta 跑 amd64 镜像，不用等 arm64 重建；
//   3) entrypoint 本来就是按容器 entrypoint 设计的（项目源自 Docker + noVNC 方案）。
// main.js 只依赖这里导出的接口；平台差异不允许泄漏回主进程。
//
// 容器模型的关键决定：
// - 实例的 PID1 是 `sleep infinity`（--init 由 tini 收信号），entrypoint 走 `docker exec` 拉起。
//   这样每次启动都能带**新的**环境变量（代理/时区/工作区随配置变），不必重建容器；
//   而且容器空闲时也能 exec 同步脚本（syncScripts 在 spawn 之前跑，需要 guest 可执行）。
// - /root 挂命名卷 claudevm-home：重建容器不丢凭据 / Chrome 配置 / Rime 词库（对齐 WSL
//   「terminate 不丢发行版磁盘」的语义）。
// - 工作区靠挂载 /Users 与 /Volumes 覆盖，换工作区不用重建容器。

const { execFile, spawn } = require('child_process');

const DISTRO = 'claude-vm';            // WSL 发行版名
const IMAGE = 'claude-vm:runtime';     // 容器镜像名
const CONTAINER = 'claude-vm';         // 容器名
const HOME_VOLUME = 'claudevm-home';   // /root 持久卷
const GUEST_ARCH = 'linux/amd64';      // rootfs 是 amd64（Apple Silicon 靠 Rosetta 跑）

// 容器内的挂载点（guest 侧固定路径）
const MOUNT = {
  syncScripts: '/mnt/sync-scripts',
  syncAssets: '/mnt/sync-assets',
  hostUsers: '/mnt/host-users',
  hostVolumes: '/mnt/host-volumes',
};

// ---------- 纯函数（可单测） ----------

// 平台 → 后端 id。win32 一律 wsl（probe 负责报「没装 WSL」的安装指引），
// 其余平台走容器（probe 负责报「没装 Docker/OrbStack」）。
function pickBackendId(platform) {
  return platform === 'win32' ? 'wsl' : 'container';
}

// 宿主路径 → 容器内路径。只覆盖 /Users 与 /Volumes（Docker Desktop / OrbStack
// 在 macOS 上默认共享这两个前缀）；其它位置返回 null，由调用方报错而不是猜。
function guestWorkspacePathFor(p) {
  const s = String(p || '').replace(/\\/g, '/');
  for (const [prefix, mount] of [
    ['/Users/', MOUNT.hostUsers + '/'],
    ['/Volumes/', MOUNT.hostVolumes + '/'],
  ]) {
    if (s.startsWith(prefix)) return mount + s.slice(prefix.length);
  }
  return null;
}

// docker create 的参数（纯函数，便于单测锁定行为）
function buildCreateArgs(o) {
  return [
    'create',
    '--name', o.container || CONTAINER,
    '--init',                              // tini 做 PID1，docker stop 的 SIGTERM 能传导
    '--hostname', o.container || CONTAINER,
    '--platform', GUEST_ARCH,
    '--shm-size=1g',                       // Chrome 需要大 /dev/shm，否则随机崩
    '--cap-add', 'NET_ADMIN',              // net-guard 熔断要 netlink 删路由
    '-p', `127.0.0.1:${o.novncPort || 6080}:6080`,
    '-v', `${o.homeVolume || HOME_VOLUME}:/root`,
    '-v', '/Users:' + MOUNT.hostUsers,
    '-v', '/Volumes:' + MOUNT.hostVolumes,
    ...(o.scriptsDir ? ['-v', `${o.scriptsDir}:${MOUNT.syncScripts}:ro`] : []),
    ...(o.assetsDir ? ['-v', `${o.assetsDir}:${MOUNT.syncAssets}:ro`] : []),
    '--label', `claudevm.spec=${o.specHash || ''}`,
    o.image || IMAGE,
    'sleep', 'infinity',
  ];
}

// 容器实例的「规格指纹」：挂载源变了（应用换了安装目录）必须重建实例
function specHashFor(scriptsDir, assetsDir) {
  return `${scriptsDir || ''}|${assetsDir || ''}`;
}

// ---------- 通用执行 ----------

function execFileP(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 1024 * 1024 * 32, ...opts },
      (err, stdout, stderr) => resolve({
        ok: !err,
        code: err && (err.code || (err.status != null ? err.status : '')),
        stdout: stdout || '',
        stderr: stderr || '',
      }));
  });
}

// ---------- WSL2 后端（Windows） ----------

function createWslBackend() {
  const wsl = (args, opts) => execFileP('wsl.exe', args, { windowsHide: true, ...opts });

  const HELP = [
    '本程序需要 WSL2（Windows 自带的轻量 Linux 运行时），当前系统上不可用。',
    '',
    '修复步骤（任选其一）：',
    '  1) 以管理员身份打开 PowerShell，执行：wsl --install',
    '     完成后重启电脑，再回到本程序点「启动虚拟环境」。',
    '  2) 若已装过 WSL：执行 wsl --update 更新内核；',
    '     并在「启用或关闭 Windows 功能」里勾选',
    '     「适用于 Linux 的 Windows 子系统」和「虚拟机平台」。',
    '  3) 若提示虚拟化未开启：进 BIOS 打开 Intel VT-x / AMD-V（SVM）。',
  ].join('\n');

  return {
    id: 'wsl',
    help: HELP,

    async probe() {
      const st = await wsl(['--status']);
      const blob = st.stdout + st.stderr;
      if (!st.ok && String(st.code) === 'ENOENT') return { ok: false, error: HELP };
      const l = await wsl(['-l', '-q']);
      if (!l.ok) {
        const detail = (l.stderr || l.stdout || blob).replace(/\0/g, '').trim();
        return { ok: false, error: `${HELP}\n\n（WSL 返回：${detail.slice(0, 300)}）` };
      }
      return { ok: true };
    },

    // guest 内执行：argv 形如 ['bash', '-c', sh]
    runGuest(argv, opts) {
      return wsl(['-d', DISTRO, '-u', 'root', '--', ...argv], opts);
    },

    async imageExists() {
      try {
        const r = await wsl(['-l', '-q']);
        return r.stdout.replace(/\0/g, '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
          .some((n) => n.toLowerCase() === DISTRO.toLowerCase());
      } catch { return false; }
    },

    async ensureImage(rootfs, opts = {}) {
      if (await this.imageExists()) return { ok: true, imported: false };
      const probe = await this.probe();
      if (!probe.ok) return { ok: false, error: probe.error };
      const fs = require('fs');
      if (!fs.existsSync(rootfs)) {
        return { ok: false, error: `找不到运行时镜像：${rootfs}\n（打包版应内置 resources/rootfs.tar.gz）` };
      }
      fs.mkdirSync(opts.dataDir, { recursive: true });
      opts.onProgress && opts.onProgress('首次运行：正在导入 Linux 运行时（约 1~2 分钟，请勿关闭窗口）…');
      const r = await wsl(['--import', DISTRO, opts.dataDir, rootfs, '--version', '2']);
      if (!r.ok) {
        const detail = (r.stderr || r.stdout || '').replace(/\0/g, '').trim();
        return {
          ok: false,
          error: [
            '导入 Linux 运行时失败。',
            `目标目录：${opts.dataDir}`,
            '',
            '常见原因：',
            '  · 磁盘空间不足（需要约 3 GB）',
            '  · 该目录被杀软/安全软件拦截',
            '  · WSL2 尚未启用（见下方提示）',
            '',
            `原始错误：${detail.slice(0, 400)}`,
            '',
            HELP,
          ].join('\n'),
        };
      }
      return { ok: true, imported: true };
    },

    spawnEntry(env) {
      const pairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
      return spawn('wsl.exe',
        ['-d', DISTRO, '-u', 'root', '--', 'env', ...pairs, '/opt/scripts/entrypoint.sh'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    },

    async stopAll() {
      await wsl(['--terminate', DISTRO]);
    },

    async diagInfo() {
      const r = await wsl(['-l', '-v'], { timeout: 20000 });
      return String(r.stdout || r.stderr || '').replace(/\0/g, '').trim();
    },

    guestScriptsPath(dir) { return toWslPathLike(dir); },
    guestAssetsPath(dir) { return toWslPathLike(dir); },
    guestWorkspacePath(p) { return toWslPathLike(p); },

    extraHostCandidates() { return []; },

    hostPortOwner(port) {
      return new Promise((resolve) => {
        execFile('netstat', ['-ano'], { windowsHide: true, maxBuffer: 1024 * 1024 * 8 }, (err, out) => {
          if (err) return resolve(null);
          const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i');
          const line = String(out).split(/\r?\n/).find((l) => re.test(l));
          if (!line) return resolve(null);
          const pid = re.exec(line)[1];
          execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true },
            (e2, o2) => {
              const name = (String(o2 || '').match(/^"([^"]+)"/) || [])[1] || '未知进程';
              resolve({ pid, name, line: line.trim() });
            });
        });
      });
    },
  };
}

// Windows 路径 -> WSL 内 /mnt/x/...（与 main.js 的 toWslPath 同语义，这里独立一份
// 是为了让后端自包含；改动时两边都要改，tests/static 有断言兜底）
function toWslPathLike(p) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(s);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
  return s;
}

// ---------- 容器后端（macOS / Linux） ----------

function createContainerBackend() {
  let cliCache = null; // 'docker' | 'podman' | null

  async function cli() {
    if (cliCache !== undefined && cliCache !== null) return cliCache;
    for (const c of ['docker', 'podman']) {
      const r = await execFileP(c, ['version', '--format', '{{.Client.Version}}'], { timeout: 8000 });
      if (r.ok) { cliCache = c; return c; }
    }
    cliCache = null;
    return null;
  }

  const HELP = [
    '本程序需要一个 Linux 容器运行时（Docker Desktop 或 OrbStack），当前系统上不可用。',
    '',
    '修复步骤（任选其一）：',
    '  1) 安装 OrbStack（推荐，轻量）：brew install --cask orbstack',
    '  2) 或安装 Docker Desktop：brew install --cask docker',
    '     安装后启动它一次，完成初始化。',
    '  3) Apple Silicon（M 系列）请在设置里启用',
    '     「Use Rosetta for x86_64/amd64 emulation」——运行时镜像是 amd64 的。',
    '',
    '装好后回到这里重新点「启动虚拟环境」。',
  ].join('\n');

  const sh = (argv, opts) => execFileP(cliCache || 'docker', argv, opts);

  return {
    id: 'container',
    help: HELP,

    async probe() {
      const c = await cli();
      if (!c) return { ok: false, error: HELP };
      // 装了 CLI 但守护进程没起（Docker Desktop 没开）也要说清楚
      const r = await execFileP(c, ['info', '--format', '{{.ServerVersion}}'], { timeout: 10000 });
      if (!r.ok) {
        return {
          ok: false,
          error: `${HELP}\n\n（${c} 已安装但守护进程未响应，请先启动 Docker Desktop / OrbStack）`,
        };
      }
      return { ok: true };
    },

    runGuest(argv, opts) {
      return sh(['exec', '-i', CONTAINER, ...argv], opts);
    },

    async imageExists() {
      const c = await cli();
      if (!c) return false;
      const r = await execFileP(c, ['container', 'inspect', CONTAINER], { timeout: 10000 });
      return r.ok;
    },

    async ensureImage(rootfs, opts = {}) {
      const c = await cli();
      if (!c) return { ok: false, error: HELP };
      const probe = await this.probe();
      if (!probe.ok) return { ok: false, error: probe.error };

      const fs = require('fs');
      // 1) 镜像：没有就 docker import（rootfs.tar.gz 直接进，零格式转换）
      const img = await execFileP(c, ['image', 'inspect', IMAGE], { timeout: 10000 });
      if (!img.ok) {
        if (!fs.existsSync(rootfs)) {
          return { ok: false, error: `找不到运行时镜像：${rootfs}\n（打包版应内置 resources/rootfs.tar.gz）` };
        }
        opts.onProgress && opts.onProgress('首次运行：正在导入 Linux 运行时镜像（约 1~2 分钟，请勿关闭窗口）…');
        const r = await execFileP(c, ['import', '--platform', GUEST_ARCH, rootfs, IMAGE],
          { timeout: 10 * 60 * 1000 });
        if (!r.ok) {
          return {
            ok: false,
            error: [
              '导入 Linux 运行时镜像失败。',
              '',
              '常见原因：',
              '  · 磁盘空间不足（需要约 3 GB）',
              '  · Docker Desktop / OrbStack 未正常运行',
              '',
              `原始错误：${(r.stderr || r.stdout || '').trim().slice(0, 400)}`,
            ].join('\n'),
          };
        }
      }

      // 2) 实例：挂载源（脚本/资源目录）变了必须重建；/root 在命名卷上，重建不丢状态
      const spec = specHashFor(opts.scriptsDir, opts.assetsDir);
      const insp = await execFileP(c, ['container', 'inspect',
        '--format', '{{ index .Config.Labels "claudevm.spec" }}', CONTAINER], { timeout: 10000 });
      const cur = insp.ok ? String(insp.stdout || '').trim() : null;
      if (insp.ok && cur !== spec) {
        opts.onProgress && opts.onProgress('运行时脚本目录有变化，重建实例…');
        await execFileP(c, ['rm', '-f', CONTAINER], { timeout: 30000 });
      }
      if (!(await this.imageExists())) {
        const args = buildCreateArgs({
          scriptsDir: opts.scriptsDir,
          assetsDir: opts.assetsDir,
          novncPort: opts.novncPort || 6080,
          specHash: spec,
        });
        const r = await sh(args, { timeout: 60000 });
        if (!r.ok) {
          return {
            ok: false,
            error: `创建容器实例失败：${(r.stderr || r.stdout || '').trim().slice(0, 400)}`,
          };
        }
      }

      // 3) 拉起空闲实例（PID1 = sleep infinity；entrypoint 稍后由 spawnEntry exec 进去）
      const st = await execFileP(c, ['inspect', '--format', '{{.State.Running}}', CONTAINER],
        { timeout: 10000 });
      if (!st.ok || String(st.stdout).trim() !== 'true') {
        const r = await sh(['start', CONTAINER], { timeout: 60000 });
        if (!r.ok) {
          return { ok: false, error: `启动容器失败：${(r.stderr || r.stdout || '').trim().slice(0, 400)}` };
        }
      }
      return { ok: true, imported: true };
    },

    spawnEntry(env) {
      // NOVNC_BIND 必须 0.0.0.0：websockify 监听容器回环的话，端口发布到宿主会连不上
      const full = { ...env, NOVNC_BIND: '0.0.0.0' };
      const envArgs = Object.entries(full).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      return spawn(cliCache || 'docker',
        ['exec', '-i', ...envArgs, CONTAINER, '/opt/scripts/entrypoint.sh'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    },

    async stopAll() {
      const c = cliCache || 'docker';
      // -t 8：给 entrypoint 收尾留时间；容器与 /root 卷保留（对齐 wsl --terminate 语义）
      await execFileP(c, ['stop', '-t', '8', CONTAINER], { timeout: 30000 });
    },

    async diagInfo() {
      const c = cliCache || 'docker';
      const ps = await execFileP(c, ['ps', '-a', '--filter', `name=${CONTAINER}`,
        '--format', '{{.Names}}  {{.Status}}  {{.Image}}'], { timeout: 15000 });
      const img = await execFileP(c, ['images', IMAGE, '--format', '{{.Repository}}:{{.Tag}}  {{.Size}}'],
        { timeout: 15000 });
      return `实例：${(ps.stdout || '(无)').trim()}\n镜像：${(img.stdout || '(无)').trim()}`;
    },

    guestScriptsPath() { return MOUNT.syncScripts; },
    guestAssetsPath() { return MOUNT.syncAssets; },
    guestWorkspacePath(p) { return guestWorkspacePathFor(p); },

    extraHostCandidates() {
      // Docker Desktop 与 OrbStack 都提供宿主别名；真实 TCP 探测会把关，解析不了自然过滤
      return ['host.docker.internal', 'host.orb.internal'];
    },

    hostPortOwner(port) {
      return new Promise((resolve) => {
        execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { maxBuffer: 1024 * 1024 },
          (err, out) => {
            const pid = String(out || '').split('\n').filter(Boolean)[0];
            if (err || !pid) return resolve(null);
            execFile('ps', ['-p', pid, '-o', 'comm='], {}, (e2, o2) => {
              resolve({ pid, name: String(o2 || '').trim() || '未知进程', line: `lsof :${port}` });
            });
          });
      });
    },
  };
}

// ---------- 选择入口 ----------

let singleton = null;
function getBackend(platform = process.platform) {
  if (!singleton) {
    singleton = pickBackendId(platform) === 'wsl' ? createWslBackend() : createContainerBackend();
  }
  return singleton;
}

module.exports = {
  DISTRO, IMAGE, CONTAINER, HOME_VOLUME, MOUNT, GUEST_ARCH,
  pickBackendId,
  guestWorkspacePathFor,
  buildCreateArgs,
  specHashFor,
  getBackend,
};
