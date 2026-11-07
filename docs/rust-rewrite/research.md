# 调研结论（2026-11-07）

本文是六路调研的摘要：三路盘点仓库现状，三路调研 GPUI、Loro 和 Rust 生态。

- 版本号、日期和许可证查自 crates.io，或是当天读到的上游源码。
- 「推断」是调研时的判断，没有上游来源。

## 仓库现状

| 部分 | 规模 | 要点 |
| --- | --- | --- |
| TS 合计 | 约 43 万行，其中测试约 13 万行 | 测试文件 655 个，约 3900 个用例 |
| 界面层（不含帮手） | views 8k、components 31k、features 29k、外壳 17k、store 8k、usecase 9k、services 13k | CSS 约 3.25 万行，全部在 `src/styles` |
| 帮手 | `src/renderer/lib/agent` 约 7.2 万行（不含测试），界面和存储另有约 2.4 万行 | 97 个工具；只实现了 `local` 传输，`sidecar` 和 `remote` 是保留的接缝 |
| 同步与领域 | `src/renderer/sync` 约 3.5 万行，`sqlite-repo` 1.5 万行，`domain` 4.7k 行 | 所有 SQL 都写在 TS 里；Rust 只负责连接、迁移、文件和网络 |
| 数据库 | 100 张表，19 个迁移，144 个触发器 | 28 张表会同步，72 张不同步 |
| Rust | `drifting-core` 约 2 万行，`drifting-document` 1.2 万行，`drifting-prose` 1.1k 行，`src-tauri` 2.65 万行 | `drifting-document` 和 `drifting-prose` 整个建在 yrs 上 |
| Tauri 命令 | 132 个 | 插件：deep-link、dialog、fs、opener、single-instance、updater |

### 能直接复用的 Rust

这些代码不依赖 CRDT，搬过去改改就能用：

- `crates/drifting-core`：
  - `database.rs`：迁移器、安全快照、影子库迁移；
  - `asset_store.rs`、`library_backup.rs`、`file_io.rs`、`archive.rs`。
- `src-tauri/src`：
  - `manuscript_export/*`：约 4.8k 行，PDF 排版用 krilla + rustybuzz + unicode-linebreak + fontdb；
  - `image_pipeline.rs` 和各平台的图片解码器；
  - `mcp_server.rs`、`mcp_stdio.rs`、`mcp_http.rs`；
  - `openai_responses.rs`、`codex_oauth.rs`、`codex_models.rs`、`byok_models.rs`、`codex_images.rs`；
  - `hosted_sync.rs`、`sync_object_store.rs`、`sync_asset_store.rs`；
  - `markdown_projection.rs`、`library_registry.rs`、`secure_storage*`。

### 新版不留的

- `crates/drifting-document`、`crates/drifting-prose`：建在 yrs 上。
- `crates/drifting-core/src/workspace/*`：约 1 万行，是已退役 Apple 前端的后端，Tauri 从没调用，也落后于素材夹和写作日，**不当规则参考**（见 [simplifications.md](simplifications.md)）。

## GPUI

### 分发与稳定性

- **crates.io**：上面的 `gpui` 停在 0.2.2，发布于 2025-10-22。Zed `main` 已经把框架拆成 `gpui`、`gpui_platform`、`gpui_macos`、`gpui_windows`、`gpui_linux`、`gpui_wgpu`、`gpui_ios` 等，这些都没发到 crates.io（`publish = false`）。
- **第三方怎么用**：两种做法。
  - 钉住 Zed 仓库的 git 版本；
  - 用 Longbridge 每周发的快照 `gpui-pre`。0.3.11 发布于 2026-11-02，对应 zed@f816e1f。gpui-component 0.9.0 用 `=0.3.11` 精确钉住了它。
- **混用有坑**：把不同来源的 GPUI 混在一起，能编译通过，但会报 trait 不匹配（E0277）。
- **稳定性**：
  - README 写明 1.0 之前「版本之间经常有破坏性改动」；
  - `crates/gpui` 每月有 45–57 个提交；
  - 2025-12，Zed 关掉了自定义着色器的 PR（#42905），理由是没有 Zed 的用例就无法验证。
