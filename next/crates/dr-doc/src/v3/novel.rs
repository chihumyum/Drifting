//! Built-in novel project template (`小说项目模板`, `docs/rust-rewrite/kernel-v3.md`).
//!
//! Built-in template IDs and module IDs are stable constants. Every entry ID
//! (including default root levels `书稿`/`构想`/`要素`/`故事线` and default categories
//! `人物`/`地点`/`道具`/`组织`) is generated fresh per book so `body:<entry_id>/*`
//! document IDs are unique across books in a library (`V3-DOCID-LIBRARY-UNIQUE`).

use dr_model::id::{EntryId, EntryTemplateId, ModuleId, TimelineViewId};
use dr_model::pos::PosKey;
use dr_model::v3::*;

use crate::error::Result;
use crate::v3::read::BookViewV3;
use crate::v3::write::BookTxnV3;

pub const NOVEL_PROJECT_TEMPLATE_ID: &str = "builtin:novel";
pub const NOVEL_PROJECT_TEMPLATE_VERSION: i64 = 1;

// ---- Stable built-in template IDs ----------------------------------------

pub const TPL_MANUSCRIPT: &str = "tpl-manuscript";
pub const TPL_IDEAS: &str = "tpl-ideas";
pub const TPL_IDEA_GROUP: &str = "tpl-idea-group";
pub const TPL_ELEMENTS: &str = "tpl-elements";
pub const TPL_CATEGORY: &str = "tpl-category";
pub const TPL_GROUP: &str = "tpl-group";
pub const TPL_STORYLINES: &str = "tpl-storylines";
pub const TPL_STORYLINE: &str = "tpl-storyline";
pub const TPL_ACT_TRACK: &str = "tpl-act-track";

pub const TPL_CHAPTER: &str = "tpl-chapter";
pub const TPL_IDEA: &str = "tpl-idea";
pub const TPL_CHARACTER: &str = "tpl-character";
pub const TPL_LOCATION: &str = "tpl-location";
pub const TPL_ITEM: &str = "tpl-item";
pub const TPL_ORGANIZATION: &str = "tpl-organization";
pub const TPL_ELEMENT: &str = "tpl-element";

// ---- Stable built-in module IDs ------------------------------------------

/// Level description prose document module (`body:<entry_id>/about`).
pub const MOD_ABOUT: &str = "about";
pub const MOD_FIELDS: &str = "mod-fields";
pub const MOD_KV: &str = "mod-kv";
pub const MOD_PROSE: &str = "mod-prose";
pub const MOD_PLOT_GRID: &str = "mod-plot-grid";
pub const MOD_PATCHES: &str = "mod-patches";
pub const MOD_RELATIONS: &str = "mod-relations";

/// Root and default category entry IDs created by [`apply_novel_project_template`].
///
/// Generated fresh per book (`EntryId::new_v7()`, `TimelineViewId::new_v7()`) so
/// two books in the same library never share `body:<entry_id>/about` document IDs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NovelRootEntries {
    pub manuscript: EntryId,
    pub ideas: EntryId,
    pub elements: EntryId,
    pub storylines: EntryId,
    pub cat_character: EntryId,
    pub cat_location: EntryId,
    pub cat_item: EntryId,
    pub cat_organization: EntryId,
    pub narrative_view: TimelineViewId,
}

impl Default for NovelRootEntries {
    fn default() -> Self {
        Self::new()
    }
}

impl NovelRootEntries {
    /// Generate fresh UUIDv7 entry and timeline view IDs for a new novel book.
    pub fn new() -> Self {
        Self {
            manuscript: EntryId::new_v7(),
            ideas: EntryId::new_v7(),
            elements: EntryId::new_v7(),
            storylines: EntryId::new_v7(),
            cat_character: EntryId::new_v7(),
            cat_location: EntryId::new_v7(),
            cat_item: EntryId::new_v7(),
            cat_organization: EntryId::new_v7(),
            narrative_view: TimelineViewId::new_v7(),
        }
    }
}

fn tid(s: &str) -> EntryTemplateId {
    EntryTemplateId::parse(s).expect("valid template id")
}

fn mid(s: &str) -> ModuleId {
    ModuleId::parse(s).expect("valid module id")
}

fn pos_chain(n: usize) -> Vec<PosKey> {
    let mut out = Vec::with_capacity(n);
    let mut cur = PosKey::first();
    for i in 0..n {
        if i > 0 {
            cur = cur.after();
        }
        out.push(cur.clone());
    }
    out
}

