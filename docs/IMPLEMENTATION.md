# 实现说明

这份文档讲的是"为什么这么做"，不是 API 手册。代码里能看出来的东西这里不重复。

## 整体结构

```
热键(evdev)  ──┐
               ├──> 状态机(main.js) ──> 录音器 ──> ASR ──> 注入
托盘 / 面板 ───┘                          │         │
                                          └─ 电平 ──┴─> 悬浮窗
```

主进程是唯一的状态持有者。渲染进程（面板、悬浮窗）只做两件事：把用户操作通过 IPC 发上来，把主进程广播下来的状态画出来。没有本地状态，也就没有同步问题。

状态机只有六个相位：

```
idle ──press──> recording ──release──> transcribing ──> injecting ──> done
                     │                       │
                     └──cancel──> idle       └──error──> error
```

`done` / `error` 会在悬浮窗上停留一会儿再回到 `idle`。

## 录音：为什么不是"按下才开录"

最直觉的写法是：按下时 `spawn('parec')`，松手时 `SIGTERM`。这个写法有两个必然后果：

1. `parec` 从进程创建到真正读出第一块 PCM，要经过进程启动、PipeWire 连接、stream 协商，通常是几十到几百毫秒。这段时间用户已经在说话了，但没录到。
2. 停止时 `SIGTERM` 到进程退出之间，采集侧缓冲里还有一小段没被读走，直接丢掉。

表现就是"慢一拍"——录到的内容整体偏后，第一个字经常没有。

所以这里不用进程启停来界定录音，而是：

- **常驻采集**：`parec` 在应用启动时就开始跑，一直不停，输出通过管道进 Node
- **环形缓冲**：保持最近 5 秒的 PCM
- **按下 = 打标记**：从环形缓冲里按**字节数**精确回补 350ms，之后新到的数据实时追加
- **松开 = 冻结**：`recording` 标志置 false，后续数据直接丢弃，同步生成 WAV

边界完全由标记决定，跟进程生命周期无关。

有一个坑值得记：`parec` 一次 `stdout` 的 data 事件最多能给 64KB，也就是 2 秒的音频。如果回补预录时按"整块"取，一块就等于 2 秒，录出来的东西会莫名其妙地长。必须按字节截断：

```js
const remain = preRoll - got;
if (buf.length <= remain) { picked.unshift(buf); got += buf.length; }
else { picked.unshift(buf.subarray(buf.length - remain)); break; }
```

另外给 `parec` 加了 `--latency-msec=40`，让数据块更细，电平反馈和边界都更准。

实测：按住 2.0 秒，`begin` 到 `end` 的时间差 2010ms，产出 WAV 2.39 秒（2.0 + 0.35 预录 + 管线余量）。

**代价**：麦克风顺路常开，系统会一直显示麦克风占用。

缓冲只在内存里滚动 5 秒、覆盖写，不上传不落盘，只有按下到松开这一段才会被切成 wav 送去识别。

如果不想让麦克风一直亮着，设置里关掉「麦克风常驻」即可：关掉后每次录音结束就 `shutdown()` 采集进程，闲置两分钟再兜底释放；下次按下要重新拉起 `parec`，开头会有启动延迟。

## 全局热键：为什么绕开 Electron 的 globalShortcut

Electron 的 `globalShortcut` 在 Linux 上底层是 X11 的 `XGrabKey`，两个问题叠在一起：

1. COSMIC 的 `xdg-desktop-portal` 后端只实现了 Access / FileChooser / RemoteDesktop / Screenshot / Settings / ScreenCast，**没有 GlobalShortcuts**。焦点在原生 Wayland 窗口时，X11 的 grab 拿不到按键。
2. `Ctrl + Win` 是纯修饰键组合，不是合法 accelerator，`globalShortcut` 注册不上。

所以直接读 `/dev/input/event*`：

- 从 `/proc/bus/input/devices` 里筛出真正的键盘。不能只看有没有 `kbd` handler——电源键、WMI 热键、遥控器都有。判据是 `B: KEY=` 能力位图里同时有 `KEY_A`(30) 和 `KEY_Z`(44)。
- 位图是高位在前的十六进制字，解析时要 `reverse()` 再按 64 位切片。
- 每次 `read` 24 字节解一个 `input_event`（x86_64：timeval 16 + type 2 + code 2 + value 4），只关心 `EV_KEY`，`value==2` 是自动重复要忽略。
- 左右修饰键合并成同一个逻辑名（`KEY_LEFTCTRL` 和 `KEY_RIGHTCTRL` 都算 `Ctrl`），用计数而不是布尔，避免同时按两边时松一个就误判。
- 组合成立后如果又按了别的键，判定为"用户其实想按别的快捷键"，走 `cancel` 而不是继续录音。
- 每秒重扫一次设备表，支持热插拔。

