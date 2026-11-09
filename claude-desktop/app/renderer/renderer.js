'use strict';
// 渲染层逻辑：读取配置、启动/停止运行时、内嵌 noVNC、自检结果渲染
const REGIONS = {
  // 中国台湾地区·台北：UTC+8 与中文作息一致，且不在检测站点名的中国时区名单里。
  // 挂 VPN 出境（哪怕落地洛杉矶）是当地用户的日常，不构成「信号不一致」。
  'tw-taipei': { tz: 'Asia/Taipei', lang: 'zh_TW.UTF-8' },
  'us-east': { tz: 'America/New_York', lang: 'en_US.UTF-8' },
  'us-west': { tz: 'America/Los_Angeles', lang: 'en_US.UTF-8' },
  uk: { tz: 'Europe/London', lang: 'en_GB.UTF-8' },
  jp: { tz: 'Asia/Tokyo', lang: 'ja_JP.UTF-8' },
  de: { tz: 'Europe/Berlin', lang: 'de_DE.UTF-8' },
  sg: { tz: 'Asia/Singapore', lang: 'en_US.UTF-8' },
};

const $ = (id) => document.getElementById(id);
// 用自带的极简页面：没有 noVNC 那个悬浮控制条（剪贴板/键盘/设置那一列），
// 剪贴板与特殊键由宿主这边双向桥接，用户当成本地窗口直接用。
const novncUrl = (host) => `http://${host || '127.0.0.1'}:6080/desktop.html?autoconnect=1`;

const MARK = { pass: '✓', warn: '!', fail: '✕', info: 'i' };

let cfg = {};
let lastCheck = null;   // 最近一次自检结果，供「原始输出」复用
let lastData = null;    // 最近一次结构化结果，供筛选切换复用
let showAll = false;    // false = 只看需要处理的项目

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function gather() {
  const region = $('region').value;
  const r = REGIONS[region] || REGIONS['us-east'];
  return {
    region,
    tz: r.tz,
    lang: r.lang,
    proxy: $('proxy').value.trim(),
    proxyMode: $('proxyMode').value,
    whitelist: $('whitelist').value.trim(),
    workspace: $('workspace').value.trim(),
    displayMode: $('displayMode').value === 'desktop' ? 'desktop' : 'wslg',
    netGuard: $('netGuard').value === 'off' ? 'off' : 'strict',
    netGuardStrictRegion: cfg.netGuardStrictRegion !== false,
    inputMethod: $('inputMethod').value === 'rime' ? 'rime' : 'off',
  };
}

// 白名单输入框只在「仅白名单」模式下才有意义
function syncProxyMode() {
  $('wlBox').hidden = $('proxyMode').value !== 'whitelist';
}

function fill(c) {
  $('region').value = c.region || 'us-east';
  $('proxy').value = c.proxy || '';
  $('proxyMode').value = c.proxyMode === 'whitelist' ? 'whitelist' : 'all';
  $('whitelist').value = c.whitelist || '.anthropic.com,.claude.com,.claude.ai,.claudeusercontent.com,clau.de';
  $('workspace').value = c.workspace || '';
  $('displayMode').value = c.displayMode === 'desktop' ? 'desktop' : 'wslg';
  $('netGuard').value = c.netGuard === 'off' ? 'off' : 'strict';
  $('inputMethod').value = c.inputMethod === 'rime' ? 'rime' : 'off';
  // macOS 没有 WSLg：隐藏选项并锁定为串流桌面
  if (c._platform === 'darwin') {
    const sel = $('displayMode');
    [...sel.options].forEach((o) => { if (o.value !== 'desktop') o.remove(); });
    sel.value = 'desktop';
    sel.disabled = true;
  }
  syncProxyMode();
  syncDisplayMode();
}

// 未启动时的占位文案跟着模式走，别在 WSLg 模式下骗用户「桌面上会串流显示」。
// 已经启动时不改画面：切换显示模式需要「停止 → 启动」，交给 doStart 统一处理。
function syncDisplayMode() {
  const wslg = $('displayMode').value !== 'desktop';
  if ($('wslgPanel').hidden && $('view').hidden) {
    $('phTitle').textContent = '虚拟环境尚未启动';
    $('phSub').textContent = wslg
      ? '点击「启动虚拟环境」，Claude Code 终端会以 Windows 原生窗口弹出。'
      : '点击「启动虚拟环境」，完整桌面会在这里串流显示（localhost）。';
  }
}

