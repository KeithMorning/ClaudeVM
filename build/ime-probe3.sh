#!/usr/bin/env bash
# 诊断 3：加载产品 env 后连 D-Bus；挖 classicui 的配置键
. /opt/config/runtime-env 2>/dev/null
echo "=== 生效环境 ==="
env | grep -E '^(DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|GTK_IM_MODULE|XMODIFIERS)=' | sort
echo "=== ps 前 25 行 ==="
ps -ef | head -25
echo "=== pgrep 精确 ==="
pgrep -x fcitx5 || echo '(没有 fcitx5 进程)'
echo "=== fcitx5-remote ==="
fcitx5-remote 2>&1; echo "state_exit=$?"
fcitx5-remote -n 2>&1; echo "engine_exit=$?"
echo "=== D-Bus 上的 fcitx 名称 ==="
dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply \
  /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>&1 | grep -i fcitx || echo '(无)'
echo "=== classicui.so 里的配置键（preedit/candidate/hide/show） ==="
strings /usr/lib/x86_64-linux-gnu/fcitx5/libclassicui.so \
  | grep -iE 'preedit|candidate|hide|hidden|show|window|empty' | head -80
echo "=== fcitx5 核心库里的 preedit 相关键 ==="
strings /usr/lib/x86_64-linux-gnu/libFcitx5Core.so.7 2>/dev/null \
  | grep -iE 'preedit|candidate' | head -40
