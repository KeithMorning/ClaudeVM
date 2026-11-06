#!/bin/bash
# 从现有 rootfs.tar.gz 产出一份瘦身版：只删确定无用的东西，不做依赖手术。
# 产出到 /mnt/e/.../rootfs-slim.tar.gz，原文件保持不动。
set -u
SRC=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs.tar.gz
DST=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs-slim.tar.gz
WORK=/var/tmp/slim

echo "== 1/4 解包 =="
rm -rf "$WORK"; mkdir -p "$WORK"
tar -xzpf "$SRC" -C "$WORK" || { echo "解包失败"; exit 1; }
echo "解包后: $(du -sh "$WORK" | cut -f1)"

echo "== 2/4 清理 =="
before=$(du -sm "$WORK" | cut -f1)

# npm 更新失败留下的暂存目录（里面还藏着一个 Windows 版 claude.exe）
rm -rf "$WORK"/usr/local/lib/nodejs/*/lib/node_modules/@anthropic-ai/.claude-code-* 2>/dev/null

# node 头文件：只有 node-gyp 编译原生模块时才用得上
rm -rf "$WORK"/usr/local/lib/nodejs/*/include 2>/dev/null

# 文档
rm -rf "$WORK"/usr/share/doc/* 2>/dev/null

# 可能残留的 Windows 可执行文件
find "$WORK"/usr/local/lib/nodejs -name '*.exe' -delete 2>/dev/null

after=$(du -sm "$WORK" | cut -f1)
echo "清理前 ${before} MB → 清理后 ${after} MB（省 $((before-after)) MB）"

echo "== 3/4 重新打包 =="
rm -f "$DST"
tar -czpf "$DST" -C "$WORK" . || { echo "打包失败"; exit 1; }
ls -l "$SRC" "$DST" | awk '{printf "%8.1f MB  %s\n", $5/1048576, $9}'

echo "== 4/4 清理工作目录 =="
rm -rf "$WORK"
echo done
