#!/usr/bin/env bash
# ============================================================
# net-guard.sh — 代理强制链路的「启动预检 + 运行看门狗」
#
# 目标（用户原话）：
#   1) 保证网络一直通过代理走，代理断了就直接中断网络；
#   2) 本地代理没配置好，也不能让环境被检查出来。
#
# 顺序是刻意的，别调换：
#   [0] 立刻 lock 路由（纯 netlink，毫秒级）→ 此刻起只有代理这一条路
#   [1] 才做网络预检 —— 所有探测都经代理，直连已经被掐死，探测本身不会泄漏
#   [2] 验证「直连确实不通」，通了就是熔断失效，直接判 blocked
#   如果把预检放前面，Claude Code 终端可能在预检那几秒里已经发请求出去了。
#
# 代理断了会怎样：
#   不需要任何「检测到再断网」的动作 —— 路由表里根本没有直连那条路，
#   代理一断，所有连接内核直接 ENETUNREACH。看门狗只负责把状态告诉界面、
#   以及防止 WSL 把默认路由偷偷加回来。代理恢复后网络自动可用。
#
# 状态文件 /run/claude-vm/net-guard.state（KV，可被 shell source / 客户端读取）
#   state=guarded|blocked|proxy_down|off
#   reason=ok|no-proxy|proxy-unreachable|exit-region-risk|split-exit|
#          anthropic-unreachable|leak-detected|lock-failed
# ============================================================

GUARD_DIR=/run/claude-vm
STATE="$GUARD_DIR/net-guard.state"
PIDFILE="$GUARD_DIR/net-guard.pid"
PY=/opt/scripts/net-guard.py
LOG_PREFIX="[net-guard]"

# 客户端传入：strict（默认，强制熔断）/ off（退回旧行为，仅告警）
NET_GUARD="${NET_GUARD:-strict}"
# 出口落在这些地区时判为「代理没配好」。HK/MO 按 checkcc 口径属受限地区。
RISK_REGIONS="${NET_GUARD_RISK_REGIONS:-CN,HK,MO}"
# 出口地区风险是否硬阻断；设 0 只记 warn、仍放行（例如确定走的是国内中转+境外落地）
STRICT_REGION="${NET_GUARD_STRICT_REGION:-1}"
# 3 秒一轮 re-assert：WSL 在网络重置/休眠恢复时可能把默认路由加回来，
# 这是唯一需要周期性兜住的情况（代理断开本身不需要看门狗，路由表里就没那条路）。
INTERVAL="${NET_GUARD_INTERVAL:-3}"
MODE="${1:-daemon}"

mkdir -p "$GUARD_DIR"

# 代理地址以「实际生效」的那个为准：entrypoint 会把它写进 /opt/config/local-proxy。
# 全量模式下它就是上游；白名单模式下它是本地 router，两者都不能绕开。
PROXY_URL="$(cat /opt/config/local-proxy 2>/dev/null | tr -d '\r\n')"
[ -n "$PROXY_URL" ] || PROXY_URL="${HTTPS_PROXY:-${HTTP_PROXY:-}}"
PROXY_URL="${PROXY_URL%/}"

log() { echo "$LOG_PREFIX $*"; }

# 原子写状态：先写 tmp 再 mv。读的一方（自检/界面）永远不会读到半截文件。
write_state() {
  local st="$1" reason="$2" msg="$3" extra="${4:-}"
  local tmp="$STATE.tmp.$$"
  {
    echo "state=$st"
    echo "reason=$reason"
    echo "message=\"$msg\""
    echo "proxy=$PROXY_URL"
    echo "exit_ip=${EXIT_IP:-}"
    echo "exit_country=${EXIT_COUNTRY:-}"
    echo "exit_city=${EXIT_CITY:-}"
    echo "direct_leak=${DIRECT_LEAK:-unknown}"
    echo "preflight=${PREFLIGHT:-unknown}"
    echo "locked=${LOCKED:-0}"
    echo "ts=$(date +%s)"
    if [ -n "$extra" ]; then echo "$extra"; fi
  } > "$tmp"
  mv -f "$tmp" "$STATE"
}

guard_status() { python3 "$PY" status 2>/dev/null; }

