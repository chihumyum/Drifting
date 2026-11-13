//! A library swap (dr-shell's `library::replace`) closes the library right
//! after the shell has dropped the search panel, and the executor may not
//! have run since: GPUI drops a cancelled task's future only when its
//! executor next runs it, and on the test platform the close itself sits on
//! that executor. The panel's tasks are still waiting then, and must not be
//! what keeps the library open.

use std::rc::Rc;

use dr_i18n::{Locale, Platform};
use dr_testkit::seed::{self, Preset};
use dr_view_search::SearchPanel;
use dr_workspace::Workspace;
use gpui::{AppContext as _, Entity, IntoElement, Render, TestAppContext};

/// Holds the panel the way the shell does, without drawing it.
struct Host {
    panel: Option<Entity<SearchPanel>>,
}

impl Render for Host {
    fn render(&mut self, _: &mut gpui::Window, _: &mut gpui::Context<Self>) -> impl IntoElement {
        gpui::div()
    }
}

#[gpui::test]
fn a_dropped_panel_lets_go_of_the_library_before_its_tasks_run_again(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    let made = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let book = made.books[0].book_id().to_string();
    made.write_to(ws.library()).unwrap();
    let lib = ws.clone();
    let (host, cx) = cx.add_window_view(move |window, cx| Host {
        panel: Some(cx.new(|cx| {
            SearchPanel::new_v3(
                Some(lib),
                book,
                Rc::new(|_| (dr_ui::sand::Kind::Element, None)),
                Locale::En,
                Platform::Mac,
                window,
                cx,
            )
        })),
    });
    // The event task is waiting for the library's events.
    cx.run_until_parked();
    // A search the executor has not started.
    host.update(cx, |h, cx| {
        h.panel
            .as_ref()
            .unwrap()
            .update(cx, |p, cx| p.set_query("the", cx))
    });
    assert!(host.read_with(cx, |h, cx| {
        h.panel.as_ref().unwrap().read(cx).is_searching()
    }));
    // The shell lets go of the panel (`Workspace::let_go_of_library`), and
    // the swap closes the library with no executor step in between: both
    // tasks are dropped but not yet run. Holding the library, either of
    // them made this close spin and give up.
    host.update(cx, |h, _| h.panel = None);
    let closed = ws.try_shutdown();
    assert!(
        closed.is_ok(),
        "the dropped panel still held the library: {closed:?}"
    );
}
