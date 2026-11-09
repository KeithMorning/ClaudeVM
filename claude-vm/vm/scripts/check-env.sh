#!/usr/bin/env bash
# ============================================================
# check-env.sh — 对照 check-cc 的封号/受限风险维度，校对本地虚拟环境
#
# 用法：
#   check-env.sh          人类可读输出（命令行用）
#   check-env.sh --json   结构化 JSON（桌面程序渲染用）
#
# 设计原则：每个维度给出「结论 + 实测值 + 为什么重要 + 怎么修」，
# 而不是把原始日志直接丢给用户。
# ============================================================

MODE=text
[ "${1:-}" = "--json" ] && MODE=json

# 独立会话（桌面程序点「自检」）继承不到 entrypoint 导出的变量，先读回落盘的环境
if [ -f /opt/config/runtime-env ]; then
  . /opt/config/runtime-env
fi

REGION_LABEL="${REGION_LABEL:-${TZ:-未知}}"
US=$'\x1f'
PASS=0; WARN=0; FAIL=0; INFO=0
ITEMS=()

# 运行时是否真的起来了（决定这次自检结论是否有意义）
# 注意：/opt/config/runtime-env 是上次运行留下的，环境停掉后它还在，
# 所以要认 entrypoint 写的就绪标记 + 会话进程，不能只看文件。
# 两种显示模式：
#   wslg    —— 没有 Xtigervnc / websockify，会话靠 sleep infinity 兜住
#   desktop —— 原有 Xtigervnc + websockify + 6080
# DISPLAY_MODE 由客户端显式传入（env），旧环境没传则从标记文件回推。
if [ -z "${DISPLAY_MODE:-}" ] && [ -f /run/claude-vm/ready ]; then
  DISPLAY_MODE="$(head -1 /run/claude-vm/ready)"
fi
DISPLAY_MODE="${DISPLAY_MODE:-desktop}"
RUNTIME_UP=0
if [ -f /run/claude-vm/ready ]; then
  if [ "$DISPLAY_MODE" = "wslg" ]; then
    pgrep -f "sleep infinity" >/dev/null 2>&1 && RUNTIME_UP=1
  else
    { pgrep -x Xtigervnc >/dev/null 2>&1 || pgrep -f "websockify --web" >/dev/null 2>&1; } && RUNTIME_UP=1
  fi
fi

# add <分组> <状态> <名称> <实测值> <说明> <建议>
add() {
  ITEMS+=("$1${US}$2${US}$3${US}$4${US}$5${US}$6")
  case "$2" in
    pass) PASS=$((PASS+1)) ;;
    warn) WARN=$((WARN+1)) ;;
    fail) FAIL=$((FAIL+1)) ;;
    *)    INFO=$((INFO+1)) ;;
  esac
}

gtitle() {
  case "$1" in
    region)      echo "地区与语言" ;;
    desktop)     echo "浏览器与运行环境" ;;
    network)     echo "网络与代理" ;;
    consistency) echo "一致性判断" ;;
    *)           echo "$1" ;;
  esac
}

jesc() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\r'/}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# ------------------------------------------------------------
# 1. 地区与语言
# ------------------------------------------------------------
_tzsys=$(cat /etc/timezone 2>/dev/null)
# 以「浏览器/JS 实际读到的时区」为准：Chrome 与 Node 都按 TZ 环境变量解析
_intl_tz=$(node -e "console.log(new Intl.DateTimeFormat().resolvedOptions().timeZone)" 2>/dev/null)
if [ -z "${TZ:-}" ]; then
  add region warn "系统时区" "未设置" \
    "没有指定时区，浏览器会按默认 UTC 上报，与所选地区不符。" \
    "在左侧选择目标地区后重启环境。"
elif [ -n "$_intl_tz" ] && [ "$_intl_tz" = "$TZ" ]; then
  if [ "$_tzsys" = "$TZ" ]; then
    add region pass "系统时区" "$TZ" "系统与浏览器读到的时区一致。" ""
  else
    add region pass "系统时区" "$TZ" \
      "浏览器读到的时区正确（系统文件为 ${_tzsys:-未知}，WSL 会把它同步成 Windows 时区，不影响浏览器）。" ""
  fi
else
  add region warn "系统时区" "${_intl_tz:-未知}（期望 $TZ）" \
    "浏览器脚本读到的时区与所选地区不一致，会暴露出另一个地区。" \
    "点「停止」再「启动」；若仍不一致，说明运行时用了旧脚本。"
fi

if [ -n "${LANG:-}" ] && [ "$LANG" != "C" ] && [ "$LANG" != "POSIX" ]; then
  if [ "$LANG" = "${LC_ALL:-$LANG}" ]; then
    add region pass "系统语言" "$LANG" "LANG 与 LC_ALL 一致，各程序读到的语言相同。" ""
  else
    add region warn "系统语言" "LANG=$LANG / LC_ALL=${LC_ALL:-空}" \
      "两个变量不一致，不同程序可能读到不同语言，形成矛盾信号。" \
      "重启虚拟环境即可，程序启动时会统一写入。"
  fi
else
  add region warn "系统语言" "${LANG:-未设置}" \
    "当前是 C/POSIX 语言环境，会被识别为非本地化环境。" \
    "在左侧选择目标地区后重启环境。"
fi

# 该 locale 是否真的生成过（没生成会导致中日文显示成方块）
_norm() { printf '%s' "$1" | tr 'A-Z' 'a-z' | sed 's/utf-\?8/utf8/g'; }
if command -v locale >/dev/null 2>&1 && [ -n "${LANG:-}" ]; then
  _want=$(_norm "$LANG"); _found=0
  while read -r _l; do
    [ "$(_norm "$_l")" = "$_want" ] && _found=1
  done < <(locale -a 2>/dev/null)
  if [ "$_found" -eq 1 ]; then
    add region pass "语言包" "$LANG 已生成" "系统里存在该 locale，界面与文档不会出现方块字。" ""
  else
    add region warn "语言包" "$LANG 未生成" \
      "系统里没有这个 locale，中日文会显示为方块，属于明显的虚拟环境特征。" \
      "点「停止」再「启动」让 entrypoint 现场生成该 locale（台北画像需 zh_TW.UTF-8）。"
  fi
fi

