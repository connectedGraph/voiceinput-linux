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

## 注入：为什么中英文走两条路

`ydotool` 通过 `/dev/uinput` 在内核层创建虚拟键盘，所以在 Wayland 原生窗口和 XWayland 窗口上都能生效——这是 `xdotool`（只对 X11 客户端）和 `wtype`（只对 Wayland 客户端）做不到的。

但 `ydotool type` 只能敲 ASCII。中文没有对应的键码，必须走输入法。

所以：

- **纯 ASCII** → `ydotool type`，直接敲，不进剪贴板
- **含非 ASCII** → `wl-copy` 写剪贴板 + `ydotool key ctrl+v`

设置里"直接键入"是默认，但含中文时会自动回落到粘贴。这是硬件键盘协议的边界，不是实现偷懒。

注意 `ydotool key` 的语法是 `ctrl+v` 这种组合串，不是 `ctrl:1 v:1`。

`wl-copy` 写完会 fork 一个进程常驻持有剪贴板内容，所以要用 `detached + unref`，否则主进程退出会被拖住。

## 悬浮窗

`BrowserWindow` 用 `frame: false` + `transparent: true` + `focusable: false` + `setIgnoreMouseEvents(true, { forward: true })`。

`focusable: false` 是关键：录音时悬浮窗出现不能抢走目标输入框的焦点，否则粘贴会打到悬浮窗自己身上。X11 下窗口深度是 32（ARGB），透明和圆角都正常。

`alwaysOnTop` 用 `screen-saver` 级别，配合 `setVisibleOnAllWorkspaces`，切工作区也跟着走。

## 面板

无边框窗口，标题栏用 `-webkit-app-region: drag` 拖动。COSMIC 下无边框窗口没有原生边缘拖拽，所以自己在四边和四角放了 8 个 5px 的透明手柄，`pointerdown` 时取当前 bounds，`pointermove` 里算新 bounds 发给主进程，用 `requestAnimationFrame` 节流。

关键点是**在渲染进程里算**，不要在主进程里轮询 `screen.getCursorScreenPoint()`——那样依赖真实光标位置，任何非真实鼠标的输入（自动化、远程）都会失效。

主题是 CSS 变量三态：`dark` / `light` / `auto`，`auto` 走 `prefers-color-scheme`。所有颜色都走变量，包括阴影和键帽渐变，否则浅色下会出现深色残影。

## 配置

`~/.config/mimo-asr/config.json`，600 权限。加载优先级：环境变量 > 项目 `.env` > 配置文件 > 内置默认。

配置对象在进程内缓存，因为热键路径上每次按键都读一次磁盘是没必要的开销；`save()` 时同步更新缓存。

## 性能上的几个注意

- 电平更新每 80ms 一次，走单独的 IPC 通道，**不触发托盘图标重绘**。早期版本每次电平更新都调 `tray.setImage()`，等于每 80ms 做一次图片 resize，主进程被拖慢，热键 release 响应跟着变迟。
- 转写期间每个 SSE chunk 都会推一次状态，渲染层只更新文字节点，不重建整页。
- 录音期间渲染层只有波形在动，走轻量路径直接返回。

## 已知取舍

| 问题 | 现在 | 原因 |
|---|---|---|
| 麦克风常驻 | 默认是，可关 | 换取零启动延迟；关掉后开头有启动延迟 |
| 中文不能直敲 | 走剪贴板 | 虚拟键盘没有中文键码 |
| 单次 3.5 分钟 | 是 | 接口 10MB base64 限制 |
| 纯修饰键组合 | 自读 evdev | Wayland 无 GlobalShortcuts |
