'use strict';
// 直接读 /dev/input/event*，实现 Wayland 下可用的全局热键（纯修饰键组合也能抓）
const fs = require('fs');
const { EventEmitter } = require('events');

const EV_SYN = 0, EV_KEY = 1;
const EV_SIZE = 24; // x86_64: timeval(16) + u16 type + u16 code + s32 value

// 修饰键 -> 逻辑名（左右合并）
const MODIFIER_CODES = {
  29: 'Ctrl', 97: 'Ctrl',
  125: 'Super', 126: 'Super',
  56: 'Alt', 100: 'Alt',
  42: 'Shift', 54: 'Shift'
};

// 常用实键 -> 逻辑名（够热键用即可）
const KEY_CODES = {
  2:'1',3:'2',4:'3',5:'4',6:'5',7:'6',8:'7',9:'8',10:'9',11:'0',
  16:'Q',17:'W',18:'E',19:'R',20:'T',21:'Y',22:'U',23:'I',24:'O',25:'P',
  30:'A',31:'S',32:'D',33:'F',34:'G',35:'H',36:'J',37:'K',38:'L',
  44:'Z',45:'X',46:'C',47:'V',48:'B',49:'N',50:'M',
  57:'Space',28:'Enter',1:'Escape',15:'Tab',14:'Backspace',
  59:'F1',60:'F2',61:'F3',62:'F4',63:'F5',64:'F6',65:'F7',66:'F8',67:'F9',68:'F10',87:'F11',88:'F12',
  51:',',52:'.',53:'/',39:';',40:"'",26:'[',27:']',12:'-',13:'=',41:'`',
  103:'Up',108:'Down',105:'Left',106:'Right',102:'Home',107:'End',104:'PageUp',109:'PageDown',110:'Insert',111:'Delete'
};

function codeToName(code) {
  return MODIFIER_CODES[code] || KEY_CODES[code] || null;
}

/** 解析 /proc 里的 KEY 能力位图（高位在前，需要反转） */
function parseKeyBitmap(block) {
  const m = block.match(/^B: KEY=(.*)$/m);
  if (!m) return null;
  return m[1].trim().split(/\s+/).reverse().map(t => BigInt('0x' + t));
}

function hasKeyBit(words, code) {
  if (!words) return false;
  const w = words[Math.floor(code / 64)];
  if (w === undefined) return false;
  return ((w >> BigInt(code % 64)) & 1n) === 1n;
}

const KEY_A = 30, KEY_Z = 44;

