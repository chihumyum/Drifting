# 字体按信息角色分工

2026-10-29 采用作者选定的 A 方案。字体表达信息结构，不给每个面板另设风格。

| 角色 | 中英文字体 | 用途 |
| --- | --- | --- |
| 结构 `--font-structure` | Noto Serif SC + Newsreader | Panel Tab、Super View 的视图切换、设置每一节的页题、故事线、要素 Category、素材文件夹、时间线与故事图谱的故事线泳道名、幕名、作品主页的节标题与「全书」里的故事线和类目、结构化编辑器的节标题 |
| 索引 `--font-mono` | 更纱等距 SC / Sarasa Mono SC | Panel subheader、数量、筛选、Category 下的 Group、状态与元数据、编辑器里一节空着时的那一句 |
| 实体 `--font-sans` / `--font-ui` | Noto Sans SC + Source Sans 3 | 章节名称、实际要素、素材条目、批注正文和普通控件 |

按当前视图中的作用分配字体：故事线在章节列表里负责组织章节，因此用衬线；Review 的分组标题指向某个具体实体，因此用非衬线。结构化编辑器（要素、故事线、类目、章节与构想、素材）稿纸上的节标题（`.page__scene-title`、`.refs-section__title`：「记 · 传」「字段」「关联」「补丁」「要素清单」等）负责组织这一页，所以与 Panel Tab 同用一条结构规则（`interface-fonts.css`）：正体、常规字重，不再是斜体非衬线，字号仍是节标题自己的 `16px`。一节空着时下面那一句（`.ui-section-empty`）是状态，用索引字，见 [components.md](components.md) 的「实体编辑器」。保持字族稳定，选中状态继续使用原有玻璃或砂笔状态，不切换字体。

2026-10-31 把同一条判断推到其余视图：同一种东西在一处是衬线、在另一处也是衬线。故事图谱的泳道名与 Bottom Timeline 的泳道名同是故事线；幕栏上的幕名与稿纸大纲里的幕同是幕（`11px`、中等字重，后面的章数仍是等宽）；作品主页「全书」一节里的故事线与类目和侧栏里的同是组织者，而「继续写」里的章节与要素仍是实体字。目的地也用结构字：Super View 的三个视图名和 Panel Tab 一样是去处，一个字重，选中只看玻璃（同一行里各视图自己的「书序／叙事时」是模式开关，仍是界面字体）；中文的视图名和幕名与 Panel Tab 一样标 `data-script="cjk"` 下移 `0.15em`，在玻璃块里居中，幕名也和后面的等宽章数落在一条线上（判断用 `lib/interface-typography.ts` 的 `CJK_TEXT`，Panel Tab 共用）；设置长页面里每一节的页题（「书桌的光线，由你决定。」）和作品主页的节标题一样组织这一页，与「关于」页的名字同族（`21px`、常规字重）；目录行仍是非衬线、组名仍是等宽。素材树里文件夹之于素材，就像类目之于要素，所以文件夹名是结构字、素材条目是实体字。这几处直接在各自的样式里引用 `--font-structure`（不进 `interface-fonts.css` 的规则表），移动端它回退到界面字体。Group 和 subheader 不再强制大写或拉开中文字距。

现有 Smaller / Standard / Larger 字号设置继续生效；Category 名称使用 body 角色，与次级 Group 的 caption 角色区分。稿纸标题与正文仍沿用独立的 `--editor-font-family` / `--font-content`，保留用户自选和导入字体。此变更只为桌面建立字体角色；移动端保留原字体回退。

字体随应用离线打包，不从字体 CDN 请求。四套可变字体通过锁定的 Fontsource 包提供；更纱等距为上游 1.0.43 完整 Regular 字体的 WOFF2 转换，不做字符子集裁剪。来源、哈希和 OFL 文本在 `src/assets/fonts/sarasa-mono-sc/`，其他字体声明见根目录 `THIRD_PARTY_NOTICES.md` 与 `LICENSES/fonts/`。

## 验证

使用隔离的 `pnpm dev:worktree --instance type-review --no-watch`，在其 devUrl 打开 `/scripts/interface-fonts-ui.html`，点击 **Run font role checks**。页面只使用合成内存数据与真实侧栏、Review、时间线组件。可加 `?capture=1&left=elements` 隐藏验收控件并查看要素面板。

在宽窗口（至少 1000 CSS px）和窄窗口（600–899 CSS px）分别保存 `#interface-font-result` 的原始 JSON，然后生成证据：

```sh
node scripts/check-interface-fonts.mjs --record /tmp/fonts-wide.json /tmp/fonts-narrow.json
pnpm ui:fonts:check
```

[生成的证据](../qa/interface-fonts.json) 覆盖两种语言、明暗主题、三个字号、章节和要素面板，共 48 个组合；验证实际叶节点字体、完整字体加载、中英文等宽字距、正文偏好隔离和移动端回退。浏览器组件证据不等于原生 WKWebView 的栅格效果验收。

2026-10-29 已重新构建隔离的 macOS Debug `.app`，在合成示例项目中目测章节、要素、素材库、Review 与时间线，并切换项目范围的批注和 TODO。原生检查确认本次字体实际随应用载入；不覆盖所有原生窗口尺寸和交互。
