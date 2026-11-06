#!/usr/bin/env bash
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends fcitx5 fcitx5-rime >/tmp/rime-install.log 2>&1
echo "install rc=$?"
echo "=== fcitx5 ==="; command -v fcitx5 || echo MISSING
echo "=== Rime 方案目录 ==="; ls /usr/share/rime-data/ 2>/dev/null | head -40
echo "=== 注音/繁体相关方案 ==="; ls /usr/share/rime-data/ 2>/dev/null | grep -iE "bopo|zhuyin|cangjie|terra|luna|jyut|quick|stroke" | head -20
echo "=== 是否引入名单内 CJK 字体 ==="; fc-list 2>/dev/null | grep -iE "Noto Sans CJK|Noto Serif CJK|WenQuanYi|Source Han" | head -5 || echo "无（安全）"
echo "=== 体积 ==="; du -sh /usr/share/rime-data /usr/lib/x86_64-linux-gnu/fcitx5 2>/dev/null
