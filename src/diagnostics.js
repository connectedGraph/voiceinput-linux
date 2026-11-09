'use strict';
// 轻量事件日志。故意不用 appendFileSync：转写时每个 SSE 增量都写一次同步磁盘 IO
// 会把主线程拖住，这里改成异步追加，队列过长时直接丢弃（诊断日志不值得拖慢 UI）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'mimo-asr');
const logPath = path.join(dir, 'events.jsonl');

let queue = [];
let flushing = false;
const MAX_QUEUE = 500;

function schedule() {
  if (flushing || !queue.length) return;
  flushing = true;
  const lines = queue.join('');
  queue = [];
  fs.appendFile(logPath, lines, { mode: 0o600 }, () => { flushing = false; schedule(); });
}

function trace(event, fields = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (queue.length >= MAX_QUEUE) return;
    queue.push(JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n');
    schedule();
  } catch (_) {}
}

module.exports = { trace, logPath };
