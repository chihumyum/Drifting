# M29 工具面对照

这份表以旧版生成清单的 **97 个内置工具**逐项核对（其中作者域段落列出 88 个）。旧工具名称只用于迁移核对，不是新版的第二份工具目录，也不会恢复旧虚拟路径。新版可用入口由 `dr_workspace::registry` 自动生成；实际可发现的目录及作用域排除项由 `dr-agent-tools/tests/catalog.rs` 的 insta 快照验证。

模型只收到 `tool_search` 和 `call_tool`。检索返回注册名称、说明、输入输出 Schema、读写类别、并发类别与内容修订号；作者名称在执行前解析为当前书籍内的身份。元数据观察按具体对象记录，正文观察保留页和块覆盖，版本变化会使旧观察失效。

合入 F3 第十轮并应用审查限制后，注册表共 136 项，当前目录开放 110 项、排除 26 项。排除项不会因 F3 增加了注册命令就自动变成模型可执行能力。

下表从旧版当前安装表和 F3 注册表逐行核对生成，状态与差异经过人工语义审核；“对应注册命令”表示操作存在，不额外宣称旧版表示法、完整正文编辑或一次多对象事务已等价。创建时的正文也受 F3 当前文本输入能力约束。

| 旧工具 | 新注册入口 | 状态 | 差异 |
| --- | --- | --- | --- |
| `add_chapter_to_storyline` | `chapter.update` | 字段对应 | 使用 add_storylines / remove_storylines / primary_storyline；保留 F3 的主、副故事线规则。 |
| `ask_user` | — | M27 控制接口 | ToolOutput::Question 已有；不是 F3 注册命令，目录不会伪造这一能力。 |
| `create_act` | `act.create` | 对应注册命令 | — |
| `create_chapter` | `chapter.create` | 对应注册命令 | 新 Schema 支持 narrative_order；旧修订调用在创建正文或书记录前拒绝，新修订可写指定叙事位置。 |
| `create_comment` | `comment.create` | 对应注册命令 | — |
| `create_element` | `element.create` | 对应注册命令 | — |
| `create_element_category` | `category.create` | 对应注册命令 | — |
| `create_element_patch` | `patch.create` | 对应注册命令 | — |
| `create_inspiration` | `idea.create` | 对应注册命令 | — |
| `create_material_folder` | `material_folder.create` | 对应注册命令 | — |
| `create_material_note` | `material.create` | 对应注册命令 | — |
| `create_project_memory` | `memory.add` | 对应注册命令 | — |
| `create_relation` | `relation.create` | 限制创建身份 | Agent 必须省略 id，由 F3 生成新身份；Schema 和执行入口都拒绝带 id 的调用，避免重写未读的隐藏关系。 |
| `create_relation_type` | `relation_type.create` | 对应注册命令 | — |
| `create_storyline` | `storyline.create` | 对应注册命令 | — |
| `create_timeline_marker` | `time_pin.create` | 对应注册命令 | — |
| `delete_act` | `act.delete` | 对应注册命令 | — |
| `delete_chapter` | `chapter.trash` | 对应注册命令 | — |
| `delete_comment` | — | 待 F3 关联查询 | comment.delete 会永久级联删除指向已回收对象的隐藏关联；只读 comment.list 不能覆盖它们，目录暂不暴露。 |
| `delete_element` | `element.trash` | 对应注册命令 | — |
| `delete_element_category` | `category.trash` | 对应注册命令 | — |
| `delete_element_patch` | — | 待 F3 关联查询 | patch.delete 会级联删除隐藏关联；现有 relation.list 不能提供全部受影响记录，目录暂不暴露。 |
| `delete_inspiration` | `idea.trash` | 对应注册命令 | — |
| `delete_material_folder` | `material_folder.delete` | 对应注册命令 | — |
| `delete_project_memory` | `memory.remove` | 对应注册命令 | — |
| `delete_relation` | `relation.delete` | 对应注册命令 | — |
| `delete_relation_type` | — | 待 F3 关联查询 | relation_type.delete 会级联删除隐藏关联；现有 relation.list 不能提供全部受影响记录，目录暂不暴露。 |
| `delete_storyline` | `storyline.trash` | 对应注册命令 | — |
| `delete_timeline_marker` | `time_pin.delete` | 对应注册命令 | — |
| `edit_working_memory` | — | M30 | 长任务与工作记忆不在 M29 重新实现。 |
| `find_element_appearances` | `mention.list` | 对应注册命令 | — |
| `generate_element_images` | — | M33 | 付费生图的授权与执行留给生图模块。 |
| `get_element_patches` | `patch.list` | 对应注册命令 | — |
| `get_project_facts` | `fact.list` | 模型语义变化 | 新版是具名键值事实；不恢复旧虚拟文件。 |
| `get_project_overview` | `book.get` / `chapter.list` / `idea.list` / `storyline.list` / `element.list` | 组合读取 | — |
| `list_chapters` | `chapter.list` | 对应注册命令 | — |
| `list_comments` | `comment.list` | 对应注册命令 | — |
| `list_element_categories` | `category.list` | 对应注册命令 | — |
| `list_elements` | `element.list` | 对应注册命令 | — |
| `list_entity_relations` | `relation.list` | 对应注册命令 | — |
| `list_inspirations` | `idea.list` | 对应注册命令 | — |
| `list_materials` | `material.list` | 对应注册命令 | — |
| `list_project_memory` | `memory.list` | 对应注册命令 | — |
| `list_relation_types` | `relation_type.list` | 对应注册命令 | — |
| `list_relations` | `relation.list` | 对应注册命令 | — |
| `list_storylines` | `storyline.list` | 对应注册命令 | — |
| `move_chapter` | `chapter.move` | 对应注册命令 | — |
| `read_book_structure` | `act.list` / `chapter.list` / `storyline.list` | 组合读取 | — |
| `read_chapter` | `chapter.list` / `prose.read` | 组合读取 | 先用作者名称定位，再读取正文；注册表没有独立的单对象 get。 |
| `read_element` | `element.list` / `prose.read` | 组合读取 | 先用作者名称定位，再读取正文；注册表没有独立的单对象 get。 |
| `read_element_category` | `category.list` / `prose.read` | 组合读取 | 先用作者名称定位，再读取正文；注册表没有独立的单对象 get。 |
| `read_inspiration` | `idea.list` / `prose.read` | 组合读取 | 先用作者名称定位，再读取正文；注册表没有独立的单对象 get。 |
| `read_material` | `material.list` / `prose.read` | 组合读取 | 先用作者名称定位，再读取正文；注册表没有独立的单对象 get。 |
| `read_plot_grid` | `plot_grid.get` | 对应注册命令 | — |
| `read_storyline` | `storyline.list` / `prose.read` | 组合读取 | 先用作者名称定位，再读取正文；注册表没有独立的单对象 get。 |
| `read_task_plan` | — | M30 | 长任务与工作记忆不在 M29 重新实现。 |
| `read_tool_result` | — | 待结果分页模块 | 当前结果直接返回；未移植旧版持久结果工件分页。 |
| `read_working_memory` | — | M30 | 长任务与工作记忆不在 M29 重新实现。 |
| `remove_chapter_from_storyline` | `chapter.update` | 字段对应 | 使用 add_storylines / remove_storylines / primary_storyline；保留 F3 的主、副故事线规则。 |
| `rename_chapter` | `chapter.update` | 对应注册命令 | — |
| `rename_inspiration` | `idea.update` | 对应注册命令 | — |
| `replace_chapter_body` | — | 待 F3 接口 | 没有完整正文结构替换命令；未改投影保持文档字节不变，不能借整篇重建丢失标记。 |
| `replace_element_body` | — | 待 F3 接口 | 没有完整正文结构替换命令；未改投影保持文档字节不变，不能借整篇重建丢失标记。 |
| `replace_element_category_body` | — | 待 F3 接口 | 没有完整正文结构替换命令；未改投影保持文档字节不变，不能借整篇重建丢失标记。 |
| `replace_inspiration_body` | — | 待 F3 接口 | 没有完整正文结构替换命令；未改投影保持文档字节不变，不能借整篇重建丢失标记。 |
| `replace_material_note_body` | — | 待 F3 接口 | 没有完整正文结构替换命令；未改投影保持文档字节不变，不能借整篇重建丢失标记。 |
| `replace_storyline_body` | — | 待 F3 接口 | 没有完整正文结构替换命令；未改投影保持文档字节不变，不能借整篇重建丢失标记。 |
| `replace_storyline_chapters` | — | 待 F3 接口 | 没有一次替换完整成员集合的注册命令；多次 chapter.update 不是同一事务。 |
| `revise_chapter` | `prose.read` / `prose.replace` | 当前仅单段 | 可对可编辑投影中的一个已有段落改字；结构、标题级别、嵌入对象的变更待 F3。 |
| `revise_element` | `prose.read` / `prose.replace` | 当前仅单段 | 可对可编辑投影中的一个已有段落改字；结构、标题级别、嵌入对象的变更待 F3。 |
| `revise_inspiration` | `prose.read` / `prose.replace` | 当前仅单段 | 可对可编辑投影中的一个已有段落改字；结构、标题级别、嵌入对象的变更待 F3。 |
| `revise_material_note` | `prose.read` / `prose.replace` | 当前仅单段 | 可对可编辑投影中的一个已有段落改字；结构、标题级别、嵌入对象的变更待 F3。 |
| `revise_storyline` | `prose.read` / `prose.replace` | 当前仅单段 | 可对可编辑投影中的一个已有段落改字；结构、标题级别、嵌入对象的变更待 F3。 |
| `search_project` | `book.search` | 查询范围变化 | 同一查询包含标题、摘要、正文、素材说明与补丁；返回分类后可选正文结果。 |
| `search_prose` | `book.search` | 查询范围变化 | 同一查询包含标题、摘要、正文、素材说明与补丁；返回分类后可选正文结果。 |
| `set_chapter_primary_storyline` | `chapter.update` | 字段对应 | 使用 add_storylines / remove_storylines / primary_storyline；保留 F3 的主、副故事线规则。 |
| `set_chapter_summary` | `chapter.update` | 对应注册命令 | — |
| `set_inspiration_summary` | `idea.update` | 对应注册命令 | — |
| `set_timeline_position` | `chapter.place` / `idea.update` | 按对象分派 | 章节与构想沿用 F3 各自的定位语义。 |
| `update_act` | `act.update` | 对应注册命令 | — |
| `update_comment` | `comment.update` | 对应注册命令 | — |
| `update_element` | `element.update` | 对应注册命令 | — |
| `update_element_category` | `category.update` | 对应注册命令 | — |
| `update_element_patch` | `patch.update` | 对应注册命令 | — |
| `update_material` | `material.update` | 对应注册命令 | — |
| `update_material_folder` | `material_folder.update` | 对应注册命令 | — |
| `update_project_facts` | `fact.put` / `fact.remove` | 模型语义变化 | 按事实条目写入；不是把旧文件整段覆盖。 |
| `update_project_memory` | `memory.update` | 对应注册命令 | — |
| `update_relation` | — | 待 F3 接口 | 没有 relation.update；不把 delete+create 伪装成一次原子更新。 |
| `update_relation_type` | `relation_type.update` | 对应注册命令 | — |
| `update_storyline` | `storyline.update` | 对应注册命令 | — |
| `update_task_constraint` | — | M30 | 长任务与工作记忆不在 M29 重新实现。 |
| `update_task_plan` | — | M30 | 长任务与工作记忆不在 M29 重新实现。 |
| `update_task_step` | — | M30 | 长任务与工作记忆不在 M29 重新实现。 |
| `update_timeline_marker` | `time_pin.update` | 对应注册命令 | — |
| `view_material` | `asset.get` / `material.list` | 待内容读取接口 | 现有工具只有素材与资产元信息，不会把元信息称作已看过图片或 PDF。 |
| `write_plot_grid` | `plot_grid.cell` / `plot_grid.line_add` / `plot_grid.line_update` / `plot_grid.line_remove` / `plot_grid.clear` | 拆分命令 | 新版按单元格和行列编辑；旧版整表替换没有原子等价入口。 |