# ------------------------------------------------------------
# 关闭模式：恢复路由，明确写状态，不做任何熔断
# ------------------------------------------------------------
if [ "$NET_GUARD" = "off" ]; then
  if guard_status | grep -q '"locked": *true'; then
    python3 "$PY" unlock >/dev/null 2>&1 && log "已按 NET_GUARD=off 恢复默认路由"
  fi
  PREFLIGHT=skipped LOCKED=0 write_state off disabled \
    "网络熔断已关闭：代理断开时流量可能直连出网，存在暴露真实环境的风险。"
  log "NET_GUARD=off，未启用熔断（不推荐）"
  exit 0
fi

# 防止同模式重启时叠多个看门狗
if [ -f "$PIDFILE" ]; then
  _old=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$_old" ] && [ "$_old" != "$$" ] && kill -0 "$_old" 2>/dev/null; then
    log "已有看门狗在跑（pid $_old），本次跳过"
    exit 0
  fi
fi
echo $$ > "$PIDFILE"
# 注意：退出时**不 unlock**。fail-closed 的语义就是「守卫死了，网络也应保持封锁」，
# 不能在脚本异常退出时把直连放回去。要恢复只有显式 NET_GUARD=off 或重启发行版。
trap 'rm -f "$PIDFILE"' EXIT INT TERM

# ------------------------------------------------------------
# [0] 先熔断。没配代理也要锁 —— 用一个不可达的占位地址，效果是全断网。
#     这正对应用户第 2 个诉求：代理没配好，宁可没网，也不能裸奔。
# ------------------------------------------------------------
NO_PROXY_CFG=0
if [ -z "$PROXY_URL" ]; then
  NO_PROXY_CFG=1
  LOCK_ARG="http://127.0.0.1:1"
  log "未配置代理：仍将封锁全部直连（fail-closed）"
else
  LOCK_ARG="$PROXY_URL"
fi

LOCK_OUT="$(python3 "$PY" lock "$LOCK_ARG" 2>&1)"
log "lock: $LOCK_OUT"
if printf '%s' "$LOCK_OUT" | grep -q '"ok": *true'; then
  LOCKED=1
