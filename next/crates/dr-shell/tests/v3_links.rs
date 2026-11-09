//! G1 addresses reach precise v3 targets through document and F7 URL entry.
use dr_editor::v3_link::{Address, Endpoint};
use dr_platform::DeepLinks;
use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace,
    book::Book,
    nav::{Lines, Target},
};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{AppContext as _, Entity, Focusable as _, TestAppContext, VisualTestContext};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

const SCHEME: &str = "drifting-next-dev";
fn fixture() -> (tempfile::TempDir, Library, String, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let made = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let lib = Library::open_dir(dir.path(), "0.2.0-dev").unwrap();
    let snapshot = Book::load(&lib, &book).unwrap();
    let v3 = snapshot.v3().unwrap();
    let entry = v3
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-chapter"))
        .unwrap()
        .id
        .clone();
    let material = v3
        .materials
        .iter()
        .find(|m| m.kind == "text")
        .unwrap()
        .id
        .clone();
    (dir, lib, book, entry, material)
}
fn address(book: &str, entry: &str) -> Address {
    Address {
        book: Some(book.parse().unwrap()),
        endpoint: Endpoint::Entry {
            id: entry.parse().unwrap(),
            module: Some("mod-prose".parse().unwrap()),
        },
        lines: Some((3, 7)),
    }
}
fn target(entry: &str) -> Target {
    Target::Entry {
        id: entry.parse().unwrap(),
        module: Some("mod-prose".parse().unwrap()),
    }
}
fn setup<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    book: &str,
    links: Arc<DeepLinks>,
) -> (Entity<Workspace>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::v3::add_module_view(cx, "prose", |_, window, cx| {
            let field = cx.new(|cx| dr_ui::input::TextField::new("link-module-probe", window, cx));
            let focus = field.focus_handle(cx);
            dr_shell::v3::Rendered::new(field).focus(focus)
        });
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: SCHEME,
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                book: Some(book.into()),
                deep_links: Some(links),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
    });
    cx.add_window_view(Workspace::new)
}
fn wait(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    done: impl Fn(&Workspace, &gpui::App) -> bool,
) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        cx.update(|w, cx| w.draw(cx).clear(cx));
        if view.read_with(cx, |w, cx| done(w, cx)) {
            return;
        }
        assert!(Instant::now() < until, "v3 link did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[gpui::test]
fn cold_and_live_system_urls_keep_the_module_and_line_range(cx: &mut TestAppContext) {
    let (_dir, lib, book, entry, material) = fixture();
    let before = lib.observe(&format!("book:{book}")).unwrap().version;
    let links = DeepLinks::new(SCHEME);
    links.push_all([address(&book, &entry).format(SCHEME)]);
    let (view, cx) = setup(cx, &lib, &book, links.clone());
    let wanted = target(&entry);
    wait(&view, cx, |w, cx| {
        w.nav.current() == Some(&wanted)
            && w.editors
                .get(&wanted.key())
                .and_then(|p| p.v3.as_ref())
                .is_some_and(|v| {
                    v.read(cx).revealed
                        == Some(Lines {
                            start: 3,
                            end: Some(7),
                        })
                })
    });
    let material_target = Target::Material(material.parse().unwrap());
    let href = Address {
        book: Some(book.parse().unwrap()),
        endpoint: Endpoint::Material(material.parse().unwrap()),
        lines: Some((1, 1)),
    }
    .format(SCHEME);
    assert_eq!(links.push_all([href]), 1);
    wait(&view, cx, |w, _| {
        w.nav.current() == Some(&material_target) && w.editor_of(&material_target).is_some()
    });
    view.read_with(cx, |w, cx| {
        assert_eq!(
            w.editor_of(&material_target).unwrap().read(cx).doc_id(),
            format!("material:{material}")
        )
    });
    assert_eq!(
        lib.observe(&format!("book:{book}")).unwrap().version,
        before
    );
    assert!(links.drain_matching("open/").is_empty());
}

#[gpui::test]
fn document_addresses_preserve_targets_and_refuse_foreign_books(cx: &mut TestAppContext) {
    let (_dir, lib, book, entry, material) = fixture();
    let (view, cx) = setup(cx, &lib, &book, DeepLinks::new(SCHEME));
    wait(&view, cx, |w, _| w.book.v3().is_some());
    let mut link = address(&book, &entry);
    link.book = None;
    assert!(view.update_in(cx, |w, window, cx| w.open_link(
        &link.format(SCHEME),
        window,
        cx
    )));
    wait(&view, cx, |w, _| w.nav.current() == Some(&target(&entry)));
    let before = view.read_with(cx, |w, _| w.nav.tabs().len());
    let mut wrong = link.clone();
    wrong.book = Some("foreign-book".parse().unwrap());
    assert!(!view.update_in(cx, |w, window, cx| w.open_link(
        &wrong.format(SCHEME),
        window,
        cx
    )));
    assert_eq!(view.read_with(cx, |w, _| w.nav.tabs().len()), before);
    assert!(!view.update_in(cx, |w, window, cx| w.open_link(
        "drifting:entries/id-missing/modules/id-mod-prose/prose.md#L1",
        window,
        cx
    )));
    // A material address opens its existing document rather than an entry or Book sentinel.
    let body = lib
        .call(
            &Actor::User,
            "prose.read",
            json!({"doc":format!("material:{material}")}),
        )
        .unwrap();
    let material_link = Address {
        book: None,
        endpoint: Endpoint::Material(material.parse().unwrap()),
        lines: Some((1, 1)),
    }
    .format(SCHEME);
    assert!(view.update_in(cx, |w, window, cx| w.open_link(&material_link, window, cx)));
    let wanted = Target::Material(material.parse().unwrap());
    wait(&view, cx, |w, _| w.editor_of(&wanted).is_some());
    assert_eq!(
        lib.call(
            &Actor::User,
            "prose.read",
            json!({"doc":format!("material:{material}")})
        )
        .unwrap()["output"],
        body["output"]
    );
    // Even an unavailable retained module must not hand typing to another body.
    let missing = Target::Entry {
        id: entry.parse().unwrap(),
        module: Some("unavailable".parse().unwrap()),
    };
    view.update(cx, |w, cx| {
        w.open(missing.clone(), dr_shell::nav::Open::KEEP, cx)
    });
    wait(&view, cx, |w, cx| {
        w.editors
            .get(&missing.key())
            .and_then(|p| p.v3.as_ref())
            .is_some_and(|v| !v.read(cx).sections.is_empty())
    });
    view.read_with(cx, |w, cx| {
        let p = w.editors[&missing.key()].v3.as_ref().unwrap().read(cx);
        assert_eq!(p.preferred_focus(), p.focus);
    });
}
