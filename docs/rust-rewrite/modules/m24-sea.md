# M24 字海、加载与首次体验

2026-11-08，F5 这一路做（分支 `claude/f5-ui-254e54`，从 main `2eb865fa`）。计划见 [modules.md 的 M24](../modules.md)。代码在新 crate `next/crates/dr-view-sea`，内置样书在新 crate `next/crates/dr-samples`。这一轮出的是组件和流程；放进外壳（F6）和书架（M01）要各加几处登记，接法写在下面「怎么接」，没有动它们的文件。

**当前格式的导览（UP 第三版，2026-11-17）**：六步已接回真实工作区，设备一次、同书设置重放、换书/设置焦点、resize 锚点与正常侧栏动画的六条真实宿主回归及八处负控已通过；2026-11-17 审查、补修和最终验收后合进本地 `main`（`handback/v5-ui-polish-3`），未推送。最终原生结果见下文，不沿用早期离屏图作本轮通过证据。

## 大白话

- **字海。** 书架和整窗等待底下铺着一张稿纸：每格一个很淡的小点，有一格的中心落在窗口正中。水面静止时什么都不算、不画。手一碰（指针拖过、在空桌面上按下、点开一本书），水面起波，波过的地方，格里的点浮成这一格的字；字跟着坡度漂几像素，波峰处放大、加深、带一点强调色。格里写的是 Drifting 自己写的一段散文（雾港灯塔那一场），九种界面语言各一段，跟着界面语言换。
- **等待。** 一个整窗的等待过了 240 ms 还没好，字海就下起数字雨，正中由水托起老式衬线粗体的「Loading」，笔画上的字浮起来、一直在换；手照样能把它冲散，它自己会回来。等完了，雨淡掉，单词整个炸成一圈，从外轮廓扩出去，里面不回弹。
- **首次运行。** 第一次打开时，字海立刻托起「Drifting」，站 1.3 秒后松开，这一圈把首次运行的卡留在窗口正中，雨接着在卡周围落；卡是一圈静止细玻璃线，线由字海画，落下时先由水显出边，再在约一秒里浓到静止的强度。右下角一个语言下拉。卡里一步一步问（每台设备一次）：有账户可选时先是欢迎和登录（M35），然后是 Markdown 文件夹放在哪（M40）。都问完了卡淡出，书架在下面浮上；新库第一次写下的样书在它的卡出来 240 ms 后从自己中心荡起一圈，之后玻璃一直流动，等你打开。现在的本地版两个问题都还没有（M35、M40 没做），所以是托起名字、直接到书架。
- **内置样书。** 新的本机库第一次打开时写进两本书：《傲慢与偏见》和写了一半的《阿Q正传》，两本一起成功或一起不写；只写一次，删了不会回来；库里已经有书就不写。
- **导览。** 这台设备第一次打开一本书时（只出一次，不是每本书一次），一串气泡指着左栏的 Tab、叠月开关（开栏与铺满）、新建、时间线、Agent 和回作品主页的地方，一步一步讲；指的东西收着就指它的开关、换一句「点这里打开」，不在屏幕上就跳过；可以跳过、上一步、下一步。六步和卡上的话是视觉打磨第一轮作者定的（kernel-v5 第 15 节第 50 条）。

## 怎么做的

### 字海

旧版是 WebGL2 着色器。新版按 P0-D 定的「简化画法」（作者同意过）在 CPU 上算、用 GPUI 自己的图元画：

