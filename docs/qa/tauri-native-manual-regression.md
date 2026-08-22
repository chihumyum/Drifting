# Tauri Native Manual Regression

这份清单用于记录 Drifting Tauri 客户端中只能依赖真实设备、系统浏览器、真实账号或真实云端完成的回归。
它不替代自动化测试，也不把尚未完成的移动端 UI 适配当作发布验收项。

最后更新：2026-08-20

## 公开 Alpha 桌面门槛

`0.1.0-alpha.1` 只支持 macOS 13+ Apple Silicon。它的 P0/P1 发布记录以
[签名桌面 RC 表](desktop-alpha-release-candidate.md)和
[Google Drive 双机表](google-drive-desktop-alpha-acceptance.md)为准；两张表必须记录日期、
设备、构建 SHA 与脱敏证据。下面保留的 iOS/Android 清单是后续可移植性资料，不影响本轮
桌面 Alpha 放行，也不能替代桌面签名构建验收。

基线提交：

- `c80245bc feat(auth): secure native OAuth handoff with PKCE`
- `90b3de75 feat(native): add secure storage and system image codecs`
- `6262b1d3 fix(auth): keep OAuth verifier out of request logs`
- `81b3b2ee feat(assets): enable native HEIC and AVIF imports`
- `19a4e2dc fix(agent): harden tool calls and stream responses`

相关资料：

- [Drifting README](../../README.md)
- [Explicit Tauri platform boundaries](../../src-tauri/UNSUPPORTED.md)
- [Official-service boundary](../official-service.md)
- [Android secure-storage instrumented test](../../src-tauri/plugins/drifting-secure-storage/android/src/androidTest/java/SecureStorageInstrumentedTest.kt)

## 1. 使用方式

优先级：

- `P0`：对应目标平台的发布阻断项。桌面 Alpha 只采用上方两张 macOS 表。
- `P1`：完整功能回归。功能相关改动或里程碑构建时完成。
- `P2`：破坏性、升级和边界回归。有设备和时间时分批完成。

结果标记：

- `[x]` 通过
- `[ ]` 未执行
- `FAIL` 实际结果与预期不一致
- `BLOCKED` 缺少设备、账号、测试素材或环境
- `N/A` 该设备或构建不适用

每次执行先复制并填写下面的记录头，不要只在 checkbox 上打勾：

```text
日期：
测试人：
Client commit / build：
Server commit / build：
设备型号：
OS / API level：
安装态：fresh / update / reinstall
账号：测试账号标识，不记录 token 或密码
网络：Wi-Fi / cellular / offline / throttled
结果汇总：PASS / FAIL / BLOCKED
关联 Issue：
```

安全规则：

- 只用可丢弃的测试账号、测试项目和测试 BYOK canary；不要破坏唯一一份真实作品。
- 截图、录屏和 Issue 中不得粘贴 OAuth code、PKCE verifier、Bearer token 或完整 BYOK。
- 做卸载、清数据和密文破坏测试前，先备份测试数据。
- 模拟器可以补 API 边界，但不能替代真实 Keystore、厂商 codec、相册 provider 和 deep link。

## 2. 自动化已经覆盖什么

| 范围                   | 自动化已覆盖                                                                                         | 仍需手工验证                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Android secure storage | Rust key 校验；Kotlin 格式、损坏、上限测试；instrumented test 源码                                   | 真 Keystore、跨进程/重启、覆盖升级、卸载、真实密文检查、厂商差异      |
| OAuth Server           | state、PKCE、HMAC binding、redirect allowlist、过期、一次性兑换、敏感 payload 解析                   | 真实 Google、浏览器 cookie、真实 PostgreSQL 竞争、deep link、生产日志 |
| OAuth renderer         | warm/queued callback、state 不匹配、过期、exchange 失败                                              | 冷启动 callback、浏览器取消、断网、系统切换、session 持久化           |
| 图片 pipeline          | 普通图片、方向、格式嗅探、尺寸/内存上限；macOS ImageIO HEIC/AVIF                                     | iOS 真机、Android 系统 codec、照片选择器、两个真实 UI 入口            |
| General Agent          | 生成能力清单、功能 checklist、SQLite/Yjs 故障与恢复、领域写入、长任务、compaction、provider/MCP 合同 | 付费 provider 抽检、桌面/iOS/Android UI、后台恢复、触摸与软键盘       |
| 构建                   | macOS 测试、iOS/Android Rust 交叉编译、Android APK/Kotlin 编译                                       | 安装、权限、后台生命周期、低内存、不同厂商设备                        |

