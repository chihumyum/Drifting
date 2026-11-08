//! The elements panel on GPUI's test platform over dr-testkit's 《慢钟》
//! (through F3): its order (categories and elements by pinyin, numbers by
//! value, or newest first; groups first), collapsing, making an element or a
//! group from a category's +, renaming a group, 「新类目」.

use std::time::{Duration, Instant};

use dr_shell::nav::Target;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_elements::panel::{ElementPanel, Sort, UNCATEGORIZED, View};
use dr_workspace::{
    Actor, Workspace as Library,
    commands::{
        ListIn,
        element::{CategoryList, ElementList, ElementListIn},
    },
    dto::ElementInfo,
};
use gpui::{Entity, TestAppContext, VisualTestContext};

const VERSION: &str = "0.2.0-dev";

fn library() -> (tempfile::TempDir, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book(&lib, &book).unwrap();
    lib.close().unwrap();
    let id = book.book.book_id().to_string();
    (dir, Library::open_dir(&root, VERSION).unwrap(), id)
}

fn setup(
    cx: &mut TestAppContext,
    library: Library,
) -> (
    Entity<Workspace>,
    Entity<ElementPanel>,
    &mut VisualTestContext,
) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(library),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_elements::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    let ws = view.downgrade();
    let (panel, _head) = cx.update(|_, cx| dr_view_elements::make_panel(ws, cx));
    wait_for(cx, |cx| {
        panel.read_with(cx, |p, _| !p.sections().is_empty())
    });
    (view, panel, cx)
}

