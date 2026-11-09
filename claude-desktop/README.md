# Claude VM 桌面版

双击即用的桌面程序：在本机 **Linux 虚拟环境**里跑 Claude Code 与 Chrome，
**以 WSLg 原生窗口**呈现（不是浏览器串流），文件走共享工作区，出网流量默认全部经宿主代理。

> 终端用户**不需要安装 Docker**（需要 WSL2 + WSLg：**Windows 11，或 Win10 19044+ 的商店版 WSL**）。
> 首次运行会自动把内置的 Linux 运行时导入为 WSL 发行版。

```
┌─ Claude VM (Electron) ─────────────────────────────┐
│  设置：地区 / 白名单代理 / 工作区 / 显示模式             │
│  自检：逐项对照 check-cc 维度并复算分数                 │
└───────────────┬────────────────────────────────────┘
                │ wsl -d claude-vm (内置 rootfs)
┌───────────────▼────────────────────────────────────┐
│  Linux 运行时（Ubuntu 22.04）                        │
│   ├─ 出网代理      → 宿主 HTTP 代理（默认全量）         │
│   ├─ Chrome        → 容器内登录 claude.ai（授权一次）   │
│   ├─ claude        → 独立 WSLg 窗口，可多开             │
│   ├─ noVNC :6080   → 可选，desktop 模式 / Mac 兜底     │
│   └─ /workspace ←── 软链 ── 宿主工作区目录             │
└─────────────────────────────────────────────────────┘
```

## 两种显示模式

默认 **wslg**，设置里可切 **desktop**（noVNC 串流）。

| | wslg（默认） | desktop（noVNC） |
| --- | --- | --- |
| 呈现 | Windows 真实窗口，独立任务栏项 | 应用内嵌 `<webview>` 显示远程桌面 |
| 清晰度 | 原生 1:1，无编码 | 跟随窗口缩放 + JPEG 编码，仍有损 |
| 剪贴板 | 系统原生双向 | 250 ms 轮询桥，仅文本 |
| 快捷键 | 与本机一致 | 大部分可用，部分被宿主拦 |
| 门槛 | Win11 / Win10 19044+ | 任意 WSL2 |

两者都**不支持在终端里直接打中文**（WSLg 不转发 Windows IME 组合事件）：
在 Windows 侧输入后 Ctrl+V / Ctrl+Shift+V 粘贴是最稳的绕法。

## 功能

- **零 Docker**：内置 rootfs，`wsl --import` 直接注册运行。
- **代理两种模式**：默认「全量」——容器内所有出网流量走你的上游 HTTP(S) 代理（出口一致，
  遥测与 API 不再分叉）；「白名单」模式下只在容器内起本地 router，仅把
  `.anthropic.com` / `.claude.ai` / `.claudeusercontent.com` 转发出去，其余直连。
- **代理地址自动映射**：填本机代理（如 `http://127.0.0.1:7897`）时，程序会自动探测它在容器内
  的真实可达地址（WSL2 镜像网络用 127.0.0.1，NAT 模式换成 Windows 宿主网关），避免代理自环。
- **工作区共享**：Windows 目录软链为 `/workspace`，文件双向可见。
- **幂等启动**：配置指纹未变且运行时还活着，直接接管，不重建虚拟机、不重启会话。
- **网络熔断（fail-closed）**：默认强制移除虚拟机默认路由并关闭 IPv6，代理是唯一出口；
  代理一断，网络内核层面直接不通，绝不回落到本机直连。启动前还会严格校验代理是否配好。
- **浏览器语言头固定**：`--lang` 只改 Chrome 的 UI 语言，不重写已有 Profile 的
  `Accept-Language`；启动时按地区写好语言偏好，自检用 headless Chrome 真实回显测量登录请求头。
- **独立环境身份**：首次启动生成一次专属主机名与 `machine-id` 并持久化，避免所有安装共用
  Docker 模板里的同一身份；只生成一次，否则每次启动都换反而更像一台新机器。
- **环境自检**：逐项对照 check-cc 维度（时区/语言/Locale/Intl/浏览器/代理路由/出口地区/
  多源出口一致性/DNS/claude.ai 可达性），并直接算出检测站同口径的分数；
  另含网络熔断、直连封锁验证、直连泄漏实测、代理预检、守卫心跳、浏览器语言头、
  代理远程解析等项。