// WSLg 模式：沿用容器里已有的登录态，缺失时才提示去授权（不自动弹浏览器）
async function refreshAuth() {
  const el = $('wslgAuth');
  const btn = $('wslgLogin');
  el.className = 'wslg-auth';
  el.textContent = '正在检查登录态…';
  btn.hidden = true;
  try {
    const r = await window.api.authStatus();
    if (r.loggedIn) {
      el.classList.add('ok');
      el.textContent = `已登录（${r.method}）· 凭据保存在虚拟环境里，直接开终端即可使用 Claude Code。`;
    } else {
      el.classList.add('warn');
      el.textContent = '虚拟环境里还没有登录态。首次使用请在终端里按 Claude Code 提示完成一次授权，或点右侧按钮打开授权页；之后不再需要浏览器。';
      btn.hidden = false;
    }
  } catch (e) {
    el.classList.add('err');
    el.textContent = '登录态检查失败：' + (e.message || e);
    btn.hidden = false;
  }
}

// ---------- 当前出口 ----------
// 「我到底从哪儿出去」是这个程序里最需要被看见的事实：用户改代理、换节点、
// 停掉代理软件之后，第一反应就是看这里有没有变。
const HOSTING_RE = /vultr|constant company|digitalocean|amazon|google|microsoft|hetzner|ovh|linode|akamai|oracle|alibaba|tencent|cloudflare/i;

function showEgress(exit) {
  const el = $('egress');
  if (!exit || !exit.ip) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  const where = [exit.city, exit.country].filter(Boolean).join(' · ');
  el.innerHTML = '';
  const ipb = document.createElement('b');
  ipb.textContent = exit.ip;
  el.append('出口 ', ipb);
  if (where) el.append(' · ' + where);
  if (exit.org) {
    // 机房网段单独标色：它是唯一没法在本地修掉的一项，提前说清楚，
    // 免得用户以为是自己配置没生效。
    const dc = document.createElement('span');
    if (HOSTING_RE.test(exit.org)) dc.className = 'dc';
    dc.textContent = ' · ' + exit.org;
    el.append(dc);
  }
}

function clearEgress() {
  const el = $('egress');
  el.hidden = true;
  el.textContent = '';
}

// ---------- 网络守卫状态 ----------
// 「代理断了没有」「有没有直连泄漏」是运行时最需要被看见的事实。
// 状态条不遮住自检面板，点一下直接跳到自检里的网络分项。
function showGuard(g) {
  const el = $('guardBadge');
  if (!g || !g.state) { clearGuard(); return; }
  el.hidden = false;
  let kind = 'warn';
  let label;
  switch (g.state) {
    case 'guarded':
      kind = 'ok';
      label = `网络已锁定 · 仅经代理出网${g.exit_ip ? ` · ${g.exit_ip}${g.exit_country ? '/' + g.exit_country : ''}` : ''}`;
      break;
    case 'proxy_down':
      label = '代理已断开 · 网络同步切断（不会直连泄漏）';
      break;
    case 'blocked':
      kind = 'err';
      label = `网络已切断 · ${g.reason || '预检未通过'}`;
      break;
    case 'off':
      kind = 'err';
      label = '网络熔断已关闭 · 代理断开会直连出网（高风险）';
      break;
    default:
      label = `网络守卫：${g.state}`;
  }
  el.className = 'guard-badge ' + kind;
  el.textContent = label;
  el.title = g.message || label;
}

function clearGuard() {
  const el = $('guardBadge');
  el.hidden = true;
  el.textContent = '';
  el.className = 'guard-badge';
}

// ---------- 侧栏小结 ----------
function showChip(text, kind) {
  const chip = $('checkChip');
  chip.hidden = false;
  chip.className = 'check-chip ' + (kind || '');
  chip.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const span = document.createElement('span');
  span.textContent = text;
  chip.append(dot, span);
}

// ---------- 自检面板 ----------
// <webview> 是独立的 guest 图层，CSS 的 z-index 盖不住它 —— 之前点「自检」，
// 面板其实生成了、内容也对，但被右侧的串流画面整块遮住，用户只看得到底部那行 chip。
// 所以打开面板时把 webview 收起来，关掉再按原状态放回去。
function openPanel() {
  $('checkPanel').hidden = false;
  const v = $('view');
  if (v && !v.hidden) { v.dataset.restore = '1'; v.hidden = true; }
}

