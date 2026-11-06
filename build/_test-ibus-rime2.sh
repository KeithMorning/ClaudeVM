#!/usr/bin/env bash
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends ibus ibus-rime >/tmp/ibus2.log 2>&1
echo "install rc=$?"
echo "=== ibus 相关可执行 ==="; ls /usr/bin/ibus* /usr/libexec/ibus* 2>/dev/null | head -15; command -v ibus-daemon
echo "=== XIM 支持文件 ==="; dpkg -L ibus 2>/dev/null | grep -iE "xim|x11" | head -10
echo "=== 字体复查 ==="; fc-list 2>/dev/null | grep -iE "Noto Sans CJK|WenQuanYi|Source Han" | head -3 || echo "无（安全）"
pkill -x fcitx5 2>/dev/null || true; pkill -x ibus-daemon 2>/dev/null || true
sleep 1
export DISPLAY=:0 LANG=en_US.UTF-8
export XMODIFIERS=@im=ibus GTK_IM_MODULE=ibus QT_IM_MODULE=ibus
ibus-daemon -d --xim >/tmp/ibusd2.log 2>&1
sleep 5
echo "=== 进程 ==="; pgrep -af "ibus" | head -5
echo "=== XIM_SERVERS（决定性）==="; xprop -root XIM_SERVERS 2>&1 | head -3
echo "=== 日志 ==="; tail -8 /tmp/ibusd2.log
