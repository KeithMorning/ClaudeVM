#!/usr/bin/env node
'use strict';
// 把 claude-vm/vm/scripts（唯一真源）同步到 claude-desktop/runtime/scripts（打包用的副本）。
//
// 为什么需要这个脚本：应用运行时读的是 runtime/scripts，而平时改的是 vm/scripts。
// 两边一分叉，改了脚本却"没生效"，排查成本极高（症状是虚拟机里跑的还是旧逻辑）。
// 所以 start / dist 之前都强制同步一次。
//
// 同样的坑也存在于"界面资源"：串流页 desktop.html、欢迎页这些在 rootfs 里有一份，
// 改了源码但镜像还是旧的，打包出去的就是旧页面。所以这里一并把它们同步到
// runtime/assets，运行时由 entrypoint 覆盖进镜像，不再依赖重建 rootfs。
const fs = require('fs');
const path = require('path');

const here = __dirname;
const VM = path.resolve(here, '..', '..', 'claude-vm', 'vm');
const SRC = path.join(VM, 'scripts');
const DST = path.resolve(here, '..', 'runtime', 'scripts');
const ASSET_DST = path.resolve(here, '..', 'runtime', 'assets');

// 源码路径（相对 claude-vm/vm）→ assets 内目标路径
const ASSETS = [
  ['config/novnc/desktop.html', 'novnc/desktop.html'],
  ['config/welcome/index.html', 'welcome/index.html'],
  // 中文字体（家族名不在 checkcc 的指纹名单里），让中文页面不再是豆腐块。
  // TC 负责繁体笔形：SC 显示繁体字时笔形偏简，和台北画像不搭。
  ['assets/fonts/NotoSansSC.ttf', 'fonts/NotoSansSC.ttf'],
  ['assets/fonts/NotoSansTC.ttf', 'fonts/NotoSansTC.ttf'],
  // 万象拼音 Pure 版词库（CC BY 4.0，离线打包，首启解压，不依赖 GitHub 可达性）
  ['assets/rime/wanxiang-pure.zip', 'rime/wanxiang-pure.zip'],
  // Openbox 鼠标绑定：补齐标题栏 CloseButton 等 context，串流桌面里 ✕ 才点得动。
  // 走 assets 同步（entrypoint 优先读它），不必重建 rootfs。
  ['config/openbox-rc.xml', 'config/openbox-rc.xml'],
];

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`[sync-scripts] 找不到源目录：${SRC}`);
    process.exit(1);
  }
  fs.mkdirSync(DST, { recursive: true });

  let n = 0;
  for (const name of fs.readdirSync(SRC)) {
    const s = path.join(SRC, name);
    if (!fs.statSync(s).isFile()) continue;
    const d = path.join(DST, name);
    fs.copyFileSync(s, d);
    // 保持可执行位（Windows 上无意义，但打包到 mac/linux 时有用）
    try { fs.chmodSync(d, 0o755); } catch {}
    n++;
  }

  // 源里已删除、副本里还留着的文件，一并清掉，避免残留脚本被同步进虚拟机
  for (const name of fs.readdirSync(DST)) {
    if (!fs.existsSync(path.join(SRC, name))) {
      try { fs.unlinkSync(path.join(DST, name)); console.log(`[sync-scripts] 移除残留 ${name}`); } catch {}
    }
  }
  console.log(`[sync-scripts] 已同步 ${n} 个脚本 → ${DST}`);

  // 界面资源（会被 entrypoint 覆盖进 /usr/share/novnc 等位置）
  let a = 0;
  for (const [from, to] of ASSETS) {
    const s = path.join(VM, from);
    if (!fs.existsSync(s)) { console.warn(`[sync-scripts] 缺少资源 ${from}`); continue; }
    const d = path.join(ASSET_DST, to);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
    a++;
  }
  console.log(`[sync-scripts] 已同步 ${a} 个界面资源 → ${ASSET_DST}`);
}

main();
