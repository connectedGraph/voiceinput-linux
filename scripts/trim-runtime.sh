#!/usr/bin/env bash
# 裁剪 Electron 运行时里用不到的文件，纯粹为了省磁盘。
# 幂等：重复跑不会出错。
#
# 删掉的东西：
#   · 55 个 locale pak，只留 en-US 和 zh-CN（Chromium 找不到对应语言会回退 en-US）
#   · esbuild/swc 之类不会出现在 dist 里，这里只处理 electron 的 dist
# 保留：LICENSE / LICENSES.chromium.html（合规）、swiftshader（软件渲染兜底）、crashpad。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${1:-$DIR/node_modules/electron/dist}"
[[ -d "$DIST/locales" ]] || { echo "没有 $DIST/locales，跳过"; exit 0; }

before=$(du -sm "$DIST" | cut -f1)
keep="en-US zh-CN zh-TW"
for f in "$DIST"/locales/*.pak; do
  name="$(basename "$f" .pak)"
  case " $keep " in *" $name "*) ;; *) rm -f "$f" ;; esac
done
# 老版本可能留下 .pak.info 之类的空壳
find "$DIST/locales" -type f ! -name 'en-US.pak' ! -name 'zh-CN.pak' ! -name 'zh-TW.pak' -delete
after=$(du -sm "$DIST" | cut -f1)
echo "electron dist: ${before}MB -> ${after}MB（省 $((before-after))MB）"
