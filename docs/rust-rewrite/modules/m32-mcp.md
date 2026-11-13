# M32 MCP

交回状态：分支 `codex/m32-mcp`，实现提交 `0f3a1dc6`，本提交补记交回。入站、出站及设置验收已完成；全量检查中的书架超时与通过的串行复验见「验收」，真实客户端和 Windows 原生运行仍见「待协调」。

2026-11-08。实现任务书（`handoff/m32-mcp.md`，已随过程文档清理删除，在 git 历史里），复用 [M27](m27-agent-runtime.md) 的调度与结算、[M29](m29-agent-tools.md) 的唯一作者工具目录，以及 [M31](m31-agent-panel.md) 的库级 Controller。没有另建 CRUD 注册表或模型驱动。

## 做了什么（大白话）

外部代理通过 `drifting --mcp --connection <文件>` 接入已经运行的应用。这个进程只在标准输入输出和本机连接之间转发协议，不开窗口，不获取应用单实例锁，也不启动日志或崩溃上报。macOS 使用私有 Unix socket，Windows 使用本机回环端口。连接使用当前打开的书；回到书架时没有可用书，切书后必须重新读取，不能把上一本书的观察带回来。

外部代理看到的工具目录跟着打开的书走。没开书时是注册表的基础目录；开着书时就是帮手为这本书用的那份目录：基础工具，加上这本书的模板声明、绑在开着「层级」开关的条目上的动作（例如小说模板书稿上的「新建章节」）。动作的工具名是稳定标识 `action:<书>/<条目>/<模板>/<动作>`，作者起的名字放在 MCP 的 `title`，描述里带所在路径和目标模板。切书、回书架或换库时，以及作者改了这本书的模板或层级、使列表变了时，应用发 `notifications/tools/list_changed`，客户端重新列。只是列目录不留任何记录，也不开外部会话。

设置里有 Codex、Claude Code、Antigravity 的连接、重新配置、配置和撤销，以及手动连接。没有只读／允许修改档位，读旧授权时丢弃这类字段。复制或写入客户端的配置只有应用路径及连接文件参数，令牌留在私有文件中。

帮手也能连接外部 MCP 服务。每本书保存自己的 stdio／HTTP 配置，秘密值放 F7 的钥匙串。`mcp_search` 查本机发现的目录；`mcp_call` 每次都走 M27 的 `ExternalPlugin` 确认，确认绑定当次配置与工具修订。切书不把仍在原书运行的聊天转向新书的插件。

## 定下的事

**对外调用仍进入同一个 Runtime。** 网络层把目录中的名称包装成现有 `call_tool`，交给应用的 `AgentController::open_external`。外部 scope 和聊天共享工具执行器及读写调度器；没有绕过 M29 的读取覆盖、版本检查、冲突停止、来源回执及 `history.undo_agent`。外部入口仅接受目录中的 Local 工具，不暴露提问、插件调用、模型设置或长任务控制。

**目录就是帮手的目录，MCP 不另存一份。** 没开书（或授权只限另一本书）时，`tools/list` 给 `Catalog::new()` 的基础目录。开着书时，`tools/list` 经 Host 的目录来源直接读 `AgentTools::catalog_for_book`：应用适配把帮手（`CompanionTools::shared`）用的同一个 `AgentTools`（克隆共享同一份缓存）交给 `McpGlobal`，在 Agent controller 的读租约下、MCP 反应器的阻塞线程上读，所以聊天和 MCP 的名字、说明、Schema 与 revision 天然一致，换库释放也会等这次读完。列目录不开外部 scope、不写审计或 journal、不排共享调度器；只有调用进入 Runtime。

