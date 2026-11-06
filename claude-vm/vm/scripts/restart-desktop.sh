#!/bin/bash
# 右键菜单：重启面板（改了 tint2 配置后不用重启整个环境）
pkill -x tint2 2>/dev/null || true
sleep 0.4
nohup tint2 >/dev/null 2>&1 &