- **许可证**：`gpui`、各平台 crate 和 `sum_tree` 都是 Apache-2.0。Zed 的 `editor`、`text`、`rope`、`ui`、`theme`、`auto_update` 是 GPL-3.0。

### 平台

| 平台 | 状态 |
| --- | --- |
| macOS | 用 Metal 渲染，CoreText 处理文字 |
| Windows | 用 DirectX 11 + DirectComposition 渲染，DirectWrite 处理文字。Zed 的 Windows 版 2025-10-15 转正 |
| Linux | wgpu 渲染，cosmic-text 处理文字；支持 Wayland 和 X11 |
| iOS | 实验性的 UIKit 后端（#63068，2026-10-14） |
| Android | 没有官方后端 |

### 绘制能力

**有的：**

- 圆角、边框（实线和虚线）、带模糊半径的投影和内阴影；
- 路径（基于 lyon）；
- SVG，但只能单色着色；
- 图片，包括 GIF 和 WebP 动图；
- 动画：时长、缓动、重复、弹簧。

**没有的：**

- **单个元素的背景模糊**。只有整个窗口的背景模糊（macOS 是 NSVisualEffectView，Windows 是 Mica）。
- **公开的自定义着色器接口**。
- **`div` 的变形**。只有 SVG 和精灵图能做变形。
- **整组透明**。`opacity` 是乘到每个图元上的，重叠的子元素会互相透出来。
- **多色渐变**。线性渐变只支持两个色标。

### 文字

- **API**：
  - `shape_line` 处理单行，遇到 `\n` 会 panic；
  - `shape_text` 处理多行，可以换行；
  - `TextRun` 包含长度（按 UTF-8 字节）、字体、颜色、背景、下划线、删除线。**一行只能有一个字号**，没有字距和基线偏移。
- **断行**：Zed `main` 从 2026-10-29（#64624）开始，换行用 `icu_segmenter` 的 UAX #14，中文标点禁则有基本保证。**钉住的 v1.27.0 不含这个改动**（P0-B 实测「，」「。」会落到行首），新版由编辑器自己断行，见 [P0-B 结论](spikes/p0-b-editor.md)。不支持两端对齐、注音和竖排。
- **Zed 编辑器的做法**：DisplayMap 一层层叠起来（Inlay → Fold → Tab → Wrap → Block），每层是一棵 SumTree。WrapMap 在后台重新换行，最多同步等 5 ms。这套设计假定行高统一、只有一种编辑器字体，**不能直接拿来做比例字体的富文本**。
- **可用的积木**：
  - `list()` 支持可变高度的虚拟化（`splice`、`remeasure`、`scroll_to_reveal_item`）；
  - `LineWrapper` 可以在后台线程估算换行。
- **推断**：标题、段距、行内标记都好做。只有同一行里出现多种字号时，才要自己写行排版器。

### 输入法

- **接口**：`EntityInputHandler`。它的方法包括 `text_for_range`、`replace_and_mark_text_in_range`、`bounds_for_range`（用来摆候选窗）等，范围一律按 UTF-16 计。
- **各平台的实现**：
  - macOS 实现了完整的 `NSTextInputClient`；
  - Windows 用 IMM32，不用 TSF；
  - Linux 在 Wayland 上用 text-input-v3，在 X11 上用 XIM。
- **已知问题**：
  - macOS 上，GPUI 只在组字中，或判断当前是非 ASCII 输入法时，才先把键交给输入法。微信、搜狗、百度和系统拼音会骗过这个判断。
  - 修复 PR #63405 没有合并就关了；总议题 #59882「中文输入法时灵时不灵」在 2026-11-06 以不修关闭。
  - 失焦时，残留的组字不会被清掉。
- **推断**：正文编辑器里不绑定单个可打印键，失焦时自己清掉组字，并测遍主流输入法，大部分风险就能避开。

### 应用基础设施

- **窗口与系统**：
  - 多窗口；自定义标题栏和红绿灯位置；应用菜单和 Dock 菜单；
  - 最近文档、`on_open_urls` 和 `register_url_scheme`（Windows 上未实现）；
  - 文件对话框、系统通知，以及钥匙串和 Windows 凭据管理器。