fn agent_instructions(instructions: &str) -> Option<ModuleAgentConfig> {
    Some(ModuleAgentConfig {
        writable: true,
        read_tier: None,
        instructions: instructions.into(),
    })
}

fn color_fields_module() -> ModuleSpec {
    ModuleSpec {
        id: mid(MOD_FIELDS),
        kind: ModuleKind::Fields,
        name: "属性".into(),
        pos: Some(PosKey::first()),
        config: ModuleConfig {
            defs: vec![FieldDef {
                id: "color".into(),
                name: "颜色".into(),
                field_type: FieldType::Text,
                options: Vec::new(),
                target_template: None,
                default_value: None,
                pos: Some(PosKey::first()),
            }],
            color_field: Some("color".into()),
            ..ModuleConfig::default()
        },
        agent: agent_instructions("层级的展示颜色。"),
    }
}

/// On-demand swimlane level template for an act track (`幕轨道`).
///
/// New books have no act track by default; this template is added when
/// importing legacy acts or when an author creates an act track in a timeline
/// view (`default_template = tpl-idea`, unrestricted `allow = []`, `home = None`
/// so new entries reside under the track itself).
pub fn act_track_level_template() -> EntryTemplate {
    EntryTemplate {
        id: tid(TPL_ACT_TRACK),
        kind: TemplateKind::Level,
        name: "幕".into(),
        mark: Some("route".into()),
        color: None,
        agent: Some(TemplateAgentConfig {
            name: "幕轨道".into(),
            description: "作为时间线幕轨道的泳道层级，里面的条目在视图顶部按区间长度展示。".into(),
            instructions: "在幕轨道下新建条目默认使用构想模板并住在本层级下，也可把已有条目归属进来赋予区间长度。".into(),
        }),
        modules: vec![color_fields_module()],
        settings: LevelSettingsOverride {
            default_template: Some(Some(tid(TPL_IDEA))),
            allow: Some(Vec::new()),
            display: Some(ChildDisplayMode::List),
            auto_link: Some(false),
            accept: Some(true),
            home: None,
            is_manuscript: Some(false),
            format_shortcuts: Some(FormatShortcuts::Notes),
        },
        lane: true,
        verbs: Vec::new(),
        deleted_at: None,
    }
}

fn element_leaf_template(id_str: &str, name: &str, description: &str) -> EntryTemplate {
    let p = pos_chain(5);
    let fp = pos_chain(3);
    EntryTemplate {
        id: tid(id_str),
        kind: TemplateKind::Leaf,
        name: name.into(),
        mark: None,
        color: None,
        agent: Some(TemplateAgentConfig {
            name: name.into(),
            description: description.into(),
            instructions: "维护别名、摘要、立绘、键值字段、设定正文、补丁和关系。先读已有记录和来源正文，识别同一对象，避免把别名重复建成新要素。作者要设计人物或其他要素时，可提出供作者选择的方案，不能冒充已定设定；要补全已有要素或梳理两个要素的关系时，先读相关记录和证据，区分原文事实、推测与建议。提取正文要素时只整理原文支持的内容。整理任务中不改正文、不删除，状态变化记在对应来源条目的补丁，拿不准的事交给作者。".into(),
        }),
        modules: vec![
            ModuleSpec {
                id: mid(MOD_FIELDS),
                kind: ModuleKind::Fields,
                name: "基本属性".into(),
                pos: Some(p[0].clone()),
                config: ModuleConfig {
                    defs: vec![
                        FieldDef {
                            id: "aliases".into(),
                            name: "别名".into(),
                            field_type: FieldType::Aliases,
                            options: Vec::new(),
                            target_template: None,
                default_value: None,
                            pos: Some(fp[0].clone()),
                        },
                        FieldDef {
                            id: "summary".into(),
                            name: "摘要".into(),
                            field_type: FieldType::LongText,
                            options: Vec::new(),
                            target_template: None,
                default_value: None,
                            pos: Some(fp[1].clone()),
                        },
                        FieldDef {
                            id: "portrait".into(),
                            name: "立绘".into(),
                            field_type: FieldType::Image,
                            options: Vec::new(),
                            target_template: None,
                default_value: None,
                            pos: Some(fp[2].clone()),
                        },
                    ],
                    aliases_field: Some("aliases".into()),
                    summary_field: Some("summary".into()),
                    portrait_field: Some("portrait".into()),
                    ..ModuleConfig::default()
                },
                agent: agent_instructions("用于自动链接的别名、卡片摘要和立绘资源。"),
            },
            ModuleSpec {
                id: mid(MOD_KV),
                kind: ModuleKind::KeyValue,
                name: "字段".into(),
                pos: Some(p[1].clone()),
                config: ModuleConfig::default(),
                agent: agent_instructions("自由键值设定表。"),
            },
            ModuleSpec {
                id: mid(MOD_PROSE),
                kind: ModuleKind::Prose,
                name: "正文".into(),
                pos: Some(p[2].clone()),
                config: ModuleConfig {
                    show_outline: true,
                    task_todos: true,
                    ..ModuleConfig::default()
                },
                agent: agent_instructions("设定详述正文，内联标题 H1/H2/H3 含义由作者自定。"),
            },
            ModuleSpec {
                id: mid(MOD_PATCHES),
                kind: ModuleKind::Patches,
                name: "补丁".into(),
                pos: Some(p[3].clone()),
                config: ModuleConfig::default(),
                agent: agent_instructions("记录正文明确给出的设定演进，保留来源条目、模块和段落锚点；先核对原文，不能把推测登记为已发生的变化。"),
            },
            ModuleSpec {
                id: mid(MOD_RELATIONS),
                kind: ModuleKind::Relations,
                name: "关联".into(),
                pos: Some(p[4].clone()),
                config: ModuleConfig::default(),
                agent: agent_instructions("读双方记录及原文证据后维护有向或对称关系，沿用已有关系类型，避免重复；需要作者决定的关系只作建议。"),
            },
        ],
        settings: LevelSettingsOverride::default(),
        lane: false,
        verbs: Vec::new(),
        deleted_at: None,
    }
}

