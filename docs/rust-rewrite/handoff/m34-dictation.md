# M34 语音口述（未验收，可以放最后）

先读 [README.md](README.md) 的共用约定和 [m31-agent-panel.md](m31-agent-panel.md)。

## 要做的

在帮手的输入框里口述：
- 录音分段送去识别，文字进输入框；
- 识别时带上书里的专名（要素名、别名），减少错字。

旧版用的是 DashScope 的 `qwen3-asr-flash`，Key 在钥匙串里，名字是 `byok.dashscope`。录音按 4 分钟滚动分段。

## 旧版

- `src/renderer/lib/speech/*`（841 行）：识别客户端、语境包、分段录音
- `src/renderer/features/agent/VoiceDictationButton.tsx`

## 新版放哪、接哪

- 放在 `dr-view-agent` 里，或者单开一个小 crate。
- 录音要用系统的麦克风接口，跨 macOS 和 Windows。选一个许可宽松的 crate，过许可门禁。第一次用麦克风时系统会弹授权，这个要写进文档，给作者手测。
- 钥匙串用 F7 的 `dr_platform::secrets`，沿用旧版的键名。

## 完成标准

- 识别客户端对着本机假服务测：分段、专名语境、出错重试。
- 录音这一段没法自动测，写清楚手测步骤，留给作者。
