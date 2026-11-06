#!/usr/bin/env bash
export DISPLAY=:0 LANG=en_US.UTF-8
export XDG_RUNTIME_DIR=/run/user/0
mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
pkill -x fcitx5 2>/dev/null || true; sleep 1
eval "$(dbus-launch --sh-syntax)"
export XMODIFIERS=@im=fcitx GTK_IM_MODULE=fcitx QT_IM_MODULE=fcitx
mkdir -p /root/.config/fcitx5/conf
printf '[Addon]\nEnabled=true\n' > /root/.config/fcitx5/conf/fcitx4frontend.conf
fcitx5 --disable=wayland --enable=fcitx4frontend -d >/tmp/fcitx5c.log 2>&1
sleep 5
echo "=== XIM_SERVERS ==="; xprop -root XIM_SERVERS 2>&1 | head -3
echo "=== xim / frontend 日志 ==="; grep -iE "xim|frontend|server|error" /tmp/fcitx5c.log | head -20
echo "=== 已加载 addon ==="; grep "Loaded addon" /tmp/fcitx5c.log | tail -12