/// All built-in [`EntryTemplate`] definitions of the novel project template,
/// in deterministic ID order.
pub fn novel_project_templates() -> Vec<EntryTemplate> {
    let ch_mod_pos = pos_chain(3);
    let ch_field_pos = pos_chain(2);
    let idea_mod_pos = pos_chain(2);
    let idea_field_pos = pos_chain(2);
    let sl_mod_pos = pos_chain(2);
    let sl_field_pos = pos_chain(2);

    let mut templates = vec![
        // 1. 书稿 (Level, manuscript = true)
        EntryTemplate {
            id: tid(TPL_MANUSCRIPT),
            kind: TemplateKind::Level,
            name: "书稿".into(),
            mark: Some("book".into()),
            color: None,
            agent: Some(TemplateAgentConfig {
                name: "书稿".into(),
                description: "小说成书所在的顶层层级，下面的章按文稿顺序组成成书。".into(),
                instructions: "这是一部小说。默认大纲是书稿 / 章 / H1 / H2 / H3；幕不内置，作者添加的层级由作者命名。书稿下的章按树上顺序组成书，H1/H2/H3 的含义由作者决定，三级同等对待。沿用作者实际写下的名称；不要把建议当成作者已定的情节、设定、视角、时态、语气或文风。文学选择由作者决定。\n\n作者要构思大纲时，先读已有书稿、构想和项目记忆，再按已有意图讨论结构；要访谈时，围绕尚未决定的创作问题提问，不替作者作答。建议阶段可依据具体正文变化提出阅读、评论、改写或记录维护任务，不泛泛评价，不重复开放待办或重提已定事项；帮手或其他设备的修改可能还未被作者看过。\n\n只有作者打开或明确请求整理任务时，才把新写或变化的小说设定整理进已有要素、补丁和关系。先读原文与已有记录，核对身份，避免重复新建；项目记忆里的作者要求优先，拿不准的留给作者。仅在这种整理任务中不修改正文、不删除任何东西，不为一次整理建立长任务计划；完成后简短说明更新了什么和未决之处。此边界不限制作者另行明确要求的创作、改写或删除，仍以实际工具能力为限。小说事实归小说记录；PROJECT_MEMORY.md 保存作者长期意图、习惯和常设要求，WORKING_MEMORY.md 保存近期共同工作上下文。".into(),
            }),
            modules: Vec::new(),
            settings: LevelSettingsOverride {
                default_template: Some(Some(tid(TPL_CHAPTER))),
                allow: Some(vec![tid(TPL_CHAPTER), tid(TPL_GROUP)]),
                display: Some(ChildDisplayMode::List),
                auto_link: Some(false),
                accept: Some(false),
                home: None,
                is_manuscript: Some(true),
                format_shortcuts: Some(FormatShortcuts::Plain),
            },
            lane: false,
            verbs: vec![TemplateVerb {
                id: "new-chapter".into(),
                name: "新建章节".into(),
                description: "在书稿下用「章」模板新建一章".into(),
                target_template: Some(tid(TPL_CHAPTER)),
                pos: Some(PosKey::first()),
            }],
            deleted_at: None,
        },
        // 2. 构想 (Level, board display)
        EntryTemplate {
            id: tid(TPL_IDEAS),
            kind: TemplateKind::Level,
            name: "构想".into(),
            mark: Some("sparkles".into()),
            color: None,
            agent: Some(TemplateAgentConfig {
                name: "构想库".into(),
                description: "存放尚未合入书稿的构想与构想分组的看板层级。".into(),
                instructions: "管理尚未纳入成书的构想和分组，支持作者讨论大纲、接受访谈或发展想法；未确认的构想不自动成为小说事实。纳入成书需要作者明确要求，并通过实际可用的移动住处与换模板命令执行，保留旧模块内容。".into(),
            }),
            modules: Vec::new(),
            settings: LevelSettingsOverride {
                default_template: Some(Some(tid(TPL_IDEA))),
                allow: Some(vec![tid(TPL_IDEA), tid(TPL_IDEA_GROUP)]),
                display: Some(ChildDisplayMode::Board),
                auto_link: Some(false),
                accept: Some(false),
                home: None,
                is_manuscript: Some(false),
                format_shortcuts: Some(FormatShortcuts::Notes),
            },
            lane: false,
            verbs: vec![TemplateVerb {
                id: "new-idea".into(),
                name: "新建构想".into(),
                description: "在构想看板下新建一条构想".into(),
                target_template: Some(tid(TPL_IDEA)),
                pos: Some(PosKey::first()),
            }],
            deleted_at: None,
        },
        // 3. 构想分组 (Level)
        EntryTemplate {
            id: tid(TPL_IDEA_GROUP),
            kind: TemplateKind::Level,
            name: "构想分组".into(),
            mark: Some("folder".into()),
            color: None,
            agent: Some(TemplateAgentConfig {
                name: "构想分组".into(),
                description: "在构想看板中归类构想的层级，支持嵌套。".into(),
                instructions: "构想分组继承上层看板设置，可单独指定颜色与说明（body:<条目 id>/about）。".into(),
            }),
            modules: vec![color_fields_module()],
            settings: LevelSettingsOverride {
                default_template: Some(Some(tid(TPL_IDEA))),
                allow: Some(vec![tid(TPL_IDEA), tid(TPL_IDEA_GROUP)]),
                ..LevelSettingsOverride::default()
            },
            lane: false,
            verbs: Vec::new(),
            deleted_at: None,
        },
        // 4. 要素 (Level, island display)
        EntryTemplate {
            id: tid(TPL_ELEMENTS),
            kind: TemplateKind::Level,
            name: "要素".into(),
            mark: Some("compass".into()),
            color: None,
            agent: Some(TemplateAgentConfig {
                name: "要素库".into(),
                description: "按分类组织人物、地点、道具、组织等设定要素的顶层层级。".into(),
                instructions: "要素下按「分类」层级划分，每个分类开启自动链接并指定自己的默认要素叶子模板。".into(),
            }),
            modules: Vec::new(),
            settings: LevelSettingsOverride {
                default_template: Some(Some(tid(TPL_CATEGORY))),
                allow: Some(vec![tid(TPL_CATEGORY)]),
                display: Some(ChildDisplayMode::Island),
                auto_link: Some(false),
                accept: Some(false),
                home: None,
                is_manuscript: Some(false),
                format_shortcuts: Some(FormatShortcuts::Notes),
            },
            lane: false,
            verbs: vec![TemplateVerb {
                id: "new-category".into(),
                name: "新建分类".into(),
                description: "在要素下新建一个要素分类".into(),
                target_template: Some(tid(TPL_CATEGORY)),
                pos: Some(PosKey::first()),
            }],
            deleted_at: None,
        },
        // 5. 分类 (Level, auto_link = true, accept = true)
        EntryTemplate {
            id: tid(TPL_CATEGORY),
            kind: TemplateKind::Level,
            name: "分类".into(),
            mark: Some("tag".into()),
            color: None,
            agent: Some(TemplateAgentConfig {
                name: "分类".into(),
                description: "要素分类层级，开启自动链接，说明正文保存在 body:<条目 id>/about。".into(),
                instructions: "分类下的叶子要素（及子分组里的叶子要素）名字与别名在全书正文中自动链接且唯一。".into(),
            }),
            modules: vec![color_fields_module()],
            settings: LevelSettingsOverride {
                default_template: Some(Some(tid(TPL_CHARACTER))),
                allow: Some(Vec::new()),
                display: Some(ChildDisplayMode::Grid),
                auto_link: Some(true),
                accept: Some(true),
                home: None,
                is_manuscript: Some(false),
                format_shortcuts: Some(FormatShortcuts::Notes),
            },
            lane: false,
            verbs: Vec::new(),
            deleted_at: None,
        },
        // 6. 分组 (Level, inherits parent settings)
        EntryTemplate {
            id: tid(TPL_GROUP),
            kind: TemplateKind::Level,
            name: "分组".into(),
            mark: Some("folder".into()),
            color: None,
            agent: Some(TemplateAgentConfig {
                name: "分组".into(),
                description: "通用分组层级，继承上一层的默认模板、自动链接和成书等设置。".into(),
                instructions: "可用于书稿分卷或分类内要素分组，说明正文保存在 body:<条目 id>/about。".into(),
            }),
            modules: vec![color_fields_module()],
            settings: LevelSettingsOverride::default(),
            lane: false,
            verbs: Vec::new(),
            deleted_at: None,
        },
        // 7. 故事线列表 (Level, container of storyline lanes)
        EntryTemplate {
            id: tid(TPL_STORYLINES),
            kind: TemplateKind::Level,
            name: "故事线列表".into(),
            mark: Some("git-branch".into()),
            color: None,
            agent: Some(TemplateAgentConfig {
                name: "故事线列表".into(),
                description: "收纳全书各条故事线泳道层级的顶层层级。".into(),
                instructions: "下面每条故事线都是一个开启了泳道开关的层级。".into(),
            }),
            modules: Vec::new(),
            settings: LevelSettingsOverride {
                default_template: Some(Some(tid(TPL_STORYLINE))),
                allow: Some(vec![tid(TPL_STORYLINE)]),
                display: Some(ChildDisplayMode::List),
                auto_link: Some(false),
                accept: Some(false),
                home: None,
                is_manuscript: Some(false),
                format_shortcuts: Some(FormatShortcuts::Notes),
            },
            lane: false,
            verbs: vec![TemplateVerb {
                id: "new-storyline".into(),
                name: "新建故事线".into(),
                description: "新建一条故事线泳道".into(),
                target_template: Some(tid(TPL_STORYLINE)),
                pos: Some(PosKey::first()),
            }],
            deleted_at: None,
        },
        // 8. 故事线 (Level, lane = true, home = root-manuscript)
        EntryTemplate {
            id: tid(TPL_STORYLINE),
            kind: TemplateKind::Level,
            name: "故事线".into(),
            mark: Some("route".into()),
            color: None,
            agent: Some(TemplateAgentConfig {
                name: "故事线".into(),
                description: "作为时间线泳道的层级，说明写在 body:<条目 id>/about，成员来自归属。".into(),
                instructions: "在此故事线上新建章节时，新章节住在「书稿」并归属到本故事线。".into(),
            }),
            modules: vec![
                ModuleSpec {
                    id: mid(MOD_FIELDS),
                    kind: ModuleKind::Fields,
                    name: "属性".into(),
                    pos: Some(sl_mod_pos[0].clone()),
                    config: ModuleConfig {
                        defs: vec![
                            FieldDef {
                                id: "color".into(),
                                name: "颜色".into(),
                                field_type: FieldType::Text,
                                options: Vec::new(),
                                target_template: None,
                default_value: None,
                                pos: Some(sl_field_pos[0].clone()),
                            },
                            FieldDef {
                                id: "summary".into(),
                                name: "摘要".into(),
                                field_type: FieldType::LongText,
                                options: Vec::new(),
                                target_template: None,
                default_value: None,
                                pos: Some(sl_field_pos[1].clone()),
                            },
                        ],
                        color_field: Some("color".into()),
                        summary_field: Some("summary".into()),
                        ..ModuleConfig::default()
                    },
                    agent: agent_instructions("故事线颜色与摘要。"),
                },
                ModuleSpec {
                    id: mid(MOD_KV),
                    kind: ModuleKind::KeyValue,
                    name: "设定".into(),
                    pos: Some(sl_mod_pos[1].clone()),
                    config: ModuleConfig::default(),
                    agent: agent_instructions("故事线键值设定表。"),
                },
            ],
            settings: LevelSettingsOverride {
                default_template: Some(Some(tid(TPL_CHAPTER))),
                allow: Some(vec![tid(TPL_CHAPTER), tid(TPL_IDEA)]),
                display: Some(ChildDisplayMode::List),
                auto_link: None,
                accept: Some(true),
                home: None,
                is_manuscript: Some(false),
                format_shortcuts: None,
            },
            lane: true,
            verbs: vec![TemplateVerb {
                id: "new-chapter".into(),
                name: "新建章节".into(),
                description: "在书稿下新建一章并归属到本故事线".into(),
                target_template: Some(tid(TPL_CHAPTER)),
                pos: Some(PosKey::first()),
            }],
            deleted_at: None,
        },
        // 9. 章 (Leaf)
        EntryTemplate {
            id: tid(TPL_CHAPTER),
            kind: TemplateKind::Leaf,
            name: "章".into(),
            mark: Some("file-text".into()),
            color: None,
            agent: Some(TemplateAgentConfig {
                name: "章".into(),
                description: "小说的一章，包含梗概、写作状态、正文和情节规划。".into(),
                instructions: "正文里用 H1/H2/H3 组织段落结构，含义由作者决定，三级同等对待。作者要评论本章时，读完整请求范围后给出有原文依据的意见，不擅自改写；作者要精简或润色时，保留已定意图、视角、语气与有意义的细节，修改幅度服从本轮要求。作者要提取要素或整理设定时，读原文和已有记录，维护要素、来源补丁与关系；仅此整理任务不改正文、不删除。".into(),
            }),
            modules: vec![
                ModuleSpec {
                    id: mid(MOD_FIELDS),
                    kind: ModuleKind::Fields,
                    name: "章节信息".into(),
                    pos: Some(ch_mod_pos[0].clone()),
                    config: ModuleConfig {
                        defs: vec![
                            FieldDef {
                                id: "summary".into(),
                                name: "梗概".into(),
                                field_type: FieldType::LongText,
                                options: Vec::new(),
                                target_template: None,
                default_value: None,
                                pos: Some(ch_field_pos[0].clone()),
                            },
                            FieldDef {
                                id: "status".into(),
                                name: "写作状态".into(),
                                field_type: FieldType::Select,
                                options: vec![
                                    "draft".into(),
                                    "finished".into(),
                                    "discarded".into(),
                                ],
                                target_template: None,
                default_value: None,
                                pos: Some(ch_field_pos[1].clone()),
                            },
                        ],
                        summary_field: Some("summary".into()),
                        status_field: Some("status".into()),
                        ..ModuleConfig::default()
                    },
                    agent: agent_instructions("本章梗概与写作状态（draft / finished / discarded）。"),
                },
                ModuleSpec {
                    id: mid(MOD_PROSE),
                    kind: ModuleKind::Prose,
                    name: "正文".into(),
                    pos: Some(ch_mod_pos[1].clone()),
                    config: ModuleConfig {
                        show_outline: true,
                        task_todos: true,
                        ..ModuleConfig::default()
                    },
                    agent: agent_instructions("章节正文，H1/H2/H3 为作者自定含义的三级标题。评论先读原文；精简、润色或续写只在作者请求范围内进行，保留格式及稳定段落和批注锚点，使用工具实际支持的编辑范围。"),
                },
                ModuleSpec {
                    id: mid(MOD_PLOT_GRID),
                    kind: ModuleKind::PlotGrid,
                    name: "情节规划".into(),
                    pos: Some(ch_mod_pos[2].clone()),
                    config: ModuleConfig::default(),
                    agent: agent_instructions("本章的二维情节规划网格。"),
                },
            ],
            settings: LevelSettingsOverride::default(),
            lane: false,
            verbs: Vec::new(),
            deleted_at: None,
        },
        // 10. 构想 (Leaf)
        EntryTemplate {
            id: tid(TPL_IDEA),
            kind: TemplateKind::Leaf,
            name: "构想".into(),
            mark: Some("lightbulb".into()),
            color: None,
            agent: Some(TemplateAgentConfig {
                name: "构想".into(),
                description: "尚未定稿入书的构想叶子，包含梗概、状态和正文。".into(),
                instructions: "这里保存尚未定稿的想法，不能自动当作小说已定事实。作者要扩展、访谈或讨论大纲时，以已有想法和作者意图为起点；整理设定时先读证据，只维护有依据的记录，不改原文、不删除。作者明确要求纳入成书时，发现并使用现有移动住处和换模板能力，保留原来的内容，不声称两次命令是一个原子转换。".into(),
            }),
            modules: vec![
                ModuleSpec {
                    id: mid(MOD_FIELDS),
                    kind: ModuleKind::Fields,
                    name: "构想信息".into(),
                    pos: Some(idea_mod_pos[0].clone()),
                    config: ModuleConfig {
                        defs: vec![
                            FieldDef {
                                id: "summary".into(),
                                name: "梗概".into(),
                                field_type: FieldType::LongText,
                                options: Vec::new(),
                                target_template: None,
                default_value: None,
                                pos: Some(idea_field_pos[0].clone()),
                            },
                            FieldDef {
                                id: "status".into(),
                                name: "状态".into(),
                                field_type: FieldType::Select,
                                options: vec!["drifting".into(), "resting".into()],
                                target_template: None,
                default_value: None,
                                pos: Some(idea_field_pos[1].clone()),
                            },
                        ],
                        summary_field: Some("summary".into()),
                        status_field: Some("status".into()),
                        ..ModuleConfig::default()
                    },
                    agent: agent_instructions("构想梗概与状态（drifting / resting）。"),
                },
                ModuleSpec {
                    id: mid(MOD_PROSE),
                    kind: ModuleKind::Prose,
                    name: "正文".into(),
                    pos: Some(idea_mod_pos[1].clone()),
                    config: ModuleConfig {
                        show_outline: false,
                        task_todos: true,
                        ..ModuleConfig::default()
                    },
                    agent: agent_instructions("构想草稿正文。区分未定想法和已确认内容；访谈时让作者决定，创作或改写时遵循本轮要求。"),
                },
            ],
            settings: LevelSettingsOverride::default(),
            lane: false,
            verbs: Vec::new(),
            deleted_at: None,
        },
        // 11–15. Element leaf templates (人物, 地点, 道具, 组织, 要素)
        element_leaf_template(TPL_CHARACTER, "人物", "小说中的角色与人物要素。"),
        element_leaf_template(TPL_LOCATION, "地点", "小说中的地理空间、建筑与地点要素。"),
        element_leaf_template(TPL_ITEM, "道具", "小说中的器物、线索物与道具要素。"),
        element_leaf_template(TPL_ORGANIZATION, "组织", "小说中的势力、家族、机构与组织要素。"),
        element_leaf_template(TPL_ELEMENT, "要素", "通用设定要素叶子模板。"),
    ];
    templates.sort_by(|a, b| a.id.cmp(&b.id));
    templates
}

