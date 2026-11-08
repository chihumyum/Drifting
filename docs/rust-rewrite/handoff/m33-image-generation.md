# M33 生图（实验）

先读 [README.md](README.md) 的共用约定和 [m28-model-providers.md](m28-model-providers.md)。

## 要做的

给要素生成立绘候选。
- 候选放进本机的收件箱；作者留下的那张导入成素材，挂到要素上。
- 要花钱，所以每次生成前都问作者一次。这是帮手里仍然保留的少数确认之一。

旧版实测过的端点情况（2026-10-26）：
- 带 Drifting 的请求头可以调 `images/generations`；
- `quality` 和 `size` 参数会被忽略；
- 生图有自己的每日限额。

## 旧版

- `src-tauri/src/codex_images.rs`（1004 行，Rust，可以复用）
- `src/renderer/features/element-images/*`（约 1.1k 行）
- `src/renderer/lib/agent/element-image-requests.ts`

## 新版放哪、接哪

- 请求那头放在 `dr-agent` 的驱动里，复用 M28 的登录和 HTTP 客户端。
- 界面放在要素页：M11，`dr-view-elements`，M01 那一路负责。要的位置写进「待协调」，或者照 `add_page_chrome` / `add_page_menu` 挂在页面上。
- 导入成素材：F3 的 `material.create` 和 `asset.put`。
- 收件箱是本机数据：F2 的 `local_state`，文件放进资源存储。

## 完成标准

- 对着本机假服务：生成、收件箱、留下一张、导入成素材，每次生成前都先问。
- 测试不调真端点。
