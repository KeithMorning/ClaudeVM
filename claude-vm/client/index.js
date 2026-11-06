#!/usr/bin/env node
// claude-vm 本地客户端
// 职责：
//   1) 在本机拉起虚拟环境容器（桌面 + Chrome + Claude Code + noVNC 流服务）
//   2) 注入地区(时区/语言)、白名单代理、工作区目录
//   3) 启动本地控制台(局域网 localhost)，内嵌 noVNC 流 + 运行 check-cc 校对
//
// 用法：
//   node index.js start [--workspace <dir>] [--region us-east] [--proxy http://host:port]
//   node index.js stop
//   node index.js status

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');

const REGIONS = require('./regions');

const CONFIG_PATH = path.join(os.homedir(), '.claude-vm', 'config.json');
const IMAGE = process.env.CLAUDE_VM_IMAGE || 'claude-vm:latest';
const CONTAINER = 'claude-vm';
const NOVNC_PORT = 6080;
const DASH_PORT = 7654;
const VNC_PASSWORD = 'claudevm';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
function dockerSync(args) {
  return execSync(`docker ${args}`, { encoding: 'utf8' });
}
function containerRunning() {
  try {
    return dockerSync(`ps -q -f name=^${CONTAINER}$`).trim().length > 0;
  } catch { return false; }
}

function start(opts) {
  const cfg = { ...loadConfig(), ...opts };
  if (cfg.region && REGIONS[cfg.region]) {
    cfg.tz = REGIONS[cfg.region].tz;
    cfg.lang = REGIONS[cfg.region].lang;
  }
  saveConfig(cfg);

  if (!containerRunning()) {
    const workspace = cfg.workspace || path.join(os.homedir(), 'claude-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const tz = cfg.tz || 'America/New_York';
    const lang = cfg.lang || 'en_US.UTF-8';
    const proxy = cfg.proxy || '';

    const envs = [
      `-e TZ=${tz}`,
      `-e LANG=${lang}`,
      `-e LC_ALL=${lang}`,
      `-e LANGUAGE=${lang.split('.')[0]}:en`,
      `-e REGION_LABEL=${cfg.region || tz}`,
    ];
    // 白名单代理：容器内 router 仅把 Anthropic 流量转发到上游代理，其余直连
    if (proxy) {
      const router = `http://127.0.0.1:${cfg.routerPort || 7890}`;
      envs.push(`-e UPSTREAM_PROXY=${proxy}`);
      // 直接写进容器配置，使 docker exec(自检) 也能读到，而非仅靠 entrypoint 运行时 export
      envs.push(`-e HTTPS_PROXY=${router}`, `-e HTTP_PROXY=${router}`, `-e NO_PROXY=localhost,127.0.0.1`);
      if (cfg.whitelist) envs.push(`-e PROXY_WHITELIST=${cfg.whitelist}`);
    }

    const runArgs = [
      'run', '-d', '--name', CONTAINER,
      '-p', `${NOVNC_PORT}:${NOVNC_PORT}`,
      '-v', `${workspace}:/workspace`,
      ...envs,
      IMAGE,
    ];
    console.log('启动本地虚拟环境容器…');
    console.log('  workspace:', workspace);
    console.log('  region:', cfg.region || tz, ' proxy:', proxy || '(无)');
    dockerSync(runArgs.join(' '));
  } else {
    console.log('容器已在运行。');
  }

  console.log(`\n虚拟环境流服务(本机): http://localhost:${NOVNC_PORT}/vnc.html?autoconnect=true&password=${VNC_PASSWORD}`);
  console.log('（直接在浏览器打开上面的地址，或用下面的控制台）\n');
  startDashboard();
}

function stop() {
  try {
    dockerSync(`stop ${CONTAINER}`);
    dockerSync(`rm -f ${CONTAINER}`);
    console.log('已停止并移除容器。');
  } catch (e) {
    console.error('停止失败:', e.message);
  }
}

function startDashboard() {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/status', (req, res) => res.json({ running: containerRunning() }));

  app.post('/api/check', (req, res) => {
    if (!containerRunning()) return res.json({ ok: false, out: '容器未运行' });
    try {
      const out = dockerSync(`exec ${CONTAINER} /opt/scripts/check-env.sh`);
      res.json({ ok: true, out });
    } catch (e) { res.json({ ok: false, out: (e.stderr || e.stdout || e.message) }); }
  });

  app.post('/api/stop', (req, res) => {
    try { dockerSync(`stop ${CONTAINER}`); dockerSync(`rm -f ${CONTAINER}`); res.json({ ok: true }); }
    catch (e) { res.json({ ok: false, msg: e.message }); }
  });

  app.listen(DASH_PORT, () => {
    const url = `http://localhost:${DASH_PORT}`;
    console.log('本地控制台:', url);
    openBrowser(url);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'cmd /c start'
            : 'xdg-open';
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true }); } catch {}
}

// ---- CLI ----
const [,, cmd, ...rest] = process.argv;
function parseOpts() {
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--workspace') o.workspace = rest[++i];
    if (rest[i] === '--region') o.region = rest[++i];
    if (rest[i] === '--proxy') o.proxy = rest[++i];
    if (rest[i] === '--whitelist') o.whitelist = rest[++i];
  }
  return o;
}

if (cmd === 'start') start(parseOpts());
else if (cmd === 'stop') stop();
else if (cmd === 'status') console.log(containerRunning() ? 'running' : 'stopped');
else {
  console.log(`claude-vm 本地客户端

  node index.js start [--workspace <dir>] [--region us-east] [--proxy http://host:port] [--whitelist ...]
  node index.js stop
  node index.js status

可用 region: ${Object.keys(REGIONS).join(', ')}
先构建镜像: docker build -t claude-vm:latest ./vm

说明:
  --proxy     仅 Anthropic 流量走这个上游 HTTP(S) 代理，其余直连(白名单代理)
  --whitelist 自定义白名单(逗号分隔域名后缀)，默认 .anthropic.com,.claude.ai,.claudeusercontent.com`);
}