/// Look up the novel root level entries (`书稿`, `构想`, `要素`, `故事线`),
/// default category entries (`人物`, `地点`, `道具`, `组织`), and default
/// timeline view by their templates (`kernel-v3.md`: "之后按模板找根层级，不按固定 id 找").
pub fn find_novel_roots(view: &BookViewV3<'_>) -> Option<NovelRootEntries> {
    let entries = view.entries_raw();
    let find_root = |tpl: &str| -> Option<EntryId> {
        entries
            .iter()
            .find(|e| {
                e.parent.is_none()
                    && !e.is_trashed()
                    && e.template.as_ref().is_some_and(|t| t.as_str() == tpl)
            })
            .map(|e| e.id.clone())
    };
    let manuscript = find_root(TPL_MANUSCRIPT)?;
    let ideas = find_root(TPL_IDEAS)?;
    let elements = find_root(TPL_ELEMENTS)?;
    let storylines = find_root(TPL_STORYLINES)?;

    let find_cat = |leaf_tpl: &str| -> Option<EntryId> {
        entries
            .iter()
            .find(|e| {
                e.parent.as_ref() == Some(&elements)
                    && !e.is_trashed()
                    && e.template
                        .as_ref()
                        .is_some_and(|t| t.as_str() == TPL_CATEGORY)
                    && e.overrides
                        .as_ref()
                        .and_then(|o| o.default_template.as_ref())
                        .and_then(|d| d.as_ref())
                        .is_some_and(|t| t.as_str() == leaf_tpl)
            })
            .map(|e| e.id.clone())
    };
    let cat_character = find_cat(TPL_CHARACTER)?;
    let cat_location = find_cat(TPL_LOCATION)?;
    let cat_item = find_cat(TPL_ITEM)?;
    let cat_organization = find_cat(TPL_ORGANIZATION)?;
    let narrative_view = view.timeline_views().into_iter().next()?.id;

    Some(NovelRootEntries {
        manuscript,
        ideas,
        elements,
        storylines,
        cat_character,
        cat_location,
        cat_item,
        cat_organization,
        narrative_view,
    })
}

