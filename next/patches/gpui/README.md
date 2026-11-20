# GPUI 补丁

给 Zed `v1.27.0`（`c84af5b`）的 GPUI 打的补丁，由 F4 维护。设计、规模、测量结果和上游计划见 [f4-editor.md 的「GPUI 补丁台账」](../../../docs/rust-rewrite/foundations/f4-editor.md#gpui-补丁台账)。

工作区现在不挂补丁：2026-11-21 GPUI 升到 Zed `v1.29.3`，`next/Cargo.toml` 的 `gpui`、`gpui_platform`、`sum_tree` 直接指向 Zed 仓库的标签。之前挂着的 `0001`（作者 2026-11-20 定）在 fork [chihumyum/zed](https://github.com/chihumyum/zed) 的标签 `v1.27.0-drifting.1` 上（Zed `v1.27.0`（`c84af5b`）上只打了 `0001` 的那个提交，分支 `drifting/v1.27.0`，`22d52319`）；上游从 `v1.28.1` 起自己做了同一件事（zed#65472），`0001` 只对 `v1.27.0` 有用，不再挂，fork 上的分支和标签留着不动。这些补丁都只存文件，方便审阅、以后挂上去，或者提给上游；它们是对 `v1.27.0` 写的，挂到新标签上之前先重做。补丁以这个目录里的文件为准；fork 里的提交是 `git am` 这些文件得到的，不在 fork 上直接改。

要挂一个补丁：在 fork 的本地检出里从对应的 Zed 标签开分支，按编号 `git am` 要挂的补丁，打一个新标签（`v<Zed 标签>-drifting.<下一个数>`，已经推过的标签不移动）推上去，再把 `next/Cargo.toml` 的三处改指 fork 的这个标签。

| 文件 | 内容 | 状态 |
| --- | --- | --- |
| `0001-macos-stop-idle-display-link.patch` | macOS 实现 `PlatformWindow::frame_waker`；连续 6 拍没画也没需求就停掉显示链接，唤醒时再启动 | **撤了**：2026-11-21 挂在 fork 的 `v1.27.0-drifting.1` 上，同日升到 `v1.29.3` 时撤掉（上游 zed#65472 用 `CAMetalDisplayLink` 做了同一件事） |
| `0002-experiment-present-now-direct.patch` | 实验：`displayLayer:` 直接画，不开 CA 事务、不重启显示链接；只在 `GPUI_PRESENT_NOW_DIRECT=1` 时生效 | 只用于测量，不挂 |
| `0003-a11y-draw-views-uncached.patch` | G7：读屏软件连着时，缓存视图一律不走缓存（GPUI 只在预绘制时建读屏节点，缓存回放的视图会从读屏树里掉出去）；独立于 0001、0002 | 只存文件；`gpui-prose` 自己先绕开了（见 f4c-input.md）。在 Zed main 上验证过，已报 [zed-industries/zed#66690](https://github.com/zed-industries/zed/issues/66690) |
| `0004-macos-a11y-subclass-first-responder.patch` | G8：AccessKit 的 macOS 适配器子类化 GPUI 自己的视图（第一响应者），而不是窗口的内容视图；否则系统问「焦点在哪个元素」时答的是窗口 | 只存文件；在 Zed main（`b5cd310`）上构建验证过（对 main 只差一行注释，那一版贴在 issue 里），已报 [zed-industries/zed#66691](https://github.com/zed-industries/zed/issues/66691) |
| `0005-window-discard-marked-text.patch` | G3：公开窗口级组字取消接口；macOS 取本窗视图 inputContext，Windows 取消并释放本窗 IMM 上下文 | 已写，未挂；独立于前四个补丁；平台适配检查见下 |

### G3 检查

`python3 next/patches/gpui/check-g3.py <Zed 检出目录>` 从固定的 `c84af5b` 提取四个基线文件，在临时目录检查、应用补丁并检查 Rust 格式，不修改提供的检出。补丁只增加接口，不自动取消组字、不改变焦点策略，不调用 `unmark_text`。其他平台默认不操作，macOS／Windows 的输入调用方仍须先清自己的组字并拦截迟到输入。

本轮另外用临时下游程序引用 `Window::discard_marked_text`、依赖打补丁后的 `gpui`／`gpui_platform`（`font-kit`、`runtime_shaders`）做 macOS 编译检查，2026-11-09 已通过；仓库 Cargo.toml／Cargo.lock 不挂本机路径。真实系统候选窗、Windows 编译及输入法时序仍须目标系统验证，不由补丁能应用替代。


在 Zed 的 `v1.27.0` 检出上应用：

```bash
git am path/to/next/patches/gpui/0001-macos-stop-idle-display-link.patch
```
