//! T1 (`kernel-v5.md` §5, §8): the left column's Tabs come from the project
//! definition, an entry's mark is its own or its template's, and an entry
//! opens in one tab.
use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as Shell,
    actions::Undo,
    book::{
        Book,
        v3::{BookV3, is_glyph_mark, mark},
    },
    nav::{Open, Target},
    pages::PageViewHost,
    v3::{
        self, Rendered,
        sidebar::Sidebar,
        tabs::{self, Gone},
    },
};
use dr_ui::sand;
use dr_workspace::{
    Actor, Workspace,
    commands::v3::types::{BookRoot, TabMount},
};
use gpui::{
    App, AppContext as _, Context, Entity, IntoElement, Render, TestAppContext, VisualTestContext,
    Window, div,
};
use serde_json::{Value, json};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn seed() -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let made = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let id = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, id)
}

fn root_of(v: &BookV3, template: &str) -> String {
    v.entries
        .iter()
        .find(|e| e.template.as_deref() == Some(template) && e.parent.is_none())
        .unwrap()
        .id
        .clone()
}

struct DummyPart;
impl Render for DummyPart {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

/// A window on `id`'s book, with stand-in level displays.
fn open<'a>(
    cx: &'a mut TestAppContext,
    lib: &Workspace,
    id: &str,
) -> (Entity<Shell>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                book: Some(id.to_owned()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx);
        for display in ["list", "board", "grid", "island"] {
            v3::add_level_display(cx, display, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
        }
        v3::add_level_settings(cx, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
    });
    let (view, cx) = cx.add_window_view(Shell::new);
    cx.update(|window, _| window.activate_window());
    (view, cx)
}

