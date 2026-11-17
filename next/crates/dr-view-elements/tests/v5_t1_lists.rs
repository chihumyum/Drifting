//! T1 (`kernel-v5.md` §16 「挂名」「条目页」): what a drop onto an entry
//! does follows its two switches, and an entry page lists an entry that
//! both lives under it and is attached to it once.
use std::{
    collections::BTreeSet,
    rc::Rc,
    time::{Duration, Instant},
};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as Shell,
    book::Book,
    pages::PageViewHost,
    v3::{DisplaySurface, LevelHost, ROOT_LEVEL},
};
use dr_view_elements::{
    data::v3::{
        Drop, DropSlot, SortOrder, drop_attaches, prepare_resolved_drop, resolve_drop_with,
        resolve_hung_drop,
    },
    panel::v3::{Display, LevelDisplay, Row, rows},
};
use dr_workspace::{Actor, Workspace};
use gpui::{
    AppContext as _, Context, Entity, IntoElement, Modifiers, MouseButton, ParentElement as _,
    Render, Styled as _, TestAppContext, VisualTestContext, WeakEntity, Window, div, point, px,
    size,
};
use serde_json::{Value, json};

fn seed() -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let id = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, id)
}
fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn of_template(book: &Book, template: &str) -> String {
    book.v3()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some(template))
        .unwrap()
        .id
        .clone()
}

