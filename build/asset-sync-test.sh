#!/bin/bash
# 验证：客户端同步下来的 /opt/assets 能被 entrypoint 正确覆盖到 /usr/share/novnc
set -u
echo "=== [1] 模拟客户端的资源同步 ==="
SRC=/mnt/e/Web/FuckCladue/claude-desktop/runtime/assets
mkdir -p /opt/assets
cp -rf "$SRC/." /opt/assets/ 2>/dev/null
find /opt/assets -type f -printf '%p %s\n'

echo "=== [2] 模拟 entrypoint 的覆盖逻辑 ==="
if [ -f /opt/assets/novnc/desktop.html ]; then
  cp -f /opt/assets/novnc/desktop.html /usr/share/novnc/desktop.html
  echo "  已从 /opt/assets 覆盖"
else
  echo "  !! 未找到 /opt/assets/novnc/desktop.html"
fi
ls -la /usr/share/novnc/desktop.html

echo "=== [3] 内容特征校验（新页面应有 __clipSet 与 hint 转圈层）==="
grep -c "__clipSet" /usr/share/novnc/desktop.html
grep -c "Connecting to your desktop" /usr/share/novnc/desktop.html
