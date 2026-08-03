# Shadow · Canon-Truth 模型设计

> 决定「正文与设定冲突时，谁是真理」的核心模型。替代判官当前「发现冲突→自己脑补成有意→静默放行」的行为。
> 配套：判官改造、时序有效-canon、一键演化（复用 copilot patch-gen）、规则→LLM 增强管线。

> Runtime 基线：semantic judge 是 canonical `AgentRuntime` 的只读 Shadow profile，
> 通过 `runShadowAgentRuntime` 安装只读工具、预算与 `submit_verdicts` completion tool。
> Shadow 不再维护独立 provider round loop；详见
> [shared-shadow-runtime.md](../../../../docs/agent-runtime/shared-shadow-runtime.md)。

## 1. 问题

判官把裁决坍缩成 pass/flag，并自己**猜意图**。真章实测（269 段 / 8 角色，rule「角色言行须与设定一致」）：
判官 `read_element` 查全了所有角色、`【一致性复核提示】` 把米拉「从来不哭/能力从不失败」的 diff 喂到眼前，
**仍 `violations:[]` 零理由放行**——它用「正文里有退化弧」当借口自我说服。根因不是信息缺失，是**裁决姿态**：
判官替作者决定了「这是有意为之」。

## 2. 核心模型

- **canon = 真理**：element 的 `summary` / `body`(contentJson) / `facts`(kvJson) 是作者**慎重敲定的设定**，等价于 spec。
- **element_patch = 唯一合法的演化通道**：正文要偏离 canon，**只有一种被许可的理由——存在一条记录该演化的 patch**（弧线只由 patch 承载）。
  - 例：body 写「Jack 12 岁 1.5m」；patch 写「Jack 16 岁 1.8m（第 N 章）」= 演进。
- **偏离路由**（判官的新裁决规则）：

  | 情形 | 裁决 |
  |---|---|
  | 正文与 canon 冲突 **且有生效中的 patch 解释** | 通过（合法演化） |
  | 正文与 canon 冲突 **且无 patch 解释** | **报出（never false negative）** |

  关键：**正文内部的弧线铺垫不算数**（退化弧、「这一次」、伏笔回收都不行），**只有作者写下的 patch 算数**。
  这焊死了判官的逃生门。

- **statefulness 是涌现的，不需要给 fact 打标**：作者从不 patch 的 fact 自然表现为不变量；一旦 patch，它就是状态量。
  作者**用「写不写 patch」来声明演化**。
- **SWE 心智模型**：canon = spec，patch = spec 的版本化演进提交，正文 = impl；**无对应 patch 的 impl-偏离 = 必须报的编译错误**。
  「改 prose 还是改 spec」由作者定，CI 只负责把不匹配摆出来，不自己偷偷选。

## 3. 时序：第 N 章的「有效 canon」（correctness 基础，先做）

patch 锚在一个 source 章节（`sourceNodeId`），语义是「**从该章起生效**」。章节带 `narrativeOrder`/`bookOrder`（叙事时间轴）。所以：

```
effective_canon(element, N) = body/facts + 所有 (source 章 narrativeOrder ≤ N) 的 patch，按序叠加
```

- 判官拿正文比的是 **effective_canon(·, N)**，不是静态 body。
- **晚弧 patch 不能赦免早章矛盾**（第 20 章「变强了」不能解释第 5 章的矛盾）。闪回/倒装靠这条自然吃掉。
- **要补的缺口**：`getElementPatches`（[tool-handlers.ts:871](agent/tool-handlers.ts) 附近）当前只回 `sourceChapter`（章标题）+ body + createdAt，**不带时间轴位置**。
  需补 source 章的 `narrativeOrder`/`bookOrder`，判官才能筛出「≤N 生效」的 patch。

## 4. 判官改造（治「病 B：看见却合理化」）

- 一致性类检查：对每个登场实体，比对其**言行 vs effective_canon(实体, N)**。
- 命中冲突时：**必须**查 `get_element_patches`；若无 ≤N 生效的 patch 解释 → **报出（advisory）**。
  **绝不放过无 patch 背书的 canon 冲突**；正文内部的弧线叙述**不是许可**。
- 在 `basis`（已落地，[shadow-rules.ts](ai/shadow-rules.ts) `SUBMIT_VERDICTS_TOOL`）写明：核对了哪条 canon 字段 vs 哪几段、**有无生效 patch**、结论。
- **区分叙述层 vs 角色口中**：角色撒谎（芮塔嘴说「我从不骗人」而设定狡诈）**不是** canon 冲突；只有叙述确立的事实才算。
- **两种失败别混**：
  - **病 A 检出漏**（判官没看见冲突）→ 靠 `basis`-forcing + 逐角色聚焦治（另一条线）。
  - **病 B 合理化放行**（看见却找借口）→ **本模型正治**（无 patch = 必报）。

## 5. 一键「演化设定」（never-FN 的产出口，复用 copilot patch-gen）

