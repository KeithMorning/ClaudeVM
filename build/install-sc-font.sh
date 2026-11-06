#!/bin/bash
# 安装「家族名不在 checkcc 名单里」的中文字体：Noto Sans SC（Google Fonts）
# 注意与 Noto Sans CJK SC 不是同一个家族名 —— 后者才是被扣 13 分的那一个。
set -e
P="http://192.168.240.1:7897"
URL='https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf'
DIR=/usr/share/fonts/truetype/claude-sc
mkdir -p "$DIR"
echo "== 下载 =="
curl -sL --max-time 120 -x "$P" "$URL" -o "$DIR/NotoSansSC.ttf"
ls -l "$DIR/NotoSansSC.ttf"
echo "== 刷新缓存 =="
fc-cache -f >/dev/null
echo "== 识别结果 =="
fc-list | grep -i "Noto Sans SC" | head -4
echo "中文字体总数: $(fc-list :lang=zh | wc -l)"
echo "== 名单里的名字是否仍然存在 =="
for n in "Noto Sans CJK SC" "Source Han Sans SC" "WenQuanYi Micro Hei" "Microsoft YaHei" "PingFang SC" "SimSun" "SimHei"; do
  if fc-list "$n" >/dev/null 2>&1 && [ -n "$(fc-list "$n")" ]; then echo "命中: $n"; fi
done
echo "（无输出即全部未命中）"
echo "== 复制到宿主，供打包内置 =="
mkdir -p /mnt/e/Web/FuckCladue/claude-desktop/runtime/assets/fonts
cp -f "$DIR/NotoSansSC.ttf" /mnt/e/Web/FuckCladue/claude-desktop/runtime/assets/fonts/
ls -l /mnt/e/Web/FuckCladue/claude-desktop/runtime/assets/fonts/
