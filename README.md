# Drifting

**A home for your stories. · 写作之心**

[English](#english) | [简体中文](#简体中文)

## English

Drifting is an open-source, local-first workspace for long-form fiction. The
manuscript, loose ideas, characters and world, storylines and research live in
one project, with an Agent that can read, search and work on all of it.

**Early development.** Drifting is used daily by its author and changes often.
Keep independent copies of manuscripts that matter, and read the
[known issues](KNOWN_ISSUES.md).

### Download

macOS 13 or later on Apple Silicon. Download the `.dmg` from
[GitHub Releases](https://github.com/chihumyum/Drifting/releases/latest).
The app tells you when a new version is out; you choose when to install it.
The first launch opens a sample project you can explore or delete.

### Write

- Write chapter by chapter, or read and edit the whole book in one view.
- Acts sit on the timeline; scenes, beats and notes are headings inside a
  chapter, listed in the outline beside the text.
- **Ideas** hold fragments that have not found a place yet. Turn one into a
  chapter or an element when it is ready.
- Comments and TODOs are anchored to the text. A finished chapter can be marked
  done, or handed to the Agent for a review pass.
- History snapshots, word counts, daily goals and streaks.

### Plan

- **Elements** for characters, places, objects and lore, grouped into
  categories. **Patches** record how an element changes, next to the passage
  that changes it.
- Typed **relations** between elements, chapters and storylines.
- **Storylines**, a timeline in book order or narrative time, and a plot grid for
  each chapter.
- Full-window views: **Element overview**, **Story graph**, and **TODO &
  Materials**.
- **Materials**: notes, images and PDFs in folders, each opening as a tab.
  Comment on a region of an image or PDF.
- **Project Home** gathers progress, quick creation and a daily check-in.

### Work with the Agent

- Bring your own key for DeepSeek, Anthropic or OpenAI, or sign in with a
  ChatGPT subscription (experimental). Writing never requires AI.
- The Agent reads, searches and edits your project: prose, elements, relations,
  storylines, materials, TODOs. Its edits are marked in the text and can be
  undone from history.
- Project Memory keeps the preferences and rules you give it. TODOs, chapter
  reviews and check-in cards can run as background Agent sessions.
- When you come back after a break, it can file what you wrote into elements,
  patches and relations. It never edits prose on its own.
- **External agents**: Codex, Claude Code and Antigravity can connect to one
  project through MCP, read-only by default. See
  [external agent setup](docs/agent-runtime/local-mcp.md).

### Your data

- Everything is stored on your Mac and works offline. No account needed.
- Each project keeps a Markdown folder. Chapters and ideas edited there in any
  editor merge back into Drifting.
- Export the book, or chosen chapters, as EPUB, PDF or Word.
- Copy or save any document or the whole book as Markdown; export every project
  as a Markdown ZIP; back up the whole library as a restorable `.drifting` file.
- Import `.md`, `.txt` and `.docx`.
- Deleted projects stay in Recently Deleted for 30 days.

With an account you can sync between Macs and share a chapter as a web page
that readers can comment on. Synced projects are not end-to-end encrypted. See
the [privacy policy](https://drifting.cc/privacy) and
[terms](https://drifting.cc/terms).

### Help

[Support](https://drifting.cc/support) · [Known issues](KNOWN_ISSUES.md) ·
[Report a bug](https://github.com/chihumyum/Drifting/issues) ·
[Security](SECURITY.md)

### Build from source

Drifting is built with Tauri, Rust, React and TypeScript. Source builds run
locally without an account; the Hosted sync service is operated separately and
is not part of this repository. Running on macOS needs Xcode and your own Apple
Development certificate; see the [contributor quick start](docs/contributor-quick-start.md).

```bash
pnpm install --frozen-lockfile
pnpm dev:check
pnpm dev
```

[Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) ·
[Releasing](docs/releasing.md)

### License

Project source is [AGPL-3.0-or-later](LICENSE); `packages/prose-metrics` is
[Apache-2.0](packages/prose-metrics/LICENSE). Third-party code and assets keep
their own licenses.

[Third-party notices](THIRD_PARTY_NOTICES.md) · [Trademarks](TRADEMARKS.md) ·
[Client privacy boundary](PRIVACY.md) · [Source history](docs/public-history.md)

## 简体中文

Drifting 是一个开源、本地优先的长篇小说写作工作台。正文、零散的构想、人物与世界设定、
故事线和资料都在同一个项目里，还有一个能读、能查、能动手整理这一切的 Agent。

**仍在早期开发。** 作者每天都在用它写作，它也在频繁变化。重要的稿件请另外保留副本，
并先看一下[已知问题](KNOWN_ISSUES.md)。

### 下载

支持 Apple Silicon 上的 macOS 13 及以上。在
[GitHub Releases](https://github.com/chihumyum/Drifting/releases/latest) 下载 `.dmg`。
有新版本时 App 会提示，何时安装由你决定。第一次打开会带一个示例作品，可以随便看，也可以删掉。

### 写作

- 按章写，也可以在一个视图里通读、修改整本书。
- 幕在时间线上设置；场景、节拍、笔记是章节里的标题，列在正文旁的大纲里。
- **构想**收留还没有位置的片段，成熟后可以转成章节或要素。
- 批注和 TODO 锚定在正文上。写完的章节可以标记完成，也可以交给 Agent 做一轮审读。
- 历史快照、字数统计、每日目标与连续写作天数。

### 规划

- 用**要素**整理人物、地点、物品和设定，并归入分类；用**补丁**记录要素随情节发生的变化，
  紧挨着引起变化的那段原文。
- 要素、章节、故事线之间可以建立带类型的**关联**。
- **故事线**、按书序或叙事时间排列的时间线，以及每章一张情节表。
- 全窗口视图：**要素全景**、**叙事结构图**、**TODO & 素材库**。
- **素材**：笔记、图片和 PDF，可以分文件夹，各自在标签页里打开；可以在图片或 PDF 的某个区域上批注。
- **作品主页**汇总进度、快速新建和每日签到。

### 与 Agent 协作

- 可以用自己的 DeepSeek、Anthropic、OpenAI 密钥，也可以登录 ChatGPT 订阅（实验性）。
  不用 AI 也能正常写作。
- Agent 能读、搜索和修改你的项目：正文、要素、关联、故事线、素材、TODO。它的改动会在正文里标出，
  可以从历史快照撤回。
- 项目记忆保存你交代给它的偏好和规则。TODO、章末审读和签到卡片都可以交给后台 Agent 处理。
- 你离开一阵再回来时，它可以把上次写的内容整理进要素、补丁和关联；它不会自行改动正文。
- **外部 Agent**：Codex、Claude Code、Antigravity 可以通过 MCP 连接到某一个项目，默认只读。
  见[外部 Agent 接入](docs/agent-runtime/local-mcp.md)。

### 你的数据

- 所有内容保存在你的 Mac 上，断网也能写，不需要账号。
- 每个项目都有一个 Markdown 文件夹；在任何编辑器里改过的章节和构想会合并回 Drifting。
- 整本书或选定章节可以导出为 EPUB、PDF、Word 成稿。
- 单篇或整本书可以复制、保存为 Markdown；所有项目可以导出为 Markdown ZIP；整个资料库可以备份成
  能恢复的 `.drifting` 文件。
- 可以导入 `.md`、`.txt`、`.docx`。
- 删除的项目会在「最近删除」里保留 30 天。

注册账号后，可以在多台 Mac 之间同步，并把章节分享成网页给读者阅读和评论。同步内容没有端到端加密。
详见[隐私政策](https://drifting.cc/privacy)和[服务条款](https://drifting.cc/terms)。

### 帮助

[支持](https://drifting.cc/support) · [已知问题](KNOWN_ISSUES.md) ·
[报告问题](https://github.com/chihumyum/Drifting/issues) · [安全问题](SECURITY.md)

### 从源码构建

Drifting 使用 Tauri、Rust、React 和 TypeScript。源码构建在本地运行，不需要账号；Hosted
同步服务另行运营，不在此仓库中。在 macOS 上运行需要 Xcode 和你自己的 Apple Development 证书，
见[开发环境配置](docs/contributor-quick-start.md)。

```bash
pnpm install --frozen-lockfile
pnpm dev:check
pnpm dev
```

[文档索引](docs/README.md) · [参与开发](CONTRIBUTING.md) · [发布流程](docs/releasing.md)

### 许可

项目源码采用 [AGPL-3.0-or-later](LICENSE)；`packages/prose-metrics` 采用
[Apache-2.0](packages/prose-metrics/LICENSE)。第三方代码和素材保留各自的许可证。

[第三方声明](THIRD_PARTY_NOTICES.md) · [商标说明](TRADEMARKS.md) ·
[客户端隐私边界](PRIVACY.md) · [源码历史说明](docs/public-history.md)
