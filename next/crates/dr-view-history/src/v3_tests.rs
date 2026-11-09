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