fn pump(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

fn wait(
    view: &Entity<Shell>,
    cx: &mut VisualTestContext,
    what: &str,
    done: impl Fn(&Shell, &App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        pump(cx);
        if view.read_with(cx, |ws, cx| done(ws, cx)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn sidebar(view: &Entity<Shell>, cx: &mut VisualTestContext) -> Entity<Sidebar> {
    // The left column starts closed: open it, so the Tabs are drawn.
    if !view.read_with(cx, |ws, _| ws.left.open) {
        cx.update(|window, cx| view.update(cx, |ws, cx| ws.toggle_left(window, cx)));
    }
    wait(view, cx, "the left column", |ws, _| ws.v3_sidebar.is_some());
    view.read_with(cx, |ws, _| ws.v3_sidebar.clone().unwrap())
}

fn host(
    view: &Entity<Shell>,
    lib: &Workspace,
    id: &str,
    cx: &mut VisualTestContext,
) -> PageViewHost {
    PageViewHost {
        workspace: view.downgrade(),
        library: lib.clone(),
        book_id: id.to_owned(),
        book: view.read_with(cx, |ws, _| ws.book.clone()),
    }
}

fn tabs_of(ws: &Shell) -> Vec<(String, String, TabMount)> {
    ws.book
        .v3()
        .unwrap()
        .project
        .tabs
        .iter()
        .map(|t| (t.id.clone(), t.name.clone(), t.mount.clone()))
        .collect()
}

#[gpui::test]
fn tabs_are_renamed_doubled_reordered_removed_and_undone_without_touching_entries(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let sidebar = sidebar(&view, cx);
    let (manuscript, first) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        (root_of(v, "tpl-manuscript"), tabs_of(ws))
    });
    let names: Vec<&str> = first.iter().map(|(_, n, _)| n.as_str()).collect();
    assert_eq!(&names[..4], ["书稿", "构想", "要素", "故事线"]);
    let (manuscript_tab, _, mount) = first[0].clone();
    assert_eq!(
        mount,
        TabMount::Entry {
            entry: manuscript.clone()
        }
    );

    // Renaming a Tab renames the Tab only.
    sidebar.update(cx, |s, cx| s.rename(&manuscript_tab, "正文", cx));
    wait(&view, cx, "the renamed Tab", |ws, _| {
        tabs_of(ws)[0].1 == "正文"
    });
    view.read_with(cx, |ws, _| {
        assert_eq!(
            ws.book.v3().unwrap().entry(&manuscript).unwrap().title,
            "书稿"
        );
    });

    // A second Tab on the same level: named after it, selected once it is
    // there, both show it.
    sidebar.update(cx, |s, cx| {
        s.mount(
            None,
            TabMount::Entry {
                entry: manuscript.clone(),
            },
            cx,
        )
    });
    wait(&view, cx, "the second Tab", |ws, _| {
        tabs_of(ws).len() == first.len() + 1
    });
    let second = view.read_with(cx, |ws, _| tabs_of(ws).last().unwrap().clone());
    assert_eq!(second.1, "书稿");
    assert_eq!(second.2, first[0].2);
    let deadline = Instant::now() + Duration::from_secs(10);
    while sidebar.read_with(cx, |s, _| {
        s.state()["selected"] != json!(second.0) || s.state()["registered"] != json!(true)
    }) {
        pump(cx);
        assert!(
            Instant::now() < deadline,
            "the new Tab is selected and shown: {}",
            sidebar.read_with(cx, |s, _| s.state())
        );
        std::thread::sleep(Duration::from_millis(2));
    }

    // Reordered to the front, then removed: the level stays.
    sidebar.update(cx, |s, cx| s.reorder(&second.0, &manuscript_tab, false, cx));
    wait(&view, cx, "the reorder", |ws, _| {
        tabs_of(ws)[0].0 == second.0
    });
    sidebar.update(cx, |s, cx| s.remove(&second.0, cx));
    wait(&view, cx, "the removal", |ws, _| {
        tabs_of(ws).iter().all(|t| t.0 != second.0)
    });
    view.read_with(cx, |ws, _| {
        assert!(ws.book.v3().unwrap().entry(&manuscript).is_some());
        assert_eq!(tabs_of(ws)[0].0, manuscript_tab);
    });
    // The selected Tab was removed: the first one is selected.
    pump(cx);
    sidebar.read_with(cx, |s, _| {
        assert_eq!(s.state()["selected"], json!(manuscript_tab))
    });

    // ⌘Z puts the removed Tab back, where it was.
    cx.update(|window, cx| {
        let focus = view.read(cx).focus_handle().clone();
        focus.focus(window, cx);
    });
    cx.dispatch_action(Undo);
    wait(&view, cx, "the undo", |ws, _| {
        tabs_of(ws).iter().any(|t| t.0 == second.0)
    });
    view.read_with(cx, |ws, _| assert_eq!(tabs_of(ws)[0].0, second.0));
}

#[gpui::test]
fn a_tab_whose_mount_is_gone_stays_and_says_why_and_an_untabbed_level_still_opens(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let sidebar = sidebar(&view, cx);
    let (ideas, storylines, view_id) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        (
            root_of(v, "tpl-ideas"),
            root_of(v, "tpl-storylines"),
            v.timeline_views[0].id.clone(),
        )
    });

    // A Tab on the book: empty once the project's book is off, back once
    // it is on again (its start kept).
    sidebar.update(cx, |s, cx| s.mount(None, TabMount::Book, cx));
    wait(&view, cx, "the book Tab", |ws, _| {
        tabs_of(ws).iter().any(|t| t.2 == TabMount::Book)
    });
    call(
        &lib,
        "project.update",
        json!({"book": id, "has_book": false}),
    );
    wait(&view, cx, "the book off", |ws, _| {
        ws.book.v3().unwrap().project.book.is_none()
    });
    view.read_with(cx, |ws, cx| {
        let v = ws.book.v3().unwrap();
        assert_eq!(tabs::gone(v, &TabMount::Book), Some(Gone::BookOff));
        let tab = v
            .project
            .tabs
            .iter()
            .find(|t| t.mount == TabMount::Book)
            .unwrap();
        assert_eq!(
            Gone::BookOff.text(tab, cx).as_ref(),
            "项目关了成书",
            "the empty Tab says why"
        );
    });
    pump(cx);
    sidebar.read_with(cx, |s, _| {
        let tabs = s.state()["tabs"].as_array().unwrap().clone();
        let book = tabs.iter().find(|t| t["mount"]["kind"] == "book").unwrap();
        assert_eq!(book["gone"], json!(true), "the Tab stays, faded");
    });
    let manuscript = view.read_with(cx, |ws, _| root_of(ws.book.v3().unwrap(), "tpl-manuscript"));
    call(
        &lib,
        "project.update",
        json!({"book": id, "has_book": true, "root": {"kind": "entry", "entry": manuscript}}),
    );
    wait(&view, cx, "the book on", |ws, _| {
        let v = ws.book.v3().unwrap();
        v.project.book.is_some() && tabs::gone(v, &TabMount::Book).is_none()
    });

    // The storylines' level in Recently Deleted: its Tab stays and says so.
    call(&lib, "entry.trash", json!({"book": id, "id": storylines}));
    wait(&view, cx, "the trash", |ws, _| {
        ws.book.v3().unwrap().entry(&storylines).is_none()
    });
    view.read_with(cx, |ws, cx| {
        let v = ws.book.v3().unwrap();
        let mount = TabMount::Entry {
            entry: storylines.clone(),
        };
        let gone = tabs::gone(v, &mount).unwrap();
        assert_eq!(gone, Gone::Trashed("故事线".into()));
        let tab = v.project.tabs.iter().find(|t| t.mount == mount).unwrap();
        assert_eq!(gone.text(tab, cx).as_ref(), "「故事线」进了最近删除");
    });
    // A deleted view.
    call(
        &lib,
        "timeline_view.delete",
        json!({"book": id, "id": view_id}),
    );
    wait(&view, cx, "the view deleted", |ws, _| {
        ws.book.v3().unwrap().timeline_view(&view_id).is_none()
    });
    view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        assert!(matches!(
            tabs::gone(
                v,
                &TabMount::View {
                    view: view_id.clone()
                }
            ),
            Some(Gone::ViewDeleted(_)) | Some(Gone::Missing)
        ));
    });

    // The ideas' Tab removed: the level is mounted nowhere, and still opens.
    let ideas_tab = view.read_with(cx, |ws, _| {
        tabs_of(ws)
            .into_iter()
            .find(|t| {
                t.2 == TabMount::Entry {
                    entry: ideas.clone(),
                }
            })
            .unwrap()
            .0
    });
    sidebar.update(cx, |s, cx| s.remove(&ideas_tab, cx));
    wait(&view, cx, "the removal", |ws, _| {
        tabs_of(ws).iter().all(|t| t.0 != ideas_tab)
    });
    let target = Target::Entry {
        id: ideas.parse().unwrap(),
        module: None,
    };
    view.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
    wait(&view, cx, "the ideas page", |ws, cx| {
        ws.editors
            .get(&target.key())
            .and_then(|p| p.v3.clone())
            .is_some_and(|page| page.read(cx).synced)
    });
    view.read_with(cx, |ws, cx| {
        let page = ws.editors[&target.key()].v3.clone().unwrap();
        let page = page.read(cx);
        let below = page.sections.iter().find(|s| s.kind == "children").unwrap();
        assert!(below.registered, "the level shows what lives under it");
    });
}

