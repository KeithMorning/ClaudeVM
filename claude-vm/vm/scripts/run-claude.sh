#!/bin/sh
# 启动器 / 任务栏：在工作区里启动 Claude Code
# xterm + Fira Code：镜像里没有位图字体包，走 Xft 才有清晰字形；
# +sb 关掉老式滚动条，-b 留内边距，观感接近普通终端。
#
# 这一行是「输入法能不能用」的关键：用户点按钮时是新开一个 wsl.exe 会话，
# 继承不到 entrypoint 里 export 的 XMODIFIERS，必须从落盘的环境读回来。
[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env

set -- -fa "Fira Code" -fs 12 -geometry 112x32 \
  -bg "#10141b" -fg "#d7dce5" -cr "#d97757" \
  -b 10 +sb -title "Claude Code" -e /opt/scripts/session-claude.sh

# xterm 只认 XIM；设成 XIM 才会去连 IBus 注册的 @server=ibus。
# 1.0.26 实测补的两项（此前只设 inputMethod，XIM 输入上下文根本没打开）：
#   · openIm: true —— xterm 372 默认不主动打开 IM，不显式开就只会把按键当 ASCII 送进 pty。
#     加了它才会出现与 IBus 协商 preedit 的日志，证明 IC 真的建起来了。
#   · preeditType: Root —— IBus 的 XIM server 不支持 OverTheSpot，设它会报
#     "input method doesn't support my preedit type"；Root 对应 XIMPreeditNothing，可用。
# 没启用输入法时不加这些资源，xterm 保持原有行为。
if [ -n "${XMODIFIERS:-}" ]; then
  set -- -xrm "XTerm*inputMethod: XIM" \
         -xrm "XTerm*openIm: true" \
         -xrm "XTerm*preeditType: Root" "$@"
fi
exec xterm "$@"