**调用和列出的一致。** 调用先在打开的书的当前目录里找这个名字，找到才开 scope：基础工具照旧用 `name`，动作改用 `call_tool` 的 `action` 字段（M29 不许用 `name` 叫动作），都带当前目录的 revision。这条连接在本代次列过、而那一项的 revision 已经变了，就在进入 Runtime 前拒绝（「列出之后已经变了，请重新列」），不按客户端没见过的绑定执行。动作标识里的书不是打开的书，同样在进入前拒绝并说明它属于哪本书；本书没有绑定的动作和未注册的名字也拒绝。列目录不确认切书：切书后即使客户端已经重新列过，第一次调用仍报「书变了」，再调用才进入新 scope。

**目录变化的通知。** 服务器声明 `tools.listChanged`。每个选择代次（切书、回书架、换库或 Host 重挂）都发一次 `notifications/tools/list_changed`；连接初始化前订阅，初始化期间的变化也不漏。书内的变化也发：Host 记着本代次最后读出的目录，再读到不一样的（名字、顺序、revision、说明或动作名称有别）就把目录代数加一，每条连接各发一次。比较的时机有三个：应用适配用 `Host::follow` 订阅这本库的书目事件（`WsEvent::Book`），打开的书一有改动、且有客户端连着，就在 150 ms 内合并后读一次目录（`catalog_for_book` 按书目版本缓存，模板和层级没变时结构戳相同、直接复用原目录，比较只是指针相等）；列目录和调用时也各读一次；Runtime 拒绝一次动作调用后再读一次，以防查找和执行之间刚好变了，调用本身从不重试。改普通条目、正文、字段这些不改目录的编辑不发通知。

**外部审计不冒充聊天。** 每条连接／书代次有独立 session，工具 call id 由 Runtime 生成，外部 JSON-RPC id 不能控制写入来源。日志在 F2 的 `local_state`，scope 为 `agent.external.sessions`／`agent.external.events`，关联书 id；不建虚假 ConversationDoc、不加数据库迁移、不上传本机日志。accepted、started、回执和终态按序落盘；恢复核对真实 F3 回执并标记中断，不重跑工具。单项大结果只保存字节数和 SHA-256 摘要，完整回执按页保存，结束事件与最后一批回执同事务提交。损坏／缺号事件不能被当作成功恢复，已清除的书不能因追加日志复活。

**撤销、切书、取消与退出都是入口屏障。** 撤销先持久删除授权，再取消旧 lease；排队中的调用在取得共享调度器后再次核对授权和书代次。Host 发布新书前同步冻结旧 scope。scope 关闭等待实际工具线程和它持有的最后一个 ToolContext，已提交的修改保留并结算。连接初始化也有独立等待者：断线或 SDK 丢弃 handler 不会丢掉稍后才完成的 scope。取消读取后结束其 scope，避免重用客户端未收到的读取覆盖；结束的 scope 不会被同一连接悄悄重开。

**外部结果直接返回。** 使用 MCP `content` 的文本 JSON 和 `isError`，包含 session、book 与 M27 ToolResult；不同时放 `structuredContent`，避免旧 Claude Code 以其替代实际文本。当前上限为请求 1 MiB、响应 4 MiB、认证行 4 KiB。超长无换行输入立即断开，响应过大则结束 scope，要求分段重读；没有恢复旧的持久结果工件分页。连接数、排队调用数、请求 id 数及重复 id 都有界限。

**授权属于应用实例，不属于库。** 文件放 F7 `AppDirs.data/mcp`，开发 profile 的身份和目录保持隔离。Unix 文件 0600、目录 0700，拒绝符号链接、不安全所有者或共享写权限；socket 超长时沿用用户私有缓存的短路径规则。Windows 端点只绑定回环，文件使用用户 AppData 的继承 ACL，不声称 Windows 支持 POSIX 权限。令牌以随机字节生成，registry 仅保存哈希；被撤销的旧 lease 即使重名连接再次建立也不复活。

