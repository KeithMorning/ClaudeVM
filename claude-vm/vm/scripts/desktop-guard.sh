#!/usr/bin/env bash
# desktop-guard.sh — 串流桌面的自愈守护（entrypoint 以 nohup 拉起）
#
# 背景：desktop 模式以前只靠 Xtigervnc / websockify / openbox「天然常驻」，
# 末尾的 wait 会一直等到最后一个后台子进程结束。任一组件崩了，wait 返回非 0，
# 而 entrypoint 开头是 set -e —— 整个 wsl.exe 立刻退出、发行版变 Stopped，
# 用户看到的就是「虚拟机意外退出」，连带 Chrome 打不开、输入法消失。
# 现在 entrypoint 另外放了 sleep infinity 兜住 wait，本脚本负责把崩掉的组件拉回来。
#
# 只在 desktop 模式运行，所有窗口都在 Xtigervnc 的 :1 上（WSLg 是 :0）。
export DISPLAY=:1
export XDG_RUNTIME_DIR=/run/user/0
mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null || true

GEOM="${NOVNC_GEOMETRY:-1600x900}"
PORT="${NOVNC_PORT:-6080}"
BIND="${NOVNC_BIND:-127.0.0.1}"
IM="${INPUT_METHOD:-off}"
INTERVAL="${DESKTOP_GUARD_INTERVAL:-4}"

log() { echo "[$(date +%H:%M:%S)] $*"; }
alive_x() { DISPLAY=:1 xprop -root >/dev/null 2>&1; }

# 先让 entrypoint 把三个组件都起完，否则第一轮会误判成「崩了」并抢着重复启动。
sleep 6
log "desktop-guard 启动（geometry=$GEOM port=$PORT im=$IM）"

while true; do
  if ! pgrep -x Xtigervnc >/dev/null 2>&1; then
    log "Xtigervnc 退出 → 清锁并重启"
    rm -f /tmp/.X1-lock 2>/dev/null || true
    mkdir -p /root/.vnc
    Xtigervnc :1 -geometry "$GEOM" -depth 24 -rfbport 5901 -localhost \
      -SecurityTypes None -nolisten unix >>/root/.vnc/Xtigervnc.log 2>&1 &
    sleep 2
  fi

  if alive_x && ! pgrep -x openbox >/dev/null 2>&1; then
    log "openbox 退出 → 重启"
    openbox >/dev/null 2>&1 &
  fi

  if ! pgrep -f '[w]ebsockify --web' >/dev/null 2>&1; then
    log "websockify 退出 → 重启"
    websockify --web=/usr/share/novnc "${BIND}:${PORT}" localhost:5901 \
      >>/tmp/websockify-guard.log 2>&1 &
  fi

  # 输入法：XIM_SERVERS 是根窗口上的 atom，进程活着也可能没注册成功。
  # 必须按 :1 检查 —— ibus 若注册到 WSLg 的 :0，串流窗口里的 xterm 连不上。
  if [ "$IM" = "rime" ] && alive_x &&
     ! DISPLAY=:1 xprop -root XIM_SERVERS 2>/dev/null | grep -q '@server=ibus'; then
    log "XIM 未注册 → 按 DISPLAY=:1 重启 ibus"
    pkill -x ibus-daemon 2>/dev/null || true
    sleep 1
    DISPLAY=:1 XMODIFIERS='@im=ibus' GTK_IM_MODULE=ibus QT_IM_MODULE=ibus \
      ibus-daemon -d --xim >/tmp/ibus-guard.log 2>&1
    sleep 2
    DISPLAY=:1 ibus engine rime >/dev/null 2>&1 || true
  fi

  sleep "$INTERVAL"
done
