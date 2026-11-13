//! Whether an entry is a card or a group on the element islands follows its
//! template (`linkable`, `kernel-v4.md` §2), never its switch.
use std::collections::BTreeSet;

use dr_shell::book::Book;
use dr_view_element_overview::{ExtractedIslands, extract_v3_islands};
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
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, id)
}

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn islands(ws: &Workspace, book: &str) -> ExtractedIslands {
    let b = Book::load(ws, book).unwrap();
    extract_v3_islands(b.v3().unwrap(), "Residents", "Members", "Uncategorized")
}

fn element_ids(x: &ExtractedIslands) -> BTreeSet<String> {
    x.elements.iter().map(|e| e.id.clone()).collect()
}

#[test]
fn a_content_entry_with_its_switch_on_stays_a_card_and_organising_entries_stay_groups() {
    let (_dir, ws, book) = seed();
    let loaded = Book::load(&ws, &book).unwrap();
    let v = loaded.v3().unwrap();
    let template = |id: &str| v.entry(id).and_then(|e| e.template.clone());
    let category = v
        .entries
        .iter()
        .find(|e| {
            e.template.as_deref() == Some("tpl-category")
                && v.levels[&e.id]
                    .children
                    .iter()
                    .any(|c| template(c).as_deref() == Some("tpl-character"))
        })
        .expect("a category holding characters")
        .id
        .clone();
    let character = v.levels[&category]
        .children
        .iter()
        .find(|c| template(c).as_deref() == Some("tpl-character"))
        .unwrap()
        .clone();
    let character_title = v.entry(&character).unwrap().title.clone();
    let categories: Vec<String> = v
        .entries
        .iter()
        .filter(|e| e.template.as_deref() == Some("tpl-category"))
        .map(|e| e.id.clone())
        .collect();
    drop(loaded);

    let before = islands(&ws, &book);
    assert!(element_ids(&before).contains(&character));

    // An organising group under the category, with a character in it.
    let group = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":category,"template":"tpl-group","title":"Synthetic group"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let grouped = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":group,"template":"tpl-character","title":"Synthetic grouped"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // The character's switch goes on, first with nothing under it.
    call(
        &ws,
        "entry.set_level",
        json!({"book":book,"id":character,"level":true}),
    );
    let switched = islands(&ws, &book);
    assert!(
        element_ids(&switched).contains(&character),
        "a character whose switch is on is still a card"
    );
    // Then an entry (of the template the level resolves for new entries)
    // lives under it.
    let past = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":character,"title":"Synthetic past"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let after = islands(&ws, &book);
    let mut expected = element_ids(&before);
    expected.extend([grouped.clone(), past.clone()]);
    assert_eq!(element_ids(&after), expected);
    assert!(!element_ids(&after).contains(&group));
    assert!(!element_ids(&after).iter().any(|id| categories.contains(id)));

    // Every category is still an island; the character stays on its own.
    for c in &categories {
        assert!(
            after.islands.iter().any(|i| &i.island_id == c),
            "category {c} is an island"
        );
    }
    let island = after
        .islands
        .iter()
        .find(|i| i.island_id == category)
        .unwrap();
    let group_of = |id: &str| {
        island
            .groups
            .iter()
            .find(|g| g.items.iter().any(|it| it.id == id))
            .map(|g| g.group_name.clone())
    };
    assert_eq!(group_of(&character), Some(None));
    assert_eq!(group_of(&grouped), Some(Some("Synthetic group".to_owned())));
    // What lives under the character hangs under its name, in its island.
    assert_eq!(group_of(&past), Some(Some(character_title)));
    let item = after.elements.iter().find(|e| e.id == past).unwrap();
    assert_eq!(item.home_island_id, category);
    ws.shutdown().unwrap();
}