**一键配置保留作者其他设置。** Codex 使用 TOML 编辑保留注释，JSON 客户端保留无关数字精度与内容；写入有备份、写前磁盘原值核对、原子替换及同步。外部客户端不参与本应用的文件锁，因此这不是跨进程原子 compare-and-replace；极短的最终核对／替换间隙仍可能撞上其他程序写入，原内容保留在备份。配置失败撤回新授权。启动修复只更新仍属于本安装的条目，不重建用户已经删掉的条目；不能从哈希猜回丢失的令牌。旧单书连接升级到跨书连接时先装好新的，再撤旧的；撞上非本应用条目则保留原授权。无法判定持久化是否成功时关闭授权缓存，重启重读，不继续以旧缓存授权。

**插件调用不自动重放。** stdio 使用绝对程序路径、受限继承环境及显式参数，进程组／Windows Job Object 负责收尾。HTTP 沿用旧版目的地址规则：回环可用 HTTP，公网必须 HTTPS，拒绝重定向、代理、私网解析及不安全地址转换；使用实际连接的 DNS 结果做检查。请求、响应、SSE 原始字节、头部和工具目录分页有界。过期会话和网络错误不会触发自动重新初始化并重发工具；只发一次调用，不自动处理新的输入轮或远程任务。中断后远端结果可能未知，不能宣称已经撤回远端修改。

调用失败后先撤销连接的可用状态，再等待 transport 清理。清理失败同时保留原调用的“远端结果未知”和安全的清理错误，不会提前返回并留下 Ready 目录；即使持久状态写入失败，本机能力修订仍已失效。该边界按最新整合预审反馈补故障注入契约。

目录检查约束工具数量、分页、名称、Schema 结构／深度与本地引用；这不是完整 JSON Schema 元模式校验器。HTTP 端点在交给 SDK 前使用规范化 URI，接受合法的无尾斜线回环根地址。

**协议内容不进入应用日志。** rmcp 的服务层会在 debug／info 记录请求、结果或通知，异常初始化的 warn 也可能带全文。F7 的 stderr／文件格式层专门排除 `rmcp` 及其子 target，并且不能由 `DRIFTING_LOG` 的更细配置重新启用；其他日志和 `dr_mcp` 自己的固定错误状态保留。没有重写 SDK 协议，也没有全局关日志。合成捕获测试验证两种输出及显式 trace override。

**配置与确认按代次失效。** 每次配置保存、secret 引用变更、目录或连接变更都有新的能力修订，旧编辑表单和旧确认不能落到新配置。更新使用 F2 CAS，新 secret 引用只在对应配置成功提交后保留；失败仅清理本次创建的引用。书被清除后，同事务存在性检查拒绝保存配置或目录。切库时同步清空 PluginSlot，等待 Manager 的所有配置、钥匙串和连接收尾操作；旧 Manager 克隆不保留已释放库。

stdio 清理在排入异步回收任务之前立即终止进程组／Job；尚未执行的清理任务被 runtime 销毁时也有 Drop 兜底。正常关闭等待 reap 和 stderr 读取任务结束后才确认完成，已回收的组不会再次收到信号。紧急 runtime 销毁的回归只验证终止信号路径，不把它当作正常会话结算的证据；专门的主／孙进程回归区分这两个边界。

## 旧版 89 项与新版目录差异

旧版 `drifting-workspace-tool-contract.ts` 的 26 个读工具、62 个写工具，加 `read_tool_result`，组成对外 89 项；M29 的旧内置清单另外包含 8 个非对外工具，因此其总数是 97。新版对外直接导出 M29 的基础目录；完整名字由 [目录快照](../../../next/crates/dr-agent-tools/tests/snapshots/catalog__directory.snap) 验证，逐个旧作者工具的映射沿用 [M29 对照表](m29-tool-mapping.md)。开着书时再加这本书模板绑定的动作，数量随书而变，不进快照。数量变化不代表逐项等价或开放了 M29 排除的命令。

