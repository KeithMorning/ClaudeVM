#!/bin/bash
# 在瘦身镜像里验证 entrypoint 的 claude 自愈逻辑（两种布局都要认）
_cb_dir="$(ls -d /usr/local/lib/nodejs/*/lib/node_modules/@anthropic-ai/claude-code 2>/dev/null | head -1)"
echo "包目录: $_cb_dir"
if [ -n "$_cb_dir" ]; then
  for _cand in "$_cb_dir/bin/claude.exe" \
               "$_cb_dir/node_modules/@anthropic-ai/claude-code-linux-x64/claude"; do
    [ -f "$_cand" ] || { echo "跳过（不存在）: $_cand"; continue; }
    chmod +x "$_cand" 2>/dev/null || true
    ln -sf "$_cand" /usr/local/bin/claude
    if timeout 20 claude --version >/tmp/claude-ver 2>&1 && grep -qE '^[0-9]+\.[0-9]+' /tmp/claude-ver; then
      echo "OK → $(head -1 /tmp/claude-ver)"
      break
    fi
    echo "不可用: $(head -1 /tmp/claude-ver)"
  done
fi
echo "which claude: $(command -v claude)"
