'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const bridge = window.api;

async function refreshClipboard() {
  try {
    const items = await bridge.clipboardList();
    const list = $('#clip-list');
    list.replaceChildren();
    if (!items.length) list.textContent = '还没有记录。复制文字、截图，或选择一张图片。';
    for (const item of items) {
      const card = document.createElement('div'); card.className = 'clip-card';
      if (item.thumbnail) { const img = document.createElement('img'); img.src = item.thumbnail; card.append(img); }
      const content = document.createElement('div'); content.className = 'clip-content';
      const text = document.createElement('pre'); text.textContent = item.text || '图片'; content.append(text);
      if (item.path) { const p = document.createElement('small'); p.textContent = item.path; content.append(p); }
      const actions = document.createElement('div'); actions.className = 'labbar';
      const choices = [];
      if (item.text) choices.push(['text', '复制文字']);
      if (item.image) choices.push(['image', '复制图片']);
      if (item.path) choices.push(['path', '复制路径']);
      for (const [mode, label] of choices) {
        const button = document.createElement('button'); button.className = 'btn'; button.textContent = label;
        button.onclick = async () => {
          try { await bridge.clipboardCopy(item.id, mode); $('#clip-status').textContent = `已${label}`; }
          catch (e) { $('#clip-status').textContent = e.message; }
        };
        actions.append(button);
      }
      content.append(actions); card.append(content); list.append(card);
    }
  } catch (e) { $('#clip-status').textContent = e.message; }
}
$('#clip-refresh').onclick = refreshClipboard;
$('#clip-import').onclick = async () => {
  try { await bridge.clipboardImport(); await refreshClipboard(); }
  catch (e) { $('#clip-status').textContent = e.message; }
};
$('#clip-clear').onclick = async () => { await bridge.clipboardClear(); await refreshClipboard(); };

let cfg = null;
let state = { phase: 'idle', text: '', durationMs: 0, error: '' };

/* ---------------- 国际化 ---------------- */
const EN = {
  'home.title': 'Overview',
  'home.sub': 'Runs in the background. Hold to talk, release to insert.',
  'home.ready': 'Ready',
  'home.listening': 'Listening in background',
  'home.hint': 'Hold to talk · Release to insert',
  'home.stat1': 'Today',
  'home.unit': 'chars',
  'home.stat2': 'Typed today (chars)',
  'home.stat3': 'Recorded (min)',
  'home.recent': 'Recent transcriptions',
  'home.clear': 'Clear',
  'lab.title': 'Playground',
  'lab.sub': 'Try it here without switching windows.',
  'lab.hint': 'Hold the button, release to insert',
  'lab.result': 'Result',
  'lab.waiting': 'Waiting',
  'lab.ph': 'Your speech will appear here.',
  'lab.model': 'Model',
  'lab.lang': 'Lang',
  'lab.copy': 'Copy result',
  'lab.replay': 'Replay',
  'lab.reset': 'Reset',
  'set.title': 'Settings',
  'set.sub': 'Changes apply immediately and are saved automatically.',
  'set.api': 'API',
  'set.key.d': 'Create one on the MiMo platform. Stored locally only.',
  'set.url': 'Base URL',
  'set.url.d': 'OpenAI-compatible endpoint.',
  'set.model': 'Model',
  'set.model.d': 'Recognition model.',
  'set.language': 'Recognition language',
  'set.language.d': 'Auto-detect, or lock a language for better accuracy.',
  'set.auto': 'Auto',
  'set.test': 'Connection test',
  'set.test.d': 'Not tested yet.',
  'set.test.btn': 'Test',
  'set.trigger': 'Trigger',
  'set.toggle': 'Press to toggle',
  'set.toggle.d': 'Press once to start, again to stop. Off means hold-to-talk.',
  'set.hotkey': 'Shortcut',
  'set.hotkey.d': 'Hold the combo to record.',
  'set.bind': 'Rebind',
  'set.autostart': 'Start on login',
  'set.autostart.d': 'Stay in the tray after login.',
  'set.output': 'Output',
  'set.inject': 'Injection',
  'set.inject.d': 'Commit through the input method. On a reported failure, copy the result for manual paste.',
  'set.inject.fcitx': 'Input method',
  'set.inject.preview': 'Transcribe only',
  'set.mic': 'Keep microphone warm',
  'set.mic.d': 'Keeps capture running to preserve the start. Off releases the mic after recording; the next start takes longer.',
  'set.strip': 'Strip trailing punctuation',
  'set.strip.d': 'Handy for shell or code input.',
  'set.look': 'Appearance',
  'set.uilang': 'Interface language',
  'set.uilang.d': 'Chinese / English.',
  'set.pos': 'Overlay position',
  'set.pos.d': 'Where the overlay appears while recording.',
  'set.pos.bottom': 'Bottom center',
  'set.pos.top': 'Top center',
  'set.env': 'Runtime',
  'set.cfgdir': 'Open config folder'
};