/// 作者 2026-11-16 (T9.1): dragging a living row in the left tree moves house
/// only: onto an entry with both switches on (写书模板's 「分类」) it moves in,
/// and with ⌥ held attaches it; onto a plain level it moves in even with ⌥
/// held; onto an entry that only accepts entries from elsewhere it is refused.
#[test]
fn a_drop_moves_in_attaches_with_option_and_follows_the_switches() {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    let category = of_template(&snapshot, "tpl-category");
    let storyline = of_template(&snapshot, "tpl-storyline");
    let manuscript = of_template(&snapshot, "tpl-manuscript");
    assert!(v.entry(&category).unwrap().level && v.accepts_members(&category));
    assert!(!v.entry(&storyline).unwrap().level && v.accepts_members(&storyline));
    assert!(v.entry(&manuscript).unwrap().level && !v.accepts_members(&manuscript));
    assert_eq!(drop_attaches(&snapshot, &category, false), Some(false));
    assert_eq!(drop_attaches(&snapshot, &category, true), Some(true));
    assert_eq!(drop_attaches(&snapshot, &storyline, false), None);
    assert_eq!(drop_attaches(&snapshot, &storyline, true), None);
    assert_eq!(drop_attaches(&snapshot, &manuscript, true), Some(false));

    // An element living in another category, dropped onto this one.
    let element = v
        .entries
        .iter()
        .find(|e| {
            e.template.as_deref() == Some("tpl-character")
                && e.parent.as_deref() != Some(category.as_str())
        })
        .or_else(|| {
            v.entries.iter().find(|e| {
                e.template.as_deref() == Some("tpl-element")
                    && e.parent.as_deref() != Some(category.as_str())
            })
        })
        .map(|e| e.id.clone());
    let element = match element {
        Some(e) => e,
        None => call(
            &ws,
            "entry.create",
            json!({"book":book,"parent":manuscript,"title":"Synthetic loose"}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned(),
    };
    let snapshot = Book::load(&ws, &book).unwrap();
    let drop = |onto: &str, attach: bool| {
        resolve_drop_with(
            &snapshot,
            &element,
            onto,
            DropSlot::Into,
            false,
            false,
            attach,
        )
    };
    assert_eq!(
        drop(&category, false),
        Some(Drop::Residence {
            parent: Some(category.clone()),
            anchor: None
        })
    );
    assert_eq!(
        drop(&category, true),
        Some(Drop::Membership {
            host: category.clone()
        })
    );
    let chapter = of_template(&snapshot, "tpl-chapter");
    let onto_line = resolve_drop_with(
        &snapshot,
        &chapter,
        &storyline,
        DropSlot::Into,
        false,
        false,
        false,
    );
    assert_eq!(
        onto_line, None,
        "a living row dropped onto an accept-only storyline is refused"
    );

    // Hung row drag (`W31Hung`): moves hang from `storyline` to `other_line`
    // while keeping residence unchanged. Its own residence removes the hang.
    let storylines_root = of_template(&snapshot, "tpl-storylines");
    let other_line = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":storylines_root,"template":"tpl-storyline","title":"Second line"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &ws,
        "membership.add",
        json!({"book":book,"host":storyline,"member":chapter}),
    );
    let snapshot = Book::load(&ws, &book).unwrap();
    let chapter_parent = snapshot
        .v3()
        .unwrap()
        .entry(&chapter)
        .unwrap()
        .parent
        .clone();
    let parent = chapter_parent.as_deref().unwrap();
    let refused = snapshot
        .v3()
        .unwrap()
        .entries
        .iter()
        .find(|e| {
            e.id != parent && e.id != chapter && !snapshot.v3().unwrap().accepts_members(&e.id)
        })
        .unwrap();
    let drop = |onto, alt| {
        resolve_hung_drop(
            &snapshot,
            &chapter,
            &storyline,
            onto,
            None,
            DropSlot::Into,
            alt,
        )
    };
    assert_eq!(drop(&refused.id, false), None);
    assert_eq!(
        drop(parent, false),
        Some(Drop::DetachMembership {
            host: storyline.clone()
        })
    );
    assert_eq!(
        drop(&other_line, true),
        Some(Drop::Membership {
            host: other_line.clone()
        })
    );
    let moved_hang = drop(&other_line, false);
    assert_eq!(
        moved_hang,
        Some(Drop::MoveMembership {
            from_host: storyline.clone(),
            to_host: other_line.clone(),
        })
    );
    prepare_resolved_drop(&snapshot, &chapter, moved_hang.unwrap())
        .unwrap()
        .commit(&ws)
        .unwrap();
    let after_move = Book::load(&ws, &book).unwrap();
    let v_after = after_move.v3().unwrap();
    assert_eq!(v_after.entry(&chapter).unwrap().parent, chapter_parent);
    assert!(!v_after.levels[&storyline].members.contains(&chapter));
    assert!(v_after.levels[&other_line].members.contains(&chapter));
    ws.undo(&Actor::User)
        .unwrap()
        .expect("one undo returns the hang");
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    assert!(v.levels[&storyline].members.contains(&chapter));
    assert!(!v.levels[&other_line].members.contains(&chapter));
    prepare_resolved_drop(
        &snapshot,
        &chapter,
        Drop::Membership {
            host: other_line.clone(),
        },
    )
    .unwrap()
    .commit(&ws)
    .unwrap();
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    assert!(v.levels[&storyline].members.contains(&chapter));
    assert!(v.levels[&other_line].members.contains(&chapter));
    let detach = resolve_hung_drop(
        &snapshot,
        &chapter,
        &storyline,
        parent,
        None,
        DropSlot::Into,
        false,
    )
    .unwrap();
    prepare_resolved_drop(&snapshot, &chapter, detach)
        .unwrap()
        .commit(&ws)
        .unwrap();
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    assert_eq!(v.entry(&chapter).unwrap().parent, chapter_parent);
    assert!(!v.levels[&storyline].members.contains(&chapter));
    assert!(v.levels[&other_line].members.contains(&chapter));
    ws.shutdown().unwrap();
}

#[test]
fn a_hung_row_reorders_on_the_first_scale_or_in_the_hosts_manual_order() {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let category = of_template(&snapshot, "tpl-category");
    let lane = of_template(&snapshot, "tpl-storyline");
    let chapters: Vec<_> = snapshot
        .v3()
        .unwrap()
        .entries
        .iter()
        .filter(|entry| entry.template.as_deref() == Some("tpl-chapter"))
        .take(2)
        .map(|entry| entry.id.clone())
        .collect();
    let view = snapshot
        .v3()
        .unwrap()
        .ordering_view(&lane)
        .unwrap()
        .id
        .clone();
    for host in [&category, &lane] {
        for chapter in &chapters {
            call(
                &ws,
                "membership.add",
                json!({"book":book,"host":host,"member":chapter}),
            );
        }
        let snapshot = Book::load(&ws, &book).unwrap();
        let ordered = |book: &Book| {
            let v = book.v3().unwrap();
            let ids = v.ordering_view(host).map_or_else(
                || v.levels[host].members.clone(),
                |view| v.lane_entries(view, host),
            );
            ids.into_iter()
                .filter(|id| chapters.contains(id))
                .collect::<Vec<_>>()
        };
        let old = ordered(&snapshot);
        assert_eq!(old.len(), 2);
        let moving = &old[1];
        let anchor = &old[0];
        let proposed = resolve_hung_drop(
            &snapshot,
            moving,
            host,
            anchor,
            Some(host),
            DropSlot::Before,
            false,
        )
        .expect("drop slot in the same group");
        let other_scale = snapshot
            .v3()
            .unwrap()
            .timeline_view(&view)
            .unwrap()
            .placements
            .clone();
        prepare_resolved_drop(&snapshot, moving, proposed)
            .unwrap()
            .commit(&ws)
            .unwrap();
        let after = Book::load(&ws, &book).unwrap();
        assert_eq!(ordered(&after), vec![moving.clone(), anchor.clone()]);
        let positions = &after.v3().unwrap().timeline_view(&view).unwrap().placements;
        if *host == category {
            assert_eq!(positions, &other_scale);
        } else {
            assert_ne!(positions, &other_scale);
            assert_eq!(
                after.v3().unwrap().levels[host].members.len(),
                snapshot.v3().unwrap().levels[host].members.len()
            );
        }
        for chapter in &chapters {
            assert_eq!(
                after.v3().unwrap().entry(chapter).unwrap().parent,
                snapshot.v3().unwrap().entry(chapter).unwrap().parent
            );
        }
        ws.undo(&Actor::User)
            .unwrap()
            .expect("one undo restores the order");
        assert_eq!(ordered(&Book::load(&ws, &book).unwrap()), old);
    }
    ws.shutdown().unwrap();
}

/// 「既住又挂的只列一次」: an entry that lives under a category and is
/// attached to it shows in 「下面的条目」 only.
#[test]
fn an_entry_living_here_and_attached_here_is_listed_once() {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let category = of_template(&snapshot, "tpl-category");
    let resident = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":category,"title":"Synthetic both"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &ws,
        "membership.add",
        json!({"book":book,"host":category,"member":resident}),
    );
    let snapshot = Book::load(&ws, &book).unwrap();
    let list = |surface| {
        rows(
            &snapshot,
            &category,
            Display::List,
            surface,
            &BTreeSet::new(),
            2,
        )
    };
    let below = list(DisplaySurface::Page);
    let attached = list(DisplaySurface::Members);
    assert!(below.contains(&Row::Entry {
        id: resident.clone(),
        depth: 0
    }));
    assert!(
        !attached
            .iter()
            .any(|r| matches!(r, Row::Member { id, .. } if *id == resident)),
        "listed once, under what lives here"
    );
    let tab = list(DisplaySurface::Sidebar);
    assert_eq!(
        tab.iter()
            .filter(
                |r| matches!(r, Row::Entry { id, .. } | Row::Member { id, .. } if *id == resident)
            )
            .count(),
        1
    );
    ws.shutdown().unwrap();
}

