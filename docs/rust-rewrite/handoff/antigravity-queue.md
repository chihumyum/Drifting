# 原 Antigravity 队列的 Codex 接续

2026-11-08 后续更新：作者已把这条队列交给独立 Codex 接续会话。帮手仍由另一 Codex 会话推进（[codex-queue.md](codex-queue.md) 第一部分），旧模块收尾和整合也各有负责人。沿用已有 worktree 与构建缓存，保护 M22 草稿后先复核 M21，再按下列顺序推进；正式交回由现有整合会话验收。文件名保留以免旧链接失效。

**先读**：
- [README.md](README.md)：共用约定；
- [integration.md](integration.md)：`main` 怎么合，你的分支会被怎么合；
- 每个模块自己的任务书。

## 怎么连着做

照 codex-queue.md 的「怎么连着做」，新接续分支用 `codex/mNN-<名字>`，保留已经交出的历史、不 rebase。要点：
- 每个模块一个分支。开下一个之前先 `git merge main`，再从上一个模块的分支开新分支。
- 每个模块收尾时：
  - 全套检查过了；
  - 模块文档写好，开头写一行「交回状态」；
  - 不合进 `main`，不推送。
- 要作者定的事、要别人加的接口：写进「待协调」，先绕过去，接着往下做。

## 顺序

**一、三个 Super View**

外壳的挂接点已经在 `main` 里：`dr_shell::pages::add_super_view(cx, SuperView::…, |host, window, cx| -> SuperViewPage)`。
- `SuperViewPage` 有 `body`、`head_start`（头部左边，在计数左边）、`head_end`。
- 关系线图例作者定在**内容区右上角**，画在 `body` 里，不放进头部。

1. [M21 故事图](m21-story-graph.md)
2. [M22 要素全景](m22-element-overview.md)
3. [M23 审阅与素材](m23-review-materials.md)
   - 素材库（M19）已经有了：`dr-view-material` 和右栏的 `pages::set_library`。素材卡和素材夹的接口照它的。

**二、账号这一条**

4. [M35 账号与登录](m35-account.md)
5. [M37 偏好同步](m37-preference-sync.md)
6. [M38 分享链接（发布端）](m38-share-links.md)
7. [M36 Hosted 同步 v2](m36-sync-v2.md)：帮手的对话文档（`DocKind::Conversation`）随书同步，本机日志表不上传。

**三、收尾**

8. [M43 Windows 补齐](m43-windows.md)

旧模块收尾已有独立会话负责，不另行认领；确实需要共享接口时按下方协调范围实施并记录。


## 交接状态

- M21 原实现 `ed106b8b`、原结论 `3f240cd5` 仍待复核；当前接续分支 `codex/m21-story-graph-review`。先修实际数据／打开路径，再补真实点击、切轴、拖章、建关系及截图，原文档超出测试的表述一并纠正。
- M22 `786e39a9` 是完整保护原草稿的 WIP 检查点，不是验收交付；恢复后仍须修接口不匹配和真实共现数据，不能把能编译或已有测试函数当作已完成。

## 共享接口协调

以下由接续会话实施并单独交回，整合者只审查、合并；不接管旧模块其余功能，不引入未接收分支。

- **M21/M14 未归线**：可以在 M14 model 公开最小输入构造，让两宿主共用。动作须一次写入、一次撤销，清全部主／副故事线且保留两个轴坐标。当前叙事坐标为 None 也应生效，不能填 0；优先复用已有有效轴的原坐标（叙事坐标为 None 时可回退原 book_order）调用 `chapter.place`，两轴都没有坐标时用既有 `chapter.update` 清成员与 primary、不传坐标。补 None 坐标、多成员、撤销／重做和两个宿主路径；不为 UI 便利扩大 F3 schema。
- **M21/M14 绑定构想**：统一复用 M16 既有卡片／打开能力。旧版是点绑定幕或钉先显示构想卡，再打开正文并退出 Super View；不能只把 `ws.open` 改成直接关闭故事图就称行为一致。若现成接口不够，追加最小公共入口并在 M16 文档记明，M16 转换和偏好等仍由旧模块会话负责。
- **F8 鼠标修饰键**：允许在现有 `input.click`／`input.drag`／`ui.press` 增可选 modifiers，默认保持原事件语义，贯穿真实 GPUI MouseDown／Move／Up；用于真实 Shift-click 建关系，不调用 M21 内部方法代替。补默认无修饰键、指定修饰键和无效参数的桥契约及方法表说明；保持开发特性，发布门禁不变。
- **M22/F3 同段共现**：由接续会话补最小只读 `mention.cooccurrence` 或等价明确命名查询，放在 F3 查询层、复用现成 Reference 索引。按当前书存活 chapter 的 `(source_doc, source_block)` 先去重存活 element，再给每个无序 element 对每段计一次；自动和手动实体链接同为 Link，不能乘 span count，也不混入纯名字 Mention、构想／素材笔记／要素正文。缺失或重复 block id 会产生 None，不能把同篇的 None 合成一段；明确不完整记录的统计边界。不能用 `min(blocks_a, blocks_b)` 推算。
- 新聚合查询不得授予对象／正文写入读取覆盖；保持 book 注入及跨书拒绝。补同段／异段、重复链接、None 段、软删除与跨书过滤契约，以及真实 AgentTools 调用后写入仍 ReadRequired 的边界；机械更新注册表、schema、M29 目录及映射。F3 其他命令和写入恢复仍由旧模块队列负责，冲突在整合时解决，不复制整份旧分支文件。


## M21 原稿的静态接收问题

- `517e445e` 叙事新建仍先 `ChapterCreate` 再 `ChapterUpdate`，形成两项撤销且后半失败会留未放置章。main 的 M14 已用 `ChapterCreate.narrative_order` 一次调用；复用它并补真实撤销／重做及创建期间切书不发生晚到导航。此项接续会话已发现，避免把原文档的完成声明沿用到新交回。
- `marks.rs` 的写入 worker Task 仅存在 `StoryGraph.writes`，销毁该视图会取消未开始的队列任务，回复接收端还把 channel 取消当成成功。普通关闭 Super View 通常只是隐藏缓存，不能声称此路径已实际丢写；整合者当前仅静态核对。请补不依赖视图存活的队列、真实错误 ACK，并接 main 的公共释放门，控制队列阻塞后分别关窗口、换库和退出验证最终持久状态。不能只在截图前等所有修改完成来证明退出安全。
