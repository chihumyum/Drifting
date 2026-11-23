use std::collections::BTreeMap;

use dr_model::project_template::{
    MAX_PROJECT_TEMPLATE_AGENT_CHARS, MAX_PROJECT_TEMPLATE_BYTES, MAX_PROJECT_TEMPLATE_ENTRIES,
    MAX_PROJECT_TEMPLATE_TEMPLATES, PROJECT_TEMPLATE_FORMAT, PROJECT_TEMPLATE_FORMAT_VERSION,
    ProjectTemplateCredit, ProjectTemplateError, ProjectTemplateValue, TemplateAgent,
    TemplateBlockAttrs, TemplateDisplayMode, TemplateEntityLink, TemplateEntry,
    TemplateEntryTemplate, TemplateFieldDef, TemplateFieldType, TemplateFormatShortcuts,
    TemplateKvRow, TemplateLevelSettings, TemplateMediaArrangement, TemplateMembership,
    TemplateModuleAgent, TemplateModuleConfig, TemplateModuleKind, TemplateModuleSpec,
    TemplateParagraph, TemplateProject, TemplateProjectBook, TemplateRelationType, TemplateRun,
    TemplateTab, TemplateTabMount, TemplateTable, TemplateVerbSpec, TemplateView, TemplateViewLane,
    TemplateViewPin, TemplateViewPlacement, parse_project_template_json, to_canonical_json,
    validate_project_template_value,
};
use dr_model::v3::FieldValue;
use serde_json::json;

