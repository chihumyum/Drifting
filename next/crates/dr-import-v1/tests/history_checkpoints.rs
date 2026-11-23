//! Each 0.1 snapshot history row becomes an entry checkpoint the current
//! format's history lists, previews and restores (`m10-import.md`
//! 「快照历史」), through the same commands the entry's 「快照历史」 dialog
//! calls: `entry_snapshot.list`, `preview`, `restore`.

mod common;

use common::{v3_fixture as fixture, *};
use dr_import_v1::progress::Step;
use dr_import_v1::receipt::Receipt;
use dr_import_v1::run::{self, Options, Outcome};
use dr_workspace::commands::v3::snapshots::{self as api, CaptureReason};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

fn options(old: &Old) -> Options {
    let mut options = Options::new("history-checkpoints-test");
    options.v3 = common::v3_choices();
    options.old_root = Some(old.root.clone());
    options.verify_history = true;
    options.index = false;
    options
}

fn import(old: &Old, root: &std::path::Path) -> Box<Receipt> {
    let (outcome, _) = run::import(&old.db, root, &options(old)).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("not imported")
    };
    receipt
}

fn workspace(root: &std::path::Path) -> Workspace {
    let start = std::time::Instant::now();
    loop {
        match Workspace::open_dir(root, "history-checkpoints-test") {
            Ok(ws) => return ws,
            // m10-import.md 待协调 12: a closed library's lock can outlive
            // `close` for a moment while other tests run.
            Err(error)
                if error.to_string().contains("already open") && start.elapsed().as_secs() < 5 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(error) => panic!("{error}"),
        }
    }
}

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn ms(iso: &str) -> i64 {
    dr_import_v1::time::parse_iso_ms(iso).unwrap()
}

/// An entry's checkpoints, newest first, as the dialog lists them.
fn points(ws: &Workspace, entry: &str) -> Vec<api::Point> {
    serde_json::from_value(call(
        ws,
        "entry_snapshot.list",
        json!({"book":BOOK,"entry":entry}),
    ))
    .unwrap()
}

fn ids(points: &[api::Point]) -> Vec<&str> {
    points.iter().map(|p| p.id.as_str()).collect()
}

fn preview(ws: &Workspace, entry: &str, point: &str) -> Value {
    call(
        ws,
        "entry_snapshot.preview",
        json!({"book":BOOK,"entry":entry,"point":point}),
    )
}

/// What the dialog's 「恢复」 does: preview, then restore with its guards.
fn restore(ws: &Workspace, entry: &str, point: &str) -> Result<Value, String> {
    let target = json!({"book":BOOK,"entry":entry,"point":point});
    let mut input = target;
    input["expected"] = preview(ws, entry, point)["expected"].clone();
    ws.call(&Actor::User, "entry_snapshot.restore", input)
        .map(|o| o["output"].clone())
        .map_err(|e| e.to_string())
}

