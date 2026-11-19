//! Agent post-commit grapheme reveal playback (`CommitPlaybackOptions::new("agent:")`)
//! enabled by default on both Entry Page (`BodyModule` / `ChapterEditor`) and
//! Whole-Book View (`WholeBook` / `BookEditor`), preserved across entry
//! switches and whole-book reloads, and suppressed when Reduced Motion is on.

use std::time::{Duration, Instant};

use dr_shell::{
    Services, Settings, SettingsFile, ShellInfo, Workspace,
    nav::{Open, Target},
    settings::registry,
};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

fn call(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn fixture() -> (tempfile::TempDir, Library, String, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("playback-test"))
        .unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();

    let lib = Library::open_dir(dir.path(), "playback-test").unwrap();
    lib.set_auto_links(false);
    let entries = call(&lib, "entry.list", json!({"book": book, "all": true}));
    let chapters: Vec<String> = entries
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["template"] == "tpl-chapter")
        .map(|e| e["id"].as_str().unwrap().to_owned())
        .collect();
    assert!(chapters.len() >= 2, "tiny seed has multiple chapters");
    (dir, lib, book, chapters)
}

fn draw_once(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|w, cx| {
        w.simulate_next_frame(cx);
        w.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn wait(
    cx: &mut VisualTestContext,
    label: &str,
    mut done: impl FnMut(&mut VisualTestContext) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        draw_once(cx);
        if done(cx) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "editor playback test timed out at: {label}"
        );
        std::thread::sleep(Duration::from_millis(3));
    }
}