- **诊断包**：一键导出脱敏配置 + `wsl -l -v` + 端口占用 + 自检 JSON + 日志末 400 行。

## 目录

```
claude-desktop/
├── app/                # Electron 程序
│   ├── main.js         # 主进程：WSL 导入/启动/停止/自检、代理、剪贴板、IPC
│   ├── preload.js      # 安全桥
│   └── renderer/       # 界面（设置 + 自检面板 + 可选 noVNC）
├── runtime/            # 构建产物：rootfs.tar.gz + 同步出的 scripts/assets
├── scripts/
│   ├── sync-scripts.js # vm/scripts → runtime/scripts（唯一同步入口）
│   └── build-rootfs.sh # 在 WSL 内构建镜像并导出 rootfs
└── package.json        # electron-builder 配置
```

## 构建步骤（开发机）

前置：WSL2（Ubuntu 22.04）+ Docker、Windows 上 Node 18+。

```bash
# 1) 在 WSL 内构建运行时并导出 rootfs
wsl -d Ubuntu-22.04 -e bash -lc \
  "bash /mnt/e/Web/FuckCladue/claude-desktop/scripts/build-rootfs.sh"

# 2) 安装依赖（国内加速）
cd claude-desktop
npm config set registry https://registry.npmmirror.com
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm install

# 3) 开发运行
npm start

# 4) 打包 Windows 安装包
npm run dist:win
```

产物在 `dist/`：

| 文件 | 说明 |
| --- | --- |
| `ClaudeVM-Setup-<版本>-x64.exe` | NSIS 安装包（可选安装目录、建桌面/开始菜单快捷方式） |

**日常只出 Setup**：`npm run dist:win` 等价于 `electron-builder --win nsis`。
便携版单独跑 `npm run dist:portable`，功能稳定前不必每次打两种包。

安装包内置 `resources/rootfs.tar.gz`（约 650 MB），因 rootfs 本身已是 gzip，
打包用 `compression: "store"` 以节省时间，所以成品约 740 MB。

## 模拟「中国台湾地区·台北的用户」

1.0.23 起**默认地区就是台北**：`Asia/Taipei`（UTC+8）+ `zh_TW.UTF-8` + Chrome `zh-TW`。

为什么是这个画像：`Asia/Shanghai` / `Asia/Urumqi` 这类时区是被检测站硬编码点名的，
而中国台湾地区不在 Anthropic 的受限地区名单内，`Asia/Taipei` 与 `zh-TW` 都不计分；
同时 UTC+8 和中文用户的作息一致，不必为了躲检测把系统时间改到美洲。
我们实测切过去之后：系统时区 / 语言 / 语言包 / 浏览器 Intl **四项全绿，总分仍是 41**。

> **挂 VPN 落地哪里都行，不必和时区同地区。** 台北用户为了加速、隐私、公司网络挂 VPN
> 出境是普通日常，不是中国地区用户专属行为。风控若见到「时区和出口 IP 地理不同」就扣分，
> 会误杀全球所有挂 VPN 的合法用户。检测站真正抓的是「是不是点名的中国时区 / `zh-CN` 语言 /
> 名单内中文字体」，以及出口 IP 是否落到受限地区、多源出口是否分叉 —— 这些由熔断预检负责。
> 所以 `Asia/Taipei` + 洛杉矶节点是干净的自洽画像，不用特意换东亚节点。

一整套画像是联动的，别只改时区：系统 `TZ` → `LANG`/`LC_ALL` → `LANGUAGE` →
Chrome `--lang` → 现场生成 `zh_TW.UTF-8` locale（不必重建 720MB rootfs）→ 终端输入法。
`chrome-login.sh` 过去硬编码 `--lang=en-US`，会让浏览器语言和系统 locale 自相矛盾，已改成按地区推导。

1.0.25 补齐了三处画像缺口：

- **`Accept-Language` 请求头**：`--lang=zh-TW` 并不会改已存在 Profile 里的
  `intl.accept_languages`（实测仍是 `en-US,en`），登录那一刻浏览器说的是美国。
  `chrome-lang.py --set` 在环境启动和每次打开登录页前把它固定成 `zh-TW,zh,en-US,en`；
  自检用真实 Profile 的副本跑 headless Chrome 访问本地回显服务，实测发出的头是
  `zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7`。
  > 这个字段是**纯语言标签列表**，q 权重由 Chrome 生成。若写成带 q 的字符串会叠出
  > `zh;q=0.9;q=0.8` 这种畸形头，反而比原来的 `en-US` 更像伪造 —— 别手改。