fn minimal_valid_template() -> ProjectTemplateValue {
    let mut fields_map = BTreeMap::new();
    fields_map.insert("f-role".to_owned(), FieldValue::Text("主角".to_owned()));
    let mut entry_fields = BTreeMap::new();
    entry_fields.insert("mod-fields".to_owned(), fields_map);

    let mut prose_map = BTreeMap::new();
    prose_map.insert(
        "mod-prose".to_owned(),
        vec![TemplateParagraph {
            attrs: TemplateBlockAttrs {
                heading: Some(1),
                ..TemplateBlockAttrs::default()
            },
            runs: vec![TemplateRun {
                text: "第一章导言".to_owned(),
                bold: true,
                ..TemplateRun::default()
            }],
            table: None,
        }],
    );

    ProjectTemplateValue {
        format: PROJECT_TEMPLATE_FORMAT.to_owned(),
        format_version: PROJECT_TEMPLATE_FORMAT_VERSION,
        made_with: "0.2.0".to_owned(),
        name: "推理设定模板".to_owned(),
        description: "包含手稿、人物库与时间线的模板".to_owned(),
        locale: "zh-CN".to_owned(),
        revision: 1,
        credit: Some(ProjectTemplateCredit {
            author: "Lin".to_owned(),
        }),
        project: TemplateProject {
            agent: Some(TemplateAgent {
                name: "推理助手".to_owned(),
                description: "核对线索与时间线".to_owned(),
                instructions: "保持叙事视角一致。".to_owned(),
            }),
            book: Some(TemplateProjectBook {
                word_target: Some(120_000),
                daily_word_target: Some(2_000),
            }),
            tabs: vec![
                TemplateTab {
                    mount: TemplateTabMount::Book,
                },
                TemplateTab {
                    mount: TemplateTabMount::Entry {
                        entry: "e2".to_owned(),
                    },
                },
            ],
        },
        templates: vec![
            TemplateEntryTemplate {
                id: "utpl-folder".to_owned(),
                name: "目录".to_owned(),
                mark: Some("folder".to_owned()),
                color: None,
                agent: None,
                modules: vec![],
                level: true,
                linkable: true,
                settings: TemplateLevelSettings {
                    default_template: Some(Some("utpl-chapter".to_owned())),
                    display: Some(TemplateDisplayMode::List),
                    auto_link: Some(false),
                    accept: Some(false),
                    home: None,
                    format_shortcuts: None,
                },
                verbs: vec![],
            },
            TemplateEntryTemplate {
                id: "utpl-chapter".to_owned(),
                name: "章节".to_owned(),
                mark: Some("file-text".to_owned()),
                color: None,
                agent: Some(TemplateAgent {
                    name: String::new(),
                    description: "正文章节".to_owned(),
                    instructions: "遵循大纲推进。".to_owned(),
                }),
                modules: vec![TemplateModuleSpec {
                    id: "mod-prose".to_owned(),
                    kind: TemplateModuleKind::Prose,
                    name: "正文".to_owned(),
                    config: TemplateModuleConfig {
                        in_book: true,
                        show_outline: true,
                        ..TemplateModuleConfig::default()
                    },
                    agent: Some(TemplateModuleAgent {
                        writable: true,
                        read_tier: None,
                        instructions: "写作正文内容".to_owned(),
                    }),
                }],
                level: false,
                linkable: true,
                settings: TemplateLevelSettings {
                    default_template: None,
                    display: None,
                    auto_link: None,
                    accept: Some(true),
                    home: Some(Some("e1".to_owned())),
                    format_shortcuts: Some(TemplateFormatShortcuts::Full),
                },
                verbs: vec![TemplateVerbSpec {
                    id: "v-new-char".to_owned(),
                    name: "新建人物".to_owned(),
                    description: "从章节快速补充人物".to_owned(),
                    target_template: Some("utpl-character".to_owned()),
                }],
            },
            TemplateEntryTemplate {
                id: "utpl-character".to_owned(),
                name: "人物".to_owned(),
                mark: Some("user".to_owned()),
                color: None,
                agent: None,
                modules: vec![
                    TemplateModuleSpec {
                        id: "mod-fields".to_owned(),
                        kind: TemplateModuleKind::Fields,
                        name: "属性".to_owned(),
                        config: TemplateModuleConfig {
                            defs: vec![
                                TemplateFieldDef {
                                    id: "f-role".to_owned(),
                                    name: "定位".to_owned(),
                                    field_type: TemplateFieldType::Select,
                                    options: vec!["主角".to_owned(), "配角".to_owned()],
                                    target_template: None,
                                    default_value: Some(FieldValue::Text("配角".to_owned())),
                                },
                                TemplateFieldDef {
                                    id: "f-home-chapter".to_owned(),
                                    name: "登场章节".to_owned(),
                                    field_type: TemplateFieldType::EntityRef,
                                    options: vec![],
                                    target_template: Some("utpl-chapter".to_owned()),
                                    default_value: None,
                                },
                            ],
                            ..TemplateModuleConfig::default()
                        },
                        agent: None,
                    },
                    TemplateModuleSpec {
                        id: "mod-kv".to_owned(),
                        kind: TemplateModuleKind::KeyValue,
                        name: "自由属性".to_owned(),
                        config: TemplateModuleConfig {
                            initial_kv: vec![TemplateKvRow {
                                key: "年龄".to_owned(),
                                value: "待定".to_owned(),
                            }],
                            ..TemplateModuleConfig::default()
                        },
                        agent: None,
                    },
                    TemplateModuleSpec {
                        id: "mod-media".to_owned(),
                        kind: TemplateModuleKind::Media,
                        name: "参考图".to_owned(),
                        config: TemplateModuleConfig {
                            arrangement: Some(TemplateMediaArrangement::Grid),
                            ..TemplateModuleConfig::default()
                        },
                        agent: None,
                    },
                ],
                level: false,
                linkable: true,
                settings: TemplateLevelSettings {
                    default_template: None,
                    display: None,
                    auto_link: Some(true),
                    accept: None,
                    home: Some(Some("e2".to_owned())),
                    format_shortcuts: None,
                },
                verbs: vec![],
            },
            TemplateEntryTemplate {
                id: "utpl-storyline".to_owned(),
                name: "故事线".to_owned(),
                mark: Some("git-branch".to_owned()),
                color: None,
                agent: None,
                modules: vec![],
                level: false,
                linkable: true,
                settings: TemplateLevelSettings {
                    accept: Some(true),
                    ..TemplateLevelSettings::default()
                },
                verbs: vec![],
            },
        ],
        template_prose: BTreeMap::from([(
            "utpl-chapter/mod-prose".to_owned(),
            vec![TemplateParagraph {
                attrs: TemplateBlockAttrs::default(),
                runs: vec![TemplateRun::plain("在这里写本章内容")],
                table: None,
            }],
        )]),
        modules: BTreeMap::new(),
        relation_types: vec![TemplateRelationType {
            name: "线索指向".to_owned(),
            description: dr_model::v3::LinkedText::plain("连接章节线索与相关人物"),
            direction: dr_model::v3::RelationDirection::Directed,
        }],
        entries: vec![
            TemplateEntry {
                sym_ref: "e1".to_owned(),
                parent: None,
                title: "手稿".to_owned(),
                template: Some("utpl-folder".to_owned()),
                level: true,
                overrides: None,
                mark: None,
                fields: BTreeMap::new(),
                kv: BTreeMap::new(),
                arrangements: BTreeMap::new(),
                prose: BTreeMap::new(),
            },
            TemplateEntry {
                sym_ref: "e2".to_owned(),
                parent: None,
                title: "人物库".to_owned(),
                template: Some("utpl-folder".to_owned()),
                level: true,
                overrides: Some(TemplateLevelSettings {
                    default_template: Some(Some("utpl-character".to_owned())),
                    display: Some(TemplateDisplayMode::Grid),
                    auto_link: Some(true),
                    accept: None,
                    home: None,
                    format_shortcuts: None,
                }),
                mark: None,
                fields: BTreeMap::new(),
                kv: BTreeMap::new(),
                arrangements: BTreeMap::new(),
                prose: BTreeMap::new(),
            },
            TemplateEntry {
                sym_ref: "e3".to_owned(),
                parent: Some("e1".to_owned()),
                title: "第一章".to_owned(),
                template: Some("utpl-chapter".to_owned()),
                level: false,
                overrides: None,
                mark: None,
                fields: BTreeMap::new(),
                kv: BTreeMap::new(),
                arrangements: BTreeMap::new(),
                prose: prose_map,
            },
            TemplateEntry {
                sym_ref: "e4".to_owned(),
                parent: Some("e2".to_owned()),
                title: "沈侦探".to_owned(),
                template: Some("utpl-character".to_owned()),
                level: false,
                overrides: None,
                mark: None,
                fields: entry_fields,
                kv: BTreeMap::from([(
                    "mod-kv".to_owned(),
                    vec![TemplateKvRow {
                        key: "职业".to_owned(),
                        value: "私家侦探".to_owned(),
                    }],
                )]),
                arrangements: BTreeMap::from([(
                    "mod-media".to_owned(),
                    TemplateMediaArrangement::Featured,
                )]),
                prose: BTreeMap::new(),
            },
            TemplateEntry {
                sym_ref: "e5".to_owned(),
                parent: None,
                title: "主线".to_owned(),
                template: Some("utpl-storyline".to_owned()),
                level: false,
                overrides: None,
                mark: None,
                fields: BTreeMap::new(),
                kv: BTreeMap::new(),
                arrangements: BTreeMap::new(),
                prose: BTreeMap::new(),
            },
        ],
        memberships: vec![TemplateMembership {
            host: "e5".to_owned(),
            member: "e3".to_owned(),
            primary: true,
        }],
        views: vec![TemplateView {
            sym_ref: "v1".to_owned(),
            name: "主时间线".to_owned(),
            lanes: vec![TemplateViewLane {
                entry: "e5".to_owned(),
                act_track: None,
            }],
            placements: vec![TemplateViewPlacement {
                entry: "e3".to_owned(),
                at: 10.0,
                span: Some(5.0),
            }],
            pins: vec![TemplateViewPin {
                at: 10.0,
                label: "案发夜".to_owned(),
                color: None,
                entry: Some("e3".to_owned()),
            }],
        }],
    }
}

