#!/bin/bash
# 复现 checkcc 的「多源 IP 情报」：看每个源究竟认为我们是谁
P="http://192.168.240.1:7897"
echo "== ping0.cc/geo (JSONP 同源，浏览器走的就是这个) =="
curl -s --max-time 12 -x "$P" -H 'Referer: https://checkcc.org/' https://ping0.cc/geo/jsonp/cbtest | head -c 400
echo
echo "== api.ip.sb/geoip（不带参数 = 由调用方自己的出口决定） =="
curl -s --max-time 12 -x "$P" https://api.ip.sb/geoip | head -c 400
echo
echo "== api.ip.sb/ip =="
curl -s --max-time 12 -x "$P" https://api.ip.sb/ip
echo
echo "== ipapi.co/json =="
curl -s --max-time 12 -x "$P" https://ipapi.co/json/ | head -c 200
echo
echo "== ipwho.is =="
curl -s --max-time 12 -x "$P" https://ipwho.is/ | head -c 200
