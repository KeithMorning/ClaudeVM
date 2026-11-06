#!/usr/bin/env bash
# 首次启动的欢迎引导。
# 用 Chrome 的 app 模式打开本地页面 → 无地址栏、无标签页，看起来像系统自带的小应用，
# 而不是一个「远程终端里敲命令」的服务器界面。
PROXY_URL=""
[ -f /opt/config/local-proxy ] && PROXY_URL="$(cat /opt/config/local-proxy)"
PROXY_URL="${PROXY_URL%/}"   # 尾斜杠会让 Chrome 报 ERR_NO_SUPPORTED_PROXIES
PROXY_FLAG=""
[ -n "$PROXY_URL" ] && PROXY_FLAG="--proxy-server=$PROXY_URL"

SANDBOX_FLAG=""
[ "$(id -u)" = "0" ] && SANDBOX_FLAG="--no-sandbox"

exec google-chrome-stable \
  --app=file:///opt/config/welcome/index.html \
  --window-size=780,570 \
  --window-position=250,140 \
  --lang=en-US \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --test-type \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  $SANDBOX_FLAG \
  $PROXY_FLAG