#[gpui::test]
fn an_entry_opens_in_one_tab_from_the_home_page_and_from_the_left_column(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let chapter = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        v.entries
            .iter()
            .find(|e| e.template.as_deref() == Some("tpl-chapter"))
            .unwrap()
            .id
            .clone()
    });
    let from_column = Target::Entry {
        id: chapter.parse().unwrap(),
        module: None,
    };
    let from_home = Target::Entry {
        id: chapter.parse().unwrap(),
        module: Some("mod-prose".parse().unwrap()),
    };
    view.update(cx, |ws, cx| ws.open(from_column.clone(), Open::PREVIEW, cx));
    pump(cx);
    view.update(cx, |ws, cx| ws.open(from_home.clone(), Open::KEEP, cx));
    pump(cx);
    view.read_with(cx, |ws, _| {
        assert_eq!(ws.nav.tabs().len(), 1);
        assert!(ws.nav.is_selected(&from_column) && ws.nav.is_selected(&from_home));
        assert_eq!(ws.editors.len(), 1, "one page");
    });
}

#[gpui::test]
fn a_mark_is_the_entrys_own_or_its_templates_and_every_surface_follows(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    let (chapter, template) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        let e = v
            .entries
            .iter()
            .find(|e| e.template.as_deref() == Some("tpl-chapter"))
            .unwrap();
        (e.id.clone(), e.template.clone().unwrap())
    });
    let target = Target::Entry {
        id: chapter.parse().unwrap(),
        module: None,
    };
    let seal = view.read_with(cx, |ws, _| ws.book.mark(&target).0);
    assert!(matches!(seal, sand::Kind::Chapter(_)));

    // One character of its own: every surface draws it (the left column,
    // tab pills and hover cards all read the book's mark).
    call(
        &lib,
        "entry.update",
        json!({"book": id, "id": chapter, "mark": "岬"}),
    );
    wait(&view, cx, "the mark", |ws, _| {
        matches!(ws.book.mark(&target).0, sand::Kind::Glyph(_))
    });
    view.read_with(cx, |ws, _| {
        let sand::Kind::Glyph(glyph) = ws.book.mark(&target).0 else {
            unreachable!()
        };
        assert_eq!(glyph.text().as_ref(), "岬");
        assert_eq!(
            ws.book
                .v3()
                .unwrap()
                .appearance(&chapter)
                .unwrap()
                .mark
                .as_deref(),
            Some("岬")
        );
    });
    // A sand mark of its own.
    call(
        &lib,
        "entry.update",
        json!({"book": id, "id": chapter, "mark": "compass"}),
    );
    wait(&view, cx, "the sand mark", |ws, _| {
        ws.book.mark(&target).0 == sand::Kind::Storyline
    });
    // ⌘Z: the character again.
    cx.update(|window, cx| {
        let focus = view.read(cx).focus_handle().clone();
        focus.focus(window, cx);
    });
    cx.dispatch_action(Undo);
    wait(&view, cx, "the undo", |ws, _| {
        matches!(ws.book.mark(&target).0, sand::Kind::Glyph(_))
    });
    // Back to the template's: it follows the template's mark.
    call(
        &lib,
        "entry.update",
        json!({"book": id, "id": chapter, "mark": null}),
    );
    wait(&view, cx, "the template's mark", |ws, _| {
        matches!(ws.book.mark(&target).0, sand::Kind::Chapter(_))
    });
    let mut tpl = view.read_with(cx, |ws, _| {
        serde_json::to_value(ws.book.v3().unwrap().template(&template).unwrap()).unwrap()
    });
    tpl["mark"] = json!("🌊");
    call(
        &lib,
        "entry_template.put",
        json!({"book": id, "template": tpl}),
    );
    wait(
        &view,
        cx,
        "the template's character",
        |ws, _| matches!(ws.book.mark(&target).0, sand::Kind::Glyph(g) if g.text().as_ref() == "🌊"),
    );
}

