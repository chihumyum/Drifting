# 2026-11-23 恢复推进后的各路：任务书

2026-11-23 晚作者说恢复推进，对监管会话列的待定事项答（原话）：

> 4现在就迁
> 8Loro issue应该已经关了
> issue #3我回了。
> 别的都按照你推荐的。你来做一下吧。

「4」是条目模块自定义，「8」是 loro-dev/loro#1263（上游 2026-11-23 已经关了）。这一页把由此要改代码的事排成几路。也是过程文档：一路合进 `main` 以后删掉它那一节，全删完连这一页一起删。第一轮十二路的各节 2026-11-24 已删（AL 那一节随第二轮一起删了，最后一版在 `c4939f29d`）；删之前的最后一版：`git show da591e629:docs/rust-rewrite/handoff/resume-1123.md`。

## 一共几路，谁等谁

| 路 | 做什么 | 状态 |
| --- | --- | --- |
| GU | GPUI 从 Zed `v1.27.0` 加补丁升到 `v1.29.3`，不再用 fork；同时在 macOS 上打开编辑器的「改完立刻画」 | 2026-11-24 下午合进 `main`：作者在场时重量了一遍（新旧中位和 p95 持平，数字在 [progress.md](../progress.md)「等作者的事」第 18 条），作者用拼音试打答「正常」。全套在并入十二路以后的树上 3543 通过、0 失败 |
| NP `np-system-proxy` | 联网请求跟着系统代理走，本机和局域网仍直连 | 2026-11-24 合进 `main`（`766f34e0f`）：监管会话审过，在整合树上自己跑全套（3359 通过、0 失败、21 忽略） |
| SR `sr-restore-missing-home` | 恢复快照点时原来住的地方没了：留在现在的位置，不再拒绝 | 2026-11-24 合进 `main`（`766f34e0f`）：监管会话审过，在整合树上自己跑全套（3359 通过、0 失败、21 忽略） |
| SM `sm-small-fixes` | 四处小修：导入确认框的标题、Windows 上泳道名不斜、葡萄牙语的「退出」、两句写进说明的话 | 2026-11-24 合进 `main`（`766f34e0f`）：监管会话审过，在整合树上自己跑全套（3359 通过、0 失败、21 忽略） |
| PF `pf-paste-formatting` | 从 Word 和网页粘贴带格式 | 2026-11-24 合进 `main`（`b5b185d93`）：监管会话审过，在整合树上自己跑全套（3461 通过、21 忽略；红了一条 `a_small_local_context_sends_the_sample_books_first_message`，是合并前就有的偶发，见 CX） |
| CM1 `cm1-module-data` | 条目模块自定义的数据：模块格式和校验器、我的模块、书里的抄本和值、自动换、命令、项目模板带模块 | 2026-11-24 合进 `main`（`b5b185d93`）：监管会话审过，在整合树上自己跑全套（3461 通过、21 忽略；红了一条 `a_small_local_context_sends_the_sample_books_first_message`，是合并前就有的偶发，见 CX） |
| CM4a `cm4a-agent-images` | Agent 栏收图片、发给看得了图的模型 | 2026-11-24 合进 `main`（`b5b185d93`）：监管会话审过，在整合树上自己跑全套（3461 通过、21 忽略；红了一条 `a_small_local_context_sends_the_sample_books_first_message`，是合并前就有的偶发，见 CX） |
| CM2 `cm2-module-render` | 盒子树画成界面：条目页上的一块、铺满、悬停卡里的一行 | 2026-11-24 合进 `main`（`5874a9753`）：和 CX 同一轮，全套 3502 通过；CM4b 一条测试按旧格式读结构说明，整合时改成按新格式读（断言不变） |
| CM4b `cm4b-module-agent-tools` | Agent 建模块、改模块、写值的工具和结构说明 | 2026-11-24 合进 `main`（`95e5c1c38`）：全套 3481 通过、0 失败。真窗口没跑（屏幕睡着） |
| CM3 `cm3-module-workbench` | 模块工作台、导出导入、「全部项目」页的我的模块、添加模块菜单 | 2026-11-24 合进 `main`（`762d98e71`）：全套 3536 通过、0 失败；真窗口之前那一版 130 步全过，合进最新 `main` 以后没跑（屏幕锁着） |
| CX `cx-small-context-headroom` | 小上下文的本地模型发示例书第一句，余量只剩一百来个 token，偶尔发不出去 | 2026-11-24 合进 `main`（`5874a9753`）：32768 时余量从 0 到 15 回到 2168，测试守住至少 1024。真窗口没跑（屏幕睡着） |
| CA `ca-custom-address` | Agent 能连网上的第三方服务（chihumyum/Drifting#3） | 2026-11-24 合进 `main`（`cd7dd96df`）：监管会话审过，在整合树上自己跑全套（3468 通过、0 失败） |
| AL `al-entry-auto-link` | 条目的自动链接默认关、显式打开才链接；开关影响已经连好的链接 | 2026-11-24 合进 `main`（`5e5af9534`）：全套 3521 通过、0 失败；整合时悬停卡的字段和工具目录快照有冲突，两边都留。真窗口没跑（屏幕睡着），欠 `auto_link.py` 和两个层级场景 |