精确工具与能力数量以
`docs/agent-runtime/acceptance/agent-capabilities.md` 为准；本手册
不复制会随实现变化的计数。手工回归应集中在右列，不需要重复证明纯函数已经测过的细节。

## 3. 准备

### 3.1 构建与环境

```bash
pnpm install
pnpm tauri:ios:dev
pnpm tauri:android:dev
```

需要候选安装包时使用：

```bash
pnpm tauri:ios:build
pnpm tauri:android:build
```

OAuth staging 必须满足：

- 兼容服务实现当前版本化 native OAuth handoff contract。
- `API_BASE_URL`、`BETTER_AUTH_URL` 是同一个公开 HTTPS origin。
- 已设置稳定的 `BETTER_AUTH_SECRET`、`GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET`。
- Google Console callback 是 `https://api.drifting.cc/api/auth/callback/google`，或 staging 的等价地址。
- 测试设备已注册 `drifting://auth/callback`。
- 当前 `LoginPage.tsx` 中 `SOCIAL_LOGIN_ENABLED` 默认为 `false`。OAuth 手测必须使用一个仅供 QA、明确开启该开关的构建；测完不要把开关误带入正式 beta。

### 3.2 最小设备矩阵

| 优先级 | 设备                      | 主要目的                                               |
| ------ | ------------------------- | ------------------------------------------------------ |
| 必须   | Android 12+ 当前系统真机  | Keystore、HEIC/AVIF、picker、OAuth deep link           |
| 必须   | 当前 iPhone 真机          | Keychain、ImageIO、HEIC/AVIF、OAuth warm/cold callback |
| 必须   | 当前 macOS                | SQLite 数据路径、OAuth、图片/PDF                       |
| 推荐   | Android 7 / API 24        | 最低版本；secure storage 成功，HEIC/AVIF 明确不可用    |
| 推荐   | Android 8–9 / API 26–28   | HEIC/HEIF BitmapFactory 路径；AVIF 明确不可用          |
| 推荐   | Android 10–11 / API 29–30 | ImageDecoder runtime capability；AVIF 明确不可用       |
| 推荐   | 第二品牌 Android 12+      | Pixel 之外的 Samsung、小米等厂商 codec 差异            |
| 推荐   | 较旧受支持 iPhone / iOS   | ImageIO runtime capability 和系统 lifecycle 边界       |
| 次要   | Windows 11、当前 Ubuntu   | PNG/JPEG/PDF；HEIC/AVIF 明确 unsupported               |

### 3.3 回归素材

为每个文件记录名称、来源、大小、像素尺寸和 SHA-256：

- 带透明通道的 PNG。
- 带 EXIF 90° 或 270° 方向的 JPEG。
- iPhone 相机原生 HEIC，至少一张竖图、一张横图。
- 一个独立 HEIF 文件。
- 一个 AVIF 文件。
- 多页 PDF。
- 接近但小于 64 MiB 的有效图片和 PDF。
- 大于 64 MiB 的有效图片和 PDF。
- 损坏或截断的图片。
- 超过 16,384 像素边长，或解码后预计超过 256 MiB 的压缩图片。

成功图片的共同预期：

- source 与原文件 SHA-256 一致。
- display 为 JPEG，最长边不超过 1600，文件不超过 8 MiB。
- thumbnail 为 JPEG，最长边不超过 512，文件不超过 1 MiB。
- 方向和宽高比正确，肉眼颜色合理；透明 PNG 不出现黑块或乱码。
- 关闭并重开 App 后仍能显示，第二台设备可以重新下载并显示。

## 4. 移动端 P0（本轮桌面 Alpha 不适用）

- [ ] `P0-01` 新安装后用邮箱登录，进入项目，创建一个测试章节并写入唯一 canary。
- [ ] `P0-02` Android 保存测试 BYOK，force-stop 后重开，登录和 BYOK 都仍可用。
- [ ] `P0-03` iPhone 保存测试 BYOK，杀进程后重开，登录和 BYOK 都仍可用。
- [ ] `P0-04` Google OAuth 从系统浏览器返回 App，登录成功；URL、日志和截图中没有 bearer/verifier。
- [ ] `P0-05` 素材库分别导入 JPEG、PNG、HEIC、AVIF 和 PDF，方向与缩略图正确。
- [ ] `P0-06` 元素头像分别使用 HEIC 和 AVIF，失败时不能覆盖旧头像。
- [ ] `P0-07` 离线编辑正文，等待本地保存后强杀；离线重开仍有完整 canary。
- [ ] `P0-08` 恢复联网后，同一项目在第二设备出现最新正文和已上传素材。
- [ ] `P0-09` 大于 64 MiB 的文件被明确拒绝，App 不崩溃、不留下 ready 的半成品。
- [ ] `P0-10` 登出并重启后仍保持登出；旧 OAuth callback 不能恢复 session。

