# 远程访问方案：WechatOnCloud（云微）

> 定位：**本地桌面之外的「远程通道」备选方案**，不是现有 claude-vm 方案的替代。
> 状态：方案存档，当前未实施。仓库 <https://github.com/Gloridust/WechatOnCloud>
> 调研时间：2026-11-05 ｜ 上游最近提交：2026-11-01

---

## 1. 为什么需要第二个方案

现有 claude-vm 是**单机桌面应用**：

```
Windows 应用 → WSL2 发行版 → TigerVNC :5901 → websockify 127.0.0.1:6080 → noVNC 页面
```

它的边界很明确：**只能在这台电脑上、只能在这个 localhost 里**。

1.0.12 加固时我把 websockify 从 `0.0.0.0` 收紧到 `127.0.0.1`，理由是同网段任何人都能操作一个登录着 Claude 的桌面。收紧之后，远程访问这条路就彻底断了 —— 这是有意的取舍，不是缺陷。

WechatOnCloud 正好补这一块：它天生为「多设备通过浏览器访问同一个会话」设计，有面板、账号、反代、TLS、PWA。

**两者不冲突，可以同时跑**：6080 与 36080 不撞端口，WSL 与 Docker 互不干扰。

---

## 2. 两个方案的边界

| 维度 | 现有 claude-vm | WechatOnCloud |
|---|---|---|
| 运行载体 | WSL2 发行版（rootfs 导入，无需 Docker） | Docker 容器（必须有 Docker） |
| 串流层 | TigerVNC + websockify + noVNC | KasmVNC（一期）/ Xpra-html5（二期） |
| 对外入口 | `127.0.0.1:6080`（仅本机） | 面板 `:36080`（可反代到公网） |
| 鉴权 | 无，靠只绑回环 | 面板账号 + 反向代理 TLS |
| 多端同时看 | 单客户端 | ✅ 多浏览器共享同一会话 |
| 音频 | ❌ RFB 不传 | ⚠️ KasmVNC 本身支持，上游未说明默认是否启用 |
| 中文输入 | 无（靠宿主剪贴板粘贴） | 面板内置「中文输入」（exec 注入） |
| 安装包体积 | 740MB（含 620MB rootfs） | 未实测（微信本体运行时下载，不在镜像里） |
| 许可证 | 自有 | **无 LICENSE**（见第 6 节） |

结论：**本地用 claude-vm，远程用 WOC**。不要试图用其中一个覆盖另一个。

---

## 3. 它的架构（摘自上游 `doc/技术方案.md`）

```
Docker 容器（Debian base，amd64 / arm64 自适应）
  └── 微信 Linux 原生版 4.0（官方 .deb，按架构选包，不用 Wine）
        │ 渲染到
      Xvfb :99 + 轻量 WM（openbox）
        │ 被串流
      KasmVNC
        │ WebSocket
  面板（唯一对外入口，:36080，反代注入 KasmVNC 凭据）
        │ docker.sock
  docker 引擎 ── 按需创建/销毁微信实例容器（woc-wx-*）
```

三个关键设计值得借鉴：

1. **单会话多端共享**，不是多租户。一个微信进程，多个观察者。
2. **面板是唯一入口**，KasmVNC 的凭据由服务端注入、不下发前端。我们的 noVNC 目前是「无认证 + 只绑回环」，靠网络边界而不是靠鉴权。
3. **`docker.sock` 隔离**：`docker-compose.secure.yml` 用 `tecnativa/docker-socket-proxy` 只放行面板真正用到的端点（CONTAINERS / EXEC / IMAGES / VOLUMES / POST），并把裸 socket 覆盖成 `/dev/null`，代理只在 `internal: true` 的网络里可见。这是很规范的做法。

---

## 4. 接入我们已有的东西（重点）

WOC 默认按「国内家庭网络 + Asia/Shanghai」配置，直接拿来会和我们辛苦调好的环境信号冲突。要改四处。

### 4.1 出口与时区必须一致

上游默认：

```yaml
- TZ=${WOC_TZ:-Asia/Shanghai}
```

改成与代理节点一致：

```yaml
WOC_TZ=America/Los_Angeles
```

**理由**：我们的自检里「时区 ↔ 出口地区」是一致性判据。出口在洛杉矶、时区在上海，这一项直接红。

### 4.2 代理想透传到「实例容器」

WOC 的微信实例是**面板动态创建**的，不是在 compose 里写死的。所以代理不能只加在 panel 服务上，必须确认实例容器也继承。

Windows 上 Docker Desktop 访问宿主代理用 `host.docker.internal`，不是 `127.0.0.1`：

```yaml
environment:
  - HTTP_PROXY=http://host.docker.internal:7897
  - HTTPS_PROXY=http://host.docker.internal:7897
  - NO_PROXY=localhost,127.0.0.1,host.docker.internal
```

**待验证项**：面板创建实例时是否透传父容器 env。若不透传，需要在面板的实例创建逻辑里补（上游未提供该开关）。

