//! G2 contracts use the shared v3 seed, never a second manuscript corpus.
use std::collections::BTreeSet;

use dr_shell::book::Book;
use dr_shell::v3::DisplaySurface;
use dr_view_elements::panel::v3::{Display, Row, rows};
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
            Row::Entry { id, .. } | Row::Member { id, .. } => vec![id.as_str()],
            Row::Tiles { ids, .. } => ids.iter().map(String::as_str).collect(),
            Row::Island { id, members } => std::iter::once(id.as_str())
                .chain(members.iter().map(String::as_str))
                .collect(),
        })
        .collect()
}
fn of_template(v: &dr_shell::book::v3::BookV3, template: &str) -> String {
    v.entries
        .iter()
        .find(|e| e.template.as_deref() == Some(template))
        .unwrap()
        .id
        .clone()
}

/// `kernel-v5.md` §16 「层级的列表」: a level's list is its tree. What
/// lives under it, in its order; an entry that holds entries opens to what
/// lives under it, then what is attached to it. A Tab lists what is
/// attached to the level itself after what lives under it; the entry page
/// lists the two in its two blocks. Attaching moves nothing.
#[test]
fn a_level_lists_its_tree_and_what_is_attached_after_what_lives_under_it() {
    let (_dir, ws, book) = seed();
    let initial = Book::load(&ws, &book).unwrap();
    let v = initial.v3().unwrap();
    let manuscript = of_template(v, "tpl-manuscript");
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
    let foreign = of_template(v, "tpl-chapter");
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
    let list = |surface| {
        rows(
            &snapshot,
            group,
            Display::List,
            surface,
            &BTreeSet::new(),
            2,
        )
    };
    let entry = |id: &str, depth| Row::Entry {
        id: id.into(),
        depth,
    };
    let member = |id: &str, depth| Row::Member {
        id: id.into(),
        depth,
        host: group.into(),
    };
    // The entry page's two blocks.
    assert_eq!(list(DisplaySurface::Page), vec![entry(child, 0)]);
    assert_eq!(list(DisplaySurface::Members), vec![member(&foreign, 0)]);
    // A Tab: what lives here, then what is attached here.
    assert_eq!(
        list(DisplaySurface::Sidebar),
        vec![entry(child, 0), member(&foreign, 0)]
    );
    assert_eq!(
        snapshot.v3().unwrap().entry(&foreign).unwrap().parent,
        v.entry(&foreign).unwrap().parent
    );
    // In the manuscript's tree the group opens to its child, then to the
    // chapter attached to it, which also shows where it lives.
    let open = rows(
        &snapshot,
        &manuscript,
        Display::List,
        DisplaySurface::Page,
        &BTreeSet::new(),
        2,
    );
    let at = open.iter().position(|r| *r == entry(group, 0)).unwrap();
    assert_eq!(open[at + 1..at + 3], [entry(child, 1), member(&foreign, 1)]);
    assert!(
        open.iter()
            .any(|r| matches!(r, Row::Entry { id, .. } if *id == foreign)),
        "it also shows where it lives"
    );
    let closed = rows(
        &snapshot,
        &manuscript,
        Display::List,
        DisplaySurface::Page,
        &BTreeSet::from([group.into()]),
        2,
    );
    assert!(!ids(&closed).contains(&child));
    assert!(!closed.contains(&member(&foreign, 1)));
    ws.shutdown().unwrap();
}