# Node/浏览器的 Intl 语言
_intl=$(node -e "console.log(new Intl.DateTimeFormat().resolvedOptions().locale)" 2>/dev/null)
if [ -n "$_intl" ]; then
  _intl_n=$(printf '%s' "$_intl" | tr '_' '-' | tr 'A-Z' 'a-z')
  _lang_n=$(printf '%s' "${LANG%%.*}" | tr '_' '-' | tr 'A-Z' 'a-z')
  if [ "$_intl_n" = "$_lang_n" ]; then
    add region pass "浏览器语言(Intl)" "$_intl" "JavaScript 侧语言与系统语言一致。" ""
  else
    add region warn "浏览器语言(Intl)" "$_intl（系统 $LANG）" \
      "浏览器脚本读到的语言与系统语言不同，两边会互相矛盾。" \
      "重启虚拟环境；若仍不一致，检查是否被 LANG 覆盖。"
  fi
fi

# Chrome 实际发出的 Accept-Language（--lang 管不到已存在 Profile 的偏好）
# 用真实 Profile 的副本跑一次 headless 回显，量到的就是登录 claude.ai 真正发出的头。
if [ -f /opt/scripts/chrome-lang.py ]; then
  mapfile -t _CL < <(python3 /opt/scripts/chrome-lang.py --shell 2>/dev/null)
  _cl_mode="${_CL[0]:-error}"
  _cl_hdr="${_CL[1]:-}"
  _cl_ok="${_CL[2]:-false}"
  _cl_detail="${_CL[3]:-}"
  _cl_want=$(printf '%s' "${LANG%%.*}" | tr '_' '-')
  if [ -z "$_cl_hdr" ]; then
    add region fail "浏览器语言头" "未配置" \
      "Chrome Profile 里没有语言偏好，登录请求会退回 en-US，与系统 ${LANG} 矛盾。" \
      "执行 /opt/scripts/chrome-lang.py --set，或重启虚拟环境让 entrypoint 自动修正。"
  elif [ "$_cl_ok" = "true" ]; then
    add region pass "浏览器语言头" "$_cl_hdr" \
      "${_cl_mode}：首选 ${_cl_want}，与系统 locale 一致；${_cl_detail}。" ""
  else
    add region fail "浏览器语言头" "$_cl_hdr（期望 ${_cl_want}）" \
      "浏览器语言头不合格（${_cl_detail}）：可能与系统地区不一致，或含重复 q 权重这种畸形写法，登录时比 en-US 更可疑。" \
      "执行 /opt/scripts/chrome-lang.py --set（Chrome 正在运行时先关掉它），再重启环境。"
  fi
fi

# ------------------------------------------------------------
# 2. 浏览器与运行环境
# ------------------------------------------------------------
if command -v google-chrome-stable >/dev/null 2>&1; then
  _v=$(google-chrome-stable --version 2>/dev/null | awk '{print $NF}')
  add desktop pass "浏览器" "Chrome $_v" "运行的是真实 Chrome，不是 WebView 或 headless。" ""
else
  add desktop fail "浏览器" "未安装" \
    "找不到 google-chrome-stable，登录页无法用真实浏览器打开。" \
    "重新导入环境（删除发行版后重启程序会自动重建）。"
fi

if [ "$DISPLAY_MODE" = "wslg" ]; then
  # WSLg 的 :0 是真实图形显示（Weston + XWayland），不是无头环境；
  # 只是没有 Xtigervnc / websockify，别再按「串流桌面」去要求它们。
  if [ -n "${DISPLAY:-}" ] && [ "$DISPLAY" = ":0" ]; then
    add desktop pass "显示会话" "WSLg · DISPLAY=:0" \
      "Linux 应用以 Windows 原生窗口显示，剪贴板/音频/缩放走 RDP 原生通道，不是无头环境。" ""
  else
    add desktop warn "显示会话" "WSLg 但 DISPLAY 异常（${DISPLAY:-未设置}）" \
      "WSLg 模式下窗口起不来；检查 wsl --version 是否有 WSLg version 一行。" \
      "确认 Win11 或 Win10 19044+ 且安装商店版 WSL；也可把显示模式切回串流桌面。"
  fi
  add desktop info "显示模式" "WSLg 原生窗口" \
    "日常在独立终端窗口里跑 Claude Code；需要浏览器/完整桌面时切到串流桌面。" ""
elif [ -n "${DISPLAY:-}" ]; then
  add desktop pass "桌面会话" "DISPLAY=$DISPLAY" "有真实 X11 桌面，不是无头环境。" ""
else
  add desktop warn "桌面会话" "无 DISPLAY" \
    "没有图形会话，Chrome 可能以 headless 方式运行，容易被判定为自动化。" \
    "先点「启动虚拟环境」，等桌面出现后再自检。"
fi

# Claude Code CLI 是否真的能跑（自更新中断会把包换成报错桩，外表看不出来）
if command -v claude >/dev/null 2>&1; then
  _cv=$(timeout 20 claude --version 2>&1 | head -1)
  if printf '%s' "$_cv" | grep -qE '^[0-9]+\.[0-9]+'; then
    add desktop pass "Claude Code" "$_cv" "命令行能正常启动并报告版本。" ""
  else
    add desktop fail "Claude Code" "无法运行" \
      "claude 命令在，但跑不起来（常见于自更新中断：包变成了报错桩 + 残片）。" \
      "重启虚拟环境会重建入口链接；仍失败可在终端执行 npm i -g @anthropic-ai/claude-code。"
  fi
else
  add desktop fail "Claude Code" "未安装" \
    "PATH 里没有 claude 命令，终端里无法启动 Claude Code。" \
    "重启虚拟环境；仍失败请重新导入环境。"
fi

