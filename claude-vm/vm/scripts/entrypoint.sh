#!/usr/bin/env bash
set -e

# 0) Node / Claude Code 可执行路径（WSL 导入后不继承镜像 ENV，这里显式补上）
export PATH="/usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin:$PATH"
if [ ! -e /usr/local/bin/claude ] && [ -x /usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin/claude ]; then
  ln -sf /usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin/claude /usr/local/bin/claude 2>/dev/null || true
fi

# 1) 系统时区（与代理/账号地区一致 → check-cc 时区维度）
#    注意：WSL 每次启动后会把 Windows 宿主时区同步进 /etc/localtime，
#    且同步时机可能在 init 之后，会覆盖这里刚写入的值。故在开头几秒内重复校准。
apply_tz() {
  [ -n "${TZ:-}" ] || return 0
  ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime 2>/dev/null || true
  echo "$TZ" > /etc/timezone 2>/dev/null || true
}
apply_tz
(
  for _ in 1 2 3 4 5 6 7 8; do sleep 1; apply_tz; done
) >/dev/null 2>&1 &

# 1.5) 语言环境
#     镜像里只预生成了 en_US / en_GB / ja_JP / de_DE。台北画像要 zh_TW.UTF-8，
#     不重建 720MB rootfs：开机时用已装的 locales 包现场生成一次即可，之后持久保留。
if [ -n "$LANG" ]; then
  _lwant=$(printf '%s' "${LANG%%.*}" | tr 'A-Z' 'a-z')
  if ! locale -a 2>/dev/null | tr 'A-Z' 'a-z' | grep -q "^${_lwant}"; then
    _lg="${LANG%%.*}.UTF-8"
    sed -i -E "s/^# *(${_lg//./\\.})/\1/" /etc/locale.gen 2>/dev/null || true
    locale-gen >/dev/null 2>&1 || true
    echo "[claude-vm] 已生成 locale: $_lg"
  fi
  export LANG
  export LC_ALL="${LC_ALL:-$LANG}"
  if [ -z "$LANGUAGE" ]; then
    _base="${LANG%%.*}"; _lang="${_base%%_*}"
    export LANGUAGE="${_base}:${_lang}"
  fi
fi

# 2) 出口链路
#    两种来源，优先级：用户自己的 VPS 隧道 > 宿主侧代理
#      a) 隧道：ssh -N -D 到用户 VPS，整个虚拟机出口 = 那台机器。
#      b) 宿主代理：用户本机的 Clash / v2ray 之类，出口 = 它当前选中的节点。
#
#    分流模式（PROXY_MODE，由客户端传入，默认 all）：
#      all      —— 全部流量交给上游，由上游自己的规则分流。
#                  这是正确默认：Clash 一类客户端本来就带完整规则集，
#                  让它决定比我们用 8 条白名单猜要准得多。更重要的是
#                  「出口一致性」—— api.anthropic.com 从洛杉矶出、而统计/
#                  遥测请求从北京直连，会形成自相矛盾的信号，体检里直接扣分。
#      whitelist —— 只有白名单域名走上游，其余直连。仅在用户明确要求
#                  「只让 Anthropic 走代理」时使用。
ROUTER_PORT="${PROXY_ROUTER_PORT:-7890}"
HOST_PROXY="${UPSTREAM_PROXY:-}"
EFFECTIVE_UP="$HOST_PROXY"
PROXY_MODE="${PROXY_MODE:-all}"
case "$PROXY_MODE" in
  all|whitelist) ;;
  *) PROXY_MODE="all" ;;
esac

