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
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, id)
}
fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn ids(rows: &[Row]) -> Vec<&str> {
    rows.iter()
        .flat_map(|r| match r {
            Row::Entry { id, .. } | Row::Member { id } => vec![id.as_str()],
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
            Row::Member {
                id: foreign.clone()
            }
        ]
    );
    assert_eq!(
        snapshot.v3().unwrap().entry(&foreign).unwrap().parent,
        v.entry(&foreign).unwrap().parent
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
    let host = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":manuscript.id,"template":"tpl-group","title":"Synthetic non-lane membership"}),
    );
    let member = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-chapter"))
        .unwrap();
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":host["id"],"overrides":{"accept":true}}),
    );
    call(
        &ws,
        "membership.add",
        json!({"book":book,"host":host["id"],"member":member.id}),
    );
    call(
        &ws,
        "membership.primary",
        json!({"book":book,"host":host["id"],"member":member.id}),
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
    for child in v
        .entries
        .iter()
        .filter(|e| e.template.as_deref() == Some("tpl-chapter"))
    {
        assert!(all.contains(&child.id.as_str()));
    }
    let unassigned = shown
        .iter()
        .position(|row| *row == Row::Section(Section::Unassigned))
        .unwrap();
    assert!(
        shown
            .iter()
            .position(|row| matches!(row,Row::Entry{id,..} if *id==member.id))
            .unwrap()
            > unassigned
    );
    assert_eq!(all.last().copied(), loose["id"].as_str());
    ws.shutdown().unwrap();
}

