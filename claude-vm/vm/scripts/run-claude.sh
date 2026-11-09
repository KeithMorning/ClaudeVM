#!/bin/sh
# 启动器 / 任务栏：在工作区里启动 Claude Code
#
# 1.0.31：xterm → lxterminal（GTK3）。
#   以前这一行是「输入法能不能用」的全部战场：xterm 只认 XIM，要靠
#   `openIm: true` + `preeditType: Root` 硬凑输入上下文，实际经常建不起来，
#   于是 Claude Code 终端里一个中文都打不进；Chrome 走 XIM 也只是勉强能用，
#   候选窗飘在左下角、字形变方块。
#   现在 lxterminal 走 GTK3 原生 im module（GTK_IM_MODULE=ibus），
#   IBus 通过 D-Bus 直接给 GTK 输入框回 preedit，XIM 只作老客户端兼容。
#   点按钮时是新开一个 wsl.exe 会话，必须从落盘的环境读回代理/输入法变量。
[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env

exec lxterminal --no-remote --title="Claude Code" --geometry=112x32 \
  -e /opt/scripts/session-claude.sh