if [ -n "$EFFECTIVE_UP" ]; then
  export UPSTREAM_PROXY="$EFFECTIVE_UP"
  export PROXY_MODE

  if [ "$PROXY_MODE" = "all" ]; then
    # 全量模式：直接把上游当代理用，中间不插本地 router。
    # 理由很实在 —— router 只是一个转发进程，多一层就多一个会挂掉的环节；
    # 它一旦退出，Chrome 会静默退化成「直连」，用户看到的就是
    # 「出口变成本地运营商 / 体检风险变高」，且没有任何报错提示。
    PROXY_URL="$EFFECTIVE_UP"
    echo "[claude-vm] 分流模式: 全量经 $EFFECTIVE_UP（不经本地路由）"
  else
    PROXY_URL="http://127.0.0.1:${ROUTER_PORT}"
    echo "[claude-vm] 分流模式: 仅 Anthropic 流量经 $EFFECTIVE_UP（其余直连）"
    node /opt/scripts/proxy-router.js &
    ROUTER_PID=$!
    # 看门狗：router 退出就拉起来，避免下一次请求悄悄变成直连
    (
      while sleep 10; do
        if ! kill -0 "$ROUTER_PID" 2>/dev/null; then
          echo "[claude-vm] 本地路由已退出，正在重启"
          node /opt/scripts/proxy-router.js &
          ROUTER_PID=$!
        fi
      done
    ) &
  fi

  # Chrome 的 --proxy-server 只接受 host:port；带尾斜杠（http://h:p/）会被判成
  # ERR_NO_SUPPORTED_PROXIES，页面直接 "This site can't be reached"，而 curl 毫无
  # 反应 —— 于是自检全绿、浏览器全挂。统一在入口去掉尾斜杠。
  PROXY_URL="${PROXY_URL%/}"

  export HTTPS_PROXY="$PROXY_URL"
  export HTTP_PROXY="$PROXY_URL"
  export https_proxy="$PROXY_URL"
  export http_proxy="$PROXY_URL"
  export NO_PROXY="localhost,127.0.0.1"
  export no_proxy="$NO_PROXY"
  echo "$PROXY_URL" > /opt/config/local-proxy
  # 出口探测统一交给 2.4 的 net-guard：它先熔断再探测，探测本身也不走直连，
  # 而且会周期刷新。这里不再另起一个「20 秒后」的后台任务 —— 两个进程写同一份
  # /run/claude-vm/exit.state 会互相覆盖，界面拿到的出口信息会随机跳。
else
  echo "[claude-vm] 未配置代理：net-guard 将切断全部直连（fail-closed）"
fi

# 2.4) 网络熔断 —— 代理是唯一出口，代理断了网络就是断的
#
# 为什么必须在这一行、而不是等桌面/终端起来之后：
#   HTTP_PROXY 只是「应用层建议」，不读环境变量的程序、DNS、raw socket 都能绕过去。
#   net-guard 直接改内核路由表：删掉默认路由，只保留到代理的那条 on-link 路，
#   同时关掉 IPv6。此后任何非代理目标内核直接返回 ENETUNREACH —— 不是「检测到
#   代理断了再去断网」，而是从一开始就没有直连这条路，不存在泄漏时间窗。
#   它放在所有业务（X / 浏览器 / Claude Code）之前，业务一睁眼就已经被锁住。
#
# 预检也在 net-guard 内部、锁完之后才跑：代理没开 / 没开 Allow LAN / 出口仍在
# 受限地区 / 多源出口分叉 / api.anthropic.com 不通，一律保持封锁并写明原因，
# 绝不放行。状态落在 /run/claude-vm/net-guard.state，界面与自检都读它。
NET_GUARD="${NET_GUARD:-strict}"
export NET_GUARD
if [ -x /opt/scripts/net-guard.sh ]; then
  /opt/scripts/net-guard.sh &
  NET_GUARD_PID=$!
  echo "[claude-vm] 网络守卫已启动（pid=$NET_GUARD_PID, mode=$NET_GUARD）"
else
  # 脚本没同步成功时不能假装安全：宁可让自检报红，也不要静默裸奔。
  echo "[claude-vm] 严重：net-guard.sh 缺失，网络未受保护！请重新启动以同步脚本"
fi

# 2.5) 工作区：WSL 已 automount Windows 盘符，把宿主工作区软链到 /workspace
if [ -n "$WORKSPACE" ] && [ -d "$WORKSPACE" ] && [ ! -e /workspace ]; then
  ln -sfn "$WORKSPACE" /workspace || true
fi
mkdir -p /workspace