CM5 社区模块和 PT5 社区模板一样，新版发布以后再做，不在这一页。

## 2026-11-24 第二轮：作者对各路留下的事答「都按照你的推荐来。」

2026-11-24 下午，作者看了 [progress.md](../progress.md)「等作者的事」第 21 条（十二路交回时各自留下的事，每条带监管会话的推荐），答（原话）：

> 都按照你的推荐来。

要改代码的排成下面五路，互相不等。五路 2026-11-24 夜都合进了本地 `main`，各节已删（删之前的最后一版：`git show c4939f29d:docs/rust-rewrite/handoff/resume-1123.md`）；它们留下的事在 [progress.md](../progress.md)「等作者的事」第 22 条。推荐是「先这样」「维持」「照现在」的不用做，记在 progress.md「作者定下的」。

| 路 | 做什么 | 状态 |
| --- | --- | --- |
| AB `ab-auto-link-backfill` | 打开自动链接的开关时把全书已经写下的名字补成链接；模板编辑器和重名提示的两处字；项目模板带上条目自己的开关；内置写书模板写给 Agent 的旧说法 | 2026-11-24 夜合进本地 `main`：监管会话审过，五路并成一棵树自己跑全套（3591 通过、0 失败） |
| AP `ap-prose-link-manual` | Agent 用 `prose.link` 加的链接记成手动的，它的撤销按原值恢复 | 2026-11-24 夜合进本地 `main`：监管会话审过，五路并成一棵树自己跑全套（3591 通过、0 失败） |
| S2 `s2-small-follow-ups` | 五处小改：粘贴为纯文本、两条路线的模型当能看图、不写协议的网上地址当 https、恢复快照点的两种情况 | 2026-11-24 夜合进本地 `main`：监管会话审过，五路并成一棵树自己跑全套（3591 通过、0 失败） |
| CW `cw-workbench-follow-ups` | 模块工作台：能撤回 Agent 对「我的模块」的修改、稿纸收图片转给 Agent、去掉稿纸角上的工具、药丸收着时的记号、「全部项目」页悬停卡预览的比例 | 2026-11-24 夜合进本地 `main`：监管会话审过，五路并成一棵树自己跑全套（3591 通过、0 失败） |
| CR `cr-module-render-follow-ups` | 模块渲染：铺满的开合动画、英文等语言的个数写法、条目页上模块的先后 | 2026-11-24 夜合进本地 `main`：监管会话审过，五路并成一棵树自己跑全套（3591 通过、0 失败） |

这一轮的公共部分和上一轮一样（见「公共部分」），只是日志放 `~/Drifting-autopilot-logs/r1124-<路>/`，交回指针 `handback/r1124-<路>`，报告 `~/Drifting-autopilot-logs/r1124-<路>/handback.md`，临时文件也放在自己那个日志目录里（上一轮两路共用临时目录互相覆盖过脚本）。开工时 `main` 上的 GPUI 已经是 Zed `v1.29.3`。界面上的字：除了各节点名要加的那几句，不加新的字；原型没画的地方照最保守的做，逐处写进报告的「等作者的事」并带推荐。

## 公共部分

规矩照 [README.md](README.md) 的「做的时候」「交回」「真窗口验收」「不能替作者做的」，和 [v5-followups.md](v5-followups.md) 的「规矩」一节。这一轮不一样的只有：

- 日志和验收证据放 `~/Drifting-autopilot-logs/r1123-<路>/`。
- 交回指针 `handback/r1123-<路>`；报告写在 `~/Drifting-autopilot-logs/r1123-<路>/handback.md`。
- 全套测试用省磁盘的跑法，`crash_report` 用默认配置单独重跑：

  ```bash
  CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 \
  RUST_TEST_THREADS=1 DR_UI_REQUIRE_FONTS=1 cargo test --workspace --locked --no-fail-fast
  cargo test -p dr-platform --test crash_report --locked
  ```

  改过的 crate 再不带 `RUST_TEST_THREADS=1` 跑一遍（CI 是并行跑的）。动了 Windows 才编的代码或 `dr-platform`，加一遍交叉 Clippy：`cargo clippy -p dr-platform --all-targets --no-default-features --target x86_64-pc-windows-msvc --locked -- -D warnings`。
- 每道检查单独看退出码，不接在管道后面。
