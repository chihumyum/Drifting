# M34：帮手输入框口述

交回状态：分支 `codex/m30-long-tasks-memory`，轨道 3 第四项；实现与合成验收在本模块提交，真实麦克风授权、声音质量和 Windows 原生录音留给作者手测。未增加 Agent 工具或模型提供商，没有 M33。

## 行为

帮手输入框上方的「开始录音」使用系统默认输入设备；再次点击停止，发送最后一段并排空转写。转写按录音顺序追加到**当时**的输入框，保留作者期间输入的文字；绝不自动发送给 Agent。输入法还在组字时先保留已识别结果，等作者提交／取消组字后再追加，不清掉候选文字，也不重复请求这段音频。录音／转写／等待组字／失败待重试期间不能发送聊天，作者可取消后发送已有文字。

「语音转写」展开独立凭据配置，输入框遮蔽，保存后立即清空；删除只删除语音 Key。沿用 F7 的 `byok.dashscope`，服务名来自当前 Identity（包括工作区 profile）。不放设置值、不写库、不同步，也不读取日用客户端凭据。凭据错误后可改 Key，失败音频仍保留，再点重试。

- 录音：`cpal 0.18.2`（Apache-2.0）的 macOS CoreAudio／Windows WASAPI。一次只占一个麦克风，由独立线程持有 stream；实时回调不等待 UI／网络。转单声道 16 kHz PCM16 WAV；跨回调保留声道／采样相位，四分钟和 7,000,000 字节双上限，以先到者滚动（PCM16 的字节上限约 3 分 39 秒）。停止先释放 stream，再处理已接受的尾帧。
- 容量：最多四段待转写，达到容量自动停止并显示「转写积压」；已有段可重试。采集缓冲溢出／积压时只保证保留已编码段，未编码尾帧不保证完整；正常停止则先关 stream，再排空已接受的帧。音频仅在本机内存，成功追加即释放，取消／关面板／切书／切聊天清除未追加段，已经进入输入框的文字不回滚。没有后台恢复录音或音频文件。
- 请求：复用提供商层的 HTTP client／Tokio reactor，直连百炼 `qwen3-asr-flash`；WAV data URI，`enable_itn: false`。只有明确的 429／5xx 最多三次尝试；鉴权失败、协议拒绝和网络结果未知不自动重复。失败时保留当前段以及其后的段，作者点「重试转写」从失败段继续，已成功段不再发送。
- 专名：开始时在 controller 的已预留库租约内读当前项目，优先活动要素名／别名，再取其他标题；去重、逐项 JSON 转义，最多 6,000 字符。只作拼写语境，不作指令，不把这些文字补进静音。这个 v2.2 读取适配器将由 v3 的结构／描述来源替换；没有新字段或按种类命令。
- 生命周期：取消令牌中止 HTTP 和录音，generation 拒绝晚到 UI 回写。退出／换库的 release hook 等待录音、请求、读取和已接受的钥匙串操作真正 ACK。关闭窗体也取消，键和原始服务错误从不进入日志。Key 写入已经接受后即使视图消失仍等系统操作完成。

## 麦克风权限与构建配置

| 改动 | 原因 | 开发构建 | release／dist 构建 |
| --- | --- | --- | --- |
| `app/drifting/resources/microphone.plist` | 声明 `NSMicrophoneUsageDescription`，供 macOS 首次访问麦克风时显示用途 | 固定开发身份 `cc.drifting.next.dev`，不是授权许可 | 当前打包脚本仍使用开发身份；F7 正式身份切换时要一起核对 |
| `app/drifting/build.rs` | 未打包的可执行文件没有 `.app/Contents/Info.plist`，需要嵌入 Mach-O `__TEXT,__info_plist` | macOS 的 `drifting` 二进制目标带用途描述；显式启用 `debug-bridge` 的验收示例也嵌入，便于假服务下手测授权；库／CLI 目标不加，Windows 不加链接参数 | 同样适用于 release／dist 的裸 app 二进制；不以 debug 开关控制 app 的权限声明；默认发布不包含验收示例 |
| `script/bundle-mac` | `.app` 读取自己的 Info.plist，需要同一用途描述 | `--debug` 从该资源读取并写入包，再照旧 ad-hoc 签名 | 默认 release 与 `--dist` 都写入；不打开 Hardened Runtime，不加调试桥／热更新，也不导入证书、签名密钥或发布 |

用途文字沿用旧版 `settings.models.speechDesc` 的英文原文；两个构建入口读同一 plist，不再自编一段权限说明。帮手的旧键登记在 `dr-i18n/keys.txt` 后运行 `sync-locales.py`；唯一新键 `speech.backlog` 只写状态名，在 `own/` 九语种维护，没有新增说明句或提示句。没有手改生成的 `locales/`。

