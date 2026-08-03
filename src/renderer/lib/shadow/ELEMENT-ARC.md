# Element Arc · 元素弧线透镜 设计

> 手动触发、**只读**的分析：从正文里**抽出**某个 element 跨章的发展轨迹，沿叙事时间轴画成**挂着证据锚**的轨迹图，附中性张力提示。
> 既服务建筑师（执行 vs 意图的镜子），也服务园丁（发现自己没意识到写出来的弧线）。
> 配套：自适应层级蒸馏树、层间契约、与现有 dep-graph / effective-canon 的接线。
> 姊妹文档：[DESIGN.md](DESIGN.md)（canon-truth 模型）。**本功能不依赖 patch 弧线——它派生弧线。**

## 1. 这是什么 / 不是什么

单章 CI（[DESIGN.md](DESIGN.md)）回答「这一章违不违反此刻的 canon」——**逐章读时看不见跨章问题**：每章单独都通顺，问题只活在*轨迹*里（怕水的人后来随便下河、能力悄悄变强、声音越写越平）。本功能就是那台**通读全角色**的透镜。

- **是**：把 element 在所有出场章里的演变，蒸馏成一条可读、可下钻、挂证据的轨迹 + 中性张力提示。
- **不是**：不判 pass/flag（无 verdict）、不反写 prose、不自动建 patch。作者看完，**自己手动改 chapter / patch**。
- **频率**：低频、手动触发（「画一下 X 的弧线」）。成本是 O(出场数)，所以**绝不自动跑**。

### 1.1 为什么砍掉 reconcile 和 dispatch（v1 边界）

| 能力 | v1 | 理由 |
|---|---|---|
| 派生轨迹 + 分析（descriptive） | ✅ | 独立站得住、低风险、同时喂饱两类作者 |
| 反向 dispatch → patches | ❌ later | 小但属"提交 spec"，先让作者手动 |
| 反向 dispatch → prose | ❌ later | 跨章改稿，属 **copilot 协作引擎**（agent-edit-review），爆炸半径大 |
| reconcile / (b) 长线冲突判定 | ❌ later | 需 patch 弧线作对照；是 detector，要另走 eval 闸 |

**关键：这是延迟，不是死路。** 派生出的轨迹本就是**结构化、挂证据锚的对象**——未来 dispatch / reconcile 正是坐在它上面。现在砍掉，未来零成本。

派生/分析 = shadow 味（只读分析）；编辑/dispatch = copilot 味（创作）。轨迹图是两台引擎共读共写的那张工件——本功能只建 shadow 这半。

## 2. 核心:派生，不是核对

作者**常态没有写 patch**。所以不能拿 prose 去核对一条不存在的弧线——要**从 prose 里抽出**它。

- **园丁**：把他没意识到自己已写出的弧线抽给他看。
- **建筑师**：同一张图是"执行 vs 意图"的镜子，一眼看出 prose 在哪走样，**不需要正式 reconcile**。
- **漂移**（(c)）：不去*裁定*，只**把斜率画出来**，作者自己看见拐点——"等等，我没打算让 X 变这么强"。诚实、不吵。

## 3. 架构:自适应层级蒸馏树

不是固定三层。**节点契约递归同构，深度随内容量自适应**——12 章的角色一层折到顶，400 章的角色可 leaves → 幕 → 卷 → 顶。

```
顶 (synthesis)          1 个：在蒸馏后的小输入上推理 → ArcMap
  ↑   ……自适应中间层（按内容量加级；每级把子摘要按叙事缝分组再蒸馏）
中 (distillation)       每节点：吃有序子摘要 → 局部子弧 + 试探性动机 + 上带证据 ref
  ↑
叶 (extraction)         每出场单元 1 个：发生了什么 + 细节，**抽取不推理**，强制 block 引用
```

**为什么这形状在 (b) 判官发虚的地方反而成立**（呼应 [chunking 证伪](DESIGN.md)）：
那次漏检是「**在稀释的大 context 上推理**」。本架构**不 window 推理**——
叶层只做**稳健抽取**（"列出 X 在这章做了啥、引 block"，269 段长章也扛得住，因为不推理）；
真正的难推理（弧线综合）挪到**顶层、在蒸馏过的小输入上**做。**把硬推理搬到 context 最小的地方。**

- **叶层 = 地板也是雷区**：抽取性、事实性，**必须挂 block 引用**。它一飘，毒往上传 → 提示词强制 extractive + 引用。
- **中层 = 幻觉入口**：动机是"behavior→characterization"的解释跳跃。输出标成**假设 + 证据 ref + 置信**，让上层与作者能打折。这层也是**未来 reconcile 的接缝**（拿中层动机比 patch 弧线），故做干净。
- **顶层**：在小输入上综合，LLM 擅长。
- **多 agent 在这里是为「压缩」不是为「快」**：叶层天然完美并行（各出场独立），每级内并行，是 `parallel`→reduce。

