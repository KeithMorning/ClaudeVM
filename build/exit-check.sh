#!/usr/bin/env bash
# 诊断脚本：在 VM 内实测「经代理的真实出口」与「守卫状态是否一致」
#
# 背景：net-guard.sh 的运行期看门狗只检查 generate_204 的 HTTP 码，
#   代理软件（Clash Verge / mihomo）运行中切成 Direct 时，204 依然返回，
#   界面会继续显示旧的境外出口 —— 这个脚本用来手工戳破这种「静默假绿」。
#
# 用法（Windows 侧，Git Bash）：
#   MSYS_NO_PATHCONV=1 wsl.exe -d claude-vm -u root -- bash /mnt/e/Web/FuckCladue/build/exit-check.sh
#   可选：把宿主机直连公网 IP 作为第一个参数传入，脚本会直接判定它是否就是当前出口
#   MSYS_NO_PATHCONV=1 wsl.exe -d claude-vm -u root -- bash /mnt/e/Web/FuckCladue/build/exit-check.sh 117.133.43.138
# 宿主机直连基线取值：curl -s --noproxy '*' https://ipinfo.io/ip
#
# 退出码：0 = 出口安全且与界面一致；1 = 发现风险，需要检查代理软件模式。

DIRECT_BASE="${1:-}"
P=$(tr -d '\r\n' < /opt/config/local-proxy)
STATE=/run/claude-vm/net-guard.state
RISK=0

echo "proxy=[$P]"
echo "=== 看门狗的 204 探活（只看 HTTP 码，切 Direct 时仍会是 204） ==="
CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  --connect-timeout 2 --max-time 6 -x "$P" http://cp.cloudflare.com/generate_204)
echo "code=$CODE"

echo "=== 经代理 ipinfo ==="
VIA=$(curl -s --connect-timeout 3 --max-time 10 -x "$P" https://ipinfo.io/json)
printf '%s\n' "$VIA"
REAL_IP=$(printf '%s' "$VIA" | sed -n 's/.*"ip": *"\([^"]*\)".*/\1/p' | head -1)
REAL_CC=$(printf '%s' "$VIA" | sed -n 's/.*"country": *"\([^"]*\)".*/\1/p' | head -1)

echo "=== 三源出口（不一致 = 按域名分流） ==="
for u in https://api.ipify.org https://ipinfo.io/ip https://api.ip.sb/ip; do
  printf '%s -> ' "$u"
  curl -s --connect-timeout 3 --max-time 8 -x "$P" "$u"
  echo
done

echo "=== 容器直连（应无 IP，[end] 紧随） ==="
curl -s --connect-timeout 2 --max-time 4 --noproxy '*' https://ipinfo.io/ip
echo "[end]"

echo "=== 界面/自检读到的状态 ==="
cat "$STATE" 2>/dev/null || echo '(缺失)'
ST_IP=$(sed -n 's/^exit_ip=//p' "$STATE" 2>/dev/null | tr -d '\r\n')
ST_CC=$(sed -n 's/^exit_country=//p' "$STATE" 2>/dev/null | tr -d '\r\n')
ST_NAME=$(sed -n 's/^state=//p' "$STATE" 2>/dev/null | tr -d '\r\n')

echo "=== 判定 ==="
if [ -z "$REAL_IP" ]; then
  echo "风险：经代理取不到出口信息，代理链路不通（预检应判 proxy-unreachable）"
  RISK=1
else
  echo "实测出口：$REAL_IP · ${REAL_CC:-未知}    界面记录：${ST_IP:-无} · ${ST_CC:-未知} ($ST_NAME)"
  case ",${REAL_CC}," in
    *,CN,*|*,HK,*|*,MO,*)
      echo "风险：出口落在受限地区，代理软件很可能已切到 Direct / 直连规则"
      RISK=1 ;;
  esac
  if [ -n "$DIRECT_BASE" ] && [ "$REAL_IP" = "$DIRECT_BASE" ]; then
    echo "风险：出口等于宿主机直连公网 IP，确认代理软件处于直连模式"
    RISK=1
  fi
  if [ -n "$ST_IP" ] && [ "$REAL_IP" != "$ST_IP" ]; then
    echo "风险：实测出口与界面状态不一致，界面显示的是陈旧数据（运行中切换的典型特征）"
    RISK=1
  fi
  if [ "$ST_NAME" != "guarded" ]; then
    echo "注意：守卫状态为 $ST_NAME，不是 guarded"
  fi
fi
if [ "$RISK" -eq 0 ]; then
  echo "OK：出口安全且与界面一致；204 探活 code=$CODE"
else
  echo "处置：把代理软件切回 Global / 换境外节点，然后「停止→启动」让预检重跑；必要时重启 WSL。"
fi
echo "提示：宿主机直连基线可用 curl -s --noproxy '*' https://ipinfo.io/ip 取得，并作为参数传入。"
exit "$RISK"