else
  LOCKED=0
  LOCK_ERR="$(printf '%s' "$LOCK_OUT" | sed -n 's/.*"error": *"\([^"]*\)".*/\1/p')"
  PREFLIGHT=fail
  write_state blocked lock-failed "网络熔断失败，已拒绝放行：${LOCK_ERR:-未知错误}。请重启虚拟环境后重试。" \
    "lock_error=\"${LOCK_ERR:-unknown}\""
  log "熔断失败，保持拒绝状态：${LOCK_ERR:-未知错误}"
  # 熔断失败时绝不进入正常看门狗循环，但仍要周期性重试封锁
  while sleep "$INTERVAL"; do
    R="$(python3 "$PY" lock "$LOCK_ARG" 2>&1)"
    if printf '%s' "$R" | grep -q '"ok": *true'; then
      LOCKED=1
      log "重试熔断成功"
      break
    fi
  done
fi

# ------------------------------------------------------------
# [1] 预检 —— 此时直连已断，所有探测只能经代理，探测本身不会泄漏真实出口
#     全部并发，整体耗时约等于最慢的那一发（~10s），不串行叠加。
# ------------------------------------------------------------
preflight() {
  local T; T="$(mktemp -d)"
  local px=()
  if [ -n "$PROXY_URL" ]; then px=(-x "$PROXY_URL"); fi

  # --connect-timeout 是给「代理软件根本没开 / 端口填错」准备的：
  # 没有它，连接被静默丢包时要干等满 --max-time 才报错，用户盯着界面十秒没反馈。
  ( curl -s --connect-timeout 3 --max-time 10 "${px[@]}" https://ipinfo.io/json > "$T/via" 2>/dev/null ) &
  ( curl -s --connect-timeout 3 --max-time 8  "${px[@]}" https://api.ipify.org > "$T/s1" 2>/dev/null ) &
  ( curl -s --connect-timeout 3 --max-time 8  "${px[@]}" https://ipinfo.io/ip   > "$T/s2" 2>/dev/null ) &
  ( curl -s --connect-timeout 3 --max-time 8  "${px[@]}" https://api.ip.sb/ip  > "$T/s3" 2>/dev/null ) &
  ( curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 "${px[@]}" \
      https://api.anthropic.com > "$T/anth" 2>/dev/null ) &
  # 封锁验证：显式绕过代理，必须失败
  ( curl -s --connect-timeout 2 --max-time 4 --noproxy '*' https://ipinfo.io/ip > "$T/direct" 2>/dev/null ) &
  wait

  mapfile -t INFO < <(python3 - "$T" <<'PY'
import json, os, sys
d = sys.argv[1]
def load(n):
    try:
        return open(os.path.join(d, n)).read().strip()
    except OSError:
        return ''
def jget(s, k):
    try:
        return str(json.loads(s).get(k, '') or '').replace('\n', ' ')
    except Exception:
        return ''
v = load('via')
for k in ('ip', 'country', 'city', 'org'):
    print(jget(v, k))
# 三个独立情报源去重后的出口集合
ips = []
for n in ('s1', 's2', 's3'):
    x = load(n).split()[0] if load(n).split() else ''
    if x and x not in ips:
        ips.append(x)
print('|'.join(ips))
print(load('anth'))
print('yes' if load('direct') else 'no')   # yes = 直连仍能出网 = 泄漏
PY
)
  EXIT_IP="${INFO[0]:-}"
  EXIT_COUNTRY="${INFO[1]:-}"
  EXIT_CITY="${INFO[2]:-}"
  EXIT_ORG="${INFO[3]:-}"
  MULTI_IPS="${INFO[4]:-}"
  ANTH_CODE="${INFO[5]:-}"
  DIRECT_LEAK="${INFO[6]:-unknown}"
  rm -rf "$T"

  # 判定按严重度从高到低，第一个命中即返回
  if [ "$DIRECT_LEAK" = "yes" ]; then
    PF_REASON=leak-detected
    PF_MSG="熔断后直连仍能出网，网络层封锁失效，已拒绝放行。请检查虚拟环境是否以 root 运行、CAP_NET_ADMIN 是否被禁用。"
    return 1
  fi
  if [ "$LOCKED" != "1" ]; then
    PF_REASON=lock-failed
    PF_MSG="网络熔断未生效，已拒绝放行。"
    return 1
  fi
  if [ "$NO_PROXY_CFG" = "1" ]; then
    PF_REASON=no-proxy
    PF_MSG="未配置代理，网络已被完全切断。请在设置里填好代理地址（并确认代理软件已开启「允许局域网连接」）后重新启动。"
    return 1
  fi
  if [ -z "$EXIT_IP" ]; then
    PF_REASON=proxy-unreachable
    PF_MSG="经代理取不到出口信息：代理软件可能没开、端口填错，或没开启「允许局域网连接（Allow LAN）」。网络已保持切断，不会直连泄漏。"
    return 1
  fi
  case ",$RISK_REGIONS," in
    *",$EXIT_COUNTRY,"*)
      if [ "$STRICT_REGION" = "1" ]; then
        PF_REASON=exit-region-risk
        PF_MSG="代理出口落在受限地区（$EXIT_COUNTRY）。多半是代理规则把流量直连了，或选中的节点在国内。请切到全局模式 / 换境外节点后重启。"
        return 1
      fi
      ;;
  esac
  # 多源不一致 = 按域名分流，正是 checkcc「多源 IP」扣分项，也是最容易露馅的
  if [ -n "$MULTI_IPS" ] && printf '%s' "$MULTI_IPS" | grep -q '|'; then
    PF_REASON=split-exit
    PF_MSG="同一次检测出现多个出口（$MULTI_IPS），说明代理按域名分流、不同站点看到的 IP 不同。请把代理切到全局统一出口后重启。"
    return 1
  fi
  if [ -n "$ANTH_CODE" ] && [ "$ANTH_CODE" != "200" ] \
     && [ "$ANTH_CODE" != "301" ] && [ "$ANTH_CODE" != "302" ] \
     && [ "$ANTH_CODE" != "401" ] && [ "$ANTH_CODE" != "403" ] && [ "$ANTH_CODE" != "404" ]; then
    PF_REASON=anthropic-unreachable
    PF_MSG="经代理访问 api.anthropic.com 失败（HTTP ${ANTH_CODE:-000}）。Claude Code 会直接不可用，请检查代理规则。"
    return 1
  fi
  PF_REASON=ok
  PF_MSG="网络已锁定：仅允许经代理出网，代理断开即断网，不会回落到本机直连。出口 ${EXIT_IP}${EXIT_COUNTRY:+ · $EXIT_COUNTRY}${EXIT_CITY:+ · $EXIT_CITY}。"
  return 0
}

preflight
PF=$?
if [ "$PF" -eq 0 ]; then PREFLIGHT=pass; else PREFLIGHT=fail; fi
log "预检：$PF_REASON | $PF_MSG"

if [ "$PF" -eq 0 ]; then
  write_state guarded ok "$PF_MSG" "exit_org=\"${EXIT_ORG:-}\""
else
  # 预检失败也**不解锁**：路由本来就只通代理（或全断），这是最安全的状态。
  write_state blocked "$PF_REASON" "$PF_MSG"
fi

# 顺带把出口信息写回旧的 exit.state，保持界面/自检已有字段的兼容性
{
  echo "state=$([ "$PF" -eq 0 ] && echo up || echo down)"
  echo "exit_ip=${EXIT_IP:-}"
  echo "exit_org=${EXIT_ORG:-}"
  echo "exit_city=${EXIT_CITY:-}"
  echo "mode=${PROXY_MODE:-all}"
  echo "upstream=${PROXY_URL}"
} > "$GUARD_DIR/exit.state"

[ "$MODE" = "once" ] && exit "$PF"

# ------------------------------------------------------------
# [2] 看门狗：周期性 re-assert 熔断 + 探活 + 把状态告诉界面
#     探活失败不会去"断网"（网络早就断了），只把 state 改成 proxy_down；
#     代理恢复后重跑一次预检再回到 guarded。
# ------------------------------------------------------------
CONSEC_FAIL=0
while sleep "$INTERVAL"; do
  # WSL 有可能把默认路由重新加回来（网络重置 / 休眠恢复），每轮都重新确认。
  # lock 是幂等的：已锁时只 re-assert IPv6 与代理主机路由，不会重复删。
  R="$(python3 "$PY" lock "${LOCK_ARG}" 2>&1)"
  if printf '%s' "$R" | grep -q '"locked": *true'; then LOCKED=1; else LOCKED=0; fi

  if [ -z "$PROXY_URL" ]; then
    # 没代理就没有可探活的链路，保持 blocked
    write_state blocked no-proxy "未配置代理，网络保持完全切断。"
    continue
  fi

  CODE="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 6 \
          -x "$PROXY_URL" http://cp.cloudflare.com/generate_204 2>/dev/null)"
  if [ "$CODE" = "204" ] || [ "$CODE" = "200" ]; then
    CONSEC_FAIL=0
    if [ "$PREFLIGHT" != "pass" ] || [ "$(sed -n 's/^state=//p' "$STATE" 2>/dev/null)" != "guarded" ]; then
      # 代理刚恢复（或上次预检失败）：重新完整预检一次再放行状态
      preflight
      PF=$?
      if [ "$PF" -eq 0 ]; then PREFLIGHT=pass; else PREFLIGHT=fail; fi
      log "代理恢复，重跑预检：$PF_REASON"
    fi
    if [ "$PREFLIGHT" = "pass" ] && [ "$LOCKED" = "1" ]; then
      write_state guarded ok "$PF_MSG" "exit_org=\"${EXIT_ORG:-}\""
    else
      write_state blocked "$PF_REASON" "$PF_MSG"
    fi
  else
    CONSEC_FAIL=$((CONSEC_FAIL + 1))
    if [ "$CONSEC_FAIL" -ge 2 ]; then
      # 关键：这里**不做任何断网动作**。路由表里没有直连，网络本来就是断的。
      if [ "$PREFLIGHT" != "pass" ]; then
        # 预检本来就没过（代理没开 Allow LAN / 出口风险 / 多源分叉 …），
        # 保留那条具体原因，别让通用的 proxy_down 把诊断信息冲掉。
        write_state blocked "$PF_REASON" "$PF_MSG"
      else
        write_state proxy_down proxy-unreachable \
          "代理已断开（连续 ${CONSEC_FAIL} 次探活失败），网络维持切断状态，不会回落到本机直连。请检查代理软件后等待自动恢复。"
      fi
    fi
  fi
done