const STATUS = {
  zh: {
    idle: '就绪', listening: '后台监听中', recording: '正在录音',
    transcribing: '识别中', injecting: '正在提交', done: '已提交给输入法', error: '出错了',
    recHint: '松手结束', toggleHint: '再按一次结束',
    wait: '等待输入', recog: '识别中…', injected: '已注入', failed: '失败',
    noKey: '还没填 API Key', noKeySub: '到设置里填一个就能用了',
    noPerm: '缺少键盘读取权限', empty: '没听清，再来一次',
    micHint: '按住按钮说话，松开立刻出字', micBusy: '正在识别…',
    binding: '按下组合键…', tested: '连接正常', testFail: '连接失败'
  },
  en: {
    idle: 'Ready', listening: 'Listening in background', recording: 'Recording',
    transcribing: 'Transcribing', injecting: 'Committing', done: 'Submitted to input method', error: 'Error',
    recHint: 'Release to finish', toggleHint: 'Press again to stop',
    wait: 'Waiting', recog: 'Transcribing…', injected: 'Inserted', failed: 'Failed',
    noKey: 'No API key yet', noKeySub: 'Add one in Settings to get started',
    noPerm: 'Keyboard permission missing', empty: 'Nothing heard, try again',
    micHint: 'Hold the button, release to insert', micBusy: 'Transcribing…',
    binding: 'Press a combo…', tested: 'Connected', testFail: 'Connection failed'
  }
};

let lang = 'zh';
const T = (k) => (STATUS[lang] || STATUS.zh)[k] || k;

function applyTheme(t) {
  document.documentElement.dataset.theme = t || 'auto';
  $$('#theme button').forEach(b => b.classList.toggle('on', b.dataset.theme === (t || 'auto')));
}

function applyLang(l) {
  lang = l;
  const en = l === 'en';
  document.documentElement.lang = en ? 'en' : 'zh';
  for (const el of $$('[data-i18n]')) {
    const key = el.dataset.i18n;
    if (!el.dataset.orig) el.dataset.orig = el.textContent;
    el.textContent = en ? (EN[key] || el.dataset.orig) : el.dataset.orig;
  }
  $$('#lang button').forEach(b => b.classList.toggle('on', b.dataset.lang === l));
  $$('#uilang-chips .chip').forEach(b => b.classList.toggle('on', b.dataset.v === l));
  renderState(state, true);
  renderHistory();
}

/* ---------------- 渲染 ---------------- */
function keyLabel(k) {
  if (lang === 'en') return k === 'Super' ? 'Win' : k;
  return k === 'Super' ? 'Win' : k === 'Ctrl' ? 'Ctrl' : k === 'Shift' ? 'Shift' : k === 'Alt' ? 'Alt' : k;
}

function renderKeys(container, keys) {
  container.innerHTML = keys
    .map(k => `<span class="kbd">${keyLabel(k)}</span>`)
    .join('<em>+</em>');
}

const PHASE_LABEL = {
  idle: 'idle', recording: 'recording', transcribing: 'transcribing',
  injecting: 'injecting', done: 'done', error: 'error'
};

