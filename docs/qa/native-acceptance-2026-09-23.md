# 2026-09-23 原生窗口、模拟器与真机验收报告

## 结论

**桌面核心冒烟通过；iPhone 启动阻断已修复，基础生命周期通过；模拟器交互受工具阻断。完整移动端和正式安装包验收尚未完成。**

源码可按 Desktop Alpha、移动端实验性的范围准备公开。本变更提交后，
确认该提交的 CI 和公开边界检查通过，即可由维护者决定公开仓库。
正式二进制发布仍须完成签名公证、真实账号和下述设备验收缺口。
这份报告没有把仓库改为公开，也没有发布安装包。

## 环境与构建身份

- 基础提交：`68f1afce9389a4775c58c8ccaba3d524634e8993`；本轮修复是该提交上的未提交候选，不能把候选伪写成未来提交的构建。
- Mac：Apple Silicon（Mac15,7），36 GiB，macOS 27.0；Xcode 27。
- 桌面：重新构建的 Apple Development 签名 Debug，`0.1.0-alpha.1`。使用独立验收 bundle ID 和本地书库；旧 Debug 包先移至本地留存位置。
- iPhone：iPhone 17 Pro Max，iOS 27.0；通过维护者明确授权的 iPhone Mirroring 操作真实设备。
- 真机包：`cc.drifting.client`，版本 `0.1.0 (0.1.0.1)`，原位覆盖安装，未卸载或重置已有数据。所有写入仅在新建合成验收项目中。
- 模拟器：独立 iPhone 17 Pro / iOS 26.5 / arm64 设备；已启动、构建并安装最终候选。
- 最低 iOS 版本统一为 **15.0**；iOS 14 不再支持，也不再列入验收。没有可用的 iOS 15 runtime，因此这次不能声称已在 iOS 15 实机运行。
- 桌面与 iOS 构建共用前端产物目录；最终采用顺序构建。一个重叠构建候选被取消并重新构建，不计入证据。

最终可执行文件 SHA-256（完整值用于区分实际测试产物）：

| 产物 | 构建时间 UTC | SHA-256 |
| --- | --- | --- |
| macOS Debug | 2026-09-22 18:16:54 | `d9825d381115f6a918639aa26f75294fbe337b1ea974fa177ca5ce69b92d5d9b` |
| iPhone Debug | 2026-09-22 18:15:46 | `17ca69ee52ff259be0616f0b024227ff776c264dda8cc4fae9a26209f2fcf2b1` |
| iOS Simulator Debug | 2026-09-22 18:19:18 | `691b2b242ab10e7842e2b52a4915451c7ffe82211a08b5dd01e4398a738500ac` |

桌面与真机签名均通过 `codesign --verify --deep --strict`。
这些是开发签名 Debug，不是公证过的 Release Candidate。原始构建日志、设备标识、
崩溃文件和数据库留在被忽略的本地验收目录，不进入公开仓库。

## 实际交互结果

| 范围 | 用例与观察 | 结果 |
| --- | --- | --- |
| 桌面 | 本地模式首次引导，不登录即可进入空书架，新建合成项目及章节 | PASS |
| 桌面 | 输入正文；撤销移除 `UNDO-REDO-CANARY`，重做恢复 | PASS |
| 桌面 | 退出并重新打开，项目、章节、已选标签与正文标记保留 | PASS |
| 桌面 | 原生文件选择器导入 Markdown，中文、标题、粗体与斜体保留 | PASS |
| 桌面 | 原生文件选择器导入 DOCX，中文、标题、粗体和 `&` 保留 | PASS |
| 桌面 | 损坏 DOCX 显示解析错误，开始导入禁用；未生成空灵感条目 | PASS |
| 桌面 | 清除失败文件后导入 TXT，中文、换行和独立段落保留 | PASS |
| 桌面 | 元素全景、叙事结构图、展开三个导入灵感、返回编辑器和打开设置 | PASS（入口与小样本加载） |
| 桌面 | 最终回补版本重新启动，原章节及 TXT 中文正文正确恢复 | PASS |
| iPhone | 修复前新构建包连续两次启动闪退，收集到对应系统崩溃记录 | FAIL → FIXED |
| iPhone | 补入 scene 声明与生命周期释放修复后进入书架 | PASS |
| iPhone | 新建独立合成项目、章节，镜像键盘可产生正文 | PARTIAL（输入保真问题见下文） |
| iPhone | Home 进入后台，再回前台，章节与正文仍在 | PASS |
| iPhone | 应用切换器中划掉 Drifting，重新冷启动，再打开项目与章节 | PASS（已落盘内容保留） |
| iPhone | 最终仅含一行上游回补的版本原位安装，冷启动并恢复同一验收项目和正文 | PASS |
| iPhone | 最终构建启动后再次查询系统崩溃目录，仍只有修复前的两份报告 | PASS（本次观察窗口内无新增报告） |
| iOS 模拟器 | arm64 Debug archive 构建和安装到已启动的 iOS 26.5 模拟器 | PASS |
| iOS 模拟器 | Xcode 27 Device Hub 多次连接均返回 `timeoutReached`，无法取得可操作窗口 | BLOCKED（不计为 UI 通过） |