/// The Tab prototype (2026-11-15): 「全部」 opens with the outermost entries
/// folded; another Tab's list opens unfolded.
#[test]
fn all_opens_with_the_outermost_entries_folded() {
    let (_dir, ws, id) = seed();
    let book = std::rc::Rc::new(Book::load(&ws, &id).unwrap());
    let host = |level: &str| LevelHost {
        page: PageViewHost {
            workspace: WeakEntity::new_invalid(),
            library: ws.clone(),
            book_id: id.clone(),
            book: book.clone(),
        },
        level: level.to_owned(),
        surface: DisplaySurface::Sidebar,
    };
    let v = book.v3().unwrap();
    let all = LevelDisplay::new(host(ROOT_LEVEL), Display::List);
    let listed: Vec<String> = all
        .rows
        .iter()
        .map(|row| match row {
            Row::Entry { id, depth } => {
                assert_eq!(*depth, 0, "only the outermost entries: {id}");
                id.clone()
            }
            other => panic!("unexpected row {other:?}"),
        })
        .collect();
    assert_eq!(listed, v.roots);
    let manuscript = of_template(&book, "tpl-manuscript");
    let tab = LevelDisplay::new(host(&manuscript), Display::List);
    assert!(
        tab.rows
            .iter()
            .any(|row| matches!(row, Row::Entry { depth, .. } if *depth >= 1)),
        "a level's own Tab opens unfolded"
    );
}

// ---- the left tree's hung rows, drawn (T9 review) --------------------------

/// A window holding the shell's workspace (so a drag is current) and one
/// list of the left column.
struct Tree {
    workspace: Entity<Shell>,
    list: Option<Entity<LevelDisplay>>,
}
impl Render for Tree {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .children(self.list.clone().map(|list| div().size_full().child(list)))
    }
}

