# 整合者的做法

2026-11-08 起，监管会话（Claude）的整合工作交给外部代理接手。整合者负责四件事：
- 把各分支合进 `main`；
- 跑全套检查；
- 维护 [progress.md](../progress.md)；
- 把各模块文档「待协调」里的事转给该做的一方。

整合者自己不写功能，只修合并时两边对不上的地方。

## 现在的状态（2026-11-08 下午）

- `main` 是本机的，**没推送**。推送要作者说。
- 已经合进 `main` 的到第十九批：热重载、对话文档审查、沉浸写作的外壳、素材库、书架躺字海、时间线第三轮。合入提交的说明写着 `batch nineteen`。
- 还没合的分支，下一批（第二十批）要合的：

| 分支 | 内容 | 状态 |
| --- | --- | --- |
| `claude/f3-workspace-88823a` | F3 第十轮：`chapter.create` 带叙事位置，M16 要的命令 | Claude 会话收尾中，看分支上最新提交 |
| `chihumyum/f4c-input-fa9d83` | F4c：Windows 输入法组字中失焦丢弃 | 同上 |
| `claude/m10-import-e63951` | M16 构想第二个里程碑 | 同上 |
| `claude/f2-store-024ef7` | F2：审迁移 0007、持有者提交选项 | 同上 |
| `codex/m28-model-providers`、`codex/m29-agent-tools` 及之后的 `codex/m*` | Codex 的帮手一条 | 按 Codex 交回的顺序合 |
| `antigravity/m*` | Antigravity 的模块 | 同上 |

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
