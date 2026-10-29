# 字体按信息角色分工

2026-10-29 采用作者选定的 A 方案。字体表达信息结构，不给每个面板另设风格。

| 角色 | 中英文字体 | 用途 |
| --- | --- | --- |
| 结构 `--font-structure` | Noto Serif SC + Newsreader | Panel Tab、故事线、要素 Category、时间线故事线轨道名 |
| 索引 `--font-mono` | 更纱等距 SC / Sarasa Mono SC | Panel subheader、数量、筛选、Category 下的 Group、状态与元数据 |
| 实体 `--font-sans` / `--font-ui` | Noto Sans SC + Source Sans 3 | 章节名称、实际要素、素材条目、批注正文和普通控件 |

按当前视图中的作用分配字体：故事线在章节列表里负责组织章节，因此用衬线；Review 的分组标题指向某个具体实体，因此用非衬线。保持字族稳定，选中状态继续使用原有玻璃或砂笔状态，不切换字体。Group 和 subheader 不再强制大写或拉开中文字距。

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
