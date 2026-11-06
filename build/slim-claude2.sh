#!/bin/bash
P=/usr/local/lib/nodejs/node-v20.18.1-linux-x64/lib/node_modules/@anthropic-ai/claude-code
echo "bin/claude.exe : $(stat -c %s "$P/bin/claude.exe" 2>&1) 字节"
echo "linux-x64/claude: $(stat -c %s "$P/node_modules/@anthropic-ai/claude-code-linux-x64/claude" 2>&1) 字节"
timeout 20 "$P/bin/claude.exe" --version 2>&1 | head -2
