#!/usr/bin/env bash
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends rime-data-bopomofo >/tmp/rime-data.log 2>&1
echo "install rc=$?"
echo "=== 方案文件 ==="; ls /usr/share/rime-data/ | grep -iE "bopo|zhuyin|terra|luna" | head -20
echo "=== bopomofo 方案头部 ==="; head -20 /usr/share/rime-data/bopomofo.schema.yaml 2>/dev/null

export DISPLAY=:0
export XMODIFIERS=@im=fcitx
export GTK_IM_MODULE=fcitx
export QT_IM_MODULE=fcitx
export LANG=en_US.UTF-8
pkill -x fcitx5 2>/dev/null || true
sleep 1
fcitx5 --disable=wayland -d >/tmp/fcitx5.log 2>&1
sleep 4
echo "=== fcitx5 进程 ==="; pgrep -af fcitx5 | head -3 || echo "未启动"
echo "=== XIM_SERVERS（关键）==="; xprop -root XIM_SERVERS 2>&1 | head -3
echo "=== fcitx5 日志 ==="; tail -8 /tmp/fcitx5.log
echo "=== 字体复查 ==="; fc-list 2>/dev/null | grep -iE "Noto Sans CJK|WenQuanYi|Source Han" | head -3 || echo "无名单内字体"