## 4. 层间契约（承重 spec）

每个节点、每一级，吐**同构** shape——树才能递归、ref 才能一路上带：

```ts
interface ArcNode {
  level: number;                  // 0 = 叶
  span: { fromOrder: number; toOrder: number; chapterIds: string[] };
  digest: string;                 // 局部子弧 / 发生了什么（prose）
  facts: Fact[];                  // 叶=正文抽取(挂block)；中=向上滚动
  motivations?: Hypothesis[];     // { claim; confidence; evidenceRefs } —— 试探、可选
  signals?: Partial<{             // 结构化弧维度，可选
    competence: string; voice: string; relationships: string; emotion: string;
  }>;
  evidenceRefs: Ref[];            // { chapterId; blockId; span } —— provenance 链
  childRefs: string[];            // 指向下一级节点 id（下钻）
}
type Ref = { chapterId: string; blockId?: string; span?: [number, number] };
type Fact = { text: string; evidenceRefs: Ref[] };
type Hypothesis = { claim: string; confidence: 'low'|'med'|'high'; evidenceRefs: Ref[] };
```

叶填 `facts` + `evidenceRefs`（强制 block）；中节点填 `digest`/`motivations`/`signals` 并**把下层 ref 往上带** + 设 `childRefs`。顶层吐终态：

```ts
interface ArcMap {
  elementId: string; elementName: string;
  axis: 'narrativeOrder' | 'bookOrder';
  points: ArcPoint[];             // 有序轨迹点
  tensions: TensionFlag[];        // 中性 surfacing，不是 verdict
  narrative: string;              // 整体弧线（prose）
  coverage: { appearances: number; chaptersCovered: number; generatedAtOrder: number };
  patchOverlay?: PatchMarker[];   // 把作者已写的 patch 叠在派生轨迹上（来自 effective-canon）
}
interface ArcPoint {
  order: number; label: string; state: string;
  motivation?: Hypothesis; confidence: 'low'|'med'|'high';
  evidenceRefs: Ref[]; nodeRef: string;        // 下钻到产出它的节点
}
interface TensionFlag {
  kind: 'contrast' | 'possible-drift' | 'uncommitted-evolution';
  note: string;                   // 中性："第20章与第8章形成对比——有意吗?"
  pointRefs: string[]; evidenceRefs: Ref[];
}
```

**provenance 是这条链本身，不是事后贴的属性**：顶层每个 `ArcPoint`/`TensionFlag` → `nodeRef`/`evidenceRefs` 一路下钻到 block。这既是**可信度**（作者核对而非盲信，同 `basis`-forcing 纪律），又是**好 UI**（drill-down）。

## 5. 分组与自适应深度

- **优先按叙事缝分组**（幕 / 卷 / storyline 成员 / 大的 narrativeOrder 段），让每个中节点的子弧**有意义**（"X 在第二幕的弧"），而非任意窗口。
- 无结构可依时**退化为定长窗口**（fan-in ~8–12 出场/节点）。
- **加级规则**：当某级节点数仍超过单次综合的舒适预算，就再加一级 reduce。简化策略：固定 fan-in，节点数 > 阈值则加级（≈ `ceil(log_f(N))`）。具体阈值先拍一个、按肉眼调。
- 轴 = `narrativeOrder ?? bookOrder`（与 effective-canon 同轴，见 [DESIGN.md §3](DESIGN.md)）。

## 6. 复用图（别重造）

| 需要 | 复用 | 位置 |
|---|---|---|
| work-list（X 在哪些章出场） | `listBacklinksToTarget('element', id)` 反查引用 | [inline-mention-repo.ts:68](../../sqlite-repo/inline-mention-repo.ts) |
| 同款依赖/陈旧面（触发联动） | `useStaleReviews` / dependency-index | [useStaleReviews.ts:45](../../usecase/useStaleReviews.ts)、[dependency-index.ts](dependency-index.ts) |
| 叶层取证（读段、搜证） | shared `AgentRuntime` profile + read 工具 | [agent-runtime.ts](agent-runtime.ts)、[tool-handlers.ts](../agent/tool-handlers.ts) |
| 叶层"该时点应有基线" | `shadowEffectivePatchesText`（effective_canon(X,K)） | [tool-handlers.ts:1846](../agent/tool-handlers.ts) |
| patch overlay（已写 vs 已派生） | `PatchWithSourceTitle.sourceNarrativeOrder` | [element-patch-repo.ts:36](../../sqlite-repo/element-patch-repo.ts) |
| 编排/持久化/trace/通知 | 给 `shadow_job` 加一种 job kind（`arc`），白嫖队列+trace+pill | [job-recorder.ts](job-recorder.ts)、[shadow-job-repo.ts](../../sqlite-repo/shadow-job-repo.ts) |
| 接受度纪律 | `basis`-forcing 同款：叶必引 block、张力必挂证据 | [shadow-rules.ts](../ai/shadow-rules.ts) |

