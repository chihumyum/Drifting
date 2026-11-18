# 内核 v5 收尾的小活：任务书

2026-11-18 写。11-17 夜里 T9、PT3、HC、KB、RD、MF、RL、UP 合进 `main` 时，原型没画、作者没选的地方先按最保守的做法做了，攒成一份清单；11-18 作者逐条定了（[kernel-v5.md](../kernel-v5.md) 第 15 节第 51 到 57 条，原话「全照建议」）。这一页把其中要改代码的排成几路小活，外加从旧任务书原样带过来、先不做的社区模板（PT5）。

旧任务书 `handoff/v5-tracks.md` 这一天删了（第 57 条），最后一版在 `git show 64563601b:docs/rust-rewrite/handoff/v5-tracks.md`；它「作者已经定下的」七十三条都在 kernel-v5 第 15 节各条里。

这也是过程文档：各路合进 `main` 以后删掉对应的一节，全删完连这一页一起删。

## 一共几路，谁等谁

| 路 | 做什么 | 状态 |
| --- | --- | --- |
| TS `ts-template-shelf` | 项目模板界面和「全部项目」页的小修：新建模板没改就关不留、失败提示说清哪步没成且不画对勾、忙时一起锁住、三个导入一律两行、新建项目卡去掉小字 | 2026-11-18 合进 `main`（`handback/v5f-ts-template-shelf`，规格和代码已审。核对空模板的清理守卫、另存失败和书架布局，全套检查及副屏通过） |
| SF `sf-shell` | 外壳的小修：左栏悬停卡贴在旁边且只留一张、右栏铺满动画里月亮挡住下面、1 倍屏的月亮（先截图给作者挑）、层级表的插入线、审阅铺满每列 310、空着的「说明」一行高 | 2026-11-18 合进 `main`（`handback/v5f-sf-shell`，规格和代码已审。补验来回悬停，1 倍月亮按作者选择留原样。全套及两种副屏窗口通过） |
| NE `ne-new-entry` | 新建条目不先起名字：直接建「未命名」、打开、标题选中 | 2026-11-18 合进 `main`（`handback/v5f-ne-new-entry`，规格和代码已审。核对默认模板、归属、一步撤销和标题焦点，合并树全套及副屏新建场景通过） |
| HC2 `hc2-home-cards` | 建议卡的小修：出错原因写成中文、开始或在看时整块点不动、读屏名带上动作 | 现在就能开工 |
| RL2 `rl2-relations` | 关系界面的小修：回车选第一个和「建立」、所有 @ 照正文的找法、条目页几篇正文之间连线、关系图上放不下的名字先不画、关系卡里重了的一行说明原因 | 2026-11-18 合进 `main`（`handback/v5f-rl2-relations`，规格和代码已审。核对键盘、共享搜索、跨正文和重复行守卫，合并树全套及副屏通过） |
| RI `ri-import-association` | 导入 0.1 时把笔记和章、要素之间的「关联」带过来 | 现在就能开工 |
| MF2 `mf2-md-folder` | Markdown 文件夹的小修：「挂在」和图片字段写带路径的 `[[…]]`、目录文件叫「目录.md」、同名属性收进新字段、另存过的提示加「知道了」 | 2026-11-18 合进 `main`（`handback/v5f-mf2-md-folder`，规格和代码已审。修复收录同名属性时的抢写，保留 App 新值和外部副本。全套检查及两轮副屏通过） |
| PT5 社区模板 | 第二期 | **先不开工**：新版发布以后，作者先建好公开仓库（kernel-v5 第 15 节第 43 条） |

七路小活彼此不等，谁先交回谁先合；碰到同一个文件的见「各路之间」。

## 公共部分

### 规矩

先读仓库根的 `AGENTS.md` 和 [README.md](README.md)（「做的时候」「真窗口验收」「不能替作者做的」三节全部适用）。最容易出错的：

