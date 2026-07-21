# Goal · 一键演化（设定 → 正文 传播）设计

> 作者改了某个 element 的设定后，**一键**让所有把它当 deps 的章节的正文**改去适应新设定**：agent 自己收集 context、自己改，靠一个 **element-scoped 对抗 critic** 边改边验，loop 到矛盾清零或停滞，最后交人批准。
> 这是一个**编辑目标**（coding-agent 式 `/goal`），不是检查任务——它有真正的终止条件（critic 变绿）。
> 配套：[DESIGN.md](DESIGN.md)（canon-truth 模型，提供「正文 vs effective-canon 谁是真理」的裁决基础）、[ELEMENT-ARC.md](ELEMENT-ARC.md)（只读弧线派生，姊妹引擎）。
> **方向辨析**：[DESIGN.md §5](DESIGN.md) 的「一键演化设定」是 **正文 → patch**（把正文里冒出的演化*收*成 patch）；**本文是 canon → 正文**（把已敲定的设定演化*铺*到正文）。同一条演化轴的两个方向,互补。

## 1. 这是什么 / 不是什么

- **是**：给定一次 element 设定改动，找到受影响章节、由 agent 改正文使其 conform，边改边对抗式自验，收敛后交人批量审。
- **不是**：不是「检查这章有没有问题」。检查任务**没有完成度**（recall 开放，永远不知道查全没有）；编辑任务**有验收测试**（critic 绿了就是 done）。`/goal` 适配后者。
- **不是**：不沿用 project review rules 来验（见 §4）；不自动 commit（人是终点，见 §6）。

### 1.1 两个并列入口，不是两个 mode

| 入口                                            | 行为                             | 语义               |
| ----------------------------------------------- | -------------------------------- | ------------------ |
| **纯 review**（shadow panel 现成的一键）        | 只检测、不改                     | 「我自己解决矛盾」 |
| **一键演化**（element editor 新增，arc 派生旁） | agent 跑 review→edit loop 主动改 | 「帮我改」         |

只想看不想改 → 用已有的 review 按钮，不进本功能。本功能**永远主动改**，没有「review-only」子模式。

## 2. 为什么是编辑任务（终止条件论证）

coding-agent 的本质循环：`edit → 跑测试 → 红 → fix → 绿 → done`。本功能里 **editor = generator，critic = 测试**。
检查任务的「done」只是「我看过了」（无法判定看全）；编辑任务的「done」是 **critic 变绿**——一个客观停机信号。
把编排放进 editor、用一个 scoped critic 当验收，才是完整的 plan→act→verify→replan→terminate。

## 3. 范围：base 改动 vs patch 改动

取用户**实际改了什么**来定 scope，不 funnel、不还原：

| 用户改了                                      | 含义                      | scope                              |
| --------------------------------------------- | ------------------------- | ---------------------------------- |
| **base 字段**（summary/contentJson/kvJson/…） | 全书都成立的设定 / retcon | **所有** deps-on-E 章（from ch.1） |
| **某条 patch**                                | 从该 patch 章起的演化     | deps-on-E 且 `order ≥ patch 章`    |

改 base = 你就是要全书纠偏（早章被改去 conform 正是意图）；要「中途才变」就用 patch。两个 affordance 各司其职。
`effectiveFrom` = base→1 / patch→`sourceNarrativeOrder`；scope = `deps-on-E` 按 `effectiveFrom` 过滤。

## 4. 核心解耦：in-loop 判据 ≠ project rule sweep

**这是本功能与现存 shadow review 链路的关键分界。**

### 4.1 为什么必须解耦（收敛性，不只是效率）

若 loop 的验证沿用「整套 project rule 跑过」，停机条件就成了「这章通过所有规则」。
一旦某章本就有一条**与本次演化无关的旧违规**，这章永远绿不了 → **loop 永不终止**，或 agent 去改用户没要它碰的东西。
所以演化 loop 的判据**必须** element-scoped。这是正确性问题。

### 4.2 共享底座，只 fork 判据

