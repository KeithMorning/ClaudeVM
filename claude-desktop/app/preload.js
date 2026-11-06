'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  start: (cfg) => ipcRenderer.invoke('runtime:start', cfg),
  stop: () => ipcRenderer.invoke('runtime:stop'),
  status: () => ipcRenderer.invoke('runtime:status'),
  check: () => ipcRenderer.invoke('runtime:check'),
  netStatus: () => ipcRenderer.invoke('net:status'),
  probeWsl: () => ipcRenderer.invoke('wsl:probe'),
  // WSLg 模式：按需再开窗口 / 查看登录态
  openTerminal: () => ipcRenderer.invoke('terminal:open'),
  openShell: () => ipcRenderer.invoke('terminal:shell'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogin: () => ipcRenderer.invoke('auth:login'),
  detectProxy: () => ipcRenderer.invoke('proxy:detect'),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  openWorkspace: (p) => ipcRenderer.invoke('workspace:open', p),
  exportDiag: () => ipcRenderer.invoke('diag:export'),
  previewDiag: () => ipcRenderer.invoke('diag:preview'),
  openLogs: () => ipcRenderer.invoke('diag:openLogs'),
  onProgress: (cb) => ipcRenderer.on('runtime:progress', (_e, msg) => cb(msg)),
  // 虚拟机进程自己退出了（不是用户点停止）：界面必须知道，否则会一直假装「运行中」
  onRuntimeExited: (cb) => ipcRenderer.on('runtime:exited', (_e, info) => cb(info)),
  // 剪贴板桥：主机 <-> 虚拟机（不走 noVNC 那个悬浮控制条）
  // 注意走 IPC，不要在 preload 里直接 require('electron').clipboard ——
  // sandbox 化的 preload 拿不到 clipboard，调用会静默失败。
  readClipboard: () => ipcRenderer.invoke('clip:read'),
  writeClipboard: (t) => ipcRenderer.invoke('clip:write', String(t == null ? '' : t)),
});
