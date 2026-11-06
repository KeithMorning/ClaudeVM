#!/bin/bash
# 真正的入口是 claude-code-linux-x64/claude（原生二进制），
# 包里的 bin/claude.exe 只是个「请先跑 postinstall」的报错桩。
BIN=/usr/local/lib/nodejs/node-v20.18.1-linux-x64/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude
chmod +x "$BIN" 2>/dev/null
ln -sf "$BIN" /usr/local/bin/claude
echo "链接: $(ls -l /usr/local/bin/claude)"
echo "大小: $(stat -c %s "$BIN")"
echo "== 验证 =="
timeout 20 claude --version 2>&1 | head -3
