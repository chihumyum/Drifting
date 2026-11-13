use super::{EntryHistoryDialog, HistoryEvent, api};
use dr_i18n::{Locale, Platform};
use dr_workspace::{Actor, Workspace};
use gpui::{
    AppContext as _, Context, Entity, Focusable as _, IntoElement, ParentElement as _, Render,
    Styled as _, TestAppContext, VisualTestContext, Window, div,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

pub(crate) fn setup() -> (tempfile::TempDir, Workspace, api::EntryIn) {
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "test").unwrap();
    let rows = ws
        .call(&Actor::User, "entry.list", json!({"book":book,"all":true}))
        .unwrap();
    let entry = rows["output"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (dir, ws, api::EntryIn { book, entry })
}
pub(crate) fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn settle(d: &Entity<EntryHistoryDialog>, cx: &mut VisualTestContext) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        cx.update(|w, cx| {
            w.simulate_next_frame(cx);
            w.draw(cx).clear(cx);
        });
        if !d.read_with(cx, |d, _| d.busy) {
            break;
        }
        assert!(Instant::now() < deadline, "history task did not settle");
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[gpui::test]
fn preview_confirmation_and_failed_restore_preserve_author_input_and_require_fresh_selection(
    cx: &mut TestAppContext,
) {
    cx.executor().allow_parking();
    let (_dir, ws, target) = setup();
    let point = ws
        .run::<api::Create>(&Actor::User, target.clone())
        .unwrap()
        .output
        .id;
    let book = target.book.clone();
    let entry = target.entry.clone();
    let library = ws.clone();
    let (d, cx) = cx.add_window_view(move |_, cx| {
        EntryHistoryDialog::new(
            library,
            target,
            "History".into(),
            Locale::En,
            Platform::Mac,
            cx,
        )
    });
    settle(&d, cx);
    d.update(cx, |d, cx| d.select(point.clone(), cx));
    settle(&d, cx);
    d.update(cx, |d, cx| d.restore(cx));
    assert!(d.read_with(cx, |d, _| d.confirming));
    call(
        &ws,
        "module.set_prose",
        json!({"book":book,"owner":entry,"module":"mod-prose","paragraphs":[{"text":"Author input after preview"}]}),
    );
    d.update(cx, |d, cx| d.restore(cx));
    settle(&d, cx);
    assert!(d.read_with(cx, |d, _| d.error.is_some()
        && d.preview.as_ref().is_some_and(|p| p.point.id == point)
        && !d.confirming));
    assert_eq!(
        call(
            &ws,
            "module.read_prose",
            json!({"book":book,"owner":entry,"module":"mod-prose"})
        )["paragraphs"][0]["text"],
        "Author input after preview"
    );
    d.update(cx, |d, cx| d.select(point.clone(), cx));
    settle(&d, cx);
    d.update(cx, |d, cx| d.restore(cx));
    assert!(!d.read_with(cx, |d, _| d.busy));
    d.update(cx, |d, cx| d.restore(cx));
    settle(&d, cx);
    assert!(d.read_with(cx, |d, _| d.error.is_none()
        && d.restored
        && d.preview.is_none()));
    assert_eq!(
        call(
            &ws,
            "entry_snapshot.list",
            json!({"book":book,"entry":entry})
        )
        .as_array()
        .unwrap()
        .len(),
        2
    );
    // The before checkpoint can actually recover the refused author's text.
    ws.undo(&Actor::User).unwrap();
    assert_eq!(
        call(
            &ws,
            "module.read_prose",
            json!({"book":book,"owner":entry,"module":"mod-prose"})
        )["paragraphs"][0]["text"],
        "Author input after preview"
    );
}

struct Host {
    field: Entity<dr_ui::input::TextField>,
    dialog: Entity<EntryHistoryDialog>,
}
impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .child(self.field.clone())
            .child(self.dialog.clone())
    }
}
#[gpui::test]
fn modal_owns_keyboard_and_blocks_close_while_writing(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_dir, ws, target) = setup();
    cx.update(|cx| cx.bind_keys(dr_ui::input::field::bindings()));
    let (host, cx) = cx.add_window_view(move |window, cx| {
        let field = cx
            .new(|cx| dr_ui::input::TextField::new("under-history", window, cx).with_text("Draft"));
        field.focus_handle(cx).focus(window, cx);
        let dialog = cx.new(|cx| {
            EntryHistoryDialog::new(ws, target, "History".into(), Locale::En, Platform::Mac, cx)
        });
        dialog.focus_handle(cx).focus(window, cx);
        Host { field, dialog }
    });
    let (field, dialog) = host.read_with(cx, |h, _| (h.field.clone(), h.dialog.clone()));
    settle(&dialog, cx);
    cx.simulate_input("must not enter the draft");
    cx.simulate_keystrokes("cmd-z");
    assert_eq!(field.read_with(cx, |f, _| f.text()), "Draft");
    let closed = std::rc::Rc::new(std::cell::Cell::new(0));
    let seen = closed.clone();
    host.update(cx, |_, cx| {
        cx.subscribe(&dialog, move |_, _, e, _| {
            if *e == HistoryEvent::Close {
                seen.set(seen.get() + 1)
            }
        })
        .detach()
    });
    dialog.update(cx, |d, cx| {
        d.busy = true;
        d.close(cx);
    });
    assert_eq!(closed.get(), 0);
    dialog.update(cx, |d, cx| {
        d.busy = false;
        d.close(cx);
    });
    assert_eq!(closed.get(), 1);
}