# 2.6) Chrome 策略：堵住两条「不走代理」的旁路
#   · WebRTC 走 UDP，不受 HTTP 代理约束 —— 网页能直接读到真实出口 IP（体检站里 +19 的那一项）
#   · DNS 走本机运营商解析器 —— 与代理出口地区对不上，被判「DNS/出口地区矛盾」
# 只有配置了代理时才强制 DoH，否则没代理的用户会连域名都解析不出来。
CHROME_POLICY_DIR=/etc/opt/chrome/policies/managed
mkdir -p "$CHROME_POLICY_DIR"
if [ -n "$UPSTREAM_PROXY" ]; then
  cat > "$CHROME_POLICY_DIR/claude-vm.json" <<'JSON'
{
  "WebRtcIPHandling": "disable_non_proxied_udp",
  "DnsOverHttpsMode": "secure",
  "DnsOverHttpsTemplates": "https://cloudflare-dns.com/dns-query"
}
JSON
else
  cat > "$CHROME_POLICY_DIR/claude-vm.json" <<'JSON'
{
  "WebRtcIPHandling": "disable_non_proxied_udp"
}
JSON
fi

# 2.65) 固定 Chrome 的语言偏好
#   --lang 管不到已存在 Profile 的 intl.accept_languages，登录时请求头会退回 en-US。
#   环境启动时就修正一次，不依赖用户是否点过「登录 claude.ai」。
if [ -f /opt/scripts/chrome-lang.py ]; then
  python3 /opt/scripts/chrome-lang.py --set >/dev/null 2>&1 || true
fi

# 2.66) 清掉 WSL 从宿主网卡继承来的企业 DNS 后缀
#   /etc/resolv.conf 由 WSL 自动生成，实测带 `search ljstaff.com`。它不会被检测站看到，
#   但会混进诊断包与应用日志，也让自检误报「DNS 被劫持」。
#   刻意**不改 nameserver**：熔断后直连 DNS 本来就不通；走 HTTP 代理的 HTTPS 由 CONNECT
#   在代理侧解析域名，本地 getent 的结果根本不参与（预演已验证 CONNECT 成功、
#   本地给的是 10.36.28.73 内网黑洞且直连不可达）。
mkdir -p /run/claude-vm
_dns_sfx=""
if grep -qE '^(search|domain)[[:space:]]' /etc/resolv.conf 2>/dev/null; then
  _dns_sfx=$(grep -E '^(search|domain)[[:space:]]' /etc/resolv.conf | head -1)
  _dns_tmp=$(mktemp)
  grep -vE '^(search|domain)[[:space:]]' /etc/resolv.conf > "$_dns_tmp" 2>/dev/null
  cat "$_dns_tmp" > /etc/resolv.conf 2>/dev/null || true   # 保留 inode，避免 WSL 重新挂载
  rm -f "$_dns_tmp"
  echo "[claude-vm] 已清除 DNS 后缀: $_dns_sfx"
fi
{
  echo "removed_suffix=${_dns_sfx:-none}"
  echo "nameserver=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null)"
  echo "ts=$(date +%s)"
} > /run/claude-vm/dns.state

# 2.67) 首次启动生成本环境独有的身份
#   WSL 默认继承宿主计算机名（实测 HomeVisionPC），/var/lib/dbus/machine-id 来自 Docker
#   模板、所有安装都一样。检测站看不到这两项，但它们会混进诊断包、日志与遥测，
#   形成「同一镜像批量部署」的指纹。**只生成一次**并持久化：每次启动都换反而更像新机器。
ID_FILE=/opt/config/identity
if [ ! -s "$ID_FILE" ]; then
  _hn=$(python3 -c "import secrets,string;print('DESKTOP-'+''.join(secrets.choice(string.ascii_uppercase+string.digits) for _ in range(7)))" 2>/dev/null)
  _mid=$(dbus-uuidgen 2>/dev/null)
  [ -n "$_hn" ]  || _hn="DESKTOP-$(date +%s | tail -c 8)"
  [ -n "$_mid" ] || _mid=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  {
    echo "vm_hostname=$_hn"
    echo "vm_machine_id=$_mid"
    echo "created=$(date -u +%FT%TZ)"
  } > "$ID_FILE"
  echo "[claude-vm] 已生成独立身份: $_hn"
fi
. "$ID_FILE"
if [ -n "$vm_hostname" ]; then
  hostname "$vm_hostname" 2>/dev/null || true
  echo "$vm_hostname" > /etc/hostname 2>/dev/null || true
fi
if [ -n "$vm_machine_id" ]; then
  echo "$vm_machine_id" > /etc/machine-id 2>/dev/null || true
  echo "$vm_machine_id" > /var/lib/dbus/machine-id 2>/dev/null || true
fi