|          | 内容                                                                          | 出处                                                                                                         |
| -------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **复用** | deps 章发现（X 在哪些章出场）                                                 | `listBacklinksToTarget('element', id)` [inline-mention-repo.ts:68](../../sqlite-repo/inline-mention-repo.ts) |
| **复用** | FC 跑环骨架 + 只读 tool registry（`submit_verdicts`/`basis` 纪律）            | [shadow-rules.ts](../ai/shadow-rules.ts)                                                                     |
| **复用** | effective-canon 解析（`effective_canon(E, N)`，安全检查要用）                 | `shadowEffectivePatchesText` [tool-handlers.ts:1846](../agent/tool-handlers.ts)                              |
| **复用** | 叶层取证（读段、搜证 provider）                                               | `buildShadowEvidenceProvider` [tool-handlers.ts:2008](../agent/tool-handlers.ts)                             |
| **Fork** | 判据：不迭代 project rules，换成一条 **bespoke E-scoped critic**              | 新建                                                                                                         |
| **Fork** | 验证单元：不复用「一章一过、所有 rule、写 comment、翻 status」                | 新建                                                                                                         |
| **Fork** | **不写 shadow comment、不翻 chapter status**；verdict 只在内存回 orchestrator | ——                                                                                                           |

> `rule` 不复用、`一轮验证`不复用——但 **effective-canon 的能力不能扔**（它是 canon-truth 这条「规则」的内核，安全检查 4.3(b) 要它）。复用的是那个**解析函数**，不是 rule config。

### 4.3 in-loop critic 的两个职责

给定 E 的 `old→new` 设定 + （已编辑的）prose，返回「仍与新设定矛盾的 spot 集」：

1. **正向**：E 的改动该应用的地方应用了吗（原来矛盾的点消解了吗）。
2. **安全**：这次编辑**有没有违反 E 自己的 `effective_canon`/patch**（把 ch.13 改失明，却撞了 ch.14「短暂复明」patch）。

**跨 element 的附带损伤（编辑撞了*别的*角色/事实）不放进 loop。** 让被动链路兜：演化跑完、这些章被编辑 → 自然 stale → 现存全量 shadow review 照常 re-review 抓出来。
**全量链路退出 loop，但仍是免费的事后安全网。** loop 干净，安全没丢。

### 4.4 「是否到位」必须锚到矛盾，否则不收敛

「改动到位了吗」若做成开放式（「这场景能不能更体现失明」），critic 永远能说「还能更」，**无不动点、loop 不停**。
所以判据落在**可证伪**的那半：**「与新设定矛盾的 spot 是否清零」**，不是「是否充分体现」。
`到位 = 没有残余矛盾`，不是「最大化体现」。这样 §6 的严格收缩判据直接成立。
**额外好处**：收缩集就是这条 critic 直接吐的 spot 集，干净、E-scoped——比从一堆 project-rule comment 里 filter 关于 E 的部分准多了。

### 4.5 critic 预载（perf）

E 的**全量当前内容** + **本章 effective-canon(patch)** 由 orchestrator 预先喂进 critic context
（`runEvolveCriticBatch(preloadElementId)` → `SemanticEvalContext.preloadedCanon`，[tool-handlers.ts](../agent/tool-handlers.ts) `buildPreloadedElementCanon`），
省掉每章一次 `read_element` + `get_element_patches`。判据不变、只是把要查的料预先放桌上——实测前每章吃 8.5–14.5k input、2–32s，多在现查同一个 E。

## 4.6 两道前置闸：改动分类 + 爆炸半径（scope 前）

并非所有改动都适合 loop。scope 前先过两道便宜的闸（都 `force:true` 可越）：

**① 语义闸（改动分类）** —— 一次便宜 LLM 调用，只看 `(field, old→new)` diff（element-agnostic：角色/地点/物件/规则…），三分（[goal-change-classify](../ai/prompts/templates/goal-change-classify.ts) v3）：

| 类        | 判据                                                                         | 行为                                                |
| --------- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `factual` | 离散、正文具体语句能直接证伪（失明/改名/搬迁/能力取消）                      | 放行进 loop                                         |
| `essence` | 对本质/神韵/性质的根本改写（性格重塑/氛围重定/调性重构），弥散、无字面硬矛盾 | **不自动改**（定位）                                |
| `mixed`   | 二者皆实质且可拆                                                             | **拆**：`factualPart` 进 loop，`essencePart` 留人工 |

判别轴 = **离散可证伪 vs 弥散本质**。为什么 essence 必拦：critic 是 contradiction-anchored 的（§4.4，正是它准的原因），对 essence **系统性漏检** → best-effort 会 silently 报「假性 done」。**实测验证**：米拉「性格」改动 5 章 critic 全 pass。