- **CLI 侧 DNS**：WSL 会把宿主网卡的 DNS 搜索域写进 `/etc/resolv.conf`（实测
  `search ljstaff.com`），检测站看不到它，但会混进诊断包与应用日志。entrypoint 每次启动清掉。
  **刻意不改 nameserver**：走 HTTP 代理的 HTTPS 是 CONNECT 远程解析，本地结果不参与；熔断后
  本地给的内网黑洞地址直连也不可达（预演已验证），改成 `1.1.1.1` 只会造成解析超时。
- **一致性判定**：删掉「时区必须和出口国家同地区」的旧逻辑（会误杀所有挂 VPN 的合法用户），
  改为只拦出口落在 CN/HK/MO；同时把「出口类型」对齐检测站口径，机房/骨干 ASN 标 warn 而非 pass。

## 中文输入法（fcitx5 + Rime · 万象拼音）

WSLg **不转发 Windows IME 的 preedit 组合串**，但按键本身是转发的。所以把输入法放进虚拟机内部：
按键 → X server → GTK3 应用（lxterminal / Chrome，经 `im-fcitx5.so`）→ fcitx5 → Rime 组合 → 中文提交 → Claude Code。
整条链路不经过 Windows IME。

> **1.0.34 换了输入法的壳：IBus → fcitx5。** Rime 引擎与万象词库原样复用，只换外壳。
> 动因：IBus 的候选面板在 VNC 串流里有天花板 —— 候选窗不跟光标（钉在屏幕左下角）、
> 竖排 1-9 老样式、面板字体回退失败出豆腐块，1.0.26~1.0.33 七轮修补无效。
> fcitx5 的面板（classicui）跟手、横排候选、字体正常，是国内 Linux 桌面事实标准。
> 1.0.31 的 lxterminal（GTK3 终端）保留不变；fcitx5 没有 XIM 前端，主链路本来就是 GTK 原生。

### 快捷键（实测）

| 快捷键 | 作用 |
|---|---|
| `Ctrl+Space` | 输入法开/关（关 = 纯英文，开 = Rime 组合） |
| `Shift`（单击） | Rime 内中文 ⇄ 英文（打英文数字时用） |
| 数字 `1-9` | 选对应候选词；`-`/`=` 或方向键翻页 |

按键经 noVNC 原样转发进虚拟机，快捷键链路没有被截断的问题。

### 实现要点

- 首次启用按需联网装 fcitx5 组件（`fcitx5` / `fcitx5-rime` / `fcitx5-frontend-gtk3`）
  外加 `lxterminal`；`--no-install-recommends` 确保不带进任何中文字体包。
  **万象词库离线解压**（约 75MB，编译一次约 1 分钟），不依赖 GitHub 可达性。
- 老环境（1.0.31~1.0.33 的 ibus 时代）词库会自动从 `~/.config/ibus/rime` 迁到
  fcitx5 的 `~/.local/share/fcitx5/rime`，不用重新解压编译。
- **fcitx5 依赖 D-Bus 会话总线**，entrypoint 显式启动（dbus-launch）并写进
  `runtime-env` 供所有 GUI 子进程继承；desktop-guard 的探活走 `fcitx5-remote`。
- fcitx5 进程起来 ≠ 可输入：必须 `fcitx5-remote -s rime` + `-o` 激活（实测切引擎
  那步才真正激活），entrypoint 与 guard 重启都会做。
- 自检「中文输入法」项：先查 GTK3 的 `im-fcitx5.so`，再查 fcitx5 服务就绪状态。

### 仍需真人按一次

自动化已验证：`im-fcitx5` 模块加载、fcitx5 服务就绪、Rime 组合出「你好」、
Shift 中英切换、Ctrl+Space 开关（合成按键实测全过）。但候选窗的跟手效果与
字形渲染要人眼确认：请在串流终端里按 `Ctrl+Space` 敲 `nihao`，看候选窗是否
跟随光标、横排显示、字形正常。宿主剪贴板桥（Ctrl+Shift+V）仍是零改动的中文输入兜底。

## 网络熔断（fail-closed）

`HTTP_PROXY` / `HTTPS_PROXY` 只是**应用层建议**：不读环境变量的程序、DNS 查询、raw socket
都能绕过去直连。以前代理一断，自检最多报个 warn，流量其实已经从本机真实出口裸奔了 ——
这正是最容易被体检站抓到的漏点。

