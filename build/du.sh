#!/bin/bash
echo "== /usr/local =="
du -xhd1 /usr/local 2>/dev/null | sort -hr | head -8
echo "== /usr/local/lib =="
du -xhd1 /usr/local/lib 2>/dev/null | sort -hr | head -8
echo "== /usr/lib =="
du -xhd1 /usr/lib 2>/dev/null | sort -hr | head -8
echo "== /usr/share =="
du -xhd1 /usr/share 2>/dev/null | sort -hr | head -8
echo "== 最大文件 TOP12 =="
find / -xdev -type f -size +30M -printf '%s %p\n' 2>/dev/null | sort -rn | head -12 | while read -r sz p; do
  printf '%6.0f MB  %s\n' "$(echo "$sz/1048576" | bc -l)" "$p"
done
