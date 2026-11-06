#!/bin/bash
# 开发用：把新导出的 rootfs 导入成一个独立发行版并跑起来，做端到端验证
# 用法: bash dev-import-test.sh
set -u
DISTRO=claude-vm-ci
ROOTFS_WIN='E:\Web\FuckCladue\claude-desktop\runtime\rootfs.tar.gz'
# wsl.exe 只吃 Windows 路径；rm/mkdir 只吃 Linux 路径。两者分开，别混。
DATA_WIN='E:\Web\FuckCladue\claude-desktop\build\wsl-ci'
DATA_DIR=/mnt/e/Web/FuckCladue/claude-desktop/build/wsl-ci

wsl.exe --terminate "$DISTRO" >/dev/null 2>&1 || true
sleep 1
if wsl.exe -l -q 2>/dev/null | tr -d '\0\r' | grep -qx "$DISTRO"; then
  echo "[test] 注销旧发行版 $DISTRO"
  wsl.exe --unregister "$DISTRO" >/dev/null 2>&1 || true
  sleep 1
fi

rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"
echo "[test] 导入 → $DISTRO ($DATA_WIN)"
wsl.exe --import "$DISTRO" "$DATA_WIN" "$ROOTFS_WIN" --version 2 || exit 1

echo "[test] 启动 entrypoint"
wsl.exe -d "$DISTRO" -u root -- bash -lc '
  export TZ=America/Los_Angeles LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
  setsid bash /opt/scripts/entrypoint.sh >/tmp/entry.log 2>&1 < /dev/null &
  sleep 1
  echo started
'
