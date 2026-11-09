#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""打包「换机开发」源码包。

用法（仓库根目录）：
    python build/pack-dev-src.py

产物：_pack/claude-vm-dev-src-<版本>-<日期>.zip

排除大件与生成物（rootfs 650MB、node_modules、dist、日志、临时截图），
保证压缩后 10MB 级别，能直接丢给另一台机器开工。
"""

import os
import re
import sys
import zipfile
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "_pack")

# 顶层只收这些（白名单比黑名单安全，避免把临时目录打进去）
TOP_FILES = [".gitignore", ".gitattributes", "README.md", "开发交接.md"]
# tests/ 也要随源码交付：换机开发时必须能跑同一套回归测试
TOP_DIRS = ["build", "claude-desktop", "claude-vm", "docs", "tests"]

# 任何层级出现即跳过
SKIP_DIRS = {
    "node_modules", "dist", "__pycache__", ".git", ".workbuddy",
    "logs", "tmp", "tmp-ud", "tmp-ud2", "tmp-ud3",
    "wsl-ci",  # claude-desktop/build/wsl-ci/ext4.vhdx 是几十 GB 的虚拟磁盘
}
SKIP_FILES = {"rootfs.tar.gz", ".DS_Store", "Thumbs.db"}
SKIP_EXT = {
    ".log", ".zip", ".tar", ".gz", ".png", ".jpg", ".jpeg", ".mp4",
    ".exe", ".vhdx", ".7z", ".tmp", ".iso", ".dll",
}
# 子工程里的 build/dist*/runtime 都不是源码（顶层 build/ 才是要收的排障脚本）
# runtime/ 是 sync-scripts 与 rootfs 的产物，rootfs 本来就要求单独获取
SKIP_BUILD_UNDER = {"claude-desktop", "claude-vm"}
SKIP_EXTRA_UNDER = {"claude-desktop": {"build", "runtime"}}


def app_version():
    pkg = os.path.join(ROOT, "claude-desktop", "package.json")
    with open(pkg, encoding="utf-8") as f:
        m = re.search(r'"version"\s*:\s*"([^"]+)"', f.read())
    return m.group(1) if m else "0.0.0"


def collect():
    """返回 [(绝对路径, 包内相对路径)]"""
    items = []

    for name in TOP_FILES:
        p = os.path.join(ROOT, name)
        if os.path.isfile(p):
            items.append((p, name))

    for d in TOP_DIRS:
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            rel_dir = os.path.relpath(dirpath, ROOT).replace(os.sep, "/")
            top = rel_dir.split("/")[0]
            drop = set(SKIP_DIRS)
            drop |= SKIP_EXTRA_UNDER.get(top, set())
            # dist-102 / dist-103 这类历史产物目录
            dirnames[:] = [
                x for x in dirnames
                if x not in drop and not (top in SKIP_BUILD_UNDER and x.startswith("dist"))
            ]
            for fn in filenames:
                if fn in SKIP_FILES:
                    continue
                abs_p = os.path.join(dirpath, fn)
                rel = os.path.relpath(abs_p, ROOT).replace(os.sep, "/")
                if os.path.splitext(fn)[1].lower() in SKIP_EXT:
                    # 万象拼音词库是有意随源码交付的二进制资源：换机开发时
                    # 首启要能离线解压，不能依赖 GitHub release 可达性。
                    # 其余 .zip/.exe/日志一律排除。
                    if not rel.startswith("claude-vm/vm/assets/rime/"):
                        continue
                items.append((abs_p, rel))

    items.sort(key=lambda x: x[1])
    return items


def main():
    ver = app_version()
    stamp = date.today().strftime("%Y%m%d")
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"claude-vm-dev-src-{ver}-{stamp}.zip")

    items = collect()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for abs_p, rel in items:
            # zipfile 对非 ASCII 名自动置 UTF-8 标志位，Windows 资源管理器可正常解压
            z.write(abs_p, rel)

    size = os.path.getsize(out) / 1024 / 1024
    print(f"版本 {ver}｜文件 {len(items)} 个｜{size:.1f} MB")
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