- `model/`：水面（7 px 一格的二维波动方程，9 点拉普拉斯，四边吸收，每秒 100 步，和帧率无关）、托字的弹簧和松开时只从外轮廓炸开（连笔、填孔、羽化、内部 0.8 秒吸收）、数字雨、换字、排格子，逐行照搬旧版 `char-sea-model.ts`，旧版的单元测试全部搬过来了。
- `sea.rs`：谁在用字海（等待 / 名字 / 雨 / 页面）、开着 / 退潮 / 关着三种状态、80 ms 的交接闩、240 ms 的加载延迟、单词的升起和呼吸、按下和拖尾，照搬旧版 `char-sea.ts` 的控制器和 `CharSea.tsx` 的状态逻辑。
- `element.rs`：画。静止的点是一张 10 × 10 格的贴图平铺（主题、缩放、点的浓度变了才重画这一张）；动起来时只画被水、雨、单词碰到的格子，每格一个字形，点留在原地不跟着晃（简化画法）。字形按界面语言的字体找：简体中文和拉丁文用 Drifting Serif（旧版捆绑的 Noto Serif SC、Newsreader），繁中、日文、韩文先用系统的衬线字（宋体-繁、冬青明朝、AppleMyungjo，Windows 上新细明体、游明朝、Batang），找不到再用 Drifting Serif。单词用系统的 Times New Roman 粗体，经 GPUI 的 SVG 渲染器画到水面格子上（每格 4 × 4 采样），按墨迹而不是行框居中。
- `glass.rs`：躺在字海上的玻璃（`on_sea`）。每帧报一次自己在哪；字海在它底下只透 12%（边外 10 px 内渐出），画它的静止细线（dr-ui 的「不平的底」画法：均匀 1 px 加内晕），波峰到线上时那一段加粗、向内晕开。浅色里墨是「正片叠底」，平底上换算成普通叠加，和 dr-ui 的砂笔一样。

### 首次运行

`first_run::FirstRun` 是一个盖满窗口的视图：名字阶段、卡阶段、离场、结束。步骤由模块登记（`first_run::add_step`），每个登记的只在这台设备还没回答时出一步；Markdown 文件夹那一步的界面照旧版做好了（`FolderStep`，文案是旧版的），M40 给它一个 `FolderSource`（读当前文件夹、选文件夹、关掉）就能用。两步之间原地叠化 180 ms（翻页那一种），卡晚 120 ms 用 0.24 s 淡入，离场 0.24 s 淡出、线一起淡掉。减少动效时不托名字，直接是卡。

### 内置样书

`dr_samples::ensure_built_in(&workspace)`：见 `next/crates/dr-samples` 的说明。样书的版面原来只在测试工具里（`dr-testkit`），产品不能依赖测试工具，所以把两本样书的定义和摆法搬进了 `dr-samples`（服务层），`dr-testkit` 改成用它，原有的种子摘要和测试一个字没变。

### 导览

`tour/`（照旧版 `features/guide/` 和 `WorkspaceGuide.tsx`）：这台设备第一次打开书、工作区露出来以后等 0.7 s 开始，六步各指一个真的控件（视觉打磨第一轮，原型第 3 版的卡）：

| 步 | 指什么 | 收着时指 | 快捷键 |
| --- | --- | --- | --- |
| 左栏 | 左栏的 Tab 行（连行末的筝柱） | 左边月牙 | — |
| 开栏与铺满 | 左边一对月亮 | — | — |
| 新建 | 作品主页「新建」那一排 | — | ⌘N |
| 时间线 | 稿纸右下角的竹子 | — | ⌘J |
| Agent | 右栏的 Agent 标签 | 右边月牙 | — |
| 作品主页 | 全部项目、鸟居和风铃，一圈 | — | — |

控件外 4 px 一圈等待的玻璃（强调色、自己流动，圆按钮保持圆），旁边一张悬停卡外壳的卡：标题和「1 / 6」（索引字）、一句话、这一步的快捷键（索引字，不画键帽）、跳过 / 上一步 / 下一步（最后一步是「完成」）。圈和卡一起按 Dock 药丸的动效滑到下一个控件，卡里的字整块淡入；减少动效时直接落位。别的地方不压暗、不遮，圈住的控件照样能用。