function closePanel() {
  $('checkPanel').hidden = true;
  const v = $('view');
  if (v && v.dataset.restore === '1') { v.hidden = false; delete v.dataset.restore; }
}

function resetPanel(sub) {
  $('cpSub').textContent = sub || '';
  $('cpVerdict').className = 'cp-verdict';
  $('cpVerdict').innerHTML = '';
  $('cpBody').innerHTML = '';
  $('cpRaw').hidden = true;
  $('cpRaw').textContent = '';
  $('cpRawToggle').disabled = false;
  $('cpRawToggle').textContent = '原始输出';
  $('cpFilter').hidden = true;
  showAll = false;
  lastData = null;
}

function panelMessage(text, isError) {
  const d = document.createElement('div');
  d.className = 'cp-empty' + (isError ? ' msg' : '');
  d.textContent = text;
  $('cpBody').appendChild(d);
}

function renderVerdict(summary, cc) {
  const { pass, warn, fail } = summary;
  const v = $('cpVerdict');
  let kind = 'ok', text = '全部通过，各维度指向同一地区';
  if (fail > 0) { kind = 'err'; text = `发现 ${fail} 项必须修复，修好再登录 Claude`; }
  else if (warn > 0) { kind = 'warn'; text = `环境可用，但有 ${warn} 项需要留意`; }
  v.className = 'cp-verdict ' + kind;

  const label = document.createElement('span');
  label.textContent = text;

  const pills = document.createElement('div');
  pills.className = 'pills';
  [['pass', '通过', pass], ['warn', '注意', warn], ['fail', '失败', fail]].forEach(([k, name, n]) => {
    if (!n) return;
    const p = document.createElement('span');
    p.className = 'pill ' + k;
    p.textContent = `${name} ${n}`;
    pills.appendChild(p);
  });
  // 检测站那个百分比的含义是「扣了多少分」，所以这里直接给同一口径的数字，
  // 免得出现「自检全绿、去网站一看 41%」这种对不上的观感。
  if (cc && cc.total > 0) {
    const p = document.createElement('span');
    p.className = 'pill cc';
    p.textContent = `检测站口径 ${cc.total} 分`;
    p.title = `服务端可观测 ${cc.serverSide} 分 + 浏览器侧探活 ${cc.browserSide} 分`;
    pills.appendChild(p);
  }

  v.append(label, pills);
}

function renderItem(it) {
  const row = document.createElement('div');
  row.className = 'ci ' + (it.status || 'info');

  const mark = document.createElement('div');
  mark.className = 'ci-mark';
  mark.textContent = MARK[it.status] || '·';

  const body = document.createElement('div');
  body.className = 'ci-body';

  const top = document.createElement('div');
  top.className = 'ci-top';
  const lb = document.createElement('span');
  lb.className = 'ci-label';
  lb.textContent = it.label || '';
  const val = document.createElement('span');
  val.className = 'ci-value';
  val.textContent = it.value || '';
  top.append(lb, val);
  body.appendChild(top);

  // 每项都带一句说明：让「为什么这项重要」一眼可读，而不只是打勾
  if (it.detail) {
    const det = document.createElement('div');
    det.className = 'ci-detail';
    det.textContent = it.detail;
    body.appendChild(det);
  }
  if (it.advice) {
    const adv = document.createElement('div');
    adv.className = 'ci-advice';
    adv.textContent = it.advice;
    body.appendChild(adv);
  }

  row.append(mark, body);
  return row;
}

const isIssue = (it) => it.status === 'fail' || it.status === 'warn';

