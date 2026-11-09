#!/usr/bin/env bash
# 串流模式（Xtigervnc :1 + openbox）隔离复现：输入 ni / ffff / 退格 / fa
# 一次 wsl.exe 调用内完成，退出时清理所有测试进程，不碰 :0/WSLg。
set -u
OUT=/mnt/e/Web/FuckCladue/build/ime-repro-out.txt
LOG=/tmp/ime-preedit.log
: > "$OUT"
: > "$LOG"

export DISPLAY=:1
export XDG_RUNTIME_DIR=/tmp/claude-vm-runtime
mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
export GTK_IM_MODULE=fcitx
export QT_IM_MODULE=fcitx
export XMODIFIERS='@im=fcitx'
export LANG=zh_TW.UTF-8
export LC_ALL=zh_TW.UTF-8

VNC_PID=''; OB_PID=''; GTK_PID=''; DBUS_PID=''
cleanup() {
  [ -n "$GTK_PID" ] && kill "$GTK_PID" 2>/dev/null
  pkill -x fcitx5 2>/dev/null
  [ -n "$OB_PID" ] && kill "$OB_PID" 2>/dev/null
  [ -n "$VNC_PID" ] && kill "$VNC_PID" 2>/dev/null
  [ -n "$DBUS_PID" ] && kill "$DBUS_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

echo "=== [0] Xtigervnc :1（串流同款 X server） ==="
mkdir -p /root/.vnc
Xtigervnc :1 -geometry 1280x720 -depth 24 -rfbport 5901 -localhost \
  -SecurityTypes None -nolisten unix >/tmp/repro-vnc.log 2>&1 &
VNC_PID=$!
for i in $(seq 1 30); do DISPLAY=:1 xdpyinfo >/dev/null 2>&1 && break; sleep 0.4; done
DISPLAY=:1 xdpyinfo 2>/dev/null | grep -m1 'vendor string' || echo 'X :1 未就绪'

echo "=== [1] openbox ==="
openbox >/tmp/repro-ob.log 2>&1 &
OB_PID=$!
sleep 1

echo "=== [2] D-Bus 会话 ==="
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
DBUS_PID="${DBUS_SESSION_BUS_PID:-}"
echo "$DBUS_SESSION_BUS_ADDRESS"

echo "=== [3] 起 fcitx5（激活必须等有焦点窗口之后） ==="
pkill -x fcitx5 2>/dev/null || true
sleep 0.4
fcitx5 -d --replace >/tmp/repro-fcitx5.log 2>&1
for i in $(seq 1 30); do fcitx5-remote >/dev/null 2>&1 && break; sleep 0.4; done
echo "state_before=$(fcitx5-remote 2>/dev/null)"

echo "=== [4] GTK IMContext 探针 ==="
python3 /mnt/e/Web/FuckCladue/build/ime-probe-gtk.py >/tmp/repro-gtk.log 2>&1 &
GTK_PID=$!
sleep 2.5
WID=$(xdotool search --name 'IME-PROBE' 2>/dev/null | head -1)
echo "probe_wid=$WID"
if [ -n "$WID" ]; then
  timeout 5 xdotool windowactivate --sync "$WID" 2>/dev/null || xdotool windowfocus "$WID" 2>/dev/null
  sleep 0.5
fi
echo "active=$(xdotool getactivewindow getwindowname 2>/dev/null)"

echo "=== [4.5] 在当前 InputContext 上激活 Rime ==="
fcitx5-remote -s rime 2>&1; echo "s_exit=$?"
fcitx5-remote -o 2>&1; echo "o_exit=$?"
sleep 0.6
ST=$(fcitx5-remote 2>/dev/null); EN=$(fcitx5-remote -n 2>/dev/null)
echo "state=$ST engine=$EN"
if [ "$ST" != "2" ]; then
  echo "state 不是 2，用 Ctrl+Space 再切一次"
  xdotool key --clearmodifiers ctrl+space
  sleep 0.8
  ST=$(fcitx5-remote 2>/dev/null); EN=$(fcitx5-remote -n 2>/dev/null)
  echo "after ctrl+space: state=$ST engine=$EN"
fi
echo "ACTIVATION state=$ST engine=$EN" >> "$OUT"

mkdir -p /mnt/e/Web/FuckCladue/build/shots
step() {
  local label="$1" idx="$2"
  {
    echo ""
    echo "----- [$label] -----"
    echo "-- 焦点窗口 --"
    xdotool getactivewindow getwindowname 2>/dev/null
    echo "-- 候选窗口 Map State --"
    CW=$(xwininfo -root -tree 2>/dev/null | grep 'ime-probe-gtk.py' | head -1 | grep -oE '0x[0-9a-f]+' | head -1)
    echo "candidate_window=$CW"
    if [ -n "$CW" ]; then
      xwininfo -id "$CW" 2>/dev/null | grep -E 'Map State|Width:|Height:|Override Redirect State'
    fi
    echo "-- preedit 日志最近 10 行 --"
    tail -10 "$LOG"
  } >> "$OUT"
  python3 /mnt/e/Web/FuckCladue/build/ime-shot.py \
    "/mnt/e/Web/FuckCladue/build/shots/s${idx}.png" >> /tmp/repro-shot.log 2>&1
}

echo "=== [5] 输入序列 ==="
xdotool type --clearmodifiers --delay 150 'ni'
sleep 1.2
step 'ni（应当有候选）' 1
xdotool key --clearmodifiers Escape
sleep 0.6
xdotool type --clearmodifiers --delay 150 'ffff'
sleep 1.2
step 'ffff（用户报告的消失点）' 2
xdotool key --clearmodifiers BackSpace
sleep 1.0
step 'ffff -> 退格 1 次' 3
xdotool key --clearmodifiers BackSpace BackSpace
sleep 1.0
step '退格共 3 次' 4
xdotool key --clearmodifiers Escape
sleep 0.5
xdotool type --clearmodifiers --delay 150 'fa'
sleep 1.2
step 'fa（对照，合法音节）' 5

echo "" >> "$OUT"
echo "=== fcitx5 日志 ===" >> "$OUT"
tail -15 /tmp/repro-fcitx5.log >> "$OUT"
echo "=== GTK 探针 stderr ===" >> "$OUT"
tail -15 /tmp/repro-gtk.log >> "$OUT"
cat "$OUT"
