//! Relations and relation types on GPUI's test platform, over a real library
//! (F3 over dr-store) seeded with dr-testkit's 《阿Q正传》 (nine relation
//! types; 阿Q has fifteen relations), with the shell's workspace window
//! for the book's names and the section in a window of its own.
//!
//! - 阿Q's 「关联」 lists his relations newest first, each other end named
//!   from the book, its type known; another writer's relation shows.
//! - The picker offers what is not related yet, by kind and by name; the
//!   chosen one takes only a type that fits the pair (turned round, the
//!   others), and 「创建」 makes it in F3 and closes the picker.
//! - A card's type changes (turned round when the new type fits only the
//!   other way), ⇄ turns it round, × removes it; each reaches F3.
//! - The types: a new one (name, 对称, roles), a name another type has is
//!   refused under the editor, the name changes, a colour is stored as the
//!   0.1 token, the trash asks first as the workspace window's dialog and
//!   only for a type no relation uses; the built-in association is neither
//!   changed nor deleted.
//! - 「新建关系类型」 in the pending pair's type menu makes a type for the
//!   pair's kinds and chooses it.

use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_relations::model::{Filter, Paint, end};
use dr_view_relations::{DeleteTypeDialog, MenuFor, Relations, TypeManager};
use dr_workspace::commands::relation::{
    RelationCreate, RelationCreateIn, RelationList, RelationListIn, RelationTypeList,
};
use dr_workspace::commands::{BookIn, ListIn, element::ElementList, element::ElementListIn};
use dr_workspace::dto::{RelationInfo, RelationTypeInfo, Target as End};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{Entity, Focusable as _, TestAppContext, VisualTestContext};

const VERSION: &str = "0.2.0-dev";

struct Setup {
    _dir: tempfile::TempDir,
    lib: Library,
    book: String,
}

fn seeded() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::a_q().unwrap();
    dr_testkit::seed::write_book(&store, &book).unwrap();
    let book_id = book.book_id().to_string();
    store.close().unwrap();
    Setup {
        _dir: dir,
        lib: Library::open_dir(&root, VERSION).unwrap(),
        book: book_id,
    }
}

fn element_id(s: &Setup, name: &str) -> String {
    s.lib
        .run::<ElementList>(
            &Actor::User,
            ElementListIn {
                book: s.book.clone(),
                ..ElementListIn::default()
            },
        )
        .unwrap()
        .output
        .into_iter()
        .find(|e| e.name == name)
        .unwrap_or_else(|| panic!("{name} in the book"))
        .id
}

fn chapter_ids(s: &Setup) -> Vec<String> {
    s.lib
        .run::<dr_workspace::commands::chapter::ChapterList>(
            &Actor::User,
            ListIn {
                book: s.book.clone(),
                trashed: false,
            },
        )
        .unwrap()
        .output
        .into_iter()
        .map(|c| c.id)
        .collect()
}

fn stored_relations(s: &Setup, owner: &End) -> Vec<RelationInfo> {
    s.lib
        .run::<RelationList>(
            &Actor::User,
            RelationListIn {
                book: s.book.clone(),
                entity: Some(owner.clone()),
                relation_type: None,
            },
        )
        .unwrap()
        .output
}

fn stored_types(s: &Setup) -> Vec<RelationTypeInfo> {
    s.lib
        .run::<RelationTypeList>(
            &Actor::User,
            BookIn {
                book: s.book.clone(),
            },
        )
        .unwrap()
        .output
}

fn type_named(s: &Setup, name: &str) -> RelationTypeInfo {
    stored_types(s)
        .into_iter()
        .find(|t| t.name == name)
        .unwrap_or_else(|| panic!("type {name}"))
}