### 4.3 字体策略：远程通道可以放宽，但要知情

把微信装进容器，镜像/微信 deb 必然带中文字体。如果这个远程桌面也去跑 checkcc，「字体地区特征」会立刻命中。

判断：**远程通道是给手机/外部设备看的，不需要过 checkcc 那一套信号。** 但如果要在远程桌面里登录 claude.ai，就仍然要沿用现有的「名单外字体」策略（`Noto Sans SC`，家族名不带 `CJK`）。

两套策略不要混：本地方案严格，远程方案宽松，各管一段。

### 4.4 数据与工作区不共享

- WOC 的持久化在 `./data-panel` 与实例卷里，与我们的 `C:\Users\KeithXi\claude-workspace` 无关。
- 如果远程要读写同一份文件，需要在 compose 里额外挂载该目录（Windows 路径 → Docker 路径），并注意权限（`PUID`/`PGID` 默认 1000）。

---

## 5. 部署步骤（Windows + Docker Desktop）

```bash
git clone https://github.com/Gloridust/WechatOnCloud.git
cd WechatOnCloud
cp .env.example .env      # 改密码、TZ、镜像前缀
docker compose -f docker-compose.yml -f docker-compose.secure.yml up -d
```

访问 `http://localhost:36080`，默认账号 `admin / wechat` —— **第一件事改密码**。

首次进入面板后，微信本体不在镜像里，需要在面板里点「下载安装」（这一步依赖网络，容器必须能走代理）。

---

## 6. 风险与限制（必须先看这一节）

| 风险 | 说明 | 处置 |
|---|---|---|
| **无 LICENSE** | 仓库没有 LICENSE 文件。法律上默认「保留所有权利」，**不能分发、不能商用、不能再发布** | 只作自用/内部工具；若要随产品分发，必须先联系作者取得授权 |
| `docker.sock` | 默认 compose 直挂，等于给面板 root 等价权限；能登面板的人理论上能以你的身份发消息 | 必须用 `docker-compose.secure.yml` overlay |
| 微信风控 | 非官方环境运行客户端 + `WOC_SPOOF_OS=1` 设备伪装，存在账号风险 | 不用主号；或只作消息中转 |
| 公网暴露 | 面板是唯一入口，一旦反代到公网就是登录页对全网敞开 | 必须 TLS + 强密码 + 限流；或只走内网/VPN |
| 资源占用 | 实例内存软/硬限 `1500/2500MB`（见 compose 默认值）；镜像体积未实测 | 低配机器先算内存再上 |
| 会话时效 | `WOC_SESSION_DAYS` 默认 30 天 | 按需调 |

---

## 7. 与「宿主侧输入法」的关系

WOC 的 `EXEC` 权限注释里写着，面板用它触发「应用安装、文件管理、**中文输入**、设备 ID 重置」。

也就是说：**它也没有在容器里装输入法，而是从宿主侧注入文字。** 这和我们计划的宿主侧输入法（Windows IME 打字 → 剪贴板 → 自动 Ctrl+V）是同一个思路，只是它做在面板里、我们做在桌面应用侧栏里。

这块可以互相参考，尤其是它的「多端协作软锁」—— 同一实例多人操作时自动只读 + 申请接管，避免两个人同时打字。

---

## 8. 验收标准（真的实施时按这个验）

1. 面板能登录，默认密码已改；
2. 微信实例启动后，浏览器能看到桌面且能操作；
3. 容器出口 IP 与宿主代理一致（`curl -x` 与容器内直连对比）；
4. `TZ` 与出口地区一致；
5. 手机浏览器（含 iOS 添加到主屏幕）能打开并操作；
6. 断网重连后会话不丢（KasmVNC 的持久化）；
7. 关掉 `secure.yml` 时确认 `docker.sock` 暴露面，打开后确认面板功能仍正常。

---

## 9. 结论

- **不是替代现有方案**：claude-vm 负责「本机、无 Docker、可过 checkcc」；WOC 负责「多设备、远程、有音频」。
- **最值得借鉴的三点**：面板作为唯一入口并服务端注入凭据、docker.sock 代理隔离、宿主侧输入注入。
- **最大的两个阻碍**：无 LICENSE（分发层面）、需要 Docker（用户门槛）。
- 实施时机：当「手机上看这个桌面」成为真实需求时再上，现在只留文档。

---

## 附：本文的事实来源

上游仓库（`main` 分支，2026-11-01 最后提交），实际读过的文件：

| 文件 | 用于 |
|---|---|
| `README.md` | 功能范围、部署入口 |
| `doc/技术方案.md` | 架构、组件选型（Xvfb / KasmVNC / Xpra 对比）、单会话多端共享的定位 |
| `docker-compose.yml` | 端口 `36080`、默认账号、`WOC_*` 环境变量默认值、`docker.sock` 挂载 |
| `docker-compose.secure.yml` | `docker-socket-proxy` 白名单端点、`internal` 网络隔离 |

未实测项（文中已标注）：镜像体积、实例容器是否继承代理 env、音频默认开关。

