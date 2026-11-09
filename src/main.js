'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require('./config');
const { Recorder } = require('./recorder');
const { transcribe, ping } = require('./asr');
const { inject, has, captureTarget, bridgeReady } = require('./inject');
const { HotkeyWatcher } = require('./evdev');
const { Overlay } = require('./overlay');
const { ClipboardStore } = require('./clipboard');
const { trace } = require('./diagnostics');
let clipboardStore = null;

// 单实例
app.setName('MiMo ASR');

// 悬浮窗是 focusable:false 的非激活窗口，Chromium 会把它当后台页面节流：
// JS 收到 state 也改了 DOM，但不产生新帧，屏幕上停在旧内容。
// webPreferences.backgroundThrottling 只覆盖一部分，这三项更彻底。
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');

let mainWin = null;
let overlay = null;
let tray = null;
let watcher = null;
let lastLevelAt = 0;
const recorder = new Recorder({
  onLevel: (rms) => {
    const now = Date.now();
    if (now - lastLevelAt < 80) return;
    lastLevelAt = now;
    pushOnly({ level: Math.min(1, rms * 6) });
  }
});

let state = { phase: 'idle', text: '', durationMs: 0, error: '', hint: '', theme: config.load().theme || 'auto' };
let targetPromise = null;
let previewOnly = false;
let abortCtrl = null;
let hudEnabled = true;

const ASSETS = path.join(__dirname, '..', 'assets');

function pushOnly(patch) {
  state = { ...state, ...patch };
  sendState();
}

let textPushTimer = null;
let lastTextPush = 0;
let pendingText = '';
const TEXT_PUSH_MS = 50;
// 识别结果是每 10–20ms 一个增量；每个增量都全量广播 + 重绘会把主线程和悬浮窗打爆。
// 这里合并到 20Hz，最后一帧由调用方显式 flush 保证不丢。
function pushText(full) {
  pendingText = full;
  const now = Date.now();
  const wait = TEXT_PUSH_MS - (now - lastTextPush);
  if (wait <= 0) {
    lastTextPush = now;
    broadcast({ text: full });
    return;
  }
  if (!textPushTimer) {
    textPushTimer = setTimeout(() => {
      textPushTimer = null;
      lastTextPush = Date.now();
      broadcast({ text: pendingText });
    }, wait);
  }
}

function flushText() {
  if (textPushTimer) { clearTimeout(textPushTimer); textPushTimer = null; }
  if (pendingText) { lastTextPush = Date.now(); broadcast({ text: pendingText }); }
}