fn wait_for(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn elements(lib: &Library, book: &str) -> Vec<ElementInfo> {
    lib.run::<ElementList>(
        &Actor::User,
        ElementListIn {
            book: book.to_owned(),
            ..ElementListIn::default()
        },
    )
    .unwrap()
    .output
}

#[gpui::test]
fn the_panel_orders_categories_and_elements_as_0_1_did(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (_, panel, cx) = setup(cx, library);
    let sections = panel.read_with(cx, |p, _| p.sections());
    // By pinyin: 地点 (di), 人物 (ren), 物件与往事 (wu).
    let names: Vec<String> = sections
        .iter()
        .map(|s| {
            s.category
                .as_ref()
                .map(|c| c.name.clone())
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(names, ["地点", "人物", "物件与往事"]);
    // Every element is listed once; within a category by pinyin.
    let total: usize = sections.iter().map(|s| s.count()).sum();
    assert_eq!(total, elements(&lib, &book).len());
    let people = &sections[1];
    let mut sorted: Vec<String> = people.loose.iter().map(|e| e.name.clone()).collect();
    sorted.sort_by(|a, b| dr_view_elements::panel::natural(a, b));
    let shown: Vec<String> = people.loose.iter().map(|e| e.name.clone()).collect();
    assert_eq!(shown, sorted);
    // Newest first: ids (UUID v7) descending, for both levels.
    panel.update(cx, |p, cx| {
        p.set_sort(Sort::Created, cx);
        p.set_category_sort(Sort::Created, cx);
    });
    let sections = panel.read_with(cx, |p, _| p.sections());
    let ids: Vec<String> = sections
        .iter()
        .filter_map(|s| s.category.as_ref().map(|c| c.id.clone()))
        .collect();
    let mut newest = ids.clone();
    newest.sort_by(|a, b| b.cmp(a));
    assert_eq!(ids, newest);
    let people: Vec<String> = sections
        .iter()
        .find(|s| s.category.as_ref().is_some_and(|c| c.name == "人物"))
        .unwrap()
        .loose
        .iter()
        .map(|e| e.id.clone())
        .collect();
    let mut newest = people.clone();
    newest.sort_by(|a, b| b.cmp(a));
    assert_eq!(people, newest);
}

#[gpui::test]
fn the_view_and_the_categories_fold(cx: &mut TestAppContext) {
    let (_dir, library, _) = library();
    let (_, panel, cx) = setup(cx, library);
    assert_eq!(panel.read_with(cx, |p, _| p.mode), View::Compact);
    panel.update(cx, |p, cx| p.toggle_mode(cx));
    assert_eq!(panel.read_with(cx, |p, _| p.mode), View::List);
    // Collapse all, then expand all.
    panel.update(cx, |p, cx| p.toggle_all(cx));
    let count = panel.read_with(cx, |p, _| p.sections().len());
    assert_eq!(panel.read_with(cx, |p, _| p.collapsed.len()), count);
    panel.update(cx, |p, cx| p.toggle_all(cx));
    assert!(panel.read_with(cx, |p, _| p.collapsed.is_empty()));
    // One category.
    let key = panel.read_with(cx, |p, _| p.sections()[0].key.clone());
    panel.update(cx, |p, cx| p.toggle(&key, cx));
    assert!(panel.read_with(cx, |p, _| p.collapsed.contains(&key)));
    // Both views draw.
    for _ in 0..2 {
        panel.update(cx, |p, cx| p.toggle_mode(cx));
        wait_for(cx, |_| true);
    }
}

#[gpui::test]
fn a_category_makes_an_element_or_a_group(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, panel, cx) = setup(cx, library);
    let places = panel.read_with(cx, |p, _| {
        p.sections()
            .into_iter()
            .find(|s| s.category.as_ref().is_some_and(|c| c.name == "地点"))
            .unwrap()
    });
    let before = elements(&lib, &book).len();
    // 「新建要素」: made in the category and opened.
    cx.update(|window, cx| panel.update(cx, |p, cx| p.new_element(&places.key, None, window, cx)));
    wait_for(cx, |_| elements(&lib, &book).len() == before + 1);
    let made = elements(&lib, &book)
        .into_iter()
        .find(|e| e.name.starts_with("New Element"))
        .unwrap();
    assert_eq!(made.category.as_deref(), Some(places.key.as_str()));
    let target = Target::Element(made.id.parse().unwrap());
    wait_for(cx, |cx| {
        view.read_with(cx, |ws, _| ws.nav.is_selected(&target))
    });
    // 「新建分组…」: a taken name is refused; a new one makes its first
    // element in it.
    panel.update(cx, |p, cx| p.open_create(&places.key, cx));
    cx.update(|window, cx| panel.update(cx, |p, cx| p.ask_group(window, cx)));
    cx.update(|window, cx| {
        panel.update(cx, |p, cx| {
            p.create_group(&places.key, "老街".into(), window, cx)
        })
    });
    wait_for(cx, |_| {
        elements(&lib, &book)
            .iter()
            .any(|e| e.group_name.as_deref() == Some("老街"))
    });
    wait_for(cx, |cx| {
        panel.read_with(cx, |p, _| p.group_taken(&places.key, "老街"))
    });
    assert!(panel.read_with(cx, |p, _| p.group_taken(&places.key, "老街")));
    let count = elements(&lib, &book).len();
    cx.update(|window, cx| {
        panel.update(cx, |p, cx| {
            p.create_group(&places.key, "老街".into(), window, cx)
        })
    });
    cx.run_until_parked();
    assert_eq!(elements(&lib, &book).len(), count);
    // The group lists before the ungrouped elements.
    let section = panel.read_with(cx, |p, _| {
        p.sections()
            .into_iter()
            .find(|s| s.key == places.key)
            .unwrap()
    });
    assert_eq!(section.groups[0].0, "老街");
    // Renaming the group renames it on its elements.
    cx.update(|window, cx| {
        panel.update(cx, |p, cx| {
            p.start_rename_group(&places.key, "老街", window, cx)
        })
    });
    panel.update(cx, |p, cx| p.finish_rename_group(Some("旧街".into()), cx));
    wait_for(cx, |_| {
        elements(&lib, &book)
            .iter()
            .any(|e| e.group_name.as_deref() == Some("旧街"))
            && !elements(&lib, &book)
                .iter()
                .any(|e| e.group_name.as_deref() == Some("老街"))
    });
}

#[gpui::test]
fn new_category_and_uncategorized(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (_, panel, cx) = setup(cx, library);
    panel.update(cx, |p, cx| p.new_category(cx));
    let named = |lib: &Library| {
        lib.run::<CategoryList>(
            &Actor::User,
            ListIn {
                book: book.clone(),
                trashed: false,
            },
        )
        .unwrap()
        .output
        .into_iter()
        .any(|c| c.name == "New Category")
    };
    wait_for(cx, |_| named(&lib));
    // The new category lists, empty (folded in the compact index).
    wait_for(cx, |cx| {
        panel.read_with(cx, |p, _| {
            p.sections().iter().any(|s| {
                s.category
                    .as_ref()
                    .is_some_and(|c| c.name == "New Category")
                    && s.count() == 0
            })
        })
    });
    // An element with no category lists under 未分类, last.
    let zhiwei = elements(&lib, &book)
        .into_iter()
        .find(|e| e.name == "沈知微")
        .unwrap();
    let mut edit = dr_view_elements::data::element_edit(&book, &zhiwei.id);
    edit.category = Some(None);
    dr_view_elements::data::update_element(&lib, edit).unwrap();
    wait_for(cx, |cx| {
        panel.read_with(cx, |p, _| {
            p.sections()
                .last()
                .is_some_and(|s| s.key == UNCATEGORIZED && s.count() == 1)
        })
    });
}

/// The shell's left sidebar draws this panel on its 要素 tab
/// (`pages::add_left_panel`, registered by `dr_view_elements::init`).
#[gpui::test]
fn the_left_sidebar_shows_the_panel_on_its_elements_tab(cx: &mut TestAppContext) {
    use dr_shell::panes::PaneId;
    use dr_shell::workspace::LeftTab;
    let (_dir, library, _) = library();
    let (view, _, cx) = setup(cx, library);
    assert!(
        cx.update(|_, cx| dr_view_elements::sidebar_panels(cx))
            .is_empty()
    );
    view.update_in(cx, |ws, window, cx| {
        if !ws.left.open {
            ws.toggle_left(window, cx);
        }
        ws.left.reveal.set(1.0);
        ws.left.panes.click(PaneId::Primary, LeftTab::Elements);
    });
    wait_for(cx, |cx| {
        cx.update(|_, cx| {
            dr_view_elements::sidebar_panels(cx)
                .first()
                .is_some_and(|p| p.read(cx).sections().len() > 1)
        })
    });
    // Made once for the half and kept.
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(
        cx.update(|_, cx| dr_view_elements::sidebar_panels(cx))
            .len(),
        1
    );
}
