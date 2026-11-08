# M28 模型接入

先读 [README.md](README.md) 的共用约定和 [m27-agent-runtime.md](m27-agent-runtime.md)：这一份实现 M27 的驱动接口。

## 要做的

四条路：

- **DeepSeek**：Chat Completions。
- **Anthropic**：Messages，流式输出，自适应思考；回放时要原样带上签过名的思考内容。
- **OpenAI**：Responses。
- **ChatGPT 订阅**：设备码登录，走 Codex 后端。

新版只用一个 HTTP 客户端、一个 SSE 解析器，上面三种协议适配。

已经定下的：

- **模型列表实时拉**：三家 API Key 路用各家的 `/models`，缓存 5 分钟。Anthropic 和 DeepSeek 的列表自带上下文、输出上限、思考档位，有就用；OpenAI 的列表只有 id。旧版另有一份内置兜底清单（`AGENT_PROVIDER_OPTIONS`），照搬。
- **联网搜索只用各家自带的**，不接第三方：
  - OpenAI 和 ChatGPT 订阅：请求带 `{type:'web_search', external_web_access:true}`。
  - Anthropic：`web_search_20250305`，`max_uses: 5`。用了搜索的那一轮整段原样回放（思考、带引用的文字、加密结果、工具调用，顺序不变）。`pause_turn` 最多续 4 次。返回 400 且提到 web search 时（组织关了或模型不支持），去掉这个工具再试。
  - DeepSeek：不做。
  - 事件里记成 `provider_tool`，面板显示「搜索网页」「打开网页」的卡片（M31）。
- **密钥放钥匙串**，用 F7 的 `dr_platform::secrets`，沿用旧版的格式和键名。这样旧版存的 Key 新版能直接读到。
- **重试和错误**：照旧版的 `provider-attempt-retry.ts`。错误要投影成作者看得懂的几类：没登录、额度、网络、模型不支持。

## 旧版

- TS 驱动：`src/renderer/lib/agent/runtime/drivers/`
- 模型目录：`byok-model-catalog.ts`、`codex-model-catalog.ts`、`connect-agent-provider.ts`
- 已经是 Rust、可以复用的：
  - `src-tauri/src/codex_oauth.rs`（设备码登录）
  - `src-tauri/src/codex_models.rs`
  - `src-tauri/src/byok_models.rs`
  - `src-tauri/src/openai_responses.rs`：它只转发字节，只留错误投影和 Codex 请求头；流式解析照 TS 驱动重写
- 文档：`docs/agent-runtime/provider-extension-protocol.md`

## 新版放哪、接哪

- 放在 `next/crates/dr-agent` 的驱动模块里，或者单开 `dr-agent-providers`，看 M27 怎么分。
- HTTP 客户端：工作区已经有 `reqwest`，看能不能满足流式需求；换别的要过许可门禁。
- **测试不调真 API。** 每家录一组合成的 SSE 响应，覆盖：文字、思考、工具调用、搜索、错误、断流。设备码登录对着本机假服务测。真账号的手测留给作者。

## 完成标准

- 四条路都能流式输出、调工具，思考内容回放正确，用合成响应测过。
- 模型列表的拉取、缓存、兜底都有测试。
- 钥匙串读写对得上旧版：读旧版存的 Key 有测试，用测试专用的服务名。
- 文档写清：每家的请求和响应怎么映射到 M27 的事件、错误分类、和旧版的差异。