if command -v fc-list >/dev/null 2>&1; then
  _fc=$(fc-list 2>/dev/null | wc -l | tr -d ' ')
  # 镜像刻意不带中文字体（等宽 CJK 会把拉丁字符按全角排版，体积也大），
  # 所以「几十个」是设计值，不是缺陷。低于 20 才是真出了问题（字体包没装上）。
  if [ "${_fc:-0}" -ge 20 ]; then
    add desktop pass "字体" "$_fc 个已安装" "字体数量正常，页面渲染不会缺字形。" ""
  else
    add desktop warn "字体" "仅 $_fc 个" \
      "字体过少会让页面排版异常，是精简环境的明显特征。" \
      "重新导入环境（镜像自带 Fira Code / DejaVu / Liberation 字族）。"
  fi

  # 中文字体本身不是罪 —— 罪的是「被指纹名单点名的那几个家族名」。
  # 检测站用的是一份硬编码名单 + canvas 字宽比对，所以这里按同一份名单判，
  # 而不是见到中文字体就报警（Noto Sans SC 不在名单里，中文显示与它无关）。
  _bad_fonts=""
  for _n in "Microsoft YaHei" "Microsoft JhengHei" "PingFang SC" "Hiragino Sans GB" \
            "STHeiti" "STSong" "SimSun" "SimHei" "Noto Sans CJK SC" "Source Han Sans SC" \
            "WenQuanYi Micro Hei" "PingFang TC" "Noto Sans CJK TC" "Source Han Sans TC" \
            "MiSans" "HarmonyOS Sans" "OPPO Sans" "vivo Sans" "Honor Sans" \
            "Alibaba PuHuiTi" "WPS Fangzheng" "FZLanTingHeiS"; do
    if fc-list "$_n" 2>/dev/null | grep -q .; then _bad_fonts="${_bad_fonts} ${_n}"; fi
  done
  if [ -z "$_bad_fonts" ]; then
    add desktop pass "字体地区特征" "未命中名单" \
      "指纹名单里的中文字体一个都没有；中文显示由名单外的 Noto Sans SC / Noto Sans TC 承担，后者负责繁体笔形。" ""
  else
    add desktop warn "字体地区特征" "命中：${_bad_fonts# }" \
      "这些家族名在检测站的指纹名单里，会被 canvas 字宽比对判成「中国字体」并扣分。" \
      "卸载对应字体包（重启虚拟环境会自动清理 Noto CJK）。"
  fi
fi

# 环境身份：主机名 / machine-id 是否与同一镜像的其它安装区分开
# 这两项检测站看不到，但会混进诊断包、日志与遥测，构成批量镜像指纹。
_idf=/opt/config/identity
_tpl_mid="181553d0b62b293fb41e6ba46ae962c1"
if [ -s "$_idf" ]; then
  vm_hostname=""; vm_machine_id=""
  . "$_idf"
  _cur_hn=$(hostname 2>/dev/null)
  _cur_mid=$(cat /etc/machine-id 2>/dev/null)
  if [ -n "$vm_hostname" ] && [ "$_cur_hn" = "$vm_hostname" ] \
     && [ -n "$vm_machine_id" ] && [ "$_cur_mid" = "$vm_machine_id" ] \
     && [ "$_cur_mid" != "$_tpl_mid" ]; then
    add desktop pass "环境身份" "$_cur_hn" \
      "主机名与 machine-id 是首次启动时独立生成并持久化的，不会和同一镜像的其它安装撞车。" ""
  else
    add desktop warn "环境身份" "与持久化身份不一致" \
      "当前 hostname / machine-id 与 /opt/config/identity 记录的不同，可能是 WSL 覆盖了 /etc/hostname。" \
      "重启虚拟环境让 entrypoint 重新套用；身份值会复用，不会变成新机器。"
  fi
else
  add desktop info "环境身份" "尚未初始化" \
    "首次启动时生成一次独立的主机名与 machine-id；环境未运行时不需要这一项。" ""
fi

# ------------------------------------------------------------
# 3. 网络与代理
# ------------------------------------------------------------
ROUTER="http://127.0.0.1:${PROXY_ROUTER_PORT:-7890}"
UP="${UPSTREAM_PROXY:-}"
PROXY_ARG=""
[ -n "$UP" ] && PROXY_ARG="-x $UP"

# 全量模式：PROXY_MODE=all 时整台机器都从上游出网（上游是用户本机的代理软件）。
ALL_ON=0
if [ -n "$UP" ] && [ "${PROXY_MODE:-all}" = "all" ]; then ALL_ON=1; fi

_pick() { printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }

if [ -n "$UP" ]; then
  # 全量模式直接用上游，只有白名单模式才经过本地路由
  if [ "$ALL_ON" = 1 ]; then
    PROXY_EP="$UP"; PROXY_NAME="代理接管"
  else
    PROXY_EP="$ROUTER"; PROXY_NAME="本地路由"
  fi

  # 比较时忽略首尾空白与尾斜杠：两者只差一个 "/" 不该报成「未接管」。
  _lp_cmp=$(printf '%s' "$(cat /opt/config/local-proxy 2>/dev/null)" | tr -d '[:space:]' | sed 's:/*$::')
  _ep_cmp=$(printf '%s' "$PROXY_EP" | tr -d '[:space:]' | sed 's:/*$::')
  if [ "$_lp_cmp" = "$_ep_cmp" ]; then
    add network pass "$PROXY_NAME" "已接管 → $UP" \
      "Claude Code 与 Chrome 的流量都从这里出网。" ""
  else
    add network warn "$PROXY_NAME" "未接管（HTTPS_PROXY=${HTTPS_PROXY:-空}）" \
      "代理已配置，但程序拿到的代理地址不是它，流量可能绕开代理直连。" \
      "重启虚拟环境，让 entrypoint 重新注入代理变量。"
  fi

  # 浏览器代理参数：这一项是血换来的 —— Chrome 的 --proxy-server 只认 host:port，
  # 带尾斜杠会直接 ERR_NO_SUPPORTED_PROXIES，而 curl 完全不受影响。只测 curl 的话
  # 会出现「自检全绿、浏览器一个页面都打不开」的分裂状态。
  _lp=$(cat /opt/config/local-proxy 2>/dev/null | tr -d '\r\n')
  if [ -z "$_lp" ]; then
    add network warn "浏览器代理参数" "缺失" \
      "没读到代理地址文件，Chrome 可能不走代理。" "重启虚拟环境以重新生成。"
  elif printf '%s' "$_lp" | grep -Eq '^(https?|socks5h?|socks4)://[^/]+$'; then
    add network pass "浏览器代理参数" "$_lp" \
      "写法可被 Chrome 直接使用（协议受支持、无多余斜杠）。" ""
  else
    add network fail "浏览器代理参数" "$_lp" \
      "这个写法 Chrome 不接受，页面会显示 ERR_NO_SUPPORTED_PROXIES。" \
      "改成 http://host:port（末尾不要带斜杠）。"
  fi

  if [ "$ALL_ON" = 1 ]; then
    # 全量经「用户本机代理」出网（Clash / v2ray 之类）。
    # 这里要确认的是两件事：① 代理真的能出网；② 出口确实变了 ——
    # 如果经代理和直连拿到同一个 IP，说明流量根本没进代理，
    # 那 Chrome 里看到的仍是本地出口，Claude 那边也会看到不一致的地理。
    _via=$(curl -s --max-time 12 -x "$PROXY_EP" https://ipinfo.io/json 2>/dev/null)
    _vip=$(_pick "$_via" ip); _vorg=$(_pick "$_via" org); _vcity=$(_pick "$_via" city)
    _direct=$(curl -s --max-time 8 --noproxy '*' https://ipinfo.io/json 2>/dev/null)
    _dip=$(_pick "$_direct" ip)

    if [ -z "$_vip" ]; then
      add network fail "统一出口" "经代理访问外网无回包" \
        "本地路由在跑，但上游代理没有把请求送出去。多半是代理软件没开、端口填错，或不允许局域网连接。" \
        "确认代理软件正在运行且已开启「允许局域网连接（Allow LAN）」；再点「自动检测」重新识别端口。"
    elif [ -n "$_dip" ] && [ "$_vip" = "$_dip" ]; then
      # 直连和走代理拿到同一个地址，通常是代理软件开了 TUN / 全局模式，
      # 整机流量都被接管 —— 这是好事，不是故障。只有当出口仍在本地
      # 运营商网段时才有问题，但那需要另一份参照才能判断，这里不猜。
      add network pass "统一出口" "全部流量同一出口（${_vip}${_vcity:+ · $_vcity}）" \
        "直连与经代理拿到的是同一个地址，说明整机流量已被代理接管（TUN / 全局模式），不存在分叉。" ""
    else
      add network pass "统一出口" "全部流量经代理出网（$_vip${_vcity:+ · $_vcity}${_vorg:+ · $_vorg}）" \
        "虚拟机所有出站请求都从这一个出口出去：IP、ASN、地理、Cloudflare 边缘节点彼此自洽。" ""
    fi
  else
  _direct=$(curl -s --max-time 8 --noproxy '*' https://ipinfo.io/json 2>/dev/null)
  _via=$(curl -s --max-time 8 -x "$ROUTER" https://ipinfo.io/json 2>/dev/null)
  _dip=$(_pick "$_direct" ip)
  _vip=$(_pick "$_via" ip)
  if [ -z "$_vip" ]; then
    add network warn "白名单隔离" "本地路由无响应" \
      "经路由访问普通站点没有回包，说明本地路由没有在运行。" \
      "重新点「启动虚拟环境」；若仍无响应，先「停止」再「启动」。"
  elif [ -z "$_dip" ]; then
    add network info "白名单隔离" "无法比对（直连不通）" \
      "本机直连探测失败，可能当前网络受限。" ""
  elif [ "$_vip" = "$_dip" ]; then
    add network pass "白名单隔离" "非 Anthropic 流量未走代理" \
      "经路由访问普通网站时出口与直连一致，说明分流生效、没有泄漏。" ""
  else
    add network fail "白名单隔离" "疑似泄漏（路由=$_vip 直连=$_dip）" \
      "非白名单流量也被送进了代理，所有流量共用同一出口。" \
      "检查白名单格式是否被改坏（应为 \".anthropic.com,.claude.com,...\"）。"
  fi
  fi

  # Anthropic 是否经代理可达
  _code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 -x "$PROXY_EP" https://api.anthropic.com 2>/dev/null)
  if [ -n "$_code" ] && [ "$_code" != "000" ]; then
    add network pass "Anthropic 可达" "HTTP $_code" \
      "经代理（$PROXY_EP）访问 api.anthropic.com 成功，链路完整。" ""
  else
    add network fail "Anthropic 可达" "无响应" \
      "经代理（$PROXY_EP）访问 api.anthropic.com 失败，Claude Code 会直接不可用。" \
      "检查上游代理是否在运行、端口是否正确、是否开启「允许局域网连接」。"
  fi
  # claude.ai 是否被 Cloudflare 人机校验拦着
  # 注意这不是「网络不通」：CF 会回 403 + `cf-mitigated: challenge`，而且响应头带
  # `cross-origin-resource-policy: same-origin` —— 浏览器里任何跨域探活都会被直接判失败，
  # 表现得和「超时」一模一样。公开检测站给的分就是从这里来的，跟延迟无关。
  _ua='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
  _ca=$(curl -sI --max-time 10 -A "$_ua" -x "$PROXY_EP" https://claude.ai/ 2>/dev/null)
  if printf '%s' "$_ca" | grep -qi 'cf-mitigated:[[:space:]]*challenge'; then
    add network warn "claude.ai 人机校验" "被 CF 挑战（403）" \
      "Cloudflare 把当前节点判为可疑，会先弹人机校验；浏览器的跨域探活会被它的 CORP 头挡掉，看起来像超时。" \
      "换住宅/ISP 节点可显著缓解；网页里遇到验证码属正常，通过即可继续登录。"
  elif printf '%s' "$_ca" | grep -qE '^HTTP/[0-9.]+ 200'; then
    add network pass "claude.ai 人机校验" "未触发" \
      "claude.ai 直接返回页面，当前节点没有被判为可疑。" ""
  fi

  # 多源出口一致性：同一时刻问三个独立源，它们必须给出同一个 IP。
  # 这条判据是我们自己算的，不依赖任何检测站 —— 「有没有分叉」必须能自己复现
  #（公开检测站那条 +15 是它自己没带客户端 IP 去查，不作数）。
  _s1=$(curl -s --max-time 8 -x "$PROXY_EP" https://api.ipify.org 2>/dev/null | tr -d '[:space:]')
  _s2=$(curl -s --max-time 8 -x "$PROXY_EP" https://ipinfo.io/ip 2>/dev/null | tr -d '[:space:]')
  _s3=$(curl -s --max-time 8 -x "$PROXY_EP" https://api.ip.sb/ip 2>/dev/null | tr -d '[:space:]')
  _uniq=$(printf '%s\n%s\n%s\n' "$_s1" "$_s2" "$_s3" | grep -E '^[0-9a-fA-F:.]{7,}$' | sort -u | tr '\n' ' ')
  _n=$(printf '%s' "$_uniq" | wc -w | tr -d ' ')
  if [ "${_n:-0}" -eq 0 ]; then
    add network warn "多源出口一致性" "无法验证" \
      "三个 IP 情报源都没有返回地址，可能代理只放行了部分域名。" ""
  elif [ "$_n" -eq 1 ]; then
    add network pass "多源出口一致性" "三源一致 → ${_uniq% }" \
      "ipify / ipinfo / ip.sb 在同一时刻给出同一个出口，说明没有分叉。" ""
  else
    add network fail "多源出口一致性" "出现 ${_n} 个出口：${_uniq% }" \
      "不同网站看到的出口 IP 不一致，这是真正的分叉（规则把部分域名送去了别的节点）。" \
      "把代理切到全局/统一出口，或检查「按域名分流」规则。"
  fi

  # 系统 DNS：只判断「有没有企业后缀污染」以及「本地解析是否真的影响业务」。
  # 预演结论：走 HTTP 代理的 HTTPS 用 CONNECT，域名在**代理侧**解析；本地 getent 的结果
  # 根本不参与。熔断删掉默认路由后，本地给的内网黑洞地址直连也不可达，因此不是泄漏点。
  # 所以不再建议改成 1.1.1.1 / 8.8.8.8 —— 那样反而会在熔断后造成解析超时。
  _ns=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null)
  _res=$(getent hosts claude.ai 2>/dev/null | awk '{print $1; exit}')
  _sfx=$(grep -E '^(search|domain)[[:space:]]' /etc/resolv.conf 2>/dev/null | head -1)
  if [ -n "$_sfx" ]; then
    add network warn "系统 DNS" "残留企业后缀 ${_sfx#* }" \
      "WSL 把宿主网卡的 DNS 搜索域写进了 resolv.conf。检测站看不到它，但它会混进诊断包与应用日志，暴露企业内网归属。" \
      "重启环境让 entrypoint 自动清掉；或在 /etc/wsl.conf 加 [network] generateResolvConf=false。"
  else
    case "$_res" in
      "") add network info "系统 DNS" "本地未解析（nameserver ${_ns:-未知}）" \
            "本地 DNS 解析不出 claude.ai；走代理的业务流量由 CONNECT 远程解析，不受影响。" "" ;;
      10.*|127.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*)
          add network info "系统 DNS" "本地 → $_res（已隔离）" \
            "本地 DNS 把域名指向内网黑洞，但走代理的 HTTPS 在代理侧解析，且熔断后该地址直连不可达，不构成泄漏。无需改 nameserver。" "" ;;
      *)  add network pass "系统 DNS" "$_res（无企业后缀）" \
            "本地解析正常，resolv.conf 也没有宿主继承的企业搜索域。" "" ;;
    esac
  fi

  # 代理远程解析：真的发一次经代理的 HTTPS，证明域名是在代理侧解析的
  if [ -n "$UP" ]; then
    _rcode=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 4 --max-time 10 \
             -x "$UP" https://api.anthropic.com 2>/dev/null)
    if [ -n "$_rcode" ] && [ "$_rcode" != "000" ]; then
      add network pass "代理远程解析" "HTTP $_rcode（CONNECT 成功）" \
        "域名由代理侧解析，本地 /etc/resolv.conf 的结果不参与业务流量；DNS 不会暴露本机网络归属。" ""
    else
      add network warn "代理远程解析" "经代理连接失败" \
        "代理不可用或不允许 CONNECT，业务流量此刻无法出网。" \
        "检查上游代理端口与 Allow LAN；熔断状态下网络会保持切断，不会回落直连。"
    fi
  fi
else
  add network info "代理" "未配置（全部直连）" \
    "所有流量直接出网，出口即本机网络所在地区。" \
    "若本机网络不在 Claude 支持地区，建议在左侧填入代理地址。"
fi

# ------------------------------------------------------------
# 2.4) 网络熔断（fail-closed）
#      状态文件只是「守卫自己怎么说」，不能全信：再直接问一次内核路由表，
#      并真的发一发绕过代理的请求，确认它出不去。
#      环境没运行时不判 fail —— 那时压根没在用 Claude，报一堆高危反而误导。
# ------------------------------------------------------------
if [ "$RUNTIME_UP" != "1" ]; then
  add network info "网络熔断" "环境未运行" \
    "虚拟环境启动后才会启用 fail-closed 熔断；当前网络状态不代表运行时的保护状态。" \
    "先点「启动虚拟环境」，再运行自检查看熔断分项。"
else
_GS=/run/claude-vm/net-guard.state
_kv() { sed -n "s/^$1=//p" "$_GS" 2>/dev/null | head -1 | sed 's/^"//; s/"$//'; }
_GUARD_STATE="$([ -f "$_GS" ] && _kv state || echo missing)"
_GUARD_REASON="$([ -f "$_GS" ] && _kv reason || echo unknown)"
_GUARD_MSG="$([ -f "$_GS" ] && _kv message || echo '没有读到守卫状态')"
_GUARD_TS="$([ -f "$_GS" ] && _kv ts || echo 0)"

case "$_GUARD_STATE" in
  guarded)
    add network pass "网络熔断" "已锁定（fail-closed）" \
      "默认路由已移除、IPv6 已关闭：非代理目标内核直接不可达，代理断开时不会回落到本机直连。" "" ;;
  blocked)
    add network fail "网络熔断" "已封锁 · $_GUARD_REASON" \
      "$_GUARD_MSG" "按提示修好代理后，点「停止」再「启动」重新预检；这期间网络保持切断。" ;;
  proxy_down)
    add network warn "网络熔断" "代理断开 · 网络已切断" \
      "代理探活连续失败，但路由封锁仍在，流量不会改走本机直连（这正是预期保护）。" \
      "检查代理软件是否还在运行；恢复后看门狗会自动重跑预检。" ;;
  off)
    add network fail "网络熔断" "已关闭（NET_GUARD=off）" \
      "熔断被显式关闭，代理一旦断开，流量会直接走本机网络出网，真实环境会暴露。" \
      "在高级设置里把「网络熔断」改回 strict（推荐）。" ;;
  *)
    add network warn "网络熔断" "守卫未运行" \
      "没有读到 net-guard.state，无法确认网络是否被强制约束在代理链路上。" \
      "点「停止」再「启动」让 entrypoint 拉起 net-guard；反复如此说明脚本没同步成功。" ;;