- 控件收起来时（侧栏关着），这一步指向把它拿出来的那个开关，用另一句话；开关一开，圈就移到控件上。两样都不在屏幕上的步骤，前后走都跳过；一样都没有就结束。
- 回车往下走，Esc 跳过（卡拿着键盘时；它在每步出现时拿、结束时还回去）。走完或跳过都记作「看过了」（设备本地，`SeenStore`），设置里能「再次显示」（`reset_seen`）。一个控件都没找到就结束的不算看过（旧版算），免得外壳还没接好时开发机上把导览用掉。
- 铺满、设置和对话框盖住工作区，以及回书架/换书时，未完成导览先收起，工作区再露出后从第一步开始；等待中的延时也取消，不在设置里抢焦点。恢复时重新捕获当前焦点，不能把键盘还给旧书里已经离开的编辑器。resize 先取下一帧重排的实际锚点，保持还可见的当前步骤。
- 完成或跳过的设备记忆写入 SettingsFile，不按 book id 分份。另一书、App 重开都不再出现；设置「重新显示」清除这个设备值，下一次打开书时重放（含同一本），不是点设置时立刻重放。
- 控件用 `tour::anchor(ids::…, 控件)` 标出来，导览不认识它们的类型；锚点只用 GPUI，可以原样挪进 dr-ui，好让外壳自己标。外壳经 `pages::anchor` 标（`pages::anchors` 是这些 id），作品主页的「新建」那一排由 dr-view-home 标；右栏的 Agent 标签用分段控件的 `Segmented::wrap_option` 单独标一段。
- 键盘和 KB 的左栏焦点各管各的：卡拿着键盘时回车往下走、Esc 跳过；⌘⇧L 把键盘交给左栏，导览照样在，这时 Esc 是左栏的（回到稿纸），不跳过导览；下一步出来时卡再拿回键盘。

## 截图

在 `next/` 下跑（要先建好字体，见 F5）：

```bash
cargo run -p dr-view-sea --features capture --example sea-capture -- ../docs/rust-rewrite/modules
cargo run -p dr-view-sea --features capture --example tour-capture -- ../docs/rust-rewrite/modules
```

下面保留的是早期离屏图，时钟冻住，每张是挑好的一刻。书架是合成的五张卡，只有书名；导览底下是合成的一本书的工作区。2 倍像素，压成 256 色。它们不是 UP 第三版六步的原生验收截图；当前结果单独记在「测试」。

| 内容 | 浅色 | 深色 |
| --- | --- | --- |
| 静止的书架 | [sea-still-light](m24/sea-still-light.png) | [sea-still-dark](m24/sea-still-dark.png) |
| 按下后一圈穿过书卡 | [sea-ring-light](m24/sea-ring-light.png) | [sea-ring-dark](m24/sea-ring-dark.png) |
| 英文的窄格 | [sea-ring-en-light](m24/sea-ring-en-light.png) | — |
| 整窗等待：雨和「Loading」 | [sea-loading-light](m24/sea-loading-light.png) | [sea-loading-dark](m24/sea-loading-dark.png) |
| 首次运行：托起「Drifting」 | [first-run-title-light](m24/first-run-title-light.png) | [first-run-title-dark](m24/first-run-title-dark.png) |
| 首次运行的卡（Markdown 文件夹那一步） | [first-run-card-light](m24/first-run-card-light.png) | [first-run-card-dark](m24/first-run-card-dark.png) |
| 样书落位，玻璃等你打开 | [first-run-landing-light](m24/first-run-landing-light.png) | [first-run-landing-dark](m24/first-run-landing-dark.png) |
| 导览第 1 步：圈住左栏的 Tab 行 | [tour-panels-light](m24/tour-panels-light.png) | [tour-panels-dark](m24/tour-panels-dark.png) |
| 导览第 4 步：时间线开关，⌘J | [tour-timeline-light](m24/tour-timeline-light.png) | [tour-timeline-dark](m24/tour-timeline-dark.png) |

## 怎么接

`dr-view-sea` 用外壳的文案和设置（`dr_shell::t`、`Settings`），所以外壳不能反过来直接调它；照书架、作品主页的做法，由外壳开登记口，应用在 `dr_shell::init` 之后登记。下面是建议的登记口和每一处要做的事。

**F6（外壳）**

1. **底下铺什么**：新登记口，比如 `pages::set_backdrop(cx, |window, cx| AnyElement)`，外壳把它作为窗口根的第一个子元素（书架和工作区都在它上面）。M24 登记 `dr_view_sea::char_sea(&Sea::of(window, cx))`。字海关着时它什么都不画，根上原来的桌面色照旧。
2. **谁按住字海**：外壳在这几处向字海要一个 `Hold`，放开就是丢掉它。外壳拿不到 `Sea`，可以用同一个登记口带一个 `hold(kind, window) -> Box<dyn Any>`：
   - 书架开着（`shelf_open`）时按住「页面」（`HoldKind::Surface`）；
   - `open_book` 时按住「等待」（`HoldKind::Loading`），直到当前那一页真正就绪（旧版是第一页带着内容站到前面，最多 2 s；过了 240 ms 露了面就至少停 600 ms），在同一帧里放开书架的那一个，交接闩让水面不受打扰；
   - 换库（`library::replace`）、启动读库这类整窗等待同样按住「等待」。
