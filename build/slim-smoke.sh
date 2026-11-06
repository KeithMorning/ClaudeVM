#!/bin/bash
t() { timeout 20 "$@" 2>&1 | head -1; }
echo "chrome  : $(t /opt/google/chrome/chrome --version)"
echo "node    : $(t node -v)"
echo "npm     : $(t npm -v)"
echo "python  : $(python3 -c 'import websockify; print("websockify ok")' 2>&1 | head -1)"
echo "websock : $(websockify --help 2>&1 | head -1)"
echo "claude  : $(t claude --version)"
echo "novnc   : $(ls /usr/share/novnc/desktop.html 2>&1)"
echo "themerc : $(ls /opt/config/themes/Claude/openbox-3/themerc 2>&1)"
echo "fonts   : $(fc-list | wc -l) 个，其中中文 $(fc-list :lang=zh | wc -l) 个"
echo "locale  : $(locale -a 2>/dev/null | grep -c '^en_US')"
