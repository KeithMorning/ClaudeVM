#!/usr/bin/env node
'use strict';
// ============================================================
// proxy-router.js — 容器内「白名单 / 全量」转发代理
//
// 机制：
//   Claude Code / Chrome 把 HTTP(S) 流量统一打到本代理 127.0.0.1:PORT，
//   本代理按域名白名单决定出口：
//     · 命中白名单(默认 Anthropic 系域名) → 经 UPSTREAM_PROXY 出站
//     · 未命中                              → 直连(容器本机出口)
//
// 两种分流模式（PROXY_MODE）：
//   whitelist（默认）：只有白名单域名走上游，其余直连。适合「宿主机上开着
//                      代理软件」的场景 —— 不想让全部流量都被代理。
//   all            ：全部流量走上游。配合 SSH 隧道到用户自己的 VPS 使用，
//                      此时整台机器的出口就是那台 VPS，与「真的在该 VPS 上
//                      装 Claude Code」完全一致（ASN / 地理 / Cloudflare POP
//                      三者自洽）。
//
// 上游支持两种协议：
//   http://host:port        —— 标准 HTTP 代理（CONNECT）
//   socks5h://host:port     —— SOCKS5，且域名交给对端解析（socks5h 的 h）。
//                              这一条很关键：DNS 必须在 VPS 那侧解析，否则
//                              「域名解析地」和「出口地」会分处两个国家。
//   socks5://host:port      —— SOCKS5，域名本地解析后送 IP
//   （Claude Code 自身不支持 SOCKS，所以它永远连本 router，由本 router 转出去）
// ============================================================

const http = require('http');
const net = require('net');

const PORT = parseInt(process.env.PROXY_ROUTER_PORT || '7890', 10);
const UPSTREAM = (process.env.UPSTREAM_PROXY || '').trim();
const MODE = (process.env.PROXY_MODE || 'whitelist').trim().toLowerCase();
const WHITELIST = (process.env.PROXY_WHITELIST ||
  '.anthropic.com,.claude.com,.claude.ai,.claudeusercontent.com,clau.de')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function parseUpstream(u) {
  if (!u) return null;
  const s = u.trim();
  const m = /^(https?|socks5h?|socks):\/\/(?:([^:@/]*):?([^@/]*)@)?([^:/]+):?(\d+)?/i.exec(s);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const port = parseInt(m[5], 10) || (scheme === 'https' ? 443 : scheme.startsWith('socks') ? 1080 : 80);
  return {
    type: scheme.startsWith('socks') ? 'socks5' : 'http',
    remoteDns: scheme === 'socks5h',
    host: m[4],
    port,
    user: m[2] ? decodeURIComponent(m[2]) : '',
    pass: m[3] ? decodeURIComponent(m[3]) : '',
  };
}
const UP = parseUpstream(UPSTREAM);

function hostMatches(host) {
  host = (host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return WHITELIST.some(s => {
    if (s.startsWith('.')) return host.endsWith(s) || host === s.slice(1);
    return host === s || host.endsWith('.' + s);
  });
}

const useUpstream = (host) => !!UP && (MODE === 'all' || hostMatches(host));

function pipeSockets(a, b) {
  a.pipe(b); b.pipe(a);
  a.on('error', () => b.destroy());
  b.on('error', () => a.destroy());
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
}

// ---------- SOCKS5 客户端 ----------
// 成功回调 (null, socket)；失败回调 (err)
const SOCKS5_ERR = {
  1: 'general failure', 2: 'connection not allowed', 3: 'network unreachable',
  4: 'host unreachable', 5: 'connection refused', 6: 'TTL expired',
  7: 'command not supported', 8: 'address type not supported',
};

function socks5Connect(host, port, done) {
  const sock = net.connect(UP.port, UP.host);
  let stage = 'greet';
  let buf = Buffer.alloc(0);
  let settled = false;
  const fail = (msg) => {
    if (settled) return;
    settled = true;
    try { sock.destroy(); } catch {}
    done(new Error(msg));
  };
  const ok = () => {
    if (settled) return;
    settled = true;
    sock.setTimeout(0);
    done(null, sock);
  };

  sock.setTimeout(15000, () => fail('socks5 上游超时'));
  sock.on('error', (e) => fail('socks5 上游连接失败: ' + e.message));
  sock.once('connect', () => {
    // 有账号密码时同时提供 无认证/用户名密码 两种，让对端挑
    sock.write(UP.user ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
  });
  sock.on('data', onData);

  function sendRequest() {
    const useDomain = UP.remoteDns || !net.isIP(host);
    let head;
    if (useDomain) {
      const d = Buffer.from(host, 'utf8');
      head = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, d.length]), d]);
    } else if (net.isIPv4(host)) {
      head = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), Buffer.from(host.split('.').map(Number))]);
    } else {
      // IPv6 兜底也走域名形式，让对端解析
      const d = Buffer.from(host, 'utf8');
      head = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, d.length]), d]);
    }
    const pb = Buffer.alloc(2);
    pb.writeUInt16BE(port || 443, 0);
    sock.write(Buffer.concat([head, pb]));
    stage = 'reply';
  }

  function onData(chunk) {
    buf = Buffer.concat([buf, chunk]);

    if (stage === 'greet') {
      if (buf.length < 2) return;
      if (buf[0] !== 0x05) return fail('socks5 上游版本不对');
      const method = buf[1];
      buf = buf.slice(2);
      if (method === 0x00) return sendRequest();
      if (method === 0x02) {
        const u = Buffer.from(UP.user, 'utf8');
        const p = Buffer.from(UP.pass, 'utf8');
        sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        stage = 'auth';
        return;
      }
      return fail('socks5 上游不接受任何认证方式（' + method + '）');
    }

    if (stage === 'auth') {
      if (buf.length < 2) return;
      if (buf[1] !== 0x00) return fail('socks5 用户名/密码被拒绝');
      buf = buf.slice(2);
      return sendRequest();
    }

    if (stage === 'reply') {
      if (buf.length < 4) return;
      if (buf[1] !== 0x00) return fail('socks5 连接被拒: ' + (SOCKS5_ERR[buf[1]] || ('rep=' + buf[1])));
      const atyp = buf[3];
      let need;
      if (atyp === 0x01) need = 4 + 4 + 2;
      else if (atyp === 0x03) need = buf.length < 5 ? 5 : 4 + 1 + buf[4] + 2;
      else if (atyp === 0x04) need = 4 + 16 + 2;
      else return fail('socks5 返回未知地址类型 ' + atyp);
      if (buf.length < need) return;
      const rest = buf.slice(need);
      sock.removeListener('data', onData);
      if (rest.length) sock.unshift(rest);   // 对端可能已经带了应用层数据
      return ok();
    }
  }
}

