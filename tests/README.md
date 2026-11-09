# 测试指南

这个项目的理念是「**fail-closed + 环境可信**」：网络熔断宁可断网也不泄漏、脚本改了必须真的进到运行环境里、代理链路每一步都要实测校验。但长期以来它只有**手工验证和一次性探针脚本**——`build/` 下那些 `_test-*.sh` 事后没人能复现，十五个坑每一个都可能悄悄回来。

这套测试的目的有两个：

1. **回归防线**：优化、重构、加功能时，改坏了立刻知道，而不是等用户报「又点不动了」。
2. **行为规格**：如果哪天要重新开发（换架构、换运行时），这套测试就是验收标准——
   纯函数的行为、脚本的关键约束、启动链路的顺序要求，全部写在这里。

## 分层模型

| 层 | 目录 | 外部依赖 | 何时跑 | 实测耗时 |
| --- | --- | --- | --- | --- |
| **L1 单元** | `tests/unit/` | 无（WSL 全部 mock） | 每次改 `app/main.js` | < 1 秒 |
| **L2 静态一致性** | `tests/static/` | 仅仓库文件（缺失自动 sync） | 每次提交前 | ~2 秒 |
| **L3 WSL 集成** | `tests/integration/` | WSL2 + 已导入 `claude-vm` | 改运行时脚本 / 网络逻辑后 | ~20 秒 |
| **L4 端到端** | 手工 checklist（见文末） | 真实代理 + 完整安装包 | 每次发版 | 分钟级 |

没有 WSL 的机器（CI、Mac）上 L3 自动 skip，不影响整体通过。

## 快速开始

```bash
# 全部（含 L3 集成，本机需 WSL 且环境处于「停止」状态）
node --test "tests/**/*.test.js"

# 只跑快速层（L1 + L2，无副作用）
node --test "tests/unit/*.test.js" "tests/static/*.test.js"

# 等价入口（在 claude-desktop/ 下）
cd claude-desktop && npm test
```

> **Windows 注意**：glob 必须用引号包住（`"tests/**/*.test.js"`）。
> cmd 不展开 `*`，Node 自己做 glob；裸目录参数（`node --test tests/unit`）在 Windows 上不生效。

## 坑 → 测试映射表

十五个踩过的坑里，能在代码层拦住的都固化成了测试。新增测试时优先补这张表。

| 坑 | 症状 | 覆盖位置 |
| --- | --- | --- |
| 坑 8：代理尾斜杠 | Chrome 报 `ERR_NO_SUPPORTED_PROXIES`，curl 却正常 | `unit/proxy.test.js`（parseProxy/stripSlash 的 href 不得带 `/`） |
| 坑 12：✕ 点不动 | openbox 用了臆造的 `CloseButton` context | `static/consistency.test.js`（必须 `context name="Close"`） |
| 坑 13：假活接管 | ready 标记还在、进程全退，新版一直不重建 | `unit/runtime.test.js`（标记在 + 进程 DEAD → 判死）＋ static（RUNTIME_REV 参与指纹、`pgrep -x` 校验） |
| 坑 13：脚本漂移 | 「修复在包里 ≠ 修复在环境里」 | `static/consistency.test.js`（镜像与打包副本逐字节一致 + 无多余副本文件） |
| 坑 14：会话猝死 | `wait` 无兜底，任一组件退出全崩 | static（entrypoint 必须含 `sleep infinity &`） |
| 坑 14：XIM 错位 | ibus 注册到 WSLg 的 `:0`，串流窗口切不了输入法 | static（输入法段索引必须 > `export DISPLAY=:1`） |
| 坑 14：Chrome 陈旧锁 | `SingletonLock` 指向不存在的主机 | static（entrypoint 与 chrome-login.sh 都要清锁） |
| 坑 15：停止→启动死锁 | 熔断删默认路由，网关发现只认默认路由 | `unit/route.test.js` + `unit/upstream.test.js`（熔断态仍解析成功）＋ static（stopRuntime 中 unlock 先于 kill）＋ `integration/wsl.test.js`（lock→unlock 往返实测） |
| 坑 16：中文输入 | 终端一个字打不进、Chrome 候选窗豆腐块 | `static/consistency.test.js`（启动器用 lxterminal 且无 `-xrm`；rime-setup 装 ibus-gtk3；entrypoint 部署配色；自检查 `im-ibus.so`） |
| 平台抽象（1.0.32） | macOS 移植：平台差异散进业务逻辑会失控 | `unit/backend.test.js`（pickBackendId / 工作区映射 / docker create 参数，直接 require `app/lib/vm-backend.js`）＋ static（main.js 不得直接 spawn wsl.exe、NOVNC_BIND=0.0.0.0、dist:mac 存在） |

## 单元测试怎么加载 main.js（loader）

`app/main.js` 是 Electron 主进程模块，顶部 `require('electron')`，纯 Node 环境无法直接 require。
当前方案（`tests/loader.js`）：**按起止标记切片 + `new Function` 注入依赖**。

- 每个 `SEGMENTS` 条目声明 start/end 标记（必须在源码中唯一，loader 启动时全量校验，
  标记失效会得到明确的失败信息而不是静默测错对象）；
- mock `runWsl`（按命令关键词路由到预置输出）、`waitPort`、`log`（收集器）等依赖后注入。

**写新测试的三步**：

1. 在 `loader.js` 的 `SEGMENTS` 里加一段（选唯一、稳定的标记，优先函数签名行）；
2. 在对应 `tests/unit/*.test.js` 里 `loadSegment(name, deps)`；
3. 断言写成「事故回放」风格：注释里写清楚坑的编号和症状，失败信息里带上拿到的东西。

**重构方向**：把纯函数抽到 `claude-desktop/app/lib/*.js`（无 Electron 依赖），
单元测试直接 `require`，loader 届时退役。迁移时每抽一个函数，同步把对应 SEGMENTS 删掉。

## 集成测试安全约定（L3）

`tests/integration/wsl.test.js` 会**真实修改容器内核路由表**，约定如下：

1. 改路由的用例只在环境**未运行**（`/run/claude-vm/ready` 为空）时执行；运行中的会话的
   熔断绝不能被测试解锁，否则相当于人为制造安全缺口；
2. 每个改路由的用例都在 `finally` 里兜底 `unlock`，并以「默认路由已恢复」收尾断言；
3. 跑 L3 前先在应用里点「停止」。

## 已知边界（这套测试不覆盖什么）

- **Electron 渲染层 UI 交互**（按钮、侧栏、webview）——需要 Playwright/CDP 驱动，`build/cdp-*.js`
  的思路可以复用，暂未纳入；
- **真实代理出网质量**（出口 IP 归属地、checkcc 评分）——依赖外部服务，只在 L4 手工验证；
- **构建产物内容**（asar 逐字节、安装包里的脚本版本）——构建后手工核验，见交接文档；
- **rootfs 首次导入**——一次性成本，L4 覆盖。

## 发版前手工 checklist（L4）

按顺序走完才算一个版本可发：

1. `npm test` 全绿（含 L3）；
2. `npm run dist:win` 构建成功，安装新包；
3. 启动 → 就绪（wslg ~10 秒 / desktop ~20 秒）；
4. 串流桌面：点 ✕ 能关窗（坑 12）；
5. 串流终端：`Ctrl+Space` 能切到万象拼音（坑 14）；
6. Chrome 图标能打开登录页（坑 14）；
7. **点「停止」再立刻点「启动」**——坑 15 的完整场景，必须成功；
8. 自检（环境体检）无失败项；
9. `vm.log` 里无未预期的 `[vm!]` 错误。
