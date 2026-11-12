//! The active contracts of the canonical model, and the tests that hold
//! each one.
//!
//! Authored data lives in Loro documents that merge on their own, so a rule
//! cannot be "rejected at write time" across devices: two devices can each
//! make a valid change whose merge breaks it. Every rule therefore names how
//! it holds:
//!
//! - [`Mechanism::Command`]: the command layer (F3) refuses the write locally;
//! - [`Mechanism::Read`]: readers tolerate the broken state (a relation whose
//!   end is gone is not shown);
//! - [`Mechanism::Repair`]: a deterministic background repair writes the fix
//!   (the same fix on every device, so repairs converge);
//! - [`Mechanism::Structure`]: the data structure makes the broken state
//!   impossible (Loro's tree has no cycles; a field list has its own slot).
//!
//! [`INVARIANTS`] is the list; [`DIVERGENCES`] records the operations the
//! 0.1 interface and the 0.1 Agent tools did differently, each with the
//! single meaning the canonical command implements. Both are checked: this
//! crate's tests assert the list's shape (every rule tested or listed in
//! [`NOT_YET_TESTED`]), and `dr-doc`'s `every_named_test_exists` fails when
//! a test named here is no longer in a crate of the workspace. Deleting a
//! test that holds a contract therefore needs the contract changed here too.
//!
//! Only contracts in force are listed. The fixed-domain rules retired at the
//! canonical v3 cutover are named in `docs/rust-rewrite/v3-cutover.md`. The
//! audit of the 0.1 client this list started from (where the old client
//! enforced each rule, and the old rules deliberately not carried over) was
//! removed with the cutover clean-up of 2026-11-12 and is in the history of
//! this file.

use serde::Serialize;

/// How an invariant holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mechanism {
    /// The command layer prevents it (F3; `dr-model` has the predicate).
    Command,
    /// Readers tolerate a merge that breaks it.
    Read,
    /// A deterministic background repair restores it.
    Repair,
    /// The structure makes it impossible.
    Structure,
}

/// One invariant.
#[derive(Clone, Debug, Serialize)]
pub struct Invariant {
    /// Stable short id, e.g. `REL-ENDPOINTS`.
    pub id: &'static str,
    /// The rule, in plain Chinese.
    pub rule: &'static str,
    pub holds_by: &'static [Mechanism],
    /// How exactly, and where in the code.
    pub how: &'static str,
    /// Tests that exercise the mechanism, in any crate of the workspace
    /// (the list's own rules live in `dr-model` / `dr-doc`, commands in
    /// `dr-workspace`, storage in `dr-store`, pages in the `dr-view-*` crates).
    pub tests: &'static [&'static str],
}

/// Where the 0.1 interface and the 0.1 Agent tools did the same operation
/// differently. The canonical model runs both through one command (F3); each
/// entry records the meaning chosen, its status and the command's tests.
#[derive(Clone, Debug, Serialize)]
pub struct Divergence {
    pub id: &'static str,
    /// The operation, in plain Chinese.
    pub topic: &'static str,
    /// What the old interface did.
    pub ui: &'static str,
    /// What the old Agent tools did.
    pub agent: &'static str,
    /// Where the 0.1 client did it (`path:lines` under the repository root,
    /// as of the audit of 2026-11-07).
    pub legacy: &'static [&'static str],
    /// The proposed single meaning for interface and Agent alike.
    pub proposal: &'static str,
    /// Where it stands now.
    pub status: &'static str,
    /// Tests of the unified command (in `dr-workspace`).
    pub tests: &'static [&'static str],
}

use Mechanism::*;

macro_rules! inv {
    ($id:literal, $rule:literal, [$($m:ident),*], $how:literal, [$($t:literal),*]) => {
        Invariant { id: $id, rule: $rule, holds_by: &[$($m),*], how: $how, tests: &[$($t),*] }
    };
}

