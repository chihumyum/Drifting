# Known issues · 已知问题

Drifting is in early development. These are the limits you are most likely to
run into. Report anything else at [GitHub Issues](https://github.com/chihumyum/Drifting/issues)
or `support@drifting.cc`; never attach manuscript text, databases, API keys or tokens.

Drifting 仍在早期开发。下面是最可能遇到的限制。其他问题请到
[GitHub Issues](https://github.com/chihumyum/Drifting/issues) 或发邮件到
`support@drifting.cc`；请不要附带稿件内容、数据库、API Key 或令牌。

## Platforms · 平台

- Only macOS 13 or later on Apple Silicon. Intel Macs, Windows, Linux and
  mobile are not supported yet.
- 只支持 Apple Silicon 上的 macOS 13 及以上；Intel Mac、Windows、Linux 和移动端暂不支持。
- The interface is in English and Simplified Chinese.
- 界面语言只有英文和简体中文。

## Export · 导出

- Manuscripts can be exported as Markdown only. EPUB, PDF and Word export are
  not available yet.
- 成稿目前只能导出 Markdown，还不能导出 EPUB、PDF 和 Word。
- The Markdown ZIP and the project Markdown folder are readable copies, not
  backups: they leave out images and PDFs and cannot be imported back. Use a
  `.drifting` library backup (Settings → Sync & Data) for a restorable copy.
- Markdown ZIP 和项目的 Markdown 文件夹是可读副本，不是备份：不含图片和 PDF，也不能导回。
  需要能恢复的副本时，请在「设置 → 同步与数据」导出 `.drifting` 资料库备份。
- A `.drifting` backup can only be made or restored while the library is not
  connected to sync.
- 资料库连着同步时，不能导出或恢复 `.drifting` 备份。

## Agent

- The Agent writes its edits straight into your project. They are marked in the
  text and can be undone from history snapshots, but read what it changed.
- Agent 的修改会直接写进项目；改动会在正文里标出，也能从历史快照撤回，但请看一下它改了什么。
- Requests go to the model provider you choose and follow that provider's
  billing, retention and data terms.
- 请求直接发给你选择的模型服务商，计费、留存和数据条款以服务商为准。
- The ChatGPT subscription route uses OpenAI's Codex device sign-in. OpenAI does
  not offer it to third-party apps officially, so it may stop working without
  notice, and it counts against your ChatGPT plan.
- ChatGPT 订阅登录借用 OpenAI 的 Codex 设备登录，OpenAI 并未正式向第三方开放，可能随时失效，
  用量计入你的 ChatGPT 套餐。

## Sync and sharing · 同步与分享

- Synced projects are not end-to-end encrypted; the Hosted operator can read them.
- 同步内容没有端到端加密，Hosted 运营方在技术上可以读取。
- Let sync finish before you switch to another Mac.
- 换到另一台 Mac 写作前，请等同步完成。
- Anyone with a share link can read what it shares.
- 拿到分享链接的人都能读到分享的内容。