权限走 udev 规则给特定用户 `/dev/input/event*` 的读权限，比 `usermod -aG input` 好在不用重新登录。

## ASR：流式的是结果，不是音频

MiMo 的接口是 `POST /chat/completions` + `input_audio`，**音频必须一次性传完**，`stream: true` 只让识别结果按 SSE 逐块返回。

所以流程只能是：录音 → 停止 → 整段 base64 上传 → 读 SSE 逐字出字 → 收齐后注入。

限制也随之而来：只收 wav / mp3，base64 后上限 10MB。16k 单声道 s16 是 32KB/s，base64 膨胀 4/3，约 43KB/s，所以单次录音上限大约 3.5 分钟。

SSE 解析做了兼容：优先 `choices[0].delta.content`，其次 `delta.text`，再退到 `message.content`。

## 注入：一次输入法提交

注入只调用 Fcitx 的 `InputContext::commitString`：整段文本一次提交，不写剪贴板，不创建虚拟键盘，也不发送 `Ctrl+V` 或 `Ctrl+Shift+V`。开始录音时先捕获当前输入上下文 UUID，识别完成后再次校验焦点没有变化，随后提交一次。

这要求目标窗口向 Fcitx 注册输入法上下文。终端的粘贴快捷键和输入法支持互相独立。2026-11-09 实测 COSMIC Terminal 的原始 PTY 接收程序、XWayland 文本框以及 Codex TUI 输入框均收到中文输入法提交。

桥接返回 OK 仅表示已调用 `commitString`，没有目标应用的显示确认。界面因此标注“已提交给输入法”。`NO_INPUT_FOCUS`、`FOCUS_CHANGED`、`INPUT_BRIDGE_UNAVAILABLE` 等明确失败会通过 Electron clipboard API 自动复制全文，并提示手动粘贴。若目标应用静默丢弃文字，无法通用检测，托盘可复制最近识别结果。

剪贴板模块每 1.5 秒只读采样文字与图片，按内容去重，最多保存 50 条至用户配置目录。图片存 PNG，保留已知源文件路径；无源路径的截图可复制 PNG 缓存路径。缩略图生成一次后按 id 缓存，打开剪贴板页不会把 50 张图重新解码缩放。用户显式选择复制时才写入相应格式。失败自动复制是另一处经用户授权的写入，不会发送任何粘贴按键。

## 悬浮窗

Wayland 下不走 `BrowserWindow.show()`，而是 **offscreen 渲染 + 原生 layer-shell 显示**：

- Electron 窗口 `show: false` + `webPreferences.offscreen: true`，`setFrameRate(30)`
- `paint` 事件拿到帧，交给 `build/layer-overlay`（GTK + gtk-layer-shell）贴到屏幕底部
- 帧走原始 BGRA（`nativeImage.getBitmap()`），helper 端直接 memcpy 进 Cairo 的 ARGB32 surface，
  **不再在 Electron 主线程做 `toPNG()`**；helper 的 READY 握手带版本号，老 helper 自动退回 PNG
- 录音/转写期间按需出帧；`hide()` 会 `stopPainting()`，隐藏后不再产生任何帧

`focusable: false` 是关键：录音时悬浮窗出现不能抢走目标输入框的焦点，否则粘贴会打到悬浮窗自己身上。
X11 下窗口深度是 32（ARGB），透明和圆角都正常。

`alwaysOnTop` 用 `screen-saver` 级别，配合 `setVisibleOnAllWorkspaces`，切工作区也跟着走。

## 面板

面板是“可关闭的窗口”，不是进程的生命周期。主进程常驻，关窗口只影响界面：

- 右上角叉叉 → `hide()`，不是 `minimize()`。窗口从任务栏/窗口列表里消失，托盘、录音热键、
  悬浮窗全部继续工作；隐藏后对渲染进程开启 `backgroundThrottling`，不再占渲染资源。
- 重新打开应用（单实例 `second-instance`）、左键托盘、托盘菜单“打开面板”都走 `showMainWindow()`。
- 真正退出只能用托盘菜单或设置里的“退出 MiMo ASR”（`app.isQuitting = true`）。
- **开机自启**会在 `~/.config/autostart/mimo-asr.desktop` 写一条带 `--hidden` 的启动项，
  登录后只驻留后台；手动打开应用不带该参数，默认显示面板。