#[test]
fn marks_are_sand_names_or_one_character() {
    assert!(matches!(
        mark(Some("file-text"), "x"),
        sand::Kind::Chapter(_)
    ));
    assert_eq!(mark(Some("square"), "x"), sand::Kind::Element);
    assert!(matches!(mark(Some("岬"), "x"), sand::Kind::Glyph(_)));
    assert!(matches!(mark(Some("a"), "x"), sand::Kind::Glyph(_)));
    assert!(matches!(mark(Some("👩‍👩‍👧"), "x"), sand::Kind::Glyph(_)));
    // A name this build does not know is the square seal, not its letters.
    assert_eq!(mark(Some("future-mark"), "x"), sand::Kind::Element);
    assert!(!is_glyph_mark("future-mark") && !is_glyph_mark("ab") && !is_glyph_mark(""));
}

#[gpui::test]
fn dragging_in_a_view_tab_moves_on_the_scale_and_in_the_book_tab_at_its_start(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    wait(&view, cx, "the book", |ws, _| ws.book.v3().is_some());
    // A lane of the view with two entries on it.
    let (view_id, lane, order) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        let tv = &v.timeline_views[0];
        tv.lanes
            .iter()
            .map(|l| (tv.id.clone(), l.entry.clone(), v.lane_entries(tv, &l.entry)))
            .find(|(_, _, order)| order.len() >= 2)
            .expect("a lane with two entries")
    });
    let (a, b) = (order[0].clone(), order[1].clone());
    let h = host(&view, &lib, &id, cx);
    cx.update(|_, cx| tabs::drop_in_view(&h, &view_id, &lane, &b, &a, false, cx));
    wait(&view, cx, "the new place on the scale", |ws, _| {
        let v = ws.book.v3().unwrap();
        let tv = v.timeline_view(&view_id).unwrap();
        let now = v.lane_entries(tv, &lane);
        now.iter().position(|x| *x == b) < now.iter().position(|x| *x == a)
    });

    // The book starts at the manuscript: dragging changes its manual order.
    let (first, second, parent) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        assert!(matches!(
            v.project.book.as_ref().unwrap().root,
            BookRoot::Entry { .. }
        ));
        let seq = v.book_entries();
        let parent = v.entry(&seq[0]).unwrap().parent.clone();
        let second = seq
            .iter()
            .skip(1)
            .find(|e| v.entry(e).unwrap().parent == parent)
            .unwrap()
            .clone();
        (seq[0].clone(), second, parent.unwrap())
    });
    let h = host(&view, &lib, &id, cx);
    cx.update(|_, cx| tabs::drop_in_book(&h, &second, &first, false, cx));
    wait(&view, cx, "the manual order", |ws, _| {
        let v = ws.book.v3().unwrap();
        let children = &v.levels[&parent].children;
        children.iter().position(|x| *x == second) < children.iter().position(|x| *x == first)
    });
    view.read_with(cx, |ws, _| {
        let seq = ws.book.v3().unwrap().book_entries();
        assert!(seq.iter().position(|x| *x == second) < seq.iter().position(|x| *x == first));
    });
}