## 5. Android secure storage

- [ ] `SS-01` `P0` 干净安装后登录，退出进程并重新打开，session 仍有效。
- [ ] `SS-02` `P0` 保存带唯一 canary 的 BYOK；重开设置时遮罩尾号正确，实际 AI 请求可用。
- [ ] `SS-03` `P1` 同一 BYOK 连续覆盖两次；只读到新值，旧值不可恢复。
- [ ] `SS-04` `P0` 分别测试 force-stop、最近任务划掉、锁屏、手机重启；session/BYOK 仍可用。
- [ ] `SS-05` `P0` 登出后重启，必须保持登出；不要把 logout 与 BYOK 清除混为一谈。
- [ ] `SS-06` `P1` 在设置中显式清除 BYOK；重启后 key 不再存在，AI 请求要求重新配置。
- [ ] `SS-07` `P1` 用相同签名覆盖安装新版；session、BYOK、SQLite 和素材都保留。
- [ ] `SS-08` `P1` Android“清除应用数据”或卸载重装后，session/BYOK 必须消失。
- [ ] `SS-09` `P2` 从系统备份恢复到另一设备时，不得恢复为可用 secret；应要求重新登录/录入。
- [ ] `SS-10` `P1` debug build 检查 `no_backup/secure-storage-v1`；逻辑 key 和 canary 明文均不能出现在文件名或文件内容中。
- [ ] `SS-11` `P2` debug build 破坏一个密文文件；读取必须 fail closed，不崩溃、不返回乱码或旧明文，日志不带 secret/底层异常文本。
- [ ] `SS-12` `P1` 在真机运行 `SecureStorageInstrumentedTest`，覆盖新 backend 实例、无明文、`.bak` 恢复和删除残留。

生成 Android 工程后，可从 Android Studio 运行上述 instrumented test；也可以尝试：

```bash
cd src-tauri/gen/android
./gradlew :tauri-plugin-drifting-secure-storage:connectedDebugAndroidTest
```

debug APK 可选的明文检查示例：

```bash
adb shell run-as cc.drifting.client find no_backup/secure-storage-v1 -type f
adb exec-out run-as cc.drifting.client sh -c 'grep -R -a -F "manual-test-canary" no_backup/secure-storage-v1; true'
```

预期第二条命令没有输出。不要在命令中放真实 BYOK。

平台差异：Android 卸载会删除 Keystore key 和 `noBackupFilesDir`；iOS Keychain 和桌面 credential store 可能跨卸载保留，不能套用 Android 的预期。

## 6. Native OAuth

- [ ] `OA-01` `P0` App 前台点击 Google，必须打开系统浏览器，而非嵌入 WebView。
- [ ] `OA-02` `P0` 完成 Google 登录，浏览器返回 App，App 加载真实用户与项目。
- [ ] `OA-03` `P0` 登录后杀进程/重启，session 从 native secure storage 恢复。
- [ ] `OA-04` `P1` 浏览器回调前杀掉 App；完成网页后冷启动 App，queued deep link 仍只兑换一次。
- [ ] `OA-05` `P1` 用户取消、拒绝授权或 Google 返回错误；App 不进入半登录状态，下一次重试可成功。
- [ ] `OA-06` `P1` 分别在浏览器、callback、exchange 阶段断网；恢复后重新发起完整流程，不能把 code 当 token 使用。
- [ ] `OA-07` `P1` OAuth 页面停留超过 10 分钟再完成，必须失败。
- [ ] `OA-08` `P2` handoff code 签发后超过 2 分钟再兑换，必须失败。
- [ ] `OA-09` `P1` 重放同一 callback；不能生成第二个 session，登出后重放也不能恢复旧 session。
- [ ] `OA-10` `P1` 修改/删除 `nativeState`、修改 code、增加重复 query 参数；必须忽略或失败。
- [ ] `OA-11` `P1` 快速重复点击登录；只能有一个有效 flow，旧 flow 不能覆盖新 state。
- [ ] `OA-12` `P2` 两个客户端同时兑换同一 code；真实 PostgreSQL 中只能一个成功。
- [ ] `OA-13` `P0` 回调 URI/浏览器历史只能出现短期 `code` 和 `nativeState`，绝不能有 `token` 或 Bearer。
- [ ] `OA-14` `P1` initiation、callback、exchange 响应都有 `Cache-Control: no-store`；callback 还有 `Referrer-Policy: no-referrer`。
- [ ] `OA-15` `P1` `native_auth_code` 只含 hash、challenge、session id、redirect 和时间戳，无 raw code、bearer、verifier。
- [ ] `OA-16` `P0` client/server 日志搜索 canary、`codeVerifier`、`Bearer ` 和测试 token，结果为空。
- [ ] `OA-17` `P1` 成功或失败后 pending state/verifier 已清除；不得在流程完成后残留。