pub const INVARIANTS: &[Invariant] = &[
    inv!(
        "ID-FORMAT",
        "实体 id 是非空、无控制字符的字符串；新 id 是 uuidv7；平局时按 UTF-8 字节比较",
        [Structure],
        "dr_model::id 的 id 类型只能经 parse 构造；Ord 即字节序",
        [
            "ids_reject_garbage",
            "ids_order_bytewise_like_the_old_client",
            "new_ids_are_uuid_v7_and_increase"
        ]
    ),
    inv!(
        "UNKNOWN-KEPT",
        "不认识的字段、取值、标记原样保留，不丢、不改写",
        [Structure, Read],
        "枚举都是开放的（Other 原样读写）；书目写入逐字段，不重写整个实体；未配置的标记键按 None 扩展；对话条目是不可变的 JSON 字符串，读不懂的整条保留、跳过（CONVERSATION-READ）",
        [
            "unknown_values_survive",
            "unknown_fields_survive_an_edit",
            "conversation_unknown_content_is_preserved_and_invalid_ids_rejected"
        ]
    ),
    inv!(
        "DOC-IDENTITY",
        "一份字节只能当作它自己那篇文档载入",
        [Command],
        "Core::load 先逐份校验 Loro 校验和（坏字节报错，不让解码器照坏长度申请内存），导入后比对 meta.doc / meta.book，再导入创世",
        [
            "loading_bytes_of_another_document_fails",
            "loading_another_books_bytes_fails",
            "corrupted_bytes_are_an_error_not_a_crash"
        ]
    ),
    inv!(
        "PEER-RESERVED",
        "设备对等方不与创世对等方、Loro 保留值冲突",
        [Structure, Command],
        "创世对等方最高位置 1；设备和导入对等方最高位为 0；load/set_peer 拒绝保留值",
        [
            "peer_kinds_do_not_overlap",
            "loading_bytes_of_another_document_fails"
        ]
    ),
    inv!(
        "ONE-ORIGIN-PER-COMMIT",
        "一次提交只有一个来源；作者撤销只撤作者自己的输入",
        [Structure],
        "每篇文档一个写入者（edit 要 &mut）；transact 先设好下次提交的来源，隐式提交也带同一来源；撤销排除 user 以外的来源前缀，作者的命令 user:command 也排除（由工作区的日志撤）",
        [
            "author_undo_never_removes_agent_or_sync_text",
            "the_editors_undo_leaves_the_authors_commands_out",
            "resolving_a_deleted_anchor_inside_an_agent_write_keeps_its_origin",
            "a_failed_edit_still_commits_what_it_applied",
            "only_user_writes_are_author_undoable",
            "every_commit_is_durable_when_the_command_returns",
            "the_editor_layer_undoes_only_the_authors_typing"
        ]
    ),
    inv!(
        "AGENT-MESSAGE",
        "Agent、导入的历史来源可识别；存量 mirror 来源编码仍可读取",
        [Structure],
        "这三种提交带提交信息 agent:<会话>/<轮>、mirror、import（Origin::commit_message），存进 Loro 历史、随快照和同步走、压缩删不掉；作者自己的提交不带",
        [
            "agent_commits_carry_a_durable_message",
            "import_and_mirror_commits_carry_their_origin_as_message",
            "origins_round_trip"
        ]
    ),
    inv!(
        "COMMIT-PERSISTED",
        "每一次本机写入都交给存储，存储里的字节能还原出同一篇文档",
        [Structure],
        "edit / undo / repair 都返回 Committed（恰好这次提交的更新字节）",
        [
            "commits_replay_into_the_same_document",
            "undo_of_a_merge_restores_both_ids"
        ]
    ),
    inv!(
        "SEED-REQUIRED",
        "创建条目、模块、关系和共享记录时，先校验所需字段和目标",
        [Command, Read],
        "canonical F3 先验证模板、住处、模块和端点，失败前不写；原始数据中的未知字段继续保留",
        [
            "v3_structure_validation_happens_before_writes",
            "random_commands_keep_the_invariants"
        ]
    ),
    inv!(
        "IMMUTABLE-AFTER-CREATE",
        "模块补丁归属不串到另一条目，写作日的设备和日期创建后不变",
        [Command, Structure],
        "补丁命令显式验证 entry＋module 的所属；写作日：设备和日期就是键",
        ["writing_day_keys"]
    ),
    inv!(
        "JSON-FIELDS",
        "不透明 JSON 原值整体保存；模板正文使用独立的书内模块文档",
        [Command, Read],
        "不透明 provenance／批注 metadata 保留为整值；结构化模板与模块逐字段更新，正文在书内 template 文档，不再读取旧 App fallback",
        [
            "json_fields_are_kept_whole",
            "v3_template_prose_is_book_scoped_and_copied_once"
        ]
    ),
    inv!(
        "NAME-NONEMPTY",
        "名字和标题去掉首尾空白后不能为空",
        [Command, Read],
        "dr_model::check::non_empty_name；读取时空名由界面显示占位",
        [
            "shared_payload_and_size_checks",
            "books_create_list_update_trash",
            "unknown_commands_and_bad_input"
        ]
    ),
    inv!(
        "BOOK-TRASH",
        "书进废纸篓记在 meta.deleted_at，30 天后彻底删除",
        [Command],
        "F3 的删除命令写 deleted_at；到期清理由存储（F2）做：删掉这本书的全部文档",
        ["books_create_list_update_trash"]
    ),
    inv!(
        "BOOK-PURGE",
        "彻底删书时，属于它的一切都删掉",
        [Structure, Command],
        "一本书就是它的书目文档加正文文档（模板文档也在里面）；F3 的 book.purge 只删「最近删除」里的书：关掉它打开的文档，按存储（F2）登记的这本书的文档逐篇删、书目文档最后删，再删它的资源和日志行，不能撤销；存储记下删过的文档，同步再送来的副本不收，不需要外键级联",
        [
            "purging_a_book_deletes_it_for_good",
            "a_purged_book_does_not_come_back_with_sync"
        ]
    ),
    inv!(
        "TRASH-AND-PURGE",
        "进废纸篓是写 deleted_at，恢复是清掉；彻底删除是删键，id 永不重用",
        [Structure],
        "书目写入：deleted_at 字段 / purge 删键；读取时废纸篓里的不进章节、关系等列表",
        [
            "chapters_sort_by_order_then_id_and_ideas_ignore_book_order",
            "relations_are_shown_only_when_whole"
        ]
    ),
    inv!(
        "NODE-HAS-PROSE",
        "每个实际正文模块和文本素材的空正文都有确定创世，不回到旧节点类型",
        [Structure],
        "确定性的创世：还没有字节的正文文档就是创世那一份空段落，所有设备一样",
        ["genesis_is_deterministic_and_concurrent_init_merges"]
    ),
    inv!(
        "REL-KINDS",
        "关系从结构实体、批注或素材出发，指向结构实体",
        [Command, Read],
        "dr_model::check::relation_ends；读取时不合规的不显示",
        [
            "relations_are_shown_only_when_whole",
            "todo_links_through_the_builtin_type",
            "entity_kind_roles_match_the_old_vocabulary",
            "canonical_relations_validate_dedupe_filter_and_restore_without_losing_raw_values"
        ]
    ),
    inv!(
        "REL-NO-SELF",
        "关系不能连自己",
        [Command, Read],
        "check::relation_ends；读取时不显示",
        [
            "relations_are_shown_only_when_whole",
            "canonical_relations_validate_dedupe_filter_and_restore_without_losing_raw_values",
            "canonical_relations_validate_dedupe_filter_and_restore_without_losing_raw_values"
        ]
    ),
    inv!(
        "REL-ENDS-EXIST",
        "关系两端存在、不在废纸篓",
        [Command, Read],
        "读取时一端不在或在废纸篓就不显示；端点恢复后关系回来（旧版删章时把关系一起永久删掉）",
        [
            "relations_are_shown_only_when_whole",
            "three_peers_read_the_same_book",
            "canonical_relations_validate_dedupe_filter_and_restore_without_losing_raw_values",
            "canonical_relations_validate_dedupe_filter_and_restore_without_losing_raw_values"
        ]
    ),
    inv!(
        "REL-TYPE-EXISTS",
        "关系类型存在",
        [Command, Read],
        "读取时类型不在就不显示",
        [
            "relations_are_shown_only_when_whole",
            "canonical_relations_validate_dedupe_filter_and_restore_without_losing_raw_values"
        ]
    ),
    inv!(
        "REL-KINDS-BY-TYPE",
        "两端的种类是关系类型允许的",
        [Command, Read],
        "check::relation_ends；读取时不合就不显示",
        [
            "relations_are_shown_only_when_whole",
            "todo_links_through_the_builtin_type",
            "canonical_relations_validate_dedupe_filter_and_restore_without_losing_raw_values"
        ]
    ),
    inv!(
        "REL-SYMMETRIC-CANONICAL",
        "对称关系两端按规范顺序存",
        [Command, Read],
        "dr_model::shared::canonical_symmetric；读取和去重时两种顺序当作同一条",
        [
            "symmetric_endpoints_are_canonical",
            "relations_are_shown_only_when_whole",
            "canonical_relations_validate_dedupe_filter_and_restore_without_losing_raw_values"
        ]
    ),
    inv!(
        "REL-SEMANTIC-UNIQUE",
        "同一对端点、同一类型只留一条",
        [Read, Repair],
        "读取时按 id 取最小的那条；后台修复删掉其余的",
        [
            "relations_are_shown_only_when_whole",
            "three_peers_read_the_same_book"
        ]
    ),
    inv!(
        "RT-ENUMS",
        "关系类型的方向是 directed/symmetric，system_key 只有 generic-association，锁定的才有 system_key",
        [Read, Structure],
        "开放枚举；system_key 和 locked 只由创世写",
        ["book_genesis_sets_version_4_and_locked_generic_relation_type"]
    ),
    inv!(
        "RT-DEFINITION",
        "关系类型的名字、方向、已知端点种类与模板限制合法；空限制列表沿用 canonical 的无限制语义",
        [Command],
        "entry_relation_type.put 预检名字冲突、方向、端点种类和模板存在；relation.create／module.put_relation 再校验具体两端",
        [
            "canonical_relations_validate_dedupe_filter_and_restore_without_losing_raw_values",
            "v3_restore_primary_pins_and_record_deletion_have_real_inverses"
        ]
    ),
    inv!(
        "RT-NAME",
        "规范名 = 去首尾空白 + ASCII 小写，每本书里不重复",
        [Structure, Command, Read],
        "RelationTypeWriter::name 同时写规范名；重名由 F3 预防，合并后重名两个都显示",
        [
            "relation_type_names_normalize",
            "the_builtin_relation_type_is_locked",
            "v3_restore_primary_pins_and_record_deletion_have_real_inverses"
        ]
    ),
    inv!(
        "RT-BUILTIN-ONCE",
        "每本书有且只有一个内置关系类型，id 是 system:generic-association:<书 id>",
        [Structure],
        "书目文档的创世写它；所有设备的创世字节相同，Loro 去重",
        ["book_genesis_sets_version_4_and_locked_generic_relation_type"]
    ),
    inv!(
        "RT-LOCKED",
        "内置关系类型不能改、不能删",
        [Command],
        "canonical entry_relation_type.put／delete 拒绝内置锁定类型",
        [
            "the_builtin_relation_type_is_locked",
            "v3_restore_primary_pins_and_record_deletion_have_real_inverses"
        ]
    ),
    inv!(
        "CMT-TARGET",
        "批注的目标要么全空（浮动），要么种类和 id 都有，且是可批注的种类",
        [Command, Read],
        "check::comment_target；读取时目标不在或在废纸篓就标 target_missing，显示为「未定位」，不丢",
        [
            "comments_keep_unlocated_targets_and_anchor_into_prose",
            "v3_comments_address_modules_validate_anchors_and_restore_after_reopen",
            "comments_with_anchors_and_metadata"
        ]
    ),
    inv!(
        "CMT-ENUMS",
        "批注的种类、状态、作者种类、来源、优先级取值固定",
        [Read],
        "开放枚举；旧值（如 copilot）照读",
        [
            "unknown_values_survive",
            "comments_keep_unlocated_targets_and_anchor_into_prose"
        ]
    ),
    inv!(
        "MEMORY-ENUMS",
        "Project Memory 的种类、来源、状态取值固定",
        [Read],
        "开放枚举",
        ["unknown_values_survive"]
    ),
    inv!(
        "MAT-KIND",
        "素材是 image / pdf / text；url 已退役",
        [Command, Read],
        "check::material_payload 拒绝其他种类；旧的 url 读成 Other，界面当作不支持",
        [
            "shared_payload_and_size_checks",
            "unknown_values_survive",
            "materials_folders_and_assets"
        ]
    ),
    inv!(
        "MAT-PAYLOAD",
        "图片和 PDF 素材有同种类的资源，文本素材没有；一个资源只属于一个主人",
        [Command, Read],
        "check::material_payload；读取时资源不在或种类不符就读成无（显示为缺失）",
        ["materials_folders_and_assets"]
    ),
    inv!(
        "MAT-PROSE",
        "只有文本素材有正文文档",
        [Read],
        "BookView::owns_prose",
        ["materials_folders_and_assets"]
    ),
    inv!(
        "MAT-FOLDER",
        "素材所在的素材夹存在",
        [Read],
        "读取时不在就放到根目录（旧版也允许 folder 比素材夹活得久）",
        ["materials_folders_and_assets"]
    ),
    inv!(
        "AST-IMMUTABLE",
        "资源的元数据写一次就不变",
        [Command],
        "BookTxn::put_asset：同一 id 不同值拒绝；没有改资源的写入接口",
        ["materials_folders_and_assets"]
    ),
    inv!(
        "AST-SHAPE",
        "资源：大小为正，sha256 是 64 位小写十六进制，图片有尺寸，PDF 没有",
        [Command],
        "dr_model::check::asset_shape",
        [
            "shared_payload_and_size_checks",
            "sha256_shape",
            "materials_folders_and_assets"
        ]
    ),
    inv!(
        "ASSET-BYTES",
        "资源字节到了才能显示",
        [Read],
        "元数据（书目文档的 assets）和字节（存储的本机资源目录，F2）分开；素材页读不到字节时在画面上说一句没有这个文件（M19 的 Trouble::Missing），不报错、不崩。字节同步到达后自动重新显示要等 F2 的资源同步，现在是打开页面时读一次",
        ["a_material_without_its_file_says_so"]
    ),
    inv!(
        "TREE-NO-CYCLE",
        "素材夹不成环，也不能是自己的父级；条目树另见 V3-TREE-NO-CYCLE",
        [Structure],
        "LoroTree 本地拒绝成环的移动，合并时也不会产生环",
        [
            "concurrent_moves_never_make_a_cycle_and_missing_groups_read_as_root",
            "three_peers_read_the_same_book"
        ]
    ),
    inv!(
        "TREE-DELETE-MOVES-UP",
        "删除素材夹时保留素材并按既有素材夹协议恢复住处",
        [Command, Read],
        "BookTxn::delete_drift_group / delete_material_folder 先挪子级再删（Loro 删节点会连子树一起删）；并发加进去的读取时放到根目录",
        [
            "deleting_a_group_moves_children_and_ideas_up",
            "materials_folders_and_assets",
            "v3_material_folders_restore_order_ancestry_and_only_selected_records"
        ]
    ),
    inv!(
        "KV-LIST",
        "字段列表各有归属（项目设定、故事线模板、故事线字段、分类模板字段、要素字段），按位置键排、平局按 id；键和值都空的条目不要",
        [Structure, Read],
        "每种列表是自己实体上的一个 mergeable 映射，条目 id 为键；读取时跳过全空条目",
        ["key_value_lists_merge_by_entry_and_skip_empties"]
    ),
    inv!(
        "PLOT-GRID",
        "每个情节规划模块独立持有行列和格子；尺寸有界，格子引用存在的行列",
        [Structure, Command, Read],
        "按条目和模块存一张（键 <条目>/<模块>）；新表的三行三列是种子变更、id 确定（PlotRowId / PlotColId::default_for_entry），两台设备同时新建也只有 3 × 3，晚到的默认值盖不掉作者的改动；check::plot_cell_size；读取时尺寸夹到范围内，行或列不在的格子不显示",
        [
            "plot_grids_skip_orphan_cells_and_clamp_sizes",
            "a_grid_created_on_two_devices_is_three_by_three_and_keeps_its_labels",
            "seeds_merge_into_one_and_never_beat_a_real_edit",
            "shared_payload_and_size_checks"
        ]
    ),
    inv!(
        "WRITING-DAY",
        "写作日是（设备，日期）一条，日期 YYYY-MM-DD，字数不为负；一天的字数是各设备之和",
        [Structure, Command, Read],
        "键就是 设备|日期，存在这本书的 stats:<书>（kernel-v4.md §8；0.1 源格式的书目文档里另有一份，只在导入时读）；写入时负数记成 0；读取时坏键、负数跳过",
        [
            "writing_day_keys",
            "days_validate",
            "writing_days_sum_over_devices",
            "two_devices_create_one_stats_document_and_keep_each_others_days"
        ]
    ),
    inv!(
        "BODY-ENDS-WITH-NEWLINE",
        "正文永远以创世写的那个换行结尾",
        [Structure],
        "插入只在最后一个字符之前；删除不删最后一个字符；回车在光标处插换行；撤销删不到创世字符",
        [
            "the_final_newline_cannot_be_removed",
            "three_peers_converge"
        ]
    ),
    inv!(
        "BLOCK-ID-UNIQUE",
        "每段有块 ID，全文唯一，跟着文字走",
        [Structure, Read, Repair],
        "新块 ID 用自己那个换行的操作 ID；读取时重复的第一个保留；导入后确定性修复",
        [
            "enter_keeps_block_ids_with_the_text",
            "concurrent_enter_at_one_end_converges_with_unique_ids",
            "readers_hide_later_duplicates_until_repair",
            "repair_is_deterministic",
            "three_peers_converge"
        ]
    ),
    inv!(
        "BLOCK-ATTRS-ON-NEWLINE",
        "段落属性只在段尾换行上，行内标记不在换行上",
        [Structure, Read],
        "新写的换行把段落属性写全、行内标记清掉；读取时只认换行上的段落属性，忽略换行上的行内标记",
        [
            "block_attrs_round_trip_and_stay_on_the_newline",
            "inline_styles_skip_newlines_and_respect_the_profile",
            "entity_links_overlap_and_do_not_expand"
        ]
    ),
    inv!(
        "BLOCK-ATTR-RANGES",
        "标题只有 H1/H2/H3，缩进 0–8",
        [Structure, Read],
        "类型化的 Heading 与 BlockAttrs；读取时越界的标题读成正文段落、缩进夹到 0–8",
        [
            "heading_levels",
            "block_attrs_round_trip_and_stay_on_the_newline"
        ]
    ),
    inv!(
        "PROFILE",
        "列表、任务、代码块、提示框、高亮、行内代码只在素材笔记里",
        [Command, Read],
        "ProseTxn 拒绝（DocError::NotInProfile）；读取时正文配置里的这些属性忽略",
        [
            "inline_styles_skip_newlines_and_respect_the_profile",
            "inheritance_follows_the_schema"
        ]
    ),
    inv!(
        "ENTITY-LINK",
        "人物链接在前后打字不扩展、中间打字算进去；不同目标可重叠；不跨段",
        [Structure, Read],
        "每个目标一个键 entity:<id>，ExpandType None；按段切开打；读取时换行处断开",
        ["entity_links_overlap_and_do_not_expand"]
    ),
    inv!(
        "EMBED-ENTRY",
        "嵌入占位指向 embeds 里的条目；没有占位指向的条目留着，后台清理",
        [Read, Repair],
        "embed_refs / embed / orphan_embeds；ProseTxn::drop_orphan_embeds",
        ["embeds_are_placeholders_with_side_entries"]
    ),
    inv!(
        "ANCHOR",
        "锚点不丢：各设备解析到同一范围；锚住的字全删后收成一个点，批注还在",
        [Structure, Read],
        "一对 Loro 光标；替换光标存 AnchorCache，不回写书目文档；解析前确认两个光标都指向这篇正文，坏锚点读成「未定位」",
        [
            "anchors_exclude_edge_typing_and_collapse_on_delete",
            "anchors_survive_merge_and_encoding",
            "anchor_cache_keeps_the_replacement_locally",
            "anchors_into_another_container_read_as_unlocated",
            "untouched_anchor_keeps_its_text",
            "three_peers_converge"
        ]
    ),
    inv!(
        "PROSE-OWNER",
        "正文文档要有书目里的实体",
        [Read, Repair],
        "BookViewV3::owns_prose；没有主人的正文文档读取时忽略，由 F2 清理（彻底删除和另一台设备的编辑并发时会出现）",
        ["materials_folders_and_assets"]
    ),
    inv!(
        "ORDER-POS",
        "纯列表（故事线、补丁、素材、键值列表、情节规划的行列、表格的行列）的顺序是分数索引位置键，不是数字；平局按 id",
        [Structure, Read],
        "dr_model::pos（照搬 Rocicorp fractional-indexing 4.0.0，旧键逐字节保留）；挪一项只改这一项的键，两台设备各自重排再合并也不会互相打乱；构想分组、素材夹的兄弟顺序由 LoroTree 自己的分数索引管；读取时缺键或坏键排到最后",
        [
            "matches_the_js_library",
            "many_keys_are_ordered_and_between",
            "concurrent_reordering_keeps_both_intents"
        ]
    ),
    inv!(
        "TODO-SINGLE-TRUTH",
        "待办只有一份真相：链了待办的任务行没有自己的勾选状态，显示待办的状态",
        [Structure, Read],
        "BlockAttrs 里 todo 有值时 checked 不写、读时忽略；界面读 BookView::todo_done",
        [
            "a_task_line_linked_to_a_todo_has_no_state_of_its_own",
            "projected_todos_are_one_entity_on_every_device"
        ]
    ),
    inv!(
        "PROJECTED-TODO-ID",
        "从正文生成的待办（TODO: 标记、素材笔记的任务行）在每台设备上是同一个实体",
        [Structure],
        "id 由（种类、文档 id、块 ID）算出：CommentId::for_projection；来源种类和块是正式字段 projection / projection_block；两台设备各自生成也只有一个，不需要去重。投出的内容（种类、目标、状态、任务文字 projection_text）是种子变更（BookTxn::project_todo）：两边投同一个标记只有一份正文，晚到的投影不会把已解决的重新打开",
        [
            "projected_todos_are_one_entity_on_every_device",
            "derived_ids",
            "a_marker_projected_on_two_devices_is_one_todo_with_one_body",
            "a_late_projection_never_reopens_a_resolved_todo",
            "a_todo_projected_again_after_its_marker_came_back_starts_fresh",
            "seeds_merge_into_one_and_never_beat_a_real_edit"
        ]
    ),
    inv!(
        "NO-HOT-FIELDS",
        "书目文档里不放随打字高频变化的字段",
        [Structure],
        "节点没有 updated_at（旧版每次正文投影都刷新它）；「最近编辑」从本机索引（F2）取；写作日和快照点清单不在书目文档里，在 stats:<书>、checkpoints:<书>",
        [
            "writing_days_sum_over_devices",
            "writing_days_and_checkpoints_leave_the_book_document_alone"
        ]
    ),
    inv!(
        "ENTITY-RESTORE",
        "从快照历史恢复一个对象时，连同它当时的标题、梗概、字段等元数据一起恢复，书里别的东西不动",
        [Command],
        "完整条目快照包含原始条目、关联记录与全部正文；restore 先预检版本、身份和无损可表示性，再用 SQLite 多文档原子提交；失败与并发均不覆盖新输入",
        [
            "restoring_an_entity_writes_its_old_fields_back",
            "complete_restore_and_pre_restore_checkpoint_survive_reopen_and_preserve_other_entries",
            "stale_book_or_body_refuses_every_write_and_preserves_new_input"
        ]
    ),
    inv!(
        "STYLE-TABLE-ONE-SOURCE",
        "所有配置 Drifting 文档的地方用同一张样式表（每个标记键的扩展规则）",
        [Structure, Command],
        "唯一来源是 dr_doc::schema::STYLE_TABLE 加 DEFAULT_EXPAND，dr_doc::schema::configure 照它配置；Loro 在打标记时把规则写进标记本身、之后各设备都照它走，所以一张错表写出来的是错数据。别处（gpui-prose）要么调 configure，要么用一模一样的表，dr-editor 用 style_table_mismatches 对拍",
        [
            "the_style_table_covers_every_mark_key_once",
            "mismatches_name_every_difference",
            "a_mark_made_under_another_table_keeps_its_rule"
        ]
    ),
    inv!(
        "CROSS-DOC-ORDER",
        "一个命令同时写正文文档和书目文档时，先写正文、再写书目",
        [Command],
        "F3 的事务顺序；中途失败只留下没有书目实体的正文文档，由 PROSE-OWNER 兜住",
        [
            "v3_invalid_initial_body_leaves_no_documents_and_fault_keeps_no_dangling_entry",
            "a_failure_after_the_prose_leaves_only_an_orphan",
            "prose_written_before_the_book_survives_a_reopen"
        ]
    ),
    inv!(
        "CONVERSATION-APPEND",
        "对话只从已落盘的运行事件追加；一个事件身份只对应一份内容，重放不重复写",
        [Structure, Command],
        "dr-doc 只公开追加（ConversationDoc::append / BorrowedConversation::append），没有删、改、挪的接口；追加前按事件身份查，已有且相同就什么都不写，不同就报错；事件身份、会话、种类守 id 的规则（check_id）。权限请求、运行状态这些本机控制不进对话（M27）",
        [
            "conversation_replay_is_idempotent_and_content_is_immutable",
            "conversation_unknown_content_is_preserved_and_invalid_ids_rejected",
            "honest_devices_converge_and_are_never_refused"
        ]
    ),
    inv!(
        "CONVERSATION-HISTORY",
        "已有的对话条目不删、不改、不挪，对话的身份不变",
        [Command],
        "导入前 conversation::validate_update 只看这份更新自己的操作：删条目（改和挪也是删加插）、创世以外的人改 meta.v / meta.doc、依赖本机还没有的变更，一律拒；同一份字节在每台设备上得到同一个答案，老实设备之间不会因为各自见过的不同而分叉。F3 的 library_options 把它装进 F2 的导入校验。被拒的更新会挡住同一设备之后的更新，所以同步要按因果顺序送，提前到的等依赖到了再送一次",
        [
            "conversation_import_rejects_deletion_and_reads_a_conflict_alike",
            "a_deletion_is_refused_whatever_the_receiver_has_seen",
            "conversation_import_rejects_reordered_existing_entries",
            "sync_conversation_uses_append_only_document_without_prose_events",
            "honest_devices_converge_and_are_never_refused"
        ]
    ),
    inv!(
        "CONVERSATION-READ",
        "每台设备读出同一份对话；读不懂的条目不挡打开和同步",
        [Read],
        "按列表顺序读，每个事件身份只读第一次出现的那条（内容不同时也读第一条，身份报在 problems().conflicting）；不是字符串、不是 JSON、信封是以后版本的条目跳过并原样保留（problems().unreadable）；读取和载入都不因内容失败；并发追加的先后由 Loro 列表收敛",
        [
            "conversation_concurrent_appends_converge",
            "a_conversation_with_entries_it_cannot_read_still_opens_and_syncs",
            "conversation_import_rejects_deletion_and_reads_a_conflict_alike",
            "honest_devices_converge_and_are_never_refused"
        ]
    ),
    inv!(
        "CONVERSATION-NOT-PROSE",
        "对话文档不是正文：不编辑、不计字数、不搜索、不导出、不投待办，也不会被当成没主人的正文清掉",
        [Structure, Read],
        "DocKind::Conversation 没有 ProseProfile、is_book_text 为假（ProseDoc / BorrowedProse 拒绝打开它）；owns_prose 认它属于书（哪本书由存储记着）；project_todo / projected_todo 只收书的正文",
        [
            "doc_ids_round_trip",
            "conversation_is_not_a_prose_document",
            "conversations_belong_to_the_book_and_project_no_todos",
            "prose_commands_and_editor_reject_conversations_without_writing"
        ]
    ),
    inv!(
        "V3-TREE-NO-CYCLE",
        "树不成环",
        [Structure, Command],
        "entries 是 LoroTree，自身保证移动与合并绝不成环；命令层用 dr_model::v3::check_entry_move 拒绝把条目移到自己或自己的后代下",
        ["v3_entry_tree_never_cycles"]
    ),
    inv!(
        "V3-LEAF-NO-CHILDREN",
        "开关关着的条目下面没有条目；合并后出现时，读取时把这些条目当作住在最近一个开着开关的祖先下面（没有就是根），数据不动，开关再打开就回来",
        [Command, Read],
        "命令层用 dr_model::v3::check_parent_is_level 只接受根或开着开关的活条目做新建、移动、恢复的住处，关开关的命令把直接子条目一次挪走；读取时 effective_parent_id 跳过开关关着的祖先，底层数据不动",
        ["entries_with_the_switch_off_hold_nothing_and_merge_lifts_to_the_nearest_level"]
    ),
    inv!(
        "V3-ENTRY-TEMPLATE-EXISTS",
        "条目的模板不在了：读取时当作没有模板的条目，只显示已有的数据，不丢",
        [Command, Read],
        "命令层用 dr_model::v3::check_entry_template 检查模板存在且未删除；读取时 Entry::effective_template 在模板缺失或已删时返回 None，visible_fields / visible_kv 照常展示已有数据",
        ["v3_entry_template_exists_or_degrades_to_blank"]
    ),
    inv!(
        "V3-TEMPLATE-SWITCH-KEEPS-DATA",
        "换模板不删数据、不动开关：新模板没有的模块数据原样留着，换回来就回来",
        [Structure, Command, Read],
        "Entry::switch_template 只改 template 字段，开关存在条目上不跟模板走，orphaned_fields 暴露不在当前模板里的原内容；命令层只用 check_entry_template 查新模板存在",
        ["switching_template_keeps_module_data_and_the_switch"]
    ),
    inv!(
        "V3-TEMPLATE-DELETE-UNUSED",
        "只能删没人用的模板；合并后仍有人用已删的模板，照模板缺失容错",
        [Command, Read],
        "命令层用 dr_model::v3::check_template_delete 拒绝删除仍有未删除条目在用的模板；合并冲突下 effective_template 将被删模板的条目当作无模板条目",
        ["v3_template_delete_refuses_when_in_use"]
    ),
    inv!(
        "V3-MEMBERSHIP-RULES",
        "归属到的层级活着、开关开着、解析后收别处的条目；读取时不满足就忽略这条归属，数据留着",
        [Command, Read],
        "归属只看要挂去的层级，不看成员的模板：check_membership 校验两端活着、宿主开关开着、解析后的 settings.accept 为真（泳道恒为真）；filter_valid_memberships 过滤不满足的归属（宿主关掉开关的也在内），Entry::effective_primary 只认仍在有效归属里的宿主",
        ["membership_is_governed_by_the_hosts_switch_and_accept"]
    ),
    inv!(
        "V3-TIMELINE-LANE-ENABLED",
        "视图里的泳道是开关开着、解析后 lane 为真的条目；lane 不往下继承",
        [Command, Read],
        "命令层用 dr_model::v3::check_timeline_lane 校验条目活着且 Entry::is_lane（开关开着，lane 取条目自己的覆盖、没有再取模板）；读取时 effective_timeline_lanes 忽略不满足的条目",
        ["v3_timeline_lanes_and_placements_require_lane_membership"]
    ),
    inv!(
        "V3-TIMELINE-PLACEMENT-IN-LANE",
        "视图里的条目在这个视图的某条泳道里：拿出最后一条泳道时一起去掉位置；读取时不在任何泳道里的位置不显示",
        [Command, Read],
        "命令层用 check_timeline_placement_in_lane 校验条目归属在该视图至少一条有效泳道里，移出泳道时用 prune_placement_if_not_in_view_lanes 清理位置；读取时 effective_timeline_placements 过滤不在该视图任何泳道里的位置",
        ["v3_timeline_lanes_and_placements_require_lane_membership"]
    ),
    inv!(
        "V3-AUTOLINK-NAME-UNIQUE",
        "自动链接的名字和别名唯一（范围：自动链接的条目，即模板 linkable、住处层级或任一归属层级开了自动链接的条目，不看它自己的开关）",
        [Command, Read],
        "命令层用 dr_model::v3::check_new_violations 比较改前改后的名字表（AutolinkNames，一遍扫出），只拒绝这次写入新造成的重名；并发合并产生重名时 resolve_autolink_name_conflicts 按创建时间与 id 保留最早的，其余标出 name_conflict，不挡无关的写入",
        [
            "autolink_names_are_unique_across_autolinked_entries_whatever_their_switch",
            "a_duplicate_name_a_merge_left_blocks_no_unrelated_write_and_a_rename_resolves_it"
        ]
    ),
    inv!(
        "V3-TIMELINE-TARGETS-LIVE",
        "视图里的泳道、时间钉挂的条目都要在；读取时不在就不显示",
        [Command, Read],
        "命令层用 dr_model::v3::check_timeline_target_live 拒绝指向已删条目；读取时 effective_timeline_lanes / effective_timeline_placements 过滤已删条目，effective_timeline_pins 清掉指向已删条目的绑定",
        ["v3_timeline_targets_filter_deleted_entries"]
    ),
    inv!(
        "V3-MANUSCRIPT-NO-NEST",
        "成书的层级（开着开关的条目）不嵌套：命令层预防；读取时只认最外层",
        [Command, Read],
        "命令层用 dr_model::v3::check_new_violations 比较改前改后的嵌套对（manuscript_nest_pairs），只拒绝这次写入新造成的嵌套；合并冲突下 effective_manuscript_levels 只认最外层，旧的嵌套不挡无关的写入",
        [
            "v3_manuscript_levels_never_nest_and_read_outermost",
            "a_nested_manuscript_a_merge_left_blocks_no_unrelated_write"
        ]
    ),
    inv!(
        "V3-CROSS-DOC-ORDER",
        "v3 跨文档写入的先后：先写正文文档（body: / template:），再写书目文档（book:）",
        [Command],
        "plan_entry_write_order 与 check_cross_doc_write_order 保证所有 body:<entry>/<module> 写入先于 book:<id>",
        ["v3_cross_document_writes_put_prose_before_book"]
    ),
    inv!(
        "V3-DOCID-LIBRARY-UNIQUE",
        "文档 id 在库里唯一：条目 id（含默认层级与默认分类）一律新生成 uuidv7，模板正文文档 id 带书 id（template:<书 id>/<模板 id>/<模块 id>），书旁边的两篇文档是 stats:<书 id>、checkpoints:<书 id>，彻底删除一本书不会删掉另一本书的文档",
        [Structure, Command],
        "NovelRootEntries::new 每次生成新的 uuidv7，TemplateId::for_entry_module 包含 book_id，DocId::Stats / DocId::Checkpoints 就是书 id，check_doc_ids_unique_across_books 检查跨书文档 id 零碰撞",
        [
            "v3_doc_ids_are_unique_across_books_in_library",
            "two_novel_books_in_one_library_have_disjoint_doc_ids_and_purging_one_keeps_the_other"
        ]
    ),
    inv!(
        "SIDE-DOC-NOT-PROSE",
        "书旁边的两篇文档（stats:<书> 写作日、checkpoints:<书> 快照点清单）不是正文也不是书目：不编辑、不计字数、不搜索、不导出成书稿、不投待办；属于 id 里的那本书，跟着它导出和彻底删除",
        [Structure, Read],
        "DocKind::Stats / Checkpoints 没有 ProseProfile、is_book_text 为假；创世确定（meta.v = 1、meta.doc），两台设备各建一篇合并后是同一篇；owns_prose 认它们属于 id 里的书；登记在书名下，按书列文档的导出和清除自动带上",
        [
            "stats_and_checkpoints_are_neither_prose_nor_the_book",
            "a_side_document_refuses_the_bytes_of_another",
            "two_novel_books_in_one_library_have_disjoint_doc_ids_and_purging_one_keeps_the_other"
        ]
    ),
    inv!(
        "SIDE-DOC-QUIET",
        "记写作日、存快照点、修剪快照点都不写书目文档：书目版本不变，不发书目事件",
        [Command],
        "writing_day.record 经 Cx::write_stats 只写 stats:<书>；entry_snapshot.* 在原子事务里只把清单写进 checkpoints:<书>，书目只读；工作区给两篇文档各发自己的事件（WsEvent::Stats / Checkpoints）",
        [
            "writing_days_and_checkpoints_leave_the_book_document_alone",
            "writing_days_dispatch_by_version_preserve_other_books_and_do_not_enter_undo"
        ]
    ),
    inv!(
        "BOOK-FORMAT-4-ONLY",
        "只开 meta.v == 4 的书；别的版本（v3 和更早）原样拒开，不改不删，也不经同步进来",
        [Command, Read],
        "is_book_doc 只认 BOOK_SCHEMA_VERSION；book_v3 / book_slot 拒绝别的版本；导入校验拒绝并完以后不是 4 的书目更新；书文件只读格式 4",
        [
            "a_book_of_format_3_is_refused_as_it_is_and_cannot_arrive_by_sync",
            "old_catalog_and_old_prose_are_refused_without_repair_or_mutation",
            "a_marker_change_that_arrives_before_its_dependency_is_refused_with_it"
        ]
    ),
    inv!(
        "LEVEL-OFF-KEEPS-BELOW",
        "关开关不删「下面」的东西：覆盖、泳道身份、归属、主归属、视图里的位置都留着，开关关着时读作不存在，再打开就回来",
        [Structure, Read],
        "开关存在条目上（Entry::level）；resolve_level_settings 对开关关着的条目给默认值，filter_valid_memberships、Entry::is_lane、effective_timeline_placements 都按开关过滤，数据不动",
        ["switching_off_keeps_overrides_memberships_lanes_and_placements_for_when_it_is_back"]
    ),
    inv!(
        "LEVEL-SWITCH-OFF-MOVES-CHILDREN",
        "下面还有条目时关开关：一次书目提交把直接子条目（含回收站里的）按原顺序挪到这个条目所在的顶层条目后面，子树跟着走，守卫按子条目顺序，一步撤销",
        [Command],
        "entry.set_level 关开关时声明 entries/<id>/level 和 children_of(<id>)，在一次写入里调 EntriesTreeWriterV3::switch_level_off，登记 entry_history.restore 撤销这个条目和每个被挪的子条目",
        ["switching_off_moves_direct_children_after_the_top_level_ancestor_in_one_undoable_commit"]
    ),
    inv!(
        "LEVEL-DEFAULT-FROM-TEMPLATE",
        "新条目的开关取模板的默认值；之后模板怎么改、条目换什么模板，都不动已有条目的开关",
        [Structure, Command],
        "开关存在条目上；只有 entry.create（取 EntryTemplate::level，可显式覆盖）和 entry.set_level 写它",
        ["the_switch_starts_from_the_template_and_never_follows_it_afterwards"]
    ),
    inv!(
        "MANUSCRIPT-OWN-PROSE-FIRST",
        "成书序列：从最外层成书层级按住处先序走，每个条目先给出自己 in_book 开着的正文，再走它下面的条目；回收站里的连同下面都不算",
        [Structure, Read],
        "只有 BookStructureV3::manuscript 算成书序列（导出、全书字数、章节编号都用它），ordinal 只编给有成书正文的条目",
        ["the_manuscript_sequence_puts_each_entrys_own_book_prose_before_what_lives_under_it"]
    ),
    inv!(
        "FLATTEN-MEMBERS-ONCE",
        "整书视图带归属摊平：每个层级先住在下面的、再归属进来的（按归属自己的顺序），每个条目只出现一次；成书序列不带归属",
        [Structure, Read],
        "BookStructureV3::flatten 的 include_members 用已访问集合挡住重复和环；manuscript() 恒不带归属",
        ["flattening_a_lane_reads_its_members_in_lane_order_once_and_leaves_the_manuscript_alone"]
    ),
];

