'use strict';
// One input-method commit for the whole result. No clipboard writes or synthetic keys.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const CLIENT = path.join(__dirname, '..', 'build', 'bridge-client');

function has(command) {
  return (process.env.PATH || '').split(path.delimiter).some(dir => {
    try { fs.accessSync(path.join(dir, command), fs.constants.X_OK); return true; }
    catch (_) { return false; }
  });
}

function call(method, token, text = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(CLIENT, token === undefined ? [method] : [method, token],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 3500);
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('INPUT_BRIDGE_UNAVAILABLE')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error('[inject] bridge:', stderr.trim() || code);
        reject(new Error('INPUT_BRIDGE_UNAVAILABLE'));
      } else resolve(stdout.trim());
    });
    child.stdin.end(text);
  });
}

async function captureTarget() {
  const token = await call('Capture');
  if (!token) throw new Error('NO_INPUT_FOCUS');
  return token;
}

async function inject(text, { target } = {}) {
  if (!text) return { ok: false, reason: 'EMPTY_RESULT' };
  if (!target) return { ok: false, reason: 'NO_INPUT_FOCUS' };
  try {
    const reply = await call('Commit', target, text);
    return reply === 'OK' ? { ok: true, method: 'fcitx' } : { ok: false, reason: reply };
  } catch (error) {
    // A timeout can follow a delivered commit; retrying risks duplicate text.
    return { ok: false, reason: error.message };
  }
}

function bridgeReady() {
  const result = spawnSync(CLIENT, ['Version'], { encoding: 'utf8', timeout: 3000 });
  return result.status === 0 && result.stdout.trim() === '1';
}

module.exports = { inject, has, captureTarget, bridgeReady };
