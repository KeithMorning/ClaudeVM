#!/bin/bash
# 在真实 Clash 上游下跑一遍自检，验证「统一出口」判定与出口类型归因
GW="${1:-192.168.240.1}"
PORT="${2:-7897}"

cp -f /mnt/e/Web/FuckCladue/claude-desktop/runtime/scripts/proxy-router.js /opt/scripts/ 2>/dev/null
cp -f /mnt/e/Web/FuckCladue/claude-desktop/runtime/scripts/check-env.sh   /opt/scripts/ 2>/dev/null
chmod +x /opt/scripts/*.sh /opt/scripts/*.js 2>/dev/null

pkill -f proxy-router.js 2>/dev/null
sleep 0.6

export UPSTREAM_PROXY="http://$GW:$PORT"
export PROXY_MODE=all
export PROXY_ROUTER_PORT=7890
export HTTPS_PROXY="http://127.0.0.1:7890"
export HTTP_PROXY="$HTTPS_PROXY"
export NO_PROXY="localhost,127.0.0.1"
export TZ=America/Los_Angeles
export LANG=en_US.UTF-8

node /opt/scripts/proxy-router.js >/tmp/router.log 2>&1 &
sleep 1.2

# check-env.sh 会先 source runtime-env（真实场景下那也是 entrypoint 写的），
# 所以测试必须把同样的内容写进去，否则会被空值覆盖。
cat > /opt/config/runtime-env <<EOF
export TZ='America/Los_Angeles'
export LANG='en_US.UTF-8'
export LC_ALL='en_US.UTF-8'
export LANGUAGE='en_US:en'
export DISPLAY=':1'
export UPSTREAM_PROXY='$UPSTREAM_PROXY'
export PROXY_MODE='all'
export PROXY_WHITELIST='.anthropic.com,.claude.com,.claude.ai,.claudeusercontent.com,clau.de'
export PROXY_ROUTER_PORT='7890'
export HTTPS_PROXY='http://127.0.0.1:7890'
export HTTP_PROXY='http://127.0.0.1:7890'
EOF

/opt/scripts/check-env.sh 2>&1 | sed -n '1,60p'
pkill -f proxy-router.js 2>/dev/null
