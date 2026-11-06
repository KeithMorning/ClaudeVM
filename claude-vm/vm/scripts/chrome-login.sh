#!/usr/bin/env bash
# 用真实 Chrome 在容器内完成 claude.ai 登录，且走与 Claude Code 相同的白名单代理出口
# Chrome 打到本地 router(127.0.0.1:7890)，router 再按白名单把 anthropic 流量转上游代理
PROXY_URL=""
[ -f /opt/config/local-proxy ] && PROXY_URL="$(cat /opt/config/local-proxy)"
# --proxy-server 不接受尾斜杠（http://h:p/ → ERR_NO_SUPPORTED_PROXIES），这里再兜一层，
# 免得旧版本写下的配置继续害人。
PROXY_URL="${PROXY_URL%/}"
PROXY_FLAG=""
[ -n "$PROXY_URL" ] && PROXY_FLAG="--proxy-server=$PROXY_URL"

# WSL/容器内以 root 运行时 Chrome 需要 --no-sandbox
SANDBOX_FLAG=""
[ "$(id -u)" = "0" ] && SANDBOX_FLAG="--no-sandbox"

# 浏览器语言必须跟随所选地区，不能写死 en-US：
# 否则 navigator.language 与系统 timezone / Intl locale 会自相矛盾，
# 台北画像（Asia/Taipei + zh_TW.UTF-8）却报 en-US 尤其扎眼。
[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env
case "${LANG:-en_US.UTF-8}" in
  zh_TW*) CHROME_LANG="zh-TW" ;;
  ja_JP*) CHROME_LANG="ja-JP" ;;
  de_DE*) CHROME_LANG="de-DE" ;;
  en_GB*) CHROME_LANG="en-GB" ;;
  *)      CHROME_LANG="en-US" ;;
esac

# --lang 只改 Chrome 的 UI 语言，不会重写已有 Profile 的 Accept-Language。
# 每次启动前把语言偏好固定成与系统 locale 一致（原子写、幂等），
# 否则会出现「系统 Asia/Taipei + zh_TW，浏览器却发 en-US」的矛盾请求头。
if [ -f /opt/scripts/chrome-lang.py ]; then
  python3 /opt/scripts/chrome-lang.py --set >/dev/null 2>&1 || true
fi

# Chrome 的 SingletonLock 记的是「hostname-PID」。1.0.26 起环境身份随机化成
# DESKTOP-XXXXXXX，旧锁仍指向 HomeVisionPC-324 这类已不存在的主机，socket 也早失效；
# Chrome 会据此判定 Profile 正被另一台机器占用，拒绝启动（串流桌面里「Chrome 打不开」）。
# 只在没有活着的 Chrome 进程时清 —— 正常多开仍复用同一实例。
CHROME_PROFILE="${HOME:-/root}/.config/google-chrome"
if [ -d "$CHROME_PROFILE" ] && ! pgrep -f '[g]oogle-chrome-stable' >/dev/null 2>&1; then
  rm -f "$CHROME_PROFILE/SingletonLock" \
        "$CHROME_PROFILE/SingletonCookie" \
        "$CHROME_PROFILE/SingletonSocket" 2>/dev/null || true
fi

# 不带参数时直接打开登录页，省得用户自己敲网址
if [ "$#" -eq 0 ]; then
  set -- https://claude.ai/login
fi

exec google-chrome-stable \
  --lang="$CHROME_LANG" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --start-maximized \
  --test-type \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  $SANDBOX_FLAG \
  $PROXY_FLAG \
  "$@"