- **并发与状态**：前台和后台执行器；状态模型是 `Entity<T>` 加 `Context<T>`；布局用 Taffy（flex 和 grid）。
- **测试**：
  - `TestAppContext` 的调度是确定性的，可以模拟键盘、鼠标和对话框；
  - `HeadlessAppContext` 带真实的文字系统，可以截图；
  - `VisualTestContext` 在 macOS 上做离屏截图对比。
  - 没有模拟输入法组字的工具。
- **无障碍**：AccessKit 在 2026-05-27 合入（#56065），还很新。自定义编辑器的读屏支持要自己做。
- **控件**：
  - GPUI 内置 `div`、`uniform_list`、`list`、`img`、`svg`、`canvas`、`anchored`、`deferred`，以及 `StyledText` / `InteractiveText`。
  - gpui-component（Apache-2.0）有 Dock、Tabs、Tree、虚拟列表、DataTable、Menu、Popover、Input、Settings 等，每周都发版。

### 性能与打包

- **帧节奏**：2026-10 重做过。省电模式下约 30 fps，过热时约 60 fps，都可以配置。
- **推断**：这块近期改动多，要盯着。
- **重绘开销**：变脏的视图会把整个子树重新渲染、重新布局。`.cached(style)` 可以跳过，但要求尺寸确定。
- **Zed 的打包**：
  - macOS：fork 版 cargo-bundle → `codesign` → `hdiutil` → `notarytool` → `stapler`；
  - Windows：Inno Setup，用 Azure Artifact Signing 签名；
  - 自动更新的代码是 GPL，而且绑死在 zed.dev 的接口上，只能当参考。

### 不采用的建议

GPUI 调研里建议正文数据用 yrs。作者已经定了用 Loro，所以这一条不采用。

## Loro

### 版本与稳定性

- Rust 版 `loro` 当前是 1.17.1，发布于 2026-10-22，大约每 2–6 周发一个小版本。
- `main` 上已经有还没发布的零拷贝快照导入（#1218），以及对等方多时的导入提速（#1222、#1244）。
- **数据格式**：从 1.0 起承诺不再有破坏性改动。新版本创建的容器，旧版本会显示成 `LoroUnknown`。
- **Rust 接口**：比数据格式稳定性差。1.17.0 改了好几处返回类型和错误枚举。
- **许可证**：MIT。

### 容器

**LoroText：**

- 位置默认按 Unicode 标量计，也有 `*_utf8` 和 `*_utf16` 两套变体，换算用 `convert_pos`。
- 富文本：`mark` / `unmark`、`to_delta` / `apply_delta`，格式是 Quill 式的 delta。**插入的内容只能是字符串，不支持嵌入对象。**
- 每个标记键的扩展方式（`ExpandType`）由 `config_text_style` 设定：
  - 加粗、斜体、下划线默认是 After；
  - 链接、高亮、批注、代码默认是 None。
- 带后缀的键（`comment:<id>`）共用前缀的配置，所以重叠的批注可以各用一个键。
- `update()` 做 Myers 差分。文档说正文超过 5 万字时可能很慢。

**其他容器：**

- `LoroList`；
- `LoroMovableList`：支持移动和设值，以最后写入为准；
- `LoroMap`：用 `ensure_mergeable_*`，两边懒创建同一个键时会得到同一个子容器；
- `LoroTree`：可以移动的树（Kleppmann 算法），兄弟之间用分数索引排序，每个节点有一个 meta map；
- `LoroCounter`。

### 光标

- `get_cursor(pos, Side)` 在某个字符的操作 ID 上锚定，`get_cursor_pos` 查询当前位置。
- 被锚的字符删掉以后，Loro 会回放历史来找位置，并返回一个新的光标，要把它存下来。
- 历史被裁掉以后，会报 `HistoryCleared`。

### 事件、版本与事务

- **事件**：
  - 有 `subscribe`、`subscribe_local_update`（每次本地提交都给出编码好的更新）、`subscribe_pre_commit`；
  - 事件在提交、导入、检出时同步触发；
  - 原生 Rust 里，事件的文本位置按 Unicode 标量计。