let lastPhase = '';
function renderState(s, force) {
  if (!s) return;
  state = s;
  const phaseChanged = s.phase !== lastPhase;
  lastPhase = s.phase;
  // 录音期间只有电平在跳，走轻量路径，别每次都重建整页
  if (!phaseChanged && !force && s.phase === 'recording') {
    if (typeof s.level === 'number') renderWave(s.level);
    return;
  }
  // 转写期间每个 SSE chunk 都会推一次，只更新文字，别重建整页
  if (!phaseChanged && !force && s.phase === 'transcribing' && s.text) {
    const el = $('#outtxt');
    if (el) { el.classList.remove('ph'); el.innerHTML = escapeHtml(s.text) + '<span class="cur"></span>'; }
    const sub = $('#hero-sub');
    if (sub) sub.textContent = s.text.slice(0, 60);
    return;
  }
  state = s;
  const orb = $('#orb'), heroStatus = $('#hero-status'), heroSub = $('#hero-sub');
  const hero = $('#hero');
  const mic = $('#mic'), wave = $('#wave'), outtxt = $('#outtxt'),
        outstat = $('#outstat'), hint = $('#lab-hint'), mw = $('#mic-wrap');

  const mode = cfg ? cfg.mode : 'hold';
  const hotkeys = cfg ? cfg.hotkey : ['Ctrl', 'Super'];
  renderKeys($('#hero-keys'), hotkeys);

  hero.classList.remove('err');
  orb.classList.remove('live');

  let label = T('idle');
  let sub = T('listening');
  let outText = null;

  switch (s.phase) {
    case 'recording':
      if (typeof s.level === 'number') renderWave(s.level);
      label = T('recording');
      sub = mode === 'toggle' ? T('toggleHint') : T('recHint');
      orb.classList.add('live');
      mic.classList.add('rec'); wave.classList.add('on'); mw.classList.add('rec');
      hint.textContent = T('recHint');
      outstat.textContent = T('recog');
      outstat.style.color = 'var(--ac)';
      if (!s.text) outtxt.innerHTML = '<span class="cur"></span>';
      outtxt.classList.remove('ph');
      break;
    case 'transcribing':
      resetWave(); renderPeak(s.peak);
      $('#btn-replay').disabled = false;
      label = T('transcribing');
      sub = s.text ? s.text.slice(0, 60) : '…';
      outstat.textContent = T('recog');
      outstat.style.color = 'var(--ac)';
      if (s.text) { outtxt.classList.remove('ph'); outText = s.text; }
      break;
    case 'injecting':
      label = T('injecting'); sub = s.text ? s.text.slice(0, 60) : '';
      outstat.textContent = T('injecting'); outstat.style.color = 'var(--tx2)';
      if (s.text) { outtxt.classList.remove('ph'); outText = s.text; }
      break;
    case 'done':
      resetWave(); renderPeak(s.peak);
      $('#btn-replay').disabled = false;
      label = s.previewOnly ? (lang === 'en' ? 'Transcribed' : '转写完成') : T('done');
      sub = s.text ? s.text.slice(0, 60) : '';
      orb.classList.add('live');
      outstat.textContent = label; outstat.style.color = 'var(--ok)';
      if (s.text) { outtxt.classList.remove('ph'); outText = s.text; }
      mic.classList.remove('rec'); wave.classList.remove('on'); mw.classList.remove('rec');
      hint.textContent = T('micHint');
      break;
    case 'error': {
      resetWave(); renderPeak(s.peak);
      $('#btn-replay').disabled = false;
      hero.classList.add('err');
      label = T('error');
      const e = s.error || '';
      if (e === 'NO_API_KEY') { label = T('noKey'); sub = T('noKeySub'); }
      else if (e === 'EMPTY_RESULT') { sub = T('empty'); }
      else if (e === 'NO_DEVICE' || e === 'PERMISSION') { label = T('noPerm'); sub = e; }
      else sub = inputError(e);
      if (s.copiedFallback) sub = lang === 'en' ? 'Insertion failed. Copied to clipboard; paste manually.' : '未能注入，已自动复制到剪贴板，请手动粘贴。';
      if (s.text) { outtxt.classList.remove('ph'); outText = s.text; }
      outstat.textContent = T('failed'); outstat.style.color = 'var(--err)';
      mic.classList.remove('rec'); wave.classList.remove('on'); mw.classList.remove('rec');
      hint.textContent = T('micHint');
      break;
    }
    default:
      resetWave();
      mic.classList.remove('rec'); wave.classList.remove('on'); mw.classList.remove('rec');
      outstat.textContent = T('wait'); outstat.style.color = 'var(--tx3)';
      hint.textContent = T('micHint');
  }

  if (s.phase === 'idle' && !outtxt.textContent.trim()) {
    outtxt.classList.add('ph');
    outtxt.textContent = lang === 'en' ? 'Your speech will appear here.' : '说话的内容会出现在这里。';
  }

  heroStatus.textContent = label;
  heroSub.textContent = sub;

  if (outText !== null) {
    const typing = s.phase === 'transcribing';
    outtxt.innerHTML = escapeHtml(outText) + (typing ? '<span class="cur"></span>' : '');
  }
  if (s.latencyMs) $('#m-lat').textContent = `${s.latencyMs} ms`;
}