3. **退潮**：最后一个放开以后字海退潮几秒（`Sea::mode() == Mode::Ebb`）。旧版这段时间工作区的桌面色让开、左右栏和底栏像书卡一样躺在字海上（只透 12%、没有静止的线、贴窗口边的边不画）。新版对应的做法：退潮时工作区根不铺桌面色，两栏和底栏用 `on_sea(id, SeaGlass::bare(0.0).hover(false), …)` 包起来（没有静止的线，波峰到边上时才显出玻璃），贴窗口边的那几条边往外推 8 px。
4. **首次运行**：这台设备第一次打开时，书架之前先盖一个 `first_run::FirstRun`（字海照样铺在底下），`shows_shelf()` 起才在它下面画书架，`on_done` 时记下「首次运行已经走过」（设备本地的一个设置键，和导览的「看过了」放在一起）。
5. **导览**：`tour::init(cx)`；`tour::set_seen_store(cx, 设备设置)`；书的工作区第一次露出来时 `tour::maybe_start(window, cx)`；工作区根的最后一个子元素 `tour::layer(被盖住, window, cx)`（全窗视图或打开书的等待盖着时传 `true`）；把六处控件用 `tour::anchor` 标出来（左栏面板标签、侧栏关着时的开关、全窗视图入口、时间线开关、帮手标签、鸟居和风铃；作品主页的「新建」归 M02）；设置「外观 → 引导 → 再次显示」调 `tour::reset_seen`。`anchor` 只用 GPUI，外壳不能依赖 dr-view-sea，所以要么把 `tour/anchor.rs` 挪进 dr-ui，要么外壳开一个登记口。

**M01（书架）**

1. 字海开着（`Sea::of(window, cx).is_on()`）时，书架的根和书卡不铺自己的底色，书卡不画自己的玻璃线：每张卡包一层 `on_sea(卡的 id, SeaGlass::resting(2.0).arrive(first_run::arriving(cx)).waiting(sample.waiting), 卡)`，「新建一本」用 `SeaGlass::bare(2.0)`。
2. 在空桌面上按下：`Sea::press(位置, 1.2, window)`；点开一本书：`Sea::press(位置, 1.3, window)`（对话框和菜单上的按下不算）。
3. 样书：`let sample = first_run::sample_on_shelf(&book_id, cx)`；`sample.landing` 的卡第一次画出来时调 `first_run::land_sample(卡的中心, window, cx)`；打开一本书时调 `first_run::note_book_opened(&book_id, cx)`。

**应用（`app/drifting`）**

- 打开库以后、在后台线程里调 `dr_samples::ensure_built_in(&workspace)`，得到的书 id 交给 `first_run::note_samples_created`。只在本机库做（以后的账户库从云端来，不写样书）。
- M40 做好以后用 `first_run::add_step(cx, |w, cx| 没选过文件夹时 Some(Rc::new(FolderStep::new(来源))))` 把 Markdown 文件夹那一步加进首次运行；M35 同样加欢迎和登录。

## 测试

`cargo test -p dr-view-sea`、`cargo test -p dr-samples`：