esac

_RS=$(python3 /opt/scripts/net-guard.py status 2>/dev/null)
_locked=$(printf '%s' "$_RS" | sed -n 's/.*"locked": *\([a-z]*\).*/\1/p')
_v6off=$(printf '%s' "$_RS" | sed -n 's/.*"ipv6_disabled": *\([a-z]*\).*/\1/p')
if [ "$_locked" = "true" ] && [ "$_v6off" = "true" ]; then
  add network pass "直连封锁验证" "IPv4 默认路由已移除 · IPv6 已关闭" \
    "内核路由表里没有直连出口；只封 IPv4 而漏掉 IPv6 是最常见的泄漏口，这里一并堵住。" ""
else
  add network fail "直连封锁验证" "IPv4 locked=${_locked:-未知} / IPv6 off=${_v6off:-未知}" \
    "网络层没有完全封锁，代理断开时流量可能从直连或 IPv6 出网。" \
    "点「停止」再「启动」让 net-guard 重新熔断；反复失败请确认以 root 运行、CAP_NET_ADMIN 未被禁用。"
fi

if curl -s --max-time 4 --noproxy '*' https://ipinfo.io/ip >/dev/null 2>&1; then
  add network fail "直连泄漏实测" "仍可出网（高危）" \
    "显式绕过代理后依然能访问外网，说明存在没走代理的流量。" \
    "立即停止使用并重启虚拟环境；确认 NET_GUARD=strict 且 net-guard 正在运行。"
