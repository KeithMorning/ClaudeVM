#!/bin/bash
# 查看虚拟机里所有 Chrome 主进程的代理相关参数
echo "=== Chrome 主进程 ==="
ps -eo pid,args 2>/dev/null | grep "google-chrome-stable" | grep -v -- "--type=" | grep -v grep | while read -r pid args; do
  echo "PID $pid"
  printf '%s\n' "$args" | tr ' ' '\n' | grep -E '^--(proxy|app|user-data|force-webrtc)' | sed 's/^/   /'
  echo
done
echo "=== 欢迎页脚本内容 ==="
cat /opt/scripts/show-welcome.sh
echo "=== local-proxy 内容 ==="
cat /opt/config/local-proxy 2>/dev/null || echo "(不存在)"