- **事务**：
  - 不是 ACID 的。每个文档只有一个隐式的自动提交事务，而且**跨线程共享**；
  - `set_next_commit_origin` 只在本地生效，撤销管理器可以按它来过滤。
- **版本**：
  - `checkout` 之后文档进入只读的分离状态；`fork` / `fork_at` 做深拷贝；
  - `revert_to` 生成新的操作来恢复旧状态，所以会同步，历史也保留；
  - `diff` / `apply_diff`。
- **时间戳**默认不记，要每次加载后调用 `set_record_timestamp(true)`。

### 撤销

- **规则**：
  - 只撤销绑定的那个对等方自己的操作，并按 OT 的方式让它们越过远端的操作；
  - 可以按来源前缀排除提交，Agent 的写入就这样排除；
  - Rust 版的合并间隔默认是 0；
  - 可以在压栈和出栈时附带光标，用来恢复选区。
- **还没修的问题**：
  - 撤销会覆盖另一方的格式（#1229）；
  - 远端编辑之后，恢复的选区会变大（#1100）；
  - 撤销后文字顺序会乱（#1228、#1245）；
  - 树的撤销还有几个问题。

### 存储与同步

- **导出模式**：快照、增量更新、浅快照、只有状态、指定范围的更新。1.17 新增了 `export_pending_updates`。
- **推荐的存储方式**：频繁追加更新，定期写一份完整快照；只有在更新已经被持久地覆盖之后，才删掉旧更新。
- **浅快照**：
  - 2026-11-06 的内存分析发现，在几个对等方交替写入的文档里，浅快照几乎裁不掉什么。作者加 Agent 正是这种情形；
  - 还有一个未修问题：远端更新依赖已被裁掉的历史时，导入会 panic（#1068）。
- **同步协议**（`loro-protocol` v1）：在一条 WebSocket 上复用多个房间，消息上限 256 KiB。Rust 的客户端和服务端 crate 都还是 0.1 的骨架。
- **Loro 作者自己的产品怎么做同步**：每个文档一条只追加的「哑」日志，客户端上传快照，跨文档不做事务。

### 性能与内存

- **基准**：
  - 26 万次操作、10.5 万字：应用 88 ms，解码 0.19 ms，编码 0.42 ms；
  - 1050 万字、2600 万次操作：快照 23.4 MB，解析 17.9 ms。
- **单个文档的固定开销很小**：空文档约 7 KB；到 5000 个文档都是线性增长。
- **会让内存变大的操作**：
  - 冷文档里只要导入一次很小的更新，就会把整段历史展开进内存（28 MB 的文档涨了 28.8 MB）；
  - 往回检出一步，又涨了 56 MB；
  - 这些内存不释放，只能关掉文档重开。
- **已经修好的**：对等方 ID 越多导入越慢（#1243），修在 `main` 上，1.17.1 里还没有。
- **推断**：每章一个文档、每本书一个书目文档，可以把检出、差分和导入展开的范围限制在单章之内。

### 线程与对等方 ID

- `LoroDoc` 是 `Send + Sync` 的。`UndoManager` 需要 `&mut self`。没有异步接口。
- 对等方 ID 是 `u64`，默认每个文档实例随机生成。如果文档状态和 ID 一起持久化，并且在导入远端更新之前加锁载入，就可以复用。

### 绑定与导入工具

- **已有的绑定**：`loro-prosemirror`（每个块一个 LoroText）、`loro-codemirror`、`lexical-loro`，**没有 Rust 原生或 GPUI 的绑定**。
- **导入工具**：没有 Yjs 转 Loro 的工具。`loro-migrate` 只处理 1.0 之前的 Loro。

## Rust 生态选型