#[test]
fn valid_template_round_trips_deterministically() {
    let val = minimal_valid_template();
    validate_project_template_value(&val).expect("valid template");
    let json1 = to_canonical_json(&val).expect("serialize 1");
    let parsed = parse_project_template_json(&json1).expect("parse");
    assert_eq!(parsed, val);
    let json2 = to_canonical_json(&parsed).expect("serialize 2");
    assert_eq!(json1, json2, "canonical JSON must be byte-deterministic");
}

#[test]
fn rejects_unknown_fields_and_unknown_enum_variants() {
    let base = minimal_valid_template();
    let base_val: serde_json::Value =
        serde_json::from_str(&to_canonical_json(&base).unwrap()).unwrap();

    // Unknown field at root
    let mut v = base_val.clone();
    v.as_object_mut()
        .unwrap()
        .insert("unexpectedField".to_owned(), json!(123));
    let err = parse_project_template_json(&serde_json::to_string(&v).unwrap()).unwrap_err();
    assert!(
        matches!(err, ProjectTemplateError::MalformedJson(_)),
        "{err:?}"
    );

    // Unknown field inside `project`
    let mut v = base_val.clone();
    v["project"]
        .as_object_mut()
        .unwrap()
        .insert("secret".to_owned(), json!(true));
    assert!(matches!(
        parse_project_template_json(&serde_json::to_string(&v).unwrap()).unwrap_err(),
        ProjectTemplateError::MalformedJson(_)
    ));

    // Retired `lane` field on entry template settings must be rejected by closed schema
    let mut v = base_val.clone();
    v["templates"][0]["settings"]
        .as_object_mut()
        .unwrap()
        .insert("lane".to_owned(), json!(true));
    assert!(matches!(
        parse_project_template_json(&serde_json::to_string(&v).unwrap()).unwrap_err(),
        ProjectTemplateError::MalformedJson(_)
    ));

    // Unknown field inside `entries[]`
    let mut v = base_val.clone();
    v["entries"][0]
        .as_object_mut()
        .unwrap()
        .insert("deleted_at".to_owned(), json!(12345));
    assert!(matches!(
        parse_project_template_json(&serde_json::to_string(&v).unwrap()).unwrap_err(),
        ProjectTemplateError::MalformedJson(_)
    ));

    // Unknown `ModuleKind`
    let mut v = base_val.clone();
    v["templates"][1]["modules"][0]["kind"] = json!("magic_canvas");
    assert!(matches!(
        parse_project_template_json(&serde_json::to_string(&v).unwrap()).unwrap_err(),
        ProjectTemplateError::MalformedJson(_)
    ));

    // Unknown `FieldType`
    let mut v = base_val.clone();
    v["templates"][2]["modules"][0]["config"]["defs"][0]["field_type"] = json!("formula");
    assert!(matches!(
        parse_project_template_json(&serde_json::to_string(&v).unwrap()).unwrap_err(),
        ProjectTemplateError::MalformedJson(_)
    ));

    // Unknown `ChildDisplayMode`
    let mut v = base_val.clone();
    v["templates"][0]["settings"]["display"] = json!("kanban");
    assert!(matches!(
        parse_project_template_json(&serde_json::to_string(&v).unwrap()).unwrap_err(),
        ProjectTemplateError::MalformedJson(_)
    ));

    // Unknown `RelationOrientation`
    let mut v = base_val.clone();
    v["relation_types"][0]["direction"] = json!("bidirectional_custom");
    assert!(matches!(
        parse_project_template_json(&serde_json::to_string(&v).unwrap()).unwrap_err(),
        ProjectTemplateError::MalformedJson(_)
    ));

    // Unknown prose list kind
    let mut v = base_val;
    v["entries"][2]["prose"]["mod-prose"][0]["attrs"]["list"] = json!("roman");
    assert!(matches!(
        parse_project_template_json(&serde_json::to_string(&v).unwrap()).unwrap_err(),
        ProjectTemplateError::MalformedJson(_)
    ));
}