function inputError(code) {
  const messages = {
    INPUT_BRIDGE_UNAVAILABLE: ['输入法桥接未运行，请重新执行安装脚本。结果已保留。', 'Input bridge unavailable. Run install.sh again. The result is saved.'],
    NO_INPUT_FOCUS: ['请先点入支持输入法的文本框。结果已保留，可复制。', 'Focus a text field with input-method support. The result is saved.'],
    FOCUS_CHANGED: ['输入焦点已改变，结果已保留，可复制。', 'Focus changed. The result is saved and can be copied.']
  };
  return messages[code] ? messages[code][lang === 'en' ? 1 : 0] : code.slice(0, 90);
}

/* 真实电平驱动波形 */
function renderWave(level) {
  const wave = $('#wave');
  if (!wave) return;
  wave.classList.add('live');
  const bars = [...wave.children];
  bars.forEach((b, i) => {
    const center = 1 - Math.abs(i - 4) / 5;
    const h = 4 + level * 26 * center * (0.55 + Math.random() * 0.75);
    b.style.height = Math.max(4, Math.min(28, h)) + 'px';
  });
}

function resetWave() {
  const wave = $('#wave');
  if (!wave) return;
  wave.classList.remove('live');
  [...wave.children].forEach(b => { b.style.height = ''; });
}

/* 录音峰值 -> 对用户直白的判断 */
function renderPeak(peak) {
  const el = $('#peak-tip');
  if (!el) return;
  if (peak === undefined || peak === null) { el.textContent = ''; el.className = 'peak'; return; }
  const db = 20 * Math.log10(Math.max(peak, 1e-6));
  const txt = lang === 'en' ? 'peak' : '峰值';
  el.textContent = `${txt} ${db.toFixed(0)} dB`;
  if (db < -38) { el.className = 'peak low'; el.title = lang === 'en' ? 'Microphone barely picked anything up' : '麦克风几乎没收到声音'; }
  else if (db > -4) { el.className = 'peak warn'; el.title = lang === 'en' ? 'Input is clipping' : '输入有削波，离麦克风远一点'; }
  else { el.className = 'peak ok'; el.title = lang === 'en' ? 'Input level is healthy' : '输入电平正常'; }
}

/* 回听原始录音 */
let audioEl = null;
let playing = false;

function setReplayState(on) {
  playing = on;
  const btn = $('#btn-replay');
  if (!btn) return;
  btn.classList.toggle('playing', on);
  const icon = $('#replay-icon');
  if (icon) {
    icon.innerHTML = on
      ? '<rect x="7" y="5.5" width="4" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.5" y="5.5" width="4" height="13" rx="1" fill="currentColor" stroke="none"/>'
      : '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>';
  }
}