- **只做自己那一节写的。** 作者这次定的形状在 kernel-v5 第 15 节第 51 到 57 条，做的时候非定不可、建议里又没说到的，会话照常理补的在 kernel-v5「替作者定的」最后一组。照那里做；那里也没说到的，写进交回报告的「等作者的事」，按最保守的做法先做，不自己另设计。
- **范围**：只改自己那一节列出的 crate 和文件。确实要动别处时做最小改动，在交回报告里逐处列出原因。数据层（`dr-model`、`dr-doc`、`dr-workspace`、`dr-store`）的接口只加不改；觉得不够用写进报告。
- **worktree 和构建**：用自己的 `next/target`，`CARGO_BUILD_JOBS=3`，测试 `RUST_TEST_THREADS=1`；字体从 `~/Drifting/next/.cache/fonts` 拷到自己的 `next/.cache/fonts`。不在主检出（`~/Drifting`）里构建或改文件。
- **不推送、不开 PR、不合 `main`、不打标签。** 提交说明用英文，不加署名行。
- **界面文字一律写「Agent」，不加靠颜色区分的东西，没有右键菜单，不加作者没要的说明文字。** 文案只加删自己的键，照 [README.md](README.md) 的写法，九种语言都写；`locales/*.json` 是生成的，不手改。
- **测试**：改了期望的、删了的测试，在报告里写改前改后和原因。不许为了通过而放松断言、加重试或 `#[ignore]`。测试数据只用 `dr_testkit::seed`、`dr_testkit::samples`、`dr_testkit::media`。
- **日志和验收证据**放 `~/Drifting-autopilot-logs/v5f-<路>/`，不放进任何工作区。

### 交回

1. 交回前 `git merge main`，在合并后的树上跑，全部通过才算做完；哪条没跑、哪条是红的，如实写：

   ```bash
   cd next
   cargo fmt --all --check
   cargo clippy --workspace --all-targets --locked -- -D warnings
   RUST_TEST_THREADS=1 DR_UI_REQUIRE_FONTS=1 cargo test --workspace --locked --no-fail-fast
   cargo xtask check
   python3 crates/dr-i18n/script/sync-locales.py --check
   cd .. && pnpm public:check && pnpm ci:contract:check
   ```

2. 真窗口冒烟自己这一路的功能：`cargo xtask dev --debug-bridge` 加 `cargo drifting app …`，或一个场景加 `--app target/debug/drifting`。
3. 更新自己涉及的模块结论文档。不改 `progress.md`，过时的写进报告。
4. 建交回指针 `git branch -f handback/v5f-<路> HEAD`。报告用中文，先说大白话（做了什么、作者会看到什么不同），再列改了哪些文件、出了范围的改动、删了和改了期望的测试、检查结果、真窗口结果、等作者的事、分支和提交号。

### 各路之间

- **`dr-i18n` 的文案文件**是共同热点：每路只加删自己的键。
- **`dr-shell`**：TS 只动窗口底部的提示（`workspace/toast.rs` 和调它的地方）；SF 动左栏的悬停卡（`workspace/sidebar.rs` 卡的那一段）、月亮（`workspace/chrome.rs`）、层级表（`v3/template_structure.rs`）；MF2 动通知（`notifications.rs`、`workspace/sidebar.rs` 里通知那一段、`mirror.rs`）；NE 只在需要时动 `Open` 的标题选中。SF 和 MF2 都碰 `workspace/sidebar.rs`，谁后合谁并入先合的。
- **`dr-view-page`**：SF 只改正文模块的最小高度（`v3.rs` 那一处）；NE 改新条目打开时选中标题（`lib.rs`、`entry_head.rs`）；RL2 加条目页几篇正文之间的连线（页这一层的画层，放自己的文件里）。
- **`dr-view-elements`**：SF 改左栏悬停卡的位置和「只留一张」（`panel.rs`）；NE 改「新建」不开小框（`menu.rs`、`dialogs.rs`）。
- **`dr-view-review`**：SF 只改铺满的列宽（`panel.rs`）；RL2 只改批注里 @ 的找法（`linked.rs`）。
- **`dr-editor`**：只有 RL2 动（`assist/relate.rs`、`entity_links.rs` 一带）。
- **`dr-ui` 的 `hover_card`**：只有 SF 动，而且只改左栏用到的那一种位置，正文里的链接和底栏卡片的悬停卡照旧。

## HC2 建议卡的小修（`hc2-home-cards`）