# 2.7) 清掉镜像里残留的「名单内」CJK 字体
#     旧版 rootfs 装了 fonts-noto-cjk（早期为了中文界面），浏览器能枚举到它，
#     体检直接记为「字体地区特征 → 中国」并扣 13 分。
#     判断条件按名字来，不能用 fc-list :lang=zh —— 下面 2.8 装的 Noto Sans SC 也算中文。
if fc-list 2>/dev/null | grep -qE 'Noto Sans CJK|Noto Serif CJK' \
   || dpkg -s fonts-noto-cjk >/dev/null 2>&1; then
  dpkg --purge fonts-noto-cjk >/dev/null 2>&1 || true
  rm -f /usr/share/fonts/opentype/noto/NotoSansCJK*.ttc \
        /usr/share/fonts/opentype/noto/NotoSerifCJK*.ttc 2>/dev/null || true
  fc-cache -f >/dev/null 2>&1 || true
  echo "[claude-vm] 已移除残留的 Noto CJK 字体"
fi

# 2.8) 装「名单外」的中文字体，避免中文页面全是豆腐块
#      全删中文字体确实能让字体指纹归零，但代价是用户打开任何中文站点都是方块字。
#      checkcc 的字体名单是硬编码的 17 个家族名（Noto Sans CJK SC / Source Han Sans SC /
#      WenQuanYi Micro Hei / Microsoft YaHei …），Google Fonts 的 Noto Sans SC 不在其中；
#      实测 canvas 字宽比对对它完全不触发，而中文渲染正常。
if [ -f /opt/assets/fonts/NotoSansSC.ttf ] && ! fc-list | grep -q 'Noto Sans SC'; then
  mkdir -p /usr/share/fonts/truetype/claude-sc
  cp -f /opt/assets/fonts/NotoSansSC.ttf /usr/share/fonts/truetype/claude-sc/
  fc-cache -f >/dev/null 2>&1 || true
  echo "[claude-vm] 已安装 Noto Sans SC（中文渲染，非指纹名单字体）"
fi

# 2.85) 繁体笔形：台北画像下 SC 显示繁体字笔形偏简，补一份 Noto Sans TC。
#       检测站名单里是 `Noto Sans CJK TC` / `PingFang TC` / `Source Han Sans TC`，
#       Google Fonts 的 `Noto Sans TC` 家族名**不在**其中（fc-scan 已验证），不增加扣分。
if [ -f /opt/assets/fonts/NotoSansTC.ttf ] && ! fc-list | grep -q 'Noto Sans TC'; then
  mkdir -p /usr/share/fonts/truetype/claude-tc
  cp -f /opt/assets/fonts/NotoSansTC.ttf /usr/share/fonts/truetype/claude-tc/
  fc-cache -f >/dev/null 2>&1 || true
  echo "[claude-vm] 已安装 Noto Sans TC（繁体笔形，非指纹名单字体）"
fi

# 3) 桌面外观：壁纸 / 图标 / 面板 / 窗口管理器 / 终端配色
#    这里的原则是「别让它看起来像一台裸服务器」：
#    有壁纸、有 dock、有像样的终端字体，窗口标题不出现 root@host。
mkdir -p ~/.config/openbox ~/.config/tint2 ~/.config/gtk-3.0 \
         ~/.local/share/applications /opt/icons /opt/wall /usr/share/themes

