//! The element and category pages on GPUI's test platform, over a real
//! library (dr-testkit's 《慢钟》, read and written through F3): opening an
//! element's page puts its head and fields around the text; the name, the
//! aliases, the summary and the fields save as in the 0.1 client, and a name
//! or alias another element holds raises the 0.1 alert; a category's page
//! renames it and lists its elements with the filter, and its swatch picks
//! its colour.

use std::time::{Duration, Instant};

use dr_shell::nav::{Open, Target};
use dr_shell::pages::{PageMenuHost, PageMenuSection};
use dr_shell::workspace::page_actions::page_actions;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_elements::dialogs::{AskFor, Asking};
use dr_view_elements::{CategoryEnd, CategoryHead, ElementHead, Fields, Filter};
use dr_workspace::{
    Actor, Workspace as Library,
    commands::{
        ListIn,
        element::{CategoryList, ElementList, ElementListIn},
    },
    dto::{CategoryInfo, ElementInfo},
};
use gpui::{Entity, Focusable as _, Modifiers, TestAppContext, VisualTestContext};

const VERSION: &str = "0.2.0-dev";

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: VERSION,
        url_scheme: "drifting-next-dev",
        forced_appearance: None,
    }
}

/// A library holding 《慢钟》, and its book's id.
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

fn setup(cx: &mut TestAppContext, library: Library) -> (Entity<Workspace>, &mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            info(),
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
    cx.update(|window, _| window.activate_window());
    cx.run_until_parked();
    (view, cx)
}

