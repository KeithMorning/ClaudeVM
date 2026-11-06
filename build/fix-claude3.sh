#!/bin/bash
# 覆盖修复：镜像里的 claude-code-linux-x64/claude（245MB，可运行）
# 当前发行版里那份是 43MB 的残包（SIGBUS）
T=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs.tar.gz
P=usr/local/lib/nodejs/node-v20.18.1-linux-x64/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude
B="/$P"
echo "覆盖前大小: $(stat -c %s "$B" 2>&1)"
tar -xzpf "$T" -C / "$P" || exit 1
chmod +x "$B"
ln -sf "$B" /usr/local/bin/claude
echo "覆盖后大小: $(stat -c %s "$B")"
echo "== 验证 =="
timeout 25 claude --version 2>&1 | head -3