| 需求 | 建议 | 备注 |
| --- | --- | --- |
| 打包与签名 | cargo-packager 0.11.8（DMG、NSIS，能写深链接协议），或者照 Zed 写脚本 | cargo-bundle 0.12 不做公证；cargo-dist 不出 `.app` |
| 自动更新 | cargo-packager-updater 0.2.3（minisign，和现在的 Tauri 更新器格式一样），或者自己写并用 `minisign-verify` 0.3.0 验签 | Zed 的更新器不做应用层验签，而且是 GPL |
| 深链接与单实例 | macOS 用 GPUI 的 `on_open_urls`；Windows 由安装器写注册表，再用互斥量加命名管道（`interprocess` 2.4.7） | GPUI 在 Windows 上没实现 `register_url_scheme` |
| 凭据 | GPUI 自带的接口；需要时用 `keyring` 4.2（已拆分成 core 和各平台的存储） | Windows 单条凭据上限约 2560 字节；要确认能读到旧版写的条目 |
| 文件对话框 | GPUI 的 `prompt_for_paths` | 一般不需要 rfd |
| 监听文件 | notify 8.2 + notify-debouncer-full 0.7 | 原子保存会表现成先写临时文件再改名，要按内容哈希过滤掉自己写入引起的回声 |
| 废纸篓 | trash 5.3 | — |
| 崩溃上报 | sentry 0.49.5 加 `minidump` 特性（已是官方），配合 sentry-tracing | CI 里要上传 dSYM / PDB 符号 |
| 多语言 | 保留 JSON 文案，在 `build.rs` 里把键展开成常量，运行时替换 `{{var}}`，复数规则用 `icu_plurals` 2.4 | 没有成熟的、兼容 i18next 的 crate；fluent 要改写全部文案；rust-i18n 不支持复数 |
| 断行与分词 | `icu_segmenter` 2.4（UAX #14 的严格档，中文日文按词典分词） | GPUI 已经在用它 |
| 搜索 | SQLite FTS5 trigram；1–2 个字的中文查询退回 LIKE | Tantivy 的索引不在 SQLite 里，会破坏「一个库就是一个文件」 |
| Markdown | comrak 0.59 或 pulldown-cmark 0.13 负责解析，序列化自己写成确定性的 | markdown-rs 没有序列化，而且从 2025-04 起没有更新 |
| 导出 | 原样复用旧版 `manuscript_export`：DOCX、EPUB 只用 zip 手写，PDF 用 krilla（架构审查后定，原先考虑的 docx-rs、epub-builder、typst 都不需要） | 中文字体要做子集化；思源和 Noto 字体是 OFL，可以嵌入 |
| 网络 | reqwest 0.13（默认 rustls）、tokio 1.54、tokio-tungstenite 0.30；SSE 用 `sse-stream` 0.3 或 `eventsource-stream` | oauth2 5.0 和 cargo-packager-updater 还在 reqwest 0.12 上：给 oauth2 接一个基于 0.13 的自定义 HTTP 客户端 |
| Google 登录 | 系统浏览器加 PKCE | Google 规定桌面应用用本机回环地址做回调。现在的做法是由服务端处理 Google、再回调 `drifting://`，可以沿用 |
| 大模型 | 自己写一层与模型无关的协议（M27）；各家接入用 reqwest 加 SSE 手写，或者基于 genai 0.7.3；OpenAI 可以用 async-openai 0.43（支持 Responses） | Anthropic 没有官方 Rust SDK；`anthropic_rust` 这个 crate 自称官方仓库，但那个地址是 404，不是官方的 |
| MCP | rmcp 3.9.0（官方，Apache-2.0）：服务端和客户端都有；传输支持 stdio、streamable HTTP，以及任意 `AsyncRead` / `AsyncWrite` | 现有的 Unix socket 和 Windows 回环方案都能接上 |
| 图片 | image 0.25（GPUI 已经在用），fast_image_resize 6.1 | — |
| PDF 预览 | hayro 0.9（纯 Rust）或 pdfium-render 0.9.5（要带 PDFium 二进制，而且不是线程安全的） | mupdf 是 AGPL：能用，但以后就没法改许可证了 |
| 2D 位图绘制 | tiny-skia（推断） | 用来画封面、热力图、砂笔纹理 |
| 口述 | 沿用 DashScope ASR；本地方案有 cpal + whisper-rs | macOS 26 的 SpeechAnalyzer 只有 Swift 接口 |
| SQLite | rusqlite 0.41；沿用现有迁移器的做法 | 别换成按 `user_version` 记迁移的库，那样会破坏「发布过的迁移不再修改」 |
| 分享阅读页 | axum 0.8 加 maud 0.27 或 askama 0.16，在服务端出 HTML | 以后需要实时评论时，再加一个 Leptos 0.8 的 island |
| 测试 | insta 1.49、proptest 1.12、criterion 0.8 | — |
| 平台胶水 | objc2 0.6 / objc2-* 0.3.2（跟 GPUI 用同一版）；windows 0.62（Zed 还在 0.62 上） | windows-rs 0.100 起拆成了多个 crate |

