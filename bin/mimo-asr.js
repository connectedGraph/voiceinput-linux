#!/usr/bin/env node
'use strict';
// 供其它脚本复用的命令行入口
const path = require('path');
const config = require('../src/config');
const { transcribe, ping } = require('../src/asr');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

function usage() {
  console.log(`mimo-asr — MiMo-V2.5-ASR 命令行

用法:
  mimo-asr --transcribe <file.wav> [--lang zh|en|auto] [--json]
  mimo-asr --ping
  mimo-asr --config            # 打印当前配置（API Key 打码）
`);
}

(async () => {
  if (has('--help') || has('-h') || !argv.length) return usage();
  const cfg = config.load();

  if (has('--config')) {
    const masked = { ...cfg, apiKey: cfg.apiKey ? cfg.apiKey.slice(0, 6) + '…' : '', history: `(${cfg.history.length} 条)` };
    console.log(JSON.stringify(masked, null, 2));
    return;
  }

  if (!cfg.apiKey) { console.error('未配置 API Key。先在面板里填，或写 ~/.config/mimo-asr/config.json / .env'); process.exit(1); }

  if (has('--ping')) {
    const r = await ping({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model, language: 'auto' });
    console.log(JSON.stringify(r));
    return;
  }

  const file = val('--transcribe');
  if (file) {
    const r = await transcribe(
      { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model, language: val('--lang') || cfg.asrLanguage },
      path.resolve(file),
      { onDelta: has('--json') ? undefined : (_p, full) => process.stderr.write('\r' + full.slice(-70)) }
    );
    if (has('--json')) console.log(JSON.stringify(r, null, 2));
    else console.log(r.text);
    return;
  }

  usage();
})().catch((e) => { console.error('错误:', e.message); process.exit(1); });