#[test]
fn grouped_list_keeps_numbered_entries_whose_switch_is_on_under_their_lane() {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    let manuscript = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-manuscript"))
        .unwrap()
        .id
        .clone();
    let (lane, chapter) = v
        .memberships
        .iter()
        .find(|m| {
            v.is_lane(&m.host)
                && v.entry(&m.member)
                    .is_some_and(|e| e.template.as_deref() == Some("tpl-chapter"))
        })
        .map(|m| (m.host.clone(), m.member.clone()))
        .expect("a chapter on a storyline");
    call(
        &ws,
        "membership.primary",
        json!({"book":book,"host":lane,"member":chapter}),
    );
    call(
        &ws,
        "entry.set_level",
        json!({"book":book,"id":chapter,"level":true}),
    );
    let below = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":chapter,"template":"tpl-chapter","title":"Synthetic below"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // An organising level in the manuscript carries no book prose: it is
    // not numbered, so it is not listed.
    let group = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":manuscript,"template":"tpl-group","title":"Synthetic volume"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    assert!(v.levels.contains_key(&chapter));
    let shown = rows(
        &snapshot,
        &manuscript,
        Display::List,
        true,
        &BTreeSet::new(),
        2,
    );
    let all = ids(&shown);
    let at = |id: &str| all.iter().position(|x| *x == id);
    assert!(at(&lane).unwrap() < at(&chapter).unwrap());
    let unassigned = shown
        .iter()
        .position(|row| *row == Row::Section(Section::Unassigned))
        .unwrap();
    assert!(
        shown
            .iter()
            .position(|row| matches!(row, Row::Entry { id, depth: 1 } if *id == chapter))
            .unwrap()
            < unassigned
    );
    assert!(at(&below).is_some());
    assert!(at(&group).is_none());
    // Every numbered entry is listed once.
    let numbered: BTreeSet<&str> = v
        .entries
        .iter()
        .filter(|e| v.manuscript_number(&e.id).is_some())
        .map(|e| e.id.as_str())
        .collect();
    let listed: BTreeSet<&str> = all.iter().copied().filter(|id| !v.is_lane(id)).collect();
    assert_eq!(listed, numbered);
    assert_eq!(all.iter().collect::<BTreeSet<_>>().len(), all.len());
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
    let other = call(
        &ws,
        "project.create",
        json!({"name":"Synthetic other book"}),
    );
    let other = Book::load(&ws, other["id"].as_str().unwrap()).unwrap();
    assert!(
        rows(
            &other,
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

#[gpui::test]
fn refresh_keeps_the_visible_entry_when_rows_are_inserted_above_it(cx: &mut gpui::TestAppContext) {
    cx.executor().allow_parking();
    use dr_shell::{
        pages::PageViewHost,
        v3::{DisplaySurface, LevelHost},
    };
    use dr_view_elements::panel::v3::LevelDisplay;
    use gpui::{AppContext as _, ListOffset, WeakEntity, px};
    use std::rc::Rc;
    let (_dir, ws, book) = seed();
    let initial = Rc::new(Book::load(&ws, &book).unwrap());
    let root = initial.v3().unwrap().roots[0].clone();
    let view = cx.update(|cx| {
        cx.new(|_| {
            LevelDisplay::new(
                LevelHost {
                    page: PageViewHost {
                        workspace: WeakEntity::new_invalid(),
                        library: ws.clone(),
                        book_id: book.clone(),
                        book: initial.clone(),
                    },
                    level: root.clone(),
                    surface: DisplaySurface::Sidebar,
                },
                Display::List,
            )
        })
    });
    let anchor = cx.update(|cx| {
        let view = view.read(cx);
        view.scroll_state().scroll_to(ListOffset {
            item_ix: 2,
            offset_in_item: px(0.0),
        });
        view.rows[2].clone()
    });
    let group = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":root,"template":"tpl-group","title":"Synthetic inserted level"}),
    );
    call(
        &ws,
        "entry.move",
        json!({"book":book,"id":group["id"],"parent":root,"index":0}),
    );
    let again = Rc::new(Book::load(&ws, &book).unwrap());
    cx.update(|cx| {
        view.update(cx, |view, cx| {
            view.refresh(again, cx);
            let at = view.scroll_state().logical_scroll_top().item_ix;
            assert_eq!(view.rows[at], anchor);
            assert_eq!(at, 3);
        })
    });
    drop(view);
    cx.run_until_parked();
    // The test App retains released entities until teardown, including the
    // display host's workspace lease, as in the other panel GPUI tests.
    drop(ws);
}

#[test]
fn setting_override_clear_restore_and_provenance_preserve_other_data() {
    use dr_shell::book::v3::SettingSource;
    use dr_view_elements::data::v3::prepare_override;
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let v = initial.v3().unwrap();
    let parent = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-manuscript"))
        .unwrap()
        .id
        .clone();
    let group = call(
        &ws,
        "entry.create",
        json!({"book":book,"parent":parent,"template":"tpl-group","title":"Synthetic inherited settings"}),
    );
    let id = group["id"].as_str().unwrap();
    let before = Book::load(&ws, &book).unwrap();
    assert_eq!(
        before.v3().unwrap().levels[id]
            .settings
            .default_template
            .as_deref(),
        Some("tpl-chapter")
    );
    assert!(
        matches!(&before.v3().unwrap().levels[id].sources["default_template"],SettingSource::Template{entry,..} if entry==&parent)
    );
    prepare_override(&before, id, "default_template", Some(Value::Null))
        .unwrap()
        .commit(&ws)
        .unwrap();
    let cleared = Book::load(&ws, &book).unwrap();
    let level = &cleared.v3().unwrap().levels[id];
    assert_eq!(level.settings.default_template, None);
    assert!(
        matches!(&level.sources["default_template"],SettingSource::Override{entry} if entry==id)
    );
    // Another setting and unrelated layout must survive restoration.
    prepare_override(&cleared, id, "display", Some(json!("grid")))
        .unwrap()
        .commit(&ws)
        .unwrap();
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":id,"layout":{"board":[-12.0,34.0],"grid":[2,3]}}),
    );
    let overridden = Book::load(&ws, &book).unwrap();
    prepare_override(&overridden, id, "default_template", None)
        .unwrap()
        .commit(&ws)
        .unwrap();
    let restored = Book::load(&ws, &book).unwrap();
    let v = restored.v3().unwrap();
    assert_eq!(
        v.levels[id].settings.default_template.as_deref(),
        Some("tpl-chapter")
    );
    assert_eq!(v.levels[id].settings.display, "grid");
    assert!(
        matches!(&v.levels[id].sources["default_template"],SettingSource::Template{entry,..} if entry==&parent)
    );
    assert_eq!(v.entry(id).unwrap().layout.board, Some((-12.0, 34.0)));
    assert_eq!(v.entry(id).unwrap().layout.grid, Some((2, 3)));
    assert_eq!(v.entry(id).unwrap().title, "Synthetic inherited settings");
    ws.shutdown().unwrap();
}

#[test]
fn stale_or_invalid_setting_edits_do_not_replace_newer_settings() {
    use dr_view_elements::data::v3::prepare_override;
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let id = initial.v3().unwrap().roots[0].clone();
    let stale = prepare_override(&initial, &id, "auto_link", Some(json!(true))).unwrap();
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":id,"overrides":{"display":"grid","accept":true}}),
    );
    assert!(stale.commit(&ws).is_err());
    let again = Book::load(&ws, &book).unwrap();
    assert_eq!(again.v3().unwrap().levels[&id].settings.display, "grid");
    assert!(again.v3().unwrap().levels[&id].settings.accept);
    let revision = again.v3().unwrap().revision.clone();
    assert!(
        prepare_override(&again, &id, "display", Some(json!("future-display")))
            .unwrap()
            .commit(&ws)
            .is_err()
    );
    assert!(prepare_override(&again, &id, "not-a-setting", None).is_err());
    let leaf = again
        .v3()
        .unwrap()
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-chapter"))
        .unwrap();
    assert!(prepare_override(&again, &leaf.id, "display", None).is_err());
    assert_eq!(
        Book::load(&ws, &book).unwrap().v3().unwrap().revision,
        revision
    );
    ws.shutdown().unwrap();
}

