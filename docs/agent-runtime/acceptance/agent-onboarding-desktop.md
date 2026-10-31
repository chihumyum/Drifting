# Agent panel first run: desktop acceptance (2026-10-31)

Feature: [`../agent-onboarding.md`](../agent-onboarding.md). Branch
`claude/agent-onboarding`, Debug build of that checkout, isolated profile
`seed-lite-v2` (`pnpm dev:seed:lite --no-watch --frontend-debug` with
`pnpm drifting frontend serve --platform desktop`). DOM-level checks through
the renderer debug bridge; the desktop bridge captures no pixels. The profile
had the development `.env` keys for DeepSeek and OpenAI and none for Anthropic
or a ChatGPT sign-in.

| Journey | Observed |
| --- | --- |
| Fresh profile, sample book open, Agent tab, DeepSeek selected | Step `new`; the empty conversation shows 「试试」 with 「给「第一章 潮声」留两条批注」「把「第一章 潮声」开头一段改紧凑些」「理一理林潮和老船长的关系」 |
| Composer switched to Anthropic (no key) | 「连接模型」: ChatGPT 订阅 (hollow, 实验), DeepSeek and OpenAI (solid, `.ENV (DEV)`), Anthropic (hollow); no 「前往设置」 bar; send disabled |
| Open the Anthropic cell | Password field focused, 「连接」 disabled until text, 「获取 API Key」 text button; the field starts at the name column (31px); the open cell's ring is hidden away from the pointer |
| 「连接」 with a throwaway value while `navigator.onLine` is false | 「请求失败（provider 不可用或网络问题）」; Keychain has no Anthropic key afterwards; selection still Anthropic; no request left the machine |
| Click the OpenAI cell (`.ENV`) | Composer routes to OpenAI 5.6 Sol; the view turns to 「试试」 under a line naming OpenAI and the model |
| Pick 「把「第一章 潮声」开头一段改紧凑些」 (DeepSeek Flash) | Sent as the author's message, composer cleared, step `change`; the live turn revised the chapter |
| Turn finished | 「本轮改动 · 第一章 潮声 已改」 with `glass--waiting`, and 「版本历史」 beside it |
| 「版本历史」 | Snapshot history opens for 第一章 潮声; step `done`; the link stops waiting and the button leaves |
| Restore point (after the coordinator change) | A second edit turn on 第二章 北岬 left one history row: the replaced state (4,939 字; the chapter is 4,900 after the edit) with 「恢复…」. Before this change the same dialog read 「暂无快照」 |
| Settings → General Agent → 对话配置 | 「管理 API Key」 and 「重新显示首次引导」; pressing it sets step `new` and disables it; a new conversation shows 「试试」 again |
| Started conversation, composer on Anthropic | No onboarding; the original 「尚未填写所选 provider 的 API Key…」 bar with 「前往设置」 |

Not covered: a real Anthropic or OpenAI key typed into the field (the success
path is covered by `connect-agent-provider.test.ts` and by the `.env`
selection above), a real ChatGPT device sign-in, pixel rendering in light and
dark (no screenshots on the desktop bridge), and a fresh installation that
has never been seeded.
