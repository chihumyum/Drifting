//! The page the window shows when the library could not be opened at
//! start-up (`dr_shell::library_failure`), with stand-ins for the bookshelf,
//! the first run, the import's offer, the feedback dialog and the update
//! button:
//!
//! - no bookshelf, no first run, no import offer, whether the first run has
//!   been done or not;
//! - the three lines for each cause (no second line for an unknown cause,
//!   the kept copy for the upgraded library that does not open);
//! - the buttons, in order, each a dr-ui `Button` (a button named by its
//!   words for assistive technology): 「检查更新」 only for a library a newer
//!   version wrote;
//! - 「提交反馈」 opens the feedback dialog with the first line and the code
//!   written in; 「退出 Drifting」 quits through the ordinary quit flow;
//! - a library that opens shows no page.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;

use dr_i18n::Locale;
use dr_shell::actions::SendFeedback;
use dr_shell::dialogs::FeedbackOpening;
use dr_shell::library_failure::{self as page, Cause, LibraryFailure, PageButton, UpdateButton};
use dr_shell::strings::Strings;
use dr_shell::workspace::FIRST_RUN_DONE;
use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace, pages, quit};
use dr_testkit::seed::{self, Preset};
use dr_workspace::Workspace as Library;
use gpui::{
    AppContext as _, Entity, Modifiers, Render, TestAppContext, VisualTestContext, Window, div,
};

const VERSION: &str = "library-failure-test";

struct Blank;

impl Render for Blank {
    fn render(&mut self, _: &mut Window, _: &mut gpui::Context<Self>) -> impl gpui::IntoElement {
        div()
    }
}

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: VERSION,
        url_scheme: "drifting-next-dev",
        forced_appearance: None,
    }
}

fn failure(cause: Cause, code: &str) -> LibraryFailure {
    LibraryFailure {
        cause,
        code: code.into(),
        folder: Some(PathBuf::from("/Users/example/Library/Drifting/library")),
    }
}

/// How often the stand-ins were reached.
#[derive(Default)]
struct Seen {
    shelves: Cell<usize>,
    first_runs: Cell<usize>,
    after_first_run: Cell<usize>,
    updates: Cell<usize>,
    quits: Cell<usize>,
    feedback: RefCell<Vec<FeedbackOpening>>,
}

/// The shell in Simplified Chinese, with `services`, and every stand-in.
fn setup(cx: &mut TestAppContext, services: Services) -> Rc<Seen> {
    cx.executor().allow_parking();
    let seen = Rc::new(Seen::default());
    cx.update(|cx| {
        let _ = dr_ui::init(cx);
        dr_shell::init(info(), services, SettingsFile::in_memory(), cx);
        Strings::install(Locale::ZhCn, cx);
        let s = seen.clone();
        pages::set_shelf(cx, move |_, _, cx| {
            s.shelves.set(s.shelves.get() + 1);
            pages::ShelfPage {
                view: cx.new(|_| Blank).into(),
                bell: None,
            }
        });
        let s = seen.clone();
        pages::set_first_run(cx, move |_, _, cx| {
            s.first_runs.set(s.first_runs.get() + 1);
            pages::FirstRunPage {
                view: cx.new(|_| Blank).into(),
                shows_shelf: Rc::new(|_| false),
            }
        });
        // The import offers itself through this (dr-view-import).
        let s = seen.clone();
        pages::after_first_run(cx, move |_, _| {
            s.after_first_run.set(s.after_first_run.get() + 1)
        });
        let s = seen.clone();
        dr_shell::dialogs::set_feedback(cx, move |opening, _, _, cx| {
            s.feedback.borrow_mut().push(opening);
            cx.new(|_| Blank).into()
        });
        let s = seen.clone();
        page::set_update_button(cx, move |cx| {
            let s = s.clone();
            Some(UpdateButton {
                label: dr_shell::t(cx, dr_i18n::keys::settings::update::CHECK_ACTION),
                busy: false,
                run: Some(Rc::new(move |_| s.updates.set(s.updates.get() + 1))),
            })
        });
        let s = seen.clone();
        quit::before_quit(cx, move |_| s.quits.set(s.quits.get() + 1));
    });
    seen
}

