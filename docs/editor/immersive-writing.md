# 沉浸写作

Status: built on 2026-11-03 (desktop). The author picked 「素纸 + 段」 from the
prototype's candidates: the window keeps only the paper, and every block but
the caret's fades. The prototype's other surroundings (灯下, 听雨) and focus
modes (句, 渐隐) were not adopted.

## Product contract

- **进出**。稿纸右下角工具栏药丸右边单独的圆形玻璃按钮，角落的最后一个（一炷香砂笔图标
  `incense`：坐禅以一炷香为一坐；`aria-pressed` 表示开着；2026-11-04 从工具栏
  药丸里拆出，先放在时间线开关左边，当天作者改到药丸右边；换掉了原来的茶碗，作者从五个候选里选了一炷香；和时间线开关一样只在右侧 pane 的角落）或 `⌘⇧↩`（设置的快捷键里可改，`toggleImmersiveWriting`）进入；
  再按一次快捷键或按 `Esc` 退出。`Esc` 只在没有别的东西先接住它时才退出
  （`defaultPrevented`、输入法组字中都不算）。进出都把光标放回原处，接着就能打字。
- **打字时自动沉浸**（2026-11-06 作者提出）。设置 → 编辑器 → 书写体验（FLOW）第一行的
  开关（`autoImmersiveWriting`，默认关，跟账号同步；只在桌面端出现）。开着时，在 stage
  里显示着的那个编辑器里第一次真的写进文字就进入沉浸：打出的字、回车（含 Shift+回车）、
  输入法的提交都算；粘贴、拖入、系统替换词、删除、撤销不算；输入法组字中绝不进入，
  等提交（`compositionend`）之后才进，免得侧栏在拼音底下滑走。光标就在原处，不重新聚焦。
  Agent 输入框、情节规划、侧栏里的输入框不是稿纸，在那里打字不进入。
  这样进入的沉浸，除了 `Esc`、快捷键和出口，点正文以外的地方也会退出：在工作区里按下
  主键、按下处不在正文（`.ProseMirror`）也不在出口上，就退出，而且这一下照常落下
  （点到顶边露出的 Dock 就换文档，点到大纲 rail 就跳过去），退出时不抢焦点。portal 到
  `body` 的悬停卡、菜单、对话框不算工作区，点它们不退出。用一炷香或 `⌘⇧↩` 进入的沉浸
  照旧不因点别处退出。退出后开关仍开着，再打字又会进入。
- **收掉什么**。两侧栏、侧栏开关（连同左栏收起时浮着的同步铃）、标签点
  Dock、每个 pane 的稿纸工具条、时间线开关（连同没有编辑器时 stage 自己的那个）、
  Bottom Panel（时间线或情节规划）。侧栏与 Bottom Panel 用各自原有的
  `420ms` 滑动收起；浮着的控件淡出（`--motion-glass-bleed`），淡完是
  `visibility: hidden`，点不到也聚焦不到。稿纸左下角的同步云在沉浸中不呼吸，
  只有同步出了问题时照常显示。Windows 的窗口按钮药丸随侧栏开关淡出。macOS 的红绿灯从原生侧隐藏
  （`window_set_traffic_lights_hidden`）。
- **留着什么**。正文里的批注砂笔（稿纸批注按钮的开关；页边便笺 rail 已在
  2026-11-04 退役）和大纲 rail 按进入前的样子保留：开着就开着，关着就关着；
  沉浸写作不读也不改它们的开关。
  要素下划线与悬停卡照常。
- **回到原样**。沉浸是一个不存盘的界面状态（`immersiveWriting`）。侧栏与
  Bottom Panel 自己的开合状态在下面原样保留，界面读的是「开着且不在沉浸中」
  （`sidebarShown`），所以退出时它们照进来前的样子滑回来，存着的布局从没被改过。
  打开整书视图（Super View）或离开工作区都会结束沉浸。
