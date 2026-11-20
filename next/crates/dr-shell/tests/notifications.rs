//! The notification center's read state (0.1's `setCenterOpen`): opening it
//! reads what it lists, closing it reads what arrived while it was open,
//! whatever the source and however it closes. The account notices
//! (`dr_view_account::notices`) take the account's read mark from this.

use dr_shell::notifications::{Notifications, Source};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_testkit::seed::{self, Preset};
use dr_workspace::Workspace as Library;
use gpui::{TestAppContext, VisualTestContext};

const VERSION: &str = "notifications-read-test";

#[gpui::test]
fn opening_reads_what_is_listed_and_closing_reads_what_arrived_meanwhile(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let made = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let lib = Library::open_dir(dir.path(), VERSION).unwrap();
    made.write_to(lib.library()).unwrap();
    cx.update(|cx| {
        let _ = dr_ui::init(cx);
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    let unread = |cx: &mut VisualTestContext| {
        cx.run_until_parked();
        cx.update(|_, cx| Notifications::unread(cx))
    };
    let post = |cx: &mut VisualTestContext, text: &'static str| {
        cx.update(|_, cx| Notifications::post(Source::Update, text, cx));
    };

    post(cx, "before");
    assert!(unread(cx));
    // Opening reads what is listed.
    view.update(cx, |ws, cx| {
        ws.notifications_open = true;
        cx.notify();
    });
    assert!(!unread(cx));
    // What arrives while it is open stays unread until it closes …
    post(cx, "while open");
    assert!(unread(cx));
    view.update(cx, |_, cx| cx.notify());
    assert!(unread(cx), "a change that leaves it open reads nothing");
    // … by Esc,
    assert!(view.update_in(cx, |ws, window, cx| ws.dismiss(window, cx)));
    assert!(!unread(cx));
    // and what arrives while it is closed waits for the next opening.
    post(cx, "after");
    view.update(cx, |_, cx| cx.notify());
    assert!(unread(cx));
    view.update(cx, |ws, cx| {
        ws.notifications_open = true;
        cx.notify();
    });
    assert!(!unread(cx));
    // Closed by opening something else over it (settings), too.
    post(cx, "while open again");
    assert!(unread(cx));
    view.update_in(cx, |ws, window, cx| ws.open_settings(window, cx));
    assert!(!view.read_with(cx, |ws, _| ws.notifications_open));
    assert!(!unread(cx));
}
