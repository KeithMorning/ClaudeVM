#!/bin/bash
N=/usr/local/lib/nodejs/node-v20.18.1-linux-x64
P="$N/lib/node_modules/@anthropic-ai/claude-code"
echo "== bin/claude.exe 内容 =="; cat "$P/bin/claude.exe"
echo
echo "== 直接跑 linux 二进制 =="
timeout 15 "$P/node_modules/@anthropic-ai/claude-code-linux-x64/claude" --version 2>&1 | head -3
echo "退出码 $?"