#[test]
fn rejects_format_version_mismatch_before_strict_struct_deserialization() {
    // Even if v2 adds a brand-new field `futureFeature`, a v1 build must report
    // `UnsupportedFormatVersion` rather than an opaque serde unknown-field error.
    let v2 = json!({
        "format": "drifting.project-template",
        "formatVersion": 2,
        "name": "未来模板",
        "futureFeature": { "enabled": true }
    });
    let err = parse_project_template_json(&serde_json::to_string(&v2).unwrap()).unwrap_err();
    assert!(
        matches!(
            err,
            ProjectTemplateError::UnsupportedFormatVersion {
                found: 2,
                supported: 1,
            }
        ),
        "unexpected error: {err:?}"
    );

    let bad_fmt = json!({
        "format": "drifting.book-export",
        "formatVersion": 1,
        "name": "走错门"
    });
    let err = parse_project_template_json(&serde_json::to_string(&bad_fmt).unwrap()).unwrap_err();
    assert!(
        matches!(err, ProjectTemplateError::InvalidFormat(ref s) if s == "drifting.book-export"),
        "unexpected error: {err:?}"
    );

    let zero_ver = json!({
        "format": "drifting.project-template",
        "formatVersion": 0,
        "name": "零版本"
    });
    let err = parse_project_template_json(&serde_json::to_string(&zero_ver).unwrap()).unwrap_err();
    assert!(
        matches!(err, ProjectTemplateError::InvalidFormatVersion(0)),
        "unexpected error: {err:?}"
    );
}

