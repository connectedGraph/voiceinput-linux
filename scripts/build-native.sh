#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_BUILD="${XDG_CACHE_HOME:-$HOME/.cache}/mimo-asr/native"
if [[ -d /data/cache ]]; then DEFAULT_BUILD=/data/cache/mimo-asr/native; fi
BUILD_DIR="${MIMO_BUILD_DIR:-$DEFAULT_BUILD}"
mkdir -p "$BUILD_DIR" "$DIR/build"
c++ -std=c++20 -O2 -Wall -Wextra -shared -fPIC "$DIR/native/fcitx-bridge.cpp" \
  $(pkg-config --cflags --libs Fcitx5Core Fcitx5Utils) -o "$BUILD_DIR/libmimoasr.so.new"
cc -O2 -Wall -Wextra "$DIR/native/bridge-client.c" \
  $(pkg-config --cflags --libs gio-2.0) -o "$BUILD_DIR/bridge-client.new"
cc -O2 -Wall -Wextra "$DIR/native/layer-overlay.c" \
  $(pkg-config --cflags --libs gtk+-3.0 gtk-layer-shell-0) -o "$BUILD_DIR/layer-overlay.new"
for file in libmimoasr.so bridge-client layer-overlay; do
  mv -f "$BUILD_DIR/$file.new" "$BUILD_DIR/$file"
  ln -sfn "$BUILD_DIR/$file" "$DIR/build/$file"
done
mkdir -p "$HOME/.local/share/fcitx5/addon" "$HOME/.local/lib/fcitx5"
ln -sfn "$DIR/build/libmimoasr.so" "$HOME/.local/lib/fcitx5/libmimoasr.so"
cat > "$BUILD_DIR/mimoasr.conf" <<CONF
[Addon]
Name=MiMo ASR text bridge
Type=SharedLibrary
Category=Module
Library=$HOME/.local/lib/fcitx5/libmimoasr
Version=1.0
OnDemand=False
Configurable=False
CONF
ln -sfn "$BUILD_DIR/mimoasr.conf" "$DIR/build/mimoasr.conf"
ln -sfn "$DIR/build/mimoasr.conf" "$HOME/.local/share/fcitx5/addon/mimoasr.conf"
