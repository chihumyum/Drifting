# 整合者的做法

2026-11-08 起，监管会话（Claude）的整合工作交给外部代理接手。整合者负责四件事：
- 把各分支合进 `main`；
- 跑全套检查；
- 维护 [progress.md](../progress.md)；
- 把各模块文档「待协调」里的事转给该做的一方。

整合者自己不写功能，只修合并时两边对不上的地方。

## 现在的状态（2026-11-08 下午）

- `main` 是本机的，**没推送**。推送要作者说。
- 已经合进 `main` 的到第二十五批：M29 修复、M03 分组路径、M15 块粘贴；第二十四批为 M41 真实进度，第二十三批为 M16 原面板验收。第二十一批为 F3 第十轮；第二十批接收 F2 第七轮和 M28 模型接入；M29 经复审后在第二十五批接收，见下方记录。
- 各分支的接收状态与下一批验收候选：

| 分支 | 内容 | 状态 |
| --- | --- | --- |
| `claude/f3-workspace-88823a` | F3 第十轮：`chapter.create` 带叙事位置，M16 要的命令 | 截至 `cd10d66a` 已在第二十一批接收 |
| `chihumyum/f4c-input-fa9d83` | F4c：Windows 输入法组字中失焦丢弃 | 截至 `7a21f7b9` 已在第二十二批接收；实机验收待做 |
| `claude/m10-import-e63951` | M16 构想第二个里程碑 | `09e94777` 已在第二十三批接收；原会话停在 `7a4cc87d`，后两提交待旧模块会话修转换接口和托盘溢出，见 remaining.md |
| `claude/f2-store-024ef7` | F2：审迁移 0007、持有者提交选项 | `8b012cba` 已在第二十批接收 |
| `codex/m28-model-providers` | M28 模型接入 | 截至 `95a0ba7c` 已在第二十批接收 |
| `codex/m29-agent-tools` | M29 工具与读取守卫 | 修复 `4d55f081`、交回 `44357606` 已在第二十五批接收 |
| `codex/m31-agent-panel` 及之后的 `codex/m*` | Codex 的帮手一条 | M31 截至 `0f1b0799` 已初审，先修 [Codex 队列](codex-queue.md) 的关闭阻塞及面板问题；后续修改仍在开发 |
| `codex/legacy-m15-paste` | M15 矩形粘贴 | `31539543` 已在第二十五批接收 |
| `codex/legacy-m03-group-path` | M03 构想分组路径与新建标题焦点 | `7bcf8210`（含 `1a20b714`）已在第二十五批接收 |
| `codex/legacy-m02-home` | M02 六类基础新建 | `44b7f843` / `2a2fe965` 暂未接收；先修创建期间切到设定后抢焦点，并补构想标题焦点证据，见 remaining.md |
| `codex/legacy-m14-create` | M14 叙事新建一步撤销 | `30c7715e` 静态审查通过，待下一批整体验收 |
| `codex/legacy-m19-actions` | M19 素材页基础动作 | `fe7657a1` 静态审查通过，待下一批整体验收；纯键盘选既有素材夹仍缺实现 |
| `codex/legacy-m41-progress` | M41 备份、核对和恢复的真实进度 | `fab79905` 已在第二十四批接收；其工作树已转做 M19 |
| `antigravity/m*` | Antigravity 的模块 | 作者另行安排，本整合会话不接管、不验收 |

分支上的提交如果比 `main` 新，就是还没合的（`git log main..<分支>`）。

## 一批怎么合

用一个常驻的整合 worktree，不要每批新建：新建会把依赖从头编一遍，很慢。

```bash
# 第一次：git worktree add .claude/worktrees/f-integrate main
cd .claude/worktrees/f-integrate
git switch -C <整合者前缀>/batch-NN main
git -c core.hooksPath=/dev/null merge --no-ff --no-edit <分支1>
git -c core.hooksPath=/dev/null merge --no-ff --no-edit <分支2>
# 依次合；有冲突当场解，解完提交再合下一个
```

字体是构建产物，新 worktree 第一次要从别的 worktree 拷 `next/.cache/fonts`，或者构建一次，否则画字的测试会失败。

**常见冲突和解法**

- **`next/crates/dr-i18n/locales/*.json`**（生成的）：取 `main` 的一边，再重新生成。

  ```bash
  git checkout --ours next/crates/dr-i18n/locales/
  cd next && python3 crates/dr-i18n/script/sync-locales.py && python3 crates/dr-i18n/script/sync-locales.py --check
  ```

