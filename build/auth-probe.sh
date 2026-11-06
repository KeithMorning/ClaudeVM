#!/usr/bin/env bash
echo "=== .claude.json 关键字段 ==="
python3 /mnt/e/Web/FuckCladue/build/claude-state.py 2>&1
echo "=== 凭据候选文件 ==="
ls -la /root/.claude/.credentials.json /root/.claude.json 2>/dev/null
echo "=== claude auth 子命令 ==="
timeout 15 claude auth status 2>&1 | head -10