fn open(cx: &mut TestAppContext) -> (Entity<Workspace>, &mut VisualTestContext) {
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    draw(cx);
    (view, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

fn click(id: &'static str, cx: &mut VisualTestContext) {
    draw(cx);
    let at = cx.debug_bounds(id).expect(id).center();
    cx.simulate_mouse_move(at, None, Modifiers::default());
    cx.simulate_click(at, Modifiers::default());
    cx.run_until_parked();
}

/// The words the page shows, in order, as drawn.
fn shown(cx: &mut VisualTestContext) -> Vec<&'static str> {
    [
        "library-failure-heading",
        "library-failure-second",
        "library-failure-what-to-do",
    ]
    .into_iter()
    .filter(|id| cx.debug_bounds(id).is_some())
    .collect()
}

/// The buttons as drawn, left to right, with their words.
fn drawn_buttons(cx: &mut VisualTestContext) -> Vec<(PageButton, String)> {
    let all = [
        PageButton::Update,
        PageButton::Reveal,
        PageButton::Feedback,
        PageButton::Quit,
    ];
    let mut out: Vec<_> = all
        .into_iter()
        .filter_map(|b| cx.debug_bounds(b.id()).map(|bounds| (bounds.left(), b)))
        .collect();
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut last_top = None;
    for (_, b) in &out {
        // One row: every button on the same line.
        let top = cx.debug_bounds(b.id()).unwrap().top();
        assert_eq!(*last_top.get_or_insert(top), top, "{b:?} is on the row");
    }
    out.into_iter()
        .map(|(_, b)| (b, cx.update(|_, cx| page::button_label(b, cx).to_string())))
        .collect()
}

const HEADING: &str = "没能打开资料库";
const UNCHANGED: &str = "资料库没有改动。";
const KEPT: &str = "升级前的资料库另外存了一份。";

fn expected_lines(cause: Cause) -> (Option<&'static str>, &'static str) {
    match cause {
        Cause::Newer => (
            Some(UNCHANGED),
            "它被更新版本的 Drifting 打开过，请先更新 Drifting。",
        ),
        Cause::Damaged => (
            Some(UNCHANGED),
            "资料库文件已损坏，请提交反馈，先别删这个文件夹。",
        ),
        Cause::UpgradeUnfinished => (
            Some(UNCHANGED),
            "这一版没能把它升级，请先用上一版 Drifting，并提交反馈。",
        ),
        Cause::UpgradedUnopenable => (Some(KEPT), "升级后的资料库打不开，请提交反馈。"),
        Cause::NoPermission => (
            Some(UNCHANGED),
            "Drifting 不能读写这个文件夹，请检查它的权限。",
        ),
        Cause::DiskFull => (
            Some(UNCHANGED),
            "磁盘已满，请腾出一些空间后重新打开 Drifting。",
        ),
        Cause::Unknown => (None, "请提交反馈。"),
    }
}

#[gpui::test]
fn the_page_replaces_the_bookshelf_for_every_cause_whether_or_not_the_first_run_was_done(
    cx: &mut TestAppContext,
) {
    let seen = setup(
        cx,
        Services {
            library_failure: Some(failure(Cause::Newer, "schema-newer")),
            ..Services::default()
        },
    );
    let mut pages_seen = Vec::new();
    for first_run_done in [false, true] {
        cx.update(|cx| {
            Settings::set_device_memory(cx, FIRST_RUN_DONE, first_run_done.then(|| true.into()))
        });
        for cause in Cause::ALL {
            cx.update(|cx| {
                cx.global_mut::<Services>().library_failure = Some(failure(cause, "a-code"));
            });
            let (view, cx) = open(cx);
            view.read_with(cx, |ws, cx| {
                assert_eq!(ws.library_failure(cx).map(|f| f.cause), Some(cause));
                assert!(!ws.shelf_open, "{cause:?}: no bookshelf");
                assert!(ws.shelf.is_none(), "{cause:?}: no bookshelf made");
                assert!(!ws.sea.first_run_shows(), "{cause:?}: no first run");
                assert!(ws.dialog.is_none(), "{cause:?}: no dialog by itself");
            });

            // The lines.
            let lines = cx.update(|_, cx| page::lines(cause, cx));
            let (second, what_to_do) = expected_lines(cause);
            assert_eq!(lines.heading.as_ref(), HEADING);
            assert_eq!(lines.second.as_ref().map(|s| s.as_ref()), second);
            assert_eq!(lines.what_to_do.as_ref(), what_to_do);
            let drawn = shown(cx);
            if second.is_some() {
                assert_eq!(drawn.len(), 3, "{cause:?}: {drawn:?}");
            } else {
                assert_eq!(
                    drawn,
                    ["library-failure-heading", "library-failure-what-to-do"],
                    "{cause:?}"
                );
            }

            // The buttons, in order, with the existing words.
            let buttons = drawn_buttons(cx);
            let mut expected = vec![
                (PageButton::Reveal, "在访达中打开".to_owned()),
                (PageButton::Feedback, "提交反馈".to_owned()),
                (PageButton::Quit, "退出 Drifting".to_owned()),
            ];
            if cause == Cause::Newer {
                expected.insert(0, (PageButton::Update, "检查更新".to_owned()));
            }
            if cfg!(windows) {
                expected
                    .iter_mut()
                    .find(|(b, _)| *b == PageButton::Reveal)
                    .unwrap()
                    .1 = "在文件资源管理器中打开".to_owned();
            }
            assert_eq!(buttons, expected, "{cause:?}");
            let listed = view.read_with(cx, |ws, cx| {
                page::buttons(&ws.library_failure(cx).unwrap(), cx)
            });
            assert_eq!(
                listed,
                expected.iter().map(|(b, _)| *b).collect::<Vec<_>>(),
                "{cause:?}"
            );
            pages_seen.push((first_run_done, cause, lines, buttons));
        }
    }
    // Nothing of the bookshelf or the first run was ever made, and nothing
    // waiting for a first run's end (the import's offer) ran.
    assert_eq!(seen.shelves.get(), 0);
    assert_eq!(seen.first_runs.get(), 0);
    assert_eq!(seen.after_first_run.get(), 0);
    // The same page with the first run done or not.
    let (before, after) = pages_seen.split_at(Cause::ALL.len());
    for (a, b) in before.iter().zip(after) {
        assert_eq!((a.1, &a.2, &a.3), (b.1, &b.2, &b.3));
    }
}

#[gpui::test]
fn feedback_opens_with_the_first_line_and_the_code_and_quit_quits(cx: &mut TestAppContext) {
    let seen = setup(
        cx,
        Services {
            library_failure: Some(failure(Cause::Newer, "schema-newer")),
            ..Services::default()
        },
    );
    let (view, cx) = open(cx);

    // 检查更新 does what the update service says.
    click(PageButton::Update.id(), cx);
    assert_eq!(seen.updates.get(), 1);

    click(PageButton::Feedback.id(), cx);
    let opened = seen.feedback.borrow().clone();
    assert_eq!(
        opened,
        [FeedbackOpening {
            follow_up: None,
            message: Some("没能打开资料库（schema-newer）".into()),
        }]
    );
    assert!(view.read_with(cx, |ws, _| ws.dialog.is_some()));
    // The dialog over the page; still no bookshelf under it.
    view.read_with(cx, |ws, cx| {
        assert!(!ws.shelf_open);
        assert!(ws.library_failure(cx).is_some());
    });

    // The menu's 提交反馈 opens the same once the dialog is gone.
    view.update(cx, |ws, cx| {
        ws.dialog = None;
        cx.notify();
    });
    draw(cx);
    cx.dispatch_action(SendFeedback);
    cx.run_until_parked();
    assert_eq!(seen.feedback.borrow().len(), 2);
    assert_eq!(seen.feedback.borrow()[1], opened[0]);
    view.update(cx, |ws, cx| {
        ws.dialog = None;
        cx.notify();
    });

    // Settings do not open over the page.
    view.update_in(cx, |ws, window, cx| ws.open_settings(window, cx));
    assert!(view.read_with(cx, |ws, _| ws.settings.is_none()));

    // 退出 Drifting: the ordinary quit flow, its hooks included.
    assert_eq!(seen.quits.get(), 0);
    click(PageButton::Quit.id(), cx);
    assert_eq!(seen.quits.get(), 1);
}

/// The feedback line follows the interface language's brackets.
#[gpui::test]
fn the_feedback_line_is_in_the_interface_language(cx: &mut TestAppContext) {
    setup(cx, Services::default());
    let f = failure(Cause::Damaged, "sqlite:database-corrupt");
    let lines = cx.update(|cx| {
        [Locale::ZhCn, Locale::ZhTw, Locale::En, Locale::Ja].map(|locale| {
            Strings::install(locale, cx);
            page::feedback_message(&f, cx)
        })
    });
    assert_eq!(
        lines,
        [
            "没能打开资料库（sqlite:database-corrupt）",
            "沒能開啟資料庫（sqlite:database-corrupt）",
            "Couldn't open the library (sqlite:database-corrupt)",
            "ライブラリを開けませんでした（sqlite:database-corrupt）",
        ]
    );
}

/// Every word the page shows is there in each of the nine languages, and
/// only English's is English: the lines for each cause, the four buttons
/// (「退出 Drifting」 is the tray menu's words, which had no Portuguese
/// until 2026-11-24) and the feedback line.
#[gpui::test]
fn every_word_on_the_page_is_in_each_of_the_nine_languages(cx: &mut TestAppContext) {
    setup(cx, Services::default());
    let f = failure(Cause::Damaged, "sqlite:database-corrupt");
    let buttons = [
        PageButton::Update,
        PageButton::Reveal,
        PageButton::Feedback,
        PageButton::Quit,
    ];
    let by_locale = cx.update(|cx| {
        Locale::ALL.map(|locale| {
            Strings::install(locale, cx);
            let mut words = Vec::new();
            for cause in Cause::ALL {
                let lines = page::lines(cause, cx);
                words.push((format!("{cause:?} heading"), lines.heading.to_string()));
                if let Some(second) = lines.second {
                    words.push((format!("{cause:?} second"), second.to_string()));
                }
                words.push((
                    format!("{cause:?} what to do"),
                    lines.what_to_do.to_string(),
                ));
            }
            for button in buttons {
                let label = page::button_label(button, cx).to_string();
                words.push((format!("{button:?}"), label));
            }
            words.push(("feedback".into(), page::feedback_message(&f, cx)));
            (locale, words)
        })
    });
    let english = &by_locale
        .iter()
        .find(|(locale, _)| *locale == Locale::En)
        .unwrap()
        .1;
    for (locale, words) in &by_locale {
        assert_eq!(words.len(), english.len(), "{locale:?}");
        for ((what, word), (_, in_english)) in words.iter().zip(english) {
            assert!(!word.trim().is_empty(), "{locale:?} {what}: empty");
            if *locale != Locale::En {
                assert_ne!(word, in_english, "{locale:?} {what}: left in English");
            }
        }
    }
    cx.update(|cx| {
        Strings::install(Locale::PtBr, cx);
        assert_eq!(page::button_label(PageButton::Quit, cx), "Sair do Drifting");
    });
}

/// Without a folder to open (no data folder at all) there is no
/// 「在访达中打开」; a build that cannot update has no 「检查更新」.
#[gpui::test]
fn buttons_with_nothing_to_do_are_left_out(cx: &mut TestAppContext) {
    setup(cx, Services::default());
    cx.update(|cx| {
        page::set_update_button(cx, |_| None);
        let mut f = failure(Cause::Newer, "schema-newer");
        f.folder = None;
        assert_eq!(
            page::buttons(&f, cx),
            [PageButton::Feedback, PageButton::Quit]
        );
    });
}

/// A library that opens shows no page, even with a failure left over; once
/// a library is in use the failure is over.
#[gpui::test]
fn a_library_that_opens_shows_no_page(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open_dir(dir.path(), VERSION).unwrap();
    seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED)
        .unwrap()
        .write_to(lib.library())
        .unwrap();
    let seen = setup(
        cx,
        Services {
            library: Some(lib),
            library_failure: Some(failure(Cause::Damaged, "sqlite:not-a-database")),
            ..Services::default()
        },
    );
    let (view, cx) = open(cx);
    view.read_with(cx, |ws, cx| {
        assert_eq!(ws.library_failure(cx), None);
        assert!(ws.shelf_open, "the bookshelf as always");
    });
    assert!(cx.debug_bounds("library-failure-heading").is_none());
    assert_eq!(seen.shelves.get(), 1);
}