# 3.1) 启动器：面板上的四个图标 + 桌面右键菜单
cp -f /opt/config/apps/*.desktop ~/.local/share/applications/ 2>/dev/null || true
cp -f /opt/config/apps/*.desktop /usr/share/applications/ 2>/dev/null || true
cp -f /opt/config/menu.xml ~/.config/openbox/menu.xml
# 窗口管理器配置优先取随客户端更新的副本（1.0.27 修了标题栏 ✕ 点了没反应），
# 没有才回退镜像内 /opt/config 的旧版 —— 这样不用重建 620MB rootfs 就能让修复生效。
_obrc=/opt/assets/config/openbox-rc.xml
[ -f "$_obrc" ] || _obrc=/opt/config/openbox-rc.xml
cp -f "$_obrc" ~/.config/openbox/rc.xml
cp -f /opt/config/tint2rc ~/.config/tint2/tint2rc

# 3.1.1) 串流页面：用自带的极简版，去掉 noVNC 那个悬浮控制条
#        优先用 /opt/assets（随客户端版本更新），没有才回退镜像内自带的旧副本
if [ -f /opt/assets/novnc/desktop.html ]; then
  cp -f /opt/assets/novnc/desktop.html /usr/share/novnc/desktop.html
else
  cp -f /opt/config/novnc/desktop.html /usr/share/novnc/desktop.html 2>/dev/null || true
fi
if [ -f /opt/assets/welcome/index.html ]; then
  mkdir -p /opt/config/welcome && cp -f /opt/assets/welcome/index.html /opt/config/welcome/index.html
fi

# 3.1.1b) 根路径直达定制页
#   websockify 的 --web 目录里没有 index.html 时，访问 http://host:6080/ 得到的是
#   一份目录列表（desktop.html / vnc.html / vnc_lite.html 全列出来），
#   而 noVNC 原版的 vnc.html 界面完全不同 —— 手动打开根路径的人会以为「不是那个页面」。
#   放一个只做跳转的 index.html，让根路径直接进定制页。
cat > /usr/share/novnc/index.html <<'NOVNC_INDEX'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Claude Workspace</title>
<meta http-equiv="refresh" content="0;url=desktop.html?autoconnect=1">
<style>
  html, body { margin: 0; height: 100%; background: #0d1017; color: #8b98ab;
    font: 13px/1.5 "DejaVu Sans", system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center; }
</style>
</head>
<body><div>正在连接桌面…</div></body>
</html>
NOVNC_INDEX

# 3.1.2) 窗口主题（旧镜像里没有，运行时补上，省得重建 rootfs）
mkdir -p /usr/share/themes/Claude/openbox-3
cp -f /opt/config/themes/Claude/openbox-3/themerc /usr/share/themes/Claude/openbox-3/themerc 2>/dev/null || true

# 3.2) 图标与壁纸（自绘 PNG：Fira Code 字形 + 品牌橙，避免方块感强的位图图标）
node /opt/scripts/gen-art.js icons /opt/icons 64 >/dev/null 2>&1 || true
if [ ! -f /opt/wall/wall.png ]; then
  node /opt/scripts/gen-art.js wallpaper /opt/wall/wall.png 1280 800 >/dev/null 2>&1 || true
fi

# 3.3) GTK 深色外观（文件管理器 / 对话框）
cat > ~/.config/gtk-3.0/settings.ini <<'GTK3'
[Settings]
gtk-theme-name=Adwaita-dark
gtk-icon-theme-name=Adwaita
gtk-application-prefer-dark-theme=1
gtk-font-name=DejaVu Sans 10
GTK3
cat > ~/.gtkrc-2.0 <<'GTK2'
gtk-theme-name="Adwaita-dark"
gtk-icon-theme-name="Adwaita"
gtk-font-name="DejaVu Sans 10"
style "default" { fg[NORMAL] = "#e6eaf2" fg[PRELIGHT] = "#ffffff" bg[NORMAL] = "#151b24" base[NORMAL] = "#10141b" text[NORMAL] = "#e6eaf2" }
class "GtkWidget" style "default"
GTK2

# 3.4) 终端提示符：去掉 user@host（那是最像服务器的记号）
if ! grep -q 'bashrc.extra' ~/.bashrc 2>/dev/null; then
  printf '\n[ -f /opt/scripts/bashrc.extra ] && . /opt/scripts/bashrc.extra\n' >> ~/.bashrc
fi

# 3.9) Claude Code 入口体检 + 自愈
#      正常布局里 bin/claude.exe 是 ~245MB 的原生二进制（对，后缀就是 .exe）；
#      但它的自更新只要中断一次，就会把整包换成「500 字节报错桩 + 残片」，
#      表现为终端里敲 claude 报 command not found 或 Bus error，且没有任何提示。
#      这里两种布局都认，每次启动都验一遍。
_cb_dir="$(ls -d /usr/local/lib/nodejs/*/lib/node_modules/@anthropic-ai/claude-code 2>/dev/null | head -1)"
if [ -n "$_cb_dir" ]; then
  for _cand in "$_cb_dir/bin/claude.exe" \
               "$_cb_dir/node_modules/@anthropic-ai/claude-code-linux-x64/claude"; do
    [ -f "$_cand" ] || continue
    chmod +x "$_cand" 2>/dev/null || true
    ln -sf "$_cand" /usr/local/bin/claude
    if timeout 20 claude --version >/tmp/claude-ver 2>&1 && grep -qE '^[0-9]+\.[0-9]+' /tmp/claude-ver; then
      echo "[claude-vm] Claude Code $(head -1 /tmp/claude-ver)"
      break
    fi
    echo "[claude-vm] 警告：$(basename "$_cand") 无法运行 —— $(head -1 /tmp/claude-ver)"
  done
