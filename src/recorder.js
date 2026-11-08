'use strict';
// 常驻采集 + 环形缓冲。
// 按下只打标记，松手瞬间冻结 —— 录音边界不再受 parec 启停延迟影响。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RATE = 16000;
const BYTES_PER_SEC = RATE * 2;      // s16le 单声道
const RING_SECONDS = 5;              // 环形缓冲保留时长
const PRE_ROLL_SEC = 0.35;           // 按下前回补，避免第一个字被吃掉
const IDLE_SHUTDOWN_MS = 0;          // >0 时闲置这么久自动关采集；0 = 一直常驻（响应最快）

function wavHeader(dataLen) {
  const blockAlign = 2;
  const byteRate = RATE * blockAlign;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

function rmsOf(chunk) {
  const n = Math.floor(chunk.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = chunk.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

class Recorder {
  /** @param {{onLevel?:(rms:number,peak:number)=>void}} opts */
  constructor(opts = {}) {
    this.onLevel = opts.onLevel || null;
    this.proc = null;
    this.source = '';
    this.ring = [];                 // {buf, size}
    this.ringBytes = 0;
    this.segment = [];              // 当前这一段
    this.segBytes = 0;
    this.recording = false;
    this.peak = 0;
    this.levelPeak = 0;
    this.idleTimer = null;
    this.lastDataAt = 0;
    this.startTime = 0;
  }

  get alive() { return !!this.proc; }

  /** 启动采集（幂等）。常驻，不会因为一次录音结束而停。 */
  warmUp(source = '') {
    if (this.proc) {
      if (source && source !== this.source) this.shutdown();  // 换了设备，重启
      else { this._touch(); return; }
    }
    this.source = source || '';
    // latency 压低到 40ms，让数据块更细，电平和录音边界都更准
    const args = ['--format=s16le', `--rate=${RATE}`, '--channels=1', '--no-remix', '--latency-msec=40'];
    if (this.source) args.push(`--device=${this.source}`);

    const proc = spawn('parec', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;

    proc.stdout.on('data', (chunk) => this._onData(chunk));
    proc.on('error', (err) => console.error('[recorder] parec 启动失败:', err.message));
    proc.on('exit', (code, sig) => {
      if (this.proc === proc) {
        this.proc = null;
        console.error(`[recorder] parec 退出 code=${code} sig=${sig}`);
      }
    });
    proc.stderr.on('data', (b) => {
      const s = b.toString().trim();
      if (s) console.error('[recorder]', s);
    });
    this._touch();
  }

  _touch() {
    this.lastDataAt = Date.now();
    clearTimeout(this.idleTimer);
    if (IDLE_SHUTDOWN_MS > 0) {
      this.idleTimer = setTimeout(() => {
        if (!this.recording && Date.now() - this.lastDataAt > IDLE_SHUTDOWN_MS - 1000) this.shutdown();
      }, IDLE_SHUTDOWN_MS);
      this.idleTimer.unref?.();
    }
  }

  _onData(chunk) {
    this.lastDataAt = Date.now();

    // 环形缓冲
    this.ring.push(chunk);
    this.ringBytes += chunk.length;
    const ringLimit = BYTES_PER_SEC * RING_SECONDS;
    while (this.ringBytes > ringLimit && this.ring.length > 1) {
      this.ringBytes -= this.ring.shift().length;
    }

    // 录音段
    if (this.recording) {
      this.segment.push(chunk);
      this.segBytes += chunk.length;
    }

    // 电平（只在录音时对外报，避免空闲时白忙）
    if (this.onLevel && this.recording) {
      let rms = 0, peak = 0;
      for (let off = 0; off < chunk.length; off += 3200) {   // 每 100ms 一片
        const slice = chunk.subarray(off, Math.min(off + 3200, chunk.length));
        const r = rmsOf(slice);
        if (r > rms) rms = r;
        // 峰值
        for (let i = 0; i + 1 < slice.length; i += 2) {
          const a = Math.abs(slice.readInt16LE(i) / 32768);
          if (a > peak) peak = a;
        }
      }
      if (peak > this.peak) this.peak = peak;
      this.onLevel(rms, this.peak);
    }
  }

  /** 按下：从环形缓冲里回补一小段，之后的数据实时累积 */
  begin() {
    if (this.recording) return;
    this.segment = [];
    this.segBytes = 0;
    this.peak = 0;

    // 精确截取：chunk 可能很大（parec 一次给到 64KB = 2 秒），不能整块算
    const preRoll = Math.round(BYTES_PER_SEC * PRE_ROLL_SEC);
    const picked = [];
    let got = 0;
    for (let i = this.ring.length - 1; i >= 0 && got < preRoll; i--) {
      const buf = this.ring[i];
      const remain = preRoll - got;
      if (buf.length <= remain) {
        picked.unshift(buf);
        got += buf.length;
      } else {
        picked.unshift(buf.subarray(buf.length - remain));
        got += remain;
        break;
      }
    }
    if (picked.length) {
      this.segment = picked;
      this.segBytes = got;
    }
    this.recording = true;
    this.startTime = Date.now();
  }

  /** 松手：立刻冻结，不再接收新数据 */
  end(prefix = 'rec') {
    if (!this.recording) return null;
    this.recording = false;

    const pcm = Buffer.concat(this.segment, this.segBytes);
    this.segment = [];
    this.segBytes = 0;

    if (pcm.length < BYTES_PER_SEC * 0.25) return null;

    const dir = path.join(os.tmpdir(), 'mimo-asr');
    fs.mkdirSync(dir, { recursive: true });
    const wavPath = path.join(dir, `${prefix}-${Date.now()}.wav`);
    fs.writeFileSync(wavPath, Buffer.concat([wavHeader(pcm.length), pcm]));
    return {
      path: wavPath,
      bytes: pcm.length,
      durationMs: Math.round((pcm.length / BYTES_PER_SEC) * 1000),
      peak: this.peak
    };
  }

  /** 取消：丢掉这一段，采集继续 */
  cancel() {
    this.recording = false;
    this.segment = [];
    this.segBytes = 0;
  }

  shutdown() {
    clearTimeout(this.idleTimer);
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    this.recording = false;
    this.segment = [];
    this.ring = [];
    this.ringBytes = 0;
    try { p.kill('SIGTERM'); } catch (_) {}
  }
}

module.exports = { Recorder, wavHeader, RATE, BYTES_PER_SEC };