| 旧入口或范围 | 新版差异 |
| --- | --- |
| 概览、单对象读取、章节／要素／构想等 CRUD | 使用注册名称和 Schema；部分旧聚合读取拆为 book／实体列表／prose 查询。各旧名的具体对应见 M29 表。 |
| `revise_chapter`、`revise_element`、`revise_inspiration`、`revise_storyline`、`revise_material_note` | `prose.read`＋`prose.replace`；目前只支持已有段落的精确替换，保留 M29 的完整读取与版本要求。 |
| 六个 `replace_*_body` | 未开放整篇结构替换；不能借新建正文绕过 F3 缺失接口。 |
| `replace_storyline_chapters`、`update_relation` | 没有原子等价入口，继续等待 F3；不把多次调用称作一次事务。 |
| `delete_comment`、`delete_element_patch`、`delete_relation_type` | 隐藏关联的准确读取接口未具备，维持 M29 排除。 |
| `create_relation` | 必须省略 id，禁止重写未读的隐藏关系。 |
| `get_project_facts`／`update_project_facts` | 改为事实条目列表、put／remove；不是旧虚拟文件的整段覆盖。 |
| `write_plot_grid` | 拆成格子和行列命令；不提供旧整表替换的原子保证。 |
| `view_material` | 只有素材和资产元数据；不声称代理已读取图片或 PDF 内容。 |
| `read_tool_result` | 暂无旧结果工件分页；过大结果明确失败并要求更小读取。 |
| 来源撤回、回收站恢复、模板、布局及其他新版注册查询 | 直接来自 M29 的已开放目录，不为 MCP 再造别名或私有能力。 |

## 接口与外壳挂接

- `dr_mcp::bridge::run(path)`：`Launch::Mcp` 的无窗口入口；转发停止后关闭 runtime，不等待仍打开的客户端 stdin。
- `GrantStore`：应用身份级授权与串行文件操作。`connect/create_manual/revoke/repair_owned` 在返回 future 前已入队，丢弃等待者不丢弃文件收尾；`authenticate/validate` 只读短内存快照，`drain` 是队列屏障。
- `Host`：当前书与代次，`replace/select/suspend/open_external`；ScopeOpener 必须接 M31 同一个 Controller。
- `inbound::Server`：接受认证后的 rmcp 会话，`close` 同步取消入口、异步等连接和 scope 收尾。每条连接订阅 `Host::watch` 和 `Host::catalog_changes`，任一变化就发 `tools/list_changed`；列目录和调用都按 `Host::selection` 当下的书与代次。
- `Host::replace(book, Backend { opener, catalog })`：后端由应用适配一次给齐，`suspend` 一并收回；`Host::catalog(book, epoch)` 是列目录与调用共用的读取，`Host::follow(workspace)` 返回书目事件订阅，释放库之前丢掉。
- `outbound::Manager`：库级插件配置、目录及连接；`activate` 选择设置页显示的书，调用权限仍取 `ToolContext.book`。`PluginSlot` 在库边界替换，`PluginTools` 只新增 `mcp_search`、`mcp_call`。
- `dr_view_agent::mcp::init` 在 Agent 初始化前登记 release hook，并建一个共享的 `AgentTools` 放进 `McpGlobal`，`dr_view_agent::init` 用 `CompanionTools::shared` 交给帮手。它观察真实 Workspace 的书、书架与窗口激活，即使没打开帮手面板也工作；切到外部客户端不会清空最后激活窗口的书。切库后等新的 AgentHub 就绪，重建 Manager、Host 后端（开 scope 与读目录都经新的 controller）和书目订阅；`prepare_close` 先丢订阅再交出库。
- AgentHub 发布后显式调用 `attach_agent` 注册观察者，不能依赖 `cx.defer` 跨模块初始化：原生启动会在下一个实体创建时冲刷回调。回归把两个初始化拆开，覆盖真实窗口发现的这一时序差异。
- `mcp_settings` 通过 F6 `agent.mcpAccess`／`agent.extensions` 两个声明式设置入口呈现；按窗口缓存视图，关闭设置清空表单中的秘密输入。
- 扩展配置加载失败显示旧版错误文案，不冒充空列表。加载 ACK 与入站配置警告分开，按库代次、书和请求序号过滤；切到别书、返回原书或释放旧库后，迟到结果不能覆盖新状态。丢弃界面等待者不会丢弃 Manager 的后台操作与释放屏障。

