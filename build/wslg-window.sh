#!/usr/bin/env bash
# 让 :0 持有剪贴板内容，供 Windows 侧读取
export DISPLAY=:0
printf 'GUEST-WSLG-1357' | xclip -selection clipboard -i -loops 20 >/dev/null 2>&1 &
sleep 1
echo "已在 :0 写入 GUEST-WSLG-1357"

# 起一个 X11 应用，验证 WSLg 是否给出独立窗口
export DISPLAY=:0
nohup xmessage -center -timeout 40 "WSLg window probe" >/dev/null 2>&1 &
sleep 2
echo "已启动 xmessage，窗口应在 Windows 桌面上"
pgrep -a xmessage | head -2