**essence ≠ 裸拦，而是「定位不自动改」**：跑 `scopeAppearances`（纯 mention 反查，**不跑 critic**）→ `result.worklist` = E 的**全部出场**章 + mention block 定位，作为**逐场重构清单**交作者。给诚实的**完整出场集**，不是 contradiction-critic 漏检后的残缺清单（否则只是把假性 done 转嫁作者）。**不**用 critic fanout 去找 essence。

**mixed → 拆分**：orchestrator 用 `effective`（`newSetting = factualPart`）喂 loop，只消解事实那半的硬矛盾；`essencePart` 进 `result.note` 留人工。防滥用：仅当本质成分实质且可单独成句才判 mixed，否则 factual。

**② 爆炸半径闸** —— round-0 探完，命中冲突的章 ≥ 阈值（默认 10）→ `needs-confirmation`，停在预览、不自动开改，作者确认后 `force` 续跑。它**只对 factual 的「宽」有效**；essence 的弥散漏检它抓不到（靠语义闸前置兜）。

## 5. Loop（编排）

**挂在 renderer**（`lib/goal/orchestrator.ts`）：它碰的 data store / repos / edit-store 全在 renderer，Shadow 直接复用 renderer runtime；General Agent 则通过可替换 transport 接入。
**确定性外环 + 两个 model 叶**：editor agent（generator）、E-scoped critic（discriminator）。

```
Phase 0  Intake      取 (E, origin: base|patch, fieldDiff)；origin 定 effectiveFrom
Phase 1  Scope       listBacklinksToTarget(E) ∩ {order ≥ effectiveFrom} = 候选集 C
Phase 2  Detect      对 C 跑 E-scoped critic → 矛盾 spot 集 S（候选 ≠ 工作清单，critic 筛出真要改的）
Phase 3  Resolve     ┌ 按章流水线（轮内无屏障）：每章 edit → 改完【立刻】verify，
                     │ 同时下一章的 edit 已在跑（edit / critique 两条独立并发 lane）
                     │ runShadowEditTurn(promptFor(ch, E.old→new, spotsOf(ch)))
                     └ 全章汇齐 → 严格收缩判据（§6）：清零 / 上界 / 停滞 → 退出
Phase 4  Terminate   所有编辑 pending 在 edit-store；批量交人审（§6）
```

- **review 起手**：loop 从一次 critic 开始（editor 得先知道「改哪」）。
  _（备选：edit-first 盲改全部 deps 再验——覆盖更全但更贵、会动没问题的章。v1 默认 review 起手。）_