- **边缘露出**。指针到窗口顶边 `56px` 内：红绿灯与标签点回来，标签点照常
  悬停成药丸、可以换文档。沉浸中稿纸角落的工具栏、时间线开关
  和那炷香本身都收着；出口是同一个按钮（按下状态），放在 stage 自己的右下角
  （右 `16px`、和工具栏同一条中线，也就是它平时所在的位置），指针到它附近（离它 `48px` 以内）才出来，
  左边是这一次写了多少字（`+N`，与左栏「今日」同一来源：全书净增）、下面是今日
  那笔砂往每日目标长；点它退出。换文档时这次的字数接着算。（2026-11-04 起；
  之前出口留在原来的位置，左边被收起的工具栏和时间线开关还占着地方，看起来
  悬在半路。）一按不带修饰键的键就都收走；
  指针离开窗口也收走。
- **段落聚焦**。光标所在的块保持原墨色，前后所有正文淡成
  `hsl(var(--ink-1) / 0.26)`。块指光标所在的文本块（段落、标题、列表项里的
  段落），选中整个节点时就是那个节点。只作用于获得焦点的那个编辑器。
- **打字机滚动**。沉浸中打字机滚动总是开着，用设置里的打字机位置；
  退出后回到设置本身的开关。所以桌面端打字机模式关着时，打字机位置也照样可调。

## Implementation

- `ui-store`：`immersiveWriting` / `setImmersiveWriting(on, byTyping?)`，以及这次是不是
  打字进入的 `immersiveWritingByTyping`（每次进出都重置），都不在 `partialize`
  里；`setActiveSuperView` 打开整书视图时顺手清掉它们；`sidebarShown(state, side)`。
- `settings-store`：`autoImmersiveWriting`（默认 `false`，合并时只认 `true`）；
  `features/preference-sync/preference-fields.ts` 把它列进跟账号同步的键；设置行在
  `PreferenceSettingsPanels.tsx` 的 FLOW 区，`settingsOnDesktop()` 时才画。
- `Sidebar.tsx`：展开 = `isOpen && !immersive`，对侧宽度的夹取也按显示与否算。
- `DesktopWorkspace.tsx`：根节点 `data-immersive`；沉浸时 `dockPane` 为 `null`；
  stage 里挂 `StageImmersiveWritingControl`（只在沉浸中渲染，即出口）；`useImmersiveWriting(rootRef)`。
- `EditorTopBar.tsx`：角落依次是 `TimelineToggle`、工具栏药丸、
  `ImmersiveWritingControl`；两个单独的按钮只在承载时间线开关的那个角落。
- `components/workspaceChrome/ImmersiveWriting.tsx`：角落里的一炷香按钮，
  以及沉浸中 stage 角落的出口与这一次的字数；
  起点（开始时的今日字数）存在 `immersiveWritingBaseline`，换文档不清零。
- 一炷香由 `scripts/design-assets/brushicons.py` 画（`incense`，种子 `9101`）；
  同时画过的灯盏、闭目留在 `ALTERNATES`。
- `shells/desktop/useImmersiveWriting.ts`：沉浸期间监听指针（顶边、或出口的
  实际位置附近；只在区域变化时改根节点的 `data-immersive-peek`，并在进出顶边时
  切换原生红绿灯）、按键与
  `Esc`，并启停段落聚焦。开关开着且不在沉浸中时，在 document 捕获阶段听 `input`、
  `compositionend` 与回车的 `keydown`，等这次事件自己的处理（ProseMirror 结束组字、
  拆段）走完的下一轮，若目标在 stage 里显示着的编辑器中（`isStageEditorTarget`：
  可编辑、不在组字、编辑器在 `.desktop-workspace-stage` 里）就
  `enterImmersiveWriting({ byTyping: true })`。打字进入的沉浸期间在 window 捕获阶段听
  主键 `pointerdown`，按在别处就 `leaveImmersiveWriting({ refocus: false })`，不拦这次按下。
- `features/immersive-writing/auto-immersion.ts`：哪些输入算打字（`isTypingInput`、
  `isTypingKey`）、按在哪里算别处（`isPressElsewhere`，正文与出口之外、工作区根节点之内）。