// ---------- HTTP 代理上游 ----------
function httpConnect(host, port, done) {
  const up = net.connect(UP.port, UP.host, () => {
    up.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nUser-Agent: claude-vm-router\r\n\r\n`);
  });
  let buf = Buffer.alloc(0);
  let settled = false;
  const fail = (msg) => {
    if (settled) return; settled = true;
    try { up.destroy(); } catch {}
    done(new Error(msg));
  };
  up.setTimeout(15000, () => fail('HTTP 上游超时'));
  up.on('error', (e) => fail('HTTP 上游连接失败: ' + e.message));
  up.on('data', (chunk) => {
    if (settled) return;
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    const head = buf.slice(0, idx).toString();
    if (!/^HTTP\/1\.[01] 200/.test(head)) return fail('上游拒绝：' + head.split('\r\n')[0]);
    settled = true;
    up.setTimeout(0);
    up.removeAllListeners('data');
    const rest = buf.slice(idx + 4);
    if (rest.length) up.unshift(rest);
    done(null, up);
  });
}

// 统一入口：返回已连通的 socket
function connectVia(host, port, done) {
  if (!UP) return done(new Error('未配置上游'));
  if (UP.type === 'socks5') socks5Connect(host, port, done);
  else httpConnect(host, port, done);
}

// ---------- CONNECT 处理 ----------
function directConnect(host, port, client, head) {
  const sock = net.connect(port || 443, host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) sock.write(head);
    pipeSockets(client, sock);
  });
  sock.on('error', () => client.destroy());
  client.on('error', () => sock.destroy());
}

function upstreamConnect(host, port, client, head) {
  connectVia(host, port, (err, sock) => {
    if (err) {
      console.error(`[proxy-router] ${host}:${port} 上游失败 → ${err.message}`);
      client.destroy();
      return;
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) sock.write(head);
    pipeSockets(client, sock);
  });
}

// ---------- 普通 HTTP（明文） ----------
function forwardHttp(req, res) {
  let parsed;
  try { parsed = new URL(req.url); } catch { res.writeHead(502); res.end(); return; }
  const target = { host: parsed.hostname, port: parseInt(parsed.port, 10) || 80 };
  const pathQ = parsed.pathname + parsed.search;

  if (useUpstream(target.host)) {
    connectVia(target.host, target.port, (err, sock) => {
      if (err) { res.writeHead(502); res.end(); return; }
      const upReq = http.request({
        method: req.method,
        path: pathQ,
        headers: { ...req.headers, host: req.headers.host || parsed.host },
        createConnection: () => sock,
      }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      upReq.on('error', () => res.destroy());
      req.pipe(upReq);
    });
    return;
  }

  const p = http.request({
    host: target.host, port: target.port, method: req.method, path: pathQ, headers: req.headers,
  }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  p.on('error', () => res.destroy());
  req.pipe(p);
}

const server = http.createServer((req, res) => {
  // 供「运行环境自检」查询当前分流状态，不影响代理功能
  if (req.url === '/__router_status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      mode: MODE,
      upstream: UP ? `${UP.type}${UP.remoteDns ? 'h' : ''}://${UP.host}:${UP.port}` : null,
      whitelist: WHITELIST,
    }));
    return;
  }
  forwardHttp(req, res);
});

// 关键：CONNECT 不会进 request 回调。Node 规定：若未监听 'connect'，
// 客户端发来的 CONNECT 会被直接关闭连接 —— 表现为“代理没反应”。
server.on('connect', (req, clientSocket, head) => {
  const raw = req.url || '';
  const i = raw.lastIndexOf(':');
  const host = i > 0 ? raw.slice(0, i) : raw;
  const port = i > 0 ? (parseInt(raw.slice(i + 1), 10) || 443) : 443;
  clientSocket.on('error', () => {});
  if (useUpstream(host)) upstreamConnect(host, port, clientSocket, head);
  else directConnect(host, port, clientSocket, head);
});

server.on('error', (e) => console.error('[proxy-router] error', e.message));
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy-router] 监听 127.0.0.1:${PORT}`);
  console.log(`[proxy-router] 分流模式: ${MODE === 'all' ? '全量走上游' : '仅白名单走上游'}`);
  if (MODE !== 'all') console.log(`[proxy-router] 白名单(${WHITELIST.length}): ${WHITELIST.join(' ')}`);
  console.log(`[proxy-router] 上游: ${UP ? `${UP.type}${UP.remoteDns ? 'h' : ''}://${UP.host}:${UP.port}` : '(无 → 全部直连)'}`);
});