/// Copy the built-in novel project template (`templates`, root level entries
/// `书稿`/`构想`/`要素`/`故事线`, default categories `人物`/`地点`/`道具`/`组织`,
/// and the default timeline view `叙事时间线`) into `txn`, generating fresh
/// UUIDv7 entry and timeline view IDs (or reusing the book's existing novel
/// roots if already initialized).
pub fn apply_novel_project_template(txn: &mut BookTxnV3<'_>) -> Result<NovelRootEntries> {
    let ids = find_novel_roots(&txn.view()).unwrap_or_default();
    apply_novel_project_template_with(txn, ids)
}

/// Copy the built-in novel project template into `txn` using the caller-provided
/// `ids` (for deterministic test seeds or idempotent re-application).
pub fn apply_novel_project_template_with(
    txn: &mut BookTxnV3<'_>,
    ids: NovelRootEntries,
) -> Result<NovelRootEntries> {
    txn.meta().project_template(Some(&ProjectTemplateRef {
        id: NOVEL_PROJECT_TEMPLATE_ID.into(),
        version: NOVEL_PROJECT_TEMPLATE_VERSION,
    }))?;

    for mut tpl in novel_project_templates() {
        if tpl.id.as_str() == TPL_STORYLINE {
            tpl.settings.home = Some(Some(ids.manuscript.clone()));
        }
        txn.template(&tpl.id)?.set_full(&tpl)?;
    }

    let existing_entries: std::collections::HashSet<EntryId> =
        txn.view().entries_raw().into_iter().map(|e| e.id).collect();
    let ensure_level = |txn: &mut BookTxnV3<'_>,
                        id: &EntryId,
                        parent: Option<&EntryId>,
                        title: &str,
                        tpl: &str|
     -> Result<()> {
        let tpl_id = tid(tpl);
        if !existing_entries.contains(id) {
            txn.entries().create(id, parent, title, Some(&tpl_id))?;
        }
        Ok(())
    };

    ensure_level(txn, &ids.manuscript, None, "书稿", TPL_MANUSCRIPT)?;
    ensure_level(txn, &ids.ideas, None, "构想", TPL_IDEAS)?;
    ensure_level(txn, &ids.elements, None, "要素", TPL_ELEMENTS)?;
    ensure_level(txn, &ids.storylines, None, "故事线", TPL_STORYLINES)?;

    let fmod = mid(MOD_FIELDS);
    for (cat_id, title, leaf_tpl, color) in [
        (&ids.cat_character, "人物", TPL_CHARACTER, "#C86D51"),
        (&ids.cat_location, "地点", TPL_LOCATION, "#4F7C6B"),
        (&ids.cat_item, "道具", TPL_ITEM, "#B38B45"),
        (&ids.cat_organization, "组织", TPL_ORGANIZATION, "#5B6E94"),
    ] {
        if !existing_entries.contains(cat_id) {
            let cat_tpl = tid(TPL_CATEGORY);
            let leaf_tid = tid(leaf_tpl);
            let w = txn
                .entries()
                .create(cat_id, Some(&ids.elements), title, Some(&cat_tpl))?;
            w.overrides(Some(&LevelSettingsOverride {
                default_template: Some(Some(leaf_tid.clone())),
                allow: Some(vec![leaf_tid, tid(TPL_GROUP)]),
                ..LevelSettingsOverride::default()
            }))?
            .set_field(
                &fmod,
                "color",
                Some(&FieldValue::Text(color.to_string())),
            )?;
        }
    }

    txn.timeline_view(&ids.narrative_view)?
        .name("叙事时间线")?
        .pos(Some(&PosKey::first()))?;

    Ok(ids)
}
