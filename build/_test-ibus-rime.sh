#!/usr/bin/env bash
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends ibus ibus-rime ibus-x11 >/tmp/ibus-install.log 2>&1
echo "install rc=$?"
echo "=== ibus 命令 ==="; command -v ibus-daemon || echo MISSING
echo "=== 是否引入字体 ==="; fc-list 2>/dev/null | grep -iE "Noto Sans CJK|WenQuanYi|Source Han" | head -3 || echo "无（安全）"
pkill -x fcitx5 2>/dev/null || true
pkill -x ibus-daemon 2>/dev/null || true
sleep 1
export DISPLAY=:0 LANG=en_US.UTF-8
export XMODIFIERS=@im=ibus GTK_IM_MODULE=ibus QT_IM_MODULE=ibus
ibus-daemon -d --xim >/tmp/ibusd.log 2>&1
sleep 5
echo "=== ibus-daemon 进程 ==="; pgrep -af ibus-daemon | head -3
echo "=== XIM_SERVERS（决定性）==="; xprop -root XIM_SERVERS 2>&1 | head -3
echo "=== ibus 日志 ==="; tail -8 /tmp/ibusd.log
echo "=== rime 引擎是否可见 ==="; ibus list-engine 2>/dev/null | grep -i rime | head -3 || echo "需 --xim 会话后再查"