/// The shell over the seeded library, its workspace window (which opens
/// the book), and `owner`'s 「关联」 in a window of its own.
fn open<'a>(
    cx: &'a mut TestAppContext,
    s: &Setup,
    owner: End,
) -> (
    Entity<Workspace>,
    Entity<Relations>,
    &'a mut VisualTestContext,
) {
    cx.executor().allow_parking();
    let lib = s.lib.clone();
    cx.update(|cx| {
        let mut file = SettingsFile::in_memory();
        file.set(
            dr_shell::settings::registry::UI_LOCALE,
            "zh-CN".into(),
            None,
        )
        .ok();
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
            file,
            cx,
        );
    });
    let ws_window = cx.add_window(Workspace::new);
    let ws = ws_window.root(cx).unwrap();
    let weak = ws.downgrade();
    let (view, vcx) = cx.add_window_view(move |window, cx| Relations::new(owner, weak, window, cx));
    wait_for(vcx, |cx| ws.read_with(cx, |w, _| !w.book.is_empty()));
    wait_for(vcx, |cx| view.read_with(cx, |r, _| r.is_loaded()));
    (ws, view, vcx)
}

/// Runs the app until `done` holds, at most thirty seconds.
fn wait_for(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn settle(view: &Entity<Relations>, cx: &mut VisualTestContext) {
    wait_for(cx, |cx| view.read_with(cx, |r, _| r.is_settled()));
}

fn settle_types(m: &Entity<TypeManager>, cx: &mut VisualTestContext) {
    wait_for(cx, |cx| m.read_with(cx, |m, _| m.is_settled()));
}

fn type_into(field: &Entity<dr_ui::input::TextField>, text: &str, cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        let handle = field.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
    });
    field.update(cx, |f, cx| f.set_text("", cx));
    cx.run_until_parked();
    cx.simulate_input(text);
    cx.run_until_parked();
}

#[gpui::test]
fn the_relations_show_newest_first_and_another_writers_too(cx: &mut TestAppContext) {
    let s = seeded();
    let aq = end("element", &element_id(&s, "阿Q"));
    let (_ws, view, cx) = open(cx, &s, aq.clone());
    let stored = stored_relations(&s, &aq);
    assert_eq!(stored.len(), 15);
    let rows = view.read_with(cx, |r, _| r.rows().to_vec());
    assert_eq!(rows.len(), 15);
    assert!(rows.windows(2).all(|w| w[0].id > w[1].id), "newest first");
    assert_eq!(
        view.read_with(cx, |r, _| r.types().len()),
        10,
        "nine and the built-in one"
    );
    // 赵太爷 bullies 阿Q: in, 欺辱.
    let zhao = element_id(&s, "赵太爷");
    let bully = type_named(&s, "欺辱");
    assert!(
        rows.iter()
            .any(|r| r.other.id == zhao && !r.outgoing && r.relation_type == bully.id)
    );

    // An Agent relates 阿Q to 赵白眼: it shows.
    let baiyan = element_id(&s, "赵白眼");
    s.lib
        .run::<RelationCreate>(
            &Actor::Agent {
                session: "test".into(),
                turn: 1,
                call: "relation.create".into(),
            },
            RelationCreateIn {
                book: s.book.clone(),
                from: aq.clone(),
                to: end("element", &baiyan),
                relation_type: Some(type_named(&s, "冤家").id),
                id: None,
            },
        )
        .unwrap();
    wait_for(cx, |cx| view.read_with(cx, |r, _| r.rows().len() == 16));
    let first = view.read_with(cx, |r, _| r.rows()[0].clone());
    assert_eq!(first.other.id, baiyan, "the newest is first");
}

