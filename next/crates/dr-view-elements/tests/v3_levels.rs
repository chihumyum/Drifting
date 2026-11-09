//! G2 contracts use the shared v3 seed, never a second manuscript corpus.
use std::collections::BTreeSet;

use dr_shell::book::Book;
use dr_view_elements::panel::v3::{Display, Row, Section, rows};
use dr_workspace::{Actor, Workspace};
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
    (
        dir,
        Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap(),
        id,
    )
}
fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn ids(rows: &[Row]) -> Vec<&str> {
    rows.iter()
        .flat_map(|r| match r {
            Row::Entry { id, .. } => vec![id.as_str()],
            Row::Tiles { ids, .. } => ids.iter().map(String::as_str).collect(),
            Row::Island { id, members } => std::iter::once(id.as_str())
                .chain(members.iter().map(String::as_str))
                .collect(),
            Row::Section(_) => Vec::new(),
        })
        .collect()
}

#[test]
fn residence_tree_is_ordered_foldable_and_separate_from_membership() {
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let v = initial.v3().unwrap();
    let manuscript = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-manuscript"))
        .unwrap()
        .id
        .clone();
    let group = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":manuscript,"template":"tpl-group","title":"Synthetic level"}),
    );
    let group = group["id"].as_str().unwrap();
    let child = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":group,"template":"tpl-chapter","title":"Synthetic leaf"}),
    );
    let child = child["id"].as_str().unwrap();
    let foreign = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-chapter"))
        .unwrap()
        .id
        .clone();
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":group,"overrides":{"accept":true}}),
    );
    call(
        &ws,
        "membership.add",
        json!({"book":book,"host":group,"member":foreign}),
    );
    let snapshot = Book::load(&ws, &book).unwrap();
    let shown = rows(&snapshot, group, Display::List, false, &BTreeSet::new(), 2);
    assert_eq!(
        shown,
        vec![
            Row::Section(Section::Residents),
            Row::Entry {
                id: child.into(),
                depth: 0
            },
            Row::Section(Section::Members),
            Row::Entry {
                id: foreign.clone(),
                depth: 0
            }
        ]
    );
    assert_eq!(
        snapshot.v3().unwrap().entry(&foreign).unwrap().parent,
        Some(manuscript.clone())
    );
    let open = rows(
        &snapshot,
        &manuscript,
        Display::List,
        false,
        &BTreeSet::new(),
        2,
    );
    let closed = rows(
        &snapshot,
        &manuscript,
        Display::List,
        false,
        &BTreeSet::from([group.into()]),
        2,
    );
    assert!(ids(&open).contains(&child));
    assert!(!ids(&closed).contains(&child));
    assert_eq!(ids(&open).last().copied(), Some(child));
    ws.shutdown().unwrap();
}

#[test]
fn grouped_list_uses_primary_lane_once_and_keeps_unassigned_leaves() {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    let manuscript = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-manuscript"))
        .unwrap();
    let loose = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":manuscript.id,"title":"Synthetic unassigned"}),
    );
    let snapshot = Book::load(&ws, &book).unwrap();
    let shown = rows(
        &snapshot,
        &manuscript.id,
        Display::List,
        true,
        &BTreeSet::new(),
        2,
    );
    let all = ids(&shown);
    assert_eq!(all.iter().collect::<BTreeSet<_>>().len(), all.len());
    for child in &v.levels[&manuscript.id].children {
        assert!(all.contains(&child.as_str()));
    }
    assert!(shown.contains(&Row::Section(Section::Unassigned)));
    assert_eq!(all.last().copied(), loose["id"].as_str());
    ws.shutdown().unwrap();
}

#[test]
fn grid_and_islands_share_entry_targets_and_preserve_canvas_layout() {
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let v = initial.v3().unwrap();
    let elements = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-elements"))
        .unwrap();
    let grid = rows(
        &initial,
        &elements.id,
        Display::Grid,
        false,
        &BTreeSet::new(),
        2,
    );
    let islands = rows(
        &initial,
        &elements.id,
        Display::Islands,
        false,
        &BTreeSet::new(),
        2,
    );
    assert_eq!(ids(&grid), ids(&islands));
    assert!(islands.iter().any(|r| matches!(r, Row::Island { .. })));
    let idea = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-idea"))
        .unwrap();
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":idea.id,"layout":{"board":[123.0,456.0],"grid":[2,3]}}),
    );
    let again = Book::load(&ws, &book).unwrap();
    let layout = again.v3().unwrap().entry(&idea.id).unwrap().layout;
    assert_eq!(layout.board, Some((123.0, 456.0)));
    assert_eq!(layout.grid, Some((2, 3)));
    let legacy = call(&ws, "book.create", json!({"name":"Synthetic legacy"}));
    let legacy = Book::load(&ws, legacy["id"].as_str().unwrap()).unwrap();
    assert!(
        rows(
            &legacy,
            &elements.id,
            Display::List,
            false,
            &BTreeSet::new(),
            2
        )
        .is_empty()
    );
    ws.shutdown().unwrap();
}
