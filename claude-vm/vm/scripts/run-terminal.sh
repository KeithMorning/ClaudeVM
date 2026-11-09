#!/bin/sh
# 启动器 / 任务栏：普通终端（默认落在工作区）
#
# 1.0.31：xterm → lxterminal（GTK3）。
#   xterm 是纯 Xt 应用，只认 XIM；IBus 的 XIM 前端只支持 preeditType=Root，
#   输入上下文经常根本建不起来 —— 表现是终端里一个中文都打不进去。
#   lxterminal 走 GTK3 的 im-ibus.so（ibus-gtk3，仅 80KB）：候选框跟随光标、
#   Ctrl+Space 切换可靠、中文由 Pango 渲染（双宽字符宽度正确，不再重叠错位）。
#   字体与深色配色读 ~/.config/lxterminal/lxterminal.conf，由 entrypoint 部署。
[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env

exec lxterminal --no-remote --title="Terminal" --geometry=120x34 \
  -e /opt/scripts/session-shell.sh
