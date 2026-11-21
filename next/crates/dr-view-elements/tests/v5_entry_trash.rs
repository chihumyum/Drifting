//! The left column's 「最近删除」 (`kernel-v5.md` §16; the author chose 一甲
//! and 二乙 on 2026-11-21): the last section of every Tab's tree, what each
//! Tab lists and counts, the folded rows, each row's small line, and what
//! 「恢复」 and 「永久删除」 do.
use std::{
    collections::BTreeSet,
    rc::Rc,
    time::{Duration, Instant},
};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as Shell,
    book::Book,
    pages::PageViewHost,
    v3::{DisplaySurface, LevelHost, ROOT_LEVEL, trash},
};
use dr_view_elements::panel::v3::{Display, LevelDisplay, Row};
use dr_workspace::{Actor, Workspace, commands::v3::types::TabMount};
use gpui::{
    AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, Styled as _,
    TestAppContext, VisualTestContext, WeakEntity, Window, div, px, size,
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
fn call(ws: &Workspace, name: &str, mut input: Value, book: &str) -> Value {
    input["book"] = json!(book);
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

/// What the tests delete, in a synthetic book: 书稿 holds 「第一幕」 with two
/// chapters (the first hung on a storyline), and 「旧稿」 with one; an
/// outermost note.
struct Deleted {
    manuscript: String,
    storyline: String,
    category: String,
    act: String,
    c1: String,
    c2: String,
    drafts: String,
    old: String,
    note: String,
}

fn entry(ws: &Workspace, book: &str, parent: Option<&str>, template: &str, title: &str) -> String {
    call(
        ws,
        "entry.create",
        json!({"parent":parent,"template":template,"title":title}),
        book,
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// As if `ids` (what went in together) had gone into Recently Deleted
/// `secs` ago.
fn age(ws: &Workspace, book: &str, ids: &[&str], secs: i64) {
    let b: dr_model::id::BookId = book.parse().unwrap();
    let ids: Vec<dr_model::id::EntryId> = ids.iter().map(|id| id.parse().unwrap()).collect();
    let at = dr_model::Timestamp(dr_model::Timestamp::now().0 - secs);
    ws.library()
        .open_doc(&format!("book:{book}"), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::User, move |d| {
            let borrowed = dr_doc::v3::BorrowedBookV3::new(d, &b).unwrap();
            let mut txn = borrowed.txn();
            for e in &ids {
                txn.entries()
                    .entry(e)
                    .unwrap()
                    .deleted_at(Some(at))
                    .unwrap();
            }
        })
        .unwrap();
}

fn delete_some(ws: &Workspace, book: &str) -> Deleted {
    let snapshot = Book::load(ws, book).unwrap();
    let manuscript = of_template(&snapshot, "tpl-manuscript");
    let storyline = of_template(&snapshot, "tpl-storyline");
    let category = of_template(&snapshot, "tpl-category");
    let act = entry(ws, book, Some(&manuscript), "tpl-group", "第一幕");
    let c1 = entry(ws, book, Some(&act), "tpl-chapter", "第一章 停摆");
    let c2 = entry(ws, book, Some(&act), "tpl-chapter", "第二章 面馆");
    let drafts = entry(ws, book, Some(&manuscript), "tpl-group", "旧稿");
    let old = entry(ws, book, Some(&drafts), "tpl-chapter", "第一版开头");
    let note = entry(ws, book, None, "tpl-note", "散页");
    call(
        ws,
        "membership.add",
        json!({"host":storyline,"member":c1}),
        book,
    );
    // The second chapter went in on its own an hour ago; the act with the
    // first ten minutes ago; the old draft two minutes ago, when 「旧稿」
    // stopped taking entries; the note just now.
    call(ws, "entry.trash", json!({"id":c2}), book);
    age(ws, book, &[&c2], 3600);
    call(ws, "entry.trash", json!({"id":act}), book);
    age(ws, book, &[&act, &c1], 600);
    call(
        ws,
        "entry.set_level",
        json!({"id":drafts,"level":false}),
        book,
    );
    age(ws, book, &[&old], 120);
    call(ws, "entry.trash", json!({"id":note}), book);
    Deleted {
        manuscript,
        storyline,
        category,
        act,
        c1,
        c2,
        drafts,
        old,
        note,
    }
}

fn host(ws: &Workspace, book: &str, level: &str) -> LevelHost {
    LevelHost {
        page: PageViewHost {
            workspace: WeakEntity::new_invalid(),
            library: ws.clone(),
            book_id: book.to_owned(),
            book: Rc::new(Book::load(ws, book).unwrap()),
        },
        level: level.to_owned(),
        surface: DisplaySurface::Sidebar,
    }
}

/// The section's rows of a list: its count, then each row's id and depth.
fn section(rows: &[Row]) -> Option<(usize, Vec<(String, usize)>)> {
    let at = rows
        .iter()
        .position(|r| matches!(r, Row::TrashHead { .. }))?;
    let Row::TrashHead { count } = rows[at] else {
        unreachable!()
    };
    assert_eq!(
        rows.iter()
            .filter(|r| matches!(r, Row::TrashHead { .. }))
            .count(),
        1
    );
    let below: Vec<(String, usize)> = rows[at + 1..]
        .iter()
        .map(|r| match r {
            Row::Trashed(t) => (t.id.clone(), t.depth),
            other => panic!("the section is the last: {other:?}"),
        })
        .collect();
    Some((count, below))
}

#[test]
fn nothing_shows_while_nothing_is_deleted() {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    assert!(snapshot.v3().unwrap().trash.is_empty());
    for level in [
        ROOT_LEVEL.to_owned(),
        of_template(&snapshot, "tpl-manuscript"),
        of_template(&snapshot, "tpl-storyline"),
    ] {
        let list = LevelDisplay::new(host(&ws, &book, &level), Display::List);
        assert!(section(&list.rows).is_none(), "{level}");
    }
    let v = snapshot.v3().unwrap();
    assert!(trash::section(v, &TabMount::Book, &BTreeSet::new()).is_none());
}

/// 「全部」 lists everything deleted; a Tab on an entry what was in its tree
/// (living under it at any depth, or hung on it); a Tab on the book what had
/// prose in the book. The count is every entry the rows hold, folded ones
/// included; the rows are the most recently deleted first.
#[test]
fn each_tab_lists_what_was_deleted_from_it_and_counts_every_entry() {
    let (_dir, ws, book) = seed();
    let d = delete_some(&ws, &book);
    let rows =
        |level: &str| section(&LevelDisplay::new(host(&ws, &book, level), Display::List).rows);
    assert_eq!(
        rows(ROOT_LEVEL),
        Some((
            5,
            vec![
                (d.note.clone(), 0),
                (d.old.clone(), 0),
                (d.act.clone(), 0),
                (d.c2.clone(), 0)
            ]
        ))
    );
    assert_eq!(
        rows(&d.manuscript),
        Some((
            4,
            vec![(d.old.clone(), 0), (d.act.clone(), 0), (d.c2.clone(), 0)]
        ))
    );
    // The first chapter was hung on the storyline: its act's row is there.
    assert_eq!(rows(&d.storyline), Some((2, vec![(d.act.clone(), 0)])));
    assert_eq!(rows(&d.category), None);
    // The islands of an unfilled grid Tab end with it too.
    let islands = LevelDisplay::new(host(&ws, &book, &d.manuscript), Display::Islands);
    assert_eq!(section(&islands.rows), rows(&d.manuscript));
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    let (count, book_rows) = trash::section(v, &TabMount::Book, &BTreeSet::new()).unwrap();
    assert_eq!(count, 4, "a note has no prose in the book");
    let ids: Vec<&str> = book_rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, [d.old.as_str(), d.act.as_str(), d.c2.as_str()]);
}

/// A left-column list in a window whose workspace has the book open.
struct Tree {
    list: Option<Entity<LevelDisplay>>,
    workspace: Entity<Shell>,
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
        dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx);
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

/// The list catches up with the workspace's book once it has `done`.
fn catch_up(
    cx: &mut VisualTestContext,
    view: &Entity<Tree>,
    list: &Entity<LevelDisplay>,
    what: &str,
    done: impl Fn(&dr_shell::book::v3::BookV3) -> bool,
) {
    let shell = view.read_with(cx, |t, _| t.workspace.clone());
    wait_for(cx, what, |cx| {
        shell.read_with(cx, |w, _| w.book.v3().is_some_and(&done))
    });
    let book = shell.read_with(cx, |w, _| w.book.clone());
    list.update(cx, |l, cx| l.refresh(book, cx));
    frame(cx);
}

/// A row that went in with the entry it lived under is folded under that
/// row (the triangle opens it); the section folds as a whole. Each row's
/// small line names where it goes back to: where it lived; 「全部」 for an
/// outermost one; and further up when its old place takes no entries now
/// (in Recently Deleted itself, or its 层级 turned off).
#[gpui::test]
fn the_section_folds_what_went_in_together_and_names_where_each_row_goes_back(
    cx: &mut TestAppContext,
) {
    let (_dir, ws, book) = seed();
    let d = delete_some(&ws, &book);
    let (_view, list, cx) = tree(cx, &ws, &book, ROOT_LEVEL);
    let rows = |list: &Entity<LevelDisplay>, cx: &mut VisualTestContext| {
        list.read_with(cx, |l, _| section(&l.rows))
    };
    let (count, shown) = rows(&list, cx).unwrap();
    assert_eq!(count, 5);
    assert!(!shown.iter().any(|(id, _)| *id == d.c1), "folded at first");
    let holds = list.read_with(cx, |l, _| {
        l.rows
            .iter()
            .any(|r| matches!(r, Row::Trashed(t) if t.id == d.act && t.holds))
    });
    assert!(holds, "the act's row has the triangle");
    list.update(cx, |l, cx| l.toggle_trashed(&d.act, cx));
    let (_, shown) = rows(&list, cx).unwrap();
    let at = shown.iter().position(|(id, _)| *id == d.act).unwrap();
    assert_eq!(shown[at + 1], (d.c1.clone(), 1), "opened under its act");
    // The whole section folds to its head.
    list.update(cx, |l, cx| l.toggle_trash(cx));
    assert_eq!(rows(&list, cx), Some((5, Vec::new())));
    list.update(cx, |l, cx| l.toggle_trash(cx));

    let manuscript_title = Book::load(&ws, &book)
        .unwrap()
        .v3()
        .unwrap()
        .entry(&d.manuscript)
        .unwrap()
        .title
        .clone();
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    let lines: Vec<String> = [&d.act, &d.c1, &d.c2, &d.old, &d.note]
        .iter()
        .map(|id| {
            cx.update(|_, cx| {
                trash::line(&v.trash[id.as_str()], std::time::SystemTime::now(), cx).to_string()
            })
        })
        .collect();
    let lives = format!("住在「{manuscript_title}」");
    assert_eq!(lines[0], format!("{lives} · 10 分钟前"), "where it lived");
    assert_eq!(
        lines[1],
        format!("{lives} · 10 分钟前"),
        "its act is in Recently Deleted: further up"
    );
    assert_eq!(lines[2], format!("{lives} · 1 小时前"));
    assert_eq!(
        lines[3],
        format!("{lives} · 2 分钟前"),
        "「旧稿」 takes no entries now: further up, not 「旧稿」"
    );
    assert!(v.entry(&d.drafts).is_some_and(|e| !e.level));
    assert_eq!(lines[4], "住在「全部」 · 刚刚", "it lived outermost");
}

/// 「恢复」 puts the entry back where its line said, without a word: the
/// tree opens down to it, its row flashes once, and the section counts one
/// less (a row whose last entry leaves goes with it).
#[gpui::test]
fn restoring_a_row_puts_it_back_where_it_says_and_the_count_drops(cx: &mut TestAppContext) {
    let (_dir, ws, book) = seed();
    let d = delete_some(&ws, &book);
    let (view, list, cx) = tree(cx, &ws, &book, ROOT_LEVEL);
    let shell = view.read_with(cx, |t, _| t.workspace.clone());
    // 「全部」 opens with the outermost entries folded: 书稿 is.
    assert!(list.read_with(cx, |l, _| l.folded.contains(&d.manuscript)));
    let host = list.read_with(cx, |l, _| l.host.page.clone());
    let reveal = list.downgrade();
    let restored: trash::RowHook = Rc::new(move |id: &str, cx: &mut gpui::App| {
        let _ = reveal.update(cx, |l, cx| l.reveal_restored(id, cx));
    });
    let old = d.old.clone();
    cx.update(|_, cx| trash::restore_entry(&host, &old, restored, cx));
    catch_up(cx, &view, &list, "the old draft is back", |v| {
        v.entry(&d.old).is_some()
    });
    let restored = Book::load(&ws, &book).unwrap();
    assert_eq!(
        restored
            .v3()
            .unwrap()
            .entry(&d.old)
            .unwrap()
            .parent
            .as_deref(),
        Some(d.manuscript.as_str()),
        "where its line said"
    );
    let (count, shown) = list.read_with(cx, |l, _| section(&l.rows)).unwrap();
    assert_eq!(count, 4);
    assert!(!shown.iter().any(|(id, _)| *id == d.old));
    // The tree opened down to it; its row flashes; nothing was asked or
    // said.
    let in_tree = list.read_with(cx, |l, _| {
        !l.folded.contains(&d.manuscript)
            && l.rows
                .iter()
                .any(|r| matches!(r, Row::Entry { id, .. } if *id == d.old))
    });
    assert!(in_tree, "the restored row is shown where it now is");
    let flashing = cx.update(|_, cx| {
        cx.try_global::<dr_shell::pages::UsageFlash>()
            .is_some_and(|f| f.keys.contains(&trash::flash_key(&d.old)))
    });
    assert!(flashing, "its row flashes once (the reveal's flash)");
    assert!(shell.read_with(cx, |w, _| w.top_layer().is_none()));
    // A folded chapter restored on its own: its act stays in Recently
    // Deleted, it lands in 书稿.
    let host = list.read_with(cx, |l, _| l.host.page.clone());
    let c1 = d.c1.clone();
    cx.update(|_, cx| {
        trash::restore_entry(&host, &c1, Rc::new(|_: &str, _: &mut gpui::App| {}), cx)
    });
    catch_up(cx, &view, &list, "the first chapter is back", |v| {
        v.entry(&d.c1).is_some()
    });
    let (count, shown) = list.read_with(cx, |l, _| section(&l.rows)).unwrap();
    assert_eq!(count, 3);
    assert!(shown.iter().any(|(id, _)| *id == d.act));
    let v = Book::load(&ws, &book).unwrap();
    assert_eq!(
        v.v3().unwrap().entry(&d.c1).unwrap().parent.as_deref(),
        Some(d.manuscript.as_str())
    );
}

/// 「永久删除」 asks nothing: the row and what went in with it leave the
/// section and the book; the rest stays.
#[gpui::test]
fn permanent_delete_removes_the_row_without_a_question(cx: &mut TestAppContext) {
    let (_dir, ws, book) = seed();
    let d = delete_some(&ws, &book);
    let (view, list, cx) = tree(cx, &ws, &book, &d.manuscript);
    let shell = view.read_with(cx, |t, _| t.workspace.clone());
    assert_eq!(list.read_with(cx, |l, _| section(&l.rows)).unwrap().0, 4);
    let host = list.read_with(cx, |l, _| l.host.page.clone());
    let act = d.act.clone();
    cx.update(|_, cx| trash::purge_entry(&host, &act, cx));
    assert!(
        shell.read_with(cx, |w, _| w.top_layer().is_none()),
        "no question"
    );
    catch_up(cx, &view, &list, "the act is gone", |v| {
        !v.trash.contains_key(&d.act)
    });
    let (count, shown) = list.read_with(cx, |l, _| section(&l.rows)).unwrap();
    assert_eq!(count, 2);
    assert_eq!(shown, vec![(d.old.clone(), 0), (d.c2.clone(), 0)]);
    let all = call(&ws, "entry.list", json!({"all":true,"trashed":true}), &book);
    let ids: Vec<&str> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert!(!ids.contains(&d.act.as_str()) && !ids.contains(&d.c1.as_str()));
    assert!(ids.contains(&d.c2.as_str()));
    // The last ones out: nothing shows.
    for id in [&d.old, &d.c2, &d.note] {
        let host = list.read_with(cx, |l, _| l.host.page.clone());
        let id = id.clone();
        cx.update(|_, cx| trash::purge_entry(&host, &id, cx));
        catch_up(cx, &view, &list, "purged", |v| !v.trash.contains_key(&id));
    }
    assert!(list.read_with(cx, |l, _| section(&l.rows)).is_none());
}

/// A Tab on an entry deleted for good stays, reads gone and keeps its name
/// (`kernel-v5.md` §5).
#[gpui::test]
fn a_tab_on_an_entry_deleted_for_good_keeps_its_name(cx: &mut TestAppContext) {
    let (_dir, ws, book) = seed();
    let snapshot = Book::load(&ws, &book).unwrap();
    let manuscript = of_template(&snapshot, "tpl-manuscript");
    let act = entry(&ws, &book, Some(&manuscript), "tpl-group", "第一幕");
    let tab = call(
        &ws,
        "tab.put",
        json!({"mount":{"kind":"entry","entry":act},"place":"last"}),
        &book,
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(&ws, "entry.trash", json!({"id":act}), &book);
    call(&ws, "entry.purge", json!({"id":act}), &book);
    let snapshot = Book::load(&ws, &book).unwrap();
    let v = snapshot.v3().unwrap();
    let kept = v.project.tabs.iter().find(|t| t.id == tab).unwrap().clone();
    assert!(dr_shell::v3::tabs::is_gone(v, &kept.mount));
    assert!(!v.trashed_titles.contains_key(&act));
    let name = cx.update(|cx| dr_shell::v3::tabs::tab_name(v, &kept, cx).to_string());
    assert_eq!(name, "第一幕");
}
