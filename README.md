# ClaudeVM

在 Windows 上一键拉起一个**隔离的 Linux 桌面环境**，里面预装 Chrome 与 Claude Code，
并强制所有出网流量经代理（fail-closed：代理断开即断网，不会回落到直连）。

- **WSLg 模式（默认）**：Claude Code / 终端以原生窗口出现，不经过浏览器。
- **desktop 模式**：TigerVNC + websockify + noVNC 串流，只监听 `127.0.0.1`，
  用于 WSLg 不可用的机器（如部分 Win10 / 远程桌面场景）。

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `claude-desktop/` | Electron 桌面端：启动/停止、配置、自检、双显示模式、打包 |
| `claude-vm/` | Linux 运行时：Dockerfile、entrypoint、Rime 输入法、Openbox、网络守卫 |
| `build/` | 构建与排障脚本（产物与日志已由 `.gitignore` 排除） |
| `docs/` | 方案调研存档 |
| `开发交接.md` | 完整开发交接：架构、约束、踩过的坑（**建议先看这个**） |

## 构建桌面端

```bash
cd claude-desktop
npm install
npm run dist:win     # Windows（NSIS 安装包）
npm run dist:mac     # macOS（dmg，必须在 Mac 上执行）
```

产物：`claude-desktop/dist/ClaudeVM-Setup-<version>-x64.exe`（Windows）。
macOS 上未签名的 dmg 首次打开需右键 →「打开」绕过 Gatekeeper。

## 运行时镜像

`rootfs.tar.gz`（约 620 MB）**不在仓库里**。它由 `claude-vm/vm/Dockerfile` 构建后导出，
应用首次启动时导入为运行时：Windows 上是名为 `claude-vm` 的 **WSL2 发行版**，
macOS 上是 **Docker / OrbStack 容器**（`docker import`，Apple Silicon 靠 Rosetta 跑 amd64）。
构建与导出方法见 [`开发交接.md`](开发交接.md) 第 2 节；macOS 细节见第 9 节。

## 安全边界

- 网络熔断：删除默认路由，只保留通往代理的主机路由；代理不可用时保持断网。
- noVNC 只监听回环地址，不暴露到局域网。
- 宿主工作区通过 `/mnt` 挂载，登录态保存在虚拟磁盘内。

## 文档

- [开发交接.md](开发交接.md) — 架构、约束、已知边界、踩坑记录
- [tests/README.md](tests/README.md) — 测试体系：分层、坑→测试映射、发版 checklist
- [claude-desktop/README.md](claude-desktop/README.md) — 应用侧功能与各版本修复说明
- [claude-vm/README.md](claude-vm/README.md) — 早期 Docker 方案存档

## 测试

```bash
node --test "tests/**/*.test.js"          # 全部（含 WSL 集成）
node --test "tests/unit/*.test.js" "tests/static/*.test.js"   # 快速层（无副作用）
```

单元（mock WSL）+ 静态一致性（两侧脚本逐字节比对）+ 集成（net-guard 锁定/解锁往返实测），详见 [tests/README.md](tests/README.md)。

## License

MIT