1.0.22 起在网络层强制约束（`NET_GUARD=strict`，默认开启）：

- 启动时用 **Python netlink 直接改内核路由表**：删掉 IPv4 默认路由、关闭 IPv6。
  WSL 的 `192.168.240.0/20` on-link 路由仍在，宿主代理照常可达；其余目标内核直接
  `ENETUNREACH`。**不是"检测到代理断了再去断网"，而是从一开始就没有直连这条路**，
  没有泄漏时间窗。
- **先锁路由、再做预检**，顺序刻意：所有探测都经代理，Claude Code 终端一睁眼就已被锁住。
- 严格预检（不通过就保持断网并写明原因）：代理可达、出口地区不是 CN/HK/MO、
  多源出口一致、`api.anthropic.com` 可达、以及"绕过代理确实出不去"。
- 看门狗每 **3 秒** re-assert 一次，防止 WSL 在网络重置后把默认路由加回来；
  代理恢复会自动重跑预检并回到受保护状态。
- 状态实时显示在侧栏状态条与「运行环境自检」里：`guarded` / `proxy_down`（代理断、
  网络同步切断）/ `blocked`（预检未过）/ `off`。

设置里的「网络熔断」可切 `off` 退回旧行为，**仅建议在自己本来就在支持地区时使用**：
关掉后代理断开会回落到本机直连。开关改变会触发运行时重建（配置指纹已包含它）。

> 实现里没有用 iptables / iproute2：这个精简 rootfs 里两者都没装，但 `CAP_NET_ADMIN` 是齐的、
> Python3 有 `AF_NETLINK`，于是直接跟内核对话，零新依赖、不用重打 720 MB 的 rootfs。
> 代价是 WSL 主动把默认路由加回来时存在**秒级**窗口（由 3 秒看门狗兜住）；
> 正常的"代理软件挂了"不受影响，那种情况压根没有直连路由可走。

## 串流桌面的窗口关闭（1.0.27）

串流桌面（noVNC）里由 Openbox 画窗口标题栏。之前 `openbox-rc.xml` 的 `<mouse>` 段只写了
`Frame` / `Titlebar` / `Desktop` 三个 context，而这一段是**整段替换**默认配置、不是合并 ——
于是标题栏的 ✕ 画得出来，点击却没有任何动作，表现就是「关闭没反应」；`Alt+F4` 倒一直能用。

1.0.27 按 Openbox 官方默认配置补齐了 `Close` / `Maximize` / `Iconify` / `AllDesktops` /
`Shade` 五个按钮 context 和 `Client` 点击聚焦。**注意按钮 context 名不是 `CloseButton`**：
第一次按直觉命名写错，Openbox 静默忽略、实测点了依然不动；对照 `/etc/xdg/openbox/rc.xml`
改成 `Close` + `Click` 后，实机点击标题栏右上角窗口即消失。

配置走 `vm/config/openbox-rc.xml → runtime/assets/config/ → /opt/assets/config/`，
entrypoint 启动时优先覆盖 `~/.config/openbox/rc.xml`，**不用重建 620MB rootfs**。
改完要「停止 → 启动」让 Openbox 重新加载；急用时 `Alt+F4` 一直是兜底。

### 1.0.28：为什么装了 1.0.27 还是点不动

1.0.27 发出来后 ✕ 依然没反应。实机诊断发现：VM 里生效的 `~/.config/openbox/rc.xml`
**仍是旧的 4076 字节**（只有 `Frame/Titlebar/Desktop`），而 `/opt/assets/config/openbox-rc.xml`
已经是修好的 7335 字节 —— 修复在安装包里，却从没进过虚拟机。两层原因叠加：

- `runtimeAlive()` 在串流模式下只看 `/run/claude-vm/ready` 就返回 `true`。`/run` 是 tmpfs，
  桌面进程全退了标记还会留着，于是应用一直在「接管一个已经死掉的会话」；
- 幂等接管分支在 `syncScripts()` **之前**就 `return`，新脚本和新资源永远推不进 VM；
  旧版 entrypoint 固定从 `/opt/config` 读配置，每次启动又把旧文件覆盖回去。

