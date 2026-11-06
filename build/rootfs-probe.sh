#!/bin/bash
# 只读索引，确认哪些可疑目录真的在 rootfs 里
T=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs.tar.gz
for pat in './root/.npm' './root/.cache' '.claude-code-' '/include/' '.claude-code/node_modules' './usr/share/yudit' './usr/share/ieee-data' './usr/share/python-babel-localedata'; do
  n=$(tar -tzf "$T" 2>/dev/null | grep -c -- "$pat")
  printf '%-38s %s 条\n' "$pat" "$n"
done