## 验收

契约用 Rust 测试，正文只取 F8 种子；授权和客户端文件写临时目录，提供商与外部 MCP 服务只用本机合成服务。配置快照由测试生成。

- 入站集成测试经真实 Unix／回环连接列出 M29 目录、完整读章、修改段落并按来源撤回；还覆盖重复请求 id、长度限制、撤销、切书及切回、取消、断线、延迟创建 scope 和关闭时的实际写入结算。
- 书的目录（`tests/inbound.rs`，F8 小种子的两本书，动作从种子书的目录里找，不写死模板 id；夹具的目录来源读夹具 Runtime 自己的 `AgentTools`，并用 `Host::follow` 跟书目事件）：开着书时列出的名字、顺序、说明和 Schema 与 `catalog_for_book` 一致，动作带作者名称作 title、不含另一本书的动作；列目录前后 scope 为零，外部会话、审计事件与 workspace journal 的行数不变。书稿上的动作未读先拒（`read_required`）且不发通知，读后经同一 Runtime 新建条目并留下本 session 的回执。没开书时是基础目录，调动作报「没有打开的书」，不开 scope、不留审计。另一本书的动作、本书未绑定的动作和未注册的名字都在进入前拒绝：没有 scope、没有审计、没有回执。切书和回书架各收到一次 `list_changed`，重新列出的就是新书或基础目录；列过之后第一次调用仍报切书。改名一个普通条目不发通知；作者关掉动作住处的层级开关后，客户端什么都没调就收到一次 `list_changed`，按旧列表调用在进入前被拒、不重放；重新列出、重读后按新绑定在动作自己的层级下建成，前后只通知一次。
- 应用适配（`dr-view-agent/tests/mcp_lifecycle.rs`）：经适配层的目录来源读到的目录，与 `McpGlobal` 里帮手共享的 `AgentTools` 为同一本书算出的是同一个缓存实例（指针相等）；换库后重建的后端读新库的目录。
- 出站集成测试运行合成 stdio／HTTP 服务，覆盖发现、分页、秘密引用、每次批准与配置修订失效、取消、子进程退出、过期会话不重放、无尾斜线 URL、配置回滚及删除书后不复活。
- 清理故障注入经真实 Runtime 许可及 HTTP 调用，验证等待清理期间就失效旧目录，清理失败与状态 CAS 失败都保留原未知结果，错误原文不泄露，也不重发调用。
- 应用二进制回归验证：远端 EOF 后，即使客户端保留 stdin 打开，`--mcp` 进程仍退出；不打开 GUI、stdout 没有非协议文字。
- GPUI 回归覆盖不打开帮手栏时的书切换、F6 换库／端点保留、原生初始化时序，以及服务就绪后的真实点击和名称键盘输入。
- 真实窗口场景 `scenarios/mcp.json`：68 步，0 pending，正常退出；检查三客户端连接／重新配置／配置／撤销、手动连接、HTTP 表单和秘密值遮蔽、保存／停用／编辑／删除、stdio 切换和取消。已看截图。窗口使用关闭的回环端口验证连接失败后仍可管理配置；协议握手和实际插件执行由上述合成服务集成测试验证。

窗口复验（在 `next/`）：

```bash
cargo build -p drifting --example mcp-acceptance --features debug-bridge --locked
cargo drifting workspace scenario crates/dr-view-agent/scenarios/mcp.json \
  --app target/debug/examples/mcp-acceptance --out target/acceptance/m32-mcp
```

