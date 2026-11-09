#!/usr/bin/env bash
# 诊断：输入 ffff 时候选列表消失、删除时看不到预编辑
# 用法：MSYS_NO_PATHCONV=1 wsl.exe -d claude-vm -u root -- bash /mnt/e/Web/FuckCladue/build/ime-check.sh
R=/root/.local/share/fcitx5/rime
C=/root/.config/fcitx5

echo "=== 进程 ==="
pgrep -af 'fcitx5|rime' | head -20
echo "=== fcitx5-remote state / engine ==="
fcitx5-remote 2>&1 | head -1
fcitx5-remote -n 2>&1 | head -1
echo "=== 已装 fcitx5 包 ==="
dpkg -l 2>/dev/null | grep -i 'fcitx\|rime' | awk '{print $2, $3}'
echo "=== profile ==="
cat "$C/profile" 2>/dev/null
echo "=== conf 文件列表 ==="
ls -1 "$C/conf" 2>/dev/null
echo "=== conf 内容 ==="
for f in "$C"/conf/*.conf; do echo "--- $(basename "$f")"; cat "$f"; done 2>/dev/null | head -200
echo "=== rime 目录 ==="
ls -la "$R" 2>/dev/null | head -50
echo "=== 启用的 schema ==="
grep -n -A14 'schema_list' "$R/default.yaml" "$R/default.custom.yaml" 2>/dev/null | head -50
echo "=== 各 schema 的 speller / key_binder ==="
for f in "$R"/*.schema.yaml; do
  echo "--- $(basename "$f")"
  grep -n -A45 '^speller:' "$f" | head -50
  grep -n -A30 '^key_binder:' "$f" | head -35
done 2>/dev/null
echo "=== speller 关键项全局搜索 ==="
grep -rn 'max_code_length\|auto_select\|auto_clear\|alphabet\|initials\|finisher\|fuzzy' "$R"/*.schema.yaml "$R"/*.yaml 2>/dev/null | head -60
echo "=== fcitx5 日志 ==="
find /root /tmp -maxdepth 5 -iname '*fcitx*' -name '*.log' 2>/dev/null | head -10
for f in $(find /root /tmp -maxdepth 5 -iname '*fcitx*' -name '*.log' 2>/dev/null | head -3); do echo "--- $f"; tail -30 "$f"; done
echo "=== 环境（DISPLAY / XDG / IM） ==="
env | grep -E '^(DISPLAY|XDG_RUNTIME_DIR|GTK_IM_MODULE|QT_IM_MODULE|XMODIFIERS|DBUS_SESSION_BUS_ADDRESS)=' | sort
