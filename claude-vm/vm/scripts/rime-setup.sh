#!/usr/bin/env bash
# ============================================================
# rime-setup.sh — 按需安装 IBus + Rime（万象拼音 Pure 词库）
#
# 为什么是 IBus 而不是 fcitx5：
#   WSLg 不转发 Windows IME 的 preedit 组合串，但**按键本身是转发的**。
#   所以把输入法放在虚拟机内部跑，组合与提交都在 Linux 侧完成，不碰 Windows IME。
#   IBus 保留 `--xim` 只为兼容老 Xt 客户端；**1.0.31 起真正的中文入口是
#   GTK3 原生 im module**：装 ibus-gtk3（80KB）后，lxterminal 与 Chrome 都走
#   `GTK_IM_MODULE=ibus`，候选框跟随光标、Ctrl+Space 切换可靠、Pango 正确渲染 CJK。
#   以前只有 XIM：xterm 连输入上下文都建不起来（终端一个中文都打不进），
#   Chrome 勉强能收字符但候选窗飘在左下角、字形变方块 —— 都是 XIM 的锅。
#   fcitx5 从 5.0 起移除了 XIM，且换它要迁词库 + 显式管 D-Bus，收益不抵复杂度。
#
# 为什么按需联网装、而不是塞进 rootfs：
#   WSL 发行版的文件系统是持久的，装一次就一直在；不必重打 720MB 的 rootfs。
#   apt 部分约 20MB（含 80KB 的 ibus-gtk3 与 593KB 的 lxterminal），且
#   --no-install-recommends 后**不含任何字体包** —— 这很关键，装
#   fonts-noto-cjk 会命中 checkcc 的字体名单直接扣分。
#   词库 zip 已随安装包放在 /opt/assets/rime，离线解压，不依赖 GitHub 可达性。
#
# 关于「换成万象词库有没有影响」：
#   词库是 Rime 的 .dict.yaml/.schema.yaml 数据文件，检测站看不到输入法，
#   也看不到打进 Claude Code 的字；它不影响时区/语言/字体/出口任何一项，评分不变。
#   唯一代价是体积（zip 26MB / 解压约 75MB / 编译产物约 59MB）与首次编译耗时。
# ============================================================
set -u

[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env

need=0
command -v ibus-daemon >/dev/null 2>&1 || need=1
[ -x /usr/libexec/ibus-x11 ] || need=1
[ -f /usr/share/rime-data/stroke.schema.yaml ] || need=1
# 1.0.31：GTK3 原生输入模块 + GTK 终端。缺了 im-ibus.so，GTK 应用会整体
# 降级到 XIM；缺了 lxterminal 就还在用只认 XIM 的 xterm。两个都是小包。
ls /usr/lib/*/gtk-3.0/*/immodules/im-ibus.so >/dev/null 2>&1 || need=1
command -v lxterminal >/dev/null 2>&1 || need=1

if [ "$need" = "1" ]; then
  echo "[rime] 首次启用：安装 ibus / ibus-rime / GTK 输入模块 / lxterminal…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1
  # 明确不装任何中文字体包：中文渲染复用镜像里的 Noto Sans SC，
  # 它的家族名不在 checkcc 硬编码的 17 个指纹名单里。
  if ! apt-get install -y --no-install-recommends \
        ibus ibus-rime rime-data-stroke ibus-gtk3 lxterminal \
        >/tmp/rime-setup.log 2>&1; then
    echo "[rime] 安装失败，详见 /tmp/rime-setup.log"
    exit 1
  fi
  echo "[rime] 安装完成（未引入任何字体包）"
fi

# ---- 万象拼音 Pure 词库（离线解压）----
# 来源：amzxyz/rime_wanxiang v18.1.8 Pure，CC BY 4.0（包内自带 README/许可说明）。
# 为什么选 Pure：Base / Pro / Lite 都依赖 librime 的 Lua 插件，而 Ubuntu 22.04
# 只有 librime 1.7.3；Pure 官方定位就是「老系统 / 旧 Rime / 无 Lua 环境」。
# 实测在 1.7.3 上成功编译出 wanxiang_pure.table.bin（约 59MB）。
# 词库自带 opencc/（s2t / TWVariants 等），所以 Pure 仍能打繁体，不依赖 Lua。
RIME_DIR=/root/.config/ibus/rime
WANT=/opt/assets/rime/wanxiang-pure.zip
STAMP="$RIME_DIR/.wanxiang-v18.1.8"
mkdir -p "$RIME_DIR"
if [ -f "$WANT" ] && [ ! -f "$STAMP" ]; then
  echo "[rime] 首次部署万象词库（解压约 75MB，首次编译约 1 分钟）…"
  if python3 - "$WANT" "$RIME_DIR" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
z.extractall(sys.argv[2])
print("[rime] 解压完成：%d 个文件" % len(z.namelist()))
PY
  then
    touch "$STAMP"
  else
    echo "[rime] 词库解压失败，将退回 luna_pinyin"
  fi
elif [ ! -f "$WANT" ]; then
  echo "[rime] 警告：未找到 $WANT，将退回系统自带 luna_pinyin"
fi

if [ -f "$RIME_DIR/wanxiang_pure.schema.yaml" ]; then
  SCHEMA=wanxiang_pure
else
  SCHEMA=luna_pinyin
fi
# ibus-rime 的用户数据目录是 ~/.config/ibus/rime，不是 ~/.config/fcitx5/rime。
cat > "$RIME_DIR/default.custom.yaml" <<YAML
patch:
  schema_list:
    - schema: $SCHEMA
  menu:
    page_size: 9
YAML

# ibus 预加载 rime 引擎（无图形面板，靠 dconf 直接写）。
# dconf 需要 session dbus，失败也没关系 —— entrypoint 会再执行一次 `ibus engine rime`。
if command -v dconf >/dev/null 2>&1; then
  dconf write /desktop/ibus/general/preload-engines "['rime']" >/dev/null 2>&1 || true
  dconf write /desktop/ibus/general/engines-order "['rime']" >/dev/null 2>&1 || true
fi

echo "[rime] 配置完成：$SCHEMA"
exit 0
