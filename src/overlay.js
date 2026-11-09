'use strict';
const { BrowserWindow, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

// Render the existing HTML HUD offscreen and present frames on a native Wayland layer.
//
// 性能要点：
//  · HUD 隐藏时绝不 startPainting，页面里的无限动画也只在 .hud.show 时启用，
//    否则 offscreen 窗口会一直按 frameRate 出帧，白烧一个核。
//  · 帧数据走原始 BGRA（nativeImage.getBitmap），不在主线程 toPNG()。
//    只有 helper 是老版本时才退回 PNG。
class Overlay {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.visible = false;
    this.painting = false;
    this.ready = false;
    this.rawSupported = false;
    this.error = '';
    this.frameCount = 0;
    this.latest = null;
    this.writing = false;
    this.hideTimer = null;
    this.wayland = !!process.env.WAYLAND_DISPLAY;
    this.window = new BrowserWindow({
      width: 560, height: 96, frame: false, transparent: true, show: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, focusable: false,
      hasShadow: false, alwaysOnTop: true, type: 'notification',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
        nodeIntegration: false, backgroundThrottling: false, offscreen: this.wayland
      }
    });
    if (this.wayland) {
      this.helper = spawn(path.join(__dirname, '..', 'build', 'layer-overlay'), [], {
        env: { ...process.env, GDK_BACKEND: 'wayland' }, stdio: ['pipe', 'pipe', 'pipe']
      });
      this.helper.stdout.on('data', b => {
        const s = b.toString();
        if (s.includes('READY')) {
          // 新 helper 会报 "READY 2"，支持原始位图帧；老 helper 只有 "READY"。
          this.rawSupported = /READY\s+2/.test(s);
          this.ready = true;
          this.flush();
        }
      });
      this.helper.stderr.on('data', b => console.error('[overlay]', b.toString().trim()));
      this.helper.stdin.on('error', () => { this.error = 'OVERLAY_UNAVAILABLE'; });
      this.helper.on('error', () => { this.ready = false; this.error = 'OVERLAY_UNAVAILABLE'; });
      this.helper.on('exit', () => { this.ready = false; this.error = 'OVERLAY_UNAVAILABLE'; });
      this.window.webContents.setFrameRate(30);
      this.window.webContents.on('paint', (_event, _dirty, image) => {
        if (!this.visible) return;              // 隐藏时收到帧也直接丢掉，不做任何编码
        this.frameCount++;
        this.latest = this.rawSupported ? this.packBitmap(image) : image.toPNG();
        this.flush();
      });
    } else {
      this.ready = true;
      this.window.setIgnoreMouseEvents(true, { forward: true });
      this.window.setAlwaysOnTop(true, 'screen-saver');
      this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    this.window.loadFile(path.join(__dirname, 'ui', 'overlay.html'));
  }

  packBitmap(image) {
    const { width, height } = image.getSize();
    const bitmap = image.getBitmap();          // BGRA, 与 cairo ARGB32 在本机小端下一致
    if (!bitmap || !bitmap.length) return null;
    return { bitmap, width, height, stride: width * 4 };
  }

  send(state) {
    if (!this.window.isDestroyed()) this.window.webContents.send('state', state);
  }

  show() {
    clearTimeout(this.hideTimer);
    this.visible = true;
    if (this.wayland) {
      if (!this.painting) {
        this.painting = true;
        this.window.webContents.startPainting();
      }
      this.window.webContents.invalidate();
    } else {
      const { x, y, width, height } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const top = this.getConfig().overlayPosition === 'top';
      this.window.setBounds({ x: Math.round(x + (width - 560) / 2), y: top ? y + 64 : y + height - 160,
        width: 560, height: 96 });
      this.window.showInactive();
    }
  }

  flush() {
    if (!this.ready || this.writing || !this.helper || !this.visible || !this.latest) return;
    const frame = this.latest;
    this.latest = null;
    const position = this.getConfig().overlayPosition === 'top' ? 'top' : 'bottom';
    let header, payload;
    if (this.rawSupported && frame.bitmap) {
      header = Buffer.from(
        `rawframe ${frame.bitmap.length} 560 96 ${frame.width} ${frame.height} ${frame.stride} ${position}`);
      payload = frame.bitmap;
    } else {
      header = Buffer.from(`frame ${frame.length} 560 96 ${position}`);
      payload = frame;
    }
    const size = Buffer.alloc(4); size.writeUInt32LE(header.length);
    this.writing = true;
    this.helper.stdin.write(Buffer.concat([size, header, payload]), () => {
      this.writing = false;
      if (!this.visible) this.sendHide();
      else this.flush();
    });
  }

  sendHide() {
    if (!this.helper || !this.ready || this.helper.stdin.destroyed) return;
    const header = Buffer.from('hide');
    const size = Buffer.alloc(4); size.writeUInt32LE(header.length);
    this.helper.stdin.write(Buffer.concat([size, header]));
  }

  hide() {
    this.visible = false;
    this.latest = null;
    if (this.wayland) {
      if (this.painting) {
        this.painting = false;
        this.window.webContents.stopPainting();
      }
      if (!this.writing) this.sendHide();
    } else this.window.hide();
  }

  hideSoon(ms) {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), ms);
  }

  destroy() {
    clearTimeout(this.hideTimer);
    if (this.helper) { this.helper.stdin.end(); this.helper.kill(); }
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}

module.exports = { Overlay };