#[gpui::test]
fn the_picker_relates_with_a_type_that_fits(cx: &mut TestAppContext) {
    let s = seeded();
    let aq = end("element", &element_id(&s, "阿Q"));
    let (_ws, view, cx) = open(cx, &s, aq.clone());
    view.update(cx, |r, cx| r.set_picking(true, cx));
    // Everything not related yet: 阿Q himself and his fifteen are left out.
    let all = view.read_with(cx, |r, cx| r.candidates(cx));
    assert!(!all.iter().any(|c| c.end == aq));
    assert!(!all.iter().any(|c| c.end.id == element_id(&s, "吴妈")));
    // 29 elements less 阿Q and the twelve his fifteen relations reach; the
    // chapters, ideas, categories and storylines (fewer than fifty in all).
    let elements = all.iter().filter(|c| c.end.kind == "element").count();
    assert_eq!(elements, 29 - 1 - 12);
    assert!(all.len() <= dr_view_relations::model::MAX_CANDIDATES);
    assert!(all.iter().any(|c| c.end.kind == "node"));
    assert!(all.iter().any(|c| c.end.kind == "category"));
    assert!(all.iter().any(|c| c.end.kind == "storyline"));
    // By kind and by name.
    view.update(cx, |r, cx| r.set_filter(Filter::Element, cx));
    let field = view.read_with(cx, |r, _| r.query_field());
    type_into(&field, "赵", cx);
    let names: Vec<String> = view.read_with(cx, |r, cx| {
        r.candidates(cx)
            .iter()
            .map(|c| c.shown.title.clone())
            .collect()
    });
    // 赵太爷 and 赵秀才 are related already (欺辱).
    assert_eq!(names, ["赵白眼", "赵司晨", "赵府"]);
    view.update(cx, |r, cx| r.set_filter(Filter::Node, cx));
    type_into(&field, "", cx);
    let chapters = view.read_with(cx, |r, cx| r.candidates(cx));
    assert!(!chapters.is_empty() && chapters.iter().all(|c| c.end.kind == "node"));

    // A chapter: only 关键章节 fits 阿Q → chapter; nothing the other way.
    let chapter = chapters[0].end.clone();
    view.update(cx, |r, cx| r.choose(chapter.clone(), cx));
    view.update(cx, |r, cx| r.toggle_menu(MenuFor::Pending, cx));
    let options: Vec<String> = view.read_with(cx, |r, _| {
        r.menu_options().iter().map(|t| t.name.clone()).collect()
    });
    assert_eq!(options, ["关键章节"]);
    view.update(cx, |r, cx| r.reverse_pending(cx));
    view.update(cx, |r, cx| r.toggle_menu(MenuFor::Pending, cx));
    assert!(view.read_with(cx, |r, _| r.menu_options().is_empty()));

    // 赵白眼 → 阿Q, 欺辱.
    view.update(cx, |r, cx| r.set_filter(Filter::Element, cx));
    let baiyan = end("element", &element_id(&s, "赵白眼"));
    view.update(cx, |r, cx| r.choose(baiyan.clone(), cx));
    view.update(cx, |r, cx| r.reverse_pending(cx));
    let bully = type_named(&s, "欺辱");
    view.update(cx, |r, cx| r.set_pending_type(&bully.id, cx));
    view.update(cx, |r, cx| r.create(cx));
    assert!(
        !view.read_with(cx, |r, _| r.is_picking()),
        "the picker closes"
    );
    settle(&view, cx);
    let made = stored_relations(&s, &aq)
        .into_iter()
        .find(|r| r.from == baiyan)
        .expect("made in F3");
    assert_eq!(
        (made.to.clone(), made.relation_type.clone()),
        (aq.clone(), bully.id.clone())
    );
    let rows = view.read_with(cx, |r, _| r.rows().to_vec());
    assert!(rows.iter().any(|r| r.id == made.id && !r.outgoing));
}

#[gpui::test]
fn a_cards_type_changes_turns_round_and_goes(cx: &mut TestAppContext) {
    let s = seeded();
    let aq = end("element", &element_id(&s, "阿Q"));
    let (_ws, view, cx) = open(cx, &s, aq.clone());
    let tuguci = element_id(&s, "土谷祠");
    let place = type_named(&s, "住在");
    let holds = type_named(&s, "持有");
    let row = view.read_with(cx, |r, _| {
        r.rows()
            .iter()
            .find(|r| r.other.id == tuguci)
            .cloned()
            .unwrap()
    });
    assert_eq!(row.relation_type, place.id);
    assert!(row.outgoing);

    // 住在 → 持有: same direction (both element → element, directed).
    view.update(cx, |r, cx| r.toggle_menu(MenuFor::Row(row.id.clone()), cx));
    let options: Vec<String> = view.read_with(cx, |r, _| {
        r.menu_options().iter().map(|t| t.name.clone()).collect()
    });
    assert!(options.contains(&"持有".to_string()) && !options.contains(&"关键章节".to_string()));
    view.update(cx, |r, cx| r.change_type(&row.id, &holds.id, cx));
    settle(&view, cx);
    let now = stored_relations(&s, &aq);
    let r = now
        .iter()
        .find(|r| r.to.id == tuguci)
        .expect("still related");
    assert_eq!(
        (r.from.clone(), r.relation_type.clone()),
        (aq.clone(), holds.id.clone())
    );
    assert!(!now.iter().any(|x| x.id == row.id), "the old one went");

    // ⇄: 土谷祠 → 阿Q.
    let row = view.read_with(cx, |r, _| {
        r.rows()
            .iter()
            .find(|r| r.other.id == tuguci)
            .cloned()
            .unwrap()
    });
    view.update(cx, |r, cx| r.swap(&row.id, cx));
    settle(&view, cx);
    let r = stored_relations(&s, &aq)
        .into_iter()
        .find(|r| r.from.id == tuguci)
        .expect("turned round");
    assert_eq!(r.to, aq);
    let row = view.read_with(cx, |r, _| {
        r.rows()
            .iter()
            .find(|r| r.other.id == tuguci)
            .cloned()
            .unwrap()
    });
    assert!(!row.outgoing);

    // ×.
    view.update(cx, |r, cx| r.remove(&row.id, cx));
    settle(&view, cx);
    assert!(
        !stored_relations(&s, &aq)
            .iter()
            .any(|r| r.from.id == tuguci || r.to.id == tuguci)
    );
    assert_eq!(view.read_with(cx, |r, _| r.rows().len()), 14);
}

