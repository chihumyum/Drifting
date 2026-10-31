# 客户端引导与 Hosted 推广准备

核对日期：2026-10-28。依据当前 Tauri 源码与当日只读的 GitHub 状态；不代表生产服务、签名安装包或真实账号验收已经完成。公开发布契约仍暂停，本次没有启用发布工作流或部署服务。

## 当前 onboarding

| 阶段 | 当前行为与源码 |
| --- | --- |
| 打开本地资料库 | `store/auth.ts` 的 `checkSession()` 先打开固定本地库；账号凭据加载和服务会话探测在后台进行，网络不阻塞本地写作。`isAuthenticated` 在这里表示本地入口可用，不等于 Hosted 登录成功。 |
| 首次引导 | `components/modals/PreAlphaOnboardingDialog.tsx` 使用 `drifting.alpha-guide.v6:<localUserId>` 的 WebView localStorage 标记。桌面在书架挂载前展示；移动端为覆盖层。确认后通常不再展示，清除 WebView 存储可重置。 |
| 能力说明 | 当前提示本地保存、可选 Hosted 信任边界、BYOK，以及配置 Hosted 时的崩溃报告。没有交互式编辑器教程、示例作品导览或逐步任务。 |
| 本地分支 | 默认源码构建 `VITE_LOCAL_ONLY_MODE=true`，仅显示“先在本地写作”；进入书架后自行创建项目。 |
| Hosted 分支 | 显式配置服务的构建另有“登录 / 注册并同步”；桌面在原弹窗中打开 `features/auth/AuthFlow.tsx`，已有会话则进入账号设置。之后也可从用户菜单或账号设置登录。 |
| 认证 | 支持邮箱密码、邮箱验证码登录、注册后验证邮箱、找回密码；社交登录目前关闭。生产构建默认关闭注册，需显式设置 `VITE_CLOSED_BETA=false`。注册展示条款与隐私链接，默认条款地址为空。 |
| 首次连接 | `sync/hosted/sign-in.ts` → `connectHostedFromProduct()`：下载云端项目、上传当前本地书库，完成后打开书架；失败提供重试或稍后处理。登录不另建资料库。 |
| 开始写作 | 进入书架，创建项目、节点并写作。AI 另行配置，写作本身不要求模型密钥。首启未引导用户形成第一篇内容，也未帮助用户判断跨设备切换何时安全。 |
| 可读副本与备份 | 桌面项目就绪后自动生成只读 Markdown 投影，默认在应用数据目录，设置里可改目录。引导未让用户确认位置、查看首次生成结果或打开目录。投影和 Markdown ZIP 都不是完整备份；可恢复的 `.drifting` 备份目前要求稳定的本地、未绑定云端的资料库。 |

## 推广阻碍，按优先级

1. **尚无完整的 Hosted 安装入口。** 当日 GitHub API 返回没有 release；`CI`、`Release macOS Alpha`、`Promote Alpha updater channel` 都是 `disabled_manually`。`.github/workflows/release-alpha.yml` 仍将两处构建配置为 local-only 和 localhost。应先确定官方 Hosted 分发配置，再重建暂停中的发布契约；开源源码的默认本地模式可以继续保留。
2. **注册和服务政策仍需分发配置。** `utils/appAccess.ts` 在 production 默认关闭注册；默认 `VITE_TERMS_URL` 为空。公开 Hosted 包需要配置统一的 HTTPS origin、原生 allowlist、CSP、开放注册、条款与服务隐私说明，并验证真实邮箱送达、验证码、找回密码、过期会话和错账号行为。当前测试不证明这些线上能力。
3. **自动更新交付未成立。** 当日更新清单端点 `https://chihumyum.github.io/Drifting/updates/alpha/latest.json` 返回 HTTP 404。需要签名、公证、已安装版本升级与迁移保留验收。旧审计中“安装前未 flush”的问题已在当前源码解决：renderer 安装前 flush，原生重启走退出保存屏障；不再将它列为未修复代码缺陷。
4. **首次成果和安全感不足。** 当前欢迎页本质是说明与入口选择，缺少首次项目/第一段文字的引导；Markdown 投影的位置与生成结果不明显。建议把“确认可读副本目录 → 看到首次生成成功 → 写下首段文字”作为下一轮 onboarding 的具体产品改造，本次只记录，不擅自改动流程。
5. **Hosted 与独立恢复的组合尚有缺口。** 登录会上传整个本地书库；先本地试用、后登录的边界必须让用户看懂。完整备份当前不能直接覆盖云端绑定资料库，投影不能被宣传成完整备份。需要独立的账号备份/导出恢复路径、两客户端离线合并及新设备恢复验收。
6. **运营与发布文案需形成同一契约。** 客户端已有配额、删除、重试与本地持久化，但生产服务的备份异地性、恢复演练、告警、滥用控制、可用性及支持入口没有在本次核验。服务端仍独立运营，不应把客户端开源描述成已经提供 Hosted SLA。收费、Hosted AI 也不属于当前客户端能力。

## 可复现证据

Hosted HTTP/SQLite 集成测试覆盖保留隔离数据、失败回滚、新设备恢复与本地内容安全。`pnpm hosted:acceptance` 重新生成 [当前客户端证据](hosted-sync/acceptance/client.json)，`pnpm hosted:acceptance --check` 核验源码指纹。

这些检查不等于真实账号注册、邮件送达、原生输入体验、签名安装、生产部署或升级验收。

本次已通过全量 Vitest、共享 Rust 核心与 Tauri 库测试、TypeScript 检查、renderer 构建、公开边界、CI 契约、Agent capability/conversation 与 compaction 证据检查。Lint 无错误，仍有现存警告；renderer 构建仍有体积警告。

Hosted HTTP 验收另外使用独立 Docker 项目、合成账号和本机 Mailpit，完成了测试邮箱验证码送达与同步用例，生成报告后已移除临时容器、数据卷和临时凭据。这证明本地兼容服务的测试链路，不证明生产邮箱、生产服务或分发安装包可用。
