#!/bin/bash
# 当前发行版里的 claude-code 包被一次失败的自更新搞坏了：
#   新包里 bin/claude.exe 是 500 字节的报错桩，真正的二进制只剩 43MB 残片（SIGBUS）
# 用镜像里那一份完整包整体覆盖回去。
T=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs.tar.gz
REL=usr/local/lib/nodejs/node-v20.18.1-linux-x64/lib/node_modules/@anthropic-ai/claude-code
echo "== 覆盖前 =="
ls -l "/$REL/bin/claude.exe" 2>&1
echo "== 解包整包 =="
tar -xzpf "$T" -C / --overwrite "$REL" || exit 1
echo "== 覆盖后 =="
ls -l "/$REL/bin/claude.exe" 2>&1
ln -sf "/$REL/bin/claude.exe" /usr/local/bin/claude
chmod +x "/$REL/bin/claude.exe"
echo "== 验证 =="
timeout 25 claude --version 2>&1 | head -3
