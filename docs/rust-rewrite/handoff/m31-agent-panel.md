# M31 帮手面板与改动显现

先读 [README.md](README.md) 的共用约定和 [m27-agent-runtime.md](m27-agent-runtime.md)。

## 要做的

右栏「帮手」标签里的面板，以及帮手改正文时编辑器里看到的样子。

**面板**
- 对话记录、输入框、上下文用量指示、对话列表。
- 提问卡：M27 的向作者提问在这里显示，作者在这里回答。
- 搜索网页的卡片：M28 的 `provider_tool`。

**首次引导**，作者选的是 A「就地连接」：
- 空对话本身就是引导。
- 没有能用的模型时，显示四个「连接模型」格子：ChatGPT 订阅、DeepSeek、Anthropic、OpenAI。砂印实心表示能用，空心表示没连。
- 粘贴 Key 后测试，通过了才保留，并把对话切到这家。
- 连上以后换成三条「试试」起手请求。
- 第一次有改动的那一轮，显示「本轮改动」的链接和「版本历史」按钮，打开一次后引导结束。
- 面板里只能新增并测试 Key、选已经能用的路由、发起 ChatGPT 登录。编辑和删除 Key 只在设置的「模型与 API」里。
- 详见 `docs/agent-runtime/agent-onboarding.md`。

**思考中的记号**
- 用「星芒」砂笔动画：从点到四道、六道、八道，再到钝头八道，往返播放，每帧 120 ms；想完停在整颗钝头星。
- 推理块的标题用同一套。
- 帧条资源在旧版的 thinking 砂笔图标里，F5 的 `dr-ui` 有砂笔图标的画法。

**改动显现**
- 帮手写入时逐字覆盖显现。
- 之后留下墨色：新增是绿色，改写是紫色；指针碰到才褪去。
- Markdown 文件夹（M40）从外面改进来的，显示为蓝色。
- 编辑器的画层归 F4d：「Agent 墨色」它已经在全书视图里画了。用它的接口，缺的写进「待协调」。

## 旧版

- `src/renderer/features/agent/`（约 3.7k 行）：`AgentMessageViews.tsx`、`AgentComposerConfig.tsx`、`onboarding/`、`desktop/` 等
- `src/renderer/components/editor/AgentEditAnimator.tsx`（651 行）
- 样式 `agent-panel.css`

## 新版放哪、接哪

- 新 crate `next/crates/dr-view-agent`。
- 外壳挂接：F6 正在加右栏帮手标签的登记口（`dr_shell::pages::set_companion` 一类）。没进 `main` 前先把视图写好，最后接。
- 设置里「模型与 API」那一页：设置是声明式的注册表（`dr-shell` 的 settings）。要加的项写进「待协调」，或照现有的写法加在你自己的 crate 里登记。
- 数据和动作都走 M27 的运行时，面板不直接调模型。

## 完成标准

- 用 M27 的假驱动在面板里跑通一轮对话、一次提问、一次写入，墨色显现和褪去都对。
- 首次引导的几种状态都有测试：没模型、粘贴 Key 失败、粘贴成功、第一次改动。
- 调试桥真窗口点一遍。真模型的手测留给作者。
