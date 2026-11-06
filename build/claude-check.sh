#!/bin/bash
echo "== which claude =="; command -v claude || echo "(PATH 里没有)"
echo "== 直接执行 =="; timeout 10 claude --version 2>&1 | head -3
echo "== 包内二进制 =="; ls -l /usr/local/lib/nodejs/node-v20.18.1-linux-x64/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude 2>&1
echo "== run-claude.sh =="; sed -n '1,20p' /opt/scripts/run-claude.sh