新版额外可发现的能力同样来自注册表：来源变更查询与撤回、回收站恢复、模板、时间线精确定位与重排等。不把它们补写回旧版清单。全书库生命周期、无当前书籍边界的查询、编辑器/派生状态维护不向当前书籍 Agent 暴露；这不是权限档或危险操作开关。`history.restore_point` 目前也不暴露：它先写历史标签，再检查正文修订，必须等 F3 增加原子受控的标签与恢复接口；`history.undo_agent` 和 `prose.restore` 仍可用。

模型目录按 M29 的惰性发现约定分页查询；没有沿用旧版把全部工具摘要塞进固定描述前缀的做法。完整目录仍可通过公共 `Catalog::directory` 给 MCP 或外壳查看。返回 Schema 描述完整的 `Outcome` 包装（`output`、`effects`、可选 `undo` 和 `journal`），正文读取还含可编辑投影。

真正缺少的结构编辑、原子关系更新、完整成员替换等应交 F3 登记接口；M29 不绕过注册表私写 Loro，也不声称多次已经提交的命令可整体回滚。每份文档的实际写入与来源结算仍遵循 F2/F3 的事务边界。

来源撤回是专门操作：先读指定 session/turn 的结算清单，对清单中文档的当前版本做 CAS，再由 F3 只撤回自该来源写入后未被改动的字段或正文。它只授予该来源撤回范围，不表示已读过正文或实体内容，也不能授权普通替换。

