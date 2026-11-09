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

  # 输入法（1.0.34 fcitx5）：fcitx5-remote 探活比 XIM atom 可靠 ——
  # fcitx5 走 D-Bus，服务死了前端立刻失联，remote 直接非零退出。
  # 进程活着但 D-Bus 名字没注册的情况也能被这个探测抓到。
  if [ "$IM" = "rime" ] && alive_x &&
     ! fcitx5-remote >/dev/null 2>&1; then
    log "fcitx5 未就绪 → 重启 fcitx5"
    pkill -x fcitx5 2>/dev/null || true
    sleep 1
    DISPLAY=:1 XMODIFIERS='@im=fcitx' GTK_IM_MODULE=fcitx QT_IM_MODULE=fcitx \
      fcitx5 -d --replace >/tmp/fcitx5-guard.log 2>&1
    sleep 2
    # 重启后要激活并切回 rime，否则又回到「按键透传」态（顺序同 entrypoint）
    fcitx5-remote -s rime >/dev/null 2>&1 || true
    fcitx5-remote -o >/dev/null 2>&1 || true
  fi

  sleep "$INTERVAL"
done