`cargo fmt --all --check`、`cargo clippy --workspace --all-targets --locked -- -D warnings`、`cargo xtask check`（含 audit）、`pnpm public:check` 和九语言同步检查通过。audit 无漏洞，12 条既有依赖通知；公开边界检查覆盖 5326 个文件。

完整 workspace 单线程检查为 1864 通过、0 失败、22 忽略。随后整合预审新增的两项清理失败契约均通过，并再次运行完整工作区：1865 通过、1 失败、22 忽略；唯一失败为未修改的书架封面测试限时。该测试组随后以同一产物串行重跑，10 项全部通过，10.90 秒。最终 1866 项均有通过记录；这不等同于最后一条两线程命令零退出码，整合复验建议用 `RUST_TEST_THREADS=1`。

Windows `x86_64-pc-windows-msvc` 的 `dr-mcp --all-targets` 已用 cargo-xwin、MSVC SDK 交叉检查通过，零警告。这是编译证据，不是 Windows 原生运行验收。

## 待协调

1. **K6／后续 v3 接回方：** M29 的结构正文、隐藏关联级联、转换及历史边界照其模块文档；不能因 MCP 已能列工具就解除排除。M17、M19 仍冻结，不启动旧分支复审；以后正式接回时再补实际 AgentTools 回归。
2. 真实 Codex／Claude Code／Antigravity 的安装路径、版本差异和作者自建服务由作者手测。本模块测试不读取或改写作者真实客户端配置，不使用真实提供商密钥。
3. **轨道 3：** 外部审计目前随库保留并在书清除时移除；日志保留与分页整理待统一设计，不为提速跳过未结算回执恢复。
4. **轨道 4 的 M43／作者：** Windows 的原生启动、作业对象退出与安装目录手测；本模块提供回环测试及交叉编译证据。
5. **轨道 2 的 F5：** `Button::disabled` 当前禁用点击并变灰，但原生 AX 仍报告 enabled；GPUI 没有现成的 disabled builder。本模块窗口验收检查实际表单／列表变化与截图，未把 AX enabled 当成就绪证据；通用无障碍禁用状态由 F5 统一补，不阻挡 M32 接收。

## 代码位置

- `next/crates/dr-mcp/`：授权、客户端配置、私有文件、协议桥、入站 Host／Server、出站 Manager 和插件工具。
- `next/crates/dr-agent/src/runtime/external/` 及 `external.rs`：无模型循环的外部 scope、持久审计及恢复。
- `next/crates/dr-view-agent/src/mcp.rs`、`mcp_settings/`、`tools.rs`、`controller.rs`：应用生命周期、设置与同 Runtime 接线。
- `next/app/drifting/src/main.rs`、`examples/mcp-acceptance.rs`：正式命令入口和隔离的窗口验收入口。
- `next/crates/dr-platform/src/logging.rs`：M32 所需的 SDK 原文日志过滤；仅改两种输出的过滤挂接点。

## 轨道 3：出站清理 P2 复验（2026-11-09）

交回分支 `codex/m30-long-tasks-memory`，合入 main 后核对：队列描述的是预审冻结副本，修复及永久故障注入已经在本分支祖先 `0f3a1dc6` 中。本项不重复改写传输实现或扩大工具目录。

当前错误路径在等待 `close` 前设置 stale 与内存 `Status::Failed`，无论清理或状态落盘是否失败都使目录和旧确认修订失效。原始调用的“远端结果未知”保留；清理与状态落盘错误追加经过脱敏的说明，不覆盖原结果、不自动重放。

执行 `cargo test -p dr-mcp --locked` 全部通过，包括真实回环 HTTP／Runtime 的 `call_cleanup_failure_preserves_unknown_outcome_and_invalidates_catalog` 和 `call_cleanup_and_status_failure_still_invalidates_catalog`：清理阻塞期间即不可用，清理失败、状态保存也失败时仍不可用；原调用、初始化均只有一次；原始私密错误不外泄。测试是本机合成服务，不代表真实第三方 MCP 客户端或 Windows 实机验收。