- **`runShadowEditTurn`**：renderer 内运行受限 function-calling editor，调用同一套 `runAgentTool` 写工具，再从 [agent-edit-store.ts](../../store/agent-edit-store.ts) 收集本轮改动；无需额外进程或 IPC。
- **编辑落 live Yjs**：`writeEntityProse` [chapter-prose.ts:497](../agent/chapter-prose.ts)，agent 按 **name** 引用实体 [tool-entity-ref.ts](../agent/tool-entity-ref.ts)。
- **editor 引擎**：当前 Tauri 版本固定使用 `shadow-fc`，跑在 Shadow provider（BYOK 一致、零 Anthropic SDK 依赖；文笔受所选 Shadow 模型限制）。`runShadowEditBatch`（[tool-handlers.ts](../agent/tool-handlers.ts)）使用 tiny 写工具集 edit_block/edit_blocks/finish_edits，经 `runAgentTool` 落 live Yjs。`agent-sdk` 仅作为旧设置值与未来 transport 的兼容 token，hydrate 时会自动迁为 `shadow-fc`。
- **edit-mode 按模块分流**：evolve 编辑记 `shadowEditMode`（默认 `approve`，批量+critic 可错），不是 general agent 的 `agentEditMode`。机制：`setAgentEditModeOverride`（[agent-edit-mode.ts](../agent/agent-edit-mode.ts)），写路径 `.record` 读 `effectiveAgentEditMode()`。
- **`approve` 模式**：编辑只 stage，不 auto-commit，留给 §6 人工闸门。
- **并发=两条 lane + 按章流水线**：`makeLimiter` 信号量两条——edit lane（`shadow-fc`=3 跨章独立 fan-out）和 critique lane（=5，只读）。轮内**无 edit/verify 屏障**：一章改完立刻进 critique lane 验，同时 edit lane 已在改下一章。轮与轮之间仍有屏障（收缩判据要全集）。
- **手动停止**：`AbortSignal` 一路穿到两叶 + critic/edit FC batch；STOP 即中止在途 model 调用，loop 以 `stopReason:'aborted'` 收尾，**已 stage 的改动保留待审**（不回滚）。
- **草稿过滤**：`includeDrafts`（默认 false，镜像 arc 派生）——只把 `writingStatus==='finished'` 的章纳入 scope，不改半成品草稿。
- **只动 chapter**：scope 显式 `isChapter(node)` 闸——drift 节点（自由灵感）永不自动改。不能只靠 writingStatus 滤（drift 的 'drifting'/'resting' 只是碰巧不等于 'finished'，含草稿章一开就漏进来）。
- **结果只报本次**：scope 后先 `pendingSnapshot`（每章已 pending 的 blockId 集），`harvestPending` 只报快照外的新增——上一轮未审完的暂存不再混进下一轮的结果 UI。
- **过程可检视（trace）**：`EvolveOpts.onTrace` 流式收 `EvolveTraceStep{round, phase, chapter, actor, step}`——critic 的查证/裁决轮（FC judge 原生 `AgenticTraceStep`）+ Shadow-FC 的 edit_block/edit_blocks/finish 摘要。evolve-store 按 element 收（cap 800），UI「过程」面板跑时自动展开、跑完折叠待查。
- **运行态 per-element**：run/phase/result 存 `evolve-store`（keyed by elementId，非组件局部 state）→ 每个 element editor 各看各的演化、切换不串台、跑动中离开再回来仍在。AbortController 存组件外 Map（非渲染态）。
- **持久化**：给 `shadow_job` 加一种 kind（`evolve`）或新 `goal_run` 行，白嫖 durable 队列 + trace + 顶栏 pill，支持长跑/重启续跑 [job-recorder.ts](job-recorder.ts)、[shadow-job-repo.ts](../../sqlite-repo/shadow-job-repo.ts)。

## 6. 终止 / 收敛 / 交人

- **上界 `MAX_ROUNDS = 3`**（可配 2–4）。每轮 = 受影响章一整轮 编辑+验，很贵；1–2 轮不敛的残余基本要人判断或在乒乓，封顶保证终止。
- **严格收缩用集合，不用裸计数**。每个 spot 给稳定 key（`chapterId : sortedBlockIds : aspect`）。停机三选一：`S` 空（✓成功）/ 到上界 / `|S| ≥ 上轮`（没净收缩 → 停）。
- **新引入的矛盾 = 回归信号**：`本轮S \ 上轮S` 单列给人——出现新 key 表示本轮编辑制造了新矛盾，强停滞信号。
- **终点交人，不 auto-commit**。critic 是可错的 LLM，「绿」只是*候选 done*。loop 结束 → 所有 pending 编辑 + 残余未解矛盾，进**批量 soft-approval**（复用现成的 colored ticks / reveal / approve✓✗）。人批准/驳回，per-block 或整批。
- **失败隔离 + 重试**：单章 critic/editor 抛错（如 DeepSeek-flash 偶发非法 tool-JSON）只**隔离该章**（记进 `result.errors`、批继续），不拖垮整批；底层 `isRetryable` 现放过 `parse`（非法 JSON 是随机抖动，重采样即恢复，realizes provider repair-note 的「retry 兜这类」意图）。

## 7. 接管 / staleness / 防双跑

- **点演化即接管**：关掉 shadow panel 那条「deps 变动需 review」提示，由 loop 接手；接管期间 `/goal` **own 住这些章的 review**，别让被动提示/手动 review 重复触发。
- **staleness 是算出来的，不是存的**：`entity.updatedAt > 上次 review.finishedAt`（[useStaleReviews.ts:45](../../usecase/useStaleReviews.ts)）。没有「清」的 API——**一次 fresh 完成的 review 把 baseline 推后即自然消**。
- **权威清算 review 跑在人批准之后**：否则中途 review 会给「后来被驳回的编辑」一个假的已清 baseline。
- **两条路径不撞车**：
  - **base 改动**：被动 staleness 会 fire（base 字段动了）→ `/goal` 接管并在收尾清掉。
  - **patch 演化**：base 没动、patch 新增不被 staleness track → 被动**根本不 fire** → `/goal` 是唯一驱动者，零撞车。