日志脱敏快速检查：

```bash
SENTINEL="manual-verifier-sentinel-$(date +%s)"
curl -i https://api.drifting.cc/api/auth/native-exchange \
  -H 'Content-Type: application/json' \
  --data "{\"code\":\"bad\",\"codeVerifier\":\"$SENTINEL\",\"redirectUri\":\"drifting://auth/callback\"}"
```

预期为 `400 invalid_grant`，响应包含 `Cache-Control: no-store`，Server 日志中搜索 `$SENTINEL` 没有结果。

`drifting://` 仍是未验证 custom scheme。人工回归可以证明流程可用和 PKCE 防重放，但不能消除其他 App 抢占 scheme 的发布风险；公开分发前仍需 iOS Universal Links / Android App Links。

## 7. General Agent

- [ ] `AG-01` `P0` 在“设置 → Agent”录入测试 DeepSeek BYOK；密钥写入 native secure storage，重启后连接状态恢复，日志和数据库中没有明文。
- [ ] `AG-02` `P1` 发起只读任务并检查项目、章节、元素、关系与素材结果；不得跨项目读取，也不得在只读任务中产生写入。
- [ ] `AG-03` `P1` 执行一个已认证写工具；变更必须进入软审阅，接受后保留，拒绝后通过 guarded inverse 撤销，正文写入仍以 live Yjs 为准。
- [ ] `AG-04` `P1` 运行中切后台、锁屏、恢复前台并重启 App；已落盘对话和结果仍可读。重启前正在等待的控制可以安全取消，但不得伪装成原 JavaScript 栈已原地恢复。
- [ ] `AG-05` `P1` 在模型流式响应和工具调用阶段分别断网；界面不得 silent success，恢复后新 turn 可继续，已提交的写入不得重复执行。
- [ ] `AG-06` `P0` 发起“逐章润色整本小说”任务；Agent 创建 `whole_book_chapters` 持久化计划，步骤数和冻结时的章节数完全一致、顺序一致，且不是由模型手工枚举。运行时仅允许一个 `in_progress` 步骤，并保留用户给出的文风、禁改项和人物语气约束。
- [ ] `AG-07` `P0` 分别让任务正常结束一个 turn 和触发一次预算上限；只要同一 session 仍有 active plan，Panel 都显示“继续此任务”且不会自动循环。点击后从首个 `in_progress`、否则首个 `pending` 步骤继续，不重复已完成章节；即使发送文本只相当于“继续”，首轮仍能看到计划、`read_node` 和 `edit_blocks`。
- [ ] `AG-08` `P1` 在长任务中退出并重启 App；文本、thinking、未完成工具参数、工具结果和 terminal 状态按 canonical journal 恢复，计划进度与 active constraints 仍在。
- [ ] `AG-09` `P1` 分别执行正文、元素、故事线、项目事实和评论写入；工具卡始终显示 durable review 状态，接受或还原后状态同步，目标若已被并发修改则安全报冲突。
- [ ] `AG-10` `P1` 用足够长的真实对话触发 compaction；续作仍记得原始目标、显式约束、已完成章节和待办章节，不重复写入。记录模型、token、耗时和任何语义遗漏。
- [ ] `AG-11` `P1` 用至少 22 章的副本执行全书任务，让所有章节先停在 review-blocked，再批量接受；重新继续后最早和最晚的步骤都能读取 `acceptedTargetEvidence=true` 并完成，不受“最近 20 条审核上下文”限制。
- [ ] `AG-12` `P1` 冻结全书计划后分别新增、改名和删除章节：新增章不进入旧 manifest；改名章沿用冻结 ID 并显示新名称；删除章显示 missing 且任务不能假装完整完成。

