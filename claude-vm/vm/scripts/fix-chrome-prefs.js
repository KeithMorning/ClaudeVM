#!/usr/bin/env node
/**
 * 消除 Chrome「恢复页面 / Chrome didn't shut down correctly」气泡。
 * 每次强制停止环境都会留下 exited_cleanly=false，下次启动必弹。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = path.join(os.homedir(), '.config', 'google-chrome');

function patch(file) {
  try {
    if (!fs.existsSync(file)) return false;
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    j.profile = j.profile || {};
    j.profile.exit_type = 'Normal';
    j.profile.exited_cleanly = true;
    fs.writeFileSync(file, JSON.stringify(j));
    return true;
  } catch {
    return false;
  }
}

let n = 0;
if (fs.existsSync(BASE)) {
  for (const d of fs.readdirSync(BASE)) {
    if (patch(path.join(BASE, d, 'Preferences'))) n++;
  }
}
// 没有 profile 时不需要处理（首次启动本来就不会有该气泡）
if (process.env.VERBOSE) console.log(`[chrome-prefs] 已复位 ${n} 个 profile`);
