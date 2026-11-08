'use strict';
// 文字注入：整段一次性写入，不做逐字模拟
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');

function has(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
}

function readClipboard() {
  const r = spawnSync('wl-paste', ['--no-newline'], { encoding: 'utf8', timeout: 1500 });
  return r.status === 0 ? r.stdout : null;
}

function writeClipboard(text) {
  // wl-copy 会 fork 常驻持有剪贴板，必须 detached + unref
  return new Promise((resolve, reject) => {
    const p = spawn('wl-copy', [], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    p.on('error', reject);
    p.stdin.end(text, () => { try { p.unref(); } catch (_) {} resolve(); });
  });
}

/** 用 ydotool 发一个按键组合，例如 ['ctrl','v'] -> ydotool key ctrl+v */
function keyCombo(keys) {
  const r = spawnSync('ydotool', ['key', keys.join('+')], { timeout: 5000, encoding: 'utf8' });
  if (r.status !== 0) console.error('[inject] ydotool key 失败:', r.stderr || r.status);
  return r.status === 0;
}

function typeDirect(text) {
  const r = spawnSync('ydotool', ['type', '--', text], { timeout: 15000, encoding: 'utf8' });
  return r.status === 0;
}

/**
 * 注入一段文字到当前焦点输入框。
 * method: 'paste'（剪贴板+Ctrl+V，中文稳）| 'type'（ydotool 直敲，仅 ASCII 稳）
 * pasteKey: 'ctrl+v' | 'ctrl+shift+v'（部分终端需要后者）
 */
async function inject(text, opts = {}) {
  const method = opts.method || 'paste';
  const restore = !!opts.restoreClipboard;
  const pasteKey = opts.pasteKey || 'ctrl+v';

  if (!text) return { ok: false, reason: 'empty' };

  if (method === 'type' && /^[\x20-\x7e\s]*$/.test(text) && has('ydotool')) {
    const ok = typeDirect(text);
    if (ok) return { ok: true, method: 'type' };
  }

  if (!has('wl-copy') || !has('ydotool')) {
    return { ok: false, reason: 'missing-tools' };
  }

  const previous = restore ? readClipboard() : null;
  await writeClipboard(text);
  await new Promise(r => setTimeout(r, 90));     // 等剪贴板落地
  const keys = pasteKey === 'ctrl+shift+v' ? ['ctrl', 'shift', 'v'] : ['ctrl', 'v'];
  keyCombo(keys);
  if (restore && previous !== null && previous !== text) {
    setTimeout(() => { writeClipboard(previous).catch(() => {}); }, 260);
  }
  return { ok: true, method: 'paste' };
}

module.exports = { inject, has, readClipboard, writeClipboard };
