#!/bin/bash
# 在图形终端里启动 Claude Code。
# 关键：把 entrypoint 落盘的运行时环境（代理/时区/语言）读进来，
# 否则这个新 shell 收不到 HTTPS_PROXY，Claude Code 会直连不通。
[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env 2>/dev/null
export PATH="/usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin:$PATH"
export TERM=xterm-256color
cd /workspace 2>/dev/null || cd ~
exec claude
