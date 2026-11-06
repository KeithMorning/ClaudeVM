#!/bin/bash
# 普通终端：同样带上运行时环境，落在工作区
[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env 2>/dev/null
export PATH="/usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin:$PATH"
export TERM=xterm-256color
cd /workspace 2>/dev/null || cd ~
exec bash -i
