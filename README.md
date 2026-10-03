# Drifting

**A home for your stories. · 写作之心**

[English](#english) | [简体中文](#简体中文)

## English

Drifting is a local-first workspace for long-form writing. It brings your
manuscript, loose ideas, characters, worldbuilding, storylines, and AI assistance
into one project. Move between drafting and organizing, from a fragment that
hasn't found its place to a book that needs another careful pass.

**This project is still in early development.** I am exploring its interactions,
architecture, and features. The current version is not yet mature and will
continue to change. The source is maintained publicly for reading, building,
and discussion.

### Write the manuscript. Keep the loose ideas.

Work chapter by chapter or read the whole book together. Navigate an outline of
acts, chapters, scenes, beats, and notes. Keep fragments in Ideas until
they find a place, without having to assign them to a chapter or storyline.

Comments, to-dos, images, PDFs, and other reference material stay within the
project, close to your writing.

### See the shape of your story

Organize characters, places, objects, and worldbuilding into elements and
categories, then connect them to the manuscript and to one another. Storylines,
the story graph, timeline, and plot grid offer different views for arranging
chapters, tracing relationships, and planning what happens next.

Track changes to an element alongside their supporting passages to look back
at how a character or setting has developed.

### Work with AI on your terms

- **Copilot** suggests new elements and changes to existing ones as you write.
  You decide which suggestions to accept.
- **General Agent** can read and search your project, discuss the writing, and
  organize story material. With write permission, it can also edit prose and
  project content. The editor provides change review; AI judgments still need
  the author's attention.
- **External agents / MCP** let you bring familiar tools into the same project.
  The Mac client can configure connections for Codex, Claude Code, and
  Antigravity, with separate access permissions. Keep Drifting and the
  authorized project open while using them.

AI is optional. Built-in AI features require a configured model provider;
external MCP access does not require a model configured inside Drifting.
See the [current Agent capabilities](docs/agent-runtime/acceptance/CURRENT_STATUS.md)
and [external agent setup](docs/agent-runtime/local-mcp.md).

### Write locally. Sync and export when needed.

Your manuscript and project data live on your device, so you can keep writing
offline. Default source builds do not require a Drifting account. Builds
configured for the official Hosted service can sign in and sync; that service
is operated separately and its server is not included in this repository.
Sync is still undergoing validation, does not guarantee conflict-free device
switching, and does not provide end-to-end encryption. Google Drive sync is
currently suspended.

Copy or save a document or whole-book manuscript as Markdown, or export a
Markdown ZIP containing project structure and relationships. The ZIP is a
readable copy for migration, not a complete backup; original image and PDF files
are not included.

[Sync details](docs/hosted-sync/README.md) · [Manuscript sharing](docs/editor/markdown-sharing.md) ·
[Project export](docs/local-data-export.md)

### Current stage

Tauri is the active client. The desktop Alpha release target is Apple Silicon
Mac; mobile work is still in development and validation, and other platforms
are not yet supported releases. This introduction describes capabilities in
the current source, not the availability of a mature installer.

To try it, read the [known issues](KNOWN_ISSUES.md), start with a source build,
and keep independent copies of important manuscripts.

### Development

Drifting uses Tauri, Rust, React, and TypeScript. The default build runs locally
without a Drifting account; this repository does not include the hosted
service's server implementation.

Before starting, read the [contributor quick start](docs/contributor-quick-start.md)
for dependencies and platform setup. Running locally on macOS requires your own
development signing certificate.

```bash
pnpm install --frozen-lockfile
pnpm dev:check
pnpm dev
```

- [Documentation index](docs/README.md)
- [Known issues](KNOWN_ISSUES.md)
- [Contributing](CONTRIBUTING.md)

### Licensing and project policy

Most project-owned source is licensed under [AGPL-3.0-or-later](LICENSE).
`packages/prose-metrics` is separately licensed under
[Apache-2.0](packages/prose-metrics/LICENSE). Third-party code and assets retain
their respective licenses.

[Third-party notices](THIRD_PARTY_NOTICES.md) · [Trademarks](TRADEMARKS.md) ·
[Privacy boundary](PRIVACY.md) · [Security reporting](SECURITY.md) ·
[Source history](docs/public-history.md)

## 简体中文
Drifting 是一个本地优先的长篇写作工作台，把正文、构想、人物与世界设定、
故事线和 AI 协作放在同一个项目里。从一段尚未成形的片段，到需要反复推敲的整本书，
你可以在写作与整理之间来回切换，让材料逐渐长成故事。

**项目仍在早期开发中。** 我正在持续探索它的交互、架构和功能；当前版本尚不成熟，
界面和功能会继续调整。源码公开维护，欢迎阅读、构建和交流。

### 写下正文，也容得下未成形的想法

按章节写作，也可以连起来阅读整本书。大纲保留幕、章、场景、节拍、笔记的层次，
在长文中定位和回看。暂时不知道放在哪里的片段，可以先写进漂流区，
不必急着为它安排章节或故事线。

批注、待办和图片、PDF 等参考资料留在项目中，写作时随手查阅。

### 看见故事的结构

用要素和分类整理人物、地点、物品与世界设定，把它们与正文和彼此连接起来。
故事线、故事图谱、时间线与情节规划表提供不同的视角，帮助你安排章节、梳理关系、
检查故事的走向。

设定也可以随情节变化：记录要素的变化及其原文依据，回看人物如何走到现在。

### 按你的意图，与 AI 协作

- **Copilot** 在写作中提出新要素和设定变化的建议，由你决定是否采纳。
- **General Agent** 可以阅读和检索项目、讨论文本、整理设定，也可以在获得写入权限后
  修改正文与项目内容。编辑器提供变更审阅；AI 的判断仍需要作者核对。
- **外部 Agent / MCP** 让你使用熟悉的工具处理同一个项目。Mac 客户端支持为 Codex、
  Claude Code、Antigravity 配置连接，并分别选择访问权限。Drifting 与已授权的项目
  需要保持打开。

不启用 AI 也可以正常写作。内置 AI 功能需要配置模型服务；外部 MCP 接入不要求
在 Drifting 中配置模型。详见[Agent 当前能力](docs/agent-runtime/acceptance/CURRENT_STATUS.md)
和[外部 Agent 接入](docs/agent-runtime/local-mcp.md)。

### 本地写作，按需同步与导出

正文和项目数据保存在本机，断网也能继续写。默认源码构建不需要 Drifting 账号。
配置了官方 Hosted 服务的构建可以登录并同步；服务端独立运营，不包含在此仓库中。
当前同步仍在持续验证，不能保证跨设备切换永远无冲突，也不提供端到端加密。
Google Drive 同步目前暂停。

可以将单篇或整本书的正文复制、保存为 Markdown，也可以导出包含项目结构与关系的
Markdown ZIP。它是便于阅读和迁移的副本，不是完整备份，不包含图片、PDF 的原始文件。

[同步说明](docs/hosted-sync/README.md) · [正文分享](docs/editor/markdown-sharing.md) ·
[项目导出](docs/local-data-export.md)

### 当前阶段

当前主客户端使用 Tauri。桌面 Alpha 的发布目标是 Apple Silicon Mac；
移动端仍在开发和验证中，其他平台尚未作为受支持的发行版提供。
这里的产品介绍描述当前源码中的能力，不代表已有成熟的安装包可下载。

如果你想尝试，建议先阅读[已知问题](KNOWN_ISSUES.md)，从源码构建开始，
并保留重要稿件的独立副本。

### 开发

项目使用 Tauri、Rust、React 和 TypeScript。默认构建在本地运行，不需要
Drifting 账号；此仓库不包含托管服务的服务端实现。

开始前请阅读[开发环境配置](docs/contributor-quick-start.md)，安装依赖并完成
目标平台的准备工作。macOS 本地运行需要自己的开发签名证书。

```bash
pnpm install --frozen-lockfile
pnpm dev:check
pnpm dev
```

- [文档索引](docs/README.md)
- [已知问题](KNOWN_ISSUES.md)
- [参与开发](CONTRIBUTING.md)

### 许可与项目政策

项目主体采用 [AGPL-3.0-or-later](LICENSE)；`packages/prose-metrics` 单独采用
[Apache-2.0](packages/prose-metrics/LICENSE)。第三方代码和素材保留各自的许可证。

[第三方声明](THIRD_PARTY_NOTICES.md) · [商标说明](TRADEMARKS.md) ·
[隐私边界](PRIVACY.md) · [安全反馈](SECURITY.md) · [源码历史说明](docs/public-history.md)