- **水面、雨、换字、排格子**（`model/`，29 个单元测试，旧版 `char-sea-model.test.ts` 全部搬过来）：一圈每秒走约 310 px、圆的；一秒半后还看得见、六秒内静止；托住的单词被冲散后自己回来，松开时散成一圈；炸开（4 倍）只出一圈、中间不再回弹（关掉吸收时中间会回弹到三倍多高）；雨大约下在三分之一的列上，被水冲断的列会重新落，停了半秒内淡完；雨和单词里的字换成同一段文字里的字母、离开后换回；每格自己的字约每秒换一次但不会让字海一直醒着；随机数和旧版 JS 逐位一样。
- **GPUI 测试平台上**（`tests/sea.rs`）：书架按住时字海开着、书卡被读到；按一下字就浮起来；放开后退潮、退潮时不再起圈、水静后关掉；书架交给等待时 80 ms 内接上，字海不退潮；等待 240 ms 内什么都不出、过了才浮起「Loading」，首次运行的名字立刻顶替它；首次运行先托名字、再出卡（卡的玻璃躺在字海上）；没有步骤时直接离场、`arriving` 在离场时为真、0.24 s 后结束并回调；样书只落一次、打开后不再等；新库写进两本样书，书架上它们等着落位。
- **内置样书**（`dr-samples`）：新库只写一次；删掉（永久删除）不会回来；库里有书（含最近删除、以前永久删除过的）就不写；中途失败会把已写的那本清掉，下次重试成功；被打断的一次下次会先清掉再写；失败三次以后不再试。2026-11-19 收口固定样书 id 的归属保护：每次 `creating` 尝试生成独立 `token` 并在写文档前绑定到 `local_state`（`OWNER_SCOPE = "samples-owner"`，随 `book_id` 清除而在同一 SQLite 事务内原子失效），清理完成后立即释放 `creating` 标记且 `failed` 状态不再盲删固定样书 id；即使清理成功后释放全局标记落盘失败，或旧无 `token` 标记下存在作者改写／导入的同 id 用户书，后续启动也绝不删除或覆盖用户书（永久回归见 `dr-samples/tests/built_in.rs` 的 `same_id_user_book_is_never_deleted_after_failed_attempt_or_unflushed_creating_cleanup`）。`dr-testkit` 的种子摘要和全部测试没变。
- **导览引擎的 GPUI 测试平台**（`dr-view-sea/tests/tour.rs`）：固定坐标的 mock 控件检验延迟、跳过未画控件、收栏 fallback、圈跟着控件移动、覆盖后从头开始、完成/跳过/重放和快捷键。它不证明真实外壳的控件位置。
- **真实宿主的 GPUI 测试平台**（`dr-view-home/tests/workspace_tour.rs`，视觉打磨接管中新增的六条回归，定向已通过）：装入真实 Workspace、Home、左右栏与导览，检查六步实际 bounds、左右栏 fallback、单独 Agent 标签、KB 焦点、设备 SettingsFile 持久化、同书重新显示及导览中换书；没有新建动作的真实项目跳过空行，窗口变窄后按新一帧坐标追踪原步骤。此文件是测试平台集成测试，不是真窗口。
- **首轮五测的负控与恢复**：同书重新显示、换书覆盖、当前书焦点、设置内延时、resize 新锚点和 Agent 单片段六处分别去掉修补即在对应行为断言红；恢复后首轮五条真实宿主测试全部绿。导览引擎 15 测、copied-string 门禁 1 测也通过。这五条使用 reduce-motion；普通动画随后增加第六条宿主回归和两处负控，见下一条。
- **普通动画补查**：真窗口发现展开左栏的第一帧会跳过 Tabs；展开状态已改变，但内容仍为零宽，原有 fallback 提前撤下。侧栏现在在展开动画中保留月牙锚点，真实 Tabs/Agent 一旦可见就优先指向该控件。`opening_sidebars_keeps_the_step_through_the_real_reveal_motion` 在真实宿主关闭减少动画，检查两侧零宽起点、过渡与完成；定向通过，分别撤掉左、右修补均精准跳步而失败，恢复后宿主 6/6、引擎 15/15；连同首轮共八处精准负控。原生复验单列，不以测试平台冒充通过。
- **最终原生窗口（2026-11-17）**：最终产品 `3a6571f206004b5f8a03650408907ad85ad4d01c`，同树 `bf1e5344` 构建（仅多导览定位脚本、Rust 相同）。`workspace-tour.py` 在正常动画下完成浅深色两轮，32 张原生 PNG 逐张复核：六步编号与真实圈选正确，栏关闭时指月牙、打开后跟随实际 Tab 或 Agent 单格；铺满时隐藏，返回后从头开始；设置重放同一本书、换另一书不重放、同 profile 退出重启后不重放均通过。设备 `guides.seen` 经文件核对，应用进程与临时 profile 已清理；1440×900 逻辑像素、2 倍副屏。该两轮属于本批七轮、103 张逐图验收的一部分。合树全套：`cargo fmt --all --check`、全 workspace/all-targets Clippy（`-D warnings`）、workspace tests（3089 通过、0 失败、21 项原有忽略）、`cargo xtask check`、`pnpm public:check`、`pnpm ci:contract:check` 与语言文件一致性检查全部通过；审计为 963 个锁定依赖、0 漏洞、13 项依赖提示，原有过期测量提示保留。早期离屏合成截图、固定坐标 mock 和分路测试均不算这一轮真实窗口验收；Windows、1 倍屏和实体设备边界仍保留。