// 按当前筛选重绘正文：默认只显示需要处理的项目，避免「通过项」把问题淹没
function paintBody() {
  const d = lastData;
  if (!d) return;

  const body = $('cpBody');
  body.innerHTML = '';

  if (!d.runtimeUp) {
    const banner = document.createElement('div');
    banner.className = 'cp-banner';
    banner.textContent = '虚拟环境当前没有运行，部分项目无法检测。先点「启动虚拟环境」，等桌面出现后再自检，结果才准确。';
    body.appendChild(banner);
  }

  const groups = d.groups || [];
  const all = groups.flatMap((g) => g.items || []);
  const problems = all.filter(isIssue).length;
  const onlyIssues = !showAll && problems > 0;

  const visible = groups
    .map((g) => ({
      title: g.title,
      items: (g.items || []).filter((it) => !onlyIssues || isIssue(it)),
    }))
    .filter((g) => g.items.length);

  if (!visible.length) {
    const d0 = document.createElement('div');
    d0.className = 'cp-empty';
    d0.textContent = problems ? '没有需要处理的项目' : '本次没有检测到结果';
    body.appendChild(d0);
  }

  visible.forEach((g) => {
    const box = document.createElement('div');
    box.className = 'cp-group';
    const t = document.createElement('div');
    t.className = 'cp-group-title';
    t.textContent = g.title;
    box.appendChild(t);
    g.items.forEach((it) => box.appendChild(renderItem(it)));
    body.appendChild(box);
  });

  // 筛选按钮：有通过项时始终可用，文案说明当前状态
  const btn = $('cpFilter');
  const passes = all.length - problems;
  if (problems === 0 || passes === 0) {
    btn.hidden = true;
  } else {
    btn.hidden = false;
    btn.textContent = showAll ? `只看需要处理的 ${problems} 项` : `显示全部 ${all.length} 项`;
  }
}

function renderCheck(res) {
  lastCheck = res;
  resetPanel();

  if (!res || res.ok !== true) {
    const msg = res && (res.error || res.out) ? (res.error || res.out) : '自检失败，未获取到结果。';
    $('cpVerdict').className = 'cp-verdict err';
    const v = document.createElement('span');
    v.textContent = '无法完成自检';
    $('cpVerdict').appendChild(v);
    panelMessage(msg, true);
    if (res && res.out) {
      $('cpRaw').textContent = res.out;
      $('cpRawToggle').disabled = false;
    } else {
      $('cpRawToggle').disabled = true;
    }
    showChip('自检未完成，点击查看原因', 'err');
    return;
  }

  const d = res.data;
  const s = d.summary || { pass: 0, warn: 0, fail: 0, info: 0 };
  const regionEl = $('region');
  const regionName = (regionEl && regionEl.selectedOptions[0] ? regionEl.selectedOptions[0].textContent : '') ||
    d.regionLabel || '';

  $('cpSub').textContent = `${regionName} · 检测时间 ${new Date().toLocaleTimeString()}`;
  renderVerdict(s, d.checkcc);

  lastData = d;
  paintBody();

  if (res.raw) {
    $('cpRaw').textContent = res.raw;
    $('cpRawToggle').disabled = false;
  } else {
    $('cpRawToggle').disabled = true;
  }

  const issues = s.fail + s.warn;
  const scoreTxt = d.checkcc && d.checkcc.total > 0 ? ` · 检测站 ${d.checkcc.total} 分` : '';
  if (s.fail > 0) showChip(`自检：${s.pass} 通过 · ${issues} 项需要处理${scoreTxt}`, 'err');
  else if (s.warn > 0) showChip(`自检：${s.pass} 通过 · ${issues} 项需留意${scoreTxt}`, 'warn');
  else showChip(`自检：${s.pass} 项全部通过${scoreTxt}`, 'ok');
}

async function doCheck() {
  openPanel();
  resetPanel('正在检测…');
  $('cpVerdict').className = 'cp-verdict';
  $('cpVerdict').textContent = '检测中…';
  $('cpBody').innerHTML = '';
  const spin = document.createElement('div');
  spin.className = 'cp-empty';
  spin.textContent = '正在逐项核对时区、语言、浏览器、代理与出口地区…';
  $('cpBody').appendChild(spin);

  const r = await window.api.check();
  renderCheck(r);
}