声明用途不会提前请求或授予权限：只有作者明确开始录音、且存在转写 Key 时才打开系统默认输入设备。worktree 的库／钥匙串 profile 仍由 F7 隔离；OS 授权未必按 profile 分开，不能用库隔离推断权限隔离。未打包启动时的授权归属也需作者观察。

当前脚本构建的是本机开发身份的 ad-hoc 包。将来 F7 启用 Developer ID／Hardened Runtime 时，还必须在正式签名的 entitlements 中声明 `com.apple.security.device.audio-input`，重新核对用途描述与正式身份，并做首次授权／拒绝手测；本次没有把 release 优化构建当作可发布签名包。见 [Apple 媒体授权](https://developer.apple.com/documentation/bundleresources/requesting-authorization-for-media-capture-on-macos) 与 [Hardened Runtime 音频输入](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input)。Windows 使用 CPAL 的 WASAPI 与系统桌面应用麦克风开关，不使用 macOS plist。

## 自动验收

契约直接在测试中，不提交伪造的录音验收 JSON：

- `wav_segments_and_resampling_preserve_frames_across_callback_boundaries`：44.1 kHz 双声道的任意回调拆分与整体输入一致；WAV 头、尾段、大小滚动与帧总量。
- `audio::tests`：合成帧直接走原生采集使用的编码循环，断言先关 stream 再排空尾帧、取消丢弃尾帧、积压保留四段并关闭 stream；测试不打开任何输入设备。
- `fake_asr_checks_wire_context_audio_and_bounded_retry`：真实本机 HTTP 服务检查模型、鉴权、WAV 原字节、专名语境、禁用 ITN；429→503→成功三次请求一致。
- `failed_segment_can_retry_without_changing_audio_and_auth_does_not_retry`：鉴权失败只请求一次，手动重试同一段。
- `unknown_outcomes_and_protocol_errors_are_not_repeated_and_rate_limits_are_bounded`：已接收请求后断连、400、畸形协议不自动重复；429 最多三次；静音可为空，缺 Key 不发 HTTP。
- `cancellation_waits_for_worker_ack_and_prevents_late_transcript`：已进入 HTTP 的取消返回 worker ACK，不采用晚到结果。
- `glossary_uses_seed_names_and_aliases_and_stays_bounded`：F8 tiny 种子、当前项目名／别名、Unicode 去重与容量边界。
- GPUI view 契约：失败后队列原序重试、作者继续打字时追加且只追加一次；输入法组字保留、等待组字期间不重复 ASR、切换上下文后待追加结果失效；积压后只重试未成功段；退出取消及排空后不写新输入框；独立钥匙串更新／删除及失败音频保留；关窗后即使视图仍被缓存也取消。另有应用级屏障契约，证明视图生命周期之外仍等待真实 ACK。没有真实麦克风、作者声音或真实 Key。

测试假服务显式将接入 socket 切回阻塞读取，避免 macOS 在请求头尚未到齐时关闭连接的竞态；协议错误会立即令顺序重试断言失败。真实窗口的入口／凭据控件脚本在 `dr-view-agent/scenarios/dictation.json`，只配合已有 `agent-acceptance` 示例（tiny 种子、内存凭据、loopback 模型接口），始终在没有语音 Key 时才点录音；不会打开麦克风。

全轨道门禁结果见下文。代码位置：`dr-view-agent/src/speech/`，面板只负责绑定生命周期；系统提示词和 M29 目录不变。

## 轨道 3 检查记录（2026-11-09）

四项工作在 `codex/m30-long-tasks-memory`；本次先将 `main` 合入本分支（`654da2a4`），未合回 `main`、未推送。前三项分别已提交于 `5b97462b`、`945e3632`、`f8f1f382`，本次没有重做。M32 的修复与永久故障注入已在祖先 `0f3a1dc6`。

下面保留上一个会话的检查记录，**不代表本次补完后的代码**；本次结果在下一节汇总。

| 前会话检查 | 前会话结果 |
| --- | --- |
| `cargo fmt --all --check` | 通过 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过 |
| `cargo xtask check` | 全部门禁通过，包含在线 audit：943 个锁定依赖、0 漏洞、12 条既有维护／健全性提示；测量证据仍有 14 stale、15 legacy，未手改或冒充新测量 |
| 根目录 `pnpm public:check` | 通过，5,363 个候选文件 |
| `cargo test -p dr-view-agent --lib --locked` | 最终代码 22 项通过，其中口述 10 项 |
| `cargo test -p dr-shell --test strings --locked` | 最终代码通过；onboarding 的生成 Key 适配与集中登记逐项核对，并只登记实际使用的翻译叶子 |
| `cargo test --workspace --doc --locked` | 最终代码顺序重建／复验通过，退出码 0；首轮的 18 个依赖产物查找错误未再出现 |
| M30 运行时／提供商／工具／控制器、M32 出站故障注入 | 定向检查通过，见各模块的命令与契约说明；全量运行中这些目标也通过 |

`cargo test --workspace --locked --no-fail-fast` 首轮退出码为 101，已产出的测试结果共 **1,911 通过、5 失败、19 忽略**，另有 18 个 rustdoc 目标报依赖产物查找错误。首轮失败及后续验证分别记录，不能把单项复验当作全工作区一次全绿：

- 两项口述假服务失败：修正 macOS 接入 socket 的非阻塞继承问题，最终全部 22 项帮手视图库测试通过。
- 翻译孤立键检查：修正类型化键适配和未使用键登记，单项通过。
- `dr-view-import::quitting_stops_the_import_first`：未改该模块，用首轮同一测试二进制串行复验通过（1 项，5.35 秒）。
- **仍未通过**：F8 `dr-debug-bridge::the_socket_answers_with_the_token_only` 在 `tests/bridge.rs:446` 超时；用首轮同一二进制单独复验仍超时。本轮未改调试桥实现／测试，未在基线重建验证，不能断言它是已知基线问题。

文档测试是在其他本工作区编译任务结束后顺序复验；首轮运行期间曾重建相同 target 中的依赖产物，因此保留两轮结果，不把首轮 rustdoc 报错当成未验证的源码结论。真实录音及 Windows 的边界见下节。

## 本次补完预检

2026-11-09：新增的组字保护、采集尾帧／积压与请求失败边界补齐后，口述 16 项合成契约、帮手视图库 28 项通过；fmt、全工作区 Clippy、翻译生成校验与公开边界通过。本次首次全量运行（尚未合入夜间更新的 main）为 **1,921 通过、1 失败、22 忽略**，退出码 101；唯一失败仍是 `dr-debug-bridge::the_socket_answers_with_the_token_only` 的十秒限时，文档测试全部通过。没有绕过或修改该断言。

夜间协议要求提交后合入最新 main，并以 `CARGO_BUILD_JOBS=3` 跑全套。整合记录现采用 `RUST_TEST_THREADS=1`；下一轮采用相同串行设置，完成结果再记入「交回」，通过以前不移动 `handback/track3`。

## 作者手测（未执行）

1. 在 `next/` 构建已有验收宿主：`cargo build --locked -p drifting --example agent-acceptance --features debug-bridge`，再以 `DRIFTING_PROFILE=m34-microphone target/debug/examples/agent-acceptance` 启动。宿主每次创建 tiny 合成项目、内存凭据、本机模型／ASR 假服务，不读日用库或系统钥匙串；不要把这个 profile 换成日用配置。
2. 展开帮手 →「语音转写」，输入占位值 `synthetic-m34-window-key` 并保存。这个值只进示例的内存；ASR 地址固定 loopback。播放现场生成的正弦波 WAV 作为输入源，不用作者声音、私稿、真 Key 或真实语音服务。
3. 点录音，首次同意系统麦克风权限。macOS 拒绝后从「系统设置 → 隐私与安全性 → 麦克风」检查 Drifting Next（未打包运行可能归属启动终端）；Windows 从「设置 → 隐私和安全性 → 麦克风」允许桌面应用访问。授权属于系统状态，本会话未替作者应答或重置。
4. 停止后，假服务返回固定的 tiny 种子文字，确认进入输入框且没有自动发送；转写期间打字／组字，确认不被覆盖。持续播放超过四分钟，确认滚动段和最后尾段出现；PCM16 的字节限制会在约 3 分 39 秒先滚动。这个假响应不反映识别准确率，专名只检查请求携带，不声称听写质量。
5. 取消、关闭帮手、切聊天、关窗或退出，确认系统麦克风指示熄灭、晚到文本不串入新输入框。拒绝权限、拔出设备、默认设备切换分别试一次，故障后可重新开始；输入设备切换当前不自动迁移 stream。
6. 删除占位凭据后再点录音，应显示旧版缺 Key 提示且不打开设备。401、断连、分段重试、积压上限与退出排空由前述合成契约覆盖，不需要连接真服务复验。

系统授权弹窗需作者应答；原生默认设备的支持、权限归属、实时延迟与质量，不能从合成测试推出。Windows 使用同一跨平台实现；编译／实机的实际检查结果在交回检查中列明，硬件边界仍需作者设备验证。

## 参考与协调

接口对照旧版 `src/renderer/lib/speech/`；[CPAL API](https://docs.rs/cpal/0.18.2/cpal/traits/trait.DeviceTrait.html)、[百炼 Qwen ASR](https://help.aliyun.com/en/model-studio/qwen-asr-api-reference)。依赖只加工作区统一版本；许可与依赖方向由 `cargo xtask check` 验证。涉及 `dr-i18n` 的既有键登记／生成翻译与一个积压状态新键，以及 app 打包隐私描述、既有 `agent-acceptance` 的假服务挂接，由整合者与轨道 2／4 协调；没有修改平台运行时、F1／F3 结构或能力清单。v3 的专名读取来源与 F7 正式签名后的麦克风授权，仍分别由对应 owner 接续。