当前产品路径是 renderer 内的 provider-neutral local runtime，使用 DeepSeek BYOK，不需要 Node/Claude CLI、sidecar 或 remote runner。当前认证了 14 / 34 个写工具；其余 20 个、multi-provider conformance、subagent、无人值守自动续跑、具体 MCP transport/config UI 不属于“当前功能应通过”的范围，也不能据此宣称完整 Claude Code parity。动态 MCP/plugin 工具的注册、隔离、schema、检索和单次审批基座已有自动化验收，但尚无可供本清单手测的产品连接入口。

## 8. 图片与 PDF

以下用例原则上要在两个入口各执行一次：

1. 素材库导入。
2. 元素头像上传、替换和删除。

### 8.1 成功路径

- [ ] `IMG-01` `P1` 取消 picker，不新增素材、不改变头像。
- [ ] `IMG-02` `P0` PNG、JPEG 在 Android、iOS、macOS 成功；PNG 透明区无黑块。
- [ ] `IMG-03` `P0` EXIF 方向正确，横竖宽高不颠倒。
- [ ] `IMG-04` `P0` HEIC、HEIF、AVIF 在 Apple 当前系统按 ImageIO runtime capability 成功。
- [ ] `IMG-05` `P1` Android 8+ 的 HEIC/HEIF 按设备 runtime codec 能力成功；不支持时返回明确错误。
- [ ] `IMG-06` `P0` Android 12+ 的 AVIF 按设备 runtime codec 能力成功；不支持时返回明确错误。
- [ ] `IMG-07` `P0` PDF 原文件可打开，缩略图为第一页，不生成错误的 display variant。
- [ ] `IMG-08` `P0` 素材卡片、预览、元素头像和重启后的 app-owned asset 加载均正确。
- [ ] `IMG-09` `P0` 导入期间断网与 `online` 事件均不触发 hosted asset API。
- [ ] `IMG-10` `P1` 原 source hash 不变；source MIME/扩展保持 heic/heif/avif，派生图为 jpg。
- [ ] `IMG-11` `P0` 替换头像时，新图 ready 后才切换；失败时旧头像仍在。
- [ ] `IMG-12` `P1` 删除头像后重启不再显示，SQLite owner binding、asset row 与 app-owned 文件均已清理。
- [ ] `IMG-13` `P1` 重复导入同一文件不会互相覆盖。

### 8.2 失败与恢复

- [ ] `IMG-F01` `P1` Android 7 HEIC/HEIF、Android 11 AVIF、Windows/Linux HEIC/AVIF 返回 `IMAGE_CODEC_UNAVAILABLE`，不崩溃。
- [ ] `IMG-F02` `P1` codec 不支持时保留 picker import 供当前 compose 重试；不创建素材/ready asset，头像不覆盖旧值。
- [ ] `IMG-F03` `P1` 损坏图片返回 `IMAGE_INVALID`，没有 ready 的半成品 asset。
- [ ] `IMG-F04` `P0` 大于 64 MiB 的图片/PDF在 copy 完成前拒绝，临时文件被清理。
- [ ] `IMG-F05` `P1` 超过 16,384 像素或 256 MiB 解码 guard 时明确失败，App 不 OOM。
- [ ] `IMG-F06` `P1` 本地导入时断网、切后台；不得发出 hosted asset/API 请求，已提交的 source asset 重启后可读。
- [ ] `IMG-F07` `P2` SQLite 提交失败时未绑定的 app-owned asset 目录被 best-effort cleanup，picker import 仍可重试。
- [ ] `IMG-F08` `P1` 强杀发生在 SQLite commit 与文件 cleanup 之间时，重启后的 current-format inventory/GC 能报告并安全清理孤儿目录。

当前导入没有 hosted upload 状态或 Retry 状态机。`project_asset` metadata 与 app-owned source 是本地真相；`display`/`thumbnail` 是派生文件。`IMG-F08` 对应的 current-format restart GC 尚未实现，因此在实现前应记录为 `BLOCKED`，不能宣称删除 crash window 已闭合。

当前 picker/Rust pipeline 能解码 BMP、TIFF、ICO；是否让未来 SyncProvider 发布这些 source MIME，应由 provider conformance 测试决定，不能重新耦合到官方 Server allowlist。

## 9. SQLite、Yjs、同步与生命周期

