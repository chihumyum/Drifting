//! Built-in novel project template (`小说项目模板`, `docs/rust-rewrite/kernel-v3.md`).
//!
//! All built-in template IDs, module IDs, default root entry IDs and default
//! timeline view ID are stable constants. Creating a new novel book copies
//! these templates into the book's `templates` container so later app upgrades
//! never silently alter an existing book's structure.

use dr_model::id::{EntryId, EntryTemplateId, ModuleId, TimelineViewId};
use dr_model::pos::PosKey;
use dr_model::v3::*;

use crate::error::Result;
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

// ---- Stable default root entry IDs & timeline view ID --------------------

pub const ROOT_MANUSCRIPT: &str = "root-manuscript";
pub const ROOT_IDEAS: &str = "root-ideas";
pub const ROOT_ELEMENTS: &str = "root-elements";
pub const ROOT_STORYLINES: &str = "root-storylines";

pub const CAT_CHARACTER: &str = "cat-character";
pub const CAT_LOCATION: &str = "cat-location";
pub const CAT_ITEM: &str = "cat-item";
pub const CAT_ORGANIZATION: &str = "cat-organization";

pub const VIEW_NARRATIVE: &str = "view-narrative";

/// Root and default category entry IDs created by [`apply_novel_project_template`].
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
    pub fn new() -> Self {
        Self {
            manuscript: EntryId::parse(ROOT_MANUSCRIPT).expect("valid id"),
            ideas: EntryId::parse(ROOT_IDEAS).expect("valid id"),
            elements: EntryId::parse(ROOT_ELEMENTS).expect("valid id"),
            storylines: EntryId::parse(ROOT_STORYLINES).expect("valid id"),
            cat_character: EntryId::parse(CAT_CHARACTER).expect("valid id"),
            cat_location: EntryId::parse(CAT_LOCATION).expect("valid id"),
            cat_item: EntryId::parse(CAT_ITEM).expect("valid id"),
            cat_organization: EntryId::parse(CAT_ORGANIZATION).expect("valid id"),
            narrative_view: TimelineViewId::parse(VIEW_NARRATIVE).expect("valid id"),
        }
    }
}

fn tid(s: &str) -> EntryTemplateId {
    EntryTemplateId::parse(s).expect("valid template id")
}

fn mid(s: &str) -> ModuleId {
    ModuleId::parse(s).expect("valid module id")
}

fn eid(s: &str) -> EntryId {
    EntryId::parse(s).expect("valid entry id")
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
                pos: Some(PosKey::first()),
            }],
            color_field: Some("color".into()),
            ..ModuleConfig::default()
        },
        agent: agent_instructions("层级的展示颜色。"),
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
            instructions: "维护别名、摘要、立绘、键值字段、设定正文、章节补丁与要素关系。".into(),
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
                            pos: Some(fp[0].clone()),
                        },
                        FieldDef {
                            id: "summary".into(),
                            name: "摘要".into(),
                            field_type: FieldType::LongText,
                            options: Vec::new(),
                            target_template: None,
                            pos: Some(fp[1].clone()),
                        },
                        FieldDef {
                            id: "portrait".into(),
                            name: "立绘".into(),
                            field_type: FieldType::Image,
                            options: Vec::new(),
                            target_template: None,
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
                agent: agent_instructions("锚定在章节段落上的设定演进补丁。"),
            },
            ModuleSpec {
                id: mid(MOD_RELATIONS),
                kind: ModuleKind::Relations,
                name: "关联".into(),
                pos: Some(p[4].clone()),
                config: ModuleConfig::default(),
                agent: agent_instructions("与其他条目的有向或对称关系。"),
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
                instructions: "书稿下的章是书的结构；章正文里的 H1/H2/H3 是三级标题，含义由作者自己决定，三级同等对待。".into(),
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
                instructions: "构想移入书稿并换成「章」模板即可转为成书章节。".into(),
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
                allow: None,
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
                                pos: Some(sl_field_pos[0].clone()),
                            },
                            FieldDef {
                                id: "summary".into(),
                                name: "摘要".into(),
                                field_type: FieldType::LongText,
                                options: Vec::new(),
                                target_template: None,
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
                home: Some(Some(eid(ROOT_MANUSCRIPT))),
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
                instructions: "正文里用 H1/H2/H3 组织段落结构，含义由作者决定，三级同等对待。".into(),
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
                    agent: agent_instructions("章节正文，H1/H2/H3 为作者自定含义的三级标题。"),
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
                instructions: "挪进书稿并换成「章」模板即可转化为正式章节。".into(),
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
                                pos: Some(idea_field_pos[0].clone()),
                            },
                            FieldDef {
                                id: "status".into(),
                                name: "状态".into(),
                                field_type: FieldType::Select,
                                options: vec!["drifting".into(), "resting".into()],
                                target_template: None,
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
                    agent: agent_instructions("构想草稿正文。"),
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

/// Copy the built-in novel project template (`templates`, root level entries
/// `书稿`/`构想`/`要素`/`故事线`, default categories `人物`/`地点`/`道具`/`组织`,
/// and the default timeline view `叙事时间线`) into `txn`.
pub fn apply_novel_project_template(txn: &mut BookTxnV3<'_>) -> Result<NovelRootEntries> {
    let ids = NovelRootEntries::new();
    txn.meta().project_template(Some(&ProjectTemplateRef {
        id: NOVEL_PROJECT_TEMPLATE_ID.into(),
        version: NOVEL_PROJECT_TEMPLATE_VERSION,
    }))?;

    for tpl in novel_project_templates() {
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