桌面功能用例先在基础提交的新构建执行，最终回补版本又检查了启动、
数据恢复与编辑器渲染。没有把每个早期操作都写成在最终二进制上重新执行。

桌面验收库另做只读检查：SQLite `quick_check=ok`，4 个节点；从原生 SQLite
的 Yjs snapshot/update 重建得到四份正文，确认编辑标记与导入格式持久化。
检查对象是 Yjs 内容，不以 `content_json` 缓存代替正文真值。

| 合成正文 | 重建后的 Yjs XML SHA-256 |
| --- | --- |
| 编辑、撤销与重做 | `123b661894b1a2c6ca31dff88da9fcbd1b4131fa0b0141a0b5b1bda5f9233290` |
| Markdown | `d5c726c31c5da56bbbcaf8d353f93b2e2bd310a7cee11378db275be8d9a1d9c7` |
| DOCX | `27c06a2bd70c4295b6867b75e207dbdfe89042b84708cc7766bff0a6b7ef3c2b` |
| TXT | `6922c296c61b5b7f25dd47ec7845b2e0ffe7ff8f26a569bcd6481288b52a5f35` |

## 本轮修复

1. Tauri iOS、Xcode、XcodeGen、CocoaPods 的最低版本均改为 15.0；公开边界检查会检查四处一致性。
2. 增加静态 `UIApplicationSceneManifest` 与 `TaoSceneDelegate` 配置。原始闪退的栈顶为 `UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`，与 [Tauri 上游问题 #15719](https://github.com/tauri-apps/tauri/issues/15719) 一致。
3. 将 [tao#1245](https://github.com/tauri-apps/tao/pull/1245) 的一行 autorelease 修复回补到已发布的 tao 0.35.3。只加 scene 声明不足以安全启用该路径。保留完整上游许可证，公开边界检查校验全部 118 个上游文件；除这一行外必须保持原样。
4. 为 Xcode 27 提供显式启用的 SwiftPM `native` 后端包装器，修复 `swift-rs 1.0.7` 在默认新后端下的模拟器交叉编译失败；不修改系统 SDK。使用方式见[移动端开发文档](../mobile-device-acceptance.md#xcode-27-compatibility)。

当前 tao 依赖 `UIApplicationSupportsMultipleScenes: true` 才注册 scene delegate。
这一配置不表示 Drifting 已验收 iPad 多窗口；该场景仍未验证。

## 自动化检查

- 前端测试：439 个文件通过，1 个跳过；2,989 个测试通过，1 个跳过。
- Rust 测试：108 通过，1 个忽略；`cargo check --locked --all-targets` 和 `cargo fmt --check` 通过。
- CI contract、typecheck、lint、Agent capability 检查通过；lint 为 0 错误、71 个现有警告。
- 公开边界校验通过，包含最低 iOS 版本、scene 配置、上游回补的整树校验和本地签名身份隔离。
- 安全、源码指纹和仓库设置以重新生成的[公开准备证据](../renderer-performance/acceptance/source-publication-preparation.json)为准；该生成器记录本报告的摘要，不代替交互验收。
- 本报告不把旧提交的云端 CI 作为当前候选的 CI；应查询承载本报告的提交对应的 Actions。

## 未通过或未执行的边界

- **镜像输入保真待定位**：较长的自动输入出现缺字，标题全选替换不稳定。已观察到的部分正文可以持久化，但不能据此宣称连续输入、中文输入法、组合态、软键盘遮挡或快速打字已通过。工具传输与应用行为尚未完全区分，需要在设备原生键盘上复验。
- 桌面中文导入通过，不等于中文 IME 组合输入通过；本轮没有完成 IME 候选和连续组合态验收。
- iPhone Mirroring 不能替代设备的麦克风、相机和直接触摸；实际录音、转写、长按拖动与软键盘输入未验收。
- 模拟器交互工具受阻；iOS 15 最低系统、iPad 多窗口、Android 模拟器与 Android 真机未验收。
- 真实 BYOK 请求、双 Mac Google Drive 并发与断网恢复、生产签名公证安装包、更新器升级未执行。
- 本轮没有复验完整图片/PDF流程、全部迁移与断电故障矩阵，也没有测得原生帧率、触摸延迟或低内存设备性能指标。

## 什么时候可以开源

**源码公开**：本次修复提交并通过当前提交的 CI、公开边界和保密扫描后，
可按“macOS Desktop Alpha / 移动端实验性源码”公开；上述未验收项须保留在文档中。
无需等待 iOS 14，也无需把所有正式安装包测试都做完才公开源码。
维护者明确决定公开后，再执行[仓库可见性变更流程](../source-publication-readiness.md#visibility-change-sequence)。

**正式二进制发布**：仍须完成[桌面 RC](desktop-alpha-release-candidate.md)、
[双 Mac Drive](google-drive-desktop-alpha-acceptance.md)和移动端实际输入复验等相关门槛。
本轮结果不支持“所有平台已经完整验收”的发布声明。
