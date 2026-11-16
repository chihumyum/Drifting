//! T1 (`kernel-v5.md` §16 「挂名」「条目页」): what a drop onto an entry
//! does follows its two switches, and an entry page lists an entry that
//! both lives under it and is attached to it once.
use std::collections::BTreeSet;

use dr_shell::{
    book::Book,
    pages::PageViewHost,
    v3::{DisplaySurface, LevelHost, ROOT_LEVEL},
};
use dr_view_elements::{
    data::v3::{
        Drop, DropSlot, drop_attaches, prepare_resolved_drop, resolve_drop_with, resolve_hung_drop,
    },
    panel::v3::{Display, LevelDisplay, Row, rows},
};
use dr_workspace::{Actor, Workspace};
use gpui::WeakEntity;
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
    // while keeping residence unchanged, and refuses `manuscript` (non-accepting)
    // and its own residence parent.
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
    assert_eq!(
        resolve_hung_drop(&snapshot, &chapter, &storyline, &manuscript),
        None
    );
    if let Some(parent) = chapter_parent.as_deref() {
        assert_eq!(
            resolve_hung_drop(&snapshot, &chapter, &storyline, parent),
            None
        );
    }
    let moved_hang = resolve_hung_drop(&snapshot, &chapter, &storyline, &other_line);
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
