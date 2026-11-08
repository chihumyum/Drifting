//! The 构想 panel on GPUI's test platform, over a real library (F3 over
//! dr-store) seeded with dr-testkit's 《阿Q正传》 (three ideas, no groups),
//! with the shell's workspace window for the book snapshot and the panel in
//! a window of its own.
//!
//! - 新构想 makes an idea called 「新构想」 and opens it as a tab of its own;
//!   新建分组 makes 「新分组」, 新建子分组 one under it, and a group two levels
//!   down cannot nest another.
//! - Ideas moved into a group and a sub-group: the tree nests them, the
//!   counts take in the sub-groups, the ideas in no group follow.
//! - A group renamed in place (Enter stores it; an empty name keeps
//!   新分组); moved where its levels fit, and not where they do not;
//!   deleted, its ideas moving up to its parent.
//! - 展开／折叠全部 folds every group and opens them again; the sort by title.
//! - An idea's ⋯ rows: 漂流 ticked, 休息 rests it (and the row stays in the
//!   list), 移动到分组 lists the groups, 删除节点 puts it in the trash.

use std::time::{Duration, Instant};

use dr_shell::nav::Target;
use dr_shell::pages::PageMenuHost;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_ideas::IdeaPanel;
use dr_view_ideas::model::Sort;
use dr_workspace::commands::BookIn;
use dr_workspace::commands::idea::{IdeaGroupList, IdeaList, IdeaListIn};
use dr_workspace::dto::{GroupInfo, IdeaInfo};
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

fn ideas(s: &Setup, trashed: bool) -> Vec<IdeaInfo> {
    s.lib
        .run::<IdeaList>(
            &Actor::User,
            IdeaListIn {
                book: s.book.clone(),
                group: None,
                trashed,
            },
        )
        .unwrap()
        .output
}

fn groups(s: &Setup) -> Vec<GroupInfo> {
    s.lib
        .run::<IdeaGroupList>(
            &Actor::User,
            BookIn {
                book: s.book.clone(),
            },
        )
        .unwrap()
        .output
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    s: &Setup,
) -> (
    Entity<Workspace>,
    Entity<IdeaPanel>,
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
        dr_view_ideas::init(cx);
    });
    let ws_window = cx.add_window(Workspace::new);
    let ws = ws_window.root(cx).unwrap();
    let weak = ws.downgrade();
    let (panel, vcx) = cx.add_window_view(move |_, cx| IdeaPanel::new(weak, cx));
    wait_for(vcx, |cx| ws.read_with(cx, |w, _| !w.book.is_empty()));
    wait_for(vcx, |cx| panel.read_with(cx, |p, _| p.idea_count() == 3));
    (ws, panel, vcx)
}

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

fn settle(panel: &Entity<IdeaPanel>, cx: &mut VisualTestContext) {
    wait_for(cx, |cx| panel.read_with(cx, |p, _| p.is_settled()));
}

fn group_named(s: &Setup, name: &str) -> GroupInfo {
    groups(s)
        .into_iter()
        .find(|g| g.name == name)
        .unwrap_or_else(|| panic!("group {name}"))
}

