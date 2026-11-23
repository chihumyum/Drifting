//! End-to-end workspace tests for user project templates (`project-templates.md` §5, §7, §8, §14, §15;
//! `handoff/v5-tracks.md` PT1).

mod common;
use common::*;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use dr_doc::project_template::BorrowedProjectTemplate;
use dr_doc::prose::{EmbedKind, Run};
use dr_model::id::{AssetId, EmbedId, ModuleId, ProjectTemplateDocId};
use dr_model::kind::EntityKind;
use dr_model::pos::PosKey;
use dr_model::project_template::to_canonical_json;
use dr_model::prose::{BlockAttrs, Heading, InlineMarks, InlineStyle};
use dr_model::v3::EntityLinkV3;
use dr_workspace::{Actor, WritePreconditions, WsEvent};
use loro::ExportMode;
use serde_json::{Value, json};

fn find_entry_by_title(entries: &[Value], title: &str) -> Value {
    entries
        .iter()
        .find(|e| e["title"] == title)
        .unwrap_or_else(|| panic!("missing entry titled {title:?}: {entries:#?}"))
        .clone()
}

fn title_map(entries: &[Value]) -> BTreeMap<String, String> {
    entries
        .iter()
        .map(|e| {
            (
                e["id"].as_str().unwrap().to_owned(),
                e["title"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[test]
fn project_template_crud_lifecycle() {
    let e = env();
    assert_eq!(e.out("project_template.list", json!({})), json!([]));

    let b = e.book();
    let saved = e.out(
        "project_template.save",
        json!({
            "book": b,
            "name": "  我的写书模板  ",
            "description": "从默认项目另存"
        }),
    );
    let tpl_id = saved["id"].as_str().unwrap().to_owned();
    assert_eq!(saved["name"], "我的写书模板");
    assert_eq!(saved["description"], "从默认项目另存");
    assert_eq!(saved["origin"], "own");
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["has_book"], true);

    let list = e.out("project_template.list", json!({}));
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], tpl_id);

    let got = e.out("project_template.get", json!({"id": tpl_id}));
    assert_eq!(got["summary"]["id"], tpl_id);
    assert_eq!(got["value"]["format"], "drifting.project-template");
    assert_eq!(got["value"]["formatVersion"], 1);
    assert_eq!(got["value"]["name"], "我的写书模板");

    let updated = e.out(
        "project_template.update",
        json!({
            "id": tpl_id,
            "name": "改名后的模板",
            "description": "新的描述"
        }),
    );
    assert_eq!(updated["name"], "改名后的模板");
    assert_eq!(updated["description"], "新的描述");
    assert_eq!(updated["revision"], 1);

    // Library-level undo restores the rename.
    e.ws().undo(&Actor::User).unwrap().unwrap();
    let reverted = e.out("project_template.get", json!({"id": tpl_id}));
    assert_eq!(reverted["summary"]["name"], "我的写书模板");
    assert_eq!(reverted["value"]["name"], "我的写书模板");

    // Replacing increments `revision` while keeping the same ID.
    let replaced = e.out(
        "project_template.save",
        json!({
            "book": b,
            "name": "我的写书模板 v2",
            "description": "替换保存",
            "replace": tpl_id
        }),
    );
    assert_eq!(replaced["id"], tpl_id);
    assert_eq!(replaced["revision"], 2);

    // Removing purges directly without trash.
    e.call("project_template.remove", json!({"id": tpl_id}));
    assert_eq!(e.out("project_template.list", json!({})), json!([]));
    assert!(
        e.try_call("project_template.get", json!({"id": tpl_id}))
            .is_err()
    );
}

#[test]
fn builtin_novel_project_round_trips_through_saved_template() {
    let e = env();
    let a = e.out("project.create", json!({"name": "直接新建"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let proj_a = e.out("project.get", json!({"book": a}));
    assert_eq!(
        proj_a["source"],
        json!({
            "id": "builtin:novel",
            "version": 5,
            "origin": "builtin",
            "name": "写书"
        })
    );

    let saved = e.out(
        "project_template.save",
        json!({
            "book": a,
            "name": "另存的写书",
            "description": "原样另存"
        }),
    );
    let tpl_id = saved["id"].as_str().unwrap().to_owned();

    // Canonical JSON must contain zero real entry/view/book IDs from `a`.
    let got = e.out("project_template.get", json!({"id": tpl_id}));
    let val_str = serde_json::to_string(&got["value"]).unwrap();
    assert!(!val_str.contains(&a));
    let entries_a = e
        .out("entry.list", json!({"book": a, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    for ent in &entries_a {
        let eid = ent["id"].as_str().unwrap();
        assert!(
            !val_str.contains(eid),
            "real entry id {eid} leaked into template value"
        );
    }

    let b = e.out(
        "project.create",
        json!({
            "name": "从另存新建",
            "template_id": tpl_id
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let proj_b = e.out("project.get", json!({"book": b}));
    assert_eq!(
        proj_b["source"],
        json!({
            "id": tpl_id,
            "version": 1,
            "origin": "own",
            "name": "另存的写书"
        })
    );
    assert_eq!(proj_b["agent"], proj_a["agent"]);
    assert_eq!(proj_b["book"]["word_target"], proj_a["book"]["word_target"]);
    assert_eq!(
        proj_b["book"]["daily_word_target"],
        proj_a["book"]["daily_word_target"]
    );
    // DW: the book has no start, and `project.get` says nothing about one.
    assert!(proj_b["book"].get("root").is_none(), "{proj_b}");
    assert!(proj_b.get("book_root_valid").is_none(), "{proj_b}");

    let entries_b = e
        .out("entry.list", json!({"book": b, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(entries_b.len(), entries_a.len());
    let ids_a: BTreeSet<&str> = entries_a
        .iter()
        .map(|x| x["id"].as_str().unwrap())
        .collect();
    let ids_b: BTreeSet<&str> = entries_b
        .iter()
        .map(|x| x["id"].as_str().unwrap())
        .collect();
    assert!(ids_a.is_disjoint(&ids_b));

    let titles_a = title_map(&entries_a);
    let titles_b = title_map(&entries_b);
    let shape = |entries: &[Value], tmap: &BTreeMap<String, String>| -> Vec<Value> {
        entries
            .iter()
            .map(|ent| {
                let parent_title = ent["parent"].as_str().map(|pid| tmap[pid].clone());
                json!({
                    "title": ent["title"],
                    "parent": parent_title,
                    "template": ent["template"],
                    "level": ent["level"],
                    "mark": ent["mark"],
                    "fields": ent["fields"],
                })
            })
            .collect()
    };
    assert_eq!(shape(&entries_b, &titles_b), shape(&entries_a, &titles_a));

    // Tabs mount the corresponding entries by title.
    let tab_shape = |proj: &Value, tmap: &BTreeMap<String, String>| -> Vec<Value> {
        proj["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| {
                let mount = match t["mount"]["kind"].as_str().unwrap() {
                    "entry" => json!({
                        "kind": "entry",
                        "title": tmap[t["mount"]["entry"].as_str().unwrap()]
                    }),
                    other => json!({"kind": other}),
                };
                json!({
                    "name": t["name"],
                    "mount": mount,
                    "mount_valid": t["mount_valid"]
                })
            })
            .collect()
    };
    assert_eq!(tab_shape(&proj_b, &titles_b), tab_shape(&proj_a, &titles_a));

    // Entry templates match, with `settings.home` rewritten to `b`'s manuscript folder.
    let tpls_a = e
        .out("entry_template.list", json!({"book": a}))
        .as_array()
        .unwrap()
        .clone();
    let tpls_b = e
        .out("entry_template.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(tpls_b.len(), tpls_a.len());
    let ms_b = find_entry_by_title(&entries_b, "书稿")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let sl_tpl_b = tpls_b.iter().find(|t| t["id"] == "tpl-storyline").unwrap();
    assert_eq!(sl_tpl_b["settings"]["home"], json!(ms_b));

    // Timeline views match with fresh IDs and storyline lane preserved.
    let views_a = e
        .out("timeline_view.list", json!({"book": a}))
        .as_array()
        .unwrap()
        .clone();
    let views_b = e
        .out("timeline_view.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(views_b.len(), views_a.len());
    assert_ne!(views_b[0]["id"], views_a[0]["id"]);
    assert_eq!(views_b[0]["name"], views_a[0]["name"]);
    assert_eq!(views_b[0]["lanes"], views_a[0]["lanes"]);

    // Functional parity: adding a chapter under "书稿" in both books puts it
    // first in the book (`book.sequence`; nothing is numbered).
    let ms_a = find_entry_by_title(&entries_a, "书稿")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (book, ms) in [(&a, &ms_a), (&b, &ms_b)] {
        e.call(
            "entry.create",
            json!({
                "book": book,
                "parent": ms,
                "template": "tpl-chapter",
                "title": "第一章",
                "bodies": {"mod-prose": "风起于青萍之末。"}
            }),
        );
        let seq = e.out("book.sequence", json!({"book": book}));
        let seq_entries = seq["entries"].as_array().unwrap();
        let ch_item = seq_entries
            .iter()
            .find(|x| !x["prose"].as_array().unwrap().is_empty())
            .expect("chapter in book.sequence");
        assert_eq!(ch_item["entry"]["title"], "第一章");
        assert!(ch_item.get("ordinal").is_none());
    }
}

#[test]
fn storyline_with_level_off_and_swimlane_skeleton_round_trips() {
    let e = env();
    let a = e.book();
    let entries_a = e
        .out("entry.list", json!({"book": a, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    let ms_a = find_entry_by_title(&entries_a, "书稿")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let sl_folder_a = find_entry_by_title(&entries_a, "故事线")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let view_a = e.out("timeline_view.list", json!({"book": a}))[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Create a storyline (`level == false`, `accept == true` via `tpl-storyline`, custom color + non-color summary).
    let sub_line_a = e.out(
        "entry.create",
        json!({
            "book": a,
            "parent": sl_folder_a,
            "template": "tpl-storyline",
            "title": "暗线",
            "level": false
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "module.set_field",
        json!({
            "book": a,
            "entry": sub_line_a,
            "module": "mod-fields",
            "field": "color",
            "value": "#2a6f97"
        }),
    );
    e.call(
        "module.set_field",
        json!({
            "book": a,
            "entry": sub_line_a,
            "module": "mod-fields",
            "field": "summary",
            "value": "未勾选的摘要不应作为骨架带走"
        }),
    );

    // Add `暗线` (`level == false`, `accept == true`) as a swimlane on the timeline view.
    e.call(
        "timeline_view.add_lane",
        json!({
            "book": a,
            "view": view_a,
            "lane": sub_line_a
        }),
    );

    // Create a skeleton volume entry (`level == true`) under `书稿`, attach it to `暗线`,
    // and place it on `暗线`'s swimlane.
    let vol_a = e.out(
        "entry.create",
        json!({
            "book": a,
            "parent": ms_a,
            "template": "tpl-group",
            "title": "第一卷",
            "level": true
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "timeline_view.place",
        json!({
            "book": a,
            "view": view_a,
            "entry": vol_a,
            "lane": sub_line_a,
            "at": 12.5,
            "span": 4.0
        }),
    );
    e.call(
        "membership.primary",
        json!({
            "book": a,
            "member": vol_a,
            "host": sub_line_a
        }),
    );

    // Default save (no `sample_entries` needed: storyline, swimlane, and skeleton on the lane are all skeleton).
    let saved = e.out(
        "project_template.save",
        json!({
            "book": a,
            "name": "双线骨架模板"
        }),
    );
    let b = e.out(
        "project.create",
        json!({
            "name": "双线新书",
            "template_id": saved["id"]
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let entries_b = e
        .out("entry.list", json!({"book": b, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    let sub_line_b = find_entry_by_title(&entries_b, "暗线");
    let sub_line_b_id = sub_line_b["id"].as_str().unwrap().to_owned();
    assert_eq!(sub_line_b["level"], false);
    assert_eq!(
        sub_line_b["fields"]["mod-fields"]["color"],
        json!("#2a6f97")
    );
    assert!(
        sub_line_b["fields"]["mod-fields"].get("summary").is_none(),
        "non-color fields on unchecked skeleton entries must be omitted"
    );

    let vol_b = find_entry_by_title(&entries_b, "第一卷");
    let vol_b_id = vol_b["id"].as_str().unwrap().to_owned();
    assert_eq!(vol_b["level"], true);
    assert_eq!(vol_b["primary"], json!(sub_line_b_id));

    let memberships_b = e
        .out("membership.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .clone();
    assert!(
        memberships_b
            .iter()
            .any(|m| m["host"] == sub_line_b_id && m["member"] == vol_b_id),
        "expected 第一卷 on 暗线 in {memberships_b:#?}"
    );

    let views_b = e
        .out("timeline_view.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .clone();
    let lanes_b: Vec<&str> = views_b[0]["lanes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["entry"].as_str().unwrap())
        .collect();
    assert!(lanes_b.contains(&sub_line_b_id.as_str()));
    let placements_b = views_b[0]["placements"].as_array().unwrap();
    assert_eq!(placements_b.len(), 1);
    assert_eq!(placements_b[0]["entry"], vol_b_id);
    assert_eq!(placements_b[0]["at"], json!(12.5));
    assert_eq!(placements_b[0]["span"], json!(4.0));
}

#[test]
fn rich_project_save_and_create_preserves_samples_rewrites_ids_and_strips_excluded() {
    let e = env();
    e.ws().set_auto_links(false);
    let a = e.book();

    let entries_a = e
        .out("entry.list", json!({"book": a, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    let ms_a = find_entry_by_title(&entries_a, "书稿")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let sl_folder_a = find_entry_by_title(&entries_a, "故事线")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let view_a = e.out("timeline_view.list", json!({"book": a}))[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let main_line_a = e.out(
        "entry.create",
        json!({
            "book": a,
            "parent": sl_folder_a,
            "template": "tpl-storyline",
            "title": "主线",
            "level": false
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "timeline_view.add_lane",
        json!({"book": a, "view": view_a, "lane": main_line_a}),
    );

    // Update project definition: custom agent, targets, and a Tab on the
    // book (an old caller's book start is ignored: DW; a Tab cannot mount a
    // view: DV).
    e.call(
        "project.update",
        json!({
            "book": a,
            "agent": {
                "name": "推理助手",
                "description": "法庭推理结构指导",
                "instructions": "核对证词时间线。"
            },
            "root": {
                "kind": "lane",
                "view": view_a,
                "entry": main_line_a
            },
            "word_target": 80000,
            "daily_word_target": 2000
        }),
    );
    e.call(
        "tab.put",
        json!({
            "book": a,
            "name": "成书序列",
            "mount": {"kind": "book"}
        }),
    );
    // 「全部」 (the root's tab) is always there (`kernel-v5.md` §5).

    // Register an image asset in `a` first so `entry_template.put` accepts it as a default image value,
    // then verify Phase 1 strips image defaults, image fields, media items, asset embeds, and asset links.
    let sha = "a".repeat(64);
    e.call(
        "asset.put",
        json!({
            "book": a,
            "id": "asset-photo",
            "name": "evidence.png",
            "kind": "image",
            "mime": "image/png",
            "size": 128,
            "sha256": sha,
            "width": 2,
            "height": 2
        }),
    );

    // Add a temporary template that will be deleted so references to deleted templates are cleared.
    e.call(
        "entry_template.put",
        json!({
            "book": a,
            "template": {
                "id": "tpl-obsolete",
                "name": "废弃模板",
                "modules": []
            }
        }),
    );

    // Put a rich custom template with fields (including entity_ref & image), kv, media, prose, and verbs.
    e.call(
        "entry_template.put",
        json!({
            "book": a,
            "template": {
                "id": "tpl-dossier",
                "name": "卷宗",
                "mark": "§",
                "color": "#4a5859",
                "level": false,
                "linkable": true,
                "agent": {
                    "name": "卷宗卡",
                    "description": "案件关键卷宗",
                    "instructions": "保持客观记录。"
                },
                "modules": [
                    {
                        "id": "mod-fields",
                        "kind": "fields",
                        "name": "属性",
                        "config": {
                            "defs": [
                                {
                                    "id": "fld-code",
                                    "name": "编号",
                                    "field_type": "text",
                                    "default_value": "D-000"
                                },
                                {
                                    "id": "fld-related",
                                    "name": "关联条目",
                                    "field_type": "entity_ref"
                                },
                                {
                                    "id": "fld-unchecked-ref",
                                    "name": "未选引用",
                                    "field_type": "entity_ref"
                                },
                                {
                                    "id": "fld-obsolete-target",
                                    "name": "已删模板引用",
                                    "field_type": "entity_ref",
                                    "target_template": "tpl-obsolete"
                                },
                                {
                                    "id": "fld-cover",
                                    "name": "封面图",
                                    "field_type": "image",
                                    "default_value": "asset-photo"
                                }
                            ]
                        }
                    },
                    {
                        "id": "mod-kv",
                        "kind": "kv",
                        "name": "键值",
                        "config": {
                            "initial_kv": [
                                {"id": "kv-init-1", "key": "来源", "value": "档案室"}
                            ]
                        }
                    },
                    {
                        "id": "mod-media",
                        "kind": "media",
                        "name": "附件",
                        "config": {
                            "arrangement": "grid"
                        }
                    },
                    {
                        "id": "mod-prose",
                        "kind": "prose",
                        "name": "正文",
                        "config": {"in_book": true},
                        "agent": {
                            "writable": true,
                            "read_tier": "full",
                            "instructions": "按证人顺序撰写。"
                        }
                    },
                    {
                        "id": "mod-notes",
                        "kind": "prose",
                        "name": "附录",
                        "config": {"in_book": false}
                    }
                ],
                "verbs": [
                    {
                        "id": "verb-new-dossier",
                        "name": "新建卷宗",
                        "description": "在此层新建一份卷宗",
                        "target_template": "tpl-dossier"
                    }
                ]
            }
        }),
    );

    // Template initial prose on `tpl-dossier` / `mod-prose`.
    e.call(
        "module.set_prose",
        json!({
            "book": a,
            "owner": "tpl-dossier",
            "module": "mod-prose",
            "template": true,
            "paragraphs": [
                {"heading": 1, "text": "卷宗摘要"},
                {"text": "在此填写卷宗内容。"}
            ]
        }),
    );

    e.call(
        "entry_template.delete",
        json!({"book": a, "id": "tpl-obsolete"}),
    );

    // Create 3 entries: `sample1` (checked), `sample2` (checked), `unchecked3` (unchecked).
    let sample2 = e.out(
        "entry.create",
        json!({
            "book": a,
            "parent": ms_a,
            "template": "tpl-dossier",
            "title": "二号证物",
            "bodies": {"mod-notes": "附录说明"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let unchecked3 = e.out(
        "entry.create",
        json!({
            "book": a,
            "parent": ms_a,
            "template": "tpl-dossier",
            "title": "未勾选草稿",
            "bodies": {"mod-prose": "这段绝不应该进模板。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let sample1 = e.out(
        "entry.create",
        json!({
            "book": a,
            "parent": ms_a,
            "template": "tpl-dossier",
            "title": "一号证物",
            "mark": "★"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Set fields (text, entity_ref to sample2, entity_ref to unchecked3, image field), kv, media, arrangement.
    e.call(
        "module.set_field",
        json!({"book": a, "entry": sample1, "module": "mod-fields", "field": "fld-code", "value": "D-101"}),
    );
    e.call(
        "module.set_field",
        json!({"book": a, "entry": sample1, "module": "mod-fields", "field": "fld-related", "value": sample2}),
    );
    e.call(
        "module.set_field",
        json!({"book": a, "entry": sample1, "module": "mod-fields", "field": "fld-unchecked-ref", "value": unchecked3}),
    );
    e.call(
        "module.set_field",
        json!({"book": a, "entry": sample1, "module": "mod-fields", "field": "fld-cover", "value": "asset-photo"}),
    );
    e.call(
        "module.put_kv",
        json!({"book": a, "entry": sample1, "module": "mod-kv", "row": {"id": "kv-1", "key": "保管人", "value": "林检"}}),
    );
    e.call(
        "module.put_media",
        json!({"book": a, "entry": sample1, "module": "mod-media", "item": {"id": "mi-1", "asset": "asset-photo", "caption": "现场照"}}),
    );
    e.call(
        "module.set_arrangement",
        json!({"book": a, "entry": sample1, "module": "mod-media", "arrangement": "list"}),
    );

    // Author rich prose on `sample1` (`mod-prose`): heading, link to `sample2` (with module `mod-notes`),
    // bold link to `unchecked3`, italic link to `asset-photo`, table embed, and image asset embed.
    {
        let sess = e
            .ws()
            .prose_session(&format!("body:{sample1}/mod-prose"))
            .unwrap();
        let s2_for_edit = sample2.clone();
        let u3_for_edit = unchecked3.clone();
        let asset_at = sess
            .edit(move |txn| {
                // Paragraph 1: H2 heading
                txn.insert_text(0, "证词记录")?;
                txn.set_block_attrs(
                    0,
                    &BlockAttrs {
                        heading: Some(Heading::H2),
                        ..BlockAttrs::default()
                    },
                )?;
                let p2 = txn.split(4)?;
                // Paragraph 2: "参见二号证物与未勾选草稿及照片"
                // chars: "参见" (0..2), "二号证物" (2..6), "与" (6..7), "未勾选草稿" (7..12), "及" (12..13), "照片" (13..15)
                txn.insert_text(p2, "参见二号证物与未勾选草稿及照片")?;
                txn.link_entity_v3(
                    (p2 + 2)..(p2 + 6),
                    &EntityLinkV3 {
                        target: s2_for_edit,
                        kind: EntityKind::Entry,
                        module: Some(ModuleId::parse("mod-notes").unwrap()),
                        block: None,
                        end_block: None,
                        manual: false,
                    },
                )?;
                txn.set_style((p2 + 7)..(p2 + 12), &InlineStyle::Bold)?;
                txn.link_entity_v3(
                    (p2 + 7)..(p2 + 12),
                    &EntityLinkV3 {
                        target: u3_for_edit,
                        kind: EntityKind::Entry,
                        module: None,
                        block: None,
                        end_block: None,
                        manual: false,
                    },
                )?;
                txn.set_style((p2 + 13)..(p2 + 15), &InlineStyle::Italic)?;
                txn.link_entity_v3(
                    (p2 + 13)..(p2 + 15),
                    &EntityLinkV3 {
                        target: "asset-photo".into(),
                        kind: EntityKind::Asset,
                        module: None,
                        block: None,
                        end_block: None,
                        manual: false,
                    },
                )?;
                let tbl_at = txn.split(p2 + 15)?;
                let tbl_id = EmbedId::parse("tbl-evidence").unwrap();
                {
                    let writer = txn.insert_embed(tbl_at, &tbl_id, &EmbedKind::Table)?;
                    let c1_pos = PosKey::first();
                    let c2_pos = c1_pos.after();
                    writer.add_col("c1", &c1_pos)?;
                    writer.add_col("c2", &c2_pos)?;
                    writer.add_row("r1", &PosKey::first())?;
                }
                txn.set_table_cell_runs_v3(
                    &tbl_id,
                    "r1",
                    "c1",
                    &[Run {
                        text: "时间".into(),
                        marks: InlineMarks::default(),
                    }],
                    &[],
                )?;
                txn.set_table_cell_runs_v3(
                    &tbl_id,
                    "r1",
                    "c2",
                    &[Run {
                        text: "21:30".into(),
                        marks: InlineMarks::default(),
                    }],
                    &[],
                )?;
                Ok(tbl_at + 2)
            })
            .unwrap();
        sess.insert_asset_embed(
            asset_at,
            &EmbedId::parse("emb-photo").unwrap(),
            &AssetId::parse("asset-photo").unwrap(),
        )
        .unwrap();
    }

    // Place `sample1` and `unchecked3` on `main_line_a`, add pins (bound to sample1, unbound, bound to unchecked3).
    e.call(
        "timeline_view.place",
        json!({"book": a, "view": view_a, "entry": sample1, "lane": main_line_a, "at": 5.0, "span": 2.0}),
    );
    e.call(
        "timeline_view.place",
        json!({"book": a, "view": view_a, "entry": unchecked3, "lane": main_line_a, "at": 9.0}),
    );
    e.call(
        "membership.primary",
        json!({"book": a, "member": sample1, "host": main_line_a}),
    );
    e.call(
        "timeline_view.put_pin",
        json!({"book": a, "view": view_a, "pin": {"id": "pin-1", "at": 5.0, "label": "案发", "entry": sample1}}),
    );
    e.call(
        "timeline_view.put_pin",
        json!({"book": a, "view": view_a, "pin": {"id": "pin-free", "at": 7.5, "label": "停电", "entry": null}}),
    );
    e.call(
        "timeline_view.put_pin",
        json!({"book": a, "view": view_a, "pin": {"id": "pin-unchecked", "at": 9.0, "label": "草稿钉", "entry": unchecked3}}),
    );

    let kind = e.out(
        "relation_type.create",
        json!({
            "book":a,"name":"证词矛盾","direction":"directed","description":{
                "text":"见证对照草案","links":[
                    {"start":0,"end":2,"entry":sample2},
                    {"start":4,"end":6,"entry":unchecked3}
                ]
            }
        }),
    )["id"]
        .clone();
    // Rows and project-local writing are excluded from a template.
    e.call(
        "relation_row.create_pair",
        json!({
            "book":a,"left":sample1,"right":sample2,"relation_type":kind
        }),
    );
    e.call(
        "comment.create",
        json!({
            "book": a,
            "target": {"kind": "entry", "id": sample1},
            "body": "私密批注不进模板"
        }),
    );
    e.call(
        "fact.put",
        json!({"book": a, "key": "地点", "value": "旧港"}),
    );
    e.call(
        "memory.add",
        json!({"book": a, "kind": "preference", "body": "私密记忆不进模板"}),
    );
    e.call(
        "layout.put",
        json!({"book": a, "scope": "root", "mode": "relation_graph", "positions": {sample1.clone(): [120.0, 240.0]}}),
    );

    // Save template selecting ONLY `sample1` and `sample2`, plus `view_a`'s pins.
    let saved = e.out(
        "project_template.save",
        json!({
            "book": a,
            "name": "法庭推理模板",
            "description": "含卷宗示例",
            "credit": {
                "author": "林检"
            },
            "sample_entries": [sample1, sample2],
            "view_pins": [view_a]
        }),
    );
    let tpl_id = saved["id"].as_str().unwrap().to_owned();

    // Create TWO projects `b` and `c` from `tpl_id`; verify disjoint IDs and purge isolation.
    let b = e.out(
        "project.create",
        json!({"name": "新案件甲", "template_id": tpl_id}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let c = e.out(
        "project.create",
        json!({"name": "新案件乙", "template_id": tpl_id}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Trash and purge `c`; `b`'s entries and prose remain completely intact.
    e.call("book.trash", json!({"book": c}));
    e.call("book.purge", json!({"book": c}));

    let proj_b = e.out("project.get", json!({"book": b}));
    assert_eq!(proj_b["source"]["origin"], "own");
    assert_eq!(proj_b["source"]["name"], "法庭推理模板");
    assert_eq!(proj_b["source"]["credit"]["author"], "林检");
    assert_eq!(proj_b["agent"]["name"], "推理助手");
    assert_eq!(proj_b["book"]["word_target"], 80000);
    assert_eq!(proj_b["book"]["daily_word_target"], 2000);
    assert!(proj_b["book"].get("root").is_none(), "{proj_b}");

    let entries_b = e
        .out("entry.list", json!({"book": b, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    assert!(
        entries_b.iter().all(|x| x["title"] != "未勾选草稿"),
        "unchecked entry must not be in template"
    );
    let s1_b = find_entry_by_title(&entries_b, "一号证物");
    let s2_b = find_entry_by_title(&entries_b, "二号证物");
    let s1_b_id = s1_b["id"].as_str().unwrap().to_owned();
    let s2_b_id = s2_b["id"].as_str().unwrap().to_owned();
    let main_line_b_id = find_entry_by_title(&entries_b, "主线")["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // `entity_ref` to `sample2` rewrote to `s2_b_id`; `entity_ref` to `unchecked3` and `image` field were stripped!
    assert_eq!(s1_b["mark"], "★");
    assert_eq!(s1_b["fields"]["mod-fields"]["fld-code"], "D-101");
    assert_eq!(s1_b["fields"]["mod-fields"]["fld-related"], s2_b_id);
    assert!(
        s1_b["fields"]["mod-fields"]
            .get("fld-unchecked-ref")
            .is_none()
    );
    assert!(s1_b["fields"]["mod-fields"].get("fld-cover").is_none());
    assert_eq!(s1_b["arrangements"]["mod-media"], "list");
    assert!(
        s1_b["media"]
            .get("mod-media")
            .is_none_or(|m| m.as_array().unwrap().is_empty())
    );
    assert_eq!(s1_b["primary"], main_line_b_id);

    // Deleted template `tpl-obsolete` references were cleared from `tpl-dossier` .
    let tpls_b = e
        .out("entry_template.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .clone();
    assert!(tpls_b.iter().all(|t| t["id"] != "tpl-obsolete"));
    let dossier_b = tpls_b.iter().find(|t| t["id"] == "tpl-dossier").unwrap();
    let defs_b = dossier_b["modules"][0]["config"]["defs"]
        .as_array()
        .unwrap();
    let obsolete_def_b = defs_b
        .iter()
        .find(|d| d["id"] == "fld-obsolete-target")
        .unwrap();
    assert!(obsolete_def_b["target_template"].is_null());
    let cover_def_b = defs_b.iter().find(|d| d["id"] == "fld-cover").unwrap();
    assert!(cover_def_b.get("default_value").is_none_or(Value::is_null));

    // Template initial prose was materialized in `b`.
    let tpl_prose_b = e.out(
        "module.read_prose",
        json!({"book": b, "owner": "tpl-dossier", "module": "mod-prose", "template": true}),
    );
    assert_eq!(tpl_prose_b["paragraphs"][0]["text"], "卷宗摘要");
    assert_eq!(tpl_prose_b["paragraphs"][0]["heading"], 1);

    let rts_b = e
        .out("relation_type.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .clone();
    let contra_b = rts_b
        .iter()
        .find(|rt| rt["name"] == "证词矛盾")
        .expect("custom relation type preserved");
    assert_eq!(contra_b["rows"], json!([]));
    assert_eq!(contra_b["direction"], "directed");
    // The description's link was picked with @: the template carries that
    // (`kernel-v5.md` §16).
    assert_eq!(
        contra_b["description"]["links"],
        json!([{"start":0,"end":s2_b["title"].as_str().unwrap().chars().count(),"entry":s2_b_id,"manual":true}])
    );
    assert!(
        contra_b["description"]["text"]
            .as_str()
            .unwrap()
            .ends_with("对照草案")
    );

    // Inspect materialized prose on `s1_b`: heading, table, rewritten link to `s2_b` (`mod-notes`),
    // degraded plain text (preserving Bold & Italic) for `unchecked3` and `asset-photo`, and zero asset embeds!
    let sess_b = e
        .ws()
        .prose_session(&format!("body:{s1_b_id}/mod-prose"))
        .unwrap();
    let reader_b = sess_b.reader();
    let pview_b = reader_b.view();
    assert!(
        pview_b.embed_refs().iter().all(|(_, eid)| !matches!(
            pview_b.embed(eid),
            Some(dr_doc::prose::EmbedView::Asset { .. })
        )),
        "asset embeds must be stripped in Phase 1"
    );
    let paras_b: Vec<_> = pview_b.paragraphs().collect();
    assert!(
        paras_b.len() >= 3,
        "H2 + text paragraph + table paragraph: {paras_b:#?}"
    );
    assert_eq!(paras_b[0].attrs.heading, Some(Heading::H2));
    assert_eq!(paras_b[0].text(), "证词记录");
    assert_eq!(paras_b[1].text(), "参见二号证物与未勾选草稿及照片");
    assert!(
        paras_b[2].embed().is_some(),
        "third paragraph is the table embed"
    );
    let links_b = pview_b.entity_links_v3();
    assert_eq!(
        links_b.len(),
        1,
        "only link to included sample2 remains: {links_b:?}"
    );
    assert_eq!(links_b[0].1.target, s2_b_id);
    assert_eq!(
        links_b[0].1.module.as_ref().map(|m| m.as_str()),
        Some("mod-notes")
    );
    assert!(
        paras_b[1]
            .runs
            .iter()
            .any(|r| r.text == "未勾选草稿" && r.marks.bold),
        "degraded unchecked-entry link keeps bold style: {:?}",
        paras_b[1].runs
    );
    assert!(
        paras_b[1]
            .runs
            .iter()
            .any(|r| r.text == "照片" && r.marks.italic),
        "degraded asset link keeps italic style: {:?}",
        paras_b[1].runs
    );

    // View pins: `案发` (bound to `s1_b_id`) and `停电` (unbound) kept; `草稿钉` (bound to `unchecked3`) omitted!
    let views_b = e
        .out("timeline_view.list", json!({"book": b}))
        .as_array()
        .unwrap()
        .clone();
    let pins_b = views_b[0]["pins"].as_array().unwrap();
    assert_eq!(pins_b.len(), 2, "{pins_b:#?}");
    assert_eq!(pins_b[0]["label"], "案发");
    assert_eq!(pins_b[0]["entry"], json!(s1_b_id));
    assert_eq!(pins_b[1]["label"], "停电");
    assert!(pins_b[1]["entry"].is_null());

    // Never-carried book data is empty in `b`.
    assert_eq!(e.out("comment.list", json!({"book": b})), json!([]));
    assert_eq!(e.out("fact.list", json!({"book": b})), json!([]));
    assert_eq!(e.out("memory.list", json!({"book": b})), json!([]));
    assert_eq!(
        e.out(
            "layout.get",
            json!({"book": b, "scope": "root", "mode": "relation_graph"})
        ),
        json!({})
    );
    assert_eq!(e.out("asset.list", json!({"book": b})), json!([]));
}

#[test]
fn forced_skeleton_targets_cannot_be_excluded_and_missing_targets_are_left_out() {
    let e = env();
    let a = e.book();
    let entries_a = e
        .out("entry.list", json!({"book": a, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    let ms_a = find_entry_by_title(&entries_a, "书稿")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ideas_a = find_entry_by_title(&entries_a, "构想")["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // `书稿` is referenced by a tab and `tpl-storyline.settings.home`: cannot exclude!
    assert!(
        e.try_call(
            "project_template.save",
            json!({"book": a, "name": "拒排除书稿", "exclude_skeleton": [ms_a]})
        )
        .is_err()
    );
    // `构想` is mounted by a tab: cannot exclude while tab mounts it!
    assert!(
        e.try_call(
            "project_template.save",
            json!({"book": a, "name": "拒排除Tab", "exclude_skeleton": [ideas_a]})
        )
        .is_err()
    );

    // Create an extra unlocked skeleton folder `附录架`, verify it CAN be excluded via `exclude_skeleton`.
    let extra_folder = e.out(
        "entry.create",
        json!({
            "book": a,
            "title": "附录架",
            "template": "tpl-group",
            "level": true
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let saved_without_extra = e.out(
        "project_template.save",
        json!({"book": a, "name": "排除附录架", "exclude_skeleton": [extra_folder]}),
    );
    let got_without_extra = e.out(
        "project_template.get",
        json!({"id": saved_without_extra["id"]}),
    );
    assert!(
        got_without_extra["value"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|ent| ent["title"] != "附录架")
    );

    // Now trash `构想` (mounted by a tab), so the tab's mount points to a
    // trashed entry (`project-templates.md` §3 row 1; the tab is left out
    // since 2026-11-15). The book has no start to break (DW).
    e.call("entry.trash", json!({"book": a, "id": extra_folder}));
    e.call("entry.trash", json!({"book": a, "id": ideas_a}));

    let saved_broken = e.out(
        "project_template.save",
        json!({"book": a, "name": "构想已删模板"}),
    );
    let b = e.out(
        "project.create",
        json!({"name": "缺了构想的新书", "template_id": saved_broken["id"]}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let proj_b = e.out("project.get", json!({"book": b}));
    assert!(proj_b["book"].is_object(), "{proj_b}");
    assert!(proj_b["book"].get("root").is_none(), "{proj_b}");
    // The tab on the trashed 构想 is left out of the template: a tab is
    // called by what it shows and is never remounted (`kernel-v5.md` §5,
    // 2026-11-15), so the new book has one tab fewer and every tab shows
    // something.
    let tabs_a = e.out("project.get", json!({"book": a}))["tabs"]
        .as_array()
        .unwrap()
        .len();
    let tabs_b = proj_b["tabs"].as_array().unwrap();
    assert_eq!(tabs_b.len(), tabs_a - 1, "{proj_b}");
    assert!(tabs_b.iter().all(|t| t["mount_valid"] == true), "{proj_b}");
}

#[test]
fn deleted_prose_history_never_leaks_source_is_untouched_and_nothing_is_derived() {
    // 1. Create a project from an external community template value with author attribution.
    let e = env();
    let base_val = dr_doc::v3::novel_project_template_value();
    let mut community_val = base_val.clone();
    community_val.name = "古典悬疑".into();
    community_val.credit = Some(dr_model::project_template::ProjectTemplateCredit {
        author: "苏木".into(),
    });

    let a = e.out(
        "project.create",
        json!({
            "name": "悬疑草稿",
            "template": community_val,
            "source": {
                "id": "community:classic-mystery",
                "version": 2,
                "origin": "community",
                "name": "古典悬疑",
                "credit": {
                    "author": "苏木"
                }
            }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let entries_a = e
        .out("entry.list", json!({"book": a, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    let ms_a = find_entry_by_title(&entries_a, "书稿")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch_a = e.out(
        "entry.create",
        json!({
            "book": a,
            "parent": ms_a,
            "template": "tpl-chapter",
            "title": "序章"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let secret = "SECRET_DRAFT_DELETED_BEFORE_SAVE_42";
    let body_doc_id = format!("body:{ch_a}/mod-prose");
    {
        let sess = e.ws().prose_session(&body_doc_id).unwrap();
        sess.edit(|txn| {
            txn.insert_text(0, secret)?;
            Ok(())
        })
        .unwrap();
        sess.edit(|txn| {
            txn.delete(0..secret.chars().count())?;
            txn.insert_text(0, "留下的公开示例文字。")?;
            Ok(())
        })
        .unwrap();
    }

    // Confirm Loro oplog of the source chapter still holds `secret` in its history.
    let raw_body_bytes = e
        .ws()
        .library()
        .load_copy(&body_doc_id)
        .unwrap()
        .export(ExportMode::all_updates())
        .unwrap();
    assert!(
        String::from_utf8_lossy(&raw_body_bytes).contains(secret),
        "precondition: deleted text is still in source Loro history"
    );

    // Observe `book:<a>` before `project_template.save` to verify zero mutation of source project.
    let before_book = e.ws().observe(&format!("book:{a}")).unwrap();

    let saved = e.out(
        "project_template.save",
        json!({
            "book": a,
            "name": "我的悬疑改版",
            "sample_entries": [ch_a]
        }),
    );
    let tpl_id = saved["id"].as_str().unwrap().to_owned();

    // Source book's frontier, deep value, and `project.source` are completely untouched!
    let after_book = e.ws().observe(&format!("book:{a}")).unwrap();
    assert_eq!(after_book.version, before_book.version);
    assert_eq!(after_book.value, before_book.value);

    // Neither the JSON value nor the raw Loro bytes of `project-template:<id>` contain `secret`.
    let tpl_doc_id = format!("project-template:{tpl_id}");
    let raw_tpl_bytes = e
        .ws()
        .library()
        .load_copy(&tpl_doc_id)
        .unwrap()
        .export(ExportMode::all_updates())
        .unwrap();
    assert!(
        !String::from_utf8_lossy(&raw_tpl_bytes).contains(secret),
        "deleted prose history must never leak into saved template doc"
    );
    let got = e.out("project_template.get", json!({"id": tpl_id}));
    let got_str = serde_json::to_string(&got).unwrap();
    assert!(!got_str.contains(secret));
    assert!(got_str.contains("留下的公开示例文字。"));

    // Nothing is filled in from `project.source` (no 「改自」 since
    // 2026-11-15 night): the template saved here carries no credit.
    assert!(got["value"].get("credit").is_none(), "{}", got["value"]);
}

#[test]
fn project_create_rolls_back_all_documents_on_midway_failure() {
    let mut e = env();
    let src_book = e.book();
    e.call(
        "module.set_prose",
        json!({
            "book": src_book,
            "owner": "tpl-chapter",
            "module": "mod-prose",
            "template": true,
            "paragraphs": [{"text": "模板初值"}]
        }),
    );
    let entries = e
        .out("entry.list", json!({"book": src_book, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    let ms = find_entry_by_title(&entries, "书稿")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch = e.out(
        "entry.create",
        json!({
            "book": src_book,
            "parent": ms,
            "template": "tpl-chapter",
            "title": "样章",
            "bodies": {"mod-prose": "样章正文"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let tpl_id = e.out(
        "project_template.save",
        json!({
            "book": src_book,
            "name": "回滚测试模板",
            "sample_entries": [ch]
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Trash & purge `src_book` + forget its purge tombstones so ONLY `project-template:<tpl_id>` exists.
    e.call("book.trash", json!({"book": src_book}));
    e.call("book.purge", json!({"book": src_book}));
    e.ws().library().forget_purged_book(&src_book).unwrap();

    let baseline_docs: Vec<String> = e
        .ws()
        .library()
        .docs(None, None)
        .unwrap()
        .into_iter()
        .map(|d| d.doc_id)
        .collect();
    assert_eq!(baseline_docs, vec![format!("project-template:{tpl_id}")]);
    assert!(e.ws().library().purged_docs(None).unwrap().is_empty());

    for point in ["after_prose", "after_side", "in_book"] {
        e.faults.arm(point);
        let res = e.try_call(
            "project.create",
            json!({
                "name": format!("失败于-{point}"),
                "template_id": tpl_id
            }),
        );
        assert!(res.is_err(), "expected failure at fault point {point}");

        let now_docs: Vec<String> = e
            .ws()
            .library()
            .docs(None, None)
            .unwrap()
            .into_iter()
            .map(|d| d.doc_id)
            .collect();
        assert_eq!(
            now_docs, baseline_docs,
            "leftover docs after {point} rollback: {now_docs:?}"
        );
        assert!(
            e.ws().library().purged_docs(None).unwrap().is_empty(),
            "rollback after {point} must forget purge tombstones"
        );
    }

    e.reopen();
    assert_eq!(e.out("book.list", json!({"trashed": true})), json!([]));
    let ok_book = e.out(
        "project.create",
        json!({"name": "故障解除后成功新建", "template_id": tpl_id}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(e.out("book.list", json!({}))[0]["id"], json!(ok_book));
}

#[test]
fn saved_template_docs_do_not_interfere_with_books_words_search_events_or_guards() {
    let e = env();
    let seen_events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let seen_clone = seen_events.clone();
    let _sub = e.ws().subscribe(move |ev| {
        if matches!(
            ev,
            WsEvent::Prose(p) if p.doc.to_string().starts_with("project-template:")
        ) {
            seen_clone.lock().unwrap().push(format!("{ev:?}"));
        }
    });
    let live_book = e.out("project.create", json!({"name": "在写项目"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Create a temporary project with unique text, save it as a template, then purge the temporary project.
    let tmp_book = e.out("project.create", json!({"name": "临时来源"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let tmp_entries = e
        .out("entry.list", json!({"book": tmp_book, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    let tmp_ms = find_entry_by_title(&tmp_entries, "书稿")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let phrase = "UNIQUE_TEMPLATE_ONLY_PHRASE_98765";
    let tmp_ch = e.out(
        "entry.create",
        json!({
            "book": tmp_book,
            "parent": tmp_ms,
            "template": "tpl-chapter",
            "title": "唯一词句章",
            "bodies": {"mod-prose": phrase}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    seen_events.lock().unwrap().clear();

    let tpl_id = e.out(
        "project_template.save",
        json!({
            "book": tmp_book,
            "name": "独立性校验模板",
            "sample_entries": [tmp_ch]
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.call(
        "project_template.update",
        json!({"id": tpl_id, "description": phrase}),
    );

    // Zero `WsEvent::Prose` emitted for `project-template:<id>`.
    let template_events = seen_events.lock().unwrap().clone();
    assert!(
        template_events.is_empty(),
        "project-template docs must never emit Prose events: {template_events:?}"
    );

    // Purge `tmp_book` so `phrase` lives ONLY inside `project-template:<tpl_id>`.
    e.call("book.trash", json!({"book": tmp_book}));
    e.call("book.purge", json!({"book": tmp_book}));

    let tpl_doc_id = format!("project-template:{tpl_id}");
    let info = e.ws().library().doc_info(&tpl_doc_id).unwrap().unwrap();
    assert_eq!(info.kind, "project-template");
    assert_eq!(info.book_id, None);
    assert!(
        e.ws()
            .library()
            .docs(Some(&live_book), None)
            .unwrap()
            .iter()
            .all(|d| d.doc_id != tpl_doc_id)
    );

    // Shelf word count for `live_book` is 0; full-text search finds 0 hits for `phrase`.
    let shelf = e.out("book.shelf", json!({}));
    assert_eq!(shelf.as_array().unwrap().len(), 1);
    assert_eq!(shelf[0]["id"], live_book);
    assert_eq!(shelf[0]["words"], 0);
    assert!(
        e.ws()
            .library()
            .search(None, phrase, 10)
            .unwrap()
            .is_empty(),
        "project-template docs must never enter text search index"
    );
    assert!(
        e.ws()
            .library()
            .search_entry_modules(None, None, None, phrase, 10)
            .unwrap()
            .is_empty()
    );

    // Book write guards on `live_book` observed BEFORE `project_template.update` remain valid!
    let obs = e.ws().observe(&format!("book:{live_book}")).unwrap();
    e.call(
        "project_template.update",
        json!({"id": tpl_id, "name": "再改一次模板名"}),
    );
    let actor = Actor::agent("guard-check", 1, "fact");
    e.ws()
        .call_guarded(
            &actor,
            "fact.put",
            json!({"book": live_book, "key": "节气", "value": "立冬"}),
            WritePreconditions::from_observations([obs]),
        )
        .unwrap();
}

fn sync_templates(from: &Env, to: &Env) {
    for d in from
        .ws()
        .library()
        .docs(None, Some("project-template"))
        .unwrap()
    {
        if from.ws().library().head(&d.doc_id).unwrap().is_none() {
            continue;
        }
        let bytes = from
            .ws()
            .library()
            .load_copy(&d.doc_id)
            .unwrap()
            .export(ExportMode::all_updates())
            .unwrap();
        to.ws()
            .import_remote(
                &d.doc_id,
                Some(("project-template", "")),
                bytes,
                &Actor::Sync,
            )
            .unwrap();
    }
    for p in from.ws().library().purged_docs(None).unwrap() {
        if p.doc_id.starts_with("project-template:") {
            to.ws().release_idle_doc_for_remote_purge(&p.doc_id);
            let _ = to.ws().library().purge_doc(&p.doc_id);
        }
    }
}

#[test]
fn two_devices_sync_saved_template_lww_replace_and_purge() {
    let dev_a = env();
    let dev_b = env();

    let book_a = dev_a.book();
    let saved = dev_a.out(
        "project_template.save",
        json!({
            "book": book_a,
            "name": "同步模板初版",
            "description": "设备甲创建"
        }),
    );
    let tpl_id = saved["id"].as_str().unwrap().to_owned();
    let tpl_doc_id = format!("project-template:{tpl_id}");

    // 1. Sync initial template from A to B; B lists it and creates a project from it.
    sync_templates(&dev_a, &dev_b);
    let list_b = dev_b.out("project_template.list", json!({}));
    assert_eq!(list_b.as_array().unwrap().len(), 1);
    assert_eq!(list_b[0]["id"], tpl_id);
    assert_eq!(list_b[0]["name"], "同步模板初版");

    let created_on_b = dev_b.out(
        "project.create",
        json!({"name": "设备乙从同步模板新建", "template_id": tpl_id}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        dev_b.out("project.get", json!({"book": created_on_b}))["source"]["id"],
        json!(tpl_id)
    );

    // 2. Concurrent offline `replace` on both devices:
    //    - A saves 2 sample chapters ("甲章一", "甲章二")
    //    - B sleeps briefly and saves 1 sample chapter ("乙唯一章") -> B has the later timestamp!
    let entries_a = dev_a
        .out("entry.list", json!({"book": book_a, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    let ms_a = find_entry_by_title(&entries_a, "书稿")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let a_c1 = dev_a.out(
        "entry.create",
        json!({"book": book_a, "parent": ms_a, "template": "tpl-chapter", "title": "甲章一"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let a_c2 = dev_a.out(
        "entry.create",
        json!({"book": book_a, "parent": ms_a, "template": "tpl-chapter", "title": "甲章二"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    dev_a.call(
        "project_template.save",
        json!({
            "book": book_a,
            "name": "甲重存版",
            "sample_entries": [a_c1, a_c2],
            "replace": tpl_id
        }),
    );

    thread::sleep(Duration::from_millis(10));

    let entries_b = dev_b
        .out("entry.list", json!({"book": created_on_b, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    let ms_b = find_entry_by_title(&entries_b, "书稿")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let b_only = dev_b.out(
        "entry.create",
        json!({"book": created_on_b, "parent": ms_b, "template": "tpl-chapter", "title": "乙唯一章"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    dev_b.call(
        "project_template.save",
        json!({
            "book": created_on_b,
            "name": "乙后写版",
            "sample_entries": [b_only],
            "replace": tpl_id
        }),
    );

    // Sync both ways after concurrent offline replaces: whole-payload LWW keeps ONE complete
    // version identically across both devices (never half-merging entries from A and B!).
    sync_templates(&dev_a, &dev_b);
    sync_templates(&dev_b, &dev_a);

    let got_a = dev_a.out("project_template.get", json!({"id": tpl_id}));
    let got_b = dev_b.out("project_template.get", json!({"id": tpl_id}));
    assert_eq!(got_a["value"], got_b["value"]);
    let concurrent_titles: Vec<&str> = got_a["value"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["title"].as_str().unwrap())
        .collect();
    let a_won = got_a["value"]["name"] == "甲重存版";
    let b_won = got_a["value"]["name"] == "乙后写版";
    assert!(
        a_won ^ b_won,
        "exactly one complete version must win: {got_a:#?}"
    );
    if a_won {
        assert!(
            concurrent_titles.contains(&"甲章一")
                && concurrent_titles.contains(&"甲章二")
                && !concurrent_titles.contains(&"乙唯一章"),
            "whole-payload LWW must never half-merge: {concurrent_titles:?}"
        );
    } else {
        assert!(
            concurrent_titles.contains(&"乙唯一章")
                && !concurrent_titles.contains(&"甲章一")
                && !concurrent_titles.contains(&"甲章二"),
            "whole-payload LWW must never half-merge: {concurrent_titles:?}"
        );
    }

    // Now a subsequent causal `replace` on B strictly supersedes the converged version on both devices!
    dev_b.call(
        "project_template.save",
        json!({
            "book": created_on_b,
            "name": "乙因果后写版",
            "sample_entries": [b_only],
            "replace": tpl_id
        }),
    );
    sync_templates(&dev_b, &dev_a);
    let got_after_b = dev_a.out("project_template.get", json!({"id": tpl_id}));
    assert_eq!(got_after_b["value"]["name"], "乙因果后写版");
    let titles_after_b: Vec<&str> = got_after_b["value"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["title"].as_str().unwrap())
        .collect();
    assert!(titles_after_b.contains(&"乙唯一章"));
    assert!(
        !titles_after_b.contains(&"甲章一") && !titles_after_b.contains(&"甲章二"),
        "later causal replace replaces the whole template: {titles_after_b:?}"
    );

    // 3. `project_template.update` touches ONLY `info` (`raw_payload` stays byte-identical) and syncs.
    let pt_parsed = ProjectTemplateDocId::parse(&tpl_id).unwrap();
    let raw_before_rename = {
        let copy = dev_a.ws().library().load_copy(&tpl_doc_id).unwrap();
        let b = BorrowedProjectTemplate::new(&copy, &pt_parsed).unwrap();
        b.view().raw_payload().unwrap()
    };
    dev_a.call(
        "project_template.update",
        json!({"id": tpl_id, "name": "只改名字不碰载荷"}),
    );
    let raw_after_rename = {
        let copy = dev_a.ws().library().load_copy(&tpl_doc_id).unwrap();
        let b = BorrowedProjectTemplate::new(&copy, &pt_parsed).unwrap();
        b.view().raw_payload().unwrap()
    };
    assert_eq!(
        raw_after_rename, raw_before_rename,
        "project_template.update must touch only info, leaving payload.value untouched"
    );
    sync_templates(&dev_a, &dev_b);
    assert_eq!(
        dev_b.out("project_template.get", json!({"id": tpl_id}))["value"]["name"],
        "只改名字不碰载荷"
    );

    // 4. `project_template.remove` on A records purge tombstone, syncs deletion to B, and blocks stale re-import!
    let stale_bytes = dev_b
        .ws()
        .library()
        .load_copy(&tpl_doc_id)
        .unwrap()
        .export(ExportMode::all_updates())
        .unwrap();
    dev_a.call("project_template.remove", json!({"id": tpl_id}));
    sync_templates(&dev_a, &dev_b);
    assert_eq!(dev_a.out("project_template.list", json!({})), json!([]));
    assert_eq!(dev_b.out("project_template.list", json!({})), json!([]));
    assert!(
        !dev_b
            .ws()
            .import_remote(
                &tpl_doc_id,
                Some(("project-template", "")),
                stale_bytes,
                &Actor::Sync
            )
            .unwrap(),
        "purged project-template must not resurrect from stale sync bytes"
    );

    // Canonical serialization determinism check on the built-in value as well.
    let c1 = to_canonical_json(&dr_doc::v3::novel_project_template_value()).unwrap();
    let c2 = to_canonical_json(&dr_doc::v3::novel_project_template_value()).unwrap();
    assert_eq!(c1, c2);
}

#[test]
fn project_template_export_and_import_commands_round_trip_and_reject_invalid_files() {
    let e = env();
    let dir = tempfile::tempdir().unwrap();
    let b = e.book();
    let saved = e.out(
        "project_template.save",
        json!({"book": b, "name": "导出导入模板", "description": "工作区命令核验"}),
    );
    let tpl_id = saved["id"].as_str().unwrap().to_owned();

    // Export with explicit author twice -> byte-identical, library copy unchanged.
    let p1 = dir.path().join("a.driftingtemplate");
    let p2 = dir.path().join("b.driftingtemplate");
    let p_anon = dir.path().join("anon.driftingtemplate");
    e.out(
        "project_template.export",
        json!({"id": tpl_id, "path": p1, "author": "南枝"}),
    );
    e.out(
        "project_template.export",
        json!({"id": tpl_id, "path": p2, "author": "南枝"}),
    );
    e.out(
        "project_template.export",
        json!({"id": tpl_id, "path": p_anon}),
    );

    // Agent actor is refused on both commands even when template/file exists.
    let agent = Actor::Agent {
        session: "s1".into(),
        turn: 1,
        call: "c1".into(),
    };
    assert!(
        e.ws()
            .call(
                &agent,
                "project_template.export",
                json!({"id": tpl_id, "path": dir.path().join("no.driftingtemplate")}),
            )
            .is_err()
    );
    assert!(!dir.path().join("no.driftingtemplate").exists());
    assert!(
        e.ws()
            .call(&agent, "project_template.import", json!({"path": p1}))
            .is_err()
    );
    assert_eq!(std::fs::read(&p1).unwrap(), std::fs::read(&p2).unwrap());
    let v1: Value = serde_json::from_slice(&std::fs::read(&p1).unwrap()).unwrap();
    assert_eq!(v1["credit"], json!({"author": "南枝"}));
    let v_anon: Value = serde_json::from_slice(&std::fs::read(&p_anon).unwrap()).unwrap();
    assert!(v_anon.get("credit").is_none());
    assert!(
        e.out("project_template.get", json!({"id": tpl_id}))["value"]
            .get("credit")
            .is_none()
    );

    // Import twice -> two new templates with `origin = "file"`, zero new books.
    let books_before = e.out("book.list", json!({}));
    let imp_a = e.out("project_template.import", json!({"path": p1}));
    let imp_b = e.out("project_template.import", json!({"path": p1}));
    assert_eq!(imp_a["origin"], "file");
    assert_eq!(imp_b["origin"], "file");
    assert_ne!(imp_a["id"], imp_b["id"]);
    assert_ne!(imp_a["id"], tpl_id);
    assert_eq!(e.out("book.list", json!({})), books_before);

    // Re-exporting someone else's template replaces attribution with exporter's name.
    let p_re = dir.path().join("re.driftingtemplate");
    e.out(
        "project_template.export",
        json!({"id": imp_a["id"], "path": p_re, "author": "林岬"}),
    );
    let re_text = std::fs::read_to_string(&p_re).unwrap();
    assert!(!re_text.contains("南枝"));
    assert_eq!(
        serde_json::from_str::<Value>(&re_text).unwrap()["credit"],
        json!({"author": "林岬"})
    );

    // Invalid file (`derivedFrom`) is rejected without writing anything.
    let docs_before = e.ws().library().docs(None, None).unwrap().len();
    let mut bad = v1;
    bad["credit"] = json!({"author": "南枝", "derivedFrom": {"name": "旧"}});
    let p_bad = dir.path().join("bad.driftingtemplate");
    std::fs::write(&p_bad, serde_json::to_vec(&bad).unwrap()).unwrap();
    assert!(
        e.ws()
            .call(
                &Actor::User,
                "project_template.import",
                json!({"path": p_bad})
            )
            .is_err()
    );
    assert_eq!(
        e.ws().library().docs(None, None).unwrap().len(),
        docs_before
    );
}
