//! The real Runtime's persisted write reaches an opt-in editor player.
//! All text comes from F8's seed; the model is a scripted in-process driver.
use std::{
    cell::RefCell,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use dr_agent::driver::scripted::{ScriptedDriver, Step};
use dr_agent::{
    DriverEvent, FinishReason, Options, Provider, RunConfig, Runtime, Start, State, ToolCall,
};
use dr_agent_tools::AgentTools;
use dr_editor::{ChapterEditor, CommitPlaybackOptions, EditorSettings};
use dr_model::id::ConversationId;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use gpui::{EntityInputHandler, TestAppContext};
use serde_json::{Value, json};

fn round(id: &str, name: &str, arguments: Value) -> Vec<Step> {
    vec![
        Step::Event(DriverEvent::ToolCall(ToolCall {
            id: id.into(),
            name: "call_tool".into(),
            arguments: json!({"name":name,"arguments":arguments}),
        })),
        Step::Event(DriverEvent::Finish(FinishReason::Tools)),
    ]
}

#[gpui::test]
fn runtime_commit_is_durable_before_reveal_and_input_finishes_without_rewriting(
    cx: &mut TestAppContext,
) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "f4-playback-test").unwrap();
    ws.set_auto_links(false);
    let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    seeded.write_to(ws.library()).unwrap();
    let book = seeded.books[0].book_id().clone();
    let chapters = ws
        .call(&Actor::User, "chapter.list", json!({"book":book}))
        .unwrap()["output"]
        .clone();
    let doc = format!("node:{}", chapters[0]["id"].as_str().unwrap());
    let prose = ws
        .call(&Actor::User, "prose.read", json!({"doc":doc}))
        .unwrap()["output"]
        .clone();
    let paragraph = prose["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["text"].as_str().is_some_and(|s| s.chars().count() > 10))
        .unwrap();
    let original = paragraph["text"].as_str().unwrap().to_owned();
    let addition: String = original.chars().take(4).collect();
    let replacement = format!("{original}{addition}");
    let (opened_ws, opened_book, opened_doc) = (ws.clone(), book.to_string(), doc.clone());
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut view = ChapterEditor::open(
            opened_ws,
            &opened_book,
            &opened_doc,
            EditorSettings::default(),
            window,
            cx,
        )
        .unwrap();
        view.set_decor_looks(
            dr_editor::decor::DecorLooks::new(
                &dr_ui::tokens::Palette::LIGHT,
                gpui::hsla(0.58, 0.7, 0.42, 1.),
                false,
            ),
            cx,
        );
        view.editor().update(cx, |e, cx| {
            let mut options = CommitPlaybackOptions::new("agent:");
            options.grapheme_interval = Duration::from_secs(1);
            options.max_duration = Duration::from_secs(5);
            e.set_commit_playback(Some(options), cx);
        });
        view
    });
    cx.run_until_parked();
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    let driver = Arc::new(ScriptedDriver::new(vec![
        round("read", "prose.read", json!({"doc":doc})),
        round(
            "write",
            "prose.replace",
            json!({"doc":doc,
            "block_id":paragraph["block_id"],"find":original,"replace":replacement}),
        ),
        vec![Step::Event(DriverEvent::Finish(FinishReason::Complete))],
    ]));
    let runtime = Runtime::new(
        ws.clone(),
        driver,
        Arc::new(AgentTools::default()),
        Options::default(),
    )
    .unwrap();
    let run = runtime
        .start(Start {
            config: RunConfig::new(Provider::Openai, "synthetic-model"),
            book,
            conversation: ConversationId::new_v7(),
            input: original,
        })
        .unwrap();
    let session = run.session.clone();
    let finished = Rc::new(RefCell::new(None));
    let result = finished.clone();
    cx.update(|_, cx| {
        cx.spawn(async move |_| *result.borrow_mut() = Some(run.finish().await))
            .detach();
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        cx.run_until_parked();
        if finished.borrow().is_some()
            && editor.read_with(cx, |e, cx| e.commit_playback(cx).is_some())
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "runtime/player did not finish: {:?}",
            finished.borrow()
        );
        cx.executor().advance_clock(Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(matches!(
        finished.borrow().as_ref(),
        Some(Ok(State::Completed))
    ));
    let receipts = ws.library().settlements(Some(&session), None).unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].doc_id, doc);
    let version = ws.observe(&doc).unwrap().version;
    let persisted = ws
        .call(&Actor::User, "prose.read", json!({"doc":doc}))
        .unwrap();
    assert!(
        persisted["output"]["paragraphs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["text"] == replacement)
    );
    editor.read_with(cx, |e, cx| {
        let status = e.commit_playback(cx).unwrap();
        assert!(status.revealed_graphemes < status.graphemes);
        assert!(e.book().chapters[0].doc.plain_text().contains(&replacement));
    });
    // Halfway: the same complete durable text, and an advancing paint frontier.
    cx.executor().advance_clock(Duration::from_millis(1100));
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(editor.read_with(
        cx,
        |e, cx| e.commit_playback(cx).unwrap().revealed_graphemes > 0
    ));
    assert_eq!(ws.observe(&doc).unwrap().version, version);
    editor.update_in(cx, |e, window, cx| {
        e.replace_and_mark_text_in_range(None, "ni", None, window, cx);
        assert!(e.commit_playback(cx).is_none());
    });
    // Starting an IME overlay is not a persisted edit or a replayed commit.
    assert_eq!(ws.observe(&doc).unwrap().version, version);
    assert_eq!(
        ws.library()
            .settlements(Some(&session), None)
            .unwrap()
            .len(),
        1
    );
}
