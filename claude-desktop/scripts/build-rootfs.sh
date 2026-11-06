#!/usr/bin/env bash
# 在 WSL (Linux) 内运行：构建运行时镜像并导出为 WSL 可导入的 rootfs.tar.gz
# 用法: bash build-rootfs.sh [构建上下文] [输出路径]
set -euo pipefail

# 默认路径按脚本自身位置推导，换机器/换盘符不用改脚本
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTX="${1:-$HERE/../../claude-vm/vm}"
OUT="${2:-$HERE/../runtime/rootfs.tar.gz}"
IMG="claude-vm:runtime"

echo "[1/4] 构建镜像 $IMG (上下文: $CTX)"
docker build -t "$IMG" "$CTX"

echo "[2/4] 创建临时容器"
CID=$(docker create "$IMG")
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

echo "[3/4] 导出文件系统 → $OUT (gzip)"
mkdir -p "$(dirname "$OUT")"
docker export "$CID" | gzip -1 > "$OUT"

echo "[4/5] 导出完成"
ls -lh "$OUT"

# 脚本单独再存一份：程序启动时会把它们同步进「已导入」的发行版，
# 这样改了 entrypoint/router 不必让用户重新导入 rootfs（保住登录态）。
echo "[5/5] 同步脚本 → $(dirname "$OUT")/scripts"
mkdir -p "$(dirname "$OUT")/scripts"
cp -f "$CTX"/scripts/* "$(dirname "$OUT")/scripts/"
ls -l "$(dirname "$OUT")/scripts"
