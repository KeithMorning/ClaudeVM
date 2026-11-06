#!/usr/bin/env bash
G=/mnt/e/Web/FuckCladue/claude-desktop/runtime/scripts/net-guard.py
P=http://192.168.240.1:7897
unlock() { echo "=== UNLOCK (trap) ==="; python3 "$G" unlock; }
trap unlock EXIT
echo "=== BEFORE ==="; python3 "$G" status
echo "=== LOCK ==="; python3 "$G" lock "$P"
echo "=== 直连（必须失败）==="
if curl -s --noproxy '*' --max-time 4 https://ipinfo.io/ip; then echo " !!! 泄漏：直连仍可用 !!!"; else echo " OK 直连已断"; fi
echo "=== 经代理（必须成功）==="
curl -s -x "$P" --max-time 12 https://ipinfo.io/ip || echo " !!! 代理失败 !!!"
echo ""
echo "=== STATUS ==="; python3 "$G" status