fn frame(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn wait_for(cx: &mut VisualTestContext, what: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        frame(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < until, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// The left column's list of `level`, in a window whose workspace has the
/// book open.
fn tree<'a>(
    cx: &'a mut TestAppContext,
    ws: &Workspace,
    book: &str,
    level: &str,
) -> (
    Entity<Tree>,
    Entity<LevelDisplay>,
    &'a mut VisualTestContext,
) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(dr_ui::Appearance::Light),
            },
            Services {
                library: Some(ws.clone()),
                book: Some(book.to_owned()),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_elements::init(cx);
    });
    let (view, vcx) = cx.add_window_view(|window, cx| Tree {
        workspace: cx.new(|cx| Shell::new(window, cx)),
        list: None,
    });
    vcx.simulate_resize(size(px(900.0), px(1400.0)));
    let shell = view.read_with(vcx, |t, _| t.workspace.clone());
    let revision = Book::load(ws, book).unwrap().v3().unwrap().revision.clone();
    wait_for(vcx, "the workspace opens the book", |cx| {
        shell.read_with(cx, |w, _| {
            w.book.v3().is_some_and(|v| v.revision == revision)
        })
    });
    let host = LevelHost {
        page: PageViewHost {
            workspace: shell.downgrade(),
            library: ws.clone(),
            book_id: book.to_owned(),
            book: shell.read_with(vcx, |w, _| w.book.clone()),
        },
        level: level.to_owned(),
        surface: DisplaySurface::Sidebar,
    };
    let list = view.update(vcx, |t, cx| {
        let list = cx.new(|_| LevelDisplay::new(host, Display::List));
        t.list = Some(list.clone());
        cx.notify();
        list
    });
    frame(vcx);
    (view, list, vcx)
}

fn guide(host: &str, id: &str) -> &'static str {
    Box::leak(format!("v3-hung-guide-{host}-{id}").into_boxed_str())
}

/// Drags the hung row `id` (on `host`) by its row and lets go over the top
/// half of the hung row `onto`: an order drop before it.
fn drag_hung_before(cx: &mut VisualTestContext, host: &str, id: &str, onto: &str) {
    let from = cx
        .debug_bounds(guide(host, id))
        .expect("the dragged row is drawn");
    let to = cx
        .debug_bounds(guide(host, onto))
        .expect("the target row is drawn");
    let start = point(from.origin.x + px(60.0), from.center().y);
    let end = point(to.origin.x + px(60.0), to.origin.y + px(1.0));
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(
        start + point(px(8.0), px(0.0)),
        MouseButton::Left,
        Modifiers::none(),
    );
    frame(cx);
    cx.simulate_mouse_move(end, MouseButton::Left, Modifiers::none());
    frame(cx);
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::none());
    frame(cx);
}

fn memberships(ws: &Workspace, book: &str) -> Value {
    ws.observe(&format!("book:{book}")).unwrap().value["memberships"].clone()
}

/// In the left tree a hung row has its dotted guide and comes after what
/// lives under its host: a living child's own hung rows are drawn above the
/// host's.
#[gpui::test]
fn hung_rows_in_the_left_tree_draw_their_guide_after_what_lives_there(cx: &mut TestAppContext) {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let category = of_template(&snapshot, "tpl-category");
    let chapters: Vec<String> = snapshot
        .v3()
        .unwrap()
        .entries
        .iter()
        .filter(|entry| entry.template.as_deref() == Some("tpl-chapter"))
        .take(2)
        .map(|entry| entry.id.clone())
        .collect();
    // A living child that takes entries from elsewhere, with one hung on it.
    let child = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":category,"template":"tpl-category","title":"Synthetic sub"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &ws,
        "membership.add",
        json!({"book":book,"host":child,"member":chapters[0]}),
    );
    call(
        &ws,
        "membership.add",
        json!({"book":book,"host":category,"member":chapters[1]}),
    );
    let (_view, list, cx) = tree(cx, &ws, &book, &category);
    let rows = list.read_with(cx, |l, _| l.rows.clone());
    let living_here: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| matches!(row, Row::Entry { depth: 0, .. }))
        .map(|(i, _)| i)
        .collect();
    let hung_here = rows
        .iter()
        .position(|row| matches!(row, Row::Member { host, .. } if *host == category))
        .expect("the host's hung row is listed");
    assert!(
        living_here.len() >= 2,
        "the category's own entries: {rows:?}"
    );
    assert!(
        living_here.iter().all(|i| *i < hung_here),
        "what lives here first, then what is hung here: {rows:?}"
    );
    wait_for(cx, "the guides are drawn", |cx| {
        cx.debug_bounds(guide(&category, &chapters[1])).is_some()
            && cx.debug_bounds(guide(&child, &chapters[0])).is_some()
    });
    let below_child = cx.debug_bounds(guide(&child, &chapters[0])).unwrap();
    let below_host = cx.debug_bounds(guide(&category, &chapters[1])).unwrap();
    assert!(
        below_child.origin.y < below_host.origin.y,
        "the living child's subtree is drawn before the host's hung rows"
    );
    assert!(
        below_host.size.height > px(4.0),
        "a dotted guide down the row"
    );
    // Living rows have no guide.
    for row in rows.iter() {
        if let Row::Entry { id, .. } = row {
            assert!(
                cx.debug_bounds(guide(&category, id)).is_none(),
                "{id} lives here"
            );
        }
    }
}