else
  add network pass "直连泄漏实测" "已阻断" \
    "绕过代理的请求无法出网，链路是真正的 fail-closed。" ""
fi

case "$_GUARD_REASON" in
  ok)
    add network pass "代理预检" "通过 · 出口 $([ -f "$_GS" ] && _kv exit_ip || echo 未知)/$([ -f "$_GS" ] && _kv exit_country || echo 未知)" \
      "代理可达、出口地区安全、多源出口一致、Anthropic 可达，预检通过后网络才允许使用。" "" ;;
  skipped|unknown|"")
    add network info "代理预检" "未执行" \
      "熔断关闭或守卫尚未运行时没有预检结果，此时无法保证代理配置正确。" "" ;;
  *)
    add network fail "代理预检" "$_GUARD_REASON" "$_GUARD_MSG" \
      "修好代理后重新启动；预检不通过时网络保持切断，不会带病放行。" ;;
esac

_now=$(date +%s)
if [ -f "$_GS" ] && [ -n "$_GUARD_TS" ] && [ "$_GUARD_STATE" != "off" ]; then
  _age=$((_now - _GUARD_TS))
  if [ "$_age" -gt 30 ]; then
    add network warn "守卫心跳" "已停滞 ${_age} 秒" \
      "看门狗超过 30 秒没有刷新状态，熔断规则可能已失去周期性 re-assert 保护。" \
      "点「停止」再「启动」重建会话。"
  else
    add network pass "守卫心跳" "正常（${_age} 秒前刷新）" \
      "看门狗在持续确认默认路由没有被 WSL 重新加回来。" ""
  fi
fi
fi

# ------------------------------------------------------------
# 2.5) 中文输入法（可选，仅 INPUT_METHOD=rime 时要求 XIM 正常）
# ------------------------------------------------------------
_IM="${INPUT_METHOD:-off}"
if [ "$_IM" != "rime" ]; then
  add desktop info "中文输入法" "未启用" \
    "WSLg 不转发 Windows IME 组合事件；中文可用宿主输入法打好后 Ctrl+Shift+V 粘贴。" ""
elif ! ls /usr/lib/*/gtk-3.0/*/immodules/im-ibus.so >/dev/null 2>&1; then
  # 1.0.31：XIM 已不是主链路，缺 GTK 原生模块才是「终端打不出中文」的真因
  add desktop warn "中文输入法" "已启用但缺 GTK 输入模块" \
    "没有 ibus-gtk3，lxterminal / Chrome 会降级到 XIM：终端可能一个中文都打不进，候选框不跟随光标。" \
    "点「停止」再「启动」，rime-setup 会按需补装 ibus-gtk3（仅 80KB）。"
elif xprop -root XIM_SERVERS 2>/dev/null | grep -q '@server=ibus'; then
  add desktop pass "中文输入法" "IBus + Rime（GTK 原生 + XIM 兼容）" \
    "输入法跑在虚拟机内部；1.0.31 起 GTK 应用经 ibus-gtk3 走 D-Bus，候选框跟随光标、Pango 正确渲染中文。" ""
else
  add desktop warn "中文输入法" "已启用但 IBus 服务未就绪" \
    "ibus-daemon 没能注册到 X root，终端里可能打不出中文。" \
    "点「停止」再「启动」重建会话；反复失败查看 /tmp/ibus-daemon.log。"
fi