- _（latent 改进：让 staleness 也对 patch 生效区间敏感。out of scope v1——orchestrator 自己 own scoping，不依赖它。）_

## 8. 触发 / UX

- **入口**：element editor 里、arc 派生功能旁，一块「**你改动了 〈字段〉**」提示 + 「一键演化」按钮。
- **「你改动了 X」**：需算「这个 element 自上次演化以来改了哪些字段」的 diff。存个 **per-element last-evolved 基线** 即可（小活）。base 起源天然挂这里；patch 起源的演化以后挂 patch 旁，喂同一 orchestrator，只是 origin/scope 不同。
- **审稿**：完全复用 agent-edit-review（[agent-edit-store.ts](../../store/agent-edit-store.ts)）——批量呈现触发章的 block diff，作者 approve/reject。

## 9. 复用图（别重造）

| 需要                                        | 复用                                                         | 位置                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| work-list（E 在哪些章出场）                 | `listBacklinksToTarget('element', id)`                       | [inline-mention-repo.ts:68](../../sqlite-repo/inline-mention-repo.ts)                                                         |
| critic 的 FC 骨架 / 只读工具 / `basis` 纪律 | `evaluateSemanticAssertionsFC` 模式 + `SUBMIT_VERDICTS_TOOL` | [shadow-rules.ts](../ai/shadow-rules.ts)                                                                                      |
| 安全检查基线 `effective_canon(E,N)`         | `shadowEffectivePatchesText`                                 | [tool-handlers.ts:1846](../agent/tool-handlers.ts)                                                                            |
| critic 取证 provider                        | `buildShadowEvidenceProvider`                                | [tool-handlers.ts:2008](../agent/tool-handlers.ts)                                                                            |
| editor 叶（程序化跑一轮编辑）               | Shadow-FC + `runAgentTool` + 读 edit-store                   | [run-shadow-edit-turn.ts](../goal/run-shadow-edit-turn.ts)、[agent-edit-store.ts](../../store/agent-edit-store.ts)            |
| 落正文（live Yjs）                          | `writeEntityProse`                                           | [chapter-prose.ts:497](../agent/chapter-prose.ts)                                                                             |
| 实体按名解析                                | tool-entity-ref                                              | [tool-entity-ref.ts](../agent/tool-entity-ref.ts)                                                                             |
| 批量审稿 UI                                 | agent-edit-review store                                      | [agent-edit-store.ts](../../store/agent-edit-store.ts)                                                                        |
| 编排/持久化/trace/通知/续跑                 | `shadow_job` 加 `evolve` kind                                | [job-recorder.ts](job-recorder.ts)、[shadow-job-repo.ts](../../sqlite-repo/shadow-job-repo.ts)                                |
| 事后跨-element 兜底（全量链路）             | renderer Shadow runtime（退出 loop，仅事后跑）               | [runtime.ts](runtime.ts)                                                                                                      |
| base/patch origin & scope                   | element 改动事件 / patch 时间轴位                            | [useBookElement.ts:185](../../usecase/useBookElement.ts)、[element-patch-repo.ts:30](../../sqlite-repo/element-patch-repo.ts) |

## 10. 验证：critic 可 eval，loop 靠 spike

- **critic 那半是 detector** → 可 eval。合成一个 **evolution corpus**：拿干净章，定义一次 element 改动，注入若干「与新设定矛盾」点，看 critic 召回 + loop 是否在 ≤3 轮把注入的矛盾清零并收敛。复用 shadow eval 的 fault-injection 思路。
- **编辑保真那半无 ground truth**（同 [ELEMENT-ARC §10](ELEMENT-ARC.md)：advisory 编辑，质量靠眼睛）→ **在一个真实例子上（Aria 从某章失明）把 loop 跑通、肉眼验**：改得最小吗？没瞎动无关段吗？收敛吗？
- 人工 soft-approval 是最终闸门——eval 提质量底，不替代终审。

## 11. 开放问题 / 风险

