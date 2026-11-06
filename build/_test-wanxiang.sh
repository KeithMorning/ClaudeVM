#!/usr/bin/env bash
P=http://192.168.240.1:7897
URL=https://github.com/amzxyz/rime_wanxiang/releases/download/v18.1.8/rime-wanxiang-pure.zip
echo "=== 下载 Pure 版（经代理）==="
curl -L -sS --connect-timeout 8 --max-time 180 -x "$P" -o /tmp/wanxiang-pure.zip -w "http=%{http_code} size=%{size_download}\n" "$URL" || echo "下载失败"
ls -l /tmp/wanxiang-pure.zip 2>/dev/null
echo "=== 包内结构 ==="
python3 - <<'PY'
import zipfile
try:
    z=zipfile.ZipFile('/tmp/wanxiang-pure.zip')
    ns=z.namelist()
    print('文件数',len(ns))
    for n in ns[:25]: print(' ',n)
    print('含 Lua:', any('/lua/' in n or n.startswith('lua/') for n in ns))
    print('主方案:', [n for n in ns if 'wanxiang_pure' in n][:5])
except Exception as e: print('zip 错误:',e)
PY