/// One drawn frame (focus listeners run when a frame sees the change).
fn frame(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

fn wait_for(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        frame(cx);
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

fn element(lib: &Library, book: &str, name: &str) -> ElementInfo {
    elements(lib, book)
        .into_iter()
        .find(|e| e.name == name)
        .unwrap_or_else(|| panic!("{name} in the book"))
}

fn categories(lib: &Library, book: &str) -> Vec<CategoryInfo> {
    lib.run::<CategoryList>(
        &Actor::User,
        ListIn {
            book: book.to_owned(),
            trashed: false,
        },
    )
    .unwrap()
    .output
}

/// Opens element `id`'s page and waits for its head and fields.
fn open_element(
    view: &Entity<Workspace>,
    id: &str,
    cx: &mut VisualTestContext,
) -> (Entity<ElementHead>, Entity<Fields>) {
    wait_for(cx, |cx| view.read_with(cx, |ws, _| !ws.book.is_empty()));
    let target = Target::Element(id.parse().unwrap());
    view.update(cx, |ws, cx| ws.open(target, Open::KEEP, cx));
    wait_for(cx, |cx| {
        cx.update(|_, cx| dr_view_elements::element_page(id, cx).is_some())
    });
    cx.update(|_, cx| dr_view_elements::element_page(id, cx).unwrap())
}

fn open_category(
    view: &Entity<Workspace>,
    id: &str,
    cx: &mut VisualTestContext,
) -> (Entity<CategoryHead>, Entity<CategoryEnd>) {
    wait_for(cx, |cx| view.read_with(cx, |ws, _| !ws.book.is_empty()));
    let target = Target::Category(id.parse().unwrap());
    view.update(cx, |ws, cx| ws.open(target, Open::KEEP, cx));
    wait_for(cx, |cx| {
        cx.update(|_, cx| dr_view_elements::category_page(id, cx).is_some())
    });
    cx.update(|_, cx| dr_view_elements::category_page(id, cx).unwrap())
}

/// What the element dialog asks now.
fn asking(cx: &mut VisualTestContext) -> Option<Asking> {
    cx.update(|_, cx| {
        dr_view_elements::dialogs::dialogs(cx)
            .unwrap()
            .read(cx)
            .asking()
    })
}

/// Waits for the 0.1 alert; its message.
fn wait_alert(cx: &mut VisualTestContext) -> String {
    wait_for(cx, |cx| matches!(asking(cx), Some(Asking::Alert(_))));
    match asking(cx) {
        Some(Asking::Alert(m)) => m,
        _ => unreachable!(),
    }
}

/// Esc closes the element dialog.
fn close_dialog(cx: &mut VisualTestContext) {
    cx.simulate_keystrokes("escape");
    frame(cx);
    assert_eq!(asking(cx), None);
}

/// Opens an element dialog as the page's ⋯ menu does.
fn ask(view: &Entity<Workspace>, ask: AskFor, cx: &mut VisualTestContext) {
    let ws = view.downgrade();
    cx.update(|window, cx| dr_view_elements::dialogs::open(ask, ws, window, cx));
    frame(cx);
}

/// The ⋯ menu of `target`'s page, as the shell lists it.
fn menu_of(
    view: &Entity<Workspace>,
    target: &Target,
    cx: &mut VisualTestContext,
) -> Vec<PageMenuSection> {
    let host = view.read_with(cx, |ws, _| PageMenuHost {
        workspace: view.downgrade(),
        library: ws.library.clone(),
        book_id: ws.book_id.clone(),
        book: ws.book.clone(),
    });
    cx.update(|_, cx| page_actions(view, &host, target, cx))
}

fn ids(sections: &[PageMenuSection]) -> Vec<Vec<String>> {
    sections
        .iter()
        .map(|s| s.items.iter().map(|i| i.id.to_string()).collect())
        .collect()
}

/// Puts the caret in `focus`, types `text` into it with `set`, then moves
/// the caret to the workspace: the field reports leaving.
fn type_and_leave(
    view: &Entity<Workspace>,
    focus: impl Fn(&mut gpui::Window, &mut gpui::App),
    set: impl Fn(&mut gpui::App),
    cx: &mut VisualTestContext,
) {
    cx.update(|window, cx| focus(window, cx));
    frame(cx);
    cx.update(|_, cx| set(cx));
    cx.update(|window, cx| view.read(cx).focus_handle().clone().focus(window, cx));
    frame(cx);
}

#[gpui::test]
fn an_element_page_shows_its_head_and_fields(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let zhiwei = element(&lib, &book, "沈知微");
    let (head, fields) = open_element(&view, &zhiwei.id, cx);
    // The fields show what is stored, once the book's snapshot is there.
    wait_for(cx, |cx| {
        let (name, _, summary) = head.read_with(cx, |h, _| h.fields());
        name.read_with(cx, |f, _| f.text()) == "沈知微"
            && summary.read_with(cx, |f, _| f.text()) == zhiwei.summary
    });
    wait_for(cx, |cx| fields.read_with(cx, |f, _| f.rows().len()) == 3);
    let rows = fields.read_with(cx, |f, _| f.rows());
    let shown: Vec<(String, String)> = rows
        .iter()
        .map(|(_, k, v)| {
            (
                k.read_with(cx, |f, _| f.text()),
                v.read_with(cx, |f, _| f.text()),
            )
        })
        .collect();
    let stored: Vec<(String, String)> = zhiwei
        .fields
        .iter()
        .map(|f| (f.key.clone(), f.value.clone()))
        .collect();
    assert_eq!(shown, stored);
    // Under the fields, 「关联」 (M17): 沈知微's relations, as F3 lists them.
    let relations = cx
        .update(|_, cx| dr_view_elements::element_relations(&zhiwei.id, cx))
        .expect("the relations under the fields");
    wait_for(cx, |cx| relations.read_with(cx, |r, _| r.is_loaded()));
    let stored = lib
        .call(
            &Actor::User,
            "relation.list",
            serde_json::json!({ "book": book, "entity": { "kind": "element", "id": zhiwei.id } }),
        )
        .unwrap()["output"]
        .as_array()
        .unwrap()
        .len();
    assert!(stored > 0);
    assert_eq!(relations.read_with(cx, |r, _| r.rows().len()), stored);
    // The page opened in an editor with the module's chrome around it.
    let target = Target::Element(zhiwei.id.parse().unwrap());
    assert!(view.read_with(cx, |ws, _| ws.editor_of(&target).is_some()));
}

#[gpui::test]
fn the_name_saves_on_leaving_and_a_taken_one_is_refused(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let zhiwei = element(&lib, &book, "沈知微");
    let (head, _) = open_element(&view, &zhiwei.id, cx);
    let (name, _, _) = head.read_with(cx, |h, _| h.fields());
    wait_for(cx, |cx| name.read_with(cx, |f, _| f.text()) == "沈知微");
    // A new name saves when the caret leaves.
    type_and_leave(
        &view,
        |window, cx| name.focus_handle(cx).focus(window, cx),
        |cx| name.update(cx, |f, cx| f.set_text("沈知微（修复师）", cx)),
        cx,
    );
    let id = zhiwei.id.clone();
    wait_for(cx, |_| {
        elements(&lib, &book)
            .iter()
            .any(|e| e.id == id && e.name == "沈知微（修复师）")
    });
    // Another element's name: the 0.1 alert, and the stored name back.
    type_and_leave(
        &view,
        |window, cx| name.focus_handle(cx).focus(window, cx),
        |cx| name.update(cx, |f, cx| f.set_text("陆远舟", cx)),
        cx,
    );
    let alert = wait_alert(cx);
    assert!(alert.contains("陆远舟"), "{alert}");
    close_dialog(cx);
    assert_eq!(name.read_with(cx, |f, _| f.text()), "沈知微（修复师）");
    assert!(
        elements(&lib, &book)
            .iter()
            .any(|e| e.id == zhiwei.id && e.name == "沈知微（修复师）")
    );
    // Esc puts the stored name back.
    cx.update(|window, cx| name.focus_handle(cx).focus(window, cx));
    frame(cx);
    cx.update(|_, cx| name.update(cx, |f, cx| f.set_text("别的", cx)));
    cx.simulate_keystrokes("escape");
    frame(cx);
    assert_eq!(name.read_with(cx, |f, _| f.text()), "沈知微（修复师）");
}

#[gpui::test]
fn aliases_add_and_go(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let zhiwei = element(&lib, &book, "沈知微");
    let (head, _) = open_element(&view, &zhiwei.id, cx);
    wait_for(cx, |cx| {
        head.read_with(cx, |h, _| h.fields().0.clone())
            .read_with(cx, |f, _| f.text())
            == "沈知微"
    });
    let alias = head.read_with(cx, |h, _| h.fields().1);
    // Enter adds what is typed.
    cx.update(|window, cx| alias.focus_handle(cx).focus(window, cx));
    frame(cx);
    cx.update(|_, cx| alias.update(cx, |f, cx| f.set_text("小微", cx)));
    cx.simulate_keystrokes("enter");
    let id = zhiwei.id.clone();
    wait_for(cx, |_| {
        element(&lib, &book, "沈知微")
            .aliases
            .contains(&"小微".to_owned())
    });
    // One another element has: the alert, nothing added.
    let alias = head.read_with(cx, |h, _| h.fields().1);
    cx.update(|window, cx| alias.focus_handle(cx).focus(window, cx));
    frame(cx);
    cx.update(|_, cx| alias.update(cx, |f, cx| f.set_text("远舟", cx)));
    cx.simulate_keystrokes("enter");
    let alert = wait_alert(cx);
    assert!(alert.contains("远舟"), "{alert}");
    close_dialog(cx);
    assert!(
        !element(&lib, &book, "沈知微")
            .aliases
            .contains(&"远舟".to_owned())
    );
    // The × takes one off.
    cx.update(|window, cx| head.update(cx, |h, cx| h.remove_alias("知微".to_owned(), window, cx)));
    wait_for(cx, |_| {
        !elements(&lib, &book)
            .iter()
            .any(|e| e.id == id && e.aliases.contains(&"知微".to_owned()))
    });
}

#[gpui::test]
fn the_summary_saves_on_leaving(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let zhiwei = element(&lib, &book, "沈知微");
    let (head, _) = open_element(&view, &zhiwei.id, cx);
    let (_, _, summary) = head.read_with(cx, |h, _| h.fields());
    wait_for(cx, |cx| {
        summary.read_with(cx, |f, _| f.text()) == zhiwei.summary
    });
    type_and_leave(
        &view,
        |window, cx| summary.focus_handle(cx).focus(window, cx),
        |cx| summary.update(cx, |f, cx| f.set_text("回到青梅镇的修复师。\n话少。", cx)),
        cx,
    );
    wait_for(cx, |_| {
        element(&lib, &book, "沈知微").summary == "回到青梅镇的修复师。\n话少。"
    });
}

#[gpui::test]
fn fields_are_added_changed_and_removed(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let zhiwei = element(&lib, &book, "沈知微");
    let (_, fields) = open_element(&view, &zhiwei.id, cx);
    wait_for(cx, |cx| fields.read_with(cx, |f, _| f.rows().len()) == 3);
    // 「新增字段」: a blank row, the caret in its key.
    cx.update(|window, cx| fields.update(cx, |f, cx| f.add_row(window, cx)));
    frame(cx);
    let (_, key, value) = fields.read_with(cx, |f, _| f.rows().pop().unwrap());
    assert!(cx.update(|window, cx| key.focus_handle(cx).is_focused(window)));
    cx.update(|_, cx| {
        key.update(cx, |f, cx| f.set_text("籍贯", cx));
        value.update(cx, |f, cx| f.set_text("青梅镇", cx));
    });
    cx.update(|window, cx| view.read(cx).focus_handle().clone().focus(window, cx));
    frame(cx);
    wait_for(cx, |_| {
        element(&lib, &book, "沈知微")
            .fields
            .iter()
            .any(|f| f.key == "籍贯" && f.value == "青梅镇")
    });
    // The new row takes the stored field's id; nothing is doubled.
    wait_for(cx, |cx| {
        fields.read_with(cx, |f, _| f.rows().iter().all(|(id, _, _)| id.is_some()))
    });
    assert_eq!(element(&lib, &book, "沈知微").fields.len(), 4);
    assert_eq!(fields.read_with(cx, |f, _| f.rows().len()), 4);
    // A changed value saves on leaving.
    let (_, _, first_value) = fields.read_with(cx, |f, _| f.rows()[0].clone());
    type_and_leave(
        &view,
        |window, cx| first_value.focus_handle(cx).focus(window, cx),
        |cx| first_value.update(cx, |f, cx| f.set_text("33", cx)),
        cx,
    );
    wait_for(cx, |_| {
        element(&lib, &book, "沈知微")
            .fields
            .iter()
            .any(|f| f.key == "年龄" && f.value == "33")
    });
    // The × removes one; a row emptied and left goes too.
    fields.update(cx, |f, cx| f.remove(3, cx));
    wait_for(cx, |_| element(&lib, &book, "沈知微").fields.len() == 3);
    let (_, key, value) = fields.read_with(cx, |f, _| f.rows()[2].clone());
    cx.update(|window, cx| key.focus_handle(cx).focus(window, cx));
    frame(cx);
    cx.update(|_, cx| {
        key.update(cx, |f, cx| f.set_text("", cx));
        value.update(cx, |f, cx| f.set_text("", cx));
    });
    cx.update(|window, cx| view.read(cx).focus_handle().clone().focus(window, cx));
    frame(cx);
    wait_for(cx, |_| element(&lib, &book, "沈知微").fields.len() == 2);
    assert_eq!(fields.read_with(cx, |f, _| f.rows().len()), 2);
}

#[gpui::test]
fn a_category_page_renames_and_lists_its_elements(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let people = categories(&lib, &book)
        .into_iter()
        .find(|c| c.name == "人物")
        .unwrap();
    let (head, end) = open_category(&view, &people.id, cx);
    let name = head.read_with(cx, |h, _| h.name_field());
    wait_for(cx, |cx| name.read_with(cx, |f, _| f.text()) == "人物");
    // The list is the category's elements; 「已填写」 has a summary or text.
    wait_for(cx, |cx| end.read_with(cx, |e, _| e.words_read()));
    let listed = end.read_with(cx, |e, _| e.elements());
    assert_eq!(listed.len(), people.elements as usize);
    let in_people: Vec<ElementInfo> = elements(&lib, &book)
        .into_iter()
        .filter(|e| e.category.as_deref() == Some(people.id.as_str()))
        .collect();
    assert_eq!(listed.len(), in_people.len());
    assert!(
        listed.iter().all(|(_, used)| *used),
        "every sample person is filled in"
    );
    end.update(cx, |e, cx| e.set_filter(Filter::Unused, cx));
    assert_eq!(end.read_with(cx, |e, _| e.filter), Filter::Unused);
    // Renamed on leaving.
    type_and_leave(
        &view,
        |window, cx| name.focus_handle(cx).focus(window, cx),
        |cx| name.update(cx, |f, cx| f.set_text("人物表", cx)),
        cx,
    );
    let id = people.id.clone();
    wait_for(cx, |_| {
        categories(&lib, &book)
            .iter()
            .any(|c| c.id == id && c.name == "人物表")
    });
}

#[gpui::test]
fn the_menu_moves_an_element_to_another_category_or_a_new_one(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let zhiwei = element(&lib, &book, "沈知微");
    open_element(&view, &zhiwei.id, cx);
    // The ⋯ menu as the shell lists it: share, the two plain rows, the
    // snapshot history, then 删除要素 with what deletes.
    let target = Target::Element(zhiwei.id.parse().unwrap());
    let sections = menu_of(&view, &target, cx);
    assert_eq!(
        ids(&sections),
        [
            vec!["page-share"],
            vec!["element-change-category", "element-change-group"],
            vec!["page-history"],
            vec!["element-delete"],
        ]
    );
    assert!(sections[3].items[0].danger);
    // 更改类目 carries the category's mark, as in the 0.1 menu.
    assert!(matches!(
        sections[1].items[0].icon,
        dr_ui::components::menu::RowIcon::Mark(dr_ui::sand::Kind::Category, _)
    ));
    // 更改类目: a click on 地点 moves it there.
    let run = sections[1].items[0].run.clone();
    cx.update(|window, cx| run(window, cx));
    frame(cx);
    assert_eq!(asking(cx), Some(Asking::ChangeCategory(zhiwei.id.clone())));
    let places = categories(&lib, &book)
        .into_iter()
        .find(|c| c.name == "地点")
        .unwrap();
    let dialogs = cx.update(|_, cx| dr_view_elements::dialogs::dialogs(cx).unwrap());
    let id = places.id.clone();
    cx.update(|window, cx| dialogs.update(cx, |d, cx| d.set_category(Some(id), window, cx)));
    wait_for(cx, |cx| asking(cx).is_none());
    assert_eq!(
        element(&lib, &book, "沈知微").category.as_deref(),
        Some(places.id.as_str())
    );
    // 新建类目…: a name, Enter; the element goes into the new category.
    ask(&view, AskFor::ChangeCategory(zhiwei.id.clone()), cx);
    cx.update(|window, cx| dialogs.update(cx, |d, cx| d.ask_new_category(window, cx)));
    frame(cx);
    assert_eq!(asking(cx), Some(Asking::NewCategory(zhiwei.id.clone())));
    let field = cx.update(|_, cx| dialogs.read(cx).field().unwrap());
    cx.update(|_, cx| field.update(cx, |f, cx| f.set_text("故人", cx)));
    cx.simulate_keystrokes("enter");
    wait_for(cx, |cx| asking(cx).is_none());
    let made = categories(&lib, &book)
        .into_iter()
        .find(|c| c.name == "故人")
        .unwrap();
    assert_eq!(
        element(&lib, &book, "沈知微").category.as_deref(),
        Some(made.id.as_str())
    );
}

#[gpui::test]
fn the_group_dialog_names_a_group_or_none(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let zhiwei = element(&lib, &book, "沈知微");
    open_element(&view, &zhiwei.id, cx);
    ask(&view, AskFor::ChangeGroup(zhiwei.id.clone()), cx);
    assert_eq!(asking(cx), Some(Asking::ChangeGroup(zhiwei.id.clone())));
    let dialogs = cx.update(|_, cx| dr_view_elements::dialogs::dialogs(cx).unwrap());
    let field = cx.update(|_, cx| dialogs.read(cx).field().unwrap());
    // The caret is in the field; Enter saves what is typed.
    assert!(cx.update(|window, cx| field.focus_handle(cx).is_focused(window)));
    cx.update(|_, cx| field.update(cx, |f, cx| f.set_text("沈家", cx)));
    cx.simulate_keystrokes("enter");
    wait_for(cx, |_| {
        element(&lib, &book, "沈知微").group_name.as_deref() == Some("沈家")
    });
    wait_for(cx, |cx| asking(cx).is_none());
    // Enter on an empty field: no group.
    ask(&view, AskFor::ChangeGroup(zhiwei.id.clone()), cx);
    cx.simulate_keystrokes("enter");
    wait_for(cx, |_| element(&lib, &book, "沈知微").group_name.is_none());
    wait_for(cx, |cx| asking(cx).is_none());
    // Esc closes it without a change.
    ask(&view, AskFor::ChangeGroup(zhiwei.id.clone()), cx);
    close_dialog(cx);
}

#[gpui::test]
fn deleting_asks_then_trashes_and_closes_the_page(cx: &mut TestAppContext) {
    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let zhiwei = element(&lib, &book, "沈知微");
    open_element(&view, &zhiwei.id, cx);
    let target = Target::Element(zhiwei.id.parse().unwrap());
    assert!(view.read_with(cx, |ws, _| ws.nav.is_selected(&target)));
    // Esc keeps it.
    ask(&view, AskFor::DeleteElement(zhiwei.id.clone()), cx);
    close_dialog(cx);
    assert!(elements(&lib, &book).iter().any(|e| e.id == zhiwei.id));
    ask(&view, AskFor::DeleteElement(zhiwei.id.clone()), cx);
    let dialogs = cx.update(|_, cx| dr_view_elements::dialogs::dialogs(cx).unwrap());
    cx.update(|window, cx| dialogs.update(cx, |d, cx| d.confirm_delete(window, cx)));
    wait_for(cx, |cx| asking(cx).is_none());
    assert!(!elements(&lib, &book).iter().any(|e| e.id == zhiwei.id));
    // The shell closes the trashed element's tab.
    wait_for(cx, |cx| {
        view.read_with(cx, |ws, _| !ws.nav.is_selected(&target))
    });
    // A category: its ⋯ menu ends with 删除类目; its elements become
    // uncategorized.
    let people = categories(&lib, &book)
        .into_iter()
        .find(|c| c.name == "人物")
        .unwrap();
    let sections = menu_of(&view, &Target::Category(people.id.parse().unwrap()), cx);
    assert_eq!(ids(&sections).last().unwrap(), &["category-delete"]);
    let run = sections.last().unwrap().items[0].run.clone();
    cx.update(|window, cx| run(window, cx));
    frame(cx);
    assert_eq!(asking(cx), Some(Asking::DeleteCategory(people.id.clone())));
    cx.update(|window, cx| dialogs.update(cx, |d, cx| d.confirm_delete(window, cx)));
    wait_for(cx, |cx| asking(cx).is_none());
    assert!(!categories(&lib, &book).iter().any(|c| c.id == people.id));
    assert!(element(&lib, &book, "沈怀山").category.is_none());
}

#[gpui::test]
fn the_category_swatch_picks_its_colour(cx: &mut TestAppContext) {
    use std::cell::RefCell;
    use std::rc::Rc;

    use dr_ui::components::color::{self, OnPick};
    use dr_ui::tokens::Rgb;

    let (_dir, library, book) = library();
    let lib = library.clone();
    let (view, cx) = setup(cx, library);
    let opened: Rc<RefCell<Option<(Rgb, OnPick)>>> = Rc::default();
    cx.update(|_, cx| {
        let opened = opened.clone();
        color::set_color_picker(cx, move |current, on_pick, _, _| {
            *opened.borrow_mut() = Some((current, on_pick));
        });
    });
    let first = categories(&lib, &book).into_iter().next().unwrap();
    let _ = open_category(&view, &first.id, cx);
    frame(cx);
    let swatch = cx
        .debug_bounds("category-color")
        .expect("the swatch is drawn");
    cx.simulate_click(swatch.center(), Modifiers::none());
    let (current, on_pick) = opened.borrow().clone().expect("the picker opened");
    // It opens on the category's own colour.
    assert_eq!(
        color::hex(current),
        first.color.to_ascii_lowercase(),
        "the picker starts from the stored colour"
    );
    cx.update(|window, cx| on_pick(Rgb::hex(0x2d4a6b), window, cx));
    frame(cx);
    cx.executor()
        .advance_clock(dr_view_elements::swatch::SETTLE);
    let id = first.id.clone();
    wait_for(cx, |_| {
        categories(&lib, &book)
            .into_iter()
            .any(|c| c.id == id && c.color == "#2d4a6b")
    });
}