# 出口信息：优先经代理探测；代理不通时退回直连，并如实标注
_egress_via="代理"
_eg=$(curl -s --max-time 10 $PROXY_ARG https://ipinfo.io/json 2>/dev/null)
_eip=$(_pick "$_eg" ip)
if [ -z "$_eip" ]; then
  _eg=$(curl -s --max-time 10 --noproxy '*' https://ipinfo.io/json 2>/dev/null)
  _eip=$(_pick "$_eg" ip)
  [ -n "$_eip" ] && _egress_via="直连"
fi
_ecc=$(_pick "$_eg" country)
_eorg=$(_pick "$_eg" org)
_ecity=$(_pick "$_eg" city)

if [ -z "$_eip" ]; then
  add network warn "出口 IP" "无法探测" \
    "代理与直连都拿不到出口信息，无法判断实际落地地区。" \
    "确认本机网络与上游代理是否可用。"
elif [ -n "$UP" ] && [ "$_egress_via" = "直连" ]; then
  add network warn "出口 IP" "$_eip（直连）" \
    "代理不通，这是本机直连的出口；Claude Code 实际上无法出网。" \
    "先修好上游代理（端口、Allow LAN），再看这一项。"
else
  _edet=""
  [ -n "$_ecity" ] && _edet="位于 $_ecity"
  [ -n "$_eorg" ] && _edet="${_edet}${_edet:+，}归属 $_eorg"
  add network pass "出口 IP" "$_eip" "$_edet" ""
fi

# 出口类型：机房 IP 是 Cloudflare 判定自动化的主要依据
HOSTING_RE='Amazon|Google|Microsoft|Cloudflare|Vultr|Constant Company|Choopa|DigitalOcean|Linode|Hetzner|OVH|Contabo|Tencent|Alibaba|Aliyun|Oracle|Akamai|Leaseweb|M247|Hostinger|Scaleway|UpCloud|ColoCrossing|FranTech|BuyVM|Psychz|Quadranet|Cogent|SoftLayer|Rackspace|Kamatera|Ionos|Gcore|Clouvider|DataCamp|Zenlayer|UCloud|Huawei'
if [ -n "$_eorg" ] && { [ -z "$UP" ] || [ "$_egress_via" = "代理" ]; }; then
  if printf '%s' "$_eorg" | grep -qiE "$HOSTING_RE"; then
    if [ "$ALL_ON" = 1 ]; then
      add network warn "出口类型" "机房 IP（IDC / 云主机）" \
        "这是你选的代理节点本身的属性，不是本地环境的问题：真的在那种服务器上用 Claude Code 也是这个结果。" \
        "想换掉只能改用住宅/ISP 节点的代理；在此之前保持时区、语言与节点所在地区一致即可。"
    else
      add network warn "出口类型" "机房 IP（IDC / 云主机）" \
        "Anthropic 与 Cloudflare 会把机房 IP 视为非家庭网络，是当前最明显的风险点。" \
        "条件允许时换成住宅或 ISP 静态代理，并让它与账号地区一致；这比任何本地改造都有效。"
    fi
  else
    # 名字不在名单里不等于「家庭宽带」：NTT / Cogent 这类骨干与托管商的段，
    # 检测站照样按 IP 段判数据中心（实测 NTT America 就是 +13）。
    # 所以这里只陈述事实，不替对方下结论。
    # 名字不在名单里 ≠ 家庭宽带：NTT / Cogent 这类骨干与托管商的段，检测站照样按 IP 段
    # 判数据中心（实测 AS2914 NTT America 就是 +13 分）。旧版给 pass 是虚假安心。
    add network warn "出口类型" "骨干/托管网段（$_eorg）" \
      "组织名不在已知机房名单里，但检测站按 IP 段判数据中心：41 分里的 13 分就来自这里。这是商业 VPN 节点的固有属性，不是本地配置错误。" \
      "只有换住宅/ISP 节点才能去掉；不要为它改时区或语言，那会制造真正的不一致。"
  fi
fi

# ------------------------------------------------------------
# 3.9. check-cc 口径自评：把它报告顶上那个百分比自己算出来
# ------------------------------------------------------------
# 它的评分结构已经解出来了：那个百分比 = signals[].contribution 之和，
# weight 是该项最多扣多少。这两个字段在返回体里是**明文数字**
#（只有 label / value 被 "Z_" 前缀加密），所以不用解密就能自己求和。
#
# 为什么要自己算：checkcc 只跑一遍浏览器，每次都得靠用户截图；而这里可以经同一条
# 代理直接问它，把「服务端能观测到的」量出来，再补上只有浏览器才测得到的项。
# 请求头必须伪装完整 —— 少了 Accept / sec-ch-ua / Sec-Fetch-* 这些，它会额外判
# 「请求头完整性偏低」再扣 8 分，那是 curl 的特征，不是用户的。
CC_SERVER=0; CC_BROWSER=0; CC_TOTAL=0
if [ -n "$UP" ] && [ -n "${_eip:-}" ]; then
  _ccjson=$(curl -s --compressed --max-time 15 -x "$PROXY_EP" \
    -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36' \
    -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' \
    -H 'Accept-Language: en-US,en;q=0.9' \
    -H 'Accept-Encoding: gzip, deflate, br' \
    -H 'sec-ch-ua: "Chromium";v="156", "Not_A Brand";v="24"' \
    -H 'sec-ch-ua-mobile: ?0' -H 'sec-ch-ua-platform: "Linux"' \
    -H 'Sec-Fetch-Site: none' -H 'Sec-Fetch-Mode: navigate' \
    -H 'Sec-Fetch-User: ?1' -H 'Sec-Fetch-Dest: document' \
    -H 'Upgrade-Insecure-Requests: 1' -H 'Referer: https://checkcc.org/' \
    "https://api.checkcc.org/check?region=cn&lang=en-US&t=$(date +%s)000" 2>/dev/null)
  CC_SERVER=$(printf '%s' "$_ccjson" | grep -oE '"n9Uy":[[:space:]]*[0-9]+' \
    | grep -oE '[0-9]+$' | awk '{s+=$1} END{printf "%d", s+0}')
  if [ "${CC_SERVER:-0}" -ge 1 ] && [ "${CC_SERVER:-0}" -le 100 ]; then
    # 浏览器侧还有一项 curl 测不到：claude.ai 的跨域探活。
    # 它以 fetch(mode:'no-cors') 打 https://claude.ai/，被 CF 挑战页的
    # `cross-origin-resource-policy: same-origin` 挡掉，前端记为异常 → 扣 6 分。
    printf '%s' "${_ca:-}" | grep -qi 'cf-mitigated:[[:space:]]*challenge' && CC_BROWSER=6
    CC_TOTAL=$((CC_SERVER + CC_BROWSER))
    case "${_n:-0}" in
      1) _pd="本轮本地三源一致（${_uniq% }）" ;;
      0) _pd="本轮本地三源都没返回地址" ;;
      *) _pd="本轮本地三源出现分叉：${_uniq% }" ;;
    esac
    add network info "checkcc 口径" "${CC_TOTAL} 分" \
      "服务端可观测 ${CC_SERVER} 分，加上浏览器侧 claude.ai 跨域探活 ${CC_BROWSER} 分，合计 ${CC_TOTAL} 分 —— 与检测站在浏览器里给出的百分比同源同算法。其中「多源 IP 情报（15）」「DNS 两项（5+2）」是它服务端自己去问那几个源得出的结论：${_pd}。" \
      "这 22 分本地无解（它查询时没带上客户端 IP，量到的是自己的 Cloudflare 出口）；剩下的是机房 IP 属性与 CF 挑战，只能换住宅节点。"
  else
    add network info "checkcc 口径" "未能取分" \
      "拿到了接口返回，但没能读出评分字段（它的字段名是混淆的，可能已改版）。" \
      "这不影响其它检查项；想核对分数请直接在浏览器里跑一次检测站。"
  fi
fi