#[test]
fn enforces_size_count_and_agent_char_limits() {
    // 1. Raw byte limit (> 2 MiB)
    let huge = " ".repeat(MAX_PROJECT_TEMPLATE_BYTES + 1);
    let err = parse_project_template_json(&huge).unwrap_err();
    assert!(matches!(err, ProjectTemplateError::TooLarge { .. }));

    // 2. Entry templates count (> 200)
    let mut t = minimal_valid_template();
    for i in 0..=MAX_PROJECT_TEMPLATE_TEMPLATES {
        t.templates.push(TemplateEntryTemplate {
            id: format!("utpl-extra-{i}"),
            name: format!("模板 {i}"),
            mark: None,
            color: None,
            agent: None,
            modules: vec![],
            level: false,
            linkable: true,
            settings: TemplateLevelSettings::default(),
            verbs: vec![],
        });
    }
    let err = validate_project_template_value(&t).unwrap_err();
    assert!(matches!(err, ProjectTemplateError::Invalid(m) if m.contains("limit 200")));

    // 3. Entries count (> 2,000)
    let mut t = minimal_valid_template();
    t.entries.clear();
    t.memberships.clear();
    t.views.clear();
    t.project.book = None;
    t.project.tabs.clear();
    for tpl in &mut t.templates {
        tpl.settings.home = None;
    }
    for i in 1..=(MAX_PROJECT_TEMPLATE_ENTRIES + 1) {
        t.entries.push(TemplateEntry {
            sym_ref: format!("e{i}"),
            parent: None,
            title: format!("条目 {i}"),
            template: None,
            level: true,
            overrides: None,
            mark: None,
            fields: BTreeMap::new(),
            kv: BTreeMap::new(),
            arrangements: BTreeMap::new(),
            prose: BTreeMap::new(),
        });
    }
    let err = validate_project_template_value(&t).unwrap_err();
    assert!(matches!(err, ProjectTemplateError::Invalid(m) if m.contains("limit 2000")));

    // 4. Agent total characters (> 100,000 across project + template + module + verbs)
    let mut t = minimal_valid_template();
    t.project.agent.as_mut().unwrap().instructions = "甲".repeat(60_000);
    t.templates[1].agent.as_mut().unwrap().instructions = "乙".repeat(30_000);
    t.templates[1].modules[0]
        .agent
        .as_mut()
        .unwrap()
        .instructions = "丙".repeat(10_001);
    let err = validate_project_template_value(&t).unwrap_err();
    assert!(
        matches!(err, ProjectTemplateError::Invalid(ref m) if m.contains(&MAX_PROJECT_TEMPLATE_AGENT_CHARS.to_string())),
        "expected agent char limit error, got {err:?}"
    );
}

