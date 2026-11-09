#!/usr/bin/env bash
# MiMo ASR 安装脚本（幂等）
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ID="mimo-asr"
USER_NAME="${SUDO_USER:-$USER}"

say()  { printf '\033[38;5;180m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[38;5;215m!\033[0m %s\n' "$*"; }

case "${1:-}" in
  --grant-input)
    say "安装 udev 规则：允许 $USER_NAME 读取 /dev/input/event*"
    sed -E "s/u:[^:]+:/u:$USER_NAME:/" "$DIR/assets/99-mimo-asr-input.rules" \
      | sudo tee /etc/udev/rules.d/99-mimo-asr-input.rules >/dev/null
    sudo udevadm control --reload-rules
    sudo udevadm trigger --action=add --subsystem-match=input
    sleep 1
    say "完成，立即生效（无需重新登录）"
    exit 0
    ;;
  --revoke-input)
    sudo rm -f /etc/udev/rules.d/99-mimo-asr-input.rules
    sudo udevadm control --reload-rules
    say "已移除 udev 规则"
    exit 0
    ;;
esac

say "检查依赖"
missing=()
for c in parec fcitx5 cc c++ pkg-config; do
  command -v "$c" >/dev/null 2>&1 || missing+=("$c")
done
if [[ ${#missing[@]} -gt 0 ]] || ! pkg-config --exists gtk+-3.0 gtk-layer-shell-0 Fcitx5Core Fcitx5Utils gio-2.0; then
  say "安装系统录音、输入法和悬浮层依赖"
  sudo apt-get install -y pulseaudio-utils fcitx5 build-essential pkg-config \
    libfcitx5core-dev libfcitx5config-dev libfcitx5utils-dev libgtk-3-dev libgtk-layer-shell-dev
fi

say "安装 npm 依赖"
cd "$DIR"
if [[ ! -x node_modules/electron/dist/electron ]]; then
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install --registry=https://registry.npmmirror.com
else
  say "electron 已存在，跳过"
fi

say "裁剪 Electron 运行时（只留中英文 locale）"
bash scripts/trim-runtime.sh

say "编译输入法桥接与 Wayland 悬浮层"
old_bridge="$(sha256sum build/libmimoasr.so 2>/dev/null | cut -d ' ' -f 1 || true)"
bash scripts/build-native.sh
new_bridge="$(sha256sum build/libmimoasr.so | cut -d ' ' -f 1)"
if [[ "$old_bridge" != "$new_bridge" ]] || ! build/bridge-client Version >/dev/null 2>&1; then
  say "重新加载 fcitx5，让输入桥接立即生效"
  fcitx5 -r -d >build/fcitx-reload.log 2>&1
  for attempt in {1..40}; do
    if build/bridge-client Version >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
fi
if ! build/bridge-client Version >/dev/null 2>&1; then
  warn "输入法桥接尚未加载，请查看 build/fcitx-reload.log"
  exit 1
fi

say "生成图标"
node scripts/gen-icons.js >/dev/null

say "安装启动器"
mkdir -p "$HOME/.local/share/applications" "$HOME/.local/bin"
cat > "$HOME/.local/share/applications/$APP_ID.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=MiMo ASR
Comment=语音输入助手
# 直接用 dist 里的 ELF 二进制：.bin/electron 是 #!/usr/bin/env node 脚本，
# 从桌面启动时 PATH 里没有 nvm 的 node，会静默失败
Exec="$DIR/node_modules/electron/dist/electron" "$DIR" --no-sandbox
Icon=$DIR/assets/icon.png
Terminal=false
Categories=Utility;AudioVideo;
StartupWMClass=MiMo ASR
DESK

ln -sf "$DIR/bin/mimo-asr.js" "$HOME/.local/bin/mimo-asr"

if ! getfacl /dev/input/event3 2>/dev/null | grep -q "user:$USER_NAME:"; then
  warn "全局热键尚未授权，执行：sudo ./install.sh --grant-input"
fi

say "完成。启动方式："
echo "  $DIR/node_modules/electron/dist/electron $DIR --no-sandbox"
echo "  或从应用菜单打开 MiMo ASR"
