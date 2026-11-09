'use strict';
// In-process failures, no HTTP test server and no user's clipboard.
const { app, clipboard, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const dir = fs.mkdtempSync('/data/scratch/mimo-fallback-test-');
process.env.XDG_CONFIG_HOME = dir;
process.env.XDG_STATE_HOME = dir;
process.env.MIMO_API_KEY = 'in-process-test';
app.setPath('userData', path.join(dir, 'electron'));
const text = '注入失败时自动复制这段中文';
const audio = path.join(dir, 'recording.wav');
class Recorder {
  warmUp() {} begin() {} shutdown() {} cancel() {}
  end() { fs.writeFileSync(audio, Buffer.alloc(44)); return { path: audio, durationMs: 1000 }; }
}
class Watcher extends EventEmitter {
  constructor() { super(); this.devices = new Map(); } start() {} stop() {}
}
let fail = 'NO_INPUT_FOCUS';
const inject = require('../src/inject');
inject.captureTarget = async () => { if (fail === 'NO_INPUT_FOCUS') throw new Error(fail); return 'test-target'; };
inject.inject = async () => ({ ok: false, reason: fail });
require('../src/recorder').Recorder = Recorder;
require('../src/evdev').HotkeyWatcher = Watcher;
require('../src/asr').transcribe = async (_cfg, _audio, hooks) => { hooks.onDelta(text, text); return { text, latencyMs: 10 }; };
const mimo = require('../src/main');
app.whenReady().then(async () => {
  // src/main schedules its ready callback first.
  for (const reason of ['NO_INPUT_FOCUS', 'FOCUS_CHANGED', 'INPUT_BRIDGE_UNAVAILABLE']) {
    fail = reason;
    clipboard.writeText('previous clipboard');
    assert.equal(mimo.startRecording({ showHud: false }), true);
    await mimo.stopAndTranscribe();
    assert.equal(mimo.getState().error, reason);
    assert.equal(mimo.getState().copiedFallback, true);
    assert.equal(clipboard.readText(), text);
  }
  assert.equal(mimo.startRecording({ showHud: false, previewOnly: true }), true);
  clipboard.writeText('keep this');
  await mimo.stopAndTranscribe();
  assert.equal(clipboard.readText(), 'keep this');
  assert.equal(mimo.getState().copiedFallback, false);
  console.log('PASS: no focus, changed focus and unavailable bridge copy result; preview keeps clipboard intact');
  const win = mimo.getMainWindow();
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  clipboard.writeImage(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')));
  await win.webContents.executeJavaScript('document.querySelector("[data-page=clipboard]").click(); refreshClipboard()');
  assert.ok(await win.webContents.executeJavaScript('document.querySelector("#clip-list img") !== null'));
  assert.ok(await win.webContents.executeJavaScript('document.querySelector("#clip-list").textContent.includes("复制图片") && document.querySelector("#clip-list").textContent.includes("复制路径")'));
  win.show();
  await new Promise(resolve => setTimeout(resolve, 500));
  fs.writeFileSync(path.join(dir, 'clipboard-ui.png'), (await win.webContents.capturePage()).toPNG());
  console.log('PASS: real renderer clipboard image preview and both copy controls; screenshot', path.join(dir, 'clipboard-ui.png'));
  app.isQuitting = true; app.quit();
}).catch(e => { console.error(e); app.exit(1); });