- **`next/crates/dr-i18n/keys.txt`、`own/*.json`**：两边都留；`keys.txt` 去掉重复的键。`own/*.json` 是按键合并的 JSON。
- **`next/Cargo.lock`**：取 `main` 的一边，再让 cargo 补：`git checkout --ours next/Cargo.lock && cd next && cargo check --workspace --all-targets`。
- **两边在同一处各加了一个函数或测试**：两边都留。**注意**：git 常把两边共有的收尾 `}` 提到冲突外面，两边都留以后前一个函数会少一个 `}`。合完先 `cargo check`。
- **文档冲突**：两边的内容合成一段，已经做掉的「待协调」项划掉（`~~…~~`），写上谁在哪一轮做的。
- **接口被别的分支改了**（比如悬停卡的参数从 `Vec` 换成了 `CardRows`）：在整合分支上把调用改到新接口，提交说明写 `fix(next): batch NN integration — …`，并在 progress.md 里记一句。

## 检查（全过才合进 main）

在整合 worktree 里：

```bash
cd next
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked --no-fail-fast
cargo xtask check
cd ..
node scripts/check-public-boundaries.mjs
node scripts/check-ci-contract.mjs
npx --no-install tsx scripts/generate-agent-capabilities.ts --check
npx vitest run src/renderer/architecture/retired-client-integrations.acceptance.test.ts \
  src/renderer/lib/agent/runtime/acceptance/retired-shadow-arc-evolve.acceptance.test.ts \
  src/renderer/lib/ai/retired-copilot.acceptance.test.ts \
  src/renderer/locales/drift-terminology.acceptance.test.ts
```

- 机器很忙（负载高）时，等画完、等后台补建索引的测试偶尔会超时。单独重跑一次，过了就算过，在 progress.md 里记一句。
- `cargo xtask check` 报测量证据「过期」只是提示，不挡合并。只在机器空闲时重测。

全过以后：

```bash
cd <仓库根>
git -c core.hooksPath=/dev/null merge --no-ff --no-edit -m "Merge branch '<整合分支>': batch NN — <一句话>" <整合分支>
```

## progress.md 怎么改

每批合完都更新 [progress.md](../progress.md)，和代码放在同一个整合分支里：
- 合进来的那一路，更新它那一行：第几轮、做了什么、还差什么；新模块加一行。
- 「监管会话替作者定下的小事」末尾加一条这批整合时修了什么。
- 写法照已有的行：大白话，先说做了什么，再说还差什么。

## 「待协调」怎么转

各模块文档的「待协调」是写给别的一方的。整合时看一遍新合进来的：
- 归某个外部代理的模块：写进它的队列文件，或者告诉作者转达；
- 要作者定的：汇总告诉作者。

## 要作者定、整合者不能做的

- 推送 `main`、发版、对外发帖、开上游 issue 或 PR（作者有长期许可：确认过的上游 bug 可以开 issue，但要先复现、查重、确认不是误用）。
- 装系统组件：Metal Toolchain、Windows 工具链等。连真服务。往真 Sentry 传符号。
- 视觉和交互的取舍，以及 D7（服务端还用不用 TypeScript）。
- 需要真人手测的，清单在 progress.md 的「待作者手测」。

## 第二十批验收记录（2026-11-08）

- 整合分支：`codex/batch-20`；仍用常驻 `f-integrate` worktree。
- 接收 F2 `8b012cba` 和 M28 截至 `95a0ba7c`（实现 `ded56ed8`、交回 `6296180b`）。
- M29 `c7905f4d`、`45853e51` 暂不接收：批注删除的隐藏关系级联、创建关系指定已有 id 的覆盖缺少读取保护；修复和回归要求在 Codex 队列。试合状态保留于 `codex/batch-20-candidate`，不是可发布分支。
- 整合修复：F2 备份测量移到 `dr-testkit/tests/store_backup.rs`，保持热重载依赖图无环；F2 旧对话验证说明改为 F1 第七轮现行约定。已完成的提交选项、F1/F2 审查待办同步划掉，未完成事项转对应队列。
- 验收通过：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`RUST_TEST_THREADS=2 cargo test --workspace --locked --no-fail-fast`（1671 通过、22 忽略、无失败）、`cargo xtask check`；审计 0 vulnerabilities、12 条既有依赖提示，14 份测量证据仍过期。公开边界、CI 契约、旧 Agent 能力清单和四个退役产品／术语测试文件（14 项）均通过，语言生成校验通过。本机没有执行 Windows 或真实服务验收，也没有刷新忙碌机器上的测量证据。

## 第二十一批验收记录（2026-11-08）

- 整合分支：`codex/batch-21`，接收 F3 `84192217` 和交接 `cd10d66a`，代码无合并冲突。
- 能力从 134 项增至 136 项；转换接口按实际命令同步交接文档。M14 界面的单步新建、M16 界面转换接线仍交原模块，不在本批冒充完成。
- M29 必须在合入新 F3 后补源正文版本、幕/时间钉覆盖和默认自动补链回归，未补前先排除两个转换命令；要求已写进 Codex 队列。
- 验收通过：fmt、全工作区 Clippy、`RUST_TEST_THREADS=2 cargo test --workspace --locked --no-fail-fast`（1674 通过、22 忽略、无失败）、全部 xtask 门禁；审计无漏洞、12 条既有提示，14 份测量仍过期。公开边界、CI 契约、旧 Agent 能力清单和四个定向验收文件（14 项）通过。

