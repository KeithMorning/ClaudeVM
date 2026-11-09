#!/usr/bin/env bash
# 试验：关闭 fcitx5 的 client preedit（PreeditEnabledByDefault=False），
# 看零候选时候选窗是否仍显示拼音串。试验结束恢复原配置，不落地。
set -u
CFG=/root/.config/fcitx5/config
BAK=/tmp/fcitx5-config.trial.bak
OUT=/mnt/e/Web/FuckCladue/build/ime-trial-out.txt
LOG=/tmp/ime-preedit.log
SHOTS=/mnt/e/Web/FuckCladue/build/shots
: > "$OUT"; : > "$LOG"
mkdir -p "$SHOTS" /root/.config/fcitx5

if [ -f "$CFG" ]; then cp -f "$CFG" "$BAK"; else echo __NONE__ > "$BAK"; fi

export DISPLAY=:1
export XDG_RUNTIME_DIR=/tmp/claude-vm-runtime
mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
export GTK_IM_MODULE=fcitx QT_IM_MODULE=fcitx XMODIFIERS='@im=fcitx'
export LANG=zh_TW.UTF-8 LC_ALL=zh_TW.UTF-8

VNC_PID=''; OB_PID=''; GTK_PID=''; DBUS_PID=''
cleanup() {
  [ -n "$GTK_PID" ] && kill "$GTK_PID" 2>/dev/null
  pkill -x fcitx5 2>/dev/null
  [ -n "$OB_PID" ] && kill "$OB_PID" 2>/dev/null
  [ -n "$VNC_PID" ] && kill "$VNC_PID" 2>/dev/null
  [ -n "$DBUS_PID" ] && kill "$DBUS_PID" 2>/dev/null
  if [ "$(cat "$BAK" 2>/dev/null)" = '__NONE__' ]; then rm -f "$CFG"; else cp -f "$BAK" "$CFG"; fi
}
trap cleanup EXIT INT TERM

cat > "$CFG" <<'CONF'
[Behavior]
PreeditEnabledByDefault=False
CONF
echo "trial config: $(tr '\n' ' ' < "$CFG")" >> "$OUT"

Xtigervnc :1 -geometry 1280x720 -depth 24 -rfbport 5901 -localhost \
  -SecurityTypes None -nolisten unix >/tmp/trial-vnc.log 2>&1 &
VNC_PID=$!
for i in $(seq 1 30); do DISPLAY=:1 xdpyinfo >/dev/null 2>&1 && break; sleep 0.4; done
openbox >/tmp/trial-ob.log 2>&1 &
OB_PID=$!
sleep 1
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
DBUS_PID="${DBUS_SESSION_BUS_PID:-}"

pkill -x fcitx5 2>/dev/null || true
sleep 0.4
fcitx5 -d --replace >/tmp/trial-fcitx5.log 2>&1
for i in $(seq 1 30); do fcitx5-remote >/dev/null 2>&1 && break; sleep 0.4; done

python3 /mnt/e/Web/FuckCladue/build/ime-probe-gtk.py >/tmp/trial-gtk.log 2>&1 &
GTK_PID=$!
sleep 2.5
WID=$(xdotool search --name 'IME-PROBE' 2>/dev/null | head -1)
if [ -n "$WID" ]; then
  timeout 5 xdotool windowactivate --sync "$WID" 2>/dev/null || xdotool windowfocus "$WID" 2>/dev/null
  sleep 0.5
fi
fcitx5-remote -s rime >/dev/null 2>&1
fcitx5-remote -o >/dev/null 2>&1
sleep 0.6
ST=$(fcitx5-remote 2>/dev/null)
if [ "$ST" != "2" ]; then xdotool key --clearmodifiers ctrl+space; sleep 0.8; ST=$(fcitx5-remote 2>/dev/null); fi
echo "state=$ST" >> "$OUT"

step() {
  local label="$1" idx="$2"
  CW=$(xwininfo -root -tree 2>/dev/null | grep 'ime-probe-gtk.py' | head -1 | grep -oE '0x[0-9a-f]+' | head -1)
  {
    echo ""
    echo "----- [$label] -----"
    echo "candidate_window=$CW"
    [ -n "$CW" ] && xwininfo -id "$CW" 2>/dev/null | grep -E 'Map State|Width:|Height:'
    tail -6 "$LOG"
  } >> "$OUT"
  python3 /mnt/e/Web/FuckCladue/build/ime-shot.py "$SHOTS/t${idx}.png" >> /tmp/trial-shot.log 2>&1
}

xdotool type --clearmodifiers --delay 150 'ffff'
sleep 1.2
step 'ffff（PreeditEnabledByDefault=False）' 1
xdotool key --clearmodifiers Escape
sleep 0.5
xdotool type --clearmodifiers --delay 150 'ni'
sleep 1.2
step 'ni 对照' 2

echo "" >> "$OUT"
echo "=== fcitx5 日志 ===" >> "$OUT"
tail -8 /tmp/trial-fcitx5.log >> "$OUT"
cat "$OUT"
