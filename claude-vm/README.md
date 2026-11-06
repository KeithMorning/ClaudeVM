# Claude VM — 本地虚拟环境串流 Claude Code

> **本文档是早期 Docker + noVNC 方案的存档（1.0.20 之前）。**
> 现行实现对 Windows 走 **WSL 导入 + WSLg 原生窗口**，主路径不再经过浏览器串流，
> Docker 只用于构建期生成 rootfs。当前架构、已知边界与开发约束见仓库根目录的
> `开发交接.md` 与 `claude-desktop/README.md`；本文保留用于理解「为什么最后没走容器这条路」。

按你描述的架构实现：**用户在自己电脑上装一个本地程序 → 程序在本机拉起一个虚拟环境容器 →
容器里跑桌面 + Chrome + Claude Code + noVNC 流服务 → 流服务在 localhost，访问无网速限制 →
文件通过挂载的本地目录（工作区）和主机互通 → 可配白名单代理让 Claude 流量统一出口 →
用 check-cc 的风险维度逐一校对本地环境。**

```
┌──────────────────────────────────────────────────────────────┐
│ 用户电脑（本机）                                                │
│                                                                │
│  本地程序(claude-vm client)                                     │
│     │ docker run（挂载工作区 + 注入地区/代理）                   │
│     ▼                                                          │
│  ┌──────────── 虚拟环境容器 (claude-vm) ──────────────┐        │
│  │  Xfce 桌面                                              │        │
│  │   ├─ Chrome (Login)  ← 经本地 router 走代理，登录 claude.ai │
│  │   └─ 终端: claude  ← 经本地 router，仅 Anthropic 流量走代理 │
│  │  本地 router :7890（白名单分流：Anthropic→代理 / 其余直连） │
│  │  noVNC 流服务 :6080  ── localhost 串流 ──┐            │        │
│  │  /workspace  ←── 挂载 ──┘  ~/claude-workspace          │        │
│  └────────────────────────────────────────────┘            │
│                                                │             │
│  浏览器 http://localhost:6080  ◀──────────────┘  (无网速限制) │
└──────────────────────────────────────────────────────────────┘
```

> 确认架构：**"我们的虚拟环境" = 我们提供的容器镜像 + 本地客户端，安装包跑在用户自己机器上**
> （所以流是 localhost，没有网速限制；工作区是宿主本地目录）。

---

## 1. 构建虚拟环境镜像

```bash
cd claude-vm/client
docker build -t claude-vm:latest ../vm
```

镜像内含：Xfce 桌面、TigerVNC + noVNC 流服务、Google Chrome（真实 UA）、
Node20 + Claude Code CLI、地区语言环境、`check-env.sh` 校对脚本。

## 2. 安装本地客户端

```bash
cd claude-vm/client
npm install
# 可选：全局安装
npm link      # 之后可直接 `claude-vm start`
```

## 3. 启动（在本机）

```bash
node index.js start \
  --workspace ~/claude-workspace \
  --region us-east \
  --proxy http://代理host:端口
```

- 自动 `docker run` 起容器，映射 `localhost:6080`（noVNC）。
- 自动打开本地控制台 `http://localhost:7654`（内嵌桌面流 + 校对按钮）。
- 也可直接浏览器开 `http://localhost:6080/vnc.html?autoconnect=true&password=claudevm`。

无代理时省略 `--proxy`；有合规地区代理时务必带上，使 Claude API 与 Chrome 登录出口一致。

## 4. 在虚拟环境里用 Claude

1. 桌面里点 **Chrome (Login)** 图标 → 打开 claude.ai → 用 Pro/Max 登录
   （Chrome 已自动走你配置的代理，出口 IP 与 API 一致）。
2. 打开终端，运行 `claude` → 复用已登录态（或 `export ANTHROPIC_API_KEY=...`）。
3. 文件读写直接放 `/workspace`，对应宿主 `~/claude-workspace`。

## 5. 白名单代理说明（仅 Anthropic 流量走代理）

`--proxy http://host:port` 注入容器后，机制是 **「容器内本地 router + 白名单」**：

1. 容器内起一个本地转发代理 `proxy-router.js`（监听 `127.0.0.1:7890`）。
2. Claude Code 的 `HTTPS_PROXY` 和 Chrome 的 `--proxy-server` 都指向这个本地 router。
3. router 按域名白名单分流：
   - **命中白名单**（默认 `.anthropic.com`、`.claude.ai`、`.claudeusercontent.com`）
     → 经你提供的上游代理 `UPSTREAM_PROXY` 出站（API / 登录 / 控制台全走代理）。
   - **未命中** → 直连（容器本机出口，不经代理）。

这样做到：
- **Anthropic 的全部流量都走代理**（API 请求、OAuth 登录、控制台、telemetry 等，只要域名属于
  Anthropic 系就命中白名单），登录出口 = API 出口，满足 check-cc 一致性。
- 非 Anthropic 流量（如 Chrome 自身更新、其他网站）直连，不浪费代理也不暴露。

可用 `--whitelist` 覆盖默认白名单，例如：
`--whitelist ".anthropic.com,.claude.ai,.claudeusercontent.com,platform.claude.com"`。

> 注意：Claude Code 官方**不支持 SOCKS 代理**，`--proxy` 必须是 HTTP(S) 代理。

## 6. 用 check-cc 维度校对

控制台点 **“运行自检”**，执行容器内 `check-env.sh`，逐维输出：

| 维度 | 做法 |
|------|------|
| 系统时区 | `--region` 决定 `TZ`，与代理地区一致 |
| 语言/Locale | `LANG`/`LC_ALL` = 地区语言（如 `en_US.UTF-8`） |
| Intl Locale | Node 运行时 locale，由镜像 locale 决定 |
| 浏览器 UA | 真实 Google Chrome，非 WebView/headless |
| 运行容器 | 真实 X 桌面会话（`DISPLAY` 存在） |
| 网络出口 | 白名单 router 已启用 → Claude + Chrome 同出口 |
| 代理路由 | 非白名单流量直连(无泄漏) + api.anthropic.com 经代理可达 |
| 出口地区 | 经代理探测 `ipinfo.io` 显示国家，需属支持地区 |
| 信号一致性 | IP / 时区 / 语言 / 账号地区四者统一 |

自检全是 PASS/INFO 后再登录，能最大程度避免 check-cc 标记的“画像冲突”误封。

## 7. 停止

```bash
node index.js stop
# 或控制台点“停止容器”
```

---

## 文件结构

```
claude-vm/
├── vm/                      # “我们的虚拟环境”镜像（核心）
│   ├── Dockerfile           # 桌面 + Chrome + Claude + noVNC
│   ├── scripts/
│   │   ├── entrypoint.sh    # 时区/白名单代理/noVNC/桌面启动
│   │   ├── proxy-router.js  # 容器内本地白名单转发代理(仅 Anthropic 走上游)
│   │   ├── chrome-login.sh  # 经 router 走代理的真实 Chrome 登录
│   │   └── check-env.sh     # check-cc 维度校对(含代理路由隔离校验)
│   └── config/
│       └── chrome-login.desktop
├── client/                  # 用户安装的本地程序
│   ├── index.js             # CLI + 本地控制台(流服务前端)
│   ├── regions.js           # 地区预设
│   ├── package.json
│   └── public/              # 控制台 UI（内嵌 noVNC + 校对）
└── README.md
```