async function toggleReplay() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.onended = () => setReplayState(false);
  }
  if (playing) { audioEl.pause(); setReplayState(false); return; }
  const a = await bridge.lastAudio();
  if (!a) return;
  audioEl.src = a.dataUrl;
  try { await audioEl.play(); setReplayState(true); } catch (e) { setReplayState(false); }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHistory() {
  const list = $('#rec-list');
  const history = (cfg && cfg.history) || [];
  if (!history.length) {
    list.innerHTML = `<div class="empty">${lang === 'en' ? 'Nothing yet. Hold the shortcut and say something.' : '还没有记录。按住快捷键说一句试试。'}</div>`;
    updateStats();
    return;
  }
  list.innerHTML = history.slice(0, 6).map(h => {
    const d = new Date(h.at || Date.now());
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const sec = Math.round((h.durationMs || 0) / 1000);
    const dur = '00:' + String(Math.min(sec, 59)).padStart(2, '0');
    return `<div class="rec">
      <div class="t mono">${hm}<i>${dur}</i></div>
      <div class="c">${escapeHtml(h.text || '')}</div>
      <button class="cp" data-copy="${encodeURIComponent(h.text || '')}">${lang === 'en' ? 'Copy' : '复制'}</button>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-copy]').forEach(b => {
    b.onclick = () => { bridge.copyText(decodeURIComponent(b.dataset.copy)); };
  });
  updateStats();
}

function updateStats() {
  const history = (cfg && cfg.history) || [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = history.filter(h => (h.at || 0) >= today.getTime());
  const chars = t.reduce((n, h) => n + (h.text || '').length, 0);
  const mins = Math.round(history.reduce((n, h) => n + (h.durationMs || 0), 0) / 60000);
  $('#st-count').textContent = t.length;
  $('#st-chars').textContent = chars.toLocaleString();
  $('#st-time').textContent = mins;
}

/* ---------------- 配置 ---------------- */
async function loadCfg() {
  cfg = await bridge.getConfig();
  $('#in-key').value = cfg.apiKey || '';
  $('#in-url').value = cfg.baseUrl;
  $('#in-model').value = cfg.model;
  $('#lab-endpoint').textContent = cfg.baseUrl.replace(/^https?:\/\//, '');
  $('#m-model').textContent = cfg.model;
  $('#m-lang').textContent = cfg.asrLanguage === 'auto' ? (lang === 'en' ? 'Auto' : '自动')
    : cfg.asrLanguage === 'zh' ? '中文' : 'English';
  setChips('#lang-chips', cfg.asrLanguage);
  setChips('#inject-chips', cfg.injectMethod);
  setChips('#pos-chips', cfg.overlayPosition);
  setChips('#uilang-chips', cfg.uiLang);
  $('#sw-toggle').classList.toggle('on', cfg.mode === 'toggle');
  $('#sw-mic').classList.toggle('on', cfg.keepMicWarm !== false);
  $('#sw-strip').classList.toggle('on', !!cfg.stripTrailingPunct);
  $('#sw-autostart').classList.toggle('on', !!cfg.autostart);
  renderKeys($('#hotkey-keys'), cfg.hotkey);
  renderKeys($('#hero-keys'), cfg.hotkey);
  applyTheme(cfg.theme || 'auto');
  applyLang(cfg.uiLang || 'zh');
  renderHistory();
}

function setChips(sel, value) {
  $$(sel + ' .chip').forEach(c => c.classList.toggle('on', c.dataset.v === value));
}

async function patch(p) {
  cfg = await bridge.saveConfig(p);
  renderHistory();
  return cfg;
}

/* ---------------- 窗口缩放 ---------------- */
const MIN_W = 600, MIN_H = 430;

$$('.rz').forEach((el) => {
  el.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    const dir = el.dataset.dir;
    const b0 = await bridge.getBounds();
    const sx = e.screenX, sy = e.screenY;
    let raf = 0, latest = null;

    const flush = () => {
      raf = 0;
      if (latest) bridge.setBounds(latest);
    };

    const onMove = (ev) => {
      const dx = ev.screenX - sx, dy = ev.screenY - sy;
      let { x, y, width, height } = b0;
      if (dir.includes('e')) width = Math.max(MIN_W, b0.width + dx);
      if (dir.includes('s')) height = Math.max(MIN_H, b0.height + dy);
      if (dir.includes('w')) { width = Math.max(MIN_W, b0.width - dx); x = b0.x + (b0.width - width); }
      if (dir.includes('n')) { height = Math.max(MIN_H, b0.height - dy); y = b0.y + (b0.height - height); }
      latest = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      if (raf) cancelAnimationFrame(raf);
      if (latest) bridge.setBounds(latest);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  });
});

/* ---------------- 导航 ---------------- */
$$('.nav').forEach(n => n.onclick = () => go(n.dataset.page));
function go(page) {
  $$('.nav').forEach(x => x.classList.toggle('on', x.dataset.page === page));
  $$('.page').forEach(p => p.classList.toggle('on', p.dataset.p === page));
  if (page === 'clipboard') refreshClipboard();
}

/* ---------------- 控件 ---------------- */
$$('#lang button').forEach(b => b.onclick = () => { patch({ uiLang: b.dataset.lang }); applyLang(b.dataset.lang); });
$$('#theme button').forEach(b => b.onclick = () => { applyTheme(b.dataset.theme); patch({ theme: b.dataset.theme }); });
$$('#uilang-chips .chip').forEach(b => b.onclick = () => { patch({ uiLang: b.dataset.v }); applyLang(b.dataset.v); });
$$('#lang-chips .chip').forEach(b => b.onclick = () => {
  setChips('#lang-chips', b.dataset.v);
  $('#m-lang').textContent = b.dataset.v === 'auto' ? (lang === 'en' ? 'Auto' : '自动') : b.dataset.v === 'zh' ? '中文' : 'English';
  patch({ asrLanguage: b.dataset.v });
});
$$('#inject-chips .chip').forEach(b => b.onclick = () => { setChips('#inject-chips', b.dataset.v); patch({ injectMethod: b.dataset.v }); });
$$('#pos-chips .chip').forEach(b => b.onclick = () => { setChips('#pos-chips', b.dataset.v); patch({ overlayPosition: b.dataset.v }); });

$('#sw-toggle').onclick = () => {
  const on = !$('#sw-toggle').classList.contains('on');
  $('#sw-toggle').classList.toggle('on', on);
  patch({ mode: on ? 'toggle' : 'hold' });
};
$('#sw-mic').onclick = () => {
  const on = !$('#sw-mic').classList.contains('on');
  $('#sw-mic').classList.toggle('on', on);
  patch({ keepMicWarm: on });
};
$('#sw-strip').onclick = () => {
  const on = !$('#sw-strip').classList.contains('on');
  $('#sw-strip').classList.toggle('on', on);
  patch({ stripTrailingPunct: on });
};
$('#sw-autostart').onclick = () => {
  const on = !$('#sw-autostart').classList.contains('on');
  $('#sw-autostart').classList.toggle('on', on);
  patch({ autostart: on });
};

let keyTimer = null;
$('#in-key').oninput = (e) => {
  clearTimeout(keyTimer);
  keyTimer = setTimeout(() => patch({ apiKey: e.target.value.trim() }), 500);
};
$('#in-url').onchange = (e) => patch({ baseUrl: e.target.value.trim() });
$('#in-model').onchange = (e) => patch({ model: e.target.value.trim() });
$('#btn-eye').onclick = () => {
  const k = $('#in-key');
  k.type = k.type === 'password' ? 'text' : 'password';
};
$('#btn-min').onclick = () => bridge.minimize();
$('#btn-close').onclick = () => bridge.hide();
$('#btn-cfgdir').onclick = () => bridge.openConfigDir();
$('#clear-history').onclick = async () => { await bridge.resetHistory(); cfg = await bridge.getConfig(); renderHistory(); };

$('#btn-test').onclick = async () => {
  const m = $('#test-msg');
  const btn = $('#btn-test');
  btn.disabled = true;
  m.textContent = lang === 'en' ? 'Connecting…' : '正在连接…';
  m.style.color = 'var(--tx3)';
  clearTimeout(keyTimer);
  await patch({ apiKey: $('#in-key').value.trim() });
  const r = await bridge.testConnection();
  btn.disabled = false;
  if (r.ok) {
    m.textContent = `${T('tested')} · ${r.latencyMs} ms`;
    m.style.color = 'var(--ok)';
  } else {
    m.textContent = (r.error === 'NO_API_KEY' ? (lang === 'en' ? 'No API key' : '还没填 API Key') : r.error || T('testFail')).slice(0, 80);
    m.style.color = 'var(--err)';
  }
};

/* ---------------- 快捷键绑定 ---------------- */
const MODS = { Control: 'Ctrl', Meta: 'Super', Alt: 'Alt', Shift: 'Shift' };
const held = new Set();
const seenMods = new Set();
let capturing = false;

$('#btn-bind').onclick = () => {
  capturing = true;
  held.clear(); seenMods.clear();
  $('#btn-bind').classList.add('primary');
  $('#btn-bind').textContent = T('binding');
};

function finishBind(keys) {
  const order = ['Ctrl', 'Super', 'Alt', 'Shift'];
  const mods = order.filter(k => keys.includes(k));
  const rest = keys.filter(k => !order.includes(k));
  const hotkey = [...mods, ...rest];
  if (!hotkey.length) return;
  capturing = false;
  held.clear(); seenMods.clear();
  const b = $('#btn-bind');
  b.classList.remove('primary');
  b.textContent = lang === 'en' ? 'Rebind' : '重新绑定';
  renderKeys($('#hotkey-keys'), hotkey);
  patch({ hotkey });
}

window.addEventListener('keydown', (e) => {
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    capturing = false; held.clear(); seenMods.clear();
    $('#btn-bind').classList.remove('primary');
    $('#btn-bind').textContent = lang === 'en' ? 'Rebind' : '重新绑定';
    return;
  }
  const mod = MODS[e.key];
  if (mod) { held.add(mod); seenMods.add(mod); return; }
  const name = e.key.length === 1 ? e.key.toUpperCase() : (e.code && e.code.startsWith('Key') ? e.code.slice(3) : e.key);
  // 把当时按住的修饰键也算进去
  for (const m of seenMods) held.add(m);
  finishBind([...held, name]);
}, true);

window.addEventListener('keyup', (e) => {
  if (!capturing) return;
  const mod = MODS[e.key];
  if (mod) held.delete(mod);
  if (held.size === 0 && seenMods.size > 0) finishBind([...seenMods]);
}, true);

/* ---------------- 尝试页 ---------------- */
let labHeld = false;
let labStarting = null;
const mic = $('#mic');
mic.addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  if (labHeld) return;
  labHeld = true;
  labStarting = (async () => {
    clearTimeout(keyTimer);
    await patch({ apiKey: $('#in-key').value.trim() });
    return bridge.labStart();
  })();
  const started = await labStarting;
  if (!started) labHeld = false;
});
window.addEventListener('pointerup', async () => {
  if (!labHeld) return;
  labHeld = false;
  await labStarting;
  await bridge.labStop();
});
$('#btn-copy-out').onclick = async () => {
  const t = $('#outtxt').textContent.trim();
  if (t) await bridge.copyText(t);
};
$('#btn-replay').onclick = toggleReplay;
$('#btn-clear-out').onclick = () => {
  if (audioEl) { audioEl.pause(); setReplayState(false); }
  $('#btn-replay').disabled = true;
  $('#peak-tip').textContent = '';
  $('#outtxt').className = 'txt ph';
  $('#outtxt').textContent = lang === 'en' ? 'Your speech will appear here.' : '说话的内容会出现在这里。';
  $('#outstat').textContent = T('wait');
  $('#outstat').style.color = 'var(--tx3)';
  $('#m-lat').textContent = '—';
};

/* ---------------- 环境探测 ---------------- */
async function probe() {
  const env = await bridge.envCheck();
  const hk = await bridge.hotkeyProbe();

  const missing = [];
  if (!env.inputBridge) missing.push(lang === 'en' ? 'input bridge' : '输入法桥接');
  if (!env.layerShell) missing.push(lang === 'en' ? 'overlay' : '悬浮层');
  if (!env.parec) missing.push('pulseaudio-utils');

  const envEl = $('#env-msg');
  if (missing.length) {
    envEl.textContent = `${lang === 'en' ? 'Unavailable: ' : '未就绪：'}${missing.join(' / ')}`;
    envEl.style.color = 'var(--err)';
  } else {
    envEl.textContent = `fcitx5 · layer-shell · parec ${lang === 'en' ? 'all ready' : '均已就绪'}`;
    envEl.style.color = 'var(--tx3)';
  }

  const notice = $('#perm-notice');
  const dot = $('#svc-dot');
  if (!hk.ready) {
    dot.classList.remove('dot-on'); dot.classList.add('dot-off');
    notice.classList.add('show');
    notice.innerHTML = lang === 'en'
      ? `Global shortcut is inactive: ${hk.permissionError || 'no keyboard device found'}.<br>Run <code>sudo ./install.sh --grant-input</code>; permission applies immediately.`
      : `全局快捷键未生效：${hk.permissionError || '没找到键盘设备'}。<br>执行 <code>sudo ./install.sh --grant-input</code>，授权立即生效。`;
  } else {
    dot.classList.add('dot-on'); dot.classList.remove('dot-off');
    notice.classList.remove('show');
  }
}

/* ---------------- 启动 ---------------- */
bridge.onState(renderState);
bridge.onHistory((h) => { cfg.history = h; renderHistory(); });
bridge.onGoto((page) => go(page));
bridge.onHotkeyStatus((s) => {
  if (!s.ready) {
    const notice = $('#perm-notice');
    notice.classList.add('show');
    notice.innerHTML = lang === 'en'
      ? `Global shortcut is inactive: ${s.permissionError || 'no keyboard device'}.<br>Run <code>sudo ./install.sh --grant-input</code>; no login needed.`
      : `全局快捷键未生效：${s.permissionError || '没找到键盘设备'}。<br>执行 <code>sudo ./install.sh --grant-input</code>，无需重新登录。`;
  }
});

(async () => {
  await loadCfg();
  await probe();
  renderState(await bridge.getState());
})();
