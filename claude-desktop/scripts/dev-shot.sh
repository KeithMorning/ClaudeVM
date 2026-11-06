#!/bin/bash
# 开发用：在 :2 测试显示上开一个终端，并截取该窗口 1:1 的文字区域
# 用法: bash dev-shot.sh [字号] [行数/列数可选]
set -u
DISP=${DISP:-:2}
PORT=${PORT:-5902}
FS=${1:-12}
export DISPLAY=$DISP

pkill -x xterm 2>/dev/null
sleep 0.5

setsid xterm -fa "Fira Code" -fs "$FS" -geometry 112x32 \
  -bg "#10141b" -fg "#d7dce5" -cr "#d97757" -b 10 +sb \
  -title "Claude Code" -e /mnt/e/Web/FuckCladue/claude-desktop/scripts/dev-font-sample.sh >/dev/null 2>&1 </dev/null &
sleep 4

G=$(DISPLAY=$DISP xwininfo -root -tree | grep '"Claude Code"' | head -1)
echo "win: $G"
POS=$(echo "$G" | grep -oE '\+[0-9]+\+[0-9]+' | tail -1)
X=$(echo "$POS" | sed -E 's/\+([0-9]+)\+([0-9]+)/\1/')
Y=$(echo "$POS" | sed -E 's/\+([0-9]+)\+([0-9]+)/\2/')
echo "pos: $X,$Y"

node /mnt/e/Web/FuckCladue/claude-desktop/scripts/vncshot.js /tmp/s.bmp 127.0.0.1 "$PORT" >/dev/null 2>&1
node /tmp/zoom.js /tmp/s.bmp /mnt/e/Web/FuckCladue/claude-desktop/build/text1x.png $((X + 8)) $((Y + 30)) 620 110 1