1.0.28 把这条链堵死：① `runtimeAlive()` 同时校验 `Xtigervnc` / `openbox` / `websockify`
三个进程和 6080 端口；② 接管分支也执行 `syncScripts()`；③ 同步时把新配置同时写到
`~/.config/openbox/rc.xml` **和旧版回退源** `/opt/config/openbox-rc.xml`，并对运行中的
openbox 发 `--reconfigure`，不必重启就生效。配置指纹另加 `RUNTIME_REV`，脚本或资源一变
就不接管旧会话（升级后第一次点「启动」会重建一次，属预期）。

### 界面精简（同一版）

- 那条刺眼的白色竖条是 Chromium 默认的浅色原生滚动条，已换成 8px 轨道、
  视觉约 4px 的深灰细条，hover 才提亮（只用 `::-webkit-scrollbar`，不混 `scrollbar-width`）。
- 侧栏 5 段长说明默认折叠成一行小小的「ⓘ 说明」，点开才展开；「启动 / 停止」不用滚动就能看到。
  点「自动检测」会先展开对应说明，反馈不会藏起来。

## 串流桌面的稳定性（1.0.29）

日志里 `[vm] 运行时进程退出 code=1` 之后，Chrome 打不开、输入法切不了、整个桌面消失，
其实是**同一次会话猝死**的连锁反应。查下来是三个互相独立的原因：

1. **会话没有兜底**。`entrypoint.sh` 开头是 `set -e`，末尾 `wait` 会等到最后一个后台
   子进程结束；desktop 模式以前只靠 `Xtigervnc` / `websockify` / `openbox`「天然常驻」，
   任意一个退出，`wait` 就返回、脚本结束、`wsl.exe` 退出、发行版变 Stopped。
   现在和 WSLg 模式一样放 `sleep infinity &` 把 `wait` 挂住，并新增
   `desktop-guard.sh` 每 4 秒巡检四个组件，缺了就拉回来（含清 `/tmp/.X1-lock`）。
2. **输入法注册到了错误的 X server**。`ibus-daemon` 原来在 2.45 段启动，而
   `export DISPLAY=:1` 在 4d 段 —— `XIM_SERVERS` 注册到了 WSLg 的 `:0` 根窗口，
   串流窗口全在 `:1`，于是 `Ctrl+Space` 毫无反应。已把整段移到 DISPLAY 确定之后，
   两种模式各注册各的；守护脚本也按 `:1` 复查 atom。
3. **Chrome 陈旧 Profile 锁**。`SingletonLock` 记的是「hostname-PID」；1.0.26 起身份
   随机化成 `DESKTOP-XXXXXXX`，残留锁却还指向 `HomeVisionPC-324`（socket 早失效），
   Chrome 据此判定 Profile 被另一台机器占用而拒绝启动。现在启动桌面和每次打开 Chrome
   时，只要没有活着的 Chrome 进程就清掉 `SingletonLock` / `Cookie` / `Socket`。

`RUNTIME_REV` 随之 +1：升级后第一次点「启动」会重建会话，不会接管旧脚本拉起的桌面。
另外 hostname 在 WSL 会话重启后会被重置回宿主名，自检那条「环境身份不一致」的 warn
是会话已退出的信号，重启后 entrypoint 会重新套用同一个持久化身份（不会变成新机器）。

## 启动报错：「代理在本机可以连上，但容器内连不到它」（1.0.30）

这条报错在**点过「停止」之后再点「启动」**时必现，其实和 Allow LAN 无关。
日志里每次都在 `spawn` 之前约 1 秒就写 `[start] 上游代理解析失败`，虚拟机根本没被拉起来。

根因是**网络熔断把自己的启动路径锁死了**：

1. `net-guard.py` 为了实现 fail-closed，用 netlink 删掉默认路由，只留下通往代理的
   直连路由 —— 任何绕开代理的流量都出不去；
2. `wsl --terminate` 只终止发行版，**不会重建 WSL2 的网络命名空间**，被删的默认路由
   会一直残留（实测只有 `wsl --shutdown` 才恢复）；
3. 旧版 `wslGateway()` 必须读 `/proc/net/route` 里的默认路由才能算出 Windows 宿主地址，
   于是返回 null → `resolveUpstream` 判失败 → 不 spawn → 环境起不来，路由也永远没机会
   被重建。诊断文案还把人往「Allow LAN」上引，纯属误导。

1.0.30 的两处修复：

