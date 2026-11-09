'use strict';
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { captureTarget, inject } = require('../src/inject');

(async () => {
  const dir = '/data/scratch/mimo-asr-native-input';
  fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, 'received.txt');
  for (const file of [output, output.replace('.txt', '.ready')]) { try { fs.unlinkSync(file); } catch (_) {} }
  const text = '原生终端中文 English 123。';
  const terminal = spawn('cosmic-term', ['-e', 'python3', path.join(__dirname, 'pty-target.py'), output, String(Buffer.byteLength(text))],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  terminal.stderr.on('data', () => {});
  try {
    for (let i = 0; i < 100 && !fs.existsSync(output.replace('.txt', '.ready')); i++) await delay(50);
    assert.ok(fs.existsSync(output.replace('.txt', '.ready')), 'Terminal did not start its isolated recipient');
    await delay(500);
    const debug = execFileSync('gdbus', ['call', '--session', '--dest', 'org.fcitx.Fcitx5', '--object-path', '/controller',
      '--method', 'org.fcitx.Fcitx.Controller1.DebugInfo']).toString();
    assert.match(debug, /frontend:wayland_v2[^\n]*focus:1/);
    const result = await inject(text, { target: await captureTarget() });
    assert.equal(result.ok, true, result.reason);
    for (let i = 0; i < 80 && !fs.existsSync(output); i++) await delay(50);
    assert.ok(fs.existsSync(output), 'Native terminal never received the commit');
    assert.equal(fs.readFileSync(output, 'utf8'), text);
    console.log('PASS: COSMIC Terminal received one multiline Unicode commit through the native Wayland input method');
  } finally { terminal.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