## 测量（只作参考：测的时候机器负载 45–55，12 核）

```bash
cargo run --release -p dr-view-sea --features capture --example sea-capture -- --bench
```

1280 × 800，2 倍屏，暖机 30 帧后量 120 帧。「整帧」是 GPUI 排版加画一帧的 CPU 时间（不含 GPU）：

| 情形 | 动着的字 p50 | 整帧 p50 | 整帧 p95 | 字海计算 p50 | 字海绘制 p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 书架下每 250 ms 落一滴 | 4484 | 12.9 ms | 72.9 ms | 0.13 ms | 11.2 ms |
| 等待：雨和「Loading」 | 1268 | 3.0 ms | 81.2 ms | 0.25 ms | 2.5 ms |

- 水面、雨、换字的计算几乎不花时间；钱花在绘制上：每个浮起的字算一次坡度、画一个字形，在这个负载下每个字约 2.5 µs（P0-D 在负载 4–11 时量到每个图元约 0.5 µs）。
- p95 被机器上同时编译的几路拖高了，不代表字海本身。等机器空闲时重测，和 P0-D 的简化画法（每 250 ms 一滴 p50 5.0–5.5 ms）对照。
- 静止时什么都不算，书架上一帧整帧约 1 ms。

## 和旧版不一样的地方

- **简化画法**：波过时点不跟着字被推开，只浮出字（P0-D，作者同意）。
- **波谷不让线变细**：GPUI 不能从已经画上的东西里减掉颜色，所以只有波峰让玻璃线加粗、内晕，波谷不让它变细变淡。
- **静止细线是均匀的**：躺在字海上的玻璃底下不是平色，按 dr-ui 的规矩退回均匀 1 px 加内晕（D2 的丙），不是纹理切出的深浅。
- **单词炸开**照旧版完整搬了（连笔、填孔、内部吸收），没有用 P0-D 的简化。

## 待协调

1. ~~**F6：登记口。**~~ **F6 第九轮做了**：`dr_shell::pages::{set_backdrop, set_first_run, set_guide, anchor, anchors}`，`dr_view_sea::shell::init` 登记，应用调用；`tour::ids` 改成转用外壳的 `anchors`。右栏「帮手」标签原来只能整行标，视觉打磨第一轮加了 `Segmented::wrap_option`，现在单独标 Agent 那一段。原来的说明：外壳要开「底下铺什么」和「按住字海」的登记口，在书架、打开书、换库这几处按住，退潮时工作区让开桌面色、两栏和底栏躺在字海上；首次运行和导览要设备本地的两个设置键。见上面「怎么接」。
2. **M01：书架躺在字海上。** 根和书卡在字海开着时不铺底色、不画自己的线，书卡包 `on_sea`；空桌面和点开书时 `Sea::press`；样书落位和「打开后不再等」。见上面「怎么接」。
3. **应用：** 打开本机库后调 `first_run::write_samples`（以后的账户库不调）。样书写进去在调试构建、机器很忙时约 30 秒（版面 19 s、存 158 篇 1.8 s、补索引 7 s），发布构建没量过；首次运行托名字的 1.3 秒里它在后台跑，写完书架自己会刷出来。
4. **M35、M40：** 欢迎和登录、Markdown 文件夹两步用 `first_run::add_step` 加进首次运行；文件夹那一步的界面已经有了（`FolderStep`），M40 给一个 `FolderSource`，「关闭」要先问一句（旧版的危险确认），这一句由 M40 的 `turn_off` 去问。
5. **样书的 id 是固定的**（同一本样书在哪个库里都是同一本），所以书的创建时间是种子里的固定时间（2025-11-01）。书架上「最近改动」读的是存储的时钟，看起来正常。
6. **测量要在空闲时重测**（见「测量」）。