#[gpui::test]
fn the_types_are_made_changed_coloured_and_deleted(cx: &mut TestAppContext) {
    let s = seeded();
    let aq = end("element", &element_id(&s, "阿Q"));
    let (ws, view, cx) = open(cx, &s, aq.clone());
    cx.update(|window, cx| view.update(cx, |r, cx| r.toggle_manager(window, cx)));
    let m = view
        .read_with(cx, |r, _| r.manager())
        .expect("the types open");
    wait_for(cx, |cx| m.read_with(cx, |m, _| m.is_loaded()));
    let bully = type_named(&s, "欺辱");
    assert_eq!(m.read_with(cx, |m, _| m.usage(&bully.id)), 6);

    // A name another type has is refused, under the editor.
    cx.update(|window, cx| m.update(cx, |m, cx| m.start_new(None, window, cx)));
    let [name, role, _, _] = m.read_with(cx, |m, _| m.fields()).unwrap();
    type_into(&name, "本家", cx);
    m.update(cx, |m, cx| m.save(cx));
    settle_types(&m, cx);
    let error = m.read_with(cx, |m, _| m.error().map(str::to_owned));
    assert!(
        error.is_some_and(|e| e.contains("本家")),
        "the refusal shows"
    );

    // 师徒, symmetric, one role.
    type_into(&name, "师徒", cx);
    m.update(cx, |m, cx| m.set_symmetric(true, cx));
    type_into(&role, "同门", cx);
    m.update(cx, |m, cx| m.save(cx));
    settle_types(&m, cx);
    assert!(m.read_with(cx, |m, _| m.editing().is_none()));
    let made = type_named(&s, "师徒");
    assert_eq!(made.orientation, "symmetric");
    assert_eq!(
        (made.source_role.as_str(), made.target_role.as_str()),
        ("同门", "同门")
    );
    assert_eq!(made.source_kinds, made.target_kinds);
    assert!(!made.source_kinds.contains(&"comment".to_string()));

    // Renamed; direction and kinds stay (F3 keeps them).
    cx.update(|window, cx| m.update(cx, |m, cx| m.start_edit(&made.id, window, cx)));
    let [name, _, _, _] = m.read_with(cx, |m, _| m.fields()).unwrap();
    type_into(&name, "师生", cx);
    m.update(cx, |m, cx| m.set_symmetric(false, cx));
    m.update(cx, |m, cx| m.save(cx));
    settle_types(&m, cx);
    let renamed = stored_types(&s)
        .into_iter()
        .find(|t| t.id == made.id)
        .unwrap();
    assert_eq!(
        (renamed.name.as_str(), renamed.orientation.as_str()),
        ("师生", "symmetric")
    );

    // A colour, stored as the 0.1 token; back to the default.
    m.update(cx, |m, cx| m.toggle_colors(&made.id, cx));
    assert_eq!(
        m.read_with(cx, |m, _| m.coloring().map(str::to_owned)),
        Some(made.id.clone())
    );
    m.update(cx, |m, cx| m.set_color(&made.id, Some(Paint::Story(2)), cx));
    settle_types(&m, cx);
    let t = stored_types(&s)
        .into_iter()
        .find(|t| t.id == made.id)
        .unwrap();
    assert_eq!(t.color.as_deref(), Some("hsl(var(--story-3))"));
    m.update(cx, |m, cx| m.set_color(&made.id, None, cx));
    settle_types(&m, cx);
    assert_eq!(
        stored_types(&s)
            .into_iter()
            .find(|t| t.id == made.id)
            .unwrap()
            .color,
        None
    );

    // The built-in association: neither edited nor recoloured.
    let builtin = stored_types(&s).into_iter().find(|t| t.locked).unwrap();
    cx.update(|window, cx| m.update(cx, |m, cx| m.start_edit(&builtin.id, window, cx)));
    assert!(m.read_with(cx, |m, _| m.editing().is_none()));
    m.update(cx, |m, cx| m.toggle_colors(&builtin.id, cx));
    assert!(m.read_with(cx, |m, _| m.coloring().is_none()));

    // The trash: a type in use asks nothing; the new one asks first.
    cx.update(|window, cx| m.update(cx, |m, cx| m.ask_delete(&bully.id, window, cx)));
    cx.run_until_parked();
    assert!(ws.read_with(cx, |w, _| w.dialog.is_none()));
    cx.update(|window, cx| m.update(cx, |m, cx| m.ask_delete(&made.id, window, cx)));
    cx.run_until_parked();
    let dialog = ws
        .read_with(cx, |w, _| w.dialog.clone())
        .expect("the question is the workspace window's dialog");
    let dialog = dialog
        .downcast::<DeleteTypeDialog>()
        .expect("the delete question");
    assert_eq!(dialog.read_with(cx, |d, _| d.type_id().to_owned()), made.id);
    assert!(
        view.read_with(cx, |r, _| r.manager().is_none()),
        "the types close under the question"
    );
    assert!(
        stored_types(&s).iter().any(|t| t.id == made.id),
        "nothing gone yet"
    );
    dialog.update(cx, |d, cx| d.confirm(cx));
    wait_for(cx, |_| !stored_types(&s).iter().any(|t| t.id == made.id));
}

