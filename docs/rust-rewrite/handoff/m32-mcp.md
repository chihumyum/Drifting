# M32 MCP

先读 [README.md](README.md) 的共用约定和 [m29-agent-tools.md](m29-agent-tools.md)。

## 要做的

**对外服务**：让 Codex、Claude Code、Antigravity 这些外部代理通过 MCP 读写作者的书。
- 工具就是 M29 的那一份，不另写。旧版对外是 89 个工具，新版以注册表生成的为准，差异列表。
- 传输：macOS 用 Unix socket，Windows 用本机回环。
- 一键配置：在设置里一键写好 Codex、Claude Code、Antigravity 的配置文件。
- 入口：`drifting --mcp --connection <连接文件>`。F7 在 `dr_platform::cli` 已经解析好了，照旧版的写法。

**扩展客户端**：帮手反过来连外部的 MCP 服务，支持 stdio 和 HTTP 两种传输。外部插件的工具，调用前要作者确认。

已经定下的：
- **对外不分权限档**（作者 2026-11-06 定）：授权里没有只读、允许修改之分；读到旧授权文件里的这些字段，丢掉。设置里每个连接只剩「连接 / 重新配置 / 配置 / 撤销」。
- **一个代理连一次就跟着打开的书走**：不是每本书授权一次。
- **套接字路径长度有上限**：路径太长时旧版另有修复，照搬。
- 协议层用 `rmcp`，过许可门禁。

## 旧版

已经是 Rust、可以复用的：
- `src-tauri/src/mcp_server.rs`（1872 行）
- `src-tauri/src/mcp_server/client_config.rs`（485 行，一键配置）
- `src-tauri/src/mcp_stdio.rs`（860 行）
- `src-tauri/src/mcp_http.rs`（279 行）

文档：`docs/agent-runtime/local-mcp.md`。界面那头：`src/renderer/lib/agent/mcp-server-bridge.ts`。

## 新版放哪、接哪

- 新 crate `next/crates/dr-mcp`。
- 应用以 `--mcp` 启动时走单独的路径，不开窗口。`app/drifting/src/main.rs` 已经按 `Launch::Mcp` 分了岔，接进去就行。
- 设置里的连接管理：照 M31 的做法登记。

## 完成标准

- 一个测试客户端经 Unix socket 连上来：列工具、读一章、改一段、撤回。
- 一键配置写出的文件和旧版格式一样，有快照测试。写到临时目录，不碰作者真正的配置。
- 扩展客户端对着测试用的 stdio 和 HTTP 服务跑通，外部工具调用会先问作者。
- Windows 回环那一路能交叉编译；能单测的部分单测。
