//! `.driftingtemplate` file export, import, attribution, and rejection
//! contracts (`docs/rust-rewrite/project-templates.md` §6, §9, §11, §15 PT2;
//! `docs/rust-rewrite/handoff/v5-tracks.md` PT2).

use dr_export::template_file::{self, MAX_BYTES, TemplateFileError};
use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use serde_json::{Value, json};

struct Env {
    dir: tempfile::TempDir,
    ws: Workspace,
}

impl Drop for Env {
    fn drop(&mut self) {
        self.ws.close();
    }
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("library"), library_options("0.2.0-test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    Env { dir, ws }
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn find_entry_by_title(entries: &[Value], title: &str) -> Value {
    entries
        .iter()
        .find(|e| e["title"] == title)
        .unwrap_or_else(|| panic!("missing entry titled {title:?}"))
        .clone()
}

fn build_rich_book(ws: &Workspace) -> (String, Vec<String>, Vec<String>) {
    let book = out(ws, "project.create", json!({"name": "雾港推理"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        ws,
        "project.update",
        json!({
            "book": book,
            "word_target": 180000,
            "daily_word_target": 2500
        }),
    );
    out(
        ws,
        "entry_relation_type.put",
        json!({
            "book": book,
            "definition": {
                "id": "rt-witnessed",
                "name": "目击",
                "description": "目击关系",
                "orientation": "directed",
                "source_role": "目击者",
                "target_role": "被目击者",
                "source_kinds": ["entry"],
                "target_kinds": ["entry"],
                "source_templates": [],
                "target_templates": []
            }
        }),
    );

    let entries = out(ws, "entry.list", json!({"book": book, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    let ms = find_entry_by_title(&entries, "书稿")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let chars = find_entry_by_title(&entries, "人物")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let sl_folder = find_entry_by_title(&entries, "故事线")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let view = out(ws, "timeline_view.list", json!({"book": book}))[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let sub_line = out(
        ws,
        "entry.create",
        json!({
            "book": book,
            "parent": sl_folder,
            "template": "tpl-storyline",
            "title": "雾夜暗线",
            "level": false
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        ws,
        "module.set_field",
        json!({
            "book": book,
            "entry": sub_line,
            "module": "mod-fields",
            "field": "color",
            "value": "#355070"
        }),
    );
    out(
        ws,
        "timeline_view.add_lane",
        json!({"book": book, "view": view, "lane": sub_line}),
    );
    out(
        ws,
        "timeline_view.put_pin",
        json!({
            "book": book,
            "view": view,
            "pin": {
                "id": "pin-bell",
                "at": 10.0,
                "label": "停钟时刻",
                "entry": null
            }
        }),
    );

    let detective = out(
        ws,
        "entry.create",
        json!({
            "book": book,
            "parent": chars,
            "template": "tpl-character",
            "title": "沈渡",
            "bodies": {"mod-prose": "守钟人，左耳失聪。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ch1 = out(
        ws,
        "entry.create",
        json!({
            "book": book,
            "parent": ms,
            "template": "tpl-chapter",
            "title": "第一夜",
            "bodies": {"mod-prose": "雾从北码头漫上钟楼。\n\n钟摆停在十一点。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        ws,
        "timeline_view.place",
        json!({
            "book": book,
            "view": view,
            "entry": ch1,
            "lane": sub_line,
            "at": 10.0,
            "span": 2.0
        }),
    );
    out(
        ws,
        "membership.primary",
        json!({"book": book, "member": ch1, "host": sub_line}),
    );

    (book, vec![detective, ch1], vec![view])
}

#[test]
fn rich_template_file_round_trips_and_repeated_exports_are_byte_identical() {
    let e = env();
    let (book, samples, views) = build_rich_book(&e.ws);
    let saved = out(
        &e.ws,
        "project_template.save",
        json!({
            "book": book,
            "name": "雾港推理长篇",
            "description": "带暗线泳道、时间钉和示例人物",
            "sample_entries": samples,
            "view_pins": views,
            "agent": {
                "name": "推理编辑",
                "description": "核对不在场证明与时间线",
                "instructions": "每次改动核对停钟时刻。"
            }
        }),
    );
    let orig_id = saved["id"].as_str().unwrap().to_owned();
    assert_eq!(saved["origin"], "own");

    assert_eq!(
        template_file::template_filename("雾港/推理:长篇"),
        "雾港-推理-长篇.driftingtemplate"
    );
    assert_eq!(
        template_file::template_name(&e.ws, &orig_id).unwrap(),
        "雾港推理长篇"
    );

    // Export twice via `dr_export` and once via `project_template.export`:
    // all three files must be byte-for-byte identical UTF-8 JSON.
    let path_a = e.dir.path().join("a.driftingtemplate");
    let path_b = e.dir.path().join("b.driftingtemplate");
    let path_cmd = e.dir.path().join("cmd.driftingtemplate");

    let sum_a = template_file::export_template(&e.ws, &orig_id, Some("林岬"), &path_a).unwrap();
    let sum_b = template_file::export_template(&e.ws, &orig_id, Some("林岬"), &path_b).unwrap();
    let cmd_out = out(
        &e.ws,
        "project_template.export",
        json!({
            "id": orig_id,
            "path": path_cmd.to_str().unwrap(),
            "author": "林岬"
        }),
    );

    let bytes_a = std::fs::read(&path_a).unwrap();
    let bytes_b = std::fs::read(&path_b).unwrap();
    let bytes_cmd = std::fs::read(&path_cmd).unwrap();
    assert_eq!(bytes_a, bytes_b, "repeated exports must be byte-identical");
    assert_eq!(bytes_a, bytes_cmd, "command export must match dr-export");
    assert_eq!(sum_a, sum_b);
    assert_eq!(sum_a.bytes, bytes_a.len() as u64);
    assert_eq!(cmd_out["bytes"], bytes_a.len() as u64);

    let raw_text = std::str::from_utf8(&bytes_a).unwrap();
    assert!(raw_text.ends_with('\n'));
    assert!(!raw_text.contains("\"homepage\""));
    assert!(!raw_text.contains("\"derivedFrom\""));
    let exported_json: Value = serde_json::from_str(raw_text).unwrap();
    assert!(exported_json["project"]["book"].get("root").is_none());
    assert_eq!(exported_json["credit"], json!({"author": "林岬"}));

    // Importing the same file twice always creates two distinct templates
    // (`origin = "file"`) and NEVER creates a project/book.
    let books_before = out(&e.ws, "book.list", json!({}));
    let imp_1 = template_file::import_template(&e.ws, &path_a).unwrap();
    let imp_2: Value = out(
        &e.ws,
        "project_template.import",
        json!({"path": path_a.to_str().unwrap()}),
    );
    let imp_2_id = imp_2["id"].as_str().unwrap().to_owned();

    assert_ne!(imp_1.id, orig_id);
    assert_ne!(imp_2_id, orig_id);
    assert_ne!(imp_1.id, imp_2_id);
    assert_eq!(imp_1.origin, "file");
    assert_eq!(imp_2["origin"], "file");
    assert_eq!(
        out(&e.ws, "book.list", json!({})),
        books_before,
        "importing a .driftingtemplate must never create a project"
    );

    let list = out(&e.ws, "project_template.list", json!({}));
    assert_eq!(list.as_array().unwrap().len(), 3);

    let got_1 = out(&e.ws, "project_template.get", json!({"id": imp_1.id}));
    let got_2 = out(&e.ws, "project_template.get", json!({"id": imp_2_id}));
    assert_eq!(got_1["value"], exported_json);
    assert_eq!(got_2["value"], exported_json);

    // Creating a project from the imported template reproduces the rich setup.
    let created = out(
        &e.ws,
        "project.create",
        json!({"name": "新案", "template_id": imp_1.id}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let proj = out(&e.ws, "project.get", json!({"book": created}));
    assert_eq!(
        proj["source"],
        json!({
            "id": imp_1.id,
            "version": 1,
            "origin": "file",
            "name": "雾港推理长篇",
            "credit": {"author": "林岬"}
        })
    );
    assert_eq!(proj["book"]["word_target"], 180000);
    assert_eq!(proj["book"]["daily_word_target"], 2500);
    assert!(proj["book"].get("root").is_none());
    assert_eq!(proj["agent"]["name"], "推理编辑");

    let new_entries = out(&e.ws, "entry.list", json!({"book": created, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    assert!(new_entries.iter().any(|x| x["title"] == "沈渡"));
    assert!(new_entries.iter().any(|x| x["title"] == "第一夜"));
    assert!(new_entries.iter().any(|x| x["title"] == "雾夜暗线"));
    let new_views = out(&e.ws, "timeline_view.list", json!({"book": created}));
    let pins = &new_views[0]["pins"];
    assert_eq!(pins.as_array().unwrap().len(), 1);
    assert_eq!(pins[0]["label"], "停钟时刻");
    let rts = out(&e.ws, "entry_relation_type.list", json!({"book": created}));
    assert!(
        rts.as_array()
            .unwrap()
            .iter()
            .any(|rt| rt["name"] == "目击" && rt["source_role"] == "目击者")
    );
}

#[test]
fn attribution_follows_exporter_display_name_and_never_carries_upstream_or_derived_from() {
    let e = env();
    let book = out(&e.ws, "project.create", json!({"name": "初稿"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let own_id = out(
        &e.ws,
        "project_template.save",
        json!({"book": book, "name": "极简模板"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // 1. Signed out (`None`) or blank profile name (`Some("   ")`): no `credit` at all.
    for (idx, author) in [(0, None), (1, Some("")), (2, Some("   "))] {
        let p = e.dir.path().join(format!("anon-{idx}.driftingtemplate"));
        template_file::export_template(&e.ws, &own_id, author, &p).unwrap();
        let v: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        assert!(
            v.get("credit").is_none(),
            "expected no credit for {author:?}, got {v}"
        );
    }

    // 2. Signed in with explicit display name: writes `credit.author` in the
    // exported file without mutating the library copy (`own_id` still has no credit).
    let nanzhi_file = e.dir.path().join("nanzhi.driftingtemplate");
    template_file::export_template(&e.ws, &own_id, Some("  南枝  "), &nanzhi_file).unwrap();
    let nanzhi_json: Value = serde_json::from_slice(&std::fs::read(&nanzhi_file).unwrap()).unwrap();
    assert_eq!(nanzhi_json["credit"], json!({"author": "南枝"}));
    assert!(
        out(&e.ws, "project_template.get", json!({"id": own_id}))["value"]
            .get("credit")
            .is_none(),
        "exporting must never mutate the stored template in the library"
    );

    // 3. Import someone else's template ("南枝"), then re-export it:
    //    - signed in as "林岬" (unedited): `credit` is `{"author": "林岬"}`, never mentioning "南枝";
    //    - signed out (unedited): `credit` is omitted;
    //    - edited in working copy, then exported as "林岬": still `{"author": "林岬"}` only.
    let imported = template_file::import_template(&e.ws, &nanzhi_file).unwrap();
    assert_eq!(
        imported.credit.as_ref().map(|c| c.author.as_str()),
        Some("南枝")
    );

    let reexport_linjia = e.dir.path().join("reexport-linjia.driftingtemplate");
    template_file::export_template(&e.ws, &imported.id, Some("林岬"), &reexport_linjia).unwrap();
    let reexport_text = std::fs::read_to_string(&reexport_linjia).unwrap();
    assert!(!reexport_text.contains("南枝"));
    assert!(!reexport_text.contains("derivedFrom"));
    let reexport_val: Value = serde_json::from_str(&reexport_text).unwrap();
    assert_eq!(reexport_val["credit"], json!({"author": "林岬"}));

    let reexport_anon = e.dir.path().join("reexport-anon.driftingtemplate");
    template_file::export_template(&e.ws, &imported.id, None, &reexport_anon).unwrap();
    let reexport_anon_val: Value =
        serde_json::from_slice(&std::fs::read(&reexport_anon).unwrap()).unwrap();
    assert!(reexport_anon_val.get("credit").is_none());

    // Stored library record still preserves upstream author "南枝".
    assert_eq!(
        out(&e.ws, "project_template.get", json!({"id": imported.id}))["value"]["credit"],
        json!({"author": "南枝"})
    );

    // Edit "南枝"'s template through its working copy, save, and export as "林岬".
    let wc = out(&e.ws, "project_template.edit", json!({"id": imported.id}))["book"]
        .as_str()
        .unwrap()
        .to_owned();
    let wc_entries = out(&e.ws, "entry.list", json!({"book": wc, "all": true}))
        .as_array()
        .unwrap()
        .clone();
    let wc_ms = find_entry_by_title(&wc_entries, "书稿")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        "entry.create",
        json!({
            "book": wc,
            "parent": wc_ms,
            "template": "tpl-chapter",
            "title": "林岬增补章"
        }),
    );
    out(&e.ws, "project_template.save", json!({"book": wc}));

    let edited_export = e.dir.path().join("edited-linjia.driftingtemplate");
    template_file::export_template(&e.ws, &imported.id, Some("林岬"), &edited_export).unwrap();
    let edited_text = std::fs::read_to_string(&edited_export).unwrap();
    assert!(!edited_text.contains("南枝"));
    assert!(!edited_text.contains("derivedFrom"));
    let edited_val: Value = serde_json::from_str(&edited_text).unwrap();
    assert_eq!(edited_val["credit"], json!({"author": "林岬"}));

    // 4. Creating a project from "南枝"'s template and saving a new template from
    // that project does NOT auto-fill `credit` or `derivedFrom`.
    let child_book = out(
        &e.ws,
        "project.create",
        json!({"name": "从南枝模板建的书", "template_id": imported.id}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let derived_saved = out(
        &e.ws,
        "project_template.save",
        json!({"book": child_book, "name": "我自己的新模板"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let derived_got = out(&e.ws, "project_template.get", json!({"id": derived_saved}));
    assert!(derived_got["summary"].get("credit").is_none());
    assert!(derived_got["value"].get("credit").is_none());
    assert!(derived_got["value"].get("derivedFrom").is_none());
}

#[test]
fn invalid_template_files_are_rejected_without_writing_anything() {
    let e = env();
    let book = out(&e.ws, "project.create", json!({"name": "基线书"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let tpl_id = out(
        &e.ws,
        "project_template.save",
        json!({"book": book, "name": "基线模板"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let valid_path = e.dir.path().join("valid.driftingtemplate");
    template_file::export_template(&e.ws, &tpl_id, Some("林岬"), &valid_path).unwrap();
    let base: Value = serde_json::from_slice(&std::fs::read(&valid_path).unwrap()).unwrap();

    let docs_before: Vec<_> =
        e.ws.library()
            .docs(None, None)
            .unwrap()
            .into_iter()
            .map(|d| d.doc_id)
            .collect();
    let templates_before = out(&e.ws, "project_template.list", json!({}));
    let books_before = out(&e.ws, "book.list", json!({}));

    let write_case = |name: &str, bytes: &[u8]| {
        let p = e.dir.path().join(format!("{name}.driftingtemplate"));
        std::fs::write(&p, bytes).unwrap();
        p
    };

    // 1. Oversized raw file (> 2 MiB) and oversized valid JSON (> 2 MiB).
    let raw_huge = write_case("raw-huge", &vec![b' '; (MAX_BYTES as usize) + 1]);
    assert!(matches!(
        template_file::import_template(&e.ws, &raw_huge),
        Err(TemplateFileError::TooLarge)
    ));
    let mut json_huge = base.clone();
    json_huge["project"]["agent"] = json!({
        "name": "a",
        "description": "b",
        "instructions": "x".repeat((MAX_BYTES as usize) + 64)
    });
    let json_huge_path = write_case(
        "json-huge",
        serde_json::to_string(&json_huge).unwrap().as_bytes(),
    );
    assert!(matches!(
        template_file::import_template(&e.ws, &json_huge_path),
        Err(TemplateFileError::TooLarge)
    ));

    // 2. Newer `formatVersion` (2) -> `Newer`; invalid `formatVersion` (0, -1) -> `Damaged`.
    let mut newer = base.clone();
    newer["formatVersion"] = json!(2);
    let newer_path = write_case("newer", serde_json::to_string(&newer).unwrap().as_bytes());
    assert!(matches!(
        template_file::import_template(&e.ws, &newer_path),
        Err(TemplateFileError::Newer)
    ));
    for bad_ver in [0, -1] {
        let mut v = base.clone();
        v["formatVersion"] = json!(bad_ver);
        let p = write_case(
            &format!("ver-{bad_ver}"),
            serde_json::to_string(&v).unwrap().as_bytes(),
        );
        assert!(matches!(
            template_file::import_template(&e.ws, &p),
            Err(TemplateFileError::Damaged(_))
        ));
    }

    // 3. Unknown top-level key, `project.book.root`, `credit.homepage`, `credit.derivedFrom`.
    let mut unknown_top = base.clone();
    unknown_top["extraKey"] = json!(true);
    let mut with_book_root = base.clone();
    with_book_root["project"]["book"]["root"] = json!("e1");
    let mut with_homepage = base.clone();
    with_homepage["credit"] = json!({"author": "林岬", "homepage": "https://example.com"});
    let mut with_derived_from = base.clone();
    with_derived_from["credit"] = json!({
        "author": "林岬",
        "derivedFrom": {"name": "旧版"}
    });
    let mut top_derived_from = base.clone();
    top_derived_from["derivedFrom"] = json!({"name": "旧版"});

    for (name, val) in [
        ("unknown-top", unknown_top),
        ("book-root", with_book_root),
        ("credit-homepage", with_homepage),
        ("credit-derived-from", with_derived_from),
        ("top-derived-from", top_derived_from),
    ] {
        let p = write_case(name, serde_json::to_string(&val).unwrap().as_bytes());
        let res = template_file::import_template(&e.ws, &p);
        assert!(
            matches!(res, Err(TemplateFileError::Damaged(_))),
            "{name} expected Damaged, got {res:?}"
        );
        assert!(
            e.ws.call(
                &Actor::User,
                "project_template.import",
                json!({"path": p.to_str().unwrap()})
            )
            .is_err(),
            "{name} must also fail via project_template.import"
        );
    }

    // 4. Unresolvable symbolic references (`e99` in tab mount, `e99` in entry parent, `v99` in tab mount).
    let mut bad_tab_entry = base.clone();
    bad_tab_entry["project"]["tabs"] = json!([
        {"mount": {"kind": "root"}},
        {"mount": {"kind": "entry", "entry": "e99"}}
    ]);
    let mut bad_parent = base.clone();
    bad_parent["entries"][0]["parent"] = json!("e99");
    let mut bad_tab_view = base.clone();
    bad_tab_view["project"]["tabs"] = json!([
        {"mount": {"kind": "root"}},
        {"mount": {"kind": "view", "view": "v99"}}
    ]);
    for (name, val) in [
        ("bad-tab-entry", bad_tab_entry),
        ("bad-parent", bad_parent),
        ("bad-tab-view", bad_tab_view),
    ] {
        let p = write_case(name, serde_json::to_string(&val).unwrap().as_bytes());
        let res = template_file::import_template(&e.ws, &p);
        assert!(
            matches!(res, Err(TemplateFileError::Damaged(_))),
            "{name} expected Damaged, got {res:?}"
        );
    }

    // 5. Truncated JSON claiming `drifting.project-template` -> `Damaged`.
    let truncated = write_case(
        "truncated",
        r#"{"format":"drifting.project-template","formatVersion":1,"name":"断了"#.as_bytes(),
    );
    assert!(matches!(
        template_file::import_template(&e.ws, &truncated),
        Err(TemplateFileError::Damaged(_))
    ));

    // 6. Non-template files (binary zip, invalid UTF-8, plain text, wrong `format`) -> `NotATemplate`.
    for (name, bytes) in [
        ("zip-binary", &b"PK\x03\x04\x14\x00\xff\xfe"[..]),
        ("plain-text", &b"just plain notes"[..]),
        (
            "wrong-format",
            &br#"{"format":"drifting.book","formatVersion":5}"#[..],
        ),
    ] {
        let p = write_case(name, bytes);
        let res = template_file::import_template(&e.ws, &p);
        assert!(
            matches!(res, Err(TemplateFileError::NotATemplate)),
            "{name} expected NotATemplate, got {res:?}"
        );
        assert!(
            e.ws.call(
                &Actor::User,
                "project_template.import",
                json!({"path": p.to_str().unwrap()})
            )
            .is_err(),
            "{name} must also fail via project_template.import"
        );
    }

    // Zero documents, templates, or books were added or altered.
    let docs_after: Vec<_> =
        e.ws.library()
            .docs(None, None)
            .unwrap()
            .into_iter()
            .map(|d| d.doc_id)
            .collect();
    assert_eq!(docs_after, docs_before);
    assert_eq!(
        out(&e.ws, "project_template.list", json!({})),
        templates_before
    );
    assert_eq!(out(&e.ws, "book.list", json!({})), books_before);
}