#[gpui::test]
fn the_head_makes_ideas_and_groups(cx: &mut TestAppContext) {
    let s = seeded();
    let (ws, panel, cx) = open(cx, &s);
    // 新构想: made, opened as a tab of its own.
    panel.update(cx, |p, cx| p.new_idea(None, cx));
    settle(&panel, cx);
    let made = ideas(&s, false)
        .into_iter()
        .find(|i| i.title == "新构想")
        .expect("「新构想」 made");
    assert!(made.group.is_none());
    let target = Target::Idea(made.id.parse().unwrap());
    wait_for(cx, |cx| {
        ws.read_with(cx, |w, _| w.nav.current() == Some(&target))
    });
    wait_for(cx, |cx| panel.read_with(cx, |p, _| p.idea_count() == 4));

    // 新建分组, then a sub-group under it; two levels down nests no more.
    panel.update(cx, |p, cx| p.new_group(None, cx));
    settle(&panel, cx);
    let top = group_named(&s, "新分组");
    panel.update(cx, |p, cx| p.new_group(Some(top.id.clone()), cx));
    settle(&panel, cx);
    let all = groups(&s);
    let sub = all
        .iter()
        .find(|g| g.parent.as_deref() == Some(top.id.as_str()))
        .expect("a sub-group");
    assert!(dr_view_ideas::model::can_nest_under(&all, &top.id));
    assert!(!dr_view_ideas::model::can_nest_under(&all, &sub.id));
    // 在此新建构想 in the sub-group.
    panel.update(cx, |p, cx| p.new_idea(Some(sub.id.clone()), cx));
    settle(&panel, cx);
    assert!(
        ideas(&s, false)
            .iter()
            .any(|i| i.group.as_deref() == Some(sub.id.as_str()))
    );
}

#[gpui::test]
fn ideas_nest_in_groups_and_groups_move_rename_and_go(cx: &mut TestAppContext) {
    let s = seeded();
    let (_ws, panel, cx) = open(cx, &s);
    let ids: Vec<IdeaInfo> = ideas(&s, false);
    let (a_id, b_id) = {
        let lib = s.lib.clone();
        let a = dr_view_ideas::data::create_group(&lib, &s.book, "结构", None).unwrap();
        let b = dr_view_ideas::data::create_group(&lib, &s.book, "细节", Some(&a)).unwrap();
        (a, b)
    };
    let c_id = dr_view_ideas::data::create_group(&s.lib, &s.book, "别处", None).unwrap();
    wait_for(cx, |cx| {
        panel.read_with(cx, |p, _| p.tree().group_ids().len() == 3)
    });
    panel.update(cx, |p, cx| p.move_idea(&ids[0].id, Some(a_id.clone()), cx));
    panel.update(cx, |p, cx| p.move_idea(&ids[1].id, Some(b_id.clone()), cx));
    settle(&panel, cx);
    wait_for(cx, |cx| {
        panel.read_with(cx, |p, _| p.tree().loose.len() == 1)
    });
    let tree = panel.read_with(cx, |p, _| p.tree());
    let a = tree.find(&a_id).unwrap();
    assert_eq!(
        (a.ideas.len(), a.count),
        (1, 2),
        "its own and its sub-group's"
    );
    assert_eq!(a.children[0].group.id, b_id);
    assert_eq!(tree.loose[0].id, ids[2].id);

    // Renamed in place: Enter stores it.
    cx.update(|window, cx| panel.update(cx, |p, cx| p.start_rename(&c_id, window, cx)));
    let field = panel.read_with(cx, |p, _| p.renaming().unwrap().1);
    cx.update(|window, cx| {
        let h = field.read(cx).focus_handle(cx);
        window.focus(&h, cx);
    });
    cx.simulate_input("闲笔");
    cx.simulate_keystrokes("enter");
    settle(&panel, cx);
    assert!(panel.read_with(cx, |p, _| p.renaming().is_none()));
    assert_eq!(
        groups(&s).iter().find(|g| g.id == c_id).unwrap().name,
        "闲笔"
    );

    // Moved where its levels fit: 闲笔 under 结构; 结构 (two levels) not
    // under 闲笔.
    panel.update(cx, |p, cx| p.move_group(&c_id, Some(a_id.clone()), cx));
    settle(&panel, cx);
    wait_for(cx, |_| {
        groups(&s)
            .iter()
            .find(|g| g.id == c_id)
            .unwrap()
            .parent
            .as_deref()
            == Some(a_id.as_str())
    });
    panel.update(cx, |p, cx| p.move_group(&a_id, Some(c_id.clone()), cx));
    settle(&panel, cx);
    assert!(
        groups(&s)
            .iter()
            .find(|g| g.id == a_id)
            .unwrap()
            .parent
            .is_none()
    );

    // Deleted: its ideas and sub-groups move up.
    panel.update(cx, |p, cx| p.delete_group(&a_id, cx));
    settle(&panel, cx);
    wait_for(cx, |_| !groups(&s).iter().any(|g| g.id == a_id));
    let now = ideas(&s, false);
    assert!(
        now.iter()
            .find(|i| i.id == ids[0].id)
            .unwrap()
            .group
            .is_none()
    );
    assert!(
        groups(&s)
            .iter()
            .find(|g| g.id == b_id)
            .unwrap()
            .parent
            .is_none()
    );

    // 展开／折叠全部; by title.
    wait_for(cx, |cx| {
        panel.read_with(cx, |p, _| p.tree().group_ids().len() == 2)
    });
    panel.update(cx, |p, cx| p.toggle_all(cx));
    assert_eq!(panel.read_with(cx, |p, _| p.collapsed.len()), 2);
    panel.update(cx, |p, cx| p.toggle_all(cx));
    assert!(panel.read_with(cx, |p, _| p.collapsed.is_empty()));
    panel.update(cx, |p, cx| p.set_sort(Sort::Title, cx));
    let loose: Vec<String> = panel.read_with(cx, |p, _| {
        p.tree().loose.iter().map(|i| i.title.clone()).collect()
    });
    let mut sorted = loose.clone();
    sorted.sort_by(|a, b| dr_view_elements::panel::natural(a, b));
    assert_eq!(loose, sorted);
}

