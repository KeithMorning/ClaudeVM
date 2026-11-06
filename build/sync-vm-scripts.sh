#!/usr/bin/env bash
set -u
SRC=/mnt/e/Web/FuckCladue/claude-desktop/runtime/scripts
mkdir -p /opt/scripts
n=0
for f in "$SRC"/*; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  cp -f "$f" "/opt/scripts/.$b.tmp" && mv -f "/opt/scripts/.$b.tmp" "/opt/scripts/$b"
  n=$((n+1))
done
chmod +x /opt/scripts/*.sh
echo "已原子替换 $n 个脚本"
grep -c DISPLAY_MODE /opt/scripts/entrypoint.sh /opt/scripts/check-env.sh