#[test]
fn rejects_real_ids_dangling_refs_and_structural_violations() {
    // Real UUID in entry ref rejected
    let mut t = minimal_valid_template();
    t.entries[0].sym_ref = "entry-01950000-0000-7000-8000-000000000001".to_owned();
    assert!(validate_project_template_value(&t).is_err());

    // Real UUID in entity_ref field value rejected
    let mut t = minimal_valid_template();
    t.entries[3].fields.get_mut("mod-fields").unwrap().insert(
        "f-home-chapter".to_owned(),
        FieldValue::Text("entry-01950000-0000-7000-8000-000000000003".to_owned()),
    );
    assert!(validate_project_template_value(&t).is_err());

    // Valid symbolic ref in entity_ref field value accepted when matching target_template
    let mut t = minimal_valid_template();
    t.entries[3].fields.get_mut("mod-fields").unwrap().insert(
        "f-home-chapter".to_owned(),
        FieldValue::Text("e3".to_owned()),
    );
    validate_project_template_value(&t).expect("symbolic entity_ref to chapter should pass");

    // Wrong target_template in entity_ref field value rejected
    t.entries[3].fields.get_mut("mod-fields").unwrap().insert(
        "f-home-chapter".to_owned(),
        FieldValue::Text("e4".to_owned()),
    );
    assert!(validate_project_template_value(&t).is_err());

    // Dangling symbolic ref in prose link rejected
    let mut t = minimal_valid_template();
    t.entries[2].prose.get_mut("mod-prose").unwrap()[0].runs[0].entities =
        vec![TemplateEntityLink {
            entry: "e99".to_owned(),
            module: None,
            manual: false,
        }];
    assert!(validate_project_template_value(&t).is_err());

    // Parent lacking `level: true` rejected
    let mut t = minimal_valid_template();
    t.entries[3].parent = Some("e3".to_owned()); // e3 is utpl-chapter (`level: false`)
    assert!(validate_project_template_value(&t).is_err());

    // Cycle in entry tree rejected
    let mut t = minimal_valid_template();
    t.entries[0].parent = Some("e2".to_owned());
    t.entries[1].parent = Some("e1".to_owned());
    assert!(validate_project_template_value(&t).is_err());

    // `home` pointing to an entry without `level: true` rejected
    let mut t = minimal_valid_template();
    t.templates[2].settings.home = Some(Some("e5".to_owned())); // e5 has accept=true, level=false
    assert!(validate_project_template_value(&t).is_err());

    // Membership host lacking `accept: true` rejected
    let mut t = minimal_valid_template();
    t.memberships.push(TemplateMembership {
        host: "e1".to_owned(), // e1 has level=true, accept=false
        member: "e3".to_owned(),
        primary: false,
    });
    assert!(validate_project_template_value(&t).is_err());

    // Multiple primary memberships for one member rejected
    let mut t = minimal_valid_template();
    let mut second_host = t.entries[4].clone();
    second_host.sym_ref = "e6".to_owned();
    second_host.title = "副线".to_owned();
    t.entries.push(second_host);
    t.memberships.push(TemplateMembership {
        host: "e6".to_owned(),
        member: "e3".to_owned(),
        primary: true,
    });
    assert!(validate_project_template_value(&t).is_err());

    // Negative placement `span` rejected
    let mut t = minimal_valid_template();
    t.views[0].placements[0].span = Some(-1.0);
    assert!(validate_project_template_value(&t).is_err());

    // `TabMount::Book` when `project.book` is `None` rejected
    let mut t = minimal_valid_template();
    t.project.book = None;
    assert!(validate_project_template_value(&t).is_err());

    // Phase 1: Image field value rejected
    let mut t = minimal_valid_template();
    t.templates[2].modules[0]
        .config
        .defs
        .push(TemplateFieldDef {
            id: "f-avatar".to_owned(),
            name: "头像".to_owned(),
            field_type: TemplateFieldType::Image,
            options: vec![],
            target_template: None,
            default_value: Some(FieldValue::Text("asset-123".to_owned())),
        });
    assert!(validate_project_template_value(&t).is_err());

    // Duplicate autolink names across entries rejected (`V3-AUTOLINK-NAME-UNIQUE`)
    let mut t = minimal_valid_template();
    let mut dup = t.entries[3].clone();
    dup.sym_ref = "e6".to_owned(); // same title "沈侦探" on autolink-enabled utpl-character
    t.entries.push(dup);
    assert!(validate_project_template_value(&t).is_err());

    // Valid table paragraph in prose with symbolic link passes
    let mut t = minimal_valid_template();
    t.templates[2].modules.push(TemplateModuleSpec {
        id: "mod-bio".to_owned(),
        kind: TemplateModuleKind::Prose,
        name: "小传".to_owned(),
        config: TemplateModuleConfig {
            in_book: false,
            ..TemplateModuleConfig::default()
        },
        agent: None,
    });
    t.entries[2]
        .prose
        .get_mut("mod-prose")
        .unwrap()
        .push(TemplateParagraph {
            attrs: TemplateBlockAttrs::default(),
            runs: vec![],
            table: Some(TemplateTable {
                cols: 2,
                rows: vec![
                    vec![
                        vec![TemplateRun {
                            text: "人物".to_owned(),
                            bold: true,
                            ..TemplateRun::default()
                        }],
                        vec![TemplateRun {
                            text: "出场".to_owned(),
                            bold: true,
                            ..TemplateRun::default()
                        }],
                    ],
                    vec![
                        vec![TemplateRun {
                            text: "沈侦探".to_owned(),
                            entities: vec![TemplateEntityLink {
                                entry: "e4".to_owned(),
                                module: Some("mod-bio".to_owned()),
                                manual: false,
                            }],
                            ..TemplateRun::default()
                        }],
                        vec![TemplateRun::plain("第一章")],
                    ],
                ],
            }),
        });
    validate_project_template_value(&t).expect("table with symbolic link should pass");
}

