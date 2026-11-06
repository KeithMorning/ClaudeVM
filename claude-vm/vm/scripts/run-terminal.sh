#!/bin/sh
# 启动器 / 任务栏：普通终端（默认落在工作区）
[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env
set -- -fa "Fira Code" -fs 12 -geometry 120x34 \
  -bg "#10141b" -fg "#d7dce5" -cr "#d97757" \
  -b 10 +sb -title "Terminal" -e /opt/scripts/session-shell.sh
# 与 run-claude.sh 保持一致：openIm 必须显式开，preeditType 用 IBus 支持的 Root。
if [ -n "${XMODIFIERS:-}" ]; then
  set -- -xrm "XTerm*inputMethod: XIM" \
         -xrm "XTerm*openIm: true" \
         -xrm "XTerm*preeditType: Root" "$@"
fi
exec xterm "$@"
