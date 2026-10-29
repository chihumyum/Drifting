# 动效

动效只有几种，每种表达一件事。新的动画先在下表里找到它属于哪一种，沿用那一种的时长与曲线，不另起一套。减少动效（`prefers-reduced-motion: reduce`）时，下表所有过程都跳过、直接到位。

## 词汇

| 名称 | 表达 | 时长 / 曲线 | 用在 | 代码 |
| --- | --- | --- | --- | --- |
| 结构性开合 | 工作区的结构变了 | `420ms`，`cubic-bezier(0.32, 0.72, 0, 1)` | 侧栏开合、单双栏切换、Bottom Timeline 开合 | `Sidebar.tsx`（`COLLAPSE_ANIM_MS`）、`DesktopSidebarLayout.tsx`（`SPLIT_ANIM_MS`）、`TimelineDrawer.tsx`（`SLIDE_MS`）与对应 CSS |
| 重冰推进 | 一整块内容被推开，换上另一块 | `265ms`，`cubic-bezier(0.8, 0, 0.66, 1)`（先慢后快） | 切换侧栏 Panel；其下的 Panel Tab 玻璃方块走同一个推进，同一刻落地；新内容四边的轮廓在落地后 `340ms` 淡出 | `lib/sidebar-push.ts`（`SIDEBAR_PUSH_MS`、`SIDEBAR_PUSH_EASING`）、`DesktopSidebarLayout.tsx`、`PanelTabs.tsx` |
| 有重量的弹簧 | 手里拿着一块有分量的东西 | 临界阻尼弹簧，刚度 `150`（略落后于手、不回弹）；需要定长时归一到 `520ms`，CSS 用 `linear()` 采样 | Dock 药丸拖拽的跟随、让位与落位；筛选滑块换选；Bottom Timeline 章节块拖动（跨泳道越过中线才吸附，带极轻的回弹） | `tab-reorder.ts`（`SPRING_K`、`SPRING_MS`、`springEasing()`）、`GlassSlider.tsx`、`chapter-lane-drag.ts`（`weighted`） |
| 水波 | 选中从旧项流到新项 | `230ms + 70ms ×` 跨过的项数（最多 4 项，约 `300–510ms`），`outCubic`；中途变宽 ×1.35、变淡 18%、软边 2→16px；落定后 `300ms` 淡出（`0.28s`） | Dock 药丸；Bottom Timeline 同一泳道的章节块（跨泳道时旧块原地淡出、新块原地亮起） | `lib/glass-wave.ts`、`hooks/useGlassWave.ts` |
| 玻璃流动 | 玻璃在手下或在移动 | 悬停：内晕 `0.24s` 晕开，纹理 `15s` 一圈缓慢流动；随距离：纹理按移动距离走（横线 ×1.2、竖线 ×1.6），强度随速度，停下后 `0.32s` 淡出 | 悬停中的玻璃控件、侧栏 Tab Header 外框；移动中的面板边线、Panel Tab 方块、筛选滑块；等你处理的卡片与它的主按钮反过来，平时流动、悬停停 | `materials.css`（`glass-flow`）、`lib/glass-flow.ts`、`desktop-shell.css`（`panel-tab-edge-drift`） |
| 推波 | 一个刚到的步骤被推进来 | `1.125s`，`cubic-bezier(0.4, 0.1, 0.35, 1)`；一道玻璃从左往右推过，纹理随之走 `66px`；静止细线在前 40% 不出现，随后淡出 | Agent 工作时新出现的工具步骤（从历史载入的不推） | `materials.css`（`.glass-sweep`、`glass-sweep`、`glass-sweep-line`） |
| 按压 | 手按下去 | `40ms` 加深，松开 `0.28s` 退回；选中态的边与内晕变化 `0.28s` | 所有 `.glass` 控件（Panel Tab 与筛选项是文字，不按压） | `materials.css` |
| 砂笔画出 | 作者的操作留下痕迹 | 画框沿路径 `0.38s`；Dock 小点长成药丸 `0.34s`（`cubic-bezier(0.3, 0.7, 0.2, 1)`），药丸内容 `0.36s` 浮出；锁与 `+` `0.3s` 展开；章末 ⁂ 展开 `150ms`、收回 `110ms`；TODO 完成的一勾从左往右 `0.38s` 画出（`cubic-bezier(0.3, 0.7, 0.2, 1)`）；统计读数淡入 `0.24s`，值改变时 `0.25s` 滑到新长度 | 侧栏 cell 选中、Dock 展开、章末菜单、TODO 完成、统计读数 | `lib/sand-frame.ts`、`desktop-shell.css`、`chapter-end-menu.css`、`comments-review.css`（`.todo-status-toggle__tick`）、`materials.css`（`.sand-stroke`） |

## 停留与宽限

| 时长 | 含义 | 代码 |
| --- | --- | --- |
| `220ms` | 指针停在对象上多久出现悬停卡 | `HOVER_PREVIEW_DELAY_MS` |
| `220ms` | 指针离开对象后，可以移进悬停卡的宽限 | `HOVER_CARD_GRACE_MS` |
| `180ms` | 列表滚动停下多久之后，滑到指针下的行才算“被指着” | `SCROLL_REST_MS` |
| `180ms` | 正文选区稳定多久后浮出选区浮条 | `EditorSelectionBar` |
| `240ms` | 等数据超过多久才出现加载的缺角圆相（之后 `0.16s` 淡入，`0.9s` 转一圈） | `loading-status.css` |
| `260ms` | 指针离开 Dock 后多久收回小点 | `COLLAPSE_DELAY_MS` |
| `160ms` | 指针离开收起的多选一 tab 与它展开的列表后多久收起（够跨过两者之间的缝） | `HOVER_CLOSE_MS`（`GlassSlider.tsx`） |
| `150ms` | 拖动中报告“离开窗口”后等多久才当真（WebKit 松手前也会报告一次） | `LEAVE_GRACE_MS` |
| `1500ms` | 按下后多久内发生的选中算“按下选中的”，直接从按住态过渡到选中态 | `PRESS_WINDOW_MS` |

## 约定

- 结构性开合只给“工作区的结构变了”用；面板之间切换用重冰推进；拿在手里、能被拖动或像实物一样滑动的东西用弹簧。
- 同一次交互里一起动的东西共用一个时长与曲线，一起落地（Panel 与它的 Tab 方块，药丸与让位的邻居）。
- 推进或拖动中途改变目标时，从每样东西此刻的位置接着走，不跳回、不消失。
- 选中切换要么流（水波、方块滑动），要么原地淡入淡出；不瞬移。文档 Tab 被挤出可视范围时，药丸行立即滚动让它露出来；Dock 展开时等药丸长完再滚。

## 待收拢

这些常量目前分散定义，应收进一个共享的动效模块，由组件引用名字而不是复制数值：`420ms` 与它的曲线（三个 TS 常量加三处 CSS），重冰推进（已在 `lib/sidebar-push.ts`），弹簧（`tab-reorder.ts` 定义，`GlassSlider.tsx` 跨模块借用，`chapter-lane-drag.ts` 另有一份），水波（`lib/glass-wave.ts`），以及上表的停留与宽限。