无边框窗口，标题栏用 `-webkit-app-region: drag` 拖动。COSMIC 下无边框窗口没有原生边缘拖拽，所以自己在四边和四角放了 8 个 5px 的透明手柄，`pointerdown` 时取当前 bounds，`pointermove` 里算新 bounds 发给主进程，用 `requestAnimationFrame` 节流。

关键点是**在渲染进程里算**，不要在主进程里轮询 `screen.getCursorScreenPoint()`——那样依赖真实光标位置，任何非真实鼠标的输入（自动化、远程）都会失效。

主题是 CSS 变量三态：`dark` / `light` / `auto`，`auto` 走 `prefers-color-scheme`。所有颜色都走变量，包括阴影和键帽渐变，否则浅色下会出现深色残影。

## 配置

`~/.config/mimo-asr/config.json`，600 权限。加载优先级：环境变量 > 项目 `.env` > 配置文件 > 内置默认。

配置对象在进程内缓存，因为热键路径上每次按键都读一次磁盘是没必要的开销；`save()` 时同步更新缓存。

## 性能上的几个注意

2026-11-09 修过一轮“闲着一动不动就吃掉 20% 单核”的问题，教训都写在这里：

- **offscreen 窗口的 CSS 动画即使 `opacity:0` 也会持续出帧。** 悬浮窗 HUD 里的小圆点原本是
  `animation:blink ... infinite`，页面加载即开跑，于是隐藏的悬浮窗一直 30fps 合成、
  每帧经 IPC 丢给主进程，主进程和 GPU 进程都被拖着。现在所有无限动画都挂在 `.hud.show` 下，
  隐藏时实测 30.2fps → 0.3fps。
- **主线程里不要做 `toPNG()`。** 悬浮窗每帧 560×96，PNG 编码在主线程，叠加 GTK 端解码，
  录音时直接把界面拖卡。现在改传原始 BGRA，helper 只做一次 memcpy。
- **不要每个 SSE chunk 都全量广播。** 服务端 10–20ms 一个增量，原实现每个增量都广播、
  写一条同步 `appendFileSync` 日志、触发悬浮窗重绘。现在文字合并到 20Hz（`pushText`），
  日志改异步追加（队列满就丢），最后一定 `flushText()` 不丢尾字。
- **电平更新每 80ms 一次**，走单独的 IPC 通道，**不触发托盘图标重绘**。早期版本每次电平更新都调
  `tray.setImage()`，等于每 80ms 做一次图片 resize，主进程被拖慢，热键 release 响应跟着变迟。
- **录音期间渲染层只有波形在动**，走轻量路径直接返回，不重建整页。
- 热键用 20ms 轮询 `/dev/input/event*`（`readSync` + `EAGAIN`），每个设备约 50 次/秒，
  开销很小，换来的是 Wayland 下不依赖 portal 的纯修饰键热键。

## 已知取舍

### 验证入口

`npm run test:clipboard` 和 `npm run test:fallback` 使用 Xvfb 隔离剪贴板，验证 Unicode、图片二进制、原路径保留、持久化、清空，以及无焦点/焦点变化/桥接故障自动复制。无需开本地测试接口；fallback 在进程内替换录音、ASR 和注入回执。系统需安装 `xvfb`。

真实桌面中运行 `npm run test:input`：新开 COSMIC Terminal，以 raw PTY 接收中文并核对字节。`npm run test:codex`：新开独立 Codex TUI，把验证文字交给输入法，从终端输出核对输入框回显并截图，不按回车、不发送模型请求。桌面必须解锁；若 agent shell 缺少桌面变量，本机使用 `DISPLAY=:1 WAYLAND_DISPLAY=wayland-1`。测试只关闭自己创建的进程。

2026-11-09 Codex TUI 实测证据目录：`/data/scratch/mimo-codex-input-ENTZsU/`。桥接 OK、终端回显和截图共同验证了这次输入，不能据此承诺所有应用都能接收。

| 问题 | 现在 | 原因 |
|---|---|---|
| 麦克风常驻 | 默认是，可关 | 换取零启动延迟；关掉后开头有启动延迟 |
| 目标没有输入法上下文 | 自动复制结果 | 不模拟按键，由用户手动粘贴 |
| 单次 3.5 分钟 | 是 | 接口 10MB base64 限制 |
| 纯修饰键组合 | 自读 evdev | Wayland 无 GlobalShortcuts |
