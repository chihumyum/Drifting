# 阶段 0 探针与基座 F1–F8

大小是对一个专注的作者加上 Agent 会话的粗估：S 几天，M 1–2 周，L 3–6 周，XL 6 周以上。

## 阶段 0：探针

阶段 0 的五个探针互不依赖，可以同时开。每个探针都要写一份结论，放在 `docs/rust-rewrite/spikes/`。

### P0-A 工程骨架

**大小**：S

**要做的事：**

- 建 `next/` 工作区：
  - `rust-toolchain.toml` 对齐 Zed（1.98.x）；
  - 钉住一个 Zed 发布标签的 git 版本（决定 D1）；
  - `Cargo.lock` 入库。
- 写一个空窗口，能做到：
  - 自定义标题栏，调整红绿灯位置；
  - 应用菜单；
  - 跟随系统的深色和浅色；
  - 打出一个双击就能打开的 `.app`（先不签名）。
- 加 CI：macOS 和 Windows 各一条，跑 `fmt`、`clippy`、`test`、`build`。

**交付物：**

- `next/README.md`：写清楚怎么构建、怎么运行；
- `AGENTS.md` 加一节「新工作区」（作者同意后再加）。

### P0-B 编辑器探针

**大小**：M–L。最关键的探针。

**要做的事：**

1. **只读**：把一章 2 万字的合成正文放进 LoroText，用 GPUI 排版：
   - 比例字体，H1–H3 各自的字号，段距；
   - 中文断行：原以为 GPUI 的 `shape_text` 已经用 ICU 的 UAX #14 断行，钉住的 v1.27.0 里其实没有，「，」「。」会落到行首。P0-B 改由编辑器自己断行（标点禁则加标点悬挂），GPUI 只排字形，见 [P0-B 结论](spikes/p0-b-editor.md)；
   - 能滚动。
2. **能写**：
   - 光标和选区；
   - 拼音组字。组字过程中的内容不写进 Loro，确认上屏后才写入；
   - 退格，回车拆段；
   - 撤销和重做：用 Loro 的 UndoManager，合并间隔约 500 ms。Rust 版的默认值是 0，也就是不合并。
3. **全书**：100 章、150 万字，用 GPUI 的 `list()` 做可变高度的虚拟化：
   - 只排版屏幕上看得见的段落；
   - 屏幕外段落的高度放在后台估算。
4. **测量**：[基准](benchmarks.md) 里「探针档」的所有项：按键上屏、打开、滚动、跳转、内存。
5. **输入法矩阵**：
   - macOS：系统拼音、微信输入法、搜狗、百度；
   - Windows：微软拼音。

**过关标准：**

- 探针档全部通过，就继续。
- 输入法有绕不过去的坑，先评估自带 GPUI 补丁要花多少成本，再和作者商量。

### P0-C Loro 数据模型探针

**大小**：M

**用什么数据**：用合成的重型种子生成书目文档和正文文档。种子包括 100 章 150 万字、300 个要素、200 个构想，以及批注和待办。

**要定下来的设计：**

- **段落身份（块 ID）**：拆段、并段、跨段删除之后，块 ID 怎么保持。
- **批注锚点**：用一对光标。被锚住的文字删掉以后，锚点会怎样。
- **人物链接**：标记用什么键、扩展规则是什么，以及重叠的链接怎么存。
- **对等方 ID**：按（设备，文档）持久化保存。只要应用独占数据库，这样做就是安全的。
- **Agent 写入**：两种做法里选一种：
  - 同一个文档里带 `agent:*` 来源标记，并让撤销管理器排除它；
  - 分叉出一份副本写，写完再导入回来。

**要测的：**

- SQLite 存储：追加更新、写快照、压缩，三者在同一个事务里完成；
- 冷启动、打开一章、打开全书的耗时和内存。

**交付物**：`docs/rust-rewrite/loro-schema.md` v0。结构从此定稿，以后要改得走版本号。

### P0-D 视觉探针

**大小**：M

**要试的：**

