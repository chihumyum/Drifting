# 动效

动效只有几种，每种表达一件事。新的动画先在下表里找到它属于哪一种，沿用那一种的时长与曲线，不另起一套。减少动效（`prefers-reduced-motion: reduce`）时，下表所有过程都跳过、直接到位。

时长与曲线只定义一次：TypeScript 从 `src/renderer/lib/motion.ts` 引用名字，CSS 读 `materials.css` 里 `:root` 上同值的 `--motion-*` 自定义属性；组件不再自己写数值。`lib/motion.test.ts` 守着两边一致。

## 词汇

| 名称 | 表达 | 时长 / 曲线 | 用在 | 代码 |
| --- | --- | --- | --- | --- |
| 结构性开合 | 工作区的结构变了 | `420ms`，`cubic-bezier(0.32, 0.72, 0, 1)` | 侧栏开合、单双栏切换、稿纸下面的 Bottom Panel（Bottom Timeline 或情节规划）开合、要素全景的浮岛从小卡长成编辑器与收回 | `STRUCTURAL_MS`、`STRUCTURAL_EASING`；CSS `--motion-structural`、`--motion-structural-ease`（`Sidebar.tsx`、`DesktopSidebarLayout.tsx`、`TimelineDrawer.tsx`、`SuperElementIsland.tsx` 与对应 CSS） |
| 重冰推进 | 一整块内容被推开，换上另一块 | `265ms`，`cubic-bezier(0.8, 0, 0.66, 1)`（先慢后快） | 切换侧栏 Panel；其下的 Panel Tab 玻璃方块走同一个推进，同一刻落地；新内容四边的轮廓在落地后 `340ms` 淡出；Bottom Panel 里时间线与情节规划互换（壳子与高度不动，整块连同 header 上下推出顶边：去情节规划向上推、回时间线向下推，新来的四边与泳道线晕出玻璃）；Super View 之间切换（header 不动，下面整块左右推开，方向按切换器里的左右，新来的一块四边晕出玻璃；打开与关闭不推）——虽然推的是整个窗口宽，仍与侧栏 Panel 同为 `265ms`（2026-11-02 由 `400ms` 统一），头部切换器的玻璃块走同一个推进、同一刻落地，和侧栏 Panel Tab 的玻璃块一样 | `PUSH_MS`、`PUSH_EASING`、`PUSH_OUTLINE_FADE_MS`；CSS `--motion-push`、`--motion-push-ease`（`DesktopSidebarLayout.tsx`、`PanelTabs.tsx`、`BottomPanel.tsx`、`DesktopSuperViewStage.tsx`，推进的路线由 `lib/sidebar-push.ts` 排） |
| 有重量的弹簧 | 手里拿着一块有分量的东西 | 临界阻尼弹簧，刚度 `150`（略落后于手、不回弹）；需要定长时归一到 `520ms`，CSS 用 `linear()` 采样 | Dock 药丸拖拽的跟随、让位与落位；筛选滑块与时间线书序／叙事时换选；Bottom Timeline 章节块拖动（跨泳道越过中线才吸附，带极轻的回弹） | `SPRING_K`、`SPRING_MS`、`springEasing()`、`weightedEasing()`；CSS `--motion-spring`（`tab-reorder.ts`、`GlassSlider.tsx`、`chapter-lane-drag.ts` 的横向） |
| 水波 | 选中从旧项流到新项 | `230ms + 70ms ×` 跨过的项数（最多 4 项，约 `300–510ms`），`outCubic`；中途变宽 ×1.35、变淡 18%、软边 2→16px；落定后 `300ms` 淡出（`0.28s`） | Dock 药丸；Bottom Timeline 同一泳道的章节块（跨泳道时旧块原地淡出、新块原地亮起） | `WAVE_BASE_MS`、`WAVE_PER_ITEM_MS`、`WAVE_MAX_ITEMS`、`WAVE_SETTLE_MS`（`lib/glass-wave.ts`、`hooks/useGlassWave.ts`） |
| 玻璃流动 | 玻璃在手下或在移动 | 悬停：内晕 `0.24s` 晕开，纹理 `15s` 一圈缓慢流动；随距离：纹理按移动距离走（横线 ×1.2、竖线 ×1.6），强度随速度，停下后 `0.32s` 淡出 | 悬停中的玻璃控件、侧栏 Tab Header 外框、时间线的幕边界；移动中的面板边线、Panel Tab 方块、筛选滑块、时间线拖动中的落点线；等你处理的卡片与它的主按钮反过来，平时流动、悬停停 | CSS `--motion-glass-bleed`、`--motion-glass-drift`、`--motion-flow-fade`（`materials.css` 的 `glass-flow`、`lib/glass-flow.ts`、`desktop-shell.css` 的 `panel-tab-edge-drift`） |
| 推波 | 一个刚到的步骤被推进来 | `1.125s`，`cubic-bezier(0.4, 0.1, 0.35, 1)`；一道玻璃从左往右推过，纹理随之走 `66px`；静止细线在前 40% 不出现，随后淡出 | Agent 工作时新出现的工具步骤（从历史载入的不推） | CSS `--motion-sweep`、`--motion-sweep-ease`（`materials.css` 的 `.glass-sweep`、`glass-sweep`、`glass-sweep-line`） |
| Dock 药丸开合 | 打开的文档在 Dock 里长出、关掉的收回 | `340ms`，`cubic-bezier(0.3, 0.7, 0.2, 1)` | 小点原地长成药丸（宽度从小点的 `20px` 长到自己的宽度，内容 `0.36s` 在后半程浮出）；关掉的药丸倒着走：标题先淡去，药丸收回 `20px` 并在两侧邻居合拢处淡出，两侧药丸、锁与 `+` 同时从关闭前的位置滑拢（FLIP），一起落地；小点状态下关掉的记号照砂印出现的样子倒着淡去 | `DOCK_PILL_MS`、`DOCK_PILL_EASING`；CSS `--motion-dock-pill`、`--motion-dock-pill-ease`（`desktop-shell.css` 的 `dock-pill-grow`，`TopTimeline/dock-leave.ts`） |
| 浮入 | 一条工具从它服务的东西上浮出来 | `160ms`，`cubic-bezier(0.3, 0.7, 0.2, 1)`，上移 `3px` 淡入；它展开的第二条 `150ms` 展开、`110ms` 收回 | 选区浮条与它的格式条；素材笔记的清单与表格浮条 | `comments-review.css`（`editor-selection-bar-in`） |
| 翻页 | 稿纸换成另一页 | 原地叠化：新页盖在旧页上面 `180ms` 淡入，曲线 `cubic-bezier(0.4, 0, 0.2, 1)`，不位移；旧页一直完整地留在下面，新页盖满后才撤走，纸上的墨一刻也不变淡（2026-11-02 作者在原型里比过浮起、慢出慢入、直接换后选定；之前的「旧页 `90ms` 淡出、新页晚 `50ms` 从下方 `6px` 浮起」中途两页都淡，读起来像闪）。中途再换页，正在淡入的那页停在下面完整显示，下一页从它已占的那份浓淡接着淡入，不跳回。舞台本身是稿纸色 | 切换顶部标签、从侧栏或链接打开另一个实体、关掉标签后露出下一页、回到作品主页；打开书时的第一页在字海下面露出，不翻；首次运行的卡换步骤（欢迎、登录、Markdown 文件夹）也这样叠化，卡的大小与字海画的线同一时长跟到新的一页 | `PAGE_BLEND_MS`、`PAGE_BLEND_EASING`，CSS `--motion-page-blend`、`--motion-page-blend-ease`（`components/editor/editor-page-turn.ts`，由 `EditorMainArea` 在新页就绪时驱动；首次运行在 `PreAlphaFirstRunGate` 的 `FirstRunCard`） |
| 按压 | 手按下去 | `40ms` 加深，松开 `0.28s` 退回；选中态的边与内晕变化 `0.28s` | 所有 `.glass` 控件（Panel Tab 与筛选项是文字，不按压） | CSS `--motion-glass-press`、`--motion-glass-settle`（`materials.css`） |
| 砂笔画出 | 作者的操作留下痕迹 | 画框沿路径 `0.38s`；Dock 小点长成药丸与关掉时收回见上面的「Dock 药丸开合」；锁与 `+` `0.3s` 展开；章末 ⁂ 展开 `150ms`、收回 `110ms`；TODO 完成的一勾从左往右 `0.38s` 画出（`cubic-bezier(0.3, 0.7, 0.2, 1)`）；统计读数淡入 `0.24s`，值改变时 `0.25s` 滑到新长度；滚动标记的砂印出现 `0.34s`（`sand-arrive` 那一种），离开整颗 `0.3s` 淡出；正文里选中的批注沿行重画，第一行 `0.38s`、每多一行加 `0.12s`，整段一口气缓出，正文砂笔整块淡入淡出 `0.3s`、浓度变化（指着卡片、链接悬停）`0.24s` | 侧栏 cell 选中、Dock 展开、章末菜单、TODO 完成、统计读数、滚动标记、正文的批注锚点与实体链接 | `lib/sand-frame.ts`、`desktop-shell.css`、`chapter-end-menu.css`、`comments-review.css`（`.todo-status-toggle__tick`、`.editor__scrollmap-tick`、`.comment-sand`）、`materials.css`（`.sand-stroke`、`prose-sand-arrive`）；`SAND_DRAW_MS`、`SAND_DRAW_PER_LINE_MS`、`sandDrawTimeAt()`、`SAND_FADE_MS`、`SAND_SHIFT_MS`，CSS `--motion-sand-fade`、`--motion-sand-shift`（`lib/comment-sand.ts`、`index.css` 的 `.entity-link`） |
| 同步的云 | 稿纸角的同步还在进行，或正在重试 | 呼吸：整朵云 `1.8s` 一次淡到 25% 再回来；慢闪：`2.4s` 一次，后半段暗下去一会儿；换记号整块淡出淡入 `0.3s`（砂笔出现那一种） | 稿纸左下角的同步记号 | `SYNC_MARK_BREATHE_MS`、`SYNC_MARK_BLINK_MS`，CSS `--motion-sync-breathe`、`--motion-sync-blink`（`paper-sync-mark.css`） |
| 原地改写 | Agent 写进来的改动 | 每步 `25ms`，一处改动走较长那一边的字数（整段 `0.5–2.5s`，同时揭示的段落多时按档加速，见 `agentEditRevealTiming`）；写完原地交给正文。留下的绿、紫墨字在指针碰到时立刻用 `300ms` 分两步退回墨色 | 正文里 Agent 改动的揭示与留色 | `agentRevealFrame`、`agentEditRevealTiming`（`components/editor/agent-edit-animation.ts`）、`RECENT_CHANGE_FADE_MS`（`lib/agent-recent-highlight.ts`、`lib/agent-recent-changes.ts`） |

