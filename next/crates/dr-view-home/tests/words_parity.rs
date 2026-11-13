//! End-to-end word-count and word-target parity across Stats, Shelf, Cover,
//! Project Home, and the writing-day recorder (`kernel-v4.md` §7, T6).

use std::time::{Duration, Instant};

use dr_model::Day;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_home::v3::Home;
use dr_view_shelf::data::{self as shelf_data, ShelfData};
use dr_view_shelf_art::cover_request;
use dr_view_stats::{
    load_progress,
    model::Live,
    recorder::{Tracker, WorkspaceSource},
    v3::{self as stats_v3, Scope},
};
use dr_workspace::{Actor, Workspace as Library, WorkspaceOptions, library_options};
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

fn call(ws: &Library, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn doc_words(ws: &Library, entry: &str, module: &str) -> u64 {
    ws.library()
        .doc_stats(&format!("body:{entry}/{module}"))
        .unwrap()
        .expect("indexed prose document")
        .words
}

#[test]
fn only_in_book_prose_drives_stats_shelf_cover_targets_and_recorder() {
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(dir.path(), library_options("0.2.0-dev")).unwrap();
    let ws = Library::open(store, WorkspaceOptions::default()).unwrap();

    let book = call(&ws, "project.create", json!({"name": "潮汐志"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &ws,
        "book.update",
        json!({"book": book, "word_target": 100, "daily_word_target": 40}),
    );

    let manuscript = dr_testkit::seed::acceptance::novel_root(&ws, &book, "tpl-manuscript");

    // Manuscript root has built-in `mod-description` (`in_book: false`) plus an
    // added `mod-preface` (`in_book: true`).
    call(
        &ws,
        "entry_template.put_module",
        json!({
            "book": book,
            "template": "tpl-manuscript",
            "module": {
                "id": "mod-preface",
                "kind": "prose",
                "name": "序言",
                "config": {"in_book": true}
            }
        }),
    );
    call(
        &ws,
        "module.set_prose",
        json!({
            "book": book,
            "owner": manuscript,
            "module": "mod-description",
            "paragraphs": [{"text": "这段提纲说明不计入整书字数，也不进入导出。"}]
        }),
    );
    call(
        &ws,
        "module.set_prose",
        json!({
            "book": book,
            "owner": manuscript,
            "module": "mod-preface",
            "paragraphs": [{"text": "海雾升起之前，旧港还有最后一次涨潮。"}]
        }),
    );

    // Chapter template gets an extra `in_book: false` notes module and a second
    // `in_book: true` coda module.
    call(
        &ws,
        "entry_template.put_module",
        json!({
            "book": book,
            "template": "tpl-chapter",
            "module": {
                "id": "mod-notes",
                "kind": "prose",
                "name": "备忘",
                "config": {"in_book": false}
            }
        }),
    );
    call(
        &ws,
        "entry_template.put_module",
        json!({
            "book": book,
            "template": "tpl-chapter",
            "module": {
                "id": "mod-coda",
                "kind": "prose",
                "name": "尾声",
                "config": {"in_book": true}
            }
        }),
    );

    let ch1 = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": manuscript,
            "template": "tpl-chapter",
            "title": "第一章",
            "bodies": {
                "mod-prose": "雨水顺着石阶流进船坞。",
                "mod-notes": "这里只给作者自己看，绝不计入整书字数。"
            }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let ch2 = call(
        &ws,
        "entry.create",
        json!({
            "book": book,
            "parent": manuscript,
            "template": "tpl-chapter",
            "title": "第二章",
            "bodies": {
                "mod-prose": "灯塔在午夜亮了三次。",
                "mod-coda": "远处的钟声沉入海底。"
            }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Off-manuscript entry whose template prose has `in_book: true` by default
    // still never enters the manuscript sequence.
    let idea =
        dr_testkit::seed::acceptance::novel_entry(&ws, &book, "tpl-idea", "旧港考", None)["id"]
            .as_str()
            .unwrap()
            .to_owned();
    call(
        &ws,
        "module.set_prose",
        json!({
            "book": book,
            "owner": idea,
            "module": "mod-prose",
            "paragraphs": [{"text": "构想条目不在成书层级里，不计入整书字数。"}]
        }),
    );

    ws.library().rebuild_stale_indexes().unwrap();

    let desc_w = doc_words(&ws, &manuscript, "mod-description");
    let preface_w = doc_words(&ws, &manuscript, "mod-preface");
    let ch1_prose_w = doc_words(&ws, &ch1, "mod-prose");
    let ch1_notes_w = doc_words(&ws, &ch1, "mod-notes");
    let ch2_prose_w = doc_words(&ws, &ch2, "mod-prose");
    let ch2_coda_w = doc_words(&ws, &ch2, "mod-coda");
    let idea_w = doc_words(&ws, &idea, "mod-prose");
    assert!(
        desc_w > 0
            && preface_w > 0
            && ch1_prose_w > 0
            && ch1_notes_w > 0
            && ch2_prose_w > 0
            && ch2_coda_w > 0
            && idea_w > 0
    );

    let expected_entry_words = vec![preface_w, ch1_prose_w, ch2_prose_w + ch2_coda_w];
    let expected_total: u64 = expected_entry_words.iter().sum();

    let day = Day::parse("2026-11-12").unwrap();
    let stats = stats_v3::load_at(&ws, &book, Scope::Book, &day).unwrap();
    assert_eq!(stats.leaves, 3);
    assert_eq!(
        stats.book_words(&Live::default()).unwrap().words,
        expected_total
    );
    assert_eq!(stats.word_target, Some(100));
    assert_eq!(stats.daily_word_target, Some(40));

    // Single-entry scope still inspects `in_book == false` prose on that entry,
    // while `book_words` continues to exclude it.
    let single = stats_v3::load_at(
        &ws,
        &book,
        Scope::Entry {
            id: ch1.clone(),
            module: None,
        },
        &day,
    )
    .unwrap();
    assert_eq!(
        single.words(&Live::default()).unwrap().words,
        ch1_prose_w + ch1_notes_w
    );
    assert_eq!(
        single.book_words(&Live::default()).unwrap().words,
        expected_total
    );

    // Shelf, Progress, and Cover all agree on the exact same word count and
    // manuscript entry count.
    let progress = load_progress(&ws, &book, &day, None).unwrap();
    assert_eq!(progress.words, expected_total);
    assert_eq!(progress.word_target, Some(100));
    assert_eq!(progress.daily_word_target, Some(40));

    let shelf = ShelfData::load(&ws).unwrap();
    let shelf_book = shelf.books.iter().find(|b| b.id == book).unwrap();
    assert_eq!(shelf_book.chapters, 3);
    assert_eq!(shelf_book.words, Some(expected_total));
    assert_eq!(shelf_book.word_target, Some(100));
    assert_eq!(
        shelf_data::progress(expected_total, shelf_book.word_target),
        progress.book
    );

    let cover = cover_request(&ws, &book, "潮汐志");
    assert_eq!(cover.chapters, stats.leaves);
    assert_eq!(cover.words, expected_entry_words);
    assert_eq!(
        cover.words.iter().sum::<u64>(),
        stats.book_words(&Live::default()).unwrap().words
    );
    assert_eq!(cover.words.iter().sum::<u64>(), shelf_book.words.unwrap());

    // Turning `in_book` off on `mod-coda` removes its words from Stats, Shelf,
    // Progress, and Cover alike; turning it back on restores them.
    call(
        &ws,
        "entry_template.put_module",
        json!({
            "book": book,
            "template": "tpl-chapter",
            "module": {
                "id": "mod-coda",
                "kind": "prose",
                "name": "尾声",
                "config": {"in_book": false}
            }
        }),
    );
    let reduced = expected_total - ch2_coda_w;
    assert_eq!(
        stats_v3::load_at(&ws, &book, Scope::Book, &day)
            .unwrap()
            .book_words(&Live::default())
            .unwrap()
            .words,
        reduced
    );
    assert_eq!(
        ShelfData::load(&ws)
            .unwrap()
            .books
            .into_iter()
            .find(|b| b.id == book)
            .unwrap()
            .words,
        Some(reduced)
    );
    assert_eq!(
        cover_request(&ws, &book, "潮汐志").words,
        vec![preface_w, ch1_prose_w, ch2_prose_w]
    );

    call(
        &ws,
        "entry_template.put_module",
        json!({
            "book": book,
            "template": "tpl-chapter",
            "module": {
                "id": "mod-coda",
                "kind": "prose",
                "name": "尾声",
                "config": {"in_book": true}
            }
        }),
    );

    // Writing-day recorder ignores edits to `in_book == false` prose and counts
    // edits to `in_book == true` prose.
    let mut tracker = Tracker::new(WorkspaceSource {
        ws: ws.clone(),
        device: Some("device-t6-in-book-check".into()),
    });
    assert!(tracker.track(&book, &day));
    assert_eq!(tracker.today(&book), Some(0));

    let now = Instant::now();
    for (owner, module) in [(&manuscript, "mod-description"), (&ch1, "mod-notes")] {
        let doc_id = format!("body:{owner}/{module}");
        tracker.prose(&doc_id, Some(&book), true, &day, now);
        call(
            &ws,
            "module.set_prose",
            json!({
                "book": book,
                "owner": owner,
                "module": module,
                "paragraphs": [{"text": "再次补充大段不计入整书的备忘文字，不应推动今日字数。"}]
            }),
        );
        ws.library().reindex_doc(&doc_id).unwrap();
        tracker.indexed(&doc_id, &day, now);
    }
    assert_eq!(
        tracker.today(&book),
        Some(0),
        "editing in_book == false prose must not move daily words"
    );

    let preface_doc = format!("body:{manuscript}/mod-preface");
    tracker.prose(&preface_doc, Some(&book), true, &day, now);
    call(
        &ws,
        "module.set_prose",
        json!({
            "book": book,
            "owner": manuscript,
            "module": "mod-preface",
            "paragraphs": [{"text": "海雾升起之前，旧港还有最后一次涨潮。守塔人点亮了风灯。"}]
        }),
    );
    ws.library().reindex_doc(&preface_doc).unwrap();
    tracker.indexed(&preface_doc, &day, now);
    let new_preface_w = doc_words(&ws, &manuscript, "mod-preface");
    assert_eq!(
        tracker.today(&book),
        Some((new_preface_w - preface_w) as i64),
        "editing in_book == true prose advances daily words by its exact delta"
    );

    ws.close();
}

fn wait(cx: &mut VisualTestContext, stage: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if done(cx) {
            break;
        }
        assert!(Instant::now() < deadline, "home timed out: {stage}");
        std::thread::sleep(Duration::from_millis(3));
    }
}

#[gpui::test]
fn home_settings_save_word_targets_across_home_stats_and_shelf(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.rebuild_stale_indexes().unwrap();
    store.close().unwrap();
    let lib = Library::open_dir(&root, "test").unwrap();

    let day = chrono::NaiveDate::from_ymd_opt(2026, 11, 12).unwrap();
    let model_day = Day::parse("2026-11-12").unwrap();
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_home::init(cx);
        dr_view_home::set_today(day, cx);
    });

    let (ws, cx) = cx.add_window_view(Workspace::new);
    cx.update(|window, _| window.activate_window());
    wait(cx, "workspace and home", |cx| {
        ws.read_with(cx, |ws, _| ws.book.id == book && ws.v3_home.is_some())
    });
    let home: Entity<Home> = ws.read_with(cx, |ws, _| {
        ws.v3_home.clone().unwrap().downcast::<Home>().unwrap()
    });
    wait(cx, "initial numbers", |cx| {
        home.read_with(cx, |h, _| h.loaded.is_some())
    });

    let dialog = cx.update(|window, cx| {
        home.update(cx, |h, cx| {
            h.ask_settings(window, cx).expect("settings dialog")
        })
    });
    assert!(ws.read_with(cx, |ws, _| ws.dialog.is_some()));

    let (goal, daily) = dialog.read_with(cx, |d, _| (d.goal.clone(), d.daily.clone()));
    cx.update(|_, cx| {
        goal.update(cx, |f, cx| f.set_text("80000", cx));
        daily.update(cx, |f, cx| f.set_text("1500", cx));
        dialog.update(cx, |d, cx| d.save(cx));
    });

    wait(cx, "updated word targets reach Home", |cx| {
        ws.read_with(cx, |ws, _| ws.dialog.is_none())
            && home.read_with(cx, |h, _| {
                h.loaded.as_ref().is_some_and(|d| {
                    d.word_target == Some(80_000) && d.daily_word_target == Some(1_500)
                })
            })
    });

    let progress = load_progress(&lib, &book, &model_day, None).unwrap();
    assert_eq!(progress.word_target, Some(80_000));
    assert_eq!(progress.daily_word_target, Some(1_500));
    let shelf = ShelfData::load(&lib).unwrap();
    assert_eq!(
        shelf
            .books
            .iter()
            .find(|b| b.id == book)
            .unwrap()
            .word_target,
        Some(80_000)
    );

    lib.close();
}