#[test]
fn board_page_separates_members_without_changing_the_navigation_canvas() {
    use dr_shell::v3::DisplaySurface;
    use dr_view_elements::panel::v3::board_sections;
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let v = initial.v3().unwrap();
    let root = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-ideas"))
        .unwrap()
        .id
        .clone();
    let member = v
        .entries
        .iter()
        .find(|e| e.template.as_deref() == Some("tpl-chapter"))
        .unwrap()
        .id
        .clone();
    let old_parent = v.entry(&member).unwrap().parent.clone();
    call(
        &ws,
        "entry.update",
        json!({"book":book,"id":root,"overrides":{"accept":true,"display":"board"}}),
    );
    call(
        &ws,
        "membership.add",
        json!({"book":book,"host":root,"member":member}),
    );
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    assert_eq!(
        board_sections(&snapshot, &root, DisplaySurface::Page),
        vec![
            (Some(Section::Residents), v.levels[&root].children.clone()),
            (Some(Section::Members), vec![member.clone()])
        ]
    );
    let navigation = board_sections(&snapshot, &root, DisplaySurface::Sidebar);
    assert_eq!(navigation.len(), 1);
    assert!(navigation[0].0.is_none());
    assert!(navigation[0].1.contains(&member));
    assert_eq!(v.entry(&member).unwrap().parent, old_parent);
    ws.shutdown().unwrap();
}

#[gpui::test]
fn picker_host_rejects_book_or_library_replacement(cx: &mut gpui::TestAppContext) {
    use dr_shell::{
        Services, ShellInfo, Workspace as ShellWorkspace, pages::PageViewHost,
        settings::SettingsFile,
    };
    use dr_view_elements::data::v3::fresh;
    use std::rc::Rc;
    let (_dir, lib, book) = seed();
    let other_dir = tempfile::tempdir().unwrap();
    let other = Workspace::open_dir(other_dir.path(), "0.2.0-dev").unwrap();
    let snapshot = Rc::new(Book::load(&lib, &book).unwrap());
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
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        )
    });
    let (ws, cx) = cx.add_window_view(ShellWorkspace::new);
    cx.update(|_, cx| {
        ws.update(cx, |ws, _| {
            ws.book_id = book.clone();
            ws.book = snapshot.clone();
        })
    });
    let host = PageViewHost {
        workspace: ws.downgrade(),
        library: lib.clone(),
        book_id: book.clone(),
        book: snapshot,
    };
    cx.update(|_, cx| {
        assert!(fresh(&host, cx).is_some());
        ws.update(cx, |ws, _| ws.book_id = "synthetic-transition-book".into());
        let transition = PageViewHost {
            book_id: "synthetic-transition-book".into(),
            ..host.clone()
        };
        assert!(fresh(&transition, cx).is_none());
        ws.update(cx, |ws, _| ws.book_id = "synthetic-other-book".into());
        assert!(fresh(&host, cx).is_none());
        ws.update(cx, |ws, _| {
            ws.book_id = book;
            ws.library = Some(other.clone());
        });
        // Even if the old book snapshot is still on screen during a library
        // replacement, no picker may write through its former library handle.
        assert!(fresh(&host, cx).is_none());
        ws.update(cx, |ws, _| ws.library = None);
        assert!(fresh(&host, cx).is_none());
        ws.update(cx, |ws, _| ws.library = Some(lib.clone()));
        assert!(fresh(&host, cx).is_some());
    });
    drop((host, lib, other));
}