pub const DIVERGENCES: &[Divergence] = &[
    Divergence {
        id: "DIV-TRASH-RELATIONS",
        topic: "删掉（进废纸篓）章节、构想、要素、分类、故事线时，它的关系怎么办",
        ui: "照删，并把它的关系永久删掉；恢复时关系不回来",
        agent: "还有关系就拒绝删除，要先删关系",
        legacy: &[
            "src/renderer/usecase/useBookNode.ts:596-660",
            "src/renderer/usecase/entity-relation-cleanup.ts:37-66",
            "src/renderer/usecase/useBookElement.ts:487-501",
            "src/renderer/usecase/useElementCategory.ts:309-318",
            "src/renderer/usecase/useStoryline.ts:559-569",
            "src/renderer/lib/agent/runtime/drifting-structural-write-strategy.ts:1406-1432",
        ],
        proposal: "canonical 条目回收不拒绝；关系原值保留，读取时隐藏已回收端点，恢复后重新显示；整书彻底删除沿用共享文档和资源隔离协议",
        status: "已统一（canonical v3，2026-11-10）：按同一条已合入命令执行",
        tests: &[
            "canonical_relations_validate_dedupe_filter_and_restore_without_losing_raw_values",
        ],
    },
    Divergence {
        id: "DIV-TRASH-COMMENTS",
        topic: "删掉一个对象时，挂在它上面的批注和待办怎么办",
        ui: "照删，批注留着",
        agent: "还有批注或待办指向它就拒绝删除",
        legacy: &[
            "src/renderer/usecase/useBookNode.ts:596-660",
            "src/renderer/lib/agent/runtime/drifting-structural-write-strategy.ts:1434-1457",
        ],
        proposal: "canonical 条目回收保留批注目标与正文，读取时标 target_missing；恢复后重新定位，不运行旧固定域级联命令",
        status: "已统一（canonical v3，2026-11-10）：按同一条已合入命令执行",
        tests: &[
            "canonical_relations_validate_dedupe_filter_and_restore_without_losing_raw_values",
        ],
    },
    Divergence {
        id: "DIV-RELTYPE-DELETE",
        topic: "删掉还在用的关系类型",
        ui: "删类型时连带删掉用它的全部关系",
        agent: "还有关系用它就拒绝",
        legacy: &[
            "src/renderer/usecase/useEntityRelationTypes.ts:118-133",
            "src/renderer/lib/agent/runtime/drifting-structural-write-strategy.ts:1399-1405",
        ],
        proposal: "沿用已合入的 canonical 命令：仍有关系使用时拒绝删除；未使用的类型可删除并通过原始记录历史撤销，内置类型不可改删",
        status: "已统一（canonical v3，2026-11-10）：按同一条已合入命令执行",
        tests: &["v3_content_modules_roundtrip_and_restore_independently"],
    },
];

