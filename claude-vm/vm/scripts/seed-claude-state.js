#!/usr/bin/env node
/**
 * 首次启动前写入 Claude Code 的初始状态。
 *
 * 不加这一步，用户点开 Claude Code 看到的是「Let's get started / choose the text style」
 * 那套首次引导——在一个已经装好的桌面里弹这个，观感就是「刚装完的服务器」。
 * 这里把主题、引导标记、目录信任一次性写好，直接进可用的界面。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.claude.json');

let state = {};
try {
  state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  state = {};
}

// 保留用户已有状态，只强制覆盖「引导已看过」这几项
const merged = { ...state };
merged.theme = merged.theme || 'dark';
merged.hasCompletedOnboarding = true;
merged.hasTrustDialogAccepted = true;

// 工作区默认信任，否则每次开都要确认一次
merged.projects = merged.projects || {};
for (const dir of ['/workspace', os.homedir()]) {
  merged.projects[dir] = {
    allowedTools: [],
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
    ...(merged.projects[dir] || {}),
    hasTrustDialogAccepted: true,
  };
}

fs.writeFileSync(FILE, JSON.stringify(merged, null, 2));
console.log(`[claude-state] 已写入 ${FILE}（theme=${merged.theme}, onboarding=skipped）`);
