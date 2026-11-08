# GPUI 补丁

给 Zed `v1.27.0`（`c84af5b`）的 GPUI 打的补丁，由 F4 维护。设计、规模、测量结果和上游计划见 [f4-editor.md 的「GPUI 补丁台账」](../../../docs/rust-rewrite/foundations/f4-editor.md#gpui-补丁台账)。

工作区现在**不挂**这些补丁，`next/Cargo.toml` 指向 Zed 官方标签。这里只存补丁文件，方便审阅、以后挂到正式的 fork 上，或者提给上游。

| 文件 | 内容 | 状态 |
| --- | --- | --- |
| `0001-macos-stop-idle-display-link.patch` | macOS 实现 `PlatformWindow::frame_waker`；连续 6 拍没画也没需求就停掉显示链接，唤醒时再启动 | 待挂：等作者指定 fork 仓库（2026-11-09 本轮不挂） |
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