1. **触及范围 = critic 的 recall**：critic 漏检的矛盾不会被改。可接受（优雅降级，漏的人还能用纯 review 兜）；critic 用 `basis`-forcing + E-聚焦提质。
2. **乒乓 / 不收敛**：靠集合严格收缩 + 3 轮上界 + 回归 spot 单列兜底（§6）。
3. **讨好 critic（reward hacking）**：每轮 critic **对整个 scoped 集重验**（非「你处理我那条没」），editor 没法靠改被点名段、暗破兄弟段过关。
4. **跨-element 附带损伤**：不进 loop，靠事后全量链路 + 人审（§4.3）。
5. **edit-first 备选**：覆盖更全但贵、会动无关章；v1 不做。
6. **「你改动了 X」基线**：需 per-element last-evolved 快照，注意与多次连续编辑的去重。

## 12. 现状（已建 / 未建）

**已建**（renderer `lib/goal/`，typecheck+lint clean；devtools `__goalEvolve` 手动跑过、并接入 element editor UI）：

- 核心循环 `orchestrator`（scope→critic→edit→re-critic，集合严格收缩 / 3 轮）、E-scoped `critic`（复用 FC 骨架 + judgingGuide 注入 + effective-canon **预载**）、editor 叶 `runShadowEditTurn`、`scope`/`scopeAppearances`。
- 两道前置闸（§4.6 语义三分 + 爆炸半径）、essence **worklist**（定位不自动改）、mixed **拆分**。
- 失败隔离 + `parse` 重试（§6）。
- **UI**：element editor `ArcSection` 旁挂 `EvolveSection`（自动检测改动字段 → 演化 → overview + 需手动清单）。
- **实测**：critic 找矛盾准；essence 漏检验证 → 语义闸必要。

**未建**：durable `evolve` job（长跑/续跑/顶栏 pill）、base/patch origin 自动判定（现 UI 走 base→全书）、接管/关 shadow 提示（§7）、批量审导航接线（编辑已落 soft-approval，但无「集中审」入口）、edit-first 备选、classifier/critic 的 eval。

## 13. 真实锚点（文件）

| 角色                                                      | 位置                                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| element canon（summary/body/facts）                       | `BookElementTable` [drizzle.ts](../../schema/drizzle.ts)、改动事件 [useBookElement.ts:185](../../usecase/useBookElement.ts)                                  |
| work-list：element → 引用章                               | `listBacklinksToTarget` [inline-mention-repo.ts:68](../../sqlite-repo/inline-mention-repo.ts)                                                                |
| critic 骨架（FC / submit_verdicts / basis）               | [shadow-rules.ts](../ai/shadow-rules.ts)                                                                                                                     |
| effective_canon(E,N)（critic 安全检查基线）               | `shadowEffectivePatchesText` [tool-handlers.ts:1846](../agent/tool-handlers.ts)                                                                              |
| critic 取证 provider                                      | `buildShadowEvidenceProvider` [tool-handlers.ts:2008](../agent/tool-handlers.ts)                                                                             |
| editor 叶 / 落 Yjs / 按名解析                             | [run-shadow-edit-turn.ts](../goal/run-shadow-edit-turn.ts)、[chapter-prose.ts](../agent/chapter-prose.ts)、[tool-entity-ref.ts](../agent/tool-entity-ref.ts) |
| 批量审稿                                                  | [agent-edit-store.ts](../../store/agent-edit-store.ts)                                                                                                       |
| 编排/trace/持久化（加 `evolve` kind）                     | [job-recorder.ts](job-recorder.ts)、[shadow-job-repo.ts](../../sqlite-repo/shadow-job-repo.ts)                                                               |
| staleness / 接管                                          | [useStaleReviews.ts:45](../../usecase/useStaleReviews.ts)                                                                                                    |
| 事后跨-element 兜底                                       | [runtime.ts](runtime.ts)                                                                                                                                     |
| canon-truth 裁决基础 / 方向辨析                           | [DESIGN.md](DESIGN.md)                                                                                                                                       |
| **本功能实现** orchestrator/scope/critic/editor/分类/预载 | [lib/goal/](../goal/)                                                                                                                                        |
| 改动分类器（语义闸）                                      | [goal-change-classify.ts](../ai/prompts/templates/goal-change-classify.ts)                                                                                   |
| critic substrate（复用 FC + 预载）                        | `runEvolveCriticBatch` [tool-handlers.ts](../agent/tool-handlers.ts)                                                                                         |
| UI 入口                                                   | `EvolveSection` [components/editor/EvolveSection.tsx](../../components/editor/EvolveSection.tsx)（挂在 `ElementEditorView` `ArcSection` 后）                 |
