'use strict';
// 配置读写。优先级：环境变量 > 项目 .env > ~/.config/mimo-asr/config.json > 内置默认
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP = 'mimo-asr';
const CONFIG_DIR = path.join(os.homedir(), '.config', APP);
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
// 写入永远落到配置目录，绝不写进项目目录（项目会被开源）
const ENV_FILE = path.join(CONFIG_DIR, '.env');
// 读取时兼容项目根的 .env，方便开发
const PROJECT_ENV = path.join(__dirname, '..', '.env');

const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5-asr',
  asrLanguage: 'auto',            // auto | zh | en
  uiLang: 'zh',                   // zh | en
  mode: 'hold',                   // hold | toggle
  hotkey: ['Ctrl', 'Super'],      // 逻辑键名数组，支持纯修饰键组合
  injectMethod: 'type',           // type(直接键入，非 ASCII 自动回落粘贴) | paste
  restoreClipboard: true,
  stripTrailingPunct: false,
  previewWhileTranscribing: true,
  overlayPosition: 'bottom',      // bottom | top
  theme: 'auto',                  // auto | light | dark
  keepMicWarm: true,              // 常驻采集：零启动延迟，代价是麦克风常亮
  audioSource: '',                // 空 = 系统默认输入
  autostart: false,
  history: []
};

function readEnvFile() {
  const out = {};
  for (const file of [PROJECT_ENV, ENV_FILE]) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
      }
    } catch (_) {}
  }
  return out;
}

function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error('[config] 读取失败:', err.message);
    return {};
  }
}

function normalize(cfg) {
  const hotkey = Array.isArray(cfg.hotkey) && cfg.hotkey.length ? cfg.hotkey : DEFAULTS.hotkey;
  return {
    ...cfg,
    hotkey,
    history: Array.isArray(cfg.history) ? cfg.history.slice(0, 50) : []
  };
}

let cached = null;

function load() {
  if (cached) return cached;
  const env = readEnvFile();
  const cfg = normalize({ ...DEFAULTS, ...readConfigFile() });
  const envKey = process.env.MIMO_API_KEY || env.MIMO_API_KEY;
  if (envKey) cfg.apiKey = envKey.trim();
  if (process.env.MIMO_BASE_URL) cfg.baseUrl = process.env.MIMO_BASE_URL.trim();
  cached = cfg;
  return cfg;
}

function invalidate() { cached = null; }

function save(patch) {
  const cur = load();
  const next = normalize({ ...cur, ...patch });
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[config] 写入失败:', err.message);
    throw err;
  }
  cached = next;
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(ENV_FILE, `MIMO_API_KEY=${patch.apiKey.trim()}\n`, { mode: 0o600 });
    } catch (_) {}
  }
  return next;
}

function pushHistory(item) {
  const cur = load();
  const history = [{ ...item, at: Date.now() }, ...cur.history].slice(0, 50);
  return save({ history });
}

module.exports = { APP, CONFIG_DIR, CONFIG_FILE, ENV_FILE, DEFAULTS, load, save, pushHistory, invalidate };