- `components/workspaceChrome/immersive-writing.ts`：进入、退出、切换；回焦只给
  可见的编辑器（保活的隐藏标签页里的编辑器不接光标）。
- `features/immersive-writing/paragraph-focus.ts`：段落淡化用
  **CSS Custom Highlight API**。一个名为 `drifting-immersive-dim` 的 Highlight 装两个活的
  Range：编辑器根节点开头到当前块之前、当前块之后到末尾。块内打字时 Range
  自己跟着走，只有光标换了块、或块的前后位置变了（`rangesStillAround`）才重建。
  它不发事务、不加装饰、不改 class 或属性，所以 ProseMirror 的 DOM 与输入法组字
  完全不受影响，也不会因为改根节点样式引起整页重算。
- `styles/immersive-writing.css`：淡出规则、两个露出区、角落样式与
  `::highlight(drifting-immersive-dim)`。
- Rust `window_set_traffic_lights_hidden(hidden)`：把三个
  `standardWindowButton` 的 `alphaValue` 设成 0 或 1；非 macOS 返回不支持。
  改按钮的 alpha（和 `setHidden` 一样）会让 AppKit 当场把标题栏重排一次，丢掉
  启动时 `window_set_traffic_light_position` 给的位置：2026-11-04 用临时探针实测，
  关闭按钮的 x 从 `18` 跳回系统默认的 `9`，标题栏容器高 `37` 变回 `32`，而且就在
  这次调用里同步发生，之后不会再自己变。所以命令在同一个主线程回合里先记下三个
  按钮与容器的 frame，改完 alpha 立刻放回，中间不会有一帧画在默认位置
  （作者两次发现红绿灯跑位：先是 `setHidden`，换成 alpha 后照旧，才查清）。
  透明时按钮仍在原处，但指针一到那里就已经在顶边露出区里，它们会先显出来。

## Acceptance

- `src/renderer/shells/desktop/immersive-writing.acceptance.test.ts`：入口与快捷键、
  侧栏与 Bottom Panel 收起且不改存着的状态、整书视图结束沉浸、淡出哪些控件、
  批注与大纲 rail 不被触碰、露出区、打字机强制开启（桌面上打字机位置不随开关禁用）、段落淡化不写编辑器。
- 同一文件「打字时自动沉浸」一条：开关默认关、跟账号同步、只在桌面 FLOW 区第一行、九种语言都有；
  进入来源随沉浸重置且不存盘；监听哪三种事件、只认 stage 里的编辑器、进入不重新聚焦；
  点别处只在打字进入时退出且不拦按下。
- `src/renderer/features/immersive-writing/auto-immersion.test.ts`：哪些 `inputType` 与按键算打字
  （粘贴、拖入、替换、删除、撤销、组字中、提交组字的 229 键都不算）、按在正文、出口、
  portal 浮层上不算别处。
- `src/renderer/features/immersive-writing/paragraph-focus.test.ts`：Range 的
  边界、块的查找（嵌套段落与节点选中）、只在换块时重画、停止时撤销 Highlight、
  没有 Highlight API 时什么都不做。
- 桌面窗口验收（调试桥，示例项目）：进出、侧栏与时间线回到原样、批注与大纲
  rail 保留、`Esc` 与 `⌘⇧↩`、露出区与本次字数。淡化的实际观感（WebKit 对
  `::highlight` 的绘制）属于真实窗口验收。
- 打字时自动沉浸的桌面窗口验收（2026-11-06，调试桥，轻量示例项目，窗口在后面、事件是合成的）：
  开关默认关、关着时打字不进入；粘贴、组字中、删除、侧栏里的输入框、229 回车、⌘↩ 不进入；
  打字、回车、输入法提交进入且记为打字进入；按在正文、portal 浮层上、右键不退出，按在
  stage 空白处退出；`Esc` 退出后再打字又进入；手动进入的沉浸按在别处不退出。真实键盘与
  输入法下的手感属于真实窗口验收。
