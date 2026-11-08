<div align="center">

# voiceinput-linux

**MiMo 语音输入法 · 优雅 UI for Linux · 支持自配置 ASR API**

按住快捷键说话，松手把整段文字注入到当前焦点窗口。

<img src="docs/screenshots/panel-dark.png" width="760" alt="主界面">

</div>

<br>

<div align="center">
<img src="docs/screenshots/overlay-rec.png" width="760" alt="悬浮窗">
</div>

## 它是什么

一个常驻托盘的桌面语音输入工具。按住 `Ctrl + Win` 说话，界面底部浮出一条窄窗实时出字，松手后整段文字直接打进你正在编辑的地方——编辑器、终端、浏览器输入框都行。

识别走小米 **MiMo-V2.5-ASR**，API Key 自己填，也可以换成任何 OpenAI 兼容的 ASR 端点。

原生支持 Wayland（COSMIC / GNOME / KDE），X11 同样可用。

## 特性

- **两种触发**：长按说话松手输入，或按一下开始、再按一下结束
- **任意快捷键**，包括 `Ctrl + Win` 这种纯修饰键组合
- **流式出字**：识别结果逐字浮现在悬浮窗，松手后整段一次注入，不做打字机模拟
- **回听原始录音**：每次录音留一份 wav，配合峰值电平判断到底是没录到还是识别不准
- **实时电平**：悬浮窗波形由真实音频驱动
- **日间 / 夜间 / 跟随系统**：三态主题，全部走 CSS 变量
- **中英双语**界面
- **录音边界精确**：常驻采集 + 环形缓冲，按下那一刻就是起点，松手那一刻就是终点
- **配置可复用**：`~/.config/mimo-asr/config.json`，也认 `MIMO_API_KEY` 环境变量，附 CLI 供其他脚本调用

## 安装

```bash
git clone https://github.com/connectedGraph/voiceinput-linux.git
cd voiceinput-linux

sudo apt install pulseaudio-utils ydotool wl-clipboard
./install.sh                       # 依赖、图标、启动器
sudo ./install.sh --grant-input    # 全局热键所需的键盘读取权限
```

`--grant-input` 会装一条 udev 规则，给当前用户 `/dev/input/event*` 的**读**权限，立即生效，不需要重新登录。撤销：`sudo ./install.sh --revoke-input`。

> 这条权限意味着该用户能读到所有键盘输入事件（包括密码）。所有 Linux 全局热键工具都是这个做法——Wayland 没有别的合法途径，COSMIC 的 portal 也没实现 GlobalShortcuts。不想给的话，托盘菜单和面板里的按钮仍然能触发录音，只是全局快捷键失效。

启动后到 **设置 → 接口** 填上 MiMo 的 API Key，点「测试连接」确认通畅。

## 使用

| 操作 | 效果 |
|---|---|
| 按住 `Ctrl + Win` | 开始录音，悬浮窗出现 |
| 松开 | 立即停止，上传识别，结果整段注入 |
| 点按切换模式 | 按一下开始，再按一下结束 |
| 左键托盘图标 | 打开面板 |
| 托盘右键 | 开始录音 / 尝试页 / 退出 |

快捷键、模式、注入方式、主题、悬浮窗位置都在设置里改，改完立即保存。

## 界面

<div align="center">
<img src="docs/screenshots/panel-light.png" width="420" alt="浅色主题">
<img src="docs/screenshots/settings-dark.png" width="420" alt="设置">
</div>

<br>

<div align="center">
<img src="docs/screenshots/lab-dark.png" width="420" alt="尝试页">
<img src="docs/screenshots/overlay-done.png" width="420" alt="已输入">
</div>

## 录音边界为什么值得单独说

最常见的写法是"按下才启动录音、松手才停"。这个写法一定会慢一拍：`parec` 从进程创建到读出第一块音频要几十到几百毫秒，这段时间说的话没录进去；停止时进程退出前缓冲里的尾巴也会丢。

这里改成**常驻采集 + 环形缓冲**：采集进程在应用启动时就跑起来，一直写进 5 秒的环形缓冲；按下只做一件事——从缓冲里精确回补 350ms 并打标记；松手立刻冻结，之后的数据直接丢弃。

边界由标记决定，跟进程启停完全无关。实测按住 2.0 秒，wav 时长 2.39 秒（2.0 + 0.35 预录 + 管线余量）。

代价是麦克风常驻，系统会一直显示麦克风占用。

细节和踩过的坑写在 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。

## 配置

`~/.config/mimo-asr/config.json`，600 权限。

加载优先级：环境变量 > 项目 `.env` > 配置文件 > 内置默认。

```json
{
  "apiKey": "",
  "baseUrl": "https://api.xiaomimimo.com/v1",
  "model": "mimo-v2.5-asr",
  "asrLanguage": "auto",
  "mode": "hold",
  "hotkey": ["Ctrl", "Super"],
  "injectMethod": "type",
  "restoreClipboard": true,
  "stripTrailingPunct": false,
  "theme": "auto"
}
```

`hotkey` 是逻辑键名数组，`Super` 就是 Win 键。`injectMethod` 为 `type` 时，纯 ASCII 直接键入，含中文自动回落到剪贴板粘贴——虚拟键盘没有中文键码，这是协议边界。

## 命令行

```bash
mimo-asr --config                    # 看配置（key 打码）
mimo-asr --ping                      # 测连接
mimo-asr --transcribe a.wav          # 识别任意 wav
mimo-asr --transcribe a.wav --json   # 结构化输出
```

## 接口约定

- `POST {baseUrl}/chat/completions`，OpenAI 兼容
- 模型仅 `mimo-v2.5-asr`
- 音频**只支持 wav / mp3**，Base64 后上限 10 MB（16k 单声道约 3.5 分钟）
- `asr_options.language`：`auto` / `zh` / `en`
- `stream: true` 是**结果流式返回**，音频本身一次性上传

## 已知限制

- 仅 Linux
- 中文走剪贴板 + `Ctrl+V`，部分终端需要在设置里切成 `Ctrl+Shift+V`
- 单次录音上限约 3.5 分钟
- XWayland 下 `wl-copy` 会继承主进程的 fd，属于已知无害的瑕疵

## 结构

```
src/main.js        主进程：窗口、托盘、状态机、IPC
src/recorder.js    常驻采集 + 环形缓冲
src/evdev.js       全局热键（直接读 /dev/input）
src/asr.js         MiMo 流式识别
src/inject.js      文字注入
src/ui/            面板与悬浮窗
bin/mimo-asr.js    命令行入口
docs/              实现说明与截图
```

## License

MIT