function sendState() {
  for (const w of [mainWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('state', state);
  }
  if (overlay) overlay.send({ ...state, uiLang: config.load().uiLang });
}

function broadcast(patch) {
  const prevPhase = state.phase;
  state = { ...state, ...patch };
  sendState();
  if (state.phase !== prevPhase) {
    trace('phase', { from: prevPhase, to: state.phase, chars: state.text.length, error: state.error, copiedFallback: !!state.copiedFallback });
    updateTray();
  }
}

/* ---------------- 窗口 ---------------- */

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 872, height: 604,
    minWidth: 600, minHeight: 430,
    frame: false,
    show: false,
    backgroundColor: '#0E1013',
    title: 'MiMo ASR',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  mainWin.loadFile(path.join(__dirname, 'ui', 'index.html'));

  const reveal = () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (!mainWin.isVisible()) mainWin.show();
    mainWin.focus();
  };
  mainWin.once('ready-to-show', reveal);
  mainWin.webContents.once('did-finish-load', reveal);
  // 无边框窗口上 ready-to-show 不保证触发，兜底 2 秒后强制显示
  setTimeout(reveal, 2000);
  mainWin.on('close', (e) => {
    // 托盘图标在部分桌面环境下不可见，隐藏窗口会让人找不回来，所以缩到任务栏
    if (!app.isQuitting) { e.preventDefault(); mainWin.minimize(); }
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function createOverlay() {
  overlay = new Overlay(config.load);
  overlay.window.webContents.on('did-finish-load', sendState);
}

function showOverlay() {
  if (overlay) overlay.show();
}

function hideOverlaySoon(ms = 1400) {
  if (overlay) overlay.hideSoon(ms);
}

/* ---------------- 托盘 ---------------- */

function trayIcon(recording) {
  const f = path.join(ASSETS, recording ? 'tray-rec.png' : 'tray-idle.png');
  // 不要在这里 resize：Linux 托盘交给面板自己缩放，提前缩到 22px 会糊成一团
  try { return nativeImage.createFromPath(f); } catch (_) { return nativeImage.createEmpty(); }
}

function updateTray() {
  if (!tray) return;
  try { tray.setImage(trayIcon(state.phase === 'recording')); } catch (_) {}
  tray.setToolTip(state.phase === 'recording' ? 'MiMo ASR · 正在录音' : 'MiMo ASR');
}

function buildTray() {
  tray = new Tray(trayIcon(false));
  const cfg = config.load();
  const zh = cfg.uiLang !== 'en';
  const menu = Menu.buildFromTemplate([
    { label: zh ? '打开面板' : 'Open panel', click: () => { mainWin.show(); mainWin.focus(); } },
    { type: 'separator' },
    { label: state.phase === 'recording' ? (zh ? '结束录音' : 'Stop') : (zh ? '开始录音' : 'Start recording'), click: () => toggleManual() },
    { label: zh ? '尝试页' : 'Playground', click: () => { mainWin.show(); mainWin.webContents.send('goto', 'lab'); } },
    { label: zh ? '剪贴板' : 'Clipboard', click: () => { mainWin.show(); mainWin.focus(); mainWin.webContents.send('goto', 'clipboard'); } },
    { label: zh ? '复制最近识别结果' : 'Copy latest transcription', click: () => {
      const text = state.text || config.load().history[0]?.text;
      if (text) clipboardStore.copyText(text);
    } },
    { type: 'separator' },
    { label: zh ? '退出' : 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  // Linux 上 setTitle 通常无效，但 SNI 的 Title 为空时 COSMIC 面板不渲染该条目
  try { tray.setTitle('MiMo ASR'); } catch (_) {}
  tray.setContextMenu(menu);
  tray.on('click', () => { mainWin.show(); mainWin.focus(); });
  updateTray();
}

/* ---------------- 录音流程 ---------------- */

function requireKey() {
  const cfg = config.load();
  if (!cfg.apiKey) {
    broadcast({ phase: 'error', error: 'NO_API_KEY', hint: 'config' });
    if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); }
    return null;
  }
  return cfg;
}

function startRecording(opts = {}) {
  if (['recording', 'transcribing', 'injecting'].includes(state.phase)) return false;
  const cfg = requireKey();
  if (!cfg) return false;
  if (textPushTimer) { clearTimeout(textPushTimer); textPushTimer = null; }
  pendingText = '';
  lastTextPush = 0;
  hudEnabled = opts.showHud !== false;
  previewOnly = opts.previewOnly === true || cfg.injectMethod === 'preview';
  // Start acquiring the focus token immediately, without delaying the audio boundary.
  targetPromise = previewOnly ? null : captureTarget().then(target => {
    console.log('[inject] target captured', target);
    trace('focus-captured', { target });
    return { target };
  }, error => {
    console.error('[inject] target capture failed', error.message);
    trace('focus-failed', { error: error.message });
    return { error: error.message };
  });
  console.log('[asr] begin @', Date.now() % 100000);
  recorder.warmUp(cfg.audioSource);   // 常驻，幂等；启动时已预热的话这里是空操作
  recorder.begin();                   // 立刻打标记：此刻起（含前 350ms）都算录音
  if (hudEnabled) showOverlay();
  broadcast({ phase: 'recording', text: '', error: '', copiedFallback: false, durationMs: 0, level: 0, peak: null, previewOnly });
  return true;
}

async function stopAndTranscribe() {
  if (state.phase !== 'recording') return;
  const cfg = config.load();
  const rec = recorder.end();          // 同步冻结，松手那一刻就是终点
  if (cfg.keepMicWarm === false) recorder.shutdown();
  console.log('[asr] end @', Date.now() % 100000, '->', rec ? (rec.durationMs / 1000).toFixed(2) + 's' : 'null');
  if (!rec) {
    broadcast({ phase: 'idle' });
    hideOverlaySoon(300);
    return;
  }
  // 留一份原始录音，供回听判断音质
  const keepDir = path.join(os.tmpdir(), 'mimo-asr');
  const keepPath = path.join(keepDir, 'last.wav');
  try {
    fs.mkdirSync(keepDir, { recursive: true });
    fs.copyFileSync(rec.path, keepPath);
  } catch (_) {}
  if (hudEnabled) showOverlay();
  broadcast({ phase: 'transcribing', text: '', durationMs: rec.durationMs, peak: rec.peak });

  abortCtrl = new AbortController();
  try {
    const result = await transcribe(
      {
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        language: cfg.asrLanguage
      },
      rec.path,
      {
        signal: abortCtrl.signal,
        onDelta: (piece, full) => {
          // 服务端结果是流式的；合并后再广播，避免每个 chunk 都重绘一次。
          pushText(full);
        }
      }
    );
    try { fs.unlinkSync(rec.path); } catch (_) {}
    flushText();

    if (!result.text) {
      broadcast({ phase: 'error', error: 'EMPTY_RESULT' });
      hideOverlaySoon(1800);
      return;
    }

    let text = result.text;
    if (cfg.stripTrailingPunct) text = text.replace(/[。、，,.]+\s*$/, '');

    // Keep the recognized result even when the target loses focus or injection fails.
    config.pushHistory({ text, durationMs: rec.durationMs, latencyMs: result.latencyMs });
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('history', config.load().history);
    broadcast({ text, latencyMs: result.latencyMs });
    const target = targetPromise ? await targetPromise : {};
    if (!previewOnly) broadcast({ phase: 'injecting', text });
    const r = previewOnly ? { ok: true } : target.error ? { ok: false, reason: target.error }
      : await inject(text, { target: target.target });
    console.log('[inject] result', { previewOnly, ok: r.ok, method: r.method, reason: r.reason });
    trace('input-method-reply', { previewOnly, accepted: r.ok, method: r.method, reason: r.reason });
    if (!r.ok) {
      let copiedFallback = false;
      try { clipboardStore.copyText(text); copiedFallback = true; }
      catch (error) { console.error('[clipboard] fallback failed', error.message); }
      broadcast({ phase: 'error', error: r.reason || 'INJECT_FAILED', text, copiedFallback });
      hideOverlaySoon(2400);
      return;
    }
    broadcast({ phase: 'done', text, durationMs: rec.durationMs, peak: rec.peak });
    hideOverlaySoon(1200);
  } catch (err) {
    try { fs.unlinkSync(rec.path); } catch (_) {}
    broadcast({ phase: 'error', error: err.message });
    hideOverlaySoon(2600);
  } finally {
    abortCtrl = null;
    targetPromise = null;
    if (config.load().keepMicWarm === false) recorder.shutdown();
  }
}

function cancelRecording() {
  recorder.cancel();
  if (config.load().keepMicWarm === false) recorder.shutdown();
  broadcast({ phase: 'idle' });
  targetPromise = null;
  hideOverlaySoon(200);
}

function toggleManual() {
  if (state.phase === 'recording') stopAndTranscribe();
  else startRecording();
}

/* ---------------- 热键 ---------------- */

function restartHotkey() {
  const cfg = config.load();
  if (watcher) { watcher.stop(); watcher.removeAllListeners(); }
  watcher = new HotkeyWatcher(cfg.hotkey);

  watcher.on('press', () => {
    console.log('[hotkey] press');
    if (config.load().mode === 'toggle') {
      if (state.phase === 'recording') stopAndTranscribe();
      else if (state.phase === 'idle' || state.phase === 'done' || state.phase === 'error') startRecording();
    } else {
      startRecording();
    }
  });
  watcher.on('release', () => {
    console.log('[hotkey] release');
    if (config.load().mode === 'hold') stopAndTranscribe();
  });
  watcher.on('cancel', () => {
    console.log('[hotkey] cancel');
    if (state.phase === 'recording') cancelRecording();
  });

  watcher.start();
  setTimeout(() => {
    console.log('[hotkey] ready=' + watcher.ready + ' devices=' + watcher.devices.size + ' err=' + (watcher.permissionError || '-'));
    const st = {
      ready: watcher.ready,
      permissionError: watcher.permissionError,
      devices: watcher.devices.size
    };
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('hotkey-status', st);
  }, 600);
}

/* ---------------- IPC ---------------- */

function registerIpc() {
  ipcMain.handle('clipboard:list', () => { clipboardStore.capture(); return clipboardStore.list(); });
  ipcMain.handle('clipboard:copy', (_e, id, mode) => { clipboardStore.copy(id, mode); return true; });
  ipcMain.handle('clipboard:text', (_e, text) => { clipboardStore.copyText(text); return true; });
  ipcMain.handle('clipboard:import', async () => { await clipboardStore.importImage(mainWin); return clipboardStore.list(); });
  ipcMain.handle('clipboard:clear', () => { clipboardStore.clear(); return []; });
  ipcMain.handle('state:get', () => ({ ...state, uiLang: config.load().uiLang }));
  ipcMain.handle('config:get', () => {
    const cfg = config.load();
    return { ...cfg, history: cfg.history };
  });
  ipcMain.handle('config:save', (_e, patch) => {
    const next = config.save(patch);
    if (patch.keepMicWarm !== undefined) {
      recorder.idleShutdownMs = patch.keepMicWarm ? 0 : 120000;
      if (patch.keepMicWarm) recorder.warmUp(next.audioSource);
      else if (state.phase !== 'recording') recorder.shutdown();
    }
    if (patch.theme) broadcast({ theme: patch.theme });
    if (patch.hotkey || patch.mode || patch.uiLang) {
      restartHotkey();
      if (tray) { tray.destroy(); buildTray(); }
    }
    broadcast({});
    return next;
  });
  ipcMain.handle('config:reset-history', () => config.save({ history: [] }));

  ipcMain.handle('asr:test', async () => {
    const cfg = config.load();
    if (!cfg.apiKey) return { ok: false, error: 'NO_API_KEY' };
    try {
      const r = await ping({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model, language: 'auto' });
      return { ok: r.ok, latencyMs: r.latencyMs };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lab:start', () => startRecording({ showHud: false, previewOnly: true }));
  ipcMain.handle('audio:last', () => {
    try {
      const p = path.join(os.tmpdir(), 'mimo-asr', 'last.wav');
      if (!fs.existsSync(p)) return null;
      const b = fs.readFileSync(p);
      if (b.length > 24 * 1024 * 1024) return null;
      return { dataUrl: 'data:audio/wav;base64,' + b.toString('base64'), bytes: b.length };
    } catch (_) { return null; }
  });
  ipcMain.handle('lab:stop', async () => { await stopAndTranscribe(); return true; });

  ipcMain.handle('hotkey:probe', () => ({
    ready: watcher ? watcher.ready : false,
    permissionError: watcher ? watcher.permissionError : 'not-started',
    devices: watcher ? watcher.devices.size : 0
  }));

  ipcMain.handle('win:get-bounds', () => {
    if (!mainWin || mainWin.isDestroyed()) return null;
    return mainWin.getBounds();
  });
  ipcMain.on('win:set-bounds', (_e, b) => {
    if (!mainWin || mainWin.isDestroyed() || !b) return;
    const MINW = 600, MINH = 430;
    mainWin.setBounds({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.max(MINW, Math.round(b.width)),
      height: Math.max(MINH, Math.round(b.height))
    });
  });

  ipcMain.handle('win:minimize', () => mainWin.minimize());
  ipcMain.handle('win:hide', () => mainWin.minimize());
  ipcMain.handle('app:quit', () => { app.isQuitting = true; app.quit(); });
  ipcMain.handle('app:open-config-dir', () => shell.openPath(config.CONFIG_DIR));
  ipcMain.handle('env:check', () => ({
    inputBridge: bridgeReady(),
    layerShell: overlay ? overlay.ready : false,
    parec: has('parec')
  }));
}

/* ---------------- 启动 ---------------- */

function revealMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
  mainWin.moveTop();
}

app.on('second-instance', revealMainWindow);

app.whenReady().then(() => {
  trace('startup', { pid: process.pid, version: app.getVersion(), display: process.env.DISPLAY, wayland: process.env.WAYLAND_DISPLAY });
  clipboardStore = new ClipboardStore();
  clipboardStore.start();
  createMainWindow();
  createOverlay();
  registerIpc();
  buildTray();
  restartHotkey();
  // 预热采集：让第一次按下就没有启动延迟
  try {
    const c0 = config.load();
    // keepMicWarm=true  -> 0：一直常驻，零延迟
    // keepMicWarm=false -> 120000：闲置两分钟释放
    recorder.idleShutdownMs = c0.keepMicWarm === false ? 120000 : 0;
    if (c0.keepMicWarm !== false) recorder.warmUp(c0.audioSource);
  } catch (_) {}

  // 托盘/面板里切换语言时重建菜单
  ipcMain.on('tray:rebuild', () => { if (tray) { tray.destroy(); buildTray(); } });
});

app.on('window-all-closed', () => { /* 常驻托盘 */ });
app.on('before-quit', () => {
  if (clipboardStore) clipboardStore.stop();
  app.isQuitting = true;
  try { recorder.shutdown(); } catch (_) {}
  if (abortCtrl) abortCtrl.abort();
  if (overlay) overlay.destroy();
  if (watcher) watcher.stop();
});

// Used by the desktop integration runner; no diagnostic IPC or network listener.
module.exports = { startRecording, stopAndTranscribe, cancelRecording, broadcast,
  getState: () => state, getMainWindow: () => mainWin, getOverlay: () => overlay };