#[gpui::test]
fn a_new_type_for_the_pending_pair_is_chosen(cx: &mut TestAppContext) {
    let s = seeded();
    let aq = end("element", &element_id(&s, "阿Q"));
    let (_ws, view, cx) = open(cx, &s, aq.clone());
    let chapter = end("node", &chapter_ids(&s)[0]);
    view.update(cx, |r, cx| r.set_picking(true, cx));
    view.update(cx, |r, cx| r.choose(chapter.clone(), cx));
    view.update(cx, |r, cx| r.reverse_pending(cx));
    // Chapter → 阿Q: no type fits; 「新建关系类型」 opens one for the pair.
    view.update(cx, |r, cx| r.toggle_menu(MenuFor::Pending, cx));
    assert!(view.read_with(cx, |r, _| r.menu_options().is_empty()));
    cx.update(|window, cx| view.update(cx, |r, cx| r.new_type_for_pending(window, cx)));
    let m = view
        .read_with(cx, |r, _| r.manager())
        .expect("the types open");
    let draft = m
        .read_with(cx, |m, _| m.draft().cloned())
        .expect("a new type's editor");
    assert_eq!(
        draft.kinds(),
        (vec!["node".to_string()], vec!["element".to_string()])
    );
    let [name, _, _, _] = m.read_with(cx, |m, _| m.fields()).unwrap();
    type_into(&name, "出场", cx);
    m.update(cx, |m, cx| m.save(cx));
    settle_types(&m, cx);
    settle(&view, cx);
    let made = type_named(&s, "出场");
    let pending = view.read_with(cx, |r, _| r.pending().cloned()).unwrap();
    assert_eq!(pending.relation_type.as_deref(), Some(made.id.as_str()));
    assert!(
        view.read_with(cx, |r, _| r.manager().is_none()),
        "back at the pair"
    );
    view.update(cx, |r, cx| r.create(cx));
    settle(&view, cx);
    assert!(
        stored_relations(&s, &aq)
            .iter()
            .any(|r| r.from == chapter && r.relation_type == made.id)
    );
}
