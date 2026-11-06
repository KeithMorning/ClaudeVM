#!/bin/bash
# 开发用：终端渲染样式样本（验证字体、颜色、字距）
clear
echo "Claude Code output sample:"
echo "The quick brown fox jumps over the lazy dog 0123456789"
echo "{} [] () <> |/ !@#\$% ^&* _+-= ~\`"
printf '\033[1;32m>_\033[0m  \033[1;33mbold\033[0m  \033[1;36mcyan\033[0m  normal text here\n'
printf '\033[1;31mred\033[0m \033[1;35mmagenta\033[0m \033[1;34mblue\033[0m \033[2mdim\033[0m\n'
echo
echo "$ pwd"
echo "/workspace"
sleep 120