fi

# 4) 显示后端：两种模式
#    wslg（默认）—— 用 WSLg 的 DISPLAY=:0。Linux 应用由 RDP/RAIL 变成 Windows
#      原生窗口：剪贴板、音频、DPI 缩放全都原生，不需要 Xtigervnc/websockify/noVNC。
#      日常只在终端窗口里跑 Claude Code，跟本机终端几乎一样。
#    desktop —— 保留 noVNC 串流桌面（也是 Mac 上唯一能嵌进应用窗口的图形方案）。
#    由客户端通过 DISPLAY_MODE 传入；旧版本没传时按 desktop 走，行为不变。
DISPLAY_MODE="${DISPLAY_MODE:-desktop}"

if [ "$DISPLAY_MODE" = "desktop" ]; then
# 4d) 启动 Xtigervnc（WSLg 把 /tmp/.X11-unix 挂成只读，故禁用 unix socket，仅用 TCP 5901）
#    分辨率只是「初始值」：客户端连上后会用 RFB 的 SetDesktopSize 按窗口实际大小
#    重新设置（xrandr 的 maximum 是 32768x32768，改得动），所以放大窗口就是真正的
#    1:1 像素，不是把 1280x800 拉伸——拉伸会让文字发虚，一眼就看出「不是本机」。
VENV_GEOMETRY="${NOVNC_GEOMETRY:-1600x900}"
mkdir -p ~/.vnc
pkill -x Xtigervnc 2>/dev/null || true
pkill -f "websockify --web" 2>/dev/null || true
sleep 1
rm -f /tmp/.X1-lock 2>/dev/null || true
export DISPLAY=:1
Xtigervnc :1 -geometry "$VENV_GEOMETRY" -depth 24 -rfbport 5901 -localhost \
  -SecurityTypes None -nolisten unix > ~/.vnc/Xtigervnc.log 2>&1 &
sleep 2

# 5) 桌面：壁纸 → 窗口管理器 → 面板
#    Chrome 被强杀后下次启动会弹「恢复页面」，启动时把崩溃标记复位掉
node /opt/scripts/fix-chrome-prefs.js >/dev/null 2>&1 || true
# 桌面刚起来时肯定没有 Chrome 在跑，直接清掉陈旧 Profile 锁（原因见 chrome-login.sh）。
# 覆盖从桌面图标启动的路径 —— 那条路走 run-chrome.sh → chrome-login.sh，一样会清，
# 但会话被强杀后残留的锁必须由启动段先清掉，否则用户第一次点图标就白点。
rm -f /root/.config/google-chrome/SingletonLock \
      /root/.config/google-chrome/SingletonCookie \
      /root/.config/google-chrome/SingletonSocket 2>/dev/null || true
# 首次引导（选主题那套）不该出现在一个已经装好的桌面里，提前把状态写好
node /opt/scripts/seed-claude-state.js >/dev/null 2>&1 || true

if [ -f /opt/wall/wall.png ]; then
  feh --bg-fill /opt/wall/wall.png >/dev/null 2>&1 || true
fi
openbox >/dev/null 2>&1 &
sleep 1
tint2 >/dev/null 2>&1 &

# 5.1) 首次启动：弹出欢迎引导（HTML 应用窗口，不是黑底终端）
if [ ! -f ~/.config/claude-vm-welcomed ]; then
  mkdir -p ~/.config
  touch ~/.config/claude-vm-welcomed
  (
    sleep 2
    /opt/scripts/show-welcome.sh >/dev/null 2>&1 &
  ) &
fi

# 6) 启动 noVNC 网页流服务
#    只绑回环：Windows 侧的 WSL localhost 转发能到达发行版自己的 127.0.0.1
#    （实测 wslrelay → 127.0.0.1 可用），所以没必要监听 0.0.0.0。
#    绑 0.0.0.0 的唯一后果是：一旦用户开了 mirrored 网络模式，同网段任何人都能
#    打开 http://<主机IP>:6080 直接操作这台虚拟机里的登录态，而 VNC 本身是无认证的。
websockify --web=/usr/share/novnc "${NOVNC_BIND:-127.0.0.1}:${NOVNC_PORT:-6080}" localhost:5901 &