function listKeyboards() {
  let raw = '';
  try { raw = fs.readFileSync('/proc/bus/input/devices', 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const block of raw.split(/\n\s*\n/)) {
    const nameM = block.match(/^N: Name="(.*)"$/m);
    const handlerM = block.match(/^H: Handlers=(.*)$/m);
    if (!handlerM) continue;
    const handlers = handlerM[1].trim().split(/\s+/);
    if (!handlers.includes('kbd')) continue;
    const ev = handlers.find(h => /^event\d+$/.test(h));
    if (!ev) continue;
    // 只有真正带字母键的设备才算键盘（电源键、WMI、遥控器都有 kbd handler）
    const bits = parseKeyBitmap(block);
    const isKeyboard = hasKeyBit(bits, KEY_A) && hasKeyBit(bits, KEY_Z);
    if (!isKeyboard) continue;
    out.push({ name: nameM ? nameM[1] : ev, path: `/dev/input/${ev}` });
  }
  return out;
}

/**
 * 监听一个热键组合。
 * 事件：
 *   'press'   组合成立
 *   'release' 组合被破坏（松开任一目标键）
 *   'cancel'  组合成立后又按了别的键（多半用户想按别的快捷键）
 */
class HotkeyWatcher extends EventEmitter {
  constructor(hotkey) {
    super();
    this.devices = new Map();   // path -> { fd, buf, dev }
    this.pressed = new Map();   // 逻辑名 -> 按下计数
    this.setHotkey(hotkey);
    this.active = false;
    this.pollTimer = null;
    this.ready = false;
    this.permissionError = null;
    this._rescan = this._rescan.bind(this);
  }

  setHotkey(hotkey) {
    this.hotkey = (hotkey || []).map(String);
    this.reset();
  }

  reset() {
    this.pressed.clear();
    this.active = false;
  }

  start() {
    this._rescan();
    // 热插拔：每秒对一次设备表
    this._lastScan = Date.now();
    this.pollTimer = setInterval(this._rescan, 1000);
    return this;
  }

  stop() {
    clearInterval(this.pollTimer);
    for (const d of this.devices.values()) {
      try { fs.closeSync(d.fd); } catch (_) {}
    }
    this.devices.clear();
  }

  _rescan() {
    const found = listKeyboards();
    const paths = new Set(found.map(d => d.path));
    // 移除已消失的
    for (const [p, d] of this.devices) {
      if (!paths.has(p)) {
        try { fs.closeSync(d.fd); } catch (_) {}
        this.devices.delete(p);
      }
    }
    // 新增
    for (const dev of found) {
      if (this.devices.has(dev.path)) continue;
      let fd;
      try {
        fd = fs.openSync(dev.path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      } catch (err) {
        this.permissionError = err.code === 'EACCES' || err.code === 'EPERM'
          ? `没有读取 ${dev.path} 的权限` : err.message;
        continue;
      }
      const entry = { fd, buf: Buffer.alloc(EV_SIZE * 64), dev };
      this.devices.set(dev.path, entry);
      this._pump(dev.path);
    }
    this.ready = this.devices.size > 0;
  }

  _pump(path) {
    const pump = () => {
      const d = this.devices.get(path);
      if (!d) return;
      let bytes = 0;
      try {
        bytes = fs.readSync(d.fd, d.buf, 0, d.buf.length, null);
      } catch (err) {
        if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') return; // 无数据
        this.devices.delete(path);
        try { fs.closeSync(d.fd); } catch (_) {}
        return;
      }
      if (bytes > 0) {
        const n = Math.floor(bytes / EV_SIZE);
        for (let i = 0; i < n; i++) {
          const off = i * EV_SIZE;
          const type = d.buf.readUInt16LE(off + 16);
          const code = d.buf.readUInt16LE(off + 18);
          const value = d.buf.readInt32LE(off + 20);
          if (type === EV_KEY) this._onKey(code, value);
        }
      }
    };
    // 用轮询读（无 TTY、跨平台简单），20ms 一次足够
    const timer = setInterval(pump, 20);
    timer.unref?.();
    this._timers = this._timers || [];
    this._timers.push(timer);
  }

  _onKey(code, value) {
    const name = codeToName(code);
    if (!name) return;

    if (value === 2) return; // autorepeat 忽略

    if (value === 1) {
      const c = (this.pressed.get(name) || 0) + 1;
      this.pressed.set(name, c);
    } else if (value === 0) {
      const c = (this.pressed.get(name) || 0) - 1;
      if (c <= 0) this.pressed.delete(name); else this.pressed.set(name, c);
    }

    this._evaluate(name, value);
  }

  _evaluate(changedName, value) {
    if (!this.hotkey.length) return;
    const target = new Set(this.hotkey);
    const matched = [...target].every(k => this.pressed.has(k));
    const extra = [...this.pressed.keys()].filter(k => !target.has(k));

    if (!this.active) {
      if (matched && extra.length === 0) {
        this.active = true;
        this.emit('press');
      }
      return;
    }

    // 已激活
    if (!matched) {
      this.active = false;
      this.emit('release');
      return;
    }
    // 组合仍然成立，但多按了别的键 —— 用户多半想按别的快捷键
    if (value === 1 && extra.length > 0) {
      this.active = false;
      this.emit('cancel');
    }
  }
}

module.exports = { HotkeyWatcher, listKeyboards, codeToName };