fn setup<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    book: &str,
) -> (Entity<Workspace>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        let _ = dr_ui::init(cx);
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "playback-test",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(dr_ui::Appearance::Light),
            },
            Services {
                library: Some(lib.clone()),
                book: Some(book.into()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_page::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.update(|w, _| w.activate_window());
    wait(cx, "book loaded", |cx| {
        view.read_with(cx, |w, _| w.book.v3().is_some())
    });
    (view, cx)
}

/// Appends ~40 characters from the paragraph itself via an `Actor::agent`
/// `prose.replace` commit so default playback (`24 ms * 40 = 960 ms`) stays
/// measurably active when the UI refreshes, returning the full updated
/// paragraph text to wait for.
fn agent_append_to_doc(lib: &Library, doc: &str, turn: u32) -> String {
    let prose = call(lib, "prose.read", json!({"doc": doc}));
    let paragraph = prose["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["text"].as_str().is_some_and(|s| s.chars().count() >= 8))
        .expect("chapter has a non-empty paragraph");
    let original = paragraph["text"].as_str().unwrap().to_owned();
    let chunk: String = original.chars().cycle().take(40).collect();
    let replacement = format!("{original}{chunk}");
    lib.call(
        &Actor::agent("playback-session", turn, format!("call-{turn}")),
        "prose.replace",
        json!({
            "doc": doc,
            "block_id": paragraph["block_id"],
            "find": &original,
            "replace": &replacement,
        }),
    )
    .unwrap();
    replacement
}

#[gpui::test]
fn entry_page_enables_agent_playback_across_entry_switches_and_respects_reduce_motion(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, book, chapters) = fixture();
    let (view, cx) = setup(cx, &lib, &book);

    // 1. Entry page 1: playback activates automatically on an `agent:` commit.
    let first_target = Target::Entry {
        id: chapters[0].parse().unwrap(),
        module: None,
    };
    view.update(cx, |w, cx| w.open(first_target.clone(), Open::KEEP, cx));
    wait(cx, "first_target open", |cx| {
        view.read_with(cx, |w, _| w.editor_of(&first_target).is_some())
    });
    let first_editor = view.read_with(cx, |w, _| w.editor_of(&first_target).unwrap().clone());
    let doc_0 = format!("body:{}/mod-prose", chapters[0]);
    let added_0 = agent_append_to_doc(&lib, &doc_0, 1);

    wait(cx, "first_editor agent_0", |cx| {
        first_editor.read_with(cx, |e, cx| e.plain_text(cx).contains(&added_0))
    });
    let status_0 = first_editor.read_with(cx, |e, cx| e.editor().read(cx).commit_playback(cx));
    assert!(
        status_0.is_some(),
        "entry page should play back `agent:` commits by default"
    );

    // 2. Navigate to Entry page 2 (and also verify `ChapterEditor::switch_to`):
    //    playback remains enabled on the newly opened entry editor.
    let second_target = Target::Entry {
        id: chapters[1].parse().unwrap(),
        module: None,
    };
    view.update(cx, |w, cx| w.open(second_target.clone(), Open::PREVIEW, cx));
    wait(cx, "second_target open", |cx| {
        view.read_with(cx, |w, _| w.editor_of(&second_target).is_some())
    });
    let second_editor = view.read_with(cx, |w, _| w.editor_of(&second_target).unwrap().clone());
    let doc_1 = format!("body:{}/mod-prose", chapters[1]);
    let added_1 = agent_append_to_doc(&lib, &doc_1, 2);

    wait(cx, "second_editor agent_1", |cx| {
        second_editor.read_with(cx, |e, cx| e.plain_text(cx).contains(&added_1))
    });
    assert!(
        second_editor
            .read_with(cx, |e, cx| e.editor().read(cx).commit_playback(cx))
            .is_some(),
        "switched entry page should also play back `agent:` commits"
    );

    // 3. Turning on Reduced Motion (`关闭动态效果`) cancels active playback and
    //    settles subsequent `agent:` commits immediately on the mounted entry page.
    cx.update(|_, cx| {
        Settings::update(cx, |f| {
            f.set(registry::REDUCE_MOTION, true.into(), None).ok()
        });
    });
    wait(cx, "reduce_motion cancel", |cx| {
        second_editor.read_with(cx, |e, cx| {
            e.editor().read(cx).commit_playback(cx).is_none()
        })
    });
    let added_rm = agent_append_to_doc(&lib, &doc_1, 3);
    wait(cx, "second_editor reduce_motion commit", |cx| {
        second_editor.read_with(cx, |e, cx| e.plain_text(cx).contains(&added_rm))
    });
    assert!(
        second_editor
            .read_with(cx, |e, cx| e.editor().read(cx).commit_playback(cx))
            .is_none(),
        "Reduced Motion must suppress commit playback while keeping durable text"
    );

    // 4. Turning Reduced Motion back off and calling `ChapterEditor::switch_to`
    //    preserves `CommitPlaybackOptions` across `ProseEditor` reconstruction.
    cx.update(|_, cx| {
        Settings::update(cx, |f| {
            f.set(registry::REDUCE_MOTION, false.into(), None).ok()
        });
    });
    draw_once(cx);
    second_editor.update_in(cx, |e, window, cx| {
        e.switch_to(&doc_0, window, cx).unwrap();
    });
    let added_switch = agent_append_to_doc(&lib, &doc_0, 4);
    wait(cx, "second_editor switch_to doc_0", |cx| {
        second_editor.read_with(cx, |e, cx| e.plain_text(cx).contains(&added_switch))
    });
    assert!(
        second_editor
            .read_with(cx, |e, cx| e.editor().read(cx).commit_playback(cx))
            .is_some(),
        "ChapterEditor::switch_to must preserve CommitPlaybackOptions"
    );

    lib.close();
}

#[gpui::test]
fn whole_book_view_enables_agent_playback_and_preserves_it_across_reload(cx: &mut TestAppContext) {
    let (_dir, lib, book, _chapters) = fixture();
    let (view, cx) = setup(cx, &lib, &book);

    let manuscript_id = view.read_with(cx, |w, _| w.book.v3().unwrap().roots[0].clone());
    let book_target = Target::Book(manuscript_id.parse().unwrap());
    view.update(cx, |w, cx| w.open(book_target.clone(), Open::KEEP, cx));
    wait(cx, "whole_book open", |cx| {
        view.read_with(cx, |w, _| w.book_editor().is_some())
    });

    let whole = view.read_with(cx, |w, _| w.book_editor().unwrap().clone());
    let initial_prose_id = whole.read_with(cx, |w, _| w.editor().entity_id());
    let first_doc = whole.read_with(cx, |w, _| w.chapter_docs().next().unwrap().to_owned());

    // 1. Agent commit in Whole-Book View plays back automatically.
    let added_before_reload = agent_append_to_doc(&lib, &first_doc, 1);
    wait(cx, "whole_book agent_1", |cx| {
        whole.read_with(cx, |w, cx| {
            w.editor().read(cx).book().chapters[0]
                .doc
                .plain_text()
                .contains(&added_before_reload)
        })
    });
    assert!(
        whole
            .read_with(cx, |w, cx| w.editor().read(cx).commit_playback(cx))
            .is_some(),
        "whole-book view should play back `agent:` commits by default"
    );

    // 2. Reorder chapters to force `BookEditor::reload` / `install_sections`
    //    (rebuilding the underlying `Entity<ProseEditor>`), then verify
    //    `CommitPlaybackOptions` is still active on the rebuilt editor.
    let owner = dr_editor::v3::body(&first_doc).unwrap().0;
    let parent = call(&lib, "entry.get", json!({"book": book, "id": owner}))["parent"].clone();
    call(
        &lib,
        "entry.move",
        json!({"book": book, "id": owner, "parent": parent, "index": 1}),
    );
    wait(cx, "whole_book reload", |cx| {
        whole.read_with(cx, |w, _| w.editor().entity_id() != initial_prose_id)
    });

    let reloaded_doc = whole.read_with(cx, |w, _| w.chapter_docs().next().unwrap().to_owned());
    let added_after_reload = agent_append_to_doc(&lib, &reloaded_doc, 2);
    wait(cx, "whole_book agent_2", |cx| {
        whole.read_with(cx, |w, cx| {
            w.editor().read(cx).book().chapters[0]
                .doc
                .plain_text()
                .contains(&added_after_reload)
        })
    });
    assert!(
        whole
            .read_with(cx, |w, cx| w.editor().read(cx).commit_playback(cx))
            .is_some(),
        "whole-book view must preserve CommitPlaybackOptions across reload"
    );

    lib.close();
}
