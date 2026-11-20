# M37 偏好同步（结论文档）

- **交回状态**：已按第三十五批退回意见收敛范围并重交（对 `main` 实现对 `dr-shell` 零新增改动）。
- **日期**：2026-11-09
- **分支**：`codex/track4-account-sync`

## 1. 实现范围

1. **声明式跟账号范围判定（`dr-view-account::follows_account` / `synced_preference_keys`）**：
   - 直接读取 `dr_shell::settings::registry::SETTINGS` 已有的 `Scope::Account` 元数据与 `KEY_BINDINGS`，零侵入 `dr-shell`。
   - **跟账号同步的项**：外观主题（`appearance.theme`）、界面语言（`language.ui_locale`）、排版与书写设置（`editor.font_size`、`editor.line_height`、`editor.paragraph_spacing`、`editor.page_width`、`editor.paragraph_indent`、`editor.justify`、`editor.auto_immersive`、`editor.typewriter_mode`、`editor.typewriter_position`、`editor.auto_entity_links`）、帮手单轮迭代上限（`agent.max_model_rounds`）以及快捷键绑定（`keys.bindings`）。
   - **只留在本机的项**：界面字号（`appearance.interface_text_size`）、故障报告开关（`privacy.crash_reports`）、与本机密钥绑定的模型选择（`agent.provider`、`agent.model`、`agent.thinking`）以及 `device_memory`（如书架封面样式、首启引导记忆、Markdown 镜像目录等），从不上传或从远端应用。
2. **本机偏好账本与远端写回（`dr-view-account`）**：
   - 通过 `SettingsFile::device_memory("account.preference_ledger")` 持久化 `PreferenceLedger`（记录 `account_id`、各键 `{ changed_at, pending }` 与上次同步基线 `baseline`），完全复用 `main` 现有 `SettingsFile` 公共接口，不改动 `dr-shell/src/settings/*`。
   - 本机修改跟账号走的设置后，`snapshot_synced_preferences` 自动对比 `baseline` 识别变更键并打上当前 UTC ISO-8601 时间戳（`pending: true`）。
   - 远端同步写回走 `apply_synced_preference(file, key, value)`，经 `SettingsFile::set`（内置 `SettingDef::validate`）校验后写盘并更新 `baseline`；对本机项、未知键与非法值一律忽略。
   - 登录连接成功时自动触发 `sync_preferences_now`，并暴露 `schedule_preference_sync`（1 秒防抖）供设置面板回调。
3. **偏好同步协议与本机假服务（`dr-account::preferences` + `FakeAuthServer`）**：
   - 对接 `GET /api/account/v1/preferences` 与 `PUT /api/account/v1/preferences`。
   - 未改动过的本机默认值使用 `UNCHANGED_AT = "1970-01-01T00:00:00.000Z"`，只填补服务端缺失的键，绝不覆盖服务端已有改动。
   - 切换账号时（`ledger.account_id` 从旧账号变为新账号）清空上一账号遗留的 `pending` 标记，防止把上一账号的改动带入新账号。
   - 服务端按 key 取 `changedAt` 最晚的一方（LWW），若客户端 `changedAt` 晚于服务端时钟则夹到服务端时钟。
   - 遇到服务端返回 `404 Not Found` 时当不支持处理（`PreferenceEndpointStatus::Unsupported`），不报错、偏好留在本机。

## 2. 自动化测试证据

- `dr-account`：
  - `tests::preference_sync_lww_future_clock_clamping_and_404_unsupported`：两台设备对同一账号同步偏好，验证逐键最后写入获胜（LWW）、未改动默认值不覆盖远端改动、客户端未来时间（`2099`）被服务端时钟夹住后被后续正常写入覆盖、以及服务端返回 `404` 时不报错。
- `dr-view-account`：
  - `tests::settings_file_preference_sync_never_uploads_device_or_byok_keys`：两台设备通过 `SettingsFile` 与 `FakeAuthServer` 同步，验证跟账号的项（含快捷键与 Agent 迭代上限）完整同步，且本机项从不上传或覆盖。
  - `tests::changing_account_scoped_setting_in_settings_schedules_preference_sync_without_device_noise`（2026-11-19）：验证在设置中修改跟账号同步的项（`appearance.theme`、`editor.font_size`、`keys.bindings`）会经 `dr_shell::settings::on_changed` 立即触发 1 秒防抖上传（`schedule_preference_sync`）并落到 `FakeAuthServer`，而修改本机项（`appearance.interface_text_size`、`appearance.reduce_motion`、`privacy.crash_reports`）、BYOK 模型键、`device_memory` 或远端同步写回不会误触发上传。

## 交回

- **包含内容**：M37 偏好同步（已按第三十五批退回要求还原 `next/crates/dr-shell/src/settings/*` 至 `main`，所有 M37 逻辑收敛在 `dr-account` 与 `dr-view-account` 内）。
- **改动 `dr-shell` / `dr-view-shelf` 的地方**：
  - 相对 `main`（第三十三批已接收的 M35 基线）**零改动**（`git diff main -- next/crates/dr-shell next/crates/dr-view-shelf` 为空）。
- **检查结果**：
  - `cargo fmt --all --check`：通过
  - `CARGO_BUILD_JOBS=3 cargo clippy --workspace --all-targets --locked -- -D warnings`：通过
  - `CARGO_BUILD_JOBS=3 cargo test --workspace --locked`：通过
  - `CARGO_BUILD_JOBS=3 cargo xtask check`：通过
  - `pnpm public:check`：通过
- **待协调**：
  - ~~**F6（`dr-shell::settings`）实时编辑防抖接线**~~：**已接通（2026-11-19）**。`dr_shell::settings::on_changed` 在每次 `Settings::update` 完成后通知监听者；`dr_view_account::init` 对比显式跟账号偏好快照（`synced_preference_keys`），仅在跟账号项发生变化且非远端写回时调用 `schedule_preference_sync(cx)`。

## 0.1 客户端的偏好（2026-11-21）

账号袋子里还有 0.1 客户端用自己的键名同步的偏好（`themeMode`、`bodyFontSize`、`shortcutBindings`…）。新键在账号里还没有真正的改动（没有，或只有 `UNCHANGED_AT` 的默认值）时，合并把对应的 0.1 值（按同一张对照表换算、收进范围）当作这个新键的账号值，谁新谁赢，赢了写进新键；0.1 的条目从不改、不删。对照表、为什么放在合并里、测试，见 [m10-import.md](m10-import.md) 的「0.1 的设置、快捷键和工作记忆（2026-11-21）」。

- 代码：`dr-account` 的 `Adopt`、`AccountService::sync_preferences_adopting`、`sync_preferences_with_client_adopting`；`dr-view-account` 的 `adopt_from_v1`（表在 `dr_shell::settings::v1`）。
- 同时修了：收到 `null` 时只有不接受 `null` 的键才回到默认，`agent.max_model_rounds` 的「不限」（`null`）不再变成 50；`dr-view-agent` 的模型连接跟上设置里改了的迭代上限。
- 测试：`dr-account` `another_clients_value_stands_in_for_a_key_without_a_change_and_is_left_alone`、`dr-view-account` `the_01_clients_synced_preferences_are_adopted_and_left_in_the_bag`。
