# Antigravity 的连续任务队列

2026-11-08。Codex 在做帮手那一条（[codex-queue.md](codex-queue.md) 第一部分）。Codex 队列里原来排在后面的三部分（Super View、账号、Windows）改由 Antigravity 做，两边同时进行，互不等待。

**先读**：
- [README.md](README.md)：共用约定；
- [integration.md](integration.md)：`main` 怎么合，你的分支会被怎么合；
- 每个模块自己的任务书。

## 怎么连着做

照 codex-queue.md 的「怎么连着做」，只有一处不同：分支名用 `antigravity/mNN-<名字>`。要点：
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

做完这些还有余力，就从 [remaining.md](remaining.md) 里挑。挑之前在这个文件末尾写一行你接了哪一项，免得和别人撞。
