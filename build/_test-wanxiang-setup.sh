#!/usr/bin/env bash
SRC=/mnt/e/Web/FuckCladue/claude-desktop/runtime/scripts
for f in "$SRC"/*; do [ -f "$f" ] || continue; b=$(basename "$f"); cp -f "$f" "/opt/scripts/.$b.tmp" && mv -f "/opt/scripts/.$b.tmp" "/opt/scripts/$b"; done
chmod +x /opt/scripts/*.sh
mkdir -p /opt/assets/rime
cp /mnt/e/Web/FuckCladue/claude-desktop/runtime/assets/rime/wanxiang-pure.zip /opt/assets/rime/
rm -f /root/.config/ibus/rime/.wanxiang-v18.1.8
echo "=== 首次启用 ==="
INPUT_METHOD=rime /opt/scripts/rime-setup.sh
echo "=== 生成的配置 ==="; cat /root/.config/ibus/rime/default.custom.yaml
echo "=== 词库与编译产物 ==="; ls -lh /root/.config/ibus/rime/.wanxiang-v18.1.8 /root/.config/ibus/rime/wanxiang_pure.schema.yaml /root/.config/ibus/rime/dicts/jichu.pro.dict.yaml /root/.config/ibus/rime/build/wanxiang_pure.table.bin 2>&1 | awk '{print $5, $9}'
echo "=== 幂等：再跑一次 ==="; INPUT_METHOD=rime /opt/scripts/rime-setup.sh