/// DW (`project-template-format.md`, 2026-11-15 night): the book has no
/// start, and a credit is its author's name only, no homepage and no
/// 「改自」. The format is closed, so a template still carrying one of these
/// keys is refused; without them it reads.
#[test]
fn a_book_start_a_homepage_or_derived_from_is_refused() {
    let base = json!({
        "format": PROJECT_TEMPLATE_FORMAT,
        "formatVersion": PROJECT_TEMPLATE_FORMAT_VERSION,
        "name": "没有起点",
        "revision": 1,
        "credit": {"author": "某作者"},
        "project": {"book": {"word_target": 1000}}
    });
    let parsed = parse_project_template_json(&base.to_string()).expect("no start, no homepage");
    assert!(parsed.project.book.is_some());

    for (what, value) in [
        ("book.root", json!({"kind": "root"})),
        ("book.root", json!({"kind": "entry", "entry": "e1"})),
    ] {
        let mut t = base.clone();
        t["project"]["book"]["root"] = value;
        assert!(
            matches!(
                parse_project_template_json(&t.to_string()),
                Err(ProjectTemplateError::MalformedJson(_))
            ),
            "{what} is refused: {t}"
        );
    }
    for (key, value) in [
        ("homepage", json!("https://example.com/templates")),
        ("derivedFrom", json!({"name": "上游", "author": "某人"})),
    ] {
        let mut t = base.clone();
        t["credit"][key] = value;
        assert!(
            matches!(
                parse_project_template_json(&t.to_string()),
                Err(ProjectTemplateError::MalformedJson(_))
            ),
            "credit.{key} is refused: {t}"
        );
    }
}

/// DV (`project-template-format.md`, 2026-11-16): a Tab cannot mount a
/// view, so a template value with a Tab on a view is refused; and a lane of
/// a template's view must take entries from elsewhere, so a folder that is
/// only a level is refused as a lane. Without them the same template reads.
#[test]
fn a_tab_on_a_view_or_a_lane_that_is_only_a_level_is_refused() {
    let mut base: serde_json::Value =
        serde_json::from_str(&to_canonical_json(&minimal_valid_template()).unwrap()).unwrap();
    base["project"]["tabs"]
        .as_array_mut()
        .unwrap()
        .retain(|t| t["mount"]["kind"] != "view");
    let parsed = parse_project_template_json(&base.to_string()).expect("no Tab on a view");
    assert!(!parsed.project.tabs.is_empty());
    assert!(!parsed.views.is_empty());

    let mut on_view = base.clone();
    on_view["project"]["tabs"]
        .as_array_mut()
        .unwrap()
        .push(json!({"mount": {"kind": "view", "view": "v1"}}));
    assert!(
        matches!(
            parse_project_template_json(&on_view.to_string()),
            Err(ProjectTemplateError::MalformedJson(_))
        ),
        "a Tab on a view is refused: {on_view}"
    );

    // 「手稿」 (e1) has its level on and 「收别处的条目」 off.
    let mut folder_lane = base.clone();
    folder_lane["views"][0]["lanes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"entry": "e1"}));
    let refused = parse_project_template_json(&folder_lane.to_string()).unwrap_err();
    assert!(
        refused.to_string().contains("V3-TIMELINE-LANE-ENABLED"),
        "a lane that is only a level is refused: {refused}"
    );
}