#[test]
fn lane_setting_override_toggles_swimlane_and_allow_is_retired() {
    use dr_shell::book::v3::SettingSource;
    use dr_view_elements::data::v3::prepare_override;

    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let group = call(
        &ws,
        "entry.create",
        json!({"book": book, "parent": initial.v3().unwrap().roots[0], "template": "tpl-group", "title": "分卷", "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let snap = Book::load(&ws, &book).unwrap();
    assert!(
        prepare_override(&snap, &group, "allow", None).is_err(),
        "retired allow setting must be rejected by prepare_override"
    );
    assert!(
        prepare_override(&snap, &group, "allow", Some(json!([]))).is_err(),
        "retired allow setting must be rejected even with an array payload"
    );
    assert!(!snap.v3().unwrap().is_lane(&group));

    prepare_override(&snap, &group, "lane", Some(json!(true)))
        .unwrap()
        .commit(&ws)
        .unwrap();
    let enabled = Book::load(&ws, &book).unwrap();
    let v = enabled.v3().unwrap();
    assert!(v.is_lane(&group));
    assert!(v.levels[&group].settings.lane);
    assert_eq!(
        v.levels[&group].sources["lane"],
        SettingSource::Override {
            entry: group.clone()
        }
    );

    prepare_override(&enabled, &group, "lane", Some(json!(false)))
        .unwrap()
        .commit(&ws)
        .unwrap();
    let disabled = Book::load(&ws, &book).unwrap();
    assert!(!disabled.v3().unwrap().is_lane(&group));
    assert!(!disabled.v3().unwrap().levels[&group].settings.lane);

    prepare_override(&disabled, &group, "lane", None)
        .unwrap()
        .commit(&ws)
        .unwrap();
    let restored = Book::load(&ws, &book).unwrap();
    let v = restored.v3().unwrap();
    assert!(!v.is_lane(&group));
    assert_eq!(v.levels[&group].sources["lane"], SettingSource::Default);
    ws.shutdown().unwrap();
}

#[gpui::test]
fn entry_card_exposes_level_switch_row_for_every_entry(cx: &mut gpui::TestAppContext) {
    use dr_shell::{Services, ShellInfo, nav::Target, pages::PageMenuHost, settings::SettingsFile};
    use gpui::WeakEntity;
    use std::rc::Rc;

    let (_dir, lib, book) = seed();
    let snapshot = Rc::new(Book::load(&lib, &book).unwrap());
    let v = snapshot.v3().unwrap();
    let level_entry = v.roots[0].clone();
    let non_level_entry = v.entries.iter().find(|e| !e.level).unwrap().id.clone();

    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services::default(),
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_elements::init(cx);

        let host = PageMenuHost {
            workspace: WeakEntity::new_invalid(),
            library: Some(lib.clone()),
            book_id: book.clone(),
            book: snapshot.clone(),
        };

        let on_rows = dr_shell::v3::entry_card_rows(
            &Target::from_key(&format!("entry:{level_entry}")).unwrap(),
            &host,
            cx,
        );
        let on_item = on_rows
            .before_danger
            .iter()
            .flat_map(|s| &s.items)
            .find(|i| i.id.as_ref() == "entry-toggle-level")
            .expect("entry-toggle-level row on level entry");
        assert!(on_item.checked);

        let off_rows = dr_shell::v3::entry_card_rows(
            &Target::from_key(&format!("entry:{non_level_entry}")).unwrap(),
            &host,
            cx,
        );
        let off_item = off_rows
            .before_danger
            .iter()
            .flat_map(|s| &s.items)
            .find(|i| i.id.as_ref() == "entry-toggle-level")
            .expect("entry-toggle-level row on non-level entry");
        assert!(!off_item.checked);
    });
    lib.shutdown().unwrap();
}
