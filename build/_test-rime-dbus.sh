#!/usr/bin/env bash
export DISPLAY=:0
export LANG=en_US.UTF-8
pkill -x fcitx5 2>/dev/null || true
sleep 1
eval "$(dbus-launch --sh-syntax)"
export XMODIFIERS=@im=fcitx
export GTK_IM_MODULE=fcitx
export QT_IM_MODULE=fcitx
fcitx5 --disable=wayland -d >/tmp/fcitx5b.log 2>&1
sleep 5
echo "DBUS=$DBUS_SESSION_BUS_ADDRESS"
echo "=== fcitx5 进程 ==="; pgrep -af "fcitx5" | head -3
echo "=== XIM_SERVERS（决定性）==="; xprop -root XIM_SERVERS 2>&1 | head -3
echo "=== addon 加载情况 ==="; grep -i "Loaded addon\|Could not load" /tmp/fcitx5b.log | head -22
echo "=== 日志尾部 ==="; tail -5 /tmp/fcitx5b.log