## 停留与宽限

| 时长 | 含义 | 代码 |
| --- | --- | --- |
| `220ms` | 指针停在对象上多久出现悬停卡 | `HOVER_PREVIEW_DELAY_MS` |
| `220ms` | 指针离开对象后，可以移进悬停卡的宽限 | `HOVER_CARD_GRACE_MS` |
| `180ms` | 列表滚动停下多久之后，滑到指针下的行才算“被指着” | `SCROLL_REST_MS` |
| `180ms` | 正文选区稳定多久后浮出选区浮条 | `SELECTION_BAR_SETTLE_MS` |
| `140ms` | 指针离开「格式」与它的格式条后多久收起（够跨过两条之间的缝） | `FORMATS_CLOSE_MS` |
| `240ms` | 等数据超过多久才出现加载的缺角圆相（之后 `0.16s` 淡入，`0.9s` 转一圈）；整个窗口的等待超过它才在字海里落水滴（之后每 `1.1s` 一滴，波每秒约 310px，按一下约五秒后静止）；等待打开工作区时字海退潮，工作区整块用 `--motion-structural` 淡入，余波走完才收起（最多 `8s`）；稿纸等新页超过它时，Dock 里要的那个标签的玻璃自己流动（`2.4s` 一圈，比悬停快），收起时是那颗小点外长出的一圈小玻璃，新页一到、翻页开始时停 | `LOADING_DELAY_MS`，CSS `--motion-loading-delay`（`loading-status.css`、`CharSea`）；`GLASS_LOADING_DRIFT_MS`，CSS `--motion-glass-loading`（`.glass--loading`、`EditorMainArea` → `editor-stage-waiting.ts` → `TopTimeline`） |
| `1300ms` | 首次运行时应用的名字「Drifting」在字海里站多久才松开、炸成把卡留下的那一圈；卡随后 `0.24s` 淡入，选完时同样 `0.24s` 淡出（`FIRST_RUN_LEAVE_MS`，与 `--motion-glass-bleed` 同值），书架同时整块浮上（`--motion-structural`） | `FIRST_RUN_TITLE_MS`、`FIRST_RUN_LEAVE_MS`（`PreAlphaFirstRunGate`） |
| `240ms` | 新书库写下的示例书，它的卡出现后多久从自己中心荡起落位的一圈；落下的玻璃线（首次运行的卡、示例书、首次运行后浮上的作品卡）约一秒浓到静止的强度 | `SAMPLE_LANDING_DELAY_MS`（`ProjectPickerView`）；线的缓入在 `lib/char-sea/char-sea.ts` 的 `REST_EASE` |
| `260ms` | 指针离开 Dock 后多久收回小点 | `DOCK_COLLAPSE_DELAY_MS` |
| `160ms` | 指针离开收起的多选一 tab 与它展开的列表后多久收起（够跨过两者之间的缝） | `OPTIONS_CLOSE_MS`（`GlassSlider.tsx`） |
| `150ms` | 拖动中报告“离开窗口”后等多久才当真（WebKit 松手前也会报告一次） | `DRAG_LEAVE_GRACE_MS` |
| `1500ms` | 按下后多久内发生的选中算“按下选中的”，直接从按住态过渡到选中态 | `PRESS_WINDOW_MS` |
| `2000ms` | 作者停笔多久后，因打字淡出的同步云回来 | `SYNC_MARK_TYPING_SETTLE_MS` |

## 约定

- 新的时长或曲线先在 `lib/motion.ts` 起名字，CSS 要用就在 `materials.css` 的 `:root` 加同值的 `--motion-*`，两边由 `lib/motion.test.ts` 对齐；组件里不写数字。
- 结构性开合只给“工作区的结构变了”用；面板之间切换用重冰推进；拿在手里、能被拖动或像实物一样滑动的东西用弹簧。
- 同一次交互里一起动的东西共用一个时长与曲线，一起落地（Panel 与它的 Tab 方块，药丸与让位的邻居）。
- 推进或拖动中途改变目标时，从每样东西此刻的位置接着走，不跳回、不消失。
- 选中切换要么流（水波、方块滑动），要么原地淡入淡出；不瞬移。文档 Tab 被挤出可视范围时，药丸行立即滚动让它露出来；Dock 展开时等药丸长完再滚。
