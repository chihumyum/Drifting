# Codex 的连续任务队列

2026-11-08。M27 已经审过、合进 `main`（第十七批）。从这里起不用每做完一个模块就停下等：照下面的顺序一个接一个做，做完一个就提交、写好文档，接着做下一个。共用约定照 [README.md](README.md)；每个模块的要求看它自己的任务书。

## 怎么连着做

1. **每个模块一个分支**，名字照 `codex/mNN-<名字>`。
   - 开下一个之前先 `git merge main`（监管会话随时在往 `main` 里合东西），再从**上一个模块的分支**开新分支。
   - 这样后一个能用前一个的代码，不用等监管会话合完。
   - 不 rebase 已经交出去的提交。
2. **每个模块收尾的时候**：全套检查（README 里那四条加 `pnpm public:check`）都过了；模块文档写好；在文档开头写一行「交回状态」，写清分支、最后一个提交、还差什么。
3. **碰到要作者定的事，或者要别的会话加接口**：写进模块文档的「待协调」，先用最小的办法绕过去，接着往下做。只有整条链都卡住才停下。
4. 作者会不时把做好的分支转给监管会话合进 `main`。你在下一个模块开始时 `git merge main` 就能拿到。合的时候整合分支上改过的地方，以 `main` 为准。

## 顺序

**一、帮手这一条（先做完这一条）**

1. [M28 模型接入](m28-model-providers.md)
   - M27 的运行时现在一个 Runtime 绑一个驱动。这里要加「每次运行带一份不可变的路由和配置」：用哪家、哪个模型、思考档位。不要在每一轮去读可能被界面改过的全局设置。
   - 作者设置里的「帮手单轮迭代上限」经这份配置传给 `max_model_rounds`。这项设置会跟账号同步（M37）。
2. [M29 工具](m29-agent-tools.md)
3. [M31 帮手面板与改动显现](m31-agent-panel.md)
   - 外壳的挂接点已经在 `main` 里：`dr_shell::pages::set_companion(cx, |ws, window, cx| -> LeftPanel)`。
   - 运行时的生命周期照 M27 文档「外壳里的挂接点」那节：库打开后建 Runtime 并 `recover()`；切库、退出前中止并等所有运行结束。
   - 中断状态、没应用的插话要在面板上显现。
4. [M32 MCP](m32-mcp.md)
5. [M30 长任务、记忆与主动建议](m30-long-tasks-memory.md)
   - 主页放卡的位置要 M01 那一路给。没给之前，先把卡放在帮手面板的空对话里，并写进「待协调」。
6. [M33 生图](m33-image-generation.md)
7. [M34 语音口述](m34-dictation.md)

**（2026-11-08 改：下面二、三、四交给 Antigravity，见 [antigravity-queue.md](antigravity-queue.md)。Codex 做完第一部分以后，看 [remaining.md](remaining.md) 和 [integration.md](integration.md)，按作者的安排接整合或剩下的活。）**

**二、三个 Super View**

外壳的挂接点已经在 `main` 里：`dr_shell::pages::add_super_view(cx, SuperView::…, |host, window, cx| -> SuperViewPage)`。`SuperViewPage` 有 `body`、`head_start`（头部左边，M22 的群岛 / 关系切换器放这里，在计数左边）、`head_end`。注意：关系线图例作者 2026-11-03 定在**内容区右上角**，不在头部；由模块画在 `body` 里，不要放进 `head_end`。

8. [M21 故事图](m21-story-graph.md)
9. [M22 要素全景](m22-element-overview.md)
10. [M23 审阅与素材](m23-review-materials.md)

**三、账号这一条**

11. [M35 账号与登录](m35-account.md)
12. [M37 偏好同步](m37-preference-sync.md)
13. [M38 分享链接（发布端）](m38-share-links.md)
14. [M36 Hosted 同步 v2](m36-sync-v2.md)：帮手的对话文档（M27 的 `DocKind::Conversation`）随书同步，本机日志表不上传。

**四、收尾**

15. [M43 Windows 补齐](m43-windows.md)

## M27 审查的结论

监管会话看过 M27，整体照合，不用返工。事件日志先落盘、对话投影可重放、写入后才进终态、只在付费生图和外部插件时问作者，这几条都和任务书一致。

你在「待协调」里提的两件事已经转给对应的会话审：
- F1 审 `DocKind::Conversation` 和它的不变量；
- F2 审迁移 `0007_agent_runtime`。

有意见会写进 m27 文档，或者直接在 `main` 里改。下一个模块开始时 `git merge main` 就能看到。
