//! M31 uses the existing F4d layer: real runtime settlements reach an already
//! open editor. These assert mark kinds, painted ranges and pointer fading;
//! they do not claim pixel colour measurements or a typewriter animation.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dr_agent::driver::scripted::{ScriptedDriver, Step};
use dr_agent::{
    DriverEvent, Event, FinishReason, Options, Provider, RunConfig, Runtime, Start, State,
    ToolCall, ToolStatus, events,
};
use dr_editor::decor::{AgentMarks, DecorLooks, Mark, MarkKind};
use dr_editor::{ChapterEditor, EditorSettings};
use dr_model::id::ConversationId;
use dr_testkit::seed::{self, Preset};
use dr_ui::tokens::Palette;
use dr_view_agent::tools::CompanionTools;
use dr_workspace::{Actor, Workspace};
use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext, hsla, px, size};
use gpui_prose::ProseEditor;
use gpui_prose::render::DecorationEvent;
use serde_json::{Value, json};

fn author(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

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

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn advance(cx: &mut VisualTestContext, duration: Duration) {
    cx.executor().advance_clock(duration);
    draw(cx);
}

fn wait(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        advance(cx, Duration::from_millis(20));
        if done(cx) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "runtime ink did not reach the open editor"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn marks(ledger: &Entity<AgentMarks>, doc: &str, cx: &VisualTestContext) -> Vec<Mark> {
    ledger.read_with(cx, |ledger, _| ledger.marks(doc).to_vec())
}

fn change_first(text: &str, corpus: &str) -> String {
    let first = text.chars().next().unwrap();
    let replacement = corpus
        .chars()
        .find(|c| !c.is_whitespace() && *c != first)
        .unwrap();
    format!("{replacement}{}", text.chars().skip(1).collect::<String>())
}

#[gpui::test]
fn runtime_and_mirror_changes_are_painted_and_pointer_touch_persists_seen(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "m31-ink-test").unwrap();
    ws.set_auto_links(false);
    let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    seeded.write_to(ws.library()).unwrap();
    let book = seeded.books[0].book_id().clone();
    let chapters = author(&ws, "chapter.list", json!({"book":book}));
    // Short excerpts of three shared-seed paragraphs keep all changed ranges
    // inside one viewport. No separate prose corpus is introduced here.
    let text: Vec<String> = seeded.books[0]
        .prose
        .iter()
        .flat_map(|doc| doc.view().paragraphs())
        .map(|paragraph| paragraph.text())
        .filter(|text| text.chars().count() >= 12)
        .take(3)
        .map(|text| text.chars().take(12).collect())
        .collect();
    assert_eq!(text.len(), 3);
    let chapter = author(
        &ws,
        "chapter.create",
        json!({
            "book":book,"title":chapters[0]["title"],"text":text.join("\n")
        }),
    );
    let doc = format!("node:{}", chapter["id"].as_str().unwrap());
    let prose = author(&ws, "prose.read", json!({"doc":doc}));
    let (opened_ws, opened_book, opened_doc) = (ws.clone(), book.to_string(), doc.clone());
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut editor = ChapterEditor::open(
            opened_ws,
            &opened_book,
            &opened_doc,
            EditorSettings::default(),
            window,
            cx,
        )
        .unwrap();
        editor.set_decor_looks(
            DecorLooks::new(&Palette::LIGHT, hsla(0.58, 0.7, 0.42, 1.), false),
            cx,
        );
        editor
    });
    cx.simulate_resize(size(px(900.), px(700.)));
    let editor: Entity<ProseEditor> = view.read_with(cx, |view, _| view.editor().clone());
    let ledger = cx.update(|_, cx| AgentMarks::of(&ws, cx));
    draw(cx);
    assert!(marks(&ledger, &doc, cx).is_empty());

    let added: String = text[2].chars().take(3).collect();
    let new_text = format!("{}{added}", text[0]);
    let changed_text = change_first(&text[1], &text[2]);
    let driver = Arc::new(ScriptedDriver::new(vec![
        round("read-new", "prose.read", json!({"doc":doc})),
        round(
            "write-new",
            "prose.replace",
            json!({
                "doc":doc,"block_id":prose["paragraphs"][0]["block_id"],"find":text[0],"replace":new_text
            }),
        ),
        round("read-change", "prose.read", json!({"doc":doc})),
        round(
            "write-change",
            "prose.replace",
            json!({
                "doc":doc,"block_id":prose["paragraphs"][1]["block_id"],"find":text[1],"replace":changed_text
            }),
        ),
        vec![
            Step::Event(DriverEvent::TextDelta {
                index: 0,
                text: text[0].clone(),
            }),
            Step::Event(DriverEvent::Finish(FinishReason::Complete)),
        ],
    ]));
    let runtime = Runtime::new(
        ws.clone(),
        driver,
        Arc::new(CompanionTools::default()),
        Options::default(),
    )
    .unwrap();
    let run = runtime
        .start(Start {
            config: RunConfig::new(Provider::Openai, "synthetic-model"),
            book: book.clone(),
            conversation: ConversationId::new_v7(),
            input: text[0].clone(),
        })
        .unwrap();
    let session = run.session.clone();
    let finished = Rc::new(RefCell::new(None));
    let result = finished.clone();
    cx.update(|_, cx| {
        cx.spawn(async move |_| *result.borrow_mut() = Some(run.finish().await))
            .detach();
    });
    wait(cx, |_| finished.borrow().is_some());
    assert!(matches!(
        finished.borrow().as_ref(),
        Some(Ok(State::Completed))
    ));
    let receipts = ws.library().settlements(Some(&session), None).unwrap();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].doc_id, doc);
    assert_eq!(receipts[1].doc_id, doc);
    assert_eq!(receipts[0].call, "write-new");
    assert_eq!(receipts[1].call, "write-change");
    let statuses: Vec<_> = events(ws.library(), &session, 0)
        .unwrap()
        .into_iter()
        .filter_map(|row| match row.event {
            Event::ToolFinished { result } => Some(result.status),
            _ => None,
        })
        .collect();
    assert_eq!(statuses, vec![ToolStatus::Success; 4]);
    wait(cx, |cx| {
        let marks = marks(&ledger, &doc, cx);
        marks.iter().any(|m| m.kind == MarkKind::New)
            && marks.iter().any(|m| m.kind == MarkKind::Changed)
    });

    // An actual F3 mirror-origin write uses the same open editor, without an
    // Agent receipt. This is the M40 blue-ink entry point, not a forged mark.
    let external_text = change_first(&text[2], &text[0]);
    ws.call(&Actor::Mirror, "prose.replace", json!({
        "doc":doc,"block_id":prose["paragraphs"][2]["block_id"],"find":text[2],"replace":external_text
    })).unwrap();
    wait(cx, |cx| {
        let marks = marks(&ledger, &doc, cx);
        marks.len() == 3
            && marks.iter().all(|mark| {
                editor.read_with(cx, |editor, _| {
                    editor
                        .painted_decoration(0, "agent", &mark.id)
                        .is_some_and(|painted| !painted.boxes.is_empty())
                })
            })
    });
    advance(cx, Duration::from_millis(400));
    let current = marks(&ledger, &doc, cx);
    let new = current
        .iter()
        .find(|mark| mark.kind == MarkKind::New)
        .unwrap();
    let changed = current
        .iter()
        .find(|mark| mark.kind == MarkKind::Changed)
        .unwrap();
    let external = current
        .iter()
        .find(|mark| mark.kind == MarkKind::External)
        .unwrap();
    let added_start = text[0].chars().count();
    let changed_start = new_text.chars().count() + 1;
    let external_start = changed_start + changed_text.chars().count() + 1;
    for (mark, expected) in [
        (new, added_start..added_start + added.chars().count()),
        (changed, changed_start..changed_start + 1),
        // Mirror events describe the range the command replaced. Agent
        // receipts instead compare before/after and trim unchanged text.
        (
            external,
            external_start..external_start + external_text.chars().count(),
        ),
    ] {
        editor.read_with(cx, |editor, _| {
            assert_eq!(
                editor.decoration_range(0, "agent", &mark.id),
                Some(expected)
            );
            assert_eq!(
                editor
                    .painted_decoration(0, "agent", &mark.id)
                    .unwrap()
                    .alpha,
                1.
            );
        });
    }
    editor.read_with(cx, |editor, _| {
        assert_eq!(
            editor.book().chapters[0].doc.plain_text(),
            format!("{new_text}\n{changed_text}\n{external_text}\n")
        );
    });
    assert_eq!(
        ws.library()
            .settlements(Some(&session), None)
            .unwrap()
            .len(),
        2
    );

    let touched = Rc::new(RefCell::new(Vec::new()));
    let observed = touched.clone();
    cx.update(|_, cx| {
        cx.subscribe(&editor, move |_, event: &DecorationEvent, _| {
            observed.borrow_mut().push(event.clone())
        })
        .detach();
    });
    let at = editor.read_with(cx, |editor, _| {
        editor
            .painted_decoration(0, "agent", &new.id)
            .unwrap()
            .boxes[0]
            .center()
    });
    let version = ws.observe(&doc).unwrap().version;
    cx.simulate_mouse_move(at, None, Modifiers::default());
    draw(cx);
    assert!(touched.borrow().iter().any(|event| matches!(event,
        DecorationEvent::Touched {chapter:0,key} if key.group == "agent" && key.id.as_ref() == new.id
    )));
    advance(cx, Duration::from_millis(150));
    let fading = editor.read_with(cx, |editor, _| {
        editor
            .painted_decoration(0, "agent", &new.id)
            .unwrap()
            .alpha
    });
    assert!(
        fading > 0. && fading < 1.,
        "touch must fade continuously: {fading}"
    );
    advance(cx, Duration::from_millis(400));
    assert!(editor.read_with(cx, |editor, _| {
        editor.painted_decoration(0, "agent", &new.id).is_none()
    }));
    assert!(
        !marks(&ledger, &doc, cx)
            .iter()
            .any(|mark| mark.id == new.id)
    );
    assert!(
        marks(&ledger, &doc, cx)
            .iter()
            .any(|mark| mark.id == changed.id)
    );
    assert!(
        marks(&ledger, &doc, cx)
            .iter()
            .any(|mark| mark.id == external.id)
    );
    let persisted: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("agent-marks.json")).unwrap())
            .unwrap();
    assert!(
        persisted["docs"][&doc]
            .as_array()
            .unwrap()
            .iter()
            .all(|mark| mark["id"] != new.id)
    );
    assert_eq!(
        ws.observe(&doc).unwrap().version,
        version,
        "pointer fading does not edit prose"
    );
    drop(runtime);
    ws.close();
}