fn wait_until(
    d: &Entity<EntryHistoryDialog>,
    cx: &mut VisualTestContext,
    what: &str,
    done: impl Fn(&EntryHistoryDialog) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        cx.update(|w, cx| {
            w.simulate_next_frame(cx);
            w.draw(cx).clear(cx);
        });
        if d.read_with(cx, |d, _| !d.busy && done(d)) {
            return;
        }
        assert!(Instant::now() < deadline, "history timed out: {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[gpui::test]
fn checkpoints_refresh_open_dialog_and_thinning_clears_removed_preview(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_dir, ws, target) = setup();
    let book = target.book.clone();
    let entry = target.entry.clone();
    let library = ws.clone();
    let opened = target.clone();
    let (d, cx) = cx.add_window_view(move |_, cx| {
        EntryHistoryDialog::new(
            library,
            opened,
            "History".into(),
            Locale::En,
            Platform::Mac,
            cx,
        )
    });
    wait_until(&d, cx, "initial empty list", |d| {
        d.points().is_some_and(<[api::Point]>::is_empty)
    });

    // A checkpoint saved outside the dialog updates the open list on its own.
    let p1 = ws
        .run::<api::Create>(&Actor::User, target.clone())
        .unwrap()
        .output
        .id;
    wait_until(&d, cx, "first checkpoint arrives", |d| {
        d.points()
            .is_some_and(|pts| pts.len() == 1 && pts[0].id == p1)
    });

    // Selecting p1 opens its preview; a newer checkpoint refreshes the list
    // without closing the preview of p1.
    d.update(cx, |d, cx| d.select(p1.clone(), cx));
    settle(&d, cx);
    assert!(d.read_with(cx, |d, _| {
        d.preview.as_ref().is_some_and(|p| p.point.id == p1)
    }));

    call(
        &ws,
        "module.set_prose",
        json!({"book":book,"owner":entry,"module":"mod-prose","paragraphs":[{"text":"Draft two"}]}),
    );
    let auto = ws
        .run::<api::Capture>(
            &Actor::User,
            api::CaptureIn {
                target: target.clone(),
                reason: api::CaptureReason::Close,
            },
        )
        .unwrap()
        .output
        .id;
    wait_until(
        &d,
        cx,
        "automatic capture arrives while preview is open",
        |d| {
            d.points()
                .is_some_and(|pts| pts.len() == 2 && pts.iter().any(|pt| pt.id == auto))
        },
    );
    assert!(
        d.read_with(cx, |d, _| {
            d.preview.as_ref().is_some_and(|p| p.point.id == p1)
        }),
        "an un-thinned preview stays open across list refresh"
    );

    // Select the automatic point, then thin it from checkpoints:<book>: the
    // open dialog refreshes and drops the stale preview.
    d.update(cx, |d, cx| d.select(auto.clone(), cx));
    settle(&d, cx);
    assert!(d.read_with(cx, |d, _| {
        d.preview.as_ref().is_some_and(|p| p.point.id == auto)
    }));
    let book_id = book.parse().unwrap();
    let removed = auto.clone();
    ws.library()
        .open_doc(&format!("checkpoints:{book}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::Command, move |doc| {
            dr_doc::side::BorrowedCheckpoints::new(doc, &book_id)
                .unwrap()
                .txn()
                .remove_entry_checkpoint(&removed)
                .unwrap()
        })
        .unwrap();
    wait_until(&d, cx, "thinned point leaves the open dialog", |d| {
        d.points()
            .is_some_and(|pts| pts.len() == 1 && pts[0].id == p1)
    });
    assert!(
        d.read_with(cx, |d, _| d.selected.is_none() && d.preview.is_none()),
        "removing the previewed checkpoint clears its selection and preview"
    );
    ws.close();
}

#[gpui::test]
fn writing_days_and_other_books_checkpoints_do_not_wake_the_dialog(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (_dir, ws, target) = setup();
    ws.run::<api::Create>(&Actor::User, target.clone()).unwrap();
    let book = target.book.clone();
    let library = ws.clone();
    let (d, cx) = cx.add_window_view(move |_, cx| {
        EntryHistoryDialog::new(
            library,
            target,
            "History".into(),
            Locale::En,
            Platform::Mac,
            cx,
        )
    });
    wait_until(&d, cx, "initial point loaded", |d| {
        d.points().is_some_and(|pts| pts.len() == 1)
    });
    let before = d.read_with(cx, |d, _| d.reads());

    // Recording writing days in stats:<book> must not wake the history dialog.
    for words in [240, 510] {
        call(
            &ws,
            "writing_day.record",
            json!({"book":book,"device":"device-000000000000000000000002","day":"2026-11-12","words":words}),
        );
    }
    // Saving checkpoints in another book must not wake this book's dialog.
    let other_book = call(&ws, "project.create", json!({"name":"Other"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let other_root = call(&ws, "entry.list", json!({"book":other_book,"all":true}))
        .as_array()
        .unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    ws.run::<api::Create>(
        &Actor::User,
        api::EntryIn {
            book: other_book,
            entry: other_root,
        },
    )
    .unwrap();

    for _ in 0..15 {
        cx.run_until_parked();
        cx.update(|w, cx| {
            w.simulate_next_frame(cx);
            w.draw(cx).clear(cx);
        });
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        d.read_with(cx, |d, _| d.reads()),
        before,
        "neither writing days nor another book's checkpoints make the dialog read again"
    );
    ws.close();
}

#[test]
fn preview_shows_each_body_once_by_its_module_name() {
    let (_dir, ws, target) = setup();
    let book = target.book.clone();
    // A second body on the chapter template, written before the point.
    let templates = call(&ws, "entry_template.list", json!({"book":book}));
    let mut module = templates
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == "tpl-chapter")
        .unwrap()["modules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "mod-prose")
        .unwrap()
        .clone();
    module["id"] = json!("synthetic-aside");
    module["name"] = json!("Synthetic aside");
    module["config"]["in_book"] = json!(false);
    call(
        &ws,
        "entry_template.put_module",
        json!({"book":book,"template":"tpl-chapter","module":module}),
    );
    call(
        &ws,
        "module.set_prose",
        json!({"book":book,"owner":target.entry,"module":"synthetic-aside","paragraphs":[{"text":"Synthetic aside text"}]}),
    );
    let point = call(
        &ws,
        "entry_snapshot.create",
        json!({"book":book,"entry":target.entry}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let preview = ws
        .run::<api::Preview>(&Actor::User, api::PointIn { target, point })
        .unwrap()
        .output;
    assert!(preview.bodies.len() >= 2);
    let sections = super::preview_sections(&preview);
    assert!(!sections.iter().any(|(title, _)| title.starts_with("body:")));
    let shown: Vec<_> = sections
        .iter()
        .filter(|(t, _)| t == "Synthetic aside")
        .collect();
    assert_eq!(shown.len(), 1);
    assert!(shown[0].1.contains("Synthetic aside text"));
}
