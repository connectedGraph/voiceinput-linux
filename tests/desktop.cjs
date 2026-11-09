'use strict';
// Run inside Electron on the real desktop. All config/audio artifacts go to /data.
const { app, BrowserWindow, nativeImage, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const output = process.env.MIMO_TEST_DIR || '/data/scratch/mimo-asr-desktop-test';
fs.mkdirSync(output, { recursive: true });
process.env.XDG_CONFIG_HOME = path.join(output, 'config');
process.env.TMPDIR = output;
process.env.MIMO_API_KEY = 'local-test-only';
app.setPath('userData', path.join(output, 'electron'));

async function until(predicate, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(40);
  }
  throw new Error(message);
}

(async () => {
  const pieces = ['中文', '输入', '整段', '提交', '，', 'English', ' 123', '。'];
  const finalText = pieces.join('');
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const b of req) body += b;
    const payload = JSON.parse(body);
    assert.equal(payload.model, 'mimo-v2.5-asr');
    assert.equal(payload.stream, true);
    assert.match(payload.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const piece of pieces) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await delay(140);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.MIMO_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  const mimo = require('../src/main');
  const { captureTarget, inject } = require('../src/inject');
  const config = require('../src/config');
  config.save({ keepMicWarm: true, theme: 'dark', uiLang: 'zh' });
  await app.whenReady();
  await until(() => mimo.getOverlay() && mimo.getOverlay().ready, 'Layer helper never became ready');
  const main = mimo.getMainWindow();
  const overlay = mimo.getOverlay();
  await until(() => !main.webContents.isLoading() && !overlay.window.webContents.isLoading(), 'UI did not load');
  await delay(2300); // Let the main window's startup fallback finish before focusing the target.
  const errors = [];
  for (const win of [main, overlay.window]) {
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  }
  main.minimize();
  const target = new BrowserWindow({ width: 640, height: 400, title: 'MiMo isolated input test',
    webPreferences: { contextIsolation: true } });
  await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
    <textarea id="input" autofocus style="width:90%;height:200px"></textarea><script>
    window.changes=[];document.querySelector('textarea').addEventListener('input',e=>changes.push(e.target.value));
    </script>`));
  target.show(); target.focus();
  execFileSync('xdotool', ['windowactivate', '--sync', String(target.getNativeWindowHandle().readUInt32LE())]);
  await target.webContents.executeJavaScript('document.querySelector("textarea").focus()');
  await delay(400);
  const token = await captureTarget();
  assert.ok(token);
  assert.equal((await inject('基线中文 English 123', { target: token })).ok, true);
  await until(async () => (await target.webContents.executeJavaScript('input.value')) === '基线中文 English 123',
    'fcitx reported commit but the target did not receive Unicode text');
  console.log('PASS: XWayland input received a whole Unicode commit');
  await target.webContents.executeJavaScript('input.value="";changes=[]');

  // Preserve the actual clipboard: inspect every advertised MIME as binary without taking ownership.
  function snapshot() {
    let types;
    try { types = execFileSync('wl-paste', ['--list-types'], { timeout: 2500 }).toString().trim().split('\n').filter(Boolean).sort(); }
    catch (_) { return {}; }
    return Object.fromEntries(types.map(type => [type,
      crypto.createHash('sha256').update(execFileSync('wl-paste', ['--no-newline', '--type', type],
        { timeout: 2500, maxBuffer: 64 * 1024 * 1024 })).digest('hex')]));
  }
  const before = snapshot();
  assert.equal(mimo.startRecording(), true);
  await delay(800);
  const transcription = mimo.stopAndTranscribe();
  await until(() => mimo.getState().text.startsWith('中文输入'), 'Streaming text never arrived');
  const geometry = screen.getPrimaryDisplay().bounds;
  function screenshot(name) {
    const file = execFileSync('cosmic-screenshot', ['--interactive=false', '--modal=false', '--notify=false',
      '--save-dir', output], { timeout: 5000 }).toString().trim();
    const image = nativeImage.createFromPath(file);
    const scale = image.getSize().width / geometry.width;
    const crop = image.crop({ x: Math.round((geometry.width / 2 - 280) * scale),
      y: Math.round((geometry.height - 160) * scale), width: Math.round(560 * scale), height: Math.round(96 * scale) });
    fs.writeFileSync(path.join(output, name), crop.toPNG());
    fs.unlinkSync(file);
  }
  await delay(40);
  screenshot('hud-partial.png');
  const partial = await overlay.window.webContents.executeJavaScript('document.querySelector("#txt").textContent');
  assert.ok(partial.includes('中文输入'));
  assert.notEqual(partial, finalText);
  const count = overlay.frameCount;
  assert.equal(await target.webContents.executeJavaScript('input.value'), '', 'Text was injected before SSE finished');
  await transcription;
  await delay(200);
  assert.equal(mimo.getState().phase, 'done', JSON.stringify(mimo.getState()));
  assert.equal(await target.webContents.executeJavaScript('input.value'), finalText);
  const changes = await target.webContents.executeJavaScript('changes');
  assert.deepEqual(changes, [finalText], 'Injection produced multiple input events instead of one commit');
  assert.ok(overlay.frameCount > count, 'The offscreen HUD stopped producing frames');
  screenshot('hud-final.png');
  const partialPixels = nativeImage.createFromPath(path.join(output, 'hud-partial.png')).toBitmap();
  const finalPixels = nativeImage.createFromPath(path.join(output, 'hud-final.png')).toBitmap();
  assert.notDeepEqual(partialPixels, finalPixels, 'Actual compositor output did not change');
  assert.deepEqual(snapshot(), before, 'Clipboard MIME bytes changed');
  assert.equal(await captureTarget(), token, 'HUD stole input focus');
  console.log(`PASS: real recording → SSE → ${overlay.frameCount} HUD frames → one final commit; clipboard unchanged`);

  const oldToken = await captureTarget();
  main.restore(); main.show(); main.focus();
  await main.webContents.executeJavaScript('document.querySelector("#in-url").focus()');
  await delay(300);
  assert.deepEqual(await inject('must not reach the old input', { target: oldToken }), { ok: false, reason: 'FOCUS_CHANGED' });
  console.log('PASS: changed focus is rejected');

  await main.webContents.executeJavaScript('document.querySelector("[data-page=lab]").click()');
  assert.equal(mimo.startRecording({ showHud: false, previewOnly: true }), true);
  await delay(500);
  await mimo.stopAndTranscribe();
  assert.equal(mimo.getState().phase, 'done');
  assert.equal(mimo.getState().previewOnly, true);
  assert.equal(await main.webContents.executeJavaScript('document.querySelector("#outtxt").textContent'), finalText);
  const audio = await main.webContents.executeJavaScript('window.api.lastAudio()');
  assert.ok(audio.bytes > 44);
  assert.equal(await main.webContents.executeJavaScript('document.querySelector("#btn-replay").disabled'), false);
  assert.ok(await main.webContents.executeJavaScript('document.querySelector("#peak-tip").textContent.includes("dB")'));
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(errors, []);
  console.log('PASS: playground transcribes without injection, retains WAV and peak dB');
  target.destroy();
  server.close();
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, frames: overlay.frameCount,
    clipboardTypes: Object.keys(before), output, text: finalText }, null, 2));
  app.isQuitting = true; app.quit();
})().catch(error => { console.error(error); app.isQuitting = true; app.exit(1); });