**work-list 召回局限**：mention 反查漏掉"只有代词、不点名"的出场。v1 可接受——零 mention 的章基本不承载 X 的弧线；列为已知限制，未来可加语义补召。

**编排落点**：shadow worker 现是单章串行。arc 是另一种 job——v1 走 `shadow_job` 新 kind，叶层 fan-out 经同一 renderer LLM substrate；复用 job-recorder 拿到 trace/持久化/通知。

## 7. 触发 / 成本

- **手动**：element 上「画一下 X 的弧线」按钮。
- **可选**：X 的 canon/patch 被大改时**提示**重派生（不自动跑）。
- **成本** = O(出场) 叶 + O(出场/f) reduce + 1 顶。缓存 `ArcMap`，标"生成于第 N 章 / 已落后 M 个新出场"。巨型角色：可**渐进渲染**（叶完成即出局部）。

## 8. 输出 / UX（v1 从简）

- 竖向时间轴（narrativeOrder 轴），轨迹点带 label/state，展开见动机 + 证据（下钻），**作者已写的 patch 以异色 marker 叠加**（"你提交的 vs 你写出的"）。
- 张力以**中性 inline 注**呈现，绝不"你应该……"。
- 只读。可导出为"角色圣经" markdown。
- **重描述、轻处方**：描述性轨迹是地板（高置信）；处方性建议是危险顶料（LLM 爱吐通用废话、踩创作品味）——尽量做成*中性点破张力*而非指点。园丁尤其反感被告知怎么写，贴合 advise-not-block 调性。

## 9. 开放问题 / 风险

1. **叶层 grounding 是地板**：抽取一飘，上层全毒 → extractive 提示 + 强制 block 引用 + 作者可下钻核对。
2. **动机层幻觉**：标试探 + 置信 + 证据；可选档位。
3. **分组缝**：依赖叙事结构（幕/卷/storyline）；缺则定长窗口、子弧偏任意（可接受）。
4. **自适应深度阈值**：先拍固定 fan-in、超阈加级，肉眼调。
5. **work-list 召回**：mention 漏代词出场（§6）。
6. **派生 ≠ 真相**：合成会脑补出更干净/不同的弧线——靠 provenance 让作者核对、靠"可编辑/advisory"把风险关进笼子。
7. **巨型角色成本**：手动触发 + 缓存 + 渐进渲染兜底。

## 10. 验证:spike，不是 eval

本功能是 **advisory 合成器**，输出无 ground truth 可打分——**召回/精度 eval 范畴错配**（那是给 detector 的）。质量由作者一眼看出来。

所以：**在一个真实角色上把叶→顶跑一遍，用眼睛验**——挂得住证据？读着像那么回事？有没有脑补动机？
- 稳 → 定 `ArcMap` 数据形状 + UI。
- 叶层抽取发飘 → **先修地板**，别让幻觉往上传。

## 11. 真实锚点（文件）

| 角色 | 位置 |
|---|---|
| element canon（summary/body/facts） | `BookElementTable` [drizzle.ts:270](../../schema/drizzle.ts) |
| work-list：element→引用章 | `listBacklinksToTarget` [inline-mention-repo.ts:68](../../sqlite-repo/inline-mention-repo.ts) |
| effective_canon(X,N)（叶层基线 + patch overlay） | `shadowEffectivePatchesText` [tool-handlers.ts:1846](../agent/tool-handlers.ts)、`PatchWithSourceTitle` [element-patch-repo.ts:30](../../sqlite-repo/element-patch-repo.ts) |
| 叶层取证 provider | shared `AgentModelDriver` + `makeShadowRunTool` [agent-runtime.ts](agent-runtime.ts)、[tool-handlers.ts](../agent/tool-handlers.ts) |
| 编排/trace/持久化（加 `arc` kind） | [job-recorder.ts](job-recorder.ts)、[shadow-job-repo.ts](../../sqlite-repo/shadow-job-repo.ts) |
| 依赖/陈旧（触发联动） | [useStaleReviews.ts:45](../../usecase/useStaleReviews.ts)、[dependency-index.ts](dependency-index.ts) |
| canon-truth 模型（reconcile 的未来对照） | [DESIGN.md](DESIGN.md) |