# ------------------------------------------------------------
# 4. 一致性判断
#    只拦「出口落在受限地区」这个真风险。
#    「系统时区与出口国家不同」**不是**风险：台北用户为了加速/隐私挂商业 VPN 出境是日常，
#    风控若按此扣分，会把全球所有挂 VPN 的合法用户一起误杀。检测站实际抓的是被点名的
#    中国时区 / zh-CN / 名单内字体，不是时区与 IP 的地理匹配。
#    旧版这里有个 _expected_cc() 按时区反推期望国家，不匹配就判 fail 并建议改地区，
#    逻辑错误且映射表漏了 Asia/Taipei，导致默认台北画像下整项被静默跳过。1.0.25 删除。
# ------------------------------------------------------------
_ecc_u=$(printf '%s' "${_ecc:-}" | tr 'a-z' 'A-Z')
case ",$_ecc_u," in
  *,CN,*|*,HK,*|*,MO,*)
    add consistency fail "出口受限地区" "出口 ${_ecc}" \
      "出口落在 CN/HK/MO 受限名单内，多半是代理规则把该域名直连了。" \
      "把代理切到全局/统一出口，检查分流规则，然后重启环境。" ;;
  *)
    if [ -n "$_ecc" ]; then
      add consistency pass "出口地区" "${_ecc}（系统 ${TZ:-未知}）" \
        "出口不在受限名单内。时区与出口国家不同是正常的 VPN 使用形态，不做一致性扣分。" ""
    else
      add consistency info "出口地区" "出口未知" \
        "出口地区探测失败，无法判断；代理不可用时熔断会保持网络切断。" ""
    fi ;;
esac

if [ -n "$_ecc" ]; then
  add consistency info "时区 ↔ 出口地区" "系统 ${TZ:-未知} / 出口 ${_ecc}" \
    "两者分属不同地区不构成信号矛盾：挂 VPN 出境是当地用户日常；检测站判的是被点名的中国时区，不是地理匹配。不要为了「对齐」去改系统时区，那反而会制造真正的不一致。" ""
fi

# 白名单是否覆盖登录所需域名（漏掉会让登录走直连 → 出现「两个国家」）
WL="${PROXY_WHITELIST:-.anthropic.com,.claude.com,.claude.ai,.claudeusercontent.com,clau.de}"
_missing=""
for _d in anthropic.com claude.com claude.ai claudeusercontent.com; do
  case "$WL" in *"$_d"*) ;; *) _missing="$_missing $_d" ;; esac
done
if [ "$ALL_ON" = 1 ]; then
  add consistency pass "白名单覆盖" "全量模式，无需白名单" \
    "所有流量都经同一个出口出去，不存在「登录走代理、API 走直连」的矛盾。" ""
elif [ -z "$_missing" ]; then
  add consistency pass "白名单覆盖" "登录与 API 域名齐全" \
    "登录、控制台、API 走同一个代理出口，不会出现地区矛盾。" ""
else
  add consistency warn "白名单覆盖" "缺少:$_missing" \
    "这些域名会走直连，登录流量与 API 流量出口不同，容易被判异常。" \
    "在左侧白名单里补齐缺失的域名（用逗号分隔）。"
fi

# ------------------------------------------------------------
# 输出
# ------------------------------------------------------------
emit_text() {
  echo "环境一致性自检 · 目标地区 $REGION_LABEL"
  echo "────────────────────────────────────────────────────────"
  [ "$RUNTIME_UP" -eq 0 ] && echo "⚠ 虚拟环境当前未运行，部分项目无法检测。"
  _last=""
  for _rec in "${ITEMS[@]}"; do
    IFS="$US" read -r _g _st _lb _val _det _adv <<< "$_rec"
    if [ "$_g" != "$_last" ]; then echo; echo "▸ $(gtitle "$_g")"; _last="$_g"; fi
    case "$_st" in
      pass) _i="✔" ;; warn) _i="!" ;; fail) _i="✘" ;; *) _i="·" ;;
    esac
    echo "  $_i $_lb · $_val"
    if [ "$_st" != "pass" ] && [ -n "$_det" ]; then echo "      $_det"; fi
    if [ -n "$_adv" ]; then echo "      → $_adv"; fi
  done
  echo
  echo "────────────────────────────────────────────────────────"
  echo "汇总：通过 $PASS · 注意 $WARN · 失败 $FAIL · 信息 $INFO"
  if [ "$FAIL" -gt 0 ]; then
    echo "结论：存在必修项，修好再登录 Claude。"
  elif [ "$WARN" -gt 0 ]; then
    echo "结论：可正常使用，但有 $WARN 项值得留意。"
  else
    echo "结论：各维度一致，环境状态良好。"
  fi
  echo "说明：本脚本只校对本地环境，不代表 Anthropic 的判定结果。"
}

emit_json() {
  _order=()
  for _rec in "${ITEMS[@]}"; do
    _g="${_rec%%"$US"*}"
    _seen=0
    for _o in ${_order[@]+"${_order[@]}"}; do [ "$_o" = "$_g" ] && _seen=1; done
    [ "$_seen" -eq 0 ] && _order+=("$_g")
  done

  printf '{"version":1,"runtimeUp":%s,"regionLabel":"%s","tz":"%s","lang":"%s",' \
    "$RUNTIME_UP" "$(jesc "$REGION_LABEL")" "$(jesc "${TZ:-}")" "$(jesc "${LANG:-}")"
  # 检测站口径的自评分数（0 = 未取到）。界面直接显示，省得用户再去网站跑一遍。
  printf '"checkcc":{"total":%s,"serverSide":%s,"browserSide":%s},' \
    "${CC_TOTAL:-0}" "${CC_SERVER:-0}" "${CC_BROWSER:-0}"
  printf '"summary":{"pass":%d,"warn":%d,"fail":%d,"info":%d},"groups":[' \
    "$PASS" "$WARN" "$FAIL" "$INFO"

  _fg=1
  for _g in "${_order[@]}"; do
    [ "$_fg" -eq 1 ] || printf ','
    _fg=0
    printf '{"id":"%s","title":"%s","items":[' "$(jesc "$_g")" "$(jesc "$(gtitle "$_g")")"
    _fi=1
    for _rec in "${ITEMS[@]}"; do
      [ "${_rec%%"$US"*}" = "$_g" ] || continue
      IFS="$US" read -r _gg _st _lb _val _det _adv <<< "$_rec"
      [ "$_fi" -eq 1 ] || printf ','
      _fi=0
      printf '{"label":"%s","status":"%s","value":"%s","detail":"%s","advice":"%s"}' \
        "$(jesc "$_lb")" "$_st" "$(jesc "$_val")" "$(jesc "$_det")" "$(jesc "$_adv")"
    done
    printf ']}'
  done
  printf ']}\n'
}

if [ "$MODE" = "json" ]; then emit_json; else emit_text; fi