/// How many contracts [`INVARIANTS`] lists.
pub const ACTIVE_CONTRACTS: usize = 83;

/// Invariants nothing tests yet, and why. The checklist's test keeps this
/// list exact: an untested rule must be named here, and a rule that gains a
/// test must leave it.
pub const NOT_YET_TESTED: &[(&str, &str)] = &[];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn invariant_ids_are_unique_and_every_rule_says_how_it_holds() {
        let mut ids = HashSet::new();
        for i in INVARIANTS {
            assert!(ids.insert(i.id), "duplicate id {}", i.id);
            assert!(!i.holds_by.is_empty(), "{} names no mechanism", i.id);
            assert!(!i.rule.is_empty() && !i.how.is_empty(), "{}", i.id);
        }
        // Every `check` predicate names an invariant that exists.
        for id in [
            "NAME-NONEMPTY",
            "MAT-PAYLOAD",
            "MAT-KIND",
            "AST-SHAPE",
            "PLOT-GRID",
        ] {
            assert!(ids.contains(id), "{id}");
        }
    }

    #[test]
    fn every_rule_is_tested_or_says_why_not() {
        let untested: Vec<&str> = INVARIANTS
            .iter()
            .filter(|i| i.tests.is_empty())
            .map(|i| i.id)
            .collect();
        let listed: Vec<&str> = NOT_YET_TESTED.iter().map(|(id, _)| *id).collect();
        assert_eq!(
            untested, listed,
            "NOT_YET_TESTED must name exactly the untested rules"
        );
    }

    #[test]
    fn contracts_leave_only_by_a_recorded_retirement() {
        // A contract is retired by a recorded decision (the cutover's are
        // named in `docs/rust-rewrite/v3-cutover.md`), never by going
        // missing: adding or retiring one changes this count with it.
        assert_eq!(INVARIANTS.len(), ACTIVE_CONTRACTS);
        let by = |m: Mechanism| {
            INVARIANTS
                .iter()
                .filter(|i| i.holds_by.contains(&m))
                .count()
        };
        for m in [Command, Read, Repair, Structure] {
            assert!(by(m) > 0, "{m:?}");
        }
    }

    #[test]
    fn every_divergence_is_unified_with_tests() {
        let mut ids = HashSet::new();
        for d in DIVERGENCES {
            assert!(ids.insert(d.id), "duplicate {}", d.id);
            assert!(d.id.starts_with("DIV-"));
            assert!(!d.ui.is_empty() && !d.agent.is_empty() && !d.proposal.is_empty());
            assert!(!d.legacy.is_empty(), "{} cites no source", d.id);
            assert!(d.status.starts_with("已统一"), "{}", d.id);
            assert!(!d.tests.is_empty(), "{} names no test", d.id);
        }
    }
}