- **开工条件**：现在就能开工。
- **依据**：kernel-v5 第 15 节第 52 条「建议卡出错的字」「整块一起点不动」「读屏名」，「替作者定的」最后一组「建议卡出错原因的归法」「建议卡的读屏名」；第 46 条。
- **范围**：`dr-agent`（`proactive/checkin.rs`、`proactive/state.rs`：出错时存一个原因的种类，不只存一句英文）、`dr-view-agent`（`controller/proactive.rs`、`home_cards.rs`）、`dr-i18n`；文档 [m30-long-tasks-memory.md](../modules/m30-long-tasks-memory.md)、[m02-home.md](../modules/m02-home.md)。
- **要做的**：
  - 「没能看完最近的改动：」后面按原因写：网络、服务不可用、超时写「连不上模型」；上下文装不下写「最近的改动太多，一次看不完」；回复格式不对、结构不对、超过四张、太长、想调工具或联网、没有结束标记写「模型的回复读不出来」。现在一律存成 `suggestion request did not complete`、显示「请求失败（provider 不可用或网络问题）」。
  - 「没能开始：」后面写「这张卡已经不在了」「主动建议关着」「另一张卡正在开始」，别的原因写「出错了」。不再露英文。书库里存着的旧英文原因一律显示「出错了」。
  - 只要有一张卡在开始，或者在看（从请求查看起，包括读改动、算 90 分钟那几秒），整块卡和 × 都点不动，× 画成点不动的样子；在看的那几秒也出「Agent 正在看你最近的改动……」那一行。
  - 卡的读屏名写成「标题，交给 Agent」或「标题，查看对话」。
- **回归测试**：每种原因各一条，显示对应的字；旧的英文原因显示「出错了」；一张卡在开始时点别的卡和它的 × 都不动、× 被 × 掉的卡不会回来；读改动那几秒出「正在看」那一行、卡点不动；读屏名带动作。照 `dr-view-agent/tests/home_cards.rs` 的合成模型流写。
- **真窗口**：合成流里让请求超时一次、上下文装不下一次，看主页那一行的字；点一张卡的瞬间点另一张。

## RI 导入 0.1 的「关联」（`ri-import-association`）

- **开工条件**：现在就能开工。
- **依据**：kernel-v5 第 15 节第 55 条、第 19 节「导入 0.1」（2026-11-18 改过）、第 18 节「RD 交回」审后补修的「导入的计数」和末尾那一问；「替作者定的」最后一组「0.1 的『关联』带过来的细节」。
- **范围**：`dr-import-v1`（`book.rs` 丢掉内置类型的那一段、`receipt.rs` 的计数和报告）；`dr-samples` 只在样书走同一条路时跟着；文档 [m17-relations.md](../modules/m17-relations.md)、[m10-import.md](../modules/m10-import.md)。
- **要做的**：
  - 0.1 内置「关联」（按 id 或 `system_key == "generic-association"` 认）下两头都是条目的关系，不再丢：建一种关系，名字「关联」、单向、描述空，左边是笔记（0.1 素材那一头），右边是章、要素等；按 0.1 里建的先后一条条走 RD 导入用的同一个选行函数，所以同一章的笔记并成一行。书里已经有一种规范化后也叫「关联」的关系，就并进那一种、方向照它的。
  - 内置类型本身照旧不带；它下面一头是图片、PDF、批注、待办、补丁的照旧不带、照旧计数。
  - 导入报告不再有「内置的「关联」下两头都是条目的关系没有导入」那一行（`relation-built-in-entries-dropped`）；回执照旧原样记一份。
  - 改导入的代码照 [README.md](README.md) 带永久测试：源库的字节和修改时间不变，导入结果逐项核对。
- **回归测试**：一份合成的 0.1 库，三条笔记两条关联到同一章、一条关联到一个要素，导入后一种「关联」、两行、对数对；作者在 0.1 自己建了同名类型时并进去；报告和回执的计数；重复导入（接着导）不重复建行。
- **真窗口**：导入那份合成库，打开那一章，右栏「关系」的「当前」里看到「关联」卡。

## PT5 社区模板

- **开工条件**：**先不开工**。新版发布以后再做（kernel-v5 第 15 节第 43 条）；那个公开的仓库要作者来建。
- **依据**：[project-templates.md](../project-templates.md) 第 9 节；做法已经定了：客户端读一份目录、取一个模板文件，投稿和审核都在仓库里做，不需要官方服务和账号；选社区的模板是直接选，不先存进「我的模板」。
- **已经定的一处**：取不到社区模板时只说「取不到社区模板」，不加重试（PT3 原型会话补的，作者「别的都甲」确认）。
- 开工前由监管会话照这一页的写法补全范围、要做的、回归测试和真窗口。
