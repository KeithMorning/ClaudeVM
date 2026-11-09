#!/usr/bin/env bash
# 诊断 2：当前会话是否活着、X display、fcitx5 实际运行状态
echo "=== 全部相关进程 ==="
ps -ef | grep -iE 'fcitx|rime|Xvfb|Xorg|Xtigervnc|openbox|lxterminal|chrome|entrypoint' | grep -v grep | head -40
echo "=== X socket ==="
ls -la /tmp/.X11-unix 2>/dev/null
echo "=== display 环境变量文件 ==="
cat /opt/config/runtime-env 2>/dev/null | head -40 || echo '(无 runtime-env)'
echo "=== 用 DBUS 地址探测 fcitx5（从运行中的进程环境取） ==="
for p in $(pgrep -x fcitx5 2>/dev/null); do
  echo "pid=$p"
  tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -E '^(DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|GTK_IM_MODULE|XMODIFIERS)=' | head -10
done
echo "=== /tmp/fcitx5.log 末尾 ==="
tail -25 /tmp/fcitx5.log 2>/dev/null
echo "=== /tmp/fcitx5-guard.log 末尾 ==="
tail -25 /tmp/fcitx5-guard.log 2>/dev/null
echo "=== classicui 默认配置模板 ==="
find /usr/share/fcitx5 /usr/lib/x86_64-linux-gnu/fcitx5 -iname '*classicui*' 2>/dev/null | head -10
for f in $(find /usr/share/fcitx5 -iname 'classicui.conf' 2>/dev/null | head -2); do echo "--- $f"; cat "$f"; done
echo "=== fcitx5 全局 config ==="
cat /root/.config/fcitx5/config 2>/dev/null || echo '(无全局 config)'
echo "=== rime 自定义文件全文 ==="
cat /root/.local/share/fcitx5/rime/default.custom.yaml 2>/dev/null
echo "=== wanxiang schema 尾部 menu/editor ==="
grep -n -A20 '^menu:' /root/.local/share/fcitx5/rime/wanxiang_pure.schema.yaml 2>/dev/null | head -30
grep -n -A25 '^editor:' /root/.local/share/fcitx5/rime/wanxiang_pure.schema.yaml 2>/dev/null | head -35