- **素玻璃**：做 2–3 个不带背景模糊的方案，放在稿纸和书架上对比。手段是叠色、现有的玻璃纹理、边缘渐变和阴影。
- **砂笔图标**：现有 132 张 PNG 遮罩，看能不能按当前颜色着色。三种办法：
  - 用 GPUI 的 `svg()` 内嵌位图遮罩；
  - 把图标转成矢量；
  - 预先按颜色着色并缓存。
- **字海**：现在是 WebGL2。改成 CPU 跑波动方程，用 GPUI 画字形，测帧时间。
- **封面和热力图**：现在用 Canvas 2D。改用 tiny-skia 画成位图再贴上去。

**交付物**：原型给作者选。设计讨论默认只改原型，作者说「迁」才动生产代码。

### P0-E 旧库导入探针

**大小**：S–M

**要做的事：**

- 用两份旧库副本：内置样书，和合成种子生成的库。
- 结构化的表直接读。
- 正文先读 `content_json`，再和 Yjs 的版本对比，弄清缓存在什么情况下会落后于正文。

**要定下来的：**

- 交换格式要不要做（决定 D5）。
- 如果做，它长什么样：每篇正文的段落、标记、块 ID、批注锚点，以及快照历史。

**交付物**：导入规格的草稿，之后进 [M10](modules.md#阶段-2写作闭环)。

## 基座

### F1 dr-model 与 dr-doc

**大小**：L。适合亲手写。

第一轮已实现（2026-11-07）：接口、不变量清单、测试结果和待协调的事见 [foundations/f1-model-doc.md](foundations/f1-model-doc.md)；文档结构实现时改成了 [loro-schema.md](loro-schema.md) v1。

#### dr-model

- 领域类型和 ID。沿用旧数据的 uuidv7。
- 不变量清单。每条都要标明它靠哪种方式成立：
  - 命令层预防；
  - 读取时容错，比如关系指向的要素已删除，就不显示；
  - 后台修复。

结构以 [loro-schema.md](loro-schema.md) 为准（P0-C 定下 v0，F1 实现时改成 v1），下面是摘要。

#### dr-doc 的书目文档（每本书一个）

| 内容 | 怎么存 |
| --- | --- |
| 书序、叙事序 | 每章各一个实数坐标字段 `book_order` / `narrative_order`，和旧版一样带间隙，平局按 id。P0-C 改：原计划的 `LoroMovableList` 放不下旧版的间隙、未上叙事轴的章节和幕的实数分界 |
| 幕 | 书序上的分界，沿用现在 `book_act.start_order` 的语义 |
| 构想分组、素材夹 | 可以嵌套，用 `LoroTree` |
| 要素、分类、故事线、关系、关系类型、时间钉、情节规划、批注与待办的元数据、项目事实、Project Memory | 各一个 Map，键是 id，值用 `ensure_mergeable_map` 建，避免两边同时创建时一边被藏掉 |
| 写作日 | 按（设备，日期）为键的 Map |
| 别名、所属故事线；要素字段等键值列表 | 集合是 mergeable Map 的键；键值列表是「条目 id → {key, value, order}」，同一旧库在两台设备导入也不会出两份 |

每个文档都从一份确定性的「创世」变更开始（专用对等方、时间戳 0），所有设备算出的字节相同、由 Loro 去重：两台设备同时初始化同一篇空正文不会多出空段，内置关系类型也只有一个。

#### dr-doc 的正文文档（每篇正文一个）

- 每篇正文是一个扁平的 `LoroText`，每段以换行结尾（决定 D3）。正文永远以创世写的那个换行结尾：回车一律在光标处插入新换行。
- **块属性记在换行符上**：H1/H2/H3、引用、缩进 0–8、对齐、块 ID。标记的 `ExpandType` 只管本机插入，并发插入的字可能落进段落标记，所以读取时只认换行符上的块属性，新写的换行符把全部块属性显式写全。
- **块 ID 跟着文字走**：段末回车时块 ID 挪到新换行符上；并段保留前一段的块 ID。两台设备同时在同一段末尾回车（或一边回车、一边并段）会撞号，读取时第一个保留，确定性修复。
- **行内标记**：加粗、斜体、下划线、删除线、链接、人物链接。
- **素材笔记**多出来的块属性：列表、任务（带 `todoId`）、代码块、提示框。
- **表格和素材嵌入**：用占位字符 U+FFFC 加一个标记，标记指向旁边的容器。Loro 的文本不支持嵌入对象。

#### 位置与锚点

- **位置换算**：
  - Loro 在原生 Rust 里的事件按 Unicode 标量计位置；
  - GPUI 用 UTF-8 字节；
  - 输入法用 UTF-16。

  统一用一个位置类型，换算走 `convert_pos`。
- **锚点**：批注、补丁、引用、Agent 命令的位置都用一对 `Cursor`（决定 D4）。查询时 Loro 如果给回一个更新后的光标，就存进本机缓存，不回写书目文档（回放历史找位置每次不到 1 ms，不值得为读取产生同步写入）。锚住的字全删掉后锚点收成一个点；撤销删除不会让它展开回来，要编辑器用撤销项的元数据自己带。

#### 测试

- **属性测试**（proptest）：随机编辑序列，多个对等方合并之后必须收敛，锚点不能丢。
- **模糊测试**（cargo fuzz）：喂坏数据不能 panic。

#### 可以参考的

- 旧数据的结构见 [modules.md 的 M10](modules.md#阶段-2写作闭环)。
- 旧的不变量在 `src/renderer/sync/reducer/production-domain-kernel.ts` 和 `drizzle/*.sql` 的触发器里。触发器共 144 个。

### F2 dr-store

**大小**：L

实现、接口和里程碑状态见 [foundations/f2-store.md](foundations/f2-store.md)。

#### 数据库基线与迁移

新版有自己的 SQLite 基线：`next/crates/dr-store/migrations/0000_*.sql`。迁移沿用现有的做法，复用 `crates/drifting-core/src/database.rs` 的这部分：

- 发布过的迁移不再修改；
- 迁移前先做原生安全快照：先 `VACUUM INTO`，再在影子库上迁移，校验通过后才替换原库；
- 迁移失败时，原库保持不动。

#### 表

| 类别 | 表 |
| --- | --- |
| Loro | `loro_update(doc_id, seq, bytes, origin, ts)`、`loro_snapshot(doc_id, upto_seq, vv, frontiers, bytes, ts)`、`loro_peer(doc_id, peer_id, epoch)`；库的换代号放在 `library_meta`，从备份恢复或复制库时必须换代（DDL 见 [loro-schema.md](loro-schema.md)） |
| 快照历史 | `history_label(doc_id, frontiers, label, ts)`：保留 30 天，每 15 分钟最多一条 |
| 派生索引 | 搜索（FTS5 trigram，1–2 个字的中文查询退回 LIKE）、引用与提及、大纲、字数 |
| 只在本机 | 帮手的运行记录、扩展、权限、工作记忆、生图收件箱 |
| 资源文件 | `asset`：source / display / thumbnail 三种版本 |

#### 文档持有者

- 每个打开的文档有一个持有者（actor），跑在专用线程上。
- 所有写入都排队进来，各带来源标记：界面、Agent、Markdown 文件夹、同步、导入。
- 一次提交之后，先把更新追加进 SQLite，再发事件。

这样能避免作者的按键和 Agent 的操作落进同一次提交。Loro 的隐式事务是跨线程共享的。

#### 压缩与历史

- 后台按更新的条数或大小写快照。写快照和删除已被覆盖的更新，放在同一个事务里。
- 保留完整历史，不做浅快照裁剪，原因有两个：
  - 作者和 Agent 交替写入时，浅快照几乎裁不掉什么；
  - 裁剪后，锚在已删文字上的光标会失效。

#### 可以复用的

- `crates/drifting-core`：`database.rs` 的影子库迁移、恢复回执和安全快照那一段，`library_backup.rs`（`VACUUM INTO` 加资源文件）、`file_io.rs`、`archive.rs`；
- 资源存储以 `src-tauri/src/native_capabilities.rs` 那一份为准（三种版本、导入标记、Windows 落盘删除），不是 `drifting-core/asset_store.rs`；
- `src-tauri`：`image_pipeline.rs` 和各平台的图片解码器，`library_registry.rs`（本机库和每账号一库的规则）。

### F3 dr-workspace

**大小**：L

#### 命令注册表

- 一套命令和查询，每条带 JSON Schema（用 schemars 生成）。
- 界面、Agent 工具、MCP、开发命令行都调用这同一套。
- 能力清单从注册表自动生成，代替现在的 `scripts/generate-agent-capabilities.ts`。

#### 事务

- 一个命令可以同时改：书目文档、若干正文文档、SQLite 里只在本机的表。
- 跨文档的写入没有原子性，所以要规定写入顺序，并写好失败时的补偿。
- 只在本机的表，放在一个 SQLite 事务里写。

#### 事件

- 订阅 Loro 的差异，把细粒度的变化（哪一章、哪一段）发给界面。
- 派生索引增量更新。

#### 撤销，分三层

| 层 | 做法 |
| --- | --- |
| 编辑器内 | 用 UndoManager，只撤作者自己的输入 |
| 对象级（删章、移动） | 执行命令的反向操作 |
| Agent 改动 | 快照历史：先查 `history_label`，再 `revert_to`。回看历史时从 SQLite 另载一份副本再 `checkout`，用完就丢；不要在打开的文档上 `fork_at` 或 `checkout`（P0-C 实测会在打开的文档里留下展开的历史，不释放） |

#### 写入来源

- 来源标记分为：`user`、`agent:<会话>`、`mirror`、`sync`、`import`。
- Agent 写入之后，在 SQLite 里留下结算记录。

#### 可以参考的

- 旧 TS 的用例层 `src/renderer/usecase`（约 8.8k 行）、同步内核 `src/renderer/sync/reducer/production-domain-kernel.ts` 和 `sync/journal/domain-mutation.ts`、帮手写策略 `src/renderer/lib/agent/runtime/drifting-*-write-strategy.ts`。界面和帮手对同一操作的语义已经分叉，统一以界面为准，见 [simplifications.md](simplifications.md)。
- `crates/drifting-core/src/workspace/*` **不当参考**：它是已退役 Apple 前端的后端，Tauri 从没调用，也落后于素材夹和写作日。

### F4 编辑引擎（gpui-prose 与 dr-editor）

**大小**：XL。最长的一条线。P0-B 定下架构以后，下面五条子线可以并行。

**现状**：第一个里程碑（2026-11-07）建了 `next/crates/gpui-prose`，四条子线各占一个目录；架构、对外 API、测量、GPUI 补丁台账和下一轮的拆法见 [foundations/f4-editor.md](foundations/f4-editor.md)。

| 子线 | 内容 | 放在哪 |
| --- | --- | --- |
| F4a 文本存储与索引 | 段落边界索引：用 SumTree 记 UTF-8 字节数、UTF-16 单元数、字符数、段数。Loro 事件增量更新这个索引 | gpui-prose |
| F4b 排版与虚拟化 | 见下文 | gpui-prose |
| F4c 输入 | 见下文 | gpui-prose |
| F4d 渲染 | 行内标记、块样式、选区、光标、查找高亮；沉浸写作时的段落淡出；滚动条标记；砂笔层（贴图） | gpui-prose 出画层接口，砂笔层在 dr-editor |
| F4e Drifting 扩展 | 见下文 | dr-editor |

**F4b 排版与虚拟化：**

- 段落排版缓存，只排看得见的段落，屏幕外段落的高度在后台估算，用 `list()` 虚拟化。
  - 断行和逐行绘制由编辑器自己做：GPUI 只给整段字形（`layout_line`）和画单个字形（`paint_glyph`），标点禁则、标点悬挂、以后的两端对齐都在这一层。
  - `list()` 没有逐项的高度提示，首帧和改宽度时会清空高度。滚动条和按像素跳转用编辑器自己的高度索引，滚动定位仍交给 `list()`。P0-B 的做法见 [结论](spikes/p0-b-editor.md)。
- 全书模式：多篇文档拼成一个滚动区。所有段落走同一套排版，不再分成「静态 HTML」和「活编辑器」两套。
- 打字机滚动。

**F4c 输入：**

- 实现 `EntityInputHandler`，处理组字。
- 键位动作：移动、删除，以及按词操作。中文按词用 ICU 的 `WordSegmenter`。
- 鼠标点选和拖选。
- 复制粘贴：纯文本、Markdown、内部富文本三种。
- 撤销分组。

**F4e Drifting 扩展：**

- 人物链接：@ 选择、自动链接、断链修复；
- 斜杠菜单；
- Markdown 输入规则，包括中文字后紧跟 `**` 等；
- 识别 TODO 标记；
- 章末 ⁂；
- 选中文字时的浮条；
- Agent 改动的显现动画。

**开源边界：**

- F4a–F4d 进 `gpui-prose`，用 MIT 或 Apache-2.0；
- F4e 留在 `dr-editor`，用 AGPL。

**预算**：见 [benchmarks.md](benchmarks.md) 的编辑器档。

### F5 dr-ui

**大小**：L

做到哪了、组件清单与 API、字体的做法和待协调的事，见 [foundations/f5-ui.md](foundations/f5-ui.md)。

#### 令牌

- 浅色和深色的颜色、字号、间距、圆角。
- 动效曲线：从 `src/renderer/lib/motion.ts` 和 `src/styles/materials.css` 的 `--motion-*` 搬过来。

#### 字体

- 打包界面字体和正文字体。
- 中文字体显式指定，不靠系统回退。这样能避开 Zed 已知的中文回退问题：斜体乱码，以及非 400 字重时回退失败。

#### 组件

- **基础控件**：按钮、开关、滑块（GlassSlider）、分段选择、筛选片、下拉、颜色选择。
- **菜单**：
  - 宽度 240 / 320 / 420；
  - 左边图标、右边文字；
  - 分组之间用发丝线隔开；
  - 同一个菜单里，不混用带图标和不带图标的行。
- **悬停卡**：延迟 220 ms，宽限 220 ms；所在的列表滚动时关闭。
- **浮层和反馈**：浮层、对话框、通知药丸、空状态、加载状态。
- **单行输入**：用于标题、搜索、设置，自带输入法处理。它和 F4c 共用组字逻辑。

#### 砂笔

- BrushIcon 着色、KindMark、SandFrame；
- 用砂笔描边画的读数。
- 图标和记号的白色遮罩用 `svg()` 内嵌位图着色：一个只装 PNG 的 SVG，GPUI 栅格化后只留透明度，画的时候上色（P0-D）。
- GPUI 没有混合模式：浅色主题的 `multiply` 在平底上换算成「颜色乘底色，再普通叠加」；底不平的地方（正文里的批注砂笔）把砂笔画在字下面。

#### 素玻璃与过渡

- 素玻璃：按决定 D2 用「遮盖」做（P0-D 的乙）。
  - 每个玻璃控件要知道自己底下和四周的平色；
  - 浮起的玻璃（工具条、Dock 药丸、浮着的侧栏开关）用不透明的稿纸色；
  - 底下不平的地方退回均匀细线（P0-D 的丙）；
  - 菜单和悬停卡的细线沿用现在 `glass-ring.png` 铺在内缩 1px 不透明底下的做法。
- 过渡：
  - 稿纸翻页，原地叠化 180 ms；
  - 侧栏推入，用冰曲线；
  - 选中态在药丸组里的水波。

#### 交付物

一个组件样张程序：`cargo run -p dr-ui --example gallery`，浅色、深色都能看。

### F6 dr-shell

**大小**：L

#### 窗口与导航

- 窗口和标题栏。
- 导航目标：章、故事线、要素、分类、素材、全书，支持前进和后退。
- 位置链接 `drifting:chapters/…#L12-L18`，以及系统深链接。

#### 布局

- 三栏布局。侧栏推入，宽度够时可以分成上下两格。
- 左侧栏三个标签：章节、要素、构想。
- 右侧栏四个标签：审阅、素材库、统计、帮手。

#### 标签坞与 Super View

- 标签坞：
  - 药丸式标签和预览标签；
  - 拖动排序；
  - 把药丸拖到稿纸的左半或右半，就分栏。
- Super View 舞台：覆盖层、切换时的推进动画、Esc 逐层退出。

#### 全局

- **快捷键注册表**：可以改键，默认键位照搬旧版。
- **通知中心**：通知来源包括同步、分享评论、整理、Markdown 文件夹、更新、崩溃跟进。
- **设置存储**：存在文件里，其中一部分随账号同步。
- **界面文案**：接入 `dr-i18n`。

### F7 dr-platform 与发布

**大小**：M–L

做法、接口和交接设计见 [foundations/f7-platform.md](foundations/f7-platform.md)。

#### 钥匙串

- **不用 GPUI 自带的凭据接口**：它在 macOS 存 internet password、在 Windows 给条目名加 `zed:url=` 前缀且超过 2560 字节直接报错，读不到旧版条目，也存不下 OAuth 令牌。沿用旧版的存法和 `secure_storage/chunked.rs` 的分片格式，键名不变（见 [simplifications.md](simplifications.md) 第 14 条）。F7 直接调系统接口、按 keyring 3.6 的格式读写，keyring 只在测试里扮演旧版，见 [f7-platform.md](foundations/f7-platform.md#钥匙串)。
- Windows 上单条凭据最多 2560 字节，大令牌要拆开存。
- 要能读到旧版用 keyring 写的条目，保证升级后不丢登录和 API Key。

#### 深链接与单实例

| 平台 | 做法 |
| --- | --- |
| macOS | 用 GPUI 的 `on_open_urls` |
| Windows | GPUI 在 Windows 上注册不了网址协议。改由安装器写注册表；单实例用互斥量，后启动的进程通过命名管道把参数转给前一个（照 Zed 的 `windows_only_instance.rs`） |

#### 日志与崩溃上报

- 日志用 `tracing`。
- 崩溃上报用 `sentry`，开启 `minidump` 特性。CI 里上传符号文件。

#### 打包

- macOS：`.app` 和 `.dmg`，签名并公证。用 cargo-packager，或者照 Zed 写脚本。
- Windows：NSIS 安装包。安装位置和卸载项与现在保持一致。

#### 自动更新

- 沿用 GitHub Releases 上的 `latest.json` 和现有的 minisign 公钥。
- 实现上，用 cargo-packager-updater，或者自己写一个并用 `minisign-verify` 验签。
- 要设计好旧版到新版的交接：最后一个 Tauri 版本把更新交给 GPUI 版本。

#### CI

发布流水线要重写。现在的 `.github/workflows/release.yml` 是为 Tauri 写的。

### F8 dr-cli 与 dr-testkit

**大小**：M

#### 种子

- 把种子生成器移到 Rust，确定性生成。现在它们在 TS 里：`src/renderer/services/sample-project`、`src/dev-cli/seeds`。
- 要移的有：内置样书，以及合成的轻量种子和重型种子。
- 只留一个生成器 `dr-testkit::seed`，预设 tiny / lite / heavy / showcase 加两本样书；探针里的两套（`loro-model` 的 seed、`prose-spike` 的 synth）并进来，随机数和语料指纹只用一种。

#### 隔离与崩溃

- 按 worktree / profile 隔离开发实例：数据库、应用身份、端口、单实例锁各自分开（旧版是 `scripts/run-worktree-dev.mjs`）。
- 一个崩溃试验台：随机时刻 SIGKILL、重开、和确定性重放比对（P0-C 的做法），代替旧版的 6 套。
- 证据统一走 `dr-testkit::evidence` 和 `cargo xtask evidence --check`，做法见 [simplifications.md 第五节](simplifications.md#五更轻的验收证据新工作区适用)。

#### 命令行

- 子命令：`drifting workspace call | describe | inspect | scenario`，直接调用 F3 的命令注册表。旧版的 `db:inspect` 和无界面的帮手调试也并进这一个命令行。
- 离线改库的安全规则照旧：应用必须关着；先备份；加 `--yes` 才执行。

#### 界面自动化

- **单元测试**：用 GPUI 的 `TestAppContext` 模拟输入。
- **调试桥**：一个本机 socket，走 JSON，让 Agent 会话能驱动真实窗口做验收。它代替现在的 frontend debug bridge。
- **截图对比**：用 `VisualTestContext`，只在 macOS 上可用。

#### 基准程序

- 运行：`cargo run -p dr-testkit --bin bench -- --check`。
- 结果写成 JSON 证据，放在 `docs/rust-rewrite/acceptance/`。
