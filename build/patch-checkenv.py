import io, sys

p = 'E:/Web/FuckCladue/claude-vm/vm/scripts/check-env.sh'
s = io.open(p, encoding='utf-8').read()
orig = s

# --- 1) 在 UP 定义后加入隧道识别 ---
old1 = '''PROXY_ARG=""
[ -n "$UP" ] && PROXY_ARG="-x $UP"
'''
new1 = '''PROXY_ARG=""
[ -n "$UP" ] && PROXY_ARG="-x $UP"

# 出口隧道：PROXY_MODE=all 且配置了 VPS 时，整台机器都从 VPS 出网。
# 此时「只有白名单走代理」的前提不再成立，判断逻辑要换一套。
TUNNEL_ON=0
if [ "${PROXY_MODE:-whitelist}" = "all" ] && [ -n "${TUNNEL_HOST:-}" ]; then
  TUNNEL_ON=1
fi
TSTATE=/run/claude-vm/tunnel.state
_tval() { sed -n "s/^$1=//p" "$TSTATE" 2>/dev/null | head -1; }
'''
assert old1 in s
s = s.replace(old1, new1, 1)

# --- 2) 白名单隔离 → 隧道模式分支 ---
old2 = '''  # 非白名单站点应直连（ipinfo 不在白名单里）
  _direct=$(curl -s --max-time 8 --noproxy '*' https://ipinfo.io/json 2>/dev/null)
  _via=$(curl -s --max-time 8 -x "$ROUTER" https://ipinfo.io/json 2>/dev/null)
  _dip=$(_pick "$_direct" ip)
  _vip=$(_pick "$_via" ip)
  if [ -z "$_vip" ]; then
    add network warn "白名单隔离" "本地路由无响应" \\
      "经路由访问普通站点没有回包，说明本地路由没有在运行。" \\
      "重新点「启动虚拟环境」；若仍无响应，先「停止」再「启动」。"
  elif [ -z "$_dip" ]; then
    add network info "白名单隔离" "无法比对（直连不通）" \\
      "本机直连探测失败，可能当前网络受限。" ""
  elif [ "$_vip" = "$_dip" ]; then
    add network pass "白名单隔离" "非 Anthropic 流量未走代理" \\
      "经路由访问普通网站时出口与直连一致，说明分流生效、没有泄漏。" ""
  else
    add network fail "白名单隔离" "疑似泄漏（路由=$_vip 直连=$_dip）" \\
      "非白名单流量也被送进了代理，所有流量共用同一出口。" \\
      "检查白名单格式是否被改坏（应为 \\".anthropic.com,.claude.com,...\\"）。"
  fi
'''
new2 = '''  if [ "$TUNNEL_ON" = 1 ]; then
    # 全量隧道模式：所有流量（含非白名单）都应当从 VPS 出去
    _tst=$(_tval state); _tip=$(_tval exit_ip); _terr=$(_tval error)
    _via=$(curl -s --max-time 10 -x "$ROUTER" https://ipinfo.io/json 2>/dev/null)
    _vip=$(_pick "$_via" ip)
    if [ "$_tst" != "up" ]; then
      add network fail "出口隧道" "未建立（${_terr:-${_tst:-无状态}}）" \\
        "隧道没起来，流量退回了宿主代理或直连，出口地区与 VPS 不一致。" \\
        "先点「测试出口」确认地址与账号；再确认该服务器允许你的 IP 连接 SSH。"
    elif [ -z "$_vip" ]; then
      add network warn "出口隧道" "已连通，但本地路由无响应" \\
        "隧道在，但经过路由器的流量没有回包。" \\
        "重新点「启动虚拟环境」。"
    elif [ -n "$_tip" ] && [ "$_vip" != "$_tip" ]; then
      add network fail "出口隧道" "路由出口 $_vip ≠ 隧道出口 $_tip" \\
        "仍有一部分流量没走隧道，出现了两个出口。" \\
        "检查是否有程序绕过代理直连（NO_PROXY / 硬编码直连）。"
    else
      add network pass "出口隧道" "全部流量经 VPS 出网（${_tip:-$_vip}）" \\
        "整台虚拟机的出口就是那台服务器：IP、ASN、地理、Cloudflare 边缘节点都来自它。" ""
    fi
  else
  # 非白名单站点应直连（ipinfo 不在白名单里）
  _direct=$(curl -s --max-time 8 --noproxy '*' https://ipinfo.io/json 2>/dev/null)
  _via=$(curl -s --max-time 8 -x "$ROUTER" https://ipinfo.io/json 2>/dev/null)
  _dip=$(_pick "$_direct" ip)
  _vip=$(_pick "$_via" ip)
  if [ -z "$_vip" ]; then
    add network warn "白名单隔离" "本地路由无响应" \\
      "经路由访问普通站点没有回包，说明本地路由没有在运行。" \\
      "重新点「启动虚拟环境」；若仍无响应，先「停止」再「启动」。"
  elif [ -z "$_dip" ]; then
    add network info "白名单隔离" "无法比对（直连不通）" \\
      "本机直连探测失败，可能当前网络受限。" ""
  elif [ "$_vip" = "$_dip" ]; then
    add network pass "白名单隔离" "非 Anthropic 流量未走代理" \\
      "经路由访问普通网站时出口与直连一致，说明分流生效、没有泄漏。" ""
  else
    add network fail "白名单隔离" "疑似泄漏（路由=$_vip 直连=$_dip）" \\
      "非白名单流量也被送进了代理，所有流量共用同一出口。" \\
      "检查白名单格式是否被改坏（应为 \\".anthropic.com,.claude.com,...\\"）。"
  fi
  fi
'''
assert old2 in s, 'block 2 not found'
s = s.replace(old2, new2, 1)

# --- 3) 出口类型：隧道时说明这是 VPS 固有属性 ---
old3 = '''    add network warn "出口类型" "机房 IP（IDC / 云主机）" \\
      "Anthropic 与 Cloudflare 会把机房 IP 视为非家庭网络，是当前最明显的风险点。" \\
      "条件允许时换成住宅或 ISP 静态代理，并让它与账号地区一致；这比任何本地改造都有效。"'''
new3 = '''    if [ "$TUNNEL_ON" = 1 ]; then
      add network warn "出口类型" "机房 IP（IDC / 云主机）" \\
        "这是 VPS 出口的固有属性：真的在 VPS 上装 Claude Code 也是这个结果，不必再修。" \\
        "想彻底消除只能换住宅 IP；在此之前保持时区、语言与 VPS 所在地区一致即可。"
    else
      add network warn "出口类型" "机房 IP（IDC / 云主机）" \\
        "Anthropic 与 Cloudflare 会把机房 IP 视为非家庭网络，是当前最明显的风险点。" \\
        "条件允许时换成住宅或 ISP 静态代理，并让它与账号地区一致；这比任何本地改造都有效。"
    fi'''
assert old3 in s, 'block 3 not found'
s = s.replace(old3, new3, 1)

# --- 4) 白名单覆盖：隧道全量模式下不再是问题 ---
old4 = '''if [ -z "$_missing" ]; then'''
new4 = '''if [ "$TUNNEL_ON" = 1 ]; then
  add consistency pass "白名单覆盖" "全量模式，无需白名单" \\
    "所有流量都经 VPS 出去，不存在「登录走代理、API 走直连」的矛盾。" ""
elif [ -z "$_missing" ]; then'''
assert old4 in s
s = s.replace(old4, new4, 1)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('patched, %d -> %d bytes' % (len(orig), len(s)))
