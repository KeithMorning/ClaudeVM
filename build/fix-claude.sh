#!/bin/bash
# 用镜像里完好的二进制，修复当前发行版里损坏的 claude
T=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs.tar.gz
B=/usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin/claude
echo "修复前: $(ls -l "$B" 2>&1)"
tar -xzpf "$T" -C / usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin/claude || exit 1
chmod +x "$B"
ln -sf "$B" /usr/local/bin/claude
echo "修复后: $(ls -l "$B")  大小 $(stat -c %s "$B")"
echo "== 验证 =="
timeout 20 claude --version 2>&1 | head -3
