'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require('./config');
const { Recorder } = require('./recorder');
const { transcribe, ping } = require('./asr');
const { inject, has } = require('./inject');
const { HotkeyWatcher } = require('./evdev');

// 单实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');

let mainWin = null;
let overlayWin = null;
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
let pendingText = '';
let abortCtrl = null;
let hideTimer = null;
let hudEnabled = true;

const ASSETS = path.join(__dirname, '..', 'assets');

function pushOnly(patch) {
  state = { ...state, ...patch };
  for (const w of [mainWin, overlayWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('state', state);
  }
}

function broadcast(patch) {
  const prevPhase = state.phase;
  state = { ...state, ...patch };
  for (const w of [mainWin, overlayWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('state', state);
  }
  if (state.phase !== prevPhase) updateTray();
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
      nodeIntegration: false
    }
  });
  mainWin.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function overlayBounds() {
  const pos = config.load().overlayPosition || 'bottom';
  const cur = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cur) || screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  const w = 560, h = 96;
  return {
    x: Math.round(x + (width - w) / 2),
    y: pos === 'top' ? y + 56 : y + height - h - 64,
    width: w, height: h
  };
}

function createOverlay() {
  overlayWin = new BrowserWindow({
    ...overlayBounds(),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: false,
    alwaysOnTop: true,
    type: 'notification',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlayWin.loadFile(path.join(__dirname, 'ui', 'overlay.html'));
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  try { overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
}

function showOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  clearTimeout(hideTimer);
  overlayWin.setBounds(overlayBounds());
  overlayWin.showInactive();
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
}

function hideOverlaySoon(ms = 1400) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
  }, ms);
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
    { type: 'separator' },
    { label: zh ? '退出' : 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
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
  if (state.phase === 'recording' || state.phase === 'transcribing') return;
  const cfg = requireKey();
  if (!cfg) return;
  hudEnabled = opts.showHud !== false;
  pendingText = '';
  console.log('[asr] begin @', Date.now() % 100000);
  recorder.warmUp(cfg.audioSource);   // 常驻，幂等；启动时已预热的话这里是空操作
  recorder.begin();                   // 立刻打标记：此刻起（含前 350ms）都算录音
  if (hudEnabled) showOverlay();
  broadcast({ phase: 'recording', text: '', error: '', durationMs: 0, level: 0 });
}

async function stopAndTranscribe() {
  if (state.phase !== 'recording') return;
  const cfg = config.load();
  const rec = recorder.end();          // 同步冻结，松手那一刻就是终点
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
        onDelta: (_piece, full) => {
          if (!config.load().previewWhileTranscribing) return;
          broadcast({ text: full });
        }
      }
    );
    try { fs.unlinkSync(rec.path); } catch (_) {}

    if (!result.text) {
      broadcast({ phase: 'error', error: 'EMPTY_RESULT' });
      hideOverlaySoon(1800);
      return;
    }

    let text = result.text;
    if (cfg.stripTrailingPunct) text = text.replace(/[。、，,.]+\s*$/, '');

    broadcast({ phase: 'injecting', text });
    const r = await inject(text, {
      method: cfg.injectMethod === 'type' ? 'type' : 'paste',
      restoreClipboard: cfg.restoreClipboard,
      pasteKey: cfg.pasteKey
    });
    if (!r.ok) {
      broadcast({ phase: 'error', error: r.reason || 'INJECT_FAILED', text });
      hideOverlaySoon(2400);
      return;
    }
    config.pushHistory({ text, durationMs: rec.durationMs, latencyMs: result.latencyMs });
    broadcast({ phase: 'done', text, durationMs: rec.durationMs, peak: rec.peak });
    hideOverlaySoon(1200);
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('history', config.load().history);
  } catch (err) {
    try { fs.unlinkSync(rec.path); } catch (_) {}
    broadcast({ phase: 'error', error: err.message });
    hideOverlaySoon(2600);
  } finally {
    abortCtrl = null;
    if (config.load().keepMicWarm === false) recorder.shutdown();
  }
}

function cancelRecording() {
  recorder.cancel();
  broadcast({ phase: 'idle' });
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
  ipcMain.handle('config:get', () => {
    const cfg = config.load();
    return { ...cfg, history: cfg.history };
  });
  ipcMain.handle('config:save', (_e, patch) => {
    const next = config.save(patch);
    if (patch.keepMicWarm !== undefined) {
      recorder.idleShutdownMs = patch.keepMicWarm ? 0 : 120000;
      if (patch.keepMicWarm) recorder.warmUp(next.audioSource);
      else recorder.shutdown();
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

  ipcMain.handle('lab:start', () => { startRecording({ showHud: false }); return true; });
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
  ipcMain.handle('win:hide', () => mainWin.hide());
  ipcMain.handle('app:quit', () => { app.isQuitting = true; app.quit(); });
  ipcMain.handle('app:open-config-dir', () => shell.openPath(config.CONFIG_DIR));
  ipcMain.handle('env:check', () => ({
    ydotool: has('ydotool'),
    wlcopy: has('wl-copy'),
    parec: has('parec')
  }));
}

/* ---------------- 启动 ---------------- */

app.on('second-instance', () => { if (mainWin) { mainWin.show(); mainWin.focus(); } });

app.whenReady().then(() => {
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
    recorder.warmUp(c0.audioSource);
  } catch (_) {}

  // 托盘/面板里切换语言时重建菜单
  ipcMain.on('tray:rebuild', () => { if (tray) { tray.destroy(); buildTray(); } });
});

app.on('window-all-closed', () => { /* 常驻托盘 */ });
app.on('before-quit', () => {
  app.isQuitting = true;
  try { recorder.shutdown(); } catch (_) {}
  if (watcher) watcher.stop();
  try { globalShortcut.unregisterAll(); } catch (_) {}
});