# 会话兜底 + 桌面自愈：以前 desktop 模式只靠 Xtigervnc / websockify / openbox
# 「天然常驻」，可只要其中一个以非 0 退出，末尾的 wait 就返回该码；脚本开头又是
# set -e，于是整个 entrypoint 直接结束、wsl.exe 退出、发行版变 Stopped ——
# 日志里就是「运行时进程退出 code=1」，同时 Chrome 打不开、输入法消失、桌面全没。
# 和 wslg 模式一样放一个永不退出的子进程把 wait 挂住；desktop-guard.sh 负责
# 把崩掉的组件逐个拉回来，用户不必手动「停止 → 启动」。
sleep infinity &
nohup /opt/scripts/desktop-guard.sh >/tmp/desktop-guard.log 2>&1 &

else
# 4w) WSLg 模式：不启 X server / 窗口管理器 / 串流服务。
#     DISPLAY=:0 是 WSLg 的 Weston（rdprail-shell），每个 Linux 应用自己就是一个
#     Windows 顶层窗口；剪贴板与音频走 RDP 通道，不需要我们自己的桥。
export DISPLAY=:0
export PULSE_SERVER="unix:/mnt/wslg/PulseServer"

# 会话必须常驻：实测只要拉起窗口的那条 wsl.exe 结束，发行版就会变 Stopped，
# 已经打开的 WSLg 窗口和剪贴板同步会一起消失。entrypoint 末尾的 wait 需要一个
# 永不退出的子进程来兜住整个会话（桌面模式靠 Xtigervnc/websockify 天然兜住）。
# 从「串流桌面」切过来时，上一轮的 X server / 串流服务可能还活着；
# 留着它们会占着 6080 和 :1，还让用户看到两套窗口。
pkill -x Xtigervnc 2>/dev/null || true
pkill -f "websockify --web" 2>/dev/null || true

sleep infinity &
echo "[claude-vm] WSLg 模式就绪：DISPLAY=:0（无 Xtigervnc / websockify）"
fi

# 2.45) 中文输入法 —— 刻意放在 DISPLAY_MODE 分支之后
#   这一段原来在文件前部，那时 DISPLAY 还没确定（WSLg 继承 :0，desktop 要到
#   4d 段才 export :1）。ibus-daemon 会把 XIM_SERVERS 注册到 :0 根窗口，
#   而串流桌面的 xterm / Chrome 全在 :1 —— 表现就是「输入法切不了」。
#   现在两种模式都在各自的 X server 上注册，且早于 runtime-env 写盘。
# 2.45) 中文输入法（可选）：IBus + Rime 台湾注音 / 繁体
#   WSLg 不转发 Windows IME 的 preedit 组合串，但按键本身是转发的 ——
#   把输入法放在虚拟机内部，组合与提交都在 Linux 侧完成，再经 XIM 交给 xterm。
#   必须用 IBus：fcitx5 5.0 起移除了 XIM，而 xterm 只认 XIM（实测 fcitx4frontend
#   加载后 XIM_SERVERS 仍不注册；ibus-daemon --xim 能注册 @server=ibus）。
#   daemon 必须挂在本会话下：拉起它的 wsl.exe 一旦退出，XIM server 跟着消失。
INPUT_METHOD="${INPUT_METHOD:-off}"
if [ "$INPUT_METHOD" = "rime" ]; then
  /opt/scripts/rime-setup.sh || echo "[claude-vm] 输入法安装失败，本次不启用"
  if command -v ibus-daemon >/dev/null 2>&1; then
    pkill -x ibus-daemon 2>/dev/null || true
    export XMODIFIERS="@im=ibus"
    export GTK_IM_MODULE="ibus"
    export QT_IM_MODULE="ibus"
    # 开头是 set -e，daemon 启动失败不能带走整个 entrypoint（否则整台桌面消失）
    ibus-daemon -d --xim >/tmp/ibus-daemon.log 2>&1 || true
    _xim_ok=0
    for _ in $(seq 1 12); do
      if xprop -root XIM_SERVERS 2>/dev/null | grep -q '@server=ibus'; then _xim_ok=1; break; fi
      sleep 0.5
    done
    if [ "$_xim_ok" = "1" ]; then
      ibus engine rime >/dev/null 2>&1 || true
      echo "[claude-vm] 输入法已启用：IBus + Rime 万象拼音，XIM=@server=ibus"
    else
      echo "[claude-vm] 输入法 XIM 未注册，中文输入可能不可用（详见 /tmp/ibus-daemon.log）"
    fi
  fi
