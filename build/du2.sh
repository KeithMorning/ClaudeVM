#!/bin/bash
N=/usr/local/lib/nodejs/node-v20.18.1-linux-x64
echo "== node 目录 =="
du -xhd1 "$N" 2>/dev/null | sort -hr
echo
echo "== node_modules =="
du -xhd1 "$N/lib/node_modules" 2>/dev/null | sort -hr | head
echo
echo "== @anthropic-ai =="
du -xhd1 "$N/lib/node_modules/@anthropic-ai" 2>/dev/null | sort -hr
echo
echo "== 各个 claude 二进制 =="
find "$N/lib/node_modules" -type f -name 'claude*' -size +10M -printf '%s\t%p\n' 2>/dev/null \
  | sort -rn | awk -F'\t' '{printf "%6.0f MB  %s\n", $1/1048576, $2}'
echo
echo "== npm 缓存 =="
du -xsh /root/.npm /root/.cache 2>/dev/null
