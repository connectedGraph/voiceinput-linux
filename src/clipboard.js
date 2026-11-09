'use strict';
const { clipboard, nativeImage, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const { CONFIG_DIR } = require('./config');

class ClipboardStore {
  constructor() {
    this.dir = path.join(CONFIG_DIR, 'clipboard');
    this.index = path.join(this.dir, 'index.json');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(fs.readFileSync(this.index, 'utf8'));
      this.items = Array.isArray(saved) ? saved.filter(x => x && /^[a-f0-9]{64}$/.test(x.id) && typeof x.text === 'string' && (!x.image || x.image === `${x.id}.png`)).slice(0, 50) : [];
    } catch (_) { this.items = []; }
    this.last = '';
    this.thumbs = new Map();   // id -> 缩略图 dataURL，避免每次打开剪贴板页都把 50 张图重新解码+缩放
  }
  thumbFor(item) {
    if (!item.image) return '';
    const cached = this.thumbs.get(item.id);
    if (cached) return cached;
    let url = '';
    try {
      url = nativeImage.createFromPath(path.join(this.dir, item.image)).resize({ width: 240 }).toDataURL();
    } catch (_) {}
    this.thumbs.set(item.id, url);
    return url;
  }
  save() {
    const removed = this.items.splice(50);
    for (const item of removed) {
      this.thumbs.delete(item.id);
      if (item.image) {
        try { fs.unlinkSync(path.join(this.dir, item.image)); } catch (_) {}
      }
    }
    fs.writeFileSync(this.index + '.tmp', JSON.stringify(this.items), { mode: 0o600 });
    fs.renameSync(this.index + '.tmp', this.index);
  }
  capture() {
    let image = clipboard.readImage();
    const text = clipboard.readText();
    let sourcePath = '';
    try {
      const uri = clipboard.readBuffer('text/uri-list').toString().split(/\r?\n/).find(x => x.startsWith('file:'));
      if (uri) sourcePath = fileURLToPath(uri);
      else if (path.isAbsolute(text.trim()) && fs.existsSync(text.trim())) sourcePath = text.trim();
    } catch (_) {}
    if (image.isEmpty() && sourcePath && /\.(png|jpg|jpeg|webp|bmp|gif)$/i.test(sourcePath)) image = nativeImage.createFromPath(sourcePath);
    const png = image.isEmpty() ? null : image.toPNG();
    if (!png && !text) return;
    const id = crypto.createHash('sha256').update(png || '').update(text).update(sourcePath).digest('hex');
    if (id === this.last) return;
    this.last = id;
    this.remember(png, text, sourcePath, id);
  }
  remember(png, text, sourcePath, id) {
    const previous = this.items.find(x => x.id === id);
    this.items = this.items.filter(x => x.id !== id);
    const item = { id, text, sourcePath: sourcePath || previous?.sourcePath || '', at: Date.now() };
    if (png) {
      item.image = `${id}.png`;
      fs.writeFileSync(path.join(this.dir, item.image), png, { mode: 0o600 });
    }
    this.items.unshift(item);
    this.save();
  }
  list() {
    return this.items.map(x => ({ ...x, path: x.sourcePath || (x.image ? path.join(this.dir, x.image) : ''),
      thumbnail: this.thumbFor(x) }));
  }
  copyText(text) {
    clipboard.writeText(String(text));
    this.capture();
  }
  copy(id, mode) {
    const item = this.items.find(x => x.id === id);
    if (!item) throw new Error('记录已不存在');
    if (mode === 'image' && item.image) clipboard.writeImage(nativeImage.createFromPath(path.join(this.dir, item.image)));
    else if (mode === 'path' && (item.image || item.sourcePath)) clipboard.writeText(item.sourcePath || path.join(this.dir, item.image));
    else if (mode === 'text') clipboard.writeText(item.text);
    else throw new Error('此记录没有所选格式');
    this.capture();
  }
  async importImage(window) {
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }] });
    if (result.canceled) return;
    const sourcePath = result.filePaths[0];
    const image = nativeImage.createFromPath(sourcePath);
    if (image.isEmpty()) throw new Error('无法读取这张图片');
    const png = image.toPNG();
    const id = crypto.createHash('sha256').update(png).digest('hex');
    this.remember(png, '', sourcePath, id);
  }
  start() {
    const poll = () => { try { this.capture(); } catch (e) { console.error('[clipboard]', e.message); } };
    poll();
    // Wayland 下 readImage() 是同步的，频率别太高；1.5s 对历史记录完全够用。
    this.timer = setInterval(poll, 1500);
  }
  stop() { clearInterval(this.timer); }
  clear() { this.items = []; this.thumbs.clear(); for (const f of fs.readdirSync(this.dir)) if (/^[a-f0-9]{64}\.png$/.test(f)) fs.unlinkSync(path.join(this.dir, f)); this.save(); }
}
module.exports = { ClipboardStore };
