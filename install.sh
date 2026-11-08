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
    sed "s/u:rap:/u:$USER_NAME:/" "$DIR/assets/99-mimo-asr-input.rules" \
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
for c in parec ydotool wl-copy; do
  command -v "$c" >/dev/null 2>&1 || missing+=("$c")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  warn "缺少: ${missing[*]}"
  echo "  sudo apt install pulseaudio-utils ydotool wl-clipboard"
fi

say "安装 npm 依赖"
cd "$DIR"
if [[ ! -d node_modules/electron ]]; then
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install --registry=https://registry.npmmirror.com
else
  say "electron 已存在，跳过"
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
Exec=$DIR/node_modules/.bin/electron $DIR --no-sandbox
Icon=$DIR/assets/icon.png
Terminal=false
Categories=Utility;AudioVideo;
StartupWMClass=MiMo ASR
DESK

ln -sf "$DIR/bin/mimo-asr.js" "$HOME/.local/bin/mimo-asr"

if ! getfacl /dev/input/event3 2>/dev/null | grep -q "u:$USER_NAME:"; then
  warn "全局热键尚未授权，执行：sudo ./install.sh --grant-input"
fi

say "完成。启动方式："
echo "  $DIR/node_modules/.bin/electron $DIR --no-sandbox"
echo "  或从应用菜单打开 MiMo ASR"