/// The text of each body a preview shows, by document.
fn texts(preview: &Value) -> Vec<(String, String)> {
    preview["bodies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| {
            (
                b["doc"].as_str().unwrap().to_owned(),
                b["text"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn prose(ws: &Workspace, entry: &str, module: &str) -> Vec<String> {
    call(
        ws,
        "module.read_prose",
        json!({"book":BOOK,"owner":entry,"module":module}),
    )["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap().to_owned())
        .collect()
}

fn entry(ws: &Workspace, id: &str) -> Value {
    call(ws, "entry.get", json!({"book":BOOK,"id":id}))
}

fn body(entry: &str, module: &str) -> String {
    format!("body:{entry}/{module}")
}

/// One expected checkpoint: point id, time, title then, body, text then.
type Expected = (String, i64, &'static str, String, &'static str);

/// Every row of the fixture with a version, newest first per entry.
fn expected() -> Vec<(&'static str, Vec<Expected>)> {
    let p = |row: &str, at: &str, title: &'static str, doc: String, text: &'static str| {
        (format!("import-v1:{row}"), ms(at), title, doc, text)
    };
    vec![
        (
            CHAPTER,
            vec![
                p(
                    "h-2",
                    T1,
                    "第一章 序",
                    body(CHAPTER, "mod-prose"),
                    "第一章 序\n我要给阿Q做正传，已经不止一两年了。",
                ),
                p(
                    "h-1",
                    T0,
                    "第一章",
                    body(CHAPTER, "mod-prose"),
                    "第一章\n我要给阿Q做正传。",
                ),
            ],
        ),
        (
            ELEMENT,
            vec![
                p(
                    "h-element-2",
                    fixture::T3,
                    "阿Q",
                    body(ELEMENT, "mod-prose"),
                    "未庄的一个闲人。",
                ),
                p("h-3", T2, "阿Q", body(ELEMENT, "mod-prose"), "未庄的人。"),
            ],
        ),
        (
            IDEA,
            vec![p(
                "h-idea-1",
                T1,
                "旧构想",
                body(IDEA, "mod-prose"),
                "构想的旧稿。",
            )],
        ),
        (
            STORYLINE,
            vec![
                p(
                    "h-storyline-2",
                    T2,
                    "主线",
                    body(STORYLINE, "mod-description"),
                    "阿Q 的一生。",
                ),
                p(
                    "h-storyline-1",
                    T0,
                    "旧主线",
                    body(STORYLINE, "mod-description"),
                    "阿Q 的半生。",
                ),
            ],
        ),
        (
            CATEGORY,
            vec![p(
                "h-category-1",
                T1,
                "人物旧名",
                body(CATEGORY, "mod-description"),
                "人物分类的旧说明。",
            )],
        ),
        (
            NOTE,
            vec![p(
                "h-note-1",
                T1,
                "旧的待查",
                body(NOTE, "mod-prose"),
                "待查的旧笔记。",
            )],
        ),
        (
            fixture::CHAPTER_DELETED,
            vec![p(
                "h-deleted-1",
                T1,
                "删掉那章旧名",
                body(fixture::CHAPTER_DELETED, "mod-prose"),
                "删掉那章的旧稿。",
            )],
        ),
    ]
}

#[test]
fn every_history_row_with_a_version_is_a_checkpoint_the_history_lists_and_previews() {
    let old = fixture::build_history();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let receipt = import(&old, &root);
    let b = &receipt.books[0];
    assert_eq!(b.status, "imported");
    // Eleven rows: ten with a version, one without a preview (skipped and
    // recorded, as before; no point, no checkpoint).
    assert_eq!(b.history_points, 10);
    assert_eq!(b.history_checkpoints, 10);
    assert_eq!(b.history_checkpoints_checked, 10);
    assert!(b.history_without_checkpoint.is_empty());
    assert!(!b.notes.0.contains_key("history-checkpoint-differs"));
    assert!(
        b.adjustments
            .iter()
            .any(|a| a.code == "history-preview-missing"
                && a.id == "h-empty"
                && a.done == "skipped")
    );
    // The element's row put it under its 0.1 group 「未庄」, which no
    // element keeps now: counted; restoring it keeps the element where it
    // lives (`restoring_a_point_whose_0_1_group_is_gone_…`).
    assert_eq!(b.notes.0.get("history-checkpoint-place-gone"), Some(&1));

    let ws = workspace(&root);
    for (entry, rows) in expected() {
        let listed = points(&ws, entry);
        assert_eq!(
            ids(&listed),
            rows.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(),
            "{entry}"
        );
        for (p, (id, ts, title, doc, text)) in listed.iter().zip(&rows) {
            assert_eq!((&p.id, p.ts, p.title.as_str()), (id, *ts, *title));
            assert_eq!(p.reason, "import");
            assert_eq!(p.format, 1);
            assert_eq!((p.book.as_str(), p.entry.as_str()), (BOOK, entry));
            // Every body the entry owns, the row's at its version.
            assert_eq!(p.bodies.keys().collect::<Vec<_>>(), [doc]);
            let shown = preview(&ws, entry, id);
            assert_eq!(texts(&shown), [(doc.clone(), (*text).to_owned())], "{id}");
            assert_eq!(shown["metadata"]["title"], *title, "{id}");
        }
    }
    // The fields 0.1 kept beside the prose, as the preview shows them.
    let idea = preview(&ws, IDEA, "import-v1:h-idea-1");
    assert_eq!(
        idea["metadata"]["fields"]["mod-fields"],
        json!({"status":"drifting","summary":"构想旧梗概"})
    );
    let chapter = preview(&ws, CHAPTER, "import-v1:h-1");
    assert_eq!(
        chapter["metadata"]["fields"]["mod-fields"],
        json!({"status":"draft","summary":"初稿梗概"})
    );
    // The row without a preview has nothing to show.
    assert!(
        points(&ws, CHAPTER)
            .iter()
            .all(|p| p.id != "import-v1:h-empty")
    );
    ws.shutdown().unwrap();
}

#[test]
fn restoring_an_imported_point_brings_back_its_prose_and_fields_and_keeps_the_state_before() {
    let old = fixture::build_history();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    import(&old, &root);
    let ws = workspace(&root);

    // The chapter: its 0.1 text, title, summary and status come back.
    let now = prose(&ws, CHAPTER, "mod-prose");
    let before = restore(&ws, CHAPTER, "import-v1:h-1").unwrap()["before"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        prose(&ws, CHAPTER, "mod-prose"),
        ["第一章", "我要给阿Q做正传。"]
    );
    let e = entry(&ws, CHAPTER);
    assert_eq!(e["title"], "第一章");
    assert_eq!(
        e["fields"]["mod-fields"],
        json!({"status":"draft","summary":"初稿梗概"})
    );
    // Where it lives and the storyline it is on are as imported.
    assert_eq!(e["parent"], "act-1");
    assert_eq!(e["primary"], STORYLINE);
    // The state before, kept as a checkpoint of its own at the top.
    let listed = points(&ws, CHAPTER);
    assert_eq!(
        ids(&listed),
        [before.as_str(), "import-v1:h-2", "import-v1:h-1"]
    );
    assert_eq!(listed[0].reason, "restore");
    assert_eq!(listed[0].title, "第一章 序");
    let kept = preview(&ws, CHAPTER, &before);
    assert_eq!(texts(&kept)[0].1, now.join("\n"));
    // And it brings the imported state back.
    restore(&ws, CHAPTER, &before).unwrap();
    assert_eq!(prose(&ws, CHAPTER, "mod-prose"), now);
    assert_eq!(entry(&ws, CHAPTER)["title"], "第一章 序");
    assert_eq!(
        entry(&ws, CHAPTER)["fields"]["mod-fields"],
        json!({"status":"draft","summary":"梗概"})
    );
    // A row with only a title: the summary is what the book version that
    // carries the row holds, the earlier row's (no row 0.1's snapshot
    // service wrote lacks a field of its kind: m10-import.md 「快照历史」).
    restore(&ws, CHAPTER, "import-v1:h-2").unwrap();
    assert_eq!(
        prose(&ws, CHAPTER, "mod-prose"),
        ["第一章 序", "我要给阿Q做正传，已经不止一两年了。"]
    );
    assert_eq!(entry(&ws, CHAPTER)["title"], "第一章 序");
    assert_eq!(
        entry(&ws, CHAPTER)["fields"]["mod-fields"],
        json!({"status":"draft","summary":"初稿梗概"})
    );

    // The storyline: its description, name, summary and facts.
    restore(&ws, STORYLINE, "import-v1:h-storyline-1").unwrap();
    assert_eq!(prose(&ws, STORYLINE, "mod-description"), ["阿Q 的半生。"]);
    let s = entry(&ws, STORYLINE);
    assert_eq!(s["title"], "旧主线");
    assert_eq!(s["fields"]["mod-fields"]["summary"], "主线旧梗概");
    assert_eq!(s["fields"]["mod-fields"]["color"], "#336699");
    let facts: Vec<_> = s["kv"]["mod-kv"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| (k["key"].clone(), k["value"].clone()))
        .collect();
    assert_eq!(facts, [(json!("起点"), json!("县城"))]);

    // The idea, the note and the chapter in Recently Deleted.
    restore(&ws, IDEA, "import-v1:h-idea-1").unwrap();
    assert_eq!(prose(&ws, IDEA, "mod-prose"), ["构想的旧稿。"]);
    assert_eq!(entry(&ws, IDEA)["title"], "旧构想");
    restore(&ws, NOTE, "import-v1:h-note-1").unwrap();
    assert_eq!(prose(&ws, NOTE, "mod-prose"), ["待查的旧笔记。"]);
    assert_eq!(entry(&ws, NOTE)["title"], "旧的待查");
    restore(&ws, fixture::CHAPTER_DELETED, "import-v1:h-deleted-1").unwrap();
    let deleted = entry(&ws, fixture::CHAPTER_DELETED);
    assert_eq!(deleted["title"], "删掉那章旧名");
    assert!(
        !deleted["deleted_at"].is_null(),
        "still in Recently Deleted"
    );
    // Its body as stored (the commands do not read an entry in Recently
    // Deleted).
    let doc = body(fixture::CHAPTER_DELETED, "mod-prose");
    let stored = ws.library().load_copy(&doc).unwrap();
    let reader =
        dr_doc::prose::ProseReader::from_loro(dr_model::DocId::parse(&doc).unwrap(), &stored)
            .unwrap();
    let text: Vec<String> = reader
        .view()
        .paragraphs()
        .map(|p| p.text().to_string())
        .collect();
    assert_eq!(text, ["删掉那章的旧稿。"]);

    // The category: its name and description. Its element template is the
    // book's, not the entry's: the preview shows it as it was, a restore
    // leaves it.
    let template = |ws: &Workspace| {
        let id = dr_samples::v3::category_template(CATEGORY).to_string();
        call(ws, "entry_template.list", json!({"book":BOOK}))
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id.as_str())
            .cloned()
            .expect("the category's element template")
    };
    let template_now = template(&ws);
    restore(&ws, CATEGORY, "import-v1:h-category-1").unwrap();
    assert_eq!(
        prose(&ws, CATEGORY, "mod-description"),
        ["人物分类的旧说明。"]
    );
    assert_eq!(entry(&ws, CATEGORY)["title"], "人物旧名");
    assert_eq!(template(&ws), template_now);

    // The element in the group it is in now: its text, name, aliases,
    // summary and facts (the one its template makes a field too).
    let group = entry(&ws, ELEMENT)["parent"].clone();
    restore(&ws, ELEMENT, "import-v1:h-element-2").unwrap();
    assert_eq!(prose(&ws, ELEMENT, "mod-prose"), ["未庄的一个闲人。"]);
    let e = entry(&ws, ELEMENT);
    assert_eq!(e["title"], "阿Q");
    assert_eq!(e["parent"], group);
    let fields = &e["fields"]["mod-fields"];
    assert_eq!(fields["summary"], "旧的主人公");
    assert_eq!(fields["aliases"], json!(["阿贵"]));
    assert_eq!(fields["kv-7"], "30");
    let facts: Vec<_> = e["kv"]["mod-kv"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| (k["key"].clone(), k["value"].clone()))
        .collect();
    assert_eq!(
        facts,
        [
            (json!("住处"), json!("破庙")),
            (json!("职业"), json!("短工"))
        ]
    );
    ws.shutdown().unwrap();
}

/// The element's older row has it under its 0.1 group 「未庄」, which the
/// imported book no longer has. Restoring it brings back the row's text,
/// name, aliases, summary and facts, and the element stays in the group it
/// lives in now, in its place there (author, 2026-11-23: a place that is
/// gone keeps the entry where it is). One undo goes back to the state before.
#[test]
fn restoring_a_point_whose_0_1_group_is_gone_keeps_the_element_where_it_lives() {
    let old = fixture::build_history();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    import(&old, &root);
    let ws = workspace(&root);
    // Where it lives now, and the order of the entries living there.
    let place = |ws: &Workspace| {
        let parent = entry(ws, ELEMENT)["parent"].clone();
        let siblings: Vec<Value> = call(ws, "entry.list", json!({"book":BOOK,"all":true}))
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["parent"] == parent)
            .map(|e| e["id"].clone())
            .collect();
        (parent, siblings)
    };
    let facts = |e: &Value| -> Vec<(Value, Value)> {
        e["kv"]["mod-kv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| (k["key"].clone(), k["value"].clone()))
            .collect()
    };
    // The point's place is gone: in the book version it was taken at, the
    // element lives under an entry the book does not have now.
    let shown = preview(&ws, ELEMENT, "import-v1:h-3");
    let then = shown["raw_state"]["parent"].as_str().unwrap().to_owned();
    assert!(
        !call(
            &ws,
            "entry.list",
            json!({"book":BOOK,"all":true,"trashed":true})
        )
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["id"] == then.as_str()),
        "the group of the row is gone"
    );
    let (here, before) = (place(&ws), entry(&ws, ELEMENT));
    let text = prose(&ws, ELEMENT, "mod-prose");
    assert_ne!(here.0, json!(then));
    let listed = points(&ws, ELEMENT).len();

    restore(&ws, ELEMENT, "import-v1:h-3").unwrap();
    assert_eq!(prose(&ws, ELEMENT, "mod-prose"), ["未庄的人。"]);
    let e = entry(&ws, ELEMENT);
    assert_eq!(e["title"], "阿Q");
    assert_eq!(e["fields"]["mod-fields"]["summary"], "");
    assert_eq!(e["fields"]["mod-fields"]["aliases"], json!(["阿贵"]));
    assert_eq!(
        facts(&e),
        [
            (json!("住处"), json!("破庙")),
            (json!("绰号"), json!("阿Q"))
        ]
    );
    assert_eq!(place(&ws), here, "where it lives and its place there");
    // The state before, kept as a checkpoint of its own at the top.
    let after = points(&ws, ELEMENT);
    assert_eq!(after.len(), listed + 1);
    assert_eq!(after[0].reason, "restore");

    // One undo: the text, the fields and the place it had.
    ws.undo(&Actor::User).unwrap().expect("the restore");
    assert_eq!(prose(&ws, ELEMENT, "mod-prose"), text);
    assert_eq!(entry(&ws, ELEMENT), before);
    assert_eq!(place(&ws), here);
    ws.shutdown().unwrap();
}

#[test]
fn the_first_checkpoints_the_new_client_takes_follow_the_imported_ones_without_a_duplicate() {
    let old = fixture::build_history();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    import(&old, &root);
    let ws = workspace(&root);
    let with_history = [
        CHAPTER,
        ELEMENT,
        IDEA,
        STORYLINE,
        CATEGORY,
        NOTE,
        fixture::CHAPTER_DELETED,
    ];
    // The background pass gives a first point to the entries without one:
    // not to those with 0.1 history.
    let without = api::entries_without_checkpoint(&ws, BOOK).unwrap();
    assert!(!without.is_empty());
    for e in with_history {
        assert!(!without.iter().any(|w| w == e), "{e}");
    }
    assert!(without.iter().any(|w| w == fixture::CHAPTER_BEFORE));
    // The last pass on quitting: what changed since the latest point.
    let due = api::entries_due_for_capture(&ws, BOOK).unwrap();
    // The storyline's latest 0.1 row is what it is now: nothing to save.
    assert!(!due.iter().any(|d| d == STORYLINE), "{due:?}");
    assert!(due.iter().any(|d| d == CHAPTER), "{due:?}");
    let mut plan = api::CapturePlan::read(&ws, BOOK).unwrap();
    for batch in due.chunks(api::CAPTURE_BATCH) {
        plan.capture(&ws, batch, CaptureReason::Close).unwrap();
    }
    // The imported points first by time, then the new client's first.
    let chapter = points(&ws, CHAPTER);
    assert_eq!(chapter.len(), 3);
    assert_eq!(chapter[0].reason, "close");
    assert!(chapter[0].ts > ms(fixture::T3));
    assert_eq!(
        ids(&chapter[1..]),
        ["import-v1:h-2", "import-v1:h-1"],
        "an automatic capture thins automatic points only"
    );
    assert_eq!(
        ids(&points(&ws, STORYLINE)),
        ["import-v1:h-storyline-2", "import-v1:h-storyline-1"]
    );
    // A second sweep finds nothing; another edit and another close point
    // leave the 0.1 points, a month and more old, where they are.
    assert!(api::entries_due_for_capture(&ws, BOOK).unwrap().is_empty());
    call(
        &ws,
        "module.set_prose",
        json!({"book":BOOK,"owner":CHAPTER,"module":"mod-prose","paragraphs":[{"text":"新版里写的。"}]}),
    );
    api::capture_entries(&ws, BOOK, &[CHAPTER.to_owned()], CaptureReason::Close).unwrap();
    let chapter = points(&ws, CHAPTER);
    assert_eq!(chapter.len(), 4);
    assert_eq!(ids(&chapter[2..]), ["import-v1:h-2", "import-v1:h-1"]);
    ws.shutdown().unwrap();
}

/// The library alone, as the measurement opens it: no workspace.
fn library(root: &std::path::Path) -> dr_store::Library {
    let start = std::time::Instant::now();
    loop {
        let mut o = dr_store::LibraryOptions::new("history-checkpoints-test");
        o.configure_doc = Some(std::sync::Arc::new(dr_doc::schema::configure));
        match dr_store::Library::open(root, o) {
            Ok(lib) => return lib,
            Err(error)
                if error.to_string().contains("already open") && start.elapsed().as_secs() < 5 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(error) => panic!("{error}"),
        }
    }
}

/// Every manifest of the book's checkpoints document, and the document's
/// version.
fn stored_checkpoints(root: &std::path::Path) -> (Value, loro::VersionVector) {
    let lib = library(root);
    let doc = lib.load_copy(&format!("checkpoints:{BOOK}")).unwrap();
    let out = (
        serde_json::to_value(doc.get_deep_value()).unwrap(),
        doc.oplog_vv(),
    );
    lib.close().unwrap();
    out
}

#[test]
fn a_resumed_import_writes_the_same_checkpoints_once() {
    let old = fixture::build_history();
    let temp = tempfile::tempdir().unwrap();
    // Stopped twice: while the catalog's history is replayed (no checkpoint
    // yet), and once the checkpoints are written (before the assets).
    for (name, step) in [("in-history", Step::Book), ("after", Step::Assets)] {
        let root = temp.path().join(name);
        let opts = options(&old);
        let cancel = opts.cancel.clone();
        let (first, _) = run::import_with(&old.db, &root, &opts, &mut |p| {
            if p.step == step && p.done == u64::from(step == Step::Book) {
                cancel.now();
            }
        })
        .unwrap();
        assert!(
            matches!(first, Outcome::Imported(r) if r.books[0].status == "importing"),
            "{name}"
        );
        let written = (step == Step::Assets).then(|| stored_checkpoints(&root));
        let again = import(&old, &root);
        let b = &again.books[0];
        assert_eq!(b.status, "imported");
        assert!(b.notes.0.contains_key("resumed-after-interruption"));
        assert_eq!(
            (b.history_checkpoints, b.history_checkpoints_checked),
            (10, 10)
        );
        let (manifests, version) = stored_checkpoints(&root);
        assert_eq!(
            manifests["entry_checkpoints"].as_object().unwrap().len(),
            10
        );
        if let Some(written) = written {
            assert_eq!((manifests, version), written, "the same operations again");
        }
        let ws = workspace(&root);
        assert_eq!(
            ids(&points(&ws, CHAPTER)),
            ["import-v1:h-2", "import-v1:h-1"]
        );
        restore(&ws, CHAPTER, "import-v1:h-1").unwrap();
        assert_eq!(
            prose(&ws, CHAPTER, "mod-prose"),
            ["第一章", "我要给阿Q做正传。"]
        );
        ws.shutdown().unwrap();
    }
}

#[test]
fn the_loss_detector_names_a_history_row_without_its_checkpoint() {
    let old = fixture::build_history();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    import(&old, &root);
    let check = || {
        let lib = library(&root);
        let checked = dr_import_v1::verify::check_catalog_in(&old.db, &lib).unwrap();
        lib.close().unwrap();
        checked
    };
    let clean = check();
    assert!(clean.is_clean(), "{:#?}", clean.unexplained);
    let t = &clean.tables["entity_snapshot_history (checkpoint)"];
    assert_eq!((t.source, t.carried, t.dropped), (11, 10, 1));

    // A checkpoint gone after the import is named.
    let lib = library(&root);
    let h = lib
        .open_doc(&format!("checkpoints:{BOOK}"), dr_store::OpenDoc::Existing)
        .unwrap();
    h.write(dr_store::Origin::User, |d| {
        d.get_map("entry_checkpoints")
            .delete("import-v1:h-1")
            .unwrap();
    })
    .unwrap();
    h.close();
    lib.close().unwrap();
    let lost = check();
    assert_eq!(
        lost.unexplained
            .iter()
            .map(|u| (u.table.as_str(), u.book.as_str(), u.id.as_str()))
            .collect::<Vec<_>>(),
        [("entity_snapshot_history (checkpoint)", BOOK, "h-1")]
    );
    // One the receipt records as not written, with its code, is explained.
    let conn = rusqlite::Connection::open(dr_store::LibraryPaths::new(&root).db).unwrap();
    let json: String = conn
        .query_row("SELECT record_json FROM import_book", [], |r| r.get(0))
        .unwrap();
    let mut record: Value = serde_json::from_str(&json).unwrap();
    record["historyWithoutCheckpoint"] = json!({"h-1": dr_import_v1::checkpoints::ENTRY_MISSING});
    conn.execute(
        "UPDATE import_book SET record_json = ?1",
        [record.to_string()],
    )
    .unwrap();
    drop(conn);
    let recorded = check();
    assert!(recorded.is_clean(), "{:#?}", recorded.unexplained);
    let t = &recorded.tables["entity_snapshot_history (checkpoint)"];
    assert_eq!((t.source, t.carried, t.dropped), (11, 9, 2));
}