/// 「放章的列表里只有树」 (作者 2026-11-15): no 「全书顺序 / 按故事线」,
/// no 「未归属」, nothing after the tree. Its rows at the top are what
/// lives in the manuscript, in its order; no storyline is listed in it.
#[test]
fn the_manuscript_list_is_only_its_tree() {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    let manuscript = of_template(v, "tpl-manuscript");
    assert!(
        v.memberships.iter().any(|m| v.is_lane(&m.host)),
        "the seed has chapters on storylines"
    );
    for surface in [DisplaySurface::Page, DisplaySurface::Sidebar] {
        let shown = rows(
            &snapshot,
            &manuscript,
            Display::List,
            surface,
            &BTreeSet::new(),
            2,
        );
        let top: Vec<&str> = shown
            .iter()
            .filter_map(|r| match r {
                Row::Entry { id, depth: 0 } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        let children: Vec<&str> = v.levels[&manuscript]
            .children
            .iter()
            .map(String::as_str)
            .collect();
        assert_eq!(top, children);
        let lanes: Vec<&str> = ids(&shown).into_iter().filter(|id| v.is_lane(id)).collect();
        assert!(
            lanes.is_empty(),
            "no storyline in the manuscript's list: {lanes:?}"
        );
        // Nothing is attached to the manuscript: nothing follows its tree.
        assert!(shown.iter().all(|r| matches!(r, Row::Entry { .. })));
    }
    ws.shutdown().unwrap();
}

/// The storylines' Tab (`kernel-v5.md` §16): each storyline opens to the
/// chapters attached to it; a chapter on two storylines shows under both.
#[test]
fn a_storyline_opens_to_its_chapters_and_a_chapter_on_two_shows_under_both() {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    let list = of_template(v, "tpl-storylines");
    let lines: Vec<String> = v.levels[&list].children.clone();
    assert!(lines.len() >= 2, "the seed has two storylines");
    let chapter = of_template(v, "tpl-chapter");
    for line in &lines[..2] {
        if !v.levels[line].members.contains(&chapter) {
            call(
                &ws,
                "membership.add",
                json!({"book":book,"host":line,"member":chapter}),
            );
        }
    }
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    let shown = rows(
        &snapshot,
        &list,
        Display::List,
        DisplaySurface::Sidebar,
        &BTreeSet::new(),
        2,
    );
    for line in &lines {
        let at = shown
            .iter()
            .position(|r| matches!(r, Row::Entry { id, depth: 0 } if id == line))
            .unwrap();
        let under: Vec<&str> = shown[at + 1..]
            .iter()
            .take_while(|r| !matches!(r, Row::Entry { depth: 0, .. }))
            .filter_map(|r| match r {
                Row::Member { id, depth: 1, host } if host == line => Some(id.as_str()),
                _ => None,
            })
            .collect();
        let members: Vec<&str> = v.levels[line].members.iter().map(String::as_str).collect();
        assert_eq!(under, members, "{line} opens to what is attached to it");
    }
    let times = shown
        .iter()
        .filter(|r| matches!(r, Row::Member { id, .. } if *id == chapter))
        .count();
    assert_eq!(times, 2, "a chapter on two storylines shows under both");
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
        DisplaySurface::Page,
        &BTreeSet::new(),
        2,
    );
    let islands = rows(
        &initial,
        &elements.id,
        Display::Islands,
        DisplaySurface::Page,
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
    let idea_scope = idea.parent.as_deref().unwrap_or("root").to_owned();
    call(
        &ws,
        "layout.put",
        json!({"book":book,"scope":idea_scope,"mode":"board","positions":{&idea.id:[123.0,456.0]}}),
    );
    call(
        &ws,
        "layout.put",
        json!({"book":book,"scope":idea_scope,"mode":"grid","positions":{&idea.id:[2.0,3.0]}}),
    );
    let again = Book::load(&ws, &book).unwrap();
    let again_v3 = again.v3().unwrap();
    assert_eq!(
        again_v3.layout_position(&idea_scope, "board", &idea.id),
        Some((123.0, 456.0))
    );
    assert_eq!(
        again_v3.layout_position(&idea_scope, "grid", &idea.id),
        Some((2.0, 3.0))
    );
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
            DisplaySurface::Page,
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
        "layout.put",
        json!({"book":book,"scope":parent,"mode":"board","positions":{id:[-12.0,34.0]}}),
    );
    call(
        &ws,
        "layout.put",
        json!({"book":book,"scope":parent,"mode":"grid","positions":{id:[2.0,3.0]}}),
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
    assert_eq!(v.layout_position(&parent, "board", id), Some((-12.0, 34.0)));
    assert_eq!(v.layout_position(&parent, "grid", id), Some((2.0, 3.0)));
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
fn board_blocks_list_residents_and_attached_apart_and_a_tab_shows_both() {
    use dr_view_elements::panel::v3::board_ids;
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
    // The entry page's two blocks: what lives here, what is attached here.
    assert_eq!(
        board_ids(&snapshot, &root, DisplaySurface::Page),
        v.levels[&root].children
    );
    assert_eq!(
        board_ids(&snapshot, &root, DisplaySurface::Members),
        vec![member.clone()]
    );
    // A Tab's one canvas: both.
    let navigation = board_ids(&snapshot, &root, DisplaySurface::Sidebar);
    assert!(navigation.contains(&member));
    assert!(
        v.levels[&root]
            .children
            .iter()
            .all(|c| navigation.contains(c))
    );
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
    assert!(
        prepare_override(&snap, &group, "lane", Some(json!(true))).is_err(),
        "retired lane setting must be rejected by prepare_override"
    );
    assert!(!snap.v3().unwrap().is_lane(&group));

    // 分组 takes no entries from elsewhere by default (kernel-v5 §16); the
    // group's own override turns it on, and clearing it goes back to that.
    assert!(!snap.v3().unwrap().levels[&group].settings.accept);
    prepare_override(&snap, &group, "accept", Some(json!(true)))
        .unwrap()
        .commit(&ws)
        .unwrap();
    let enabled = Book::load(&ws, &book).unwrap();
    let v = enabled.v3().unwrap();
    assert!(v.levels[&group].settings.accept);
    assert_eq!(
        v.levels[&group].sources["accept"],
        SettingSource::Override {
            entry: group.clone()
        }
    );

    prepare_override(&enabled, &group, "accept", None)
        .unwrap()
        .commit(&ws)
        .unwrap();
    let restored = Book::load(&ws, &book).unwrap();
    let v = restored.v3().unwrap();
    assert!(!v.levels[&group].settings.accept);
    assert_eq!(v.levels[&group].sources["accept"], SettingSource::Default);
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
