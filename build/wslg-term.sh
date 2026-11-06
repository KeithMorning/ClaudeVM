#!/usr/bin/env bash
# 清理此前的 WSLg 探测进程，再按「缩小范围」实测：WSLg 终端窗口 + 中文剪贴板
pkill -f "user-data-dir=/tmp/wslg-chrome" 2>/dev/null || true
pkill -x xmessage 2>/dev/null || true
pkill -f "xclip -selection clipboard" 2>/dev/null || true
rm -rf /tmp/wslg-chrome

export DISPLAY=:0
export PULSE_SERVER=unix:/mnt/wslg/PulseServer

echo "=== 终端程序 ==="
for c in lxterminal xterm gnome-terminal; do
  p=$(command -v "$c" 2>/dev/null) && echo "  $c: $p" || echo "  $c: 无"
done

echo "=== 从 :0 读 Windows 剪贴板（中文）==="
t=$(timeout 5 xclip -selection clipboard -o 2>/dev/null)
echo "  读到 = [$t]"

echo "=== 启动 WSLg 终端窗口 ==="
if command -v lxterminal >/dev/null 2>&1; then
  nohup lxterminal --title="claude-vm terminal" >/tmp/wslg-term.log 2>&1 &
else
  nohup xterm -T "claude-vm terminal" -geometry 100x30 >/tmp/wslg-term.log 2>&1 &
fi
sleep 4
echo "=== 窗口是否建立 ==="
xwininfo -root -tree 2>/dev/null | grep -iE "claude-vm terminal|lxterminal|xterm" | head -4
echo "=== 终端进程 ==="
pgrep -af "lxterminal|xterm" | head -3
