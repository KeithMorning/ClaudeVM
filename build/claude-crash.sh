#!/bin/bash
N=/usr/local/lib/nodejs/node-v20.18.1-linux-x64
B="$N/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude"
echo "file: $(file -b "$B" 2>/dev/null)"
echo "size: $(stat -c %s "$B")"
echo "== 运行 =="
"$B" --version 2>/tmp/err.txt; rc=$?
echo "退出码=$rc"
echo "--- stderr ---"
head -20 /tmp/err.txt
echo "--- ldd ---"
ldd "$B" 2>&1 | grep -i "not found" | head -5 || echo "依赖齐全"
