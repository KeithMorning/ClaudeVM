#!/usr/bin/env bash
SRC=/mnt/e/Web/FuckCladue/claude-desktop/runtime/scripts
mkdir -p /opt/scripts
for f in "$SRC"/*; do b=$(basename "$f"); cp -f "$f" "/opt/scripts/.$b.tmp" && mv -f "/opt/scripts/.$b.tmp" "/opt/scripts/$b"; done
chmod +x /opt/scripts/*.sh
G=/opt/scripts/net-guard.py
trap 'echo "=== 恢复路由（trap） ==="; python3 "$G" unlock' EXIT
echo "=== net-guard.sh once ==="
NET_GUARD=strict /opt/scripts/net-guard.sh once
echo "once 退出码=$?"
echo "=== 状态文件 ==="
cat /run/claude-vm/net-guard.state
echo "=== 直连（应断）==="
curl -s --noproxy '*' --max-time 4 https://ipinfo.io/ip && echo " !!! 泄漏 !!!" || echo " OK 已断"
echo "=== 经代理（应通）==="
curl -s -x http://192.168.240.1:7897 --max-time 10 https://ipinfo.io/ip
echo ""