never-FN ⇒ 报得多。但每个「误报」其实是**揪出了未记录的 canon 演化**——前提是能**一键把它变成 patch**，否则手写 patch 的摩擦劝退作者。

真实循环：**写正文 → shadow 报偏离 → 作者「哦这是演化」→ 一键起草 patch → 复审：有生效 patch 解释 → 绿。**（或者作者选「改 prose」。）

复用已有 copilot 管线，无需重造：

1. **起草**：复用 copilot 的 `elementPatchPrompt` / `runStructured`
   （[copilot/capabilities/element-patch.ts:88](copilot/capabilities/element-patch.ts)），
   输入 `recentText` = 被报的偏离段、`candidateElements` = [被冲突的 element] → 输出 `{patchTitle, patchBody, evidenceText, confidence}`。
2. **落库**：走和 copilot `accept()`、agent `createElementPatch` **同一条路**——
   `createElementPatchRepository().create({ projectId, elementId, sourceNodeId: chapterId, sourceBlockId, title, contentJson })`
   （[element-patch-repo.ts:71](../../sqlite-repo/element-patch-repo.ts)）+ `syncElementPatchCreate`（[sync-helpers.ts:194](../../usecase/sync-helpers.ts)）。
3. **软批准**：和 copilot suggestion 一样走 comment 卡片（`source:'copilot'`→可加 `source:'shadow'`），作者点接受才真正建 patch。
4. 复审时 `effective_canon` 纳入这条新 patch → 偏离被解释 → 通过。**闭环。**

## 6. 政策住哪 + 规则增强（接「答案 1」）

- 本 canon-truth 政策是**一致性类规则的判定 spec 主干**。
- 方向：移除当前 `compileRule` 的**初步编译**（薄 checklist），改成**更深的 LLM 规则增强**——
  把作者每条 rule 编译成**持久化的判定 spec**，注入 shadow task 的 prompt，让 task 回 `basis`。
- character-consistency 作为 **seed 规则**在建项目时下发（onboarding），后续可移除。
- 注：当前 Layer 0 把一致性两条子句**临时写死在全局 prompt**——属过渡态，应迁进这个 per-rule spec；`basis` 那条普适可留全局。

## 7. 实施顺序

1. **时序有效-canon**：`getElementPatches` 暴露 patch 的时间轴位置 + `foldEffectiveCanon(element, N)` helper。（correctness 地基）
2. **判官政策**：canon=真理、命中冲突必查 patch、无 ≤N 生效 patch 即报、绝不放过无背书冲突。（治病 B）
3. **一键演化**：shadow 偏离 finding →（复用 copilot 起草）→ 落库（复用 repo 路径）→ 软批准卡。（产出口）
4. **规则增强管线**：用 LLM 深度增强替换 `compileRule`，把政策编进持久化 spec。（泛化）
5. （later）覆盖面：关系/故事线/世界设定 的演化等价通道；patch 结构化（字段级 + 时间戳）。

## 8. 开放问题 / 风险

- **检出灵敏度**（病 A）仍靠 `basis`-forcing + 逐角色聚焦，与本模型正交。
- **patch 充分性判断**（这条 patch 是否**足以**解释这处偏离）是残留语义任务——但窄、且**锚在具体工件上**，比「猜是否有意」稳。
- **never-FN 抬 FP**：一键演化是缓解；放 prod 前仍须在「相关但自洽」清白控制上量 FP。
- **patch 是 prose 笔记，非结构化字段覆盖**：折叠 effective-canon 含判官解释成分（v1 可接受）。

## 9. 真实锚点（文件）

| 角色 | 位置 |
|---|---|
| canon（summary/body/facts） | `BookElementTable` [drizzle.ts:270](../../schema/drizzle.ts) |
| patch 模型（sourceNodeId 锚、orderKey；时间轴经 source 章 narrativeOrder/bookOrder） | `ElementPatchTable` [drizzle.ts:353](../../schema/drizzle.ts) |
| patch 读（判官） | `getElementPatches` [tool-handlers.ts:871](../agent/tool-handlers.ts) ← 补时间轴 |
| patch 建 + sync | `createElementPatchRepository().create` [element-patch-repo.ts:71](../../sqlite-repo/element-patch-repo.ts)、`syncElementPatchCreate` [sync-helpers.ts:194](../../usecase/sync-helpers.ts) |
| copilot 起草 patch（复用） | `elementPatchCapability` detect/accept [copilot/capabilities/element-patch.ts:54](../copilot/capabilities/element-patch.ts) |
| agent 建 patch（参考实现） | `createElementPatch` [tool-handlers.ts:1575](../agent/tool-handlers.ts) |
| 判官 | `evaluateSemanticAssertionsWithRuntime` [shadow-rules.ts](../ai/shadow-rules.ts)（政策 + effective-canon 注入） |
| canon↔章 依赖/陈旧 | [dep-snapshot.ts](dep-snapshot.ts)、[useStaleReviews.ts](../../usecase/useStaleReviews.ts) |
