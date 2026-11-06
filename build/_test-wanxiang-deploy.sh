#!/usr/bin/env bash
R=/root/.config/ibus/rime
mkdir -p "$R"
python3 - <<'PY'
import zipfile
zipfile.ZipFile('/tmp/wanxiang-pure.zip').extractall('/root/.config/ibus/rime')
print('解压完成')
PY
echo "=== Pure 自带 default.yaml 的 schema_list ==="
grep -A6 "schema_list" "$R/default.yaml" 2>/dev/null | head -10
cat > "$R/default.custom.yaml" <<'YAML'
patch:
  schema_list:
    - schema: wanxiang_pure
  menu:
    page_size: 9
YAML
echo "=== 词库大小 ==="; ls -lh "$R/wanxiang_pure.dict.yaml" 2>/dev/null
echo "=== 启动 ibus 触发 Rime 部署 ==="
pkill -x ibus-daemon 2>/dev/null || true; sleep 1
export DISPLAY=:0 LANG=zh_TW.UTF-8 XMODIFIERS=@im=ibus GTK_IM_MODULE=ibus QT_IM_MODULE=ibus
ibus-daemon -d --xim >/tmp/ibus-wx.log 2>&1
sleep 4
echo "XIM: $(xprop -root XIM_SERVERS 2>/dev/null | head -1)"
ibus engine rime 2>&1 | head -2
echo "engine: $(ibus engine 2>/dev/null | head -1)"
echo "=== 等待词库编译（最多 90 秒）==="
for i in $(seq 1 18); do
  [ -f "$R/build/wanxiang_pure.table.bin" ] && break
  sleep 5
done
echo "=== build 产物 ==="; ls -lh "$R/build/" 2>/dev/null | head -20 || echo "无 build 目录"
echo "=== 方案编译结果 ==="; ls "$R/build/" 2>/dev/null | grep -i wanxiang | head -10 || echo "未生成万象编译产物"
echo "=== Rime 日志错误 ==="; grep -riE "error|fail|invalid" /tmp/rime* /tmp/ibus-wx.log "$R"/*.log /root/.config/ibus/rime/*.log 2>/dev/null | head -12 || echo "无报错"