- [ ] `DATA-01` `P0` 新安装后创建项目、章节、元素、关系、素材，重启后全部存在。
- [ ] `DATA-02` `P0` 离线输入唯一正文 canary，等待本地落盘后强杀；离线重开内容逐字一致。
- [ ] `DATA-03` `P0` 离线新增/修改多类实体和素材，重启本机后无重复记录且 app-owned source 仍可读。
- [ ] `DATA-04` `P1` 编辑时切后台、锁屏、旋转、接电话，再回前台；正文与选择状态不损坏。
- [ ] `DATA-05` `P1` 导入素材时切后台或杀进程；重开后数据库无 ready 的空 asset，已提交 source 不丢失。
- [ ] `DATA-06` `P1` 登出 A、登录 B；本地数据库、项目和 session 不串账号。
- [ ] `DATA-07` `P0` Drive 同步三个带唯一 canary 的项目时快速切换项目；左栏、Tab、编辑区、关系与 bottom timeline 始终只属于当前 project，旧 hydrate 不得迟到覆盖。
- [ ] `DATA-08` `P0` 从独立设置页执行 Drive 同步，再打开恢复项目；pull/ingest/apply 时显示项目级同步提示，路由 project authority 必须在子组件挂载前就绪；远端 commit 后以只读 loading overlay 等待原子 projection，完成后一次性出现完整 workspace，不得崩溃、逐块填充或在项目间振荡。
- [ ] `DATA-09` `P1` fresh-device Drive 恢复不继承另一台设备或旧本地测试库的 Tab；本机新开的 Tab 在本机重启后仍保留。
- [ ] `DATA-10` `P1` 同一账号从第二设备编辑同一章节，最终 Yjs 内容收敛且可继续编辑。
- [ ] `DATA-11` `P2` 异常退出后重开，SQLite 无损坏提示，关键表和 Yjs snapshot/update 可读。

## 10. 覆盖升级与重装

Drifting 尚未发布数据兼容契约。候选构建只验证当前 schema 的 fresh install 与同 schema 覆盖升级；旧开发数据库应先备份后重置，不进入产品迁移路径。

- [ ] `UP-01` `P1` macOS fresh install 不扫描或复制其他客户端的数据目录。
- [ ] `UP-02` `P1` 同签名、同 schema Tauri→Tauri 覆盖升级；SQLite、`assets/`、session/BYOK 保留。
- [ ] `UP-03` `P1` 重置旧开发数据库后，fresh schema 可创建、编辑、导出、删除项目。
- [ ] `UP-04` `P1` Android 清数据或卸载重装后，本地数据与 secret 清空；没有独立备份时不得暗示可以从云端恢复。
- [ ] `UP-05` `P2` 记录 iOS 卸载重装后的真实 Keychain 行为，不预设 secret 一定清除。
- [ ] `UP-06` `P2` 记录桌面卸载重装后的 OS credential store 行为。

主题、panel 状态、快捷键、写作统计和 Agent UI 元数据属于设备本地状态。重置开发数据库或清除应用数据前必须自行备份需要保留的测试内容。

## 11. 发布阻断条件

出现以下任一情况，停止发布并建 Issue：

- Bearer、BYOK 或 PKCE verifier 出现在 URL、日志、截图证据或 Android 明文文件中。
- Android 清数据/卸载后旧 session 仍可用。
- 密文损坏后返回旧值、乱码，或发生 silent plaintext fallback。
- 同一个 OAuth code 可以成功兑换两次，或错误 state 可以登录。
- codec、网络或后台失败导致 app-owned original 丢失。
- JPEG、PNG、PDF 任一主平台回归失败。
- 图片方向错误、App OOM、数据库损坏或正文丢失。
- 失败操作留下已提交 owner row 却缺失 canonical source，或在 cleanup 后由迟到写入重新制造孤儿目录。

## 12. 结果表

| Test ID | Client/Server build | 日期 | 设备 | OS/API | 安装态 | 素材/账号 | 网络 | 结果 | 实际表现/错误码 | 证据 | Issue |
| ------- | ------------------- | ---- | ---- | ------ | ------ | --------- | ---- | ---- | --------------- | ---- | ----- |
|         |                     |      |      |        |        |           |      |      |                 |      |       |

## 13. 不属于这份回归的已知边界

- General Agent 可用，但仅限当前已认证的 local-runtime 能力；完整 Claude Code parity 和三端真机 UI 验收尚未完成。
- `drifting://` 尚未替换为 Universal Links / Android App Links。
- 完整移动端信息架构、触摸交互和软键盘适配尚未完成。
- 复杂 story graph、split editor、plot grid 的移动 UX 不以“能显示”视为通过。