/// `Book::load` alone (no window): the snapshot's helpers the Tabs read.
#[test]
fn a_view_lists_its_lanes_entries_along_its_scale() {
    let (_dir, lib, id) = seed();
    let book = Book::load(&lib, &id).unwrap();
    let v = book.v3().unwrap();
    let tv = &v.timeline_views[0];
    for lane in &tv.lanes {
        let order = v.lane_entries(tv, &lane.entry);
        let at: Vec<Option<f64>> = order
            .iter()
            .map(|e| tv.placements.iter().find(|p| p.entry == *e).map(|p| p.at))
            .collect();
        let placed: Vec<f64> = at.iter().flatten().copied().collect();
        assert!(placed.windows(2).all(|w| w[0] <= w[1]), "along the scale");
        // Unplaced ones last.
        let first_unplaced = at.iter().position(Option::is_none).unwrap_or(at.len());
        assert!(at[first_unplaced..].iter().all(Option::is_none));
        // What lives under it and what is attached to it, each once.
        let level = &v.levels[&lane.entry];
        let mut expect: Vec<&String> = level.children.iter().chain(&level.members).collect();
        expect.sort();
        expect.dedup();
        let mut got: Vec<&String> = order.iter().collect();
        got.sort();
        assert_eq!(got, expect);
    }
}