#[gpui::test]
fn an_ideas_menu_rests_moves_and_deletes_it(cx: &mut TestAppContext) {
    let s = seeded();
    let (ws, panel, cx) = open(cx, &s);
    let idea = ideas(&s, false).remove(0);
    let target = Target::Idea(idea.id.parse().unwrap());
    let rows = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| {
            let host = PageMenuHost::of(&ws, cx);
            dr_view_ideas::menu::sections(&target, &host, cx)
        })
    };
    // No groups yet: status and delete only.
    let sections = rows(cx);
    assert_eq!(sections.len(), 2);
    let status = &sections[0].items;
    assert!(status[0].checked && !status[1].checked, "漂流 ticked");
    assert!(sections[1].items[0].danger);

    // 休息: resting, still in the list.
    let run = status[1].run.clone();
    cx.update(|window, cx| run(window, cx));
    wait_for(cx, |_| {
        ideas(&s, false)
            .iter()
            .find(|i| i.id == idea.id)
            .unwrap()
            .status
            == "resting"
    });
    wait_for(cx, |cx| {
        panel.read_with(cx, |p, _| {
            p.tree()
                .loose
                .iter()
                .any(|i| i.id == idea.id && i.status == "resting")
        })
    });

    // With a group, 移动到分组 lists it; choosing it moves the idea.
    let g = dr_view_ideas::data::create_group(&s.lib, &s.book, "结构", None).unwrap();
    wait_for(cx, |cx| {
        ws.read_with(cx, |w, _| !w.book.idea_groups.is_empty())
    });
    let sections = rows(cx);
    assert_eq!(sections.len(), 3);
    let moves = &sections[1].items;
    assert!(moves[0].checked, "in no group yet");
    assert_eq!(moves[1].label.as_ref(), "结构");
    let run = moves[1].run.clone();
    cx.update(|window, cx| run(window, cx));
    wait_for(cx, |_| {
        ideas(&s, false)
            .iter()
            .find(|i| i.id == idea.id)
            .unwrap()
            .group
            .as_deref()
            == Some(g.as_str())
    });

    // 删除节点: in the trash.
    let run = rows(cx)[2].items[0].run.clone();
    cx.update(|window, cx| run(window, cx));
    wait_for(cx, |_| ideas(&s, true).iter().any(|i| i.id == idea.id));
    wait_for(cx, |cx| panel.read_with(cx, |p, _| p.idea_count() == 2));
}