// ---------- 诊断包 ----------
// 出问题时用户只要点一下，日志、配置（已脱敏）、自检结果就整成一包，
// 不用再靠「你看到什么」这种来回描述。
async function doExportDiag() {
  const btn = $('diag');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '正在收集…';
  try {
    const r = await window.api.exportDiag();
    if (r && r.ok) {
      showChip('诊断包已保存：' + r.file, 'ok');
    } else if (r && r.canceled) {
      showChip('已取消导出', '');
    } else {
      showChip('导出失败：' + ((r && r.error) || '未知错误'), 'err');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ---------- 剪贴板 / 键盘桥接 ----------
// noVNC 原版要用户点开悬浮控制条、在里面的文本框里手动粘贴，才能把内容送进虚拟机。
// 这里改成静默双向同步：主机复制的内容直接进虚拟机剪贴板，虚拟机里 Ctrl+V 就能用；
// 反过来在虚拟机里复制的文本也会自动回到主机。
let clipTimer = null;
let lastFromHost = '';
let lastFromGuest = '';

const normClip = (t) => String(t == null ? '' : t);

function stopClipboardBridge() {
  if (clipTimer) { clearInterval(clipTimer); clipTimer = null; }
  lastFromHost = '';
  lastFromGuest = '';
}

function startClipboardBridge() {
  stopClipboardBridge();
  const wv = $('view');
  const tick = async () => {
    if (!wv || wv.hidden) return;
    // 虚拟机 → 主机
    let guestText = '';
    try {
      guestText = normClip(await wv.executeJavaScript('window.__clipTaken ? window.__clipTaken() : ""'));
    } catch { return; }
    if (guestText && guestText !== lastFromGuest) {
      lastFromGuest = guestText;
      lastFromHost = guestText;   // 标记为已同步，避免下一轮又推回虚拟机形成回环
      try { window.api.writeClipboard(guestText); } catch {}
    }
    // 主机 → 虚拟机（readClipboard 现在是 IPC，返回 Promise，必须 await）
    let hostText = '';
    try { hostText = normClip(await window.api.readClipboard()); } catch {}
    if (hostText && hostText !== lastFromHost) {
      lastFromHost = hostText;
      try {
        await wv.executeJavaScript(`window.__clipSet && window.__clipSet(${JSON.stringify(hostText)})`);
      } catch {}
    }
  };
  // 250ms：剪贴板只能靠轮询（Electron 没有「剪贴板变了」的事件），
  // 700ms 时复制完要愣一下才生效，和本机手感差得明显。readText 很轻，这个频率无感。
  clipTimer = setInterval(tick, 250);
  tick();
}

// 键盘：点进画面就把焦点交给虚拟机，Ctrl / Alt 组合键、功能键直接透传
function wireStageFocus() {
  const stage = document.querySelector('.stage');
  if (!stage || stage.dataset.wired) return;
  stage.dataset.wired = '1';
  stage.addEventListener('mousedown', () => { try { $('view').focus(); } catch {} }, true);
}

// ---------- 启动 / 停止 ----------
async function doStart() {
  cfg = gather();
  $('start').disabled = true;
  setStatus('正在启动…', 'busy');
  const r = await window.api.start(cfg);
  if (r.ok) {
    $('placeholder').hidden = true;
    const wslg = r.displayMode !== 'desktop';
    const v = $('view');

    if (wslg) {
      // 原生窗口模式：这里不嵌任何画面，窗口已经由 entrypoint 弹出在 Windows 桌面上。
      // webview 必须收起来，否则它的 guest 图层会盖住状态卡片（z-index 盖不住 webview）。
      v.hidden = true;
      $('wslgPanel').hidden = false;
      refreshAuth();
    } else {
      $('wslgPanel').hidden = true;
      const already = r.resumed && v.getAttribute('src');
      v.hidden = false;
      // 接管已有桌面时不重设 src —— 重新赋值会让 webview 整体重载，
      // 画面黑一下再回来，和「重启」是同一个观感。
      if (!already) {
        v.addEventListener('dom-ready', () => { try { v.focus(); } catch {} }, { once: true });
        v.src = novncUrl(r.host);
      }
      wireStageFocus();
      startClipboardBridge();
    }
    $('stop').disabled = false;

    const lines = [...(r.notes || []), ...(r.warnings || [])];
    if (lines.length) showChip(lines.join('  '), (r.warnings || []).length ? 'err' : 'ok');
    showEgress(r.exit);
    showGuard(r.guard);

    if ((r.warnings || []).length) {
      setStatus('运行中（代理有警告）', 'err');
      $('start').disabled = false;
    } else {
      setStatus('运行中', 'ok');
    }
  } else {
    clearGuard();
    setStatus('启动失败', 'err');
    showChip('启动失败，点击查看原因', 'err');
    openPanel();
    resetPanel('启动未完成');
    $('cpVerdict').className = 'cp-verdict err';
    $('cpVerdict').textContent = '需要处理';
    panelMessage(r.error || '未知错误', true);
    $('cpRawToggle').disabled = true;
    $('start').disabled = false;
  }
}

async function doStop() {
  stopClipboardBridge();
  setStatus('正在停止…', 'busy');
  await window.api.stop();
  $('view').hidden = true;
  $('view').src = 'about:blank';
  $('wslgPanel').hidden = true;
  $('placeholder').hidden = false;
  syncDisplayMode();
  setStatus('已停止', '');
  clearEgress();
  clearGuard();
  $('start').disabled = false;
  $('stop').disabled = true;
}

// ---------- 初始化 ----------
// 没有 preload 注入的 api 时（预览/截图用）跳过自动初始化，只暴露渲染函数
if (!window.api) {
  window.__renderCheck = renderCheck;
  window.__setShowAll = (v) => { showAll = !!v; paintBody(); };
} else (async function init() {
  cfg = await window.api.getConfig();
  fill(cfg);

  $('region').addEventListener('change', () => { cfg = gather(); window.api.saveConfig(cfg); });
  $('proxy').addEventListener('change', () => { cfg = gather(); window.api.saveConfig(cfg); });
  $('whitelist').addEventListener('change', () => { cfg = gather(); window.api.saveConfig(cfg); });
  $('workspace').addEventListener('change', () => { cfg = gather(); window.api.saveConfig(cfg); });

  $('proxyMode').addEventListener('change', () => {
    syncProxyMode();
    cfg = gather(); window.api.saveConfig(cfg);
  });

  // 自动检测本机代理：把「不知道填什么端口」这件事彻底消掉。
  // Clash Verge 7897、Clash for Windows 7890、v2rayN 10809、SS 1080 等都在候选里。
  // silent=true 用于启动时静默探测：只写结果，不弹失败提示（用户可能根本没用代理）。
  async function runDetect(silent) {
    const btn = $('proxyDetect');
    const hint = $('proxyHint');
    if (!silent) {
      // 说明文字默认折叠了，检测结果写进去之前先展开，否则点「自动检测」看不到反馈
      const det = hint.closest && hint.closest('details');
      if (det) det.open = true;
      btn.disabled = true;
      btn.textContent = '检测中…';
      hint.className = 'hint';
      hint.textContent = '正在扫描本机常见代理端口…';
    }
    try {
      const r = await window.api.detectProxy();
      if (r.found) {
        $('proxy').value = r.url;
        // 检测过程本身说明「这个代理能用」，顺手切到全量模式：
        // 用户提供的 Clash 类客户端自己带规则，交给它分流最准。
        cfg = gather(); window.api.saveConfig(cfg);
        hint.className = 'hint ok';
        hint.textContent = `已找到代理 ${r.url}${r.checked ? ' · 出口 ' + r.checked : ''}。启动后会再校验一次实际出口。`;
        return true;
      }
      if (!silent) {
        if (r.all?.length) {
          hint.className = 'hint err';
          hint.textContent = `端口在监听但代理不通：${r.all.join('、')}。请确认代理已开启「允许局域网连接（Allow LAN）」。`;
        } else {
          hint.className = 'hint err';
          hint.textContent = '没有检测到本机代理。请先打开代理软件（Clash / v2ray 等），再点一次自动检测。';
        }
      }
      return false;
    } catch (e) {
      if (!silent) {
        hint.className = 'hint err';
        hint.textContent = '检测失败：' + (e.message || e);
      }
      return false;
    } finally {
      if (!silent) {
        btn.disabled = false;
        btn.textContent = '自动检测';
      }
    }
  }

  $('proxyDetect').addEventListener('click', () => runDetect(false));

  // 还没填代理 → 启动后静默扫一次。用户不需要知道「端口」这个概念，
  // 打开程序时如果代理已经在跑，就已经填好了。
  if (!cfg.proxy) setTimeout(() => runDetect(true), 600);

  $('pick').addEventListener('click', async () => {
    const p = await window.api.pickWorkspace();
    if (p) { $('workspace').value = p; cfg = gather(); window.api.saveConfig(cfg); }
  });
  $('openWs').addEventListener('click', () => window.api.openWorkspace($('workspace').value));

  $('start').addEventListener('click', doStart);
  $('stop').addEventListener('click', doStop);

  $('displayMode').addEventListener('change', () => {
    syncDisplayMode();
    cfg = gather(); window.api.saveConfig(cfg);
    if ($('stop').disabled === false) {
      showChip('显示模式已改，点「停止」再「启动」生效', 'warn');
    }
  });

  $('netGuard').addEventListener('change', () => {
    cfg = gather(); window.api.saveConfig(cfg);
    if ($('stop').disabled === false) {
      showChip('网络熔断开关已改，点「停止」再「启动」生效', 'warn');
    }
  });
  $('inputMethod').addEventListener('change', () => {
    cfg = gather(); window.api.saveConfig(cfg);
    if ($('stop').disabled === false) {
      showChip('输入法已改，点「停止」再「启动」生效（首次启用需联网安装）', 'warn');
    }
  });
  // 点状态条直接跑自检，看「网络熔断 / 直连封锁验证 / 代理预检」逐项结论
  $('guardBadge').addEventListener('click', () => doCheck());

  // 守卫状态在运行中会变（代理断开又恢复、WSL 把默认路由重新加回来），
  // 启动那一刻的快照不够，每 6 秒拉一次。没运行就别去打扰 WSL。
  setInterval(async () => {
    if ($('stop').disabled || !window.api.netStatus) return;
    try {
      const g = await window.api.netStatus();
      if (g) showGuard(g);
    } catch { /* 会话正在重启，下一轮再看 */ }
  }, 6000);

  // WSLg 模式：窗口按需再开一个；登录态缺失时才出现授权按钮
  $('wslgTerminal').addEventListener('click', async () => {
    await window.api.openTerminal();
    showChip('已打开 Claude Code 终端窗口（在 Windows 桌面上）', 'ok');
  });
  $('wslgShell').addEventListener('click', async () => {
    await window.api.openShell();
    showChip('已打开普通终端窗口', 'ok');
  });
  $('wslgLogin').addEventListener('click', async () => {
    await window.api.authLogin();
    showChip('已打开授权页，完成登录后回到这里点「打开 Claude Code 终端」', 'warn');
    setTimeout(() => refreshAuth(), 4000);
  });

  // 虚拟机不是用户停的，而是自己没了（WSL 被回收、entrypoint 退出、被任务管理器杀）。
  // 以前这种情况界面会一直显示「运行中」，点什么都没反应，用户只能关掉应用重开 ——
  // 那才是最像「反复重启」的体验。现在明确报出来并让按钮回到可用状态。
  if (window.api.onRuntimeExited) {
    window.api.onRuntimeExited((info) => {
      stopClipboardBridge();
      const v = $('view');
      v.hidden = true;
      try { v.removeAttribute('src'); v.src = 'about:blank'; } catch {}
      $('wslgPanel').hidden = true;
      $('placeholder').hidden = false;
      syncDisplayMode();
      clearEgress();
      clearGuard();
      setStatus('虚拟环境已退出', 'err');
      showChip(`虚拟环境意外退出（code=${info && info.code}），点「启动虚拟环境」重新拉起`, 'err');
      $('start').disabled = false;
      $('stop').disabled = true;
    });
  }
  $('check').addEventListener('click', doCheck);
  $('diag').addEventListener('click', doExportDiag);
  $('diagOpen').addEventListener('click', () => window.api.openLogs());
  $('checkChip').addEventListener('click', () => {
    if ($('checkChip').classList.contains('err') && !$('cpBody').children.length) { doCheck(); return; }
    openPanel();
  });

  $('cpClose').addEventListener('click', closePanel);
  $('cpRerun').addEventListener('click', doCheck);
  $('cpFilter').addEventListener('click', () => {
    showAll = !showAll;
    paintBody();
  });
  $('cpRawToggle').addEventListener('click', () => {
    const raw = $('cpRaw');
    raw.hidden = !raw.hidden;
    $('cpRawToggle').textContent = raw.hidden ? '原始输出' : '收起原始输出';
  });

  // 面板空白处点击关闭（Esc 也可以）
  $('checkPanel').addEventListener('click', (e) => {
    if (e.target === $('checkPanel')) closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('checkPanel').hidden) closePanel();
  });

  window.api.onProgress((msg) => setStatus(msg, 'busy'));

  // 预检：WSL2 不可用时直接告诉用户怎么修，而不是等导入报错
  const probe = await window.api.probeWsl();
  if (!probe.ok) {
    setStatus('当前系统未启用 WSL2，无法启动环境', 'err');
    openPanel();
    resetPanel('系统预检未通过');
    $('cpVerdict').className = 'cp-verdict err';
    $('cpVerdict').textContent = '需要先安装 WSL2';
    panelMessage(probe.error || '', true);
    $('cpRawToggle').disabled = true;
    showChip('未启用 WSL2，点击查看修复步骤', 'err');
    $('start').disabled = true;
    return;
  }

  // 老用户（已配置过）自动启动，接近“双击即用”
  if (!cfg._firstRun) setTimeout(doStart, 400);
})();