fi

# 7) 落盘「运行时实际生效的环境」，供独立会话读取
#    （桌面程序的「自检」是新开一个 WSL 会话，继承不到本脚本 export 的变量）
{
  echo "export TZ='${TZ:-}'"
  echo "export LANG='${LANG:-}'"
  echo "export LC_ALL='${LC_ALL:-}'"
  echo "export LANGUAGE='${LANGUAGE:-}'"
  echo "export DISPLAY='${DISPLAY}'"
  echo "export DISPLAY_MODE='${DISPLAY_MODE}'"
  echo "export PULSE_SERVER='${PULSE_SERVER:-}'"
  echo "export UPSTREAM_PROXY='${UPSTREAM_PROXY:-}'"
  echo "export PROXY_MODE='${PROXY_MODE:-}'"
  echo "export PROXY_WHITELIST='${PROXY_WHITELIST:-}'"
  echo "export PROXY_ROUTER_PORT='${ROUTER_PORT}'"
  echo "export HTTPS_PROXY='${HTTPS_PROXY:-}'"
  echo "export HTTP_PROXY='${HTTP_PROXY:-}'"
  echo "export NET_GUARD='${NET_GUARD:-strict}'"
  echo "export NET_GUARD_STRICT_REGION='${NET_GUARD_STRICT_REGION:-1}'"
  echo "export INPUT_METHOD='${INPUT_METHOD:-off}'"
  echo "export XMODIFIERS='${XMODIFIERS:-}'"
  echo "export GTK_IM_MODULE='${GTK_IM_MODULE:-}'"
  echo "export QT_IM_MODULE='${QT_IM_MODULE:-}'"
  # 关掉 Claude Code 的自动更新：它是在原地覆盖自己的包，网络一断就会留下
  # 「报错桩 + 残片」，整个 CLI 直接废掉，而且没有任何提示。版本随镜像走更稳。
  echo "export DISABLE_AUTOUPDATER='1'"
} > /opt/config/runtime-env
chmod 644 /opt/config/runtime-env

# 就绪标记：客户端不再只靠 6080 端口判断「环境是否起来了」——
# WSLg 模式不监听任何端口，必须有一个明确的信号告诉主进程可以开窗了。
# 文件内容写模式名，客户端据此确认这次拉起来的是自己要的那一种。
mkdir -p /run/claude-vm
printf '%s\n' "$DISPLAY_MODE" > /run/claude-vm/ready

# WSLg 模式：启动即弹出 Claude Code 终端窗口（日常唯一入口）。
# 登录态沿用容器里已有的 ~/.claude：没登录时 Claude Code 自己在终端里给出
# 授权链接，界面也会提示「先完成授权」，不会每次启动都强行弹浏览器。
# nohup + & 让窗口脱离 entrypoint；会话由 sleep infinity 兜住，关窗口不停虚拟机。
if [ "$DISPLAY_MODE" != "desktop" ]; then
  nohup /opt/scripts/run-claude.sh >/tmp/wslg-terminal.log 2>&1 &
  echo "[claude-vm] 已拉起 Claude Code 终端窗口（WSLg）"
fi

if [ "$DISPLAY_MODE" = "desktop" ]; then
  echo "[claude-vm] 就绪（串流桌面）。noVNC: ${NOVNC_BIND:-127.0.0.1}:${NOVNC_PORT:-6080}"
else
  echo "[claude-vm] 就绪（WSLg 原生窗口）。DISPLAY=:0，窗口由客户端按需拉起"
fi
echo "[claude-vm] 工作区已挂载到 /workspace"
# wait 会一直等到最后一个后台子进程结束：
#   · desktop 模式 —— Xtigervnc / websockify / openbox 天然常驻
#   · wslg 模式 —— 上面显式放了 sleep infinity，否则窗口会随会话一起消失
wait