### 许可证

客户端是 AGPL-3.0-or-later。

- **可以直接用**：MIT、Apache-2.0、BSD、Zlib、0BSD、CC0、Unlicense、Unicode-3.0。
- **可以用，但要保留声明**：MPL-2.0（epub-builder、spellbook）。
- **可以合进来，但抄来的文件仍然是 GPL**：从 Zed 抄的 GPL-3.0 代码。
- **要特别处理的**：
  - 开源编辑器 `gpui-prose` 打算用 MIT 或 Apache-2.0，所以不能抄 Zed 的 GPL 代码进去；
  - `packages/prose-metrics` 的规则移到 Rust 后，那部分仍用 Apache-2.0。
- **工具**：用 cargo-deny 0.20 管住许可证白名单，用 cargo-about 0.9 生成第三方声明。

## 来源

### GPUI

- https://crates.io/crates/gpui
- https://crates.io/crates/gpui-pre
- https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md
- https://github.com/zed-industries/zed/blob/main/crates/gpui/src/text_system.rs
- https://github.com/zed-industries/zed/blob/main/crates/gpui/src/input.rs
- https://github.com/zed-industries/zed/blob/main/crates/gpui/src/elements/list.rs
- https://github.com/zed-industries/zed/blob/main/crates/editor/src/display_map/wrap_map.rs
- https://github.com/zed-industries/zed/pull/42905
- https://github.com/zed-industries/zed/pull/63405
- https://github.com/zed-industries/zed/issues/59882
- https://github.com/zed-industries/zed/pull/64624
- https://github.com/zed-industries/zed/pull/56065
- https://github.com/zed-industries/zed/pull/63068
- https://github.com/zed-industries/zed/blob/main/script/bundle-mac
- https://github.com/zed-industries/zed/blob/main/script/bundle-windows.ps1
- https://github.com/longbridge/gpui-component
- https://zed.dev/blog/zed-1-0
- https://zed.dev/blog/zed-for-windows-is-here

### Loro

- https://crates.io/crates/loro
- https://docs.rs/loro/1.17.1/loro/
- https://github.com/loro-dev/loro
- https://loro.dev/docs/tutorial/encoding
- https://loro.dev/docs/tutorial/cursor
- https://loro.dev/docs/advanced/undo
- https://loro.dev/docs/tutorial/persistence
- https://loro.dev/docs/concepts/transaction_model
- https://loro.dev/docs/concepts/peerid_management
- https://loro.dev/blog/loro-richtext
- https://loro.dev/blog/movable-tree
- https://loro.dev/blog/v1.0
- https://loro.dev/blog/crdt-is-not-enough
- https://github.com/loro-dev/loro/blob/main/context/memory-analysis.md
- https://github.com/loro-dev/protocol
- https://github.com/loro-dev/loro-prosemirror
- https://github.com/loro-dev/loro/issues/673
- https://github.com/loro-dev/loro/issues/1068
- https://github.com/loro-dev/loro/issues/1229
- https://github.com/loro-dev/loro/issues/1256

### 生态

- https://github.com/crabnebula-dev/cargo-packager
- https://docs.rs/cargo-packager-updater/latest/cargo_packager_updater/
- https://github.com/open-source-cooperative/keyring-rs
- https://docs.rs/sentry-minidump
- https://docs.rs/icu_segmenter/latest/icu_segmenter/
- https://sqlite.org/fts5.html
- https://github.com/modelcontextprotocol/rust-sdk
- https://github.com/jeremychone/rust-genai
- https://github.com/64bit/async-openai
- https://platform.claude.com/docs/en/api/client-sdks
- https://developers.google.com/identity/protocols/oauth2/native-app
- https://github.com/LaurenzV/hayro
- https://book.leptos.dev/islands.html
- https://learn.microsoft.com/azure/artifact-signing/quickstart
