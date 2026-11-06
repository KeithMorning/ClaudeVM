#!/usr/bin/env bash
# WSLg（DISPLAY=:0）能力探针：剪贴板 + 独立窗口
echo "=== 显示服务器 ==="
echo -n ":0 -> "; DISPLAY=:0 xdpyinfo 2>&1 | grep -m1 "vendor string" || echo "不可连"
echo -n ":1 -> "; DISPLAY=:1 xdpyinfo 2>&1 | grep -m1 "vendor string" || echo "不可连"

echo "=== 工具 ==="
for c in xclip xterm xmessage zenity google-chrome-stable xdotool; do
  p=$(command -v "$c" 2>/dev/null) && echo "  $c: $p" || echo "  $c: 无"
done

echo "=== 从 :0 读 Windows 剪贴板（不经过我们的桥）==="
t=$(DISPLAY=:0 timeout 5 xclip -selection clipboard -o 2>/dev/null)
echo "  :0 读到 = [$t]"
echo "=== 对照：从 :1 读 ==="
t1=$(DISPLAY=:1 timeout 5 xclip -selection clipboard -o 2>/dev/null)
echo "  :1 读到 = [$t1]"
