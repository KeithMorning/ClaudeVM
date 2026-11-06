#!/bin/bash
N=/usr/local/lib/nodejs/node-v20.18.1-linux-x64
B="$N/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude"
echo "size: $(stat -c %s "$B")  mtime: $(stat -c %y "$B")"
echo "== 运行 --version =="
timeout 20 "$B" --version 2>/tmp/e2.txt; echo "退出码=$?"
head -5 /tmp/e2.txt
