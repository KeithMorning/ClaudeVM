#!/bin/bash
# 统计 rootfs.tar.gz 里各部分占多少（不解包，只读索引）
T=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs.tar.gz
tar -tvzf "$T" 2>/dev/null | awk '
{
  size=$3; path=$6;
  if (path == "") next;
  split(path, a, "/");
  k = a[1];
  if (a[1] == ".") k = a[2];
  tot[k] += size;
  if (path ~ /^\.?\/?usr\/share\/doc\//) doc += size;
  else if (path ~ /^\.?\/?usr\/share\/man\//) man += size;
  else if (path ~ /^\.?\/?usr\/share\/locale\//) loc += size;
  else if (path ~ /^\.?\/?var\/lib\/apt\/lists\//) apt += size;
  else if (path ~ /^\.?\/?usr\/lib\/locale\//) libloc += size;
}
END {
  n=0; for (k in tot) { n++; ks[n]=k }
  # 简单插入排序取前 12
  for (i=1;i<=n;i++) for (j=i+1;j<=n;j++) if (tot[ks[j]]>tot[ks[i]]) { t=ks[i]; ks[i]=ks[j]; ks[j]=t }
  print "== 顶层目录占用（字节 → MB） ==";
  for (i=1;i<=n && i<=12;i++) printf "%-18s %8.1f MB\n", ks[i], tot[ks[i]]/1048576;
  print "";
  printf "usr/share/doc      %8.1f MB\n", doc/1048576;
  printf "usr/share/man      %8.1f MB\n", man/1048576;
  printf "usr/share/locale   %8.1f MB\n", loc/1048576;
  printf "var/lib/apt/lists  %8.1f MB\n", apt/1048576;
  printf "usr/lib/locale     %8.1f MB\n", libloc/1048576;
}'
