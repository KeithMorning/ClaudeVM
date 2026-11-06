#!/bin/bash
N=/usr/local/lib/nodejs/node-v20.18.1-linux-x64
P="$N/lib/node_modules/@anthropic-ai/claude-code"
echo "== 包目录 =="; ls -l "$P" | head -10
echo "== 包 bin =="; ls -l "$P/bin" 2>&1
echo "== bin 文件类型 =="; file "$P/bin"/* 2>/dev/null | head -3
echo "== linux-x64 =="; ls -l "$P/node_modules/@anthropic-ai/claude-code-linux-x64/" 2>&1 | head -5