- **网关发现不再依赖默认路由**：一次 WSL 调用同时取三个来源 —— 默认路由网关、
  由直连网段推出的 `.1`、`/opt/config/local-proxy` 里上次成功写入的宿主地址；
  所有候选都交给容器内真实 TCP 连通性探测，只采用能连上代理端口的那个。
  候选含推断值，所以必须实测把关，猜错也不会把流量送错地方。
- **主动停止时还原路由**：`stopRuntime()` 在 kill 之前先跑 `net-guard.py unlock`
  （此时 `/run/claude-vm/net-guard.orig` 还在），精确还原原始路由。顺序不能反：
  会话一停，`/run` 是 tmpfs，原始路由记录就没了。fail-closed 的「不 unlock」
  只针对守卫意外死亡；用户点停止时环境本来就要下线，解锁是安全的。

**即时缓解（不用装包）**：正卡在这个报错时，在 Windows 终端执行 `wsl --shutdown`
重建 WSL 网络命名空间，再回程序点「启动」即可。装 1.0.30 之后「停止 → 启动」不再复发。

## macOS 支持（1.0.32）

macOS 上没有 WSL，改走 **Linux 容器后端**（Docker Desktop 或 OrbStack，自动探测）：

- 同一个 `rootfs.tar.gz` 直接 `docker import` 成镜像，首次启动约 1~2 分钟；
- **Apple Silicon 需要 Rosetta**：Docker Desktop / OrbStack 设置里启用
  「Use Rosetta for x86_64/amd64 emulation」（镜像是 amd64 的，不启用起不来）；
- 显示模式**只有串流桌面**（macOS 没有 WSLg），设置里对应选项已隐藏；
- 工作区只能放在 `/Users` 或 `/Volumes` 下（容器只共享这两个前缀），否则启动时会明确报错；
- 代理探测会自动试 `host.docker.internal` / `host.orb.internal`（容器内访问宿主的别名），
  你照常填 `127.0.0.1:7897` 就行，**不需要**开 Allow LAN；
- 构建：`npm run dist:mac`（必须在 macOS 上执行）。未签名的 dmg 首次打开需
  右键 →「打开」绕过 Gatekeeper。

前置条件：Docker Desktop / OrbStack 已安装并启动（`brew install --cask orbstack`）。

## 首次运行

1. 程序启动先做 WSL2/WSLg 预检；不可用会直接列出修复步骤。
2. 自动 `wsl --import claude-vm`（约 1~3 分钟，取决于磁盘）。
3. 启动 Linux 运行时 → 等就绪标记（wslg 约 5~10 秒 / desktop 等 noVNC 约 10~20 秒）。
4. 点 **登录 claude.ai** 弹出容器内 Chrome 完成授权（一次即可，登录态留在虚拟机里）。
5. 点 **Claude Code** 打开独立窗口直接跑 `claude`；可反复多开。
6. 文件放在共享工作区（默认 `%USERPROFILE%\claude-workspace`）。

## 卸载

- 程序目录直接删除即可；运行时数据在 `%APPDATA%\claude-desktop\runtime`
  （先用 `wsl --unregister claude-vm` 注销发行版，再删该目录，可完整回收约 3 GB 空间）。

## 注意

- 需要 **WSL2 + WSLg**：Windows 11，或 **Win10 19044+ 且用商店版 WSL**。
  老版本 Win10 没有 WSLg，请在设置里切到 `desktop` 模式（noVNC），程序会预检并提示。
- WSLg 窗口的生命周期绑定在发起它的 `wsl.exe` 上：应用退出前别手动关掉那个隐藏进程，
  否则窗口与剪贴板会一起消失（应用已用 `sleep infinity` 兜住，正常使用不用管）。
- 运行时：wslg 模式占 `display :0`；desktop 模式占 `display :1`、`5901`（VNC）、
  `6080`（noVNC，仅绑回环）；白名单模式另占 `7890`（本地 router）。
  同一台机器请只跑一个实例。
- 上游代理必须是 **HTTP(S)**；Claude Code 官方不支持 SOCKS。若上游代理需要账号密码，
  当前版本尚未转发 `Proxy-Authorization`，请先用免认证的本地代理（Clash/v2rayN 等）。
- 环境一致性只能降低误判风险，**绕不过账号级地区限制**；需合规地区的 Claude 订阅或 API key。
- macOS：不需要图形协议，`limactl shell` + Terminal.app 直接跑 Claude Code 体验最好；
  noVNC 仅作为「要在 Mac 浏览器里登录 claude.ai」时的兜底（走 SSH 端口转发）。