/// Item 4 of the T9 review: while the list is sorted by something other
/// than the manual order and the host is in no view, a hung row takes no
/// order drop, exactly like the rows living there; in the manual order the
/// same drag reorders.
#[gpui::test]
fn a_hung_row_takes_no_order_drop_under_another_sort(cx: &mut TestAppContext) {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let category = of_template(&snapshot, "tpl-category");
    assert!(!snapshot.v3().unwrap().is_lane(&category));
    let chapters: Vec<String> = snapshot
        .v3()
        .unwrap()
        .entries
        .iter()
        .filter(|entry| entry.template.as_deref() == Some("tpl-chapter"))
        .take(2)
        .map(|entry| entry.id.clone())
        .collect();
    for chapter in &chapters {
        call(
            &ws,
            "membership.add",
            json!({"book":book,"host":category,"member":chapter}),
        );
    }
    let (_view, list, cx) = tree(cx, &ws, &book, &category);
    let hung = |list: &Entity<LevelDisplay>, cx: &mut VisualTestContext| -> Vec<String> {
        list.read_with(cx, |l, _| {
            l.rows
                .iter()
                .filter_map(|row| match row {
                    Row::Member { id, host, .. } if *host == category => Some(id.clone()),
                    _ => None,
                })
                .collect()
        })
    };
    list.update(cx, |l, cx| l.set_sort(SortOrder::Name, cx));
    frame(cx);
    assert!(!list.read_with(cx, |l, _| l.hung_can_reorder(&category)));
    let shown = hung(&list, cx);
    let before = memberships(&ws, &book);
    let journal = ws.journal(None, 10_000).unwrap().len();
    wait_for(cx, "the hung rows are drawn", |cx| {
        shown
            .iter()
            .all(|id| cx.debug_bounds(guide(&category, id)).is_some())
    });
    drag_hung_before(cx, &category, &shown[1], &shown[0]);
    for _ in 0..10 {
        frame(cx);
    }
    assert_eq!(memberships(&ws, &book), before, "no order nobody sees");
    assert_eq!(
        ws.journal(None, 10_000).unwrap().len(),
        journal,
        "no undo step"
    );

    // The same drag in the manual order reorders.
    list.update(cx, |l, cx| l.set_sort(SortOrder::Manual, cx));
    frame(cx);
    assert!(list.read_with(cx, |l, _| l.hung_can_reorder(&category)));
    let shown = hung(&list, cx);
    wait_for(cx, "the hung rows are drawn", |cx| {
        shown
            .iter()
            .all(|id| cx.debug_bounds(guide(&category, id)).is_some())
    });
    drag_hung_before(cx, &category, &shown[1], &shown[0]);
    wait_for(cx, "the order is written", |_| {
        ws.journal(None, 10_000).unwrap().len() == journal + 1
    });
    let order: Vec<String> = Book::load(&ws, &book).unwrap().v3().unwrap().levels[&category]
        .members
        .iter()
        .filter(|id| shown.contains(id))
        .cloned()
        .collect();
    assert_eq!(order, vec![shown[1].clone(), shown[0].clone()]);
}

/// Item 5 of the T9 review: the same book snapshot handed over again (the
/// left column does on every frame) neither sorts the list again nor reads
/// the update times; a new snapshot does both once.
#[gpui::test]
fn a_list_given_the_same_book_again_does_no_work(cx: &mut TestAppContext) {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let category = of_template(&snapshot, "tpl-category");
    let (view, list, cx) = tree(cx, &ws, &book, &category);
    list.update(cx, |l, cx| l.set_sort(SortOrder::Updated, cx));
    frame(cx);
    let done = list.read_with(cx, |l, _| l.work_done());
    let same = list.read_with(cx, |l, _| l.host.page.book.clone());
    for _ in 0..5 {
        list.update(cx, |l, cx| l.refresh(same.clone(), cx));
        view.update(cx, |_, cx| cx.notify());
        frame(cx);
    }
    assert_eq!(list.read_with(cx, |l, _| l.work_done()), done);
    let next = Rc::new(Book::load(&ws, &book).unwrap());
    list.update(cx, |l, cx| l.refresh(next, cx));
    assert_eq!(
        list.read_with(cx, |l, _| l.work_done()),
        (done.0 + 1, done.1 + 1)
    );
}