## 第二十二批验收记录（2026-11-08）

- 整合分支：`codex/batch-22`，接收 F4c `296f60ca` 和交接 `7a21f7b9`，代码无合并冲突。
- 更新 F4/G4 台账；dr-ui 输入框与 macOS inputContext 对齐转旧模块收尾。真实 Windows 输入法时序、ARM 检查、同页点击策略仍在 F4c 文档，不把模拟测试或交叉类型检查算实机验收。
- 同期审查 M16 `805e2064` / `7a4cc87d`：转换接口未接上、横向托盘溢出时首卡不可达；本批未合它们，具体修复及证据要求转 remaining.md。原面板场景 `09e94777` 可作为后续独立验收候选。
- 验收通过：fmt、全工作区 Clippy、`RUST_TEST_THREADS=2 cargo test --workspace --locked --no-fail-fast`（1679 通过、22 忽略、无失败）、全部 xtask 门禁；审计无漏洞、12 条既有提示，14 份测量仍过期。公开边界、CI 契约、旧 Agent 能力清单和四个定向验收文件（14 项）通过。

## 第二十三批验收记录（2026-11-08）

- 整合分支：`codex/batch-23`，只接收 M16 前缀 `09e94777`；后续 `805e2064` / `7a4cc87d` 不在本批。代码无合并冲突。
- 原面板真窗口场景补一条移动目标唯一性断言，隔离临时 profile 上 54 步、0 pending；共享悬停卡的动作有可访问名称，移动分组行不重复。检查卡片与删除后的截图，发现的既有英文长标签越界已交旧模块收尾；完整键盘／读屏、其他语言布局和第二里程碑不算本批完成。
- 验收通过：fmt、全工作区 Clippy、`RUST_TEST_THREADS=2 cargo test --workspace --locked --no-fail-fast`（1679 通过、22 忽略、无失败）、全部 xtask 门禁、调试桥构建；审计无漏洞、12 条既有提示，14 份测量仍过期。公开边界、CI 契约、旧 Agent 能力清单和四个定向验收文件（14 项）通过。
- 同期只读初审 M31 `ef63d4f9` / `0f1b0799`：关闭及控制请求同步阻塞、元数据回执导航、多轮卡片顺序、文案与可访问性问题交 Codex 队列。本批没有合入 M31，也没有接管其未提交工作。

## 第二十四批验收记录（2026-11-08）

- 整合分支：`codex/batch-24`，接收旧模块 M41 `fab79905`。代码无合并冲突；只更新模块与应用间的进度回调，F6 换库流程和 F2 取消／恢复边界不变。
- 5 项备份定向测试通过，调试桥构建通过，临时 profile 上 `restore.json` 64 步、0 pending；已核对恢复确认截图。阶段进度转换由可控制的契约验证，真实窗口场景覆盖入口、确认、换库和错误结果。
- 验收通过：fmt、全工作区 Clippy、`RUST_TEST_THREADS=2 cargo test --workspace --locked --no-fail-fast`（1680 通过、22 忽略、无失败）、全部 xtask 门禁；审计无漏洞、12 条既有提示，14 份测量仍过期。公开边界、CI 契约、旧 Agent 能力清单和四个定向验收文件（14 项）通过。

## 第二十五批验收记录（2026-11-08）

- 整合分支：`codex/batch-25`；接收 M29 截至 `44357606`、M15 `31539543`、M03 `7bcf8210`（含 `1a20b714`）。三路代码无合并冲突。
- M29 的原两项隐藏关系问题已复审通过；136 项注册能力中开放 110、排除 26，两个转换仍未开放。8 项 F3 守卫测试原样放在 dr-testkit，避免热重载依赖环。
- M03 本轮只补分组路径及共享标题意图；M15 只补矩形粘贴，未宣称整块原子撤销或完整模块结束。M02 和 M31 仍在审查／修复，不随依赖一起接收。
- 验收通过：fmt、全工作区 Clippy、`RUST_TEST_THREADS=2 cargo test --workspace --locked --no-fail-fast`（1724 通过、22 忽略、无失败）、全部 xtask 门禁、调试桥构建；审计 943 个锁定 crate、无漏洞、12 条既有提示，14 份测量仍过期。公开边界、CI 契约、旧 Agent 能力清单和四个定向验收文件（14 项）通过。
- 临时 profile 重跑 M15 `plot-paste.json` 27 步、M03 `idea-group-path.json` 浅色和深色各 25 步，全部 0 pending；三张真实截图已核对。M15 是中文浅色窗口，M03 为中文浅深；不把这些场景当作完整键盘／其他语言验收。
- 同期初审 M02 `44b7f843` / `2a2fe965`：创建等待时切到设定后仍抢焦点，且构想标题焦点未在实际 page 宿主验证，先修后收；跨书残留错误一并转 remaining。