实体永久清除（`*.purge`）、`comment.delete`、`material.delete`、`patch.delete`、`relation_type.delete` 的隐藏关联级联暂不暴露，等待 F3 的完整受影响关联查询。普通移入回收站及已读取的单条关联删除仍可用。分类/章节模板的字段和正文观察分别记录；正文替换目前要求模板文档已经存在。

F3 第十轮新增的 `idea.to_chapter` 和 `idea.to_element` 也明确排除，不补写成旧版映射中的已完成能力。转章节会解绑幕与时间钉，需要完整的实际受影响集合；转要素需要完整源正文及取副本时的版本检查，另有自动补链产生的跨正文影响。将源正文只加入写入 guard 不能保护先前读到的副本；关闭自动补链也不能替代覆盖和结算。等 F3 提供相应受控接口后，再以并发修改、部分读取、部分提交和来源撤回的真实回归开放。

第 27 批 M19 边界预审新增 `note_tasks.project` 的显式内部维护排除，与 `todo.project` 相同；它不是作者工具，也不会被 `prose.shape` 或完整正文读取授权。核对 `3c44e1bf` 时其源命令尚未注册，所以当前计数和生成快照未变，测试用局部同名注册验证后续合入也不能自动开放。M19 的真实 TODO／关联不变测试，以及 Agent 经 `material.update`、`history.restore_entities`、`history.undo_agent` 恢复 `task_todos` 不触发无归属 User 投射的编辑器测试，须随源功能合入验证；作者菜单和作者撤销的合法投射保留。
