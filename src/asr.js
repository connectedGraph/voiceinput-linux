'use strict';
// MiMo-V2.5-ASR 流式识别（SSE）。音频一次性上传，结果是流式返回。
const fs = require('fs');

const MAX_BASE64 = 10 * 1024 * 1024; // 官方上限

function buildBody({ model, base64, mime, language }) {
  return {
    model,
    messages: [{
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${base64}` } }]
    }],
    asr_options: { language: language || 'auto' },
    stream: true
  };
}

function pickDelta(obj) {
  const c = obj && obj.choices && obj.choices[0];
  if (!c) return '';
  const d = c.delta || c.message || {};
  if (typeof d.content === 'string') return d.content;
  if (Array.isArray(d.content)) {
    return d.content.map(x => (typeof x === 'string' ? x : x.text || '')).join('');
  }
  if (typeof d.text === 'string') return d.text;
  return '';
}

/**
 * @param {{apiKey:string, baseUrl:string, model:string, language:string}} cfg
 * @param {string} audioPath
 * @param {{onDelta?:(t:string,full:string)=>void, signal?:AbortSignal}} hooks
 */
async function transcribe(cfg, audioPath, hooks = {}) {
  const buf = fs.readFileSync(audioPath);
  const base64 = buf.toString('base64');
  const mime = audioPath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';

  if (base64.length > MAX_BASE64) {
    throw new Error(`音频过大（${(base64.length / 1048576).toFixed(1)} MB），单次上限 10 MB，请缩短时长`);
  }

  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const started = Date.now();

  const ctrl = new AbortController();
  if (hooks.signal) {
    if (hooks.signal.aborted) ctrl.abort();
    else hooks.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), 90000);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(buildBody({ model: cfg.model, base64, mime, language: cfg.language })),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === 'AbortError' ? '请求超时或被取消' : `网络错误：${err.message}`);
  }

  if (!res.ok) {
    clearTimeout(timer);
    let detail = '';
    try { detail = (await res.text()).slice(0, 400); } catch (_) {}
    throw new Error(`HTTP ${res.status}${detail ? ' · ' + detail : ''}`);
  }

  let full = '';
  let frames = 0;

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let bufText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bufText += dec.decode(value, { stream: true });

      let idx;
      while ((idx = bufText.indexOf('\n')) >= 0) {
        const line = bufText.slice(0, idx).trim();
        bufText = bufText.slice(idx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        frames++;
        let obj;
        try { obj = JSON.parse(payload); } catch (_) { continue; }
        if (obj.error) throw new Error(obj.error.message || JSON.stringify(obj.error));
        const piece = pickDelta(obj);
        if (piece) {
          full += piece;
          hooks.onDelta?.(piece, full);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return { text: full.trim(), frames, latencyMs: Date.now() - started };
}

/** 非流式，用于"测试连接"：发一个极短的静音 wav */
async function ping(cfg) {
  const fs2 = require('fs');
  const os = require('os');
  const path = require('path');
  const { wavHeader, RATE } = require('./recorder');
  const pcm = Buffer.alloc(RATE * 2 * 0.4); // 0.4 秒静音
  const p = path.join(os.tmpdir(), `mimo-asr-ping-${Date.now()}.wav`);
  fs2.writeFileSync(p, Buffer.concat([wavHeader(pcm.length), pcm]));
  const t0 = Date.now();
  try {
    const r = await transcribe({ ...cfg, language: 'auto' }, p, {});
    return { ok: true, latencyMs: Date.now() - t0, empty: !r.text };
  } finally {
    try { fs2.unlinkSync(p); } catch (_) {}
  }
}

module.exports = { transcribe, ping, MAX_BASE64 };
