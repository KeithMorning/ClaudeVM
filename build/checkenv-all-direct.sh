#!/bin/bash
# 验证「全量模式不再依赖本地 router」：只设 UPSTREAM_PROXY，不启动 router
GW="${1:-192.168.240.1}"
PORT="${2:-7897}"

cp -f /mnt/e/Web/FuckCladue/claude-desktop/runtime/scripts/check-env.sh /opt/scripts/ 2>/dev/null
chmod +x /opt/scripts/*.sh 2>/dev/null
pkill -f proxy-router.js 2>/dev/null
sleep 0.5

export TZ=America/Los_Angeles
export LANG=en_US.UTF-8
export UPSTREAM_PROXY="http://$GW:$PORT"
export PROXY_MODE=all
export PROXY_ROUTER_PORT=7890
export HTTPS_PROXY="$UPSTREAM_PROXY"
export HTTP_PROXY="$UPSTREAM_PROXY"
export NO_PROXY="localhost,127.0.0.1"

mkdir -p /opt/config
echo "$UPSTREAM_PROXY" > /opt/config/local-proxy

cat > /opt/config/runtime-env <<EOF
export TZ='America/Los_Angeles'
export LANG='en_US.UTF-8'
export LC_ALL='en_US.UTF-8'
export LANGUAGE='en_US:en'
export DISPLAY=':1'
export UPSTREAM_PROXY='$UPSTREAM_PROXY'
export PROXY_MODE='all'
export PROXY_WHITELIST='.anthropic.com,.claude.com,.claude.ai,.claudeusercontent.com,clau.de,checkcc.org'
export PROXY_ROUTER_PORT='7890'
export HTTPS_PROXY='$UPSTREAM_PROXY'
export HTTP_PROXY='$UPSTREAM_PROXY'
EOF

/opt/scripts/check-env.sh 2>&1 | sed -n '/网络与代理/,$p' | head -20
