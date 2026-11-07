//! List items as the author types: Enter continues and leaves, Backspace at
//! an item's start, Tab / ⇧Tab, and ticking tasks from the keyboard.

use std::{cell::RefCell, rc::Rc};

use gpui::{Entity, TestAppContext, VisualTestContext};

use super::*;
use crate::{
    render::{
        DecorationEvent,
        blocks::{ListItem, ListMark},
    },
    schema::block,
};

/// A note's paragraphs, each a list item (`(kind, level)`) or plain
/// (`None`), in a focused editor with the Mac keys bound.
fn note<'a>(
    cx: &'a mut TestAppContext,
    paragraphs: &[(&str, Option<(&str, i64)>)],
) -> (Entity<ProseEditor>, &'a mut VisualTestContext) {
    let texts: Vec<(BlockKind, &str)> = paragraphs
        .iter()
        .map(|(text, _)| (BlockKind::Body, *text))
        .collect();
    let (editor, cx) = keyed_editor(cx, KeyScheme::Mac, &[&texts]);
    editor.update(cx, |e, cx| {
        let doc = &mut e.book_mut().chapters[0].doc;
        for (line, (_, item)) in paragraphs.iter().enumerate() {
            if let Some((kind, level)) = item {
                // Seeded: not part of the author's history.
                doc.set_block_attr(line, block::LIST, Some((*kind).into()), "seed");
                if *level > 0 {
                    doc.set_block_attr(line, block::LIST_LEVEL, Some((*level).into()), "seed");
                }
            }
        }
        e.refresh_chapter(0, cx);
    });
    (editor, cx)
}

fn item(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, line: usize) -> Option<ListItem> {
    editor.update(cx, |e, _| e.list_item_at(0, line))
}

fn level(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, line: usize) -> Option<u8> {
    item(editor, cx, line).map(|i| i.level)
}

fn lines(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> Vec<String> {
    editor.update(cx, |e, _| {
        let doc = &e.book().chapters[0].doc;
        (0..doc.visible_lines())
            .map(|l| doc.line(l).text.to_string())
            .collect()
    })
}

#[gpui::test]
fn enter_continues_a_list_and_an_empty_item_leaves_it(cx: &mut TestAppContext) {
    let (editor, cx) = note(cx, &[("买菜", Some(("bullet", 0)))]);
    select(&editor, cx, 0, 2);
    cx.simulate_keystrokes("enter");
    commit(&editor, cx, "做饭");
    assert_eq!(lines(&editor, cx), ["买菜", "做饭"]);
    assert_eq!(item(&editor, cx, 1).map(|i| i.mark), Some(ListMark::Bullet));
    // Enter in the empty item at level 0: a plain paragraph, nothing split.
    cx.simulate_keystrokes("enter");
    assert_eq!(item(&editor, cx, 2).map(|i| i.mark), Some(ListMark::Bullet));
    cx.simulate_keystrokes("enter");
    assert_eq!(lines(&editor, cx), ["买菜", "做饭", ""]);
    assert_eq!(item(&editor, cx, 2), None);
    // One undo puts it back in the list.
    undo(&editor, cx);
    assert_eq!(item(&editor, cx, 2).map(|i| i.mark), Some(ListMark::Bullet));
}

#[gpui::test]
fn a_nested_empty_item_moves_out_a_level_at_a_time(cx: &mut TestAppContext) {
    let (editor, cx) = note(
        cx,
        &[("一", Some(("ordered", 0))), ("", Some(("ordered", 2)))],
    );
    select(&editor, cx, 0, 2);
    cx.simulate_keystrokes("enter");
    assert_eq!(level(&editor, cx, 1), Some(1));
    cx.simulate_keystrokes("enter");
    assert_eq!(level(&editor, cx, 1), Some(0));
    cx.simulate_keystrokes("enter");
    assert_eq!(level(&editor, cx, 1), None);
    assert_eq!(lines(&editor, cx), ["一", ""]);
}

#[gpui::test]
fn a_new_task_starts_open(cx: &mut TestAppContext) {
    let (editor, cx) = note(cx, &[("洗衣", Some(("task", 1)))]);
    editor.update(cx, |e, cx| {
        let doc = &mut e.book_mut().chapters[0].doc;
        doc.set_block_attr(0, block::CHECKED, Some(true.into()), "seed");
        doc.set_block_attr(0, block::TODO, Some("t1".into()), "seed");
        e.refresh_chapter(0, cx);
    });
    select(&editor, cx, 0, 2);
    cx.simulate_keystrokes("enter");
    let (first, second) = (item(&editor, cx, 0).unwrap(), item(&editor, cx, 1).unwrap());
    assert_eq!(first.mark, ListMark::Task { done: true });
    assert_eq!(
        second,
        ListItem {
            mark: ListMark::Task { done: false },
            level: 1
        }
    );
    // Nor does it carry the TODO link.
    let todo = editor.update(cx, |e, _| {
        e.book().chapters[0]
            .doc
            .line(1)
            .block
            .get(block::TODO)
            .cloned()
    });
    assert_eq!(todo, None);
}

#[gpui::test]
fn backspace_at_an_item_start_leaves_the_list(cx: &mut TestAppContext) {
    let (editor, cx) = note(cx, &[("前面", None), ("一项", Some(("bullet", 1)))]);
    select(&editor, cx, 0, 3);
    cx.simulate_keystrokes("backspace");
    assert_eq!(item(&editor, cx, 1), None);
    assert_eq!(lines(&editor, cx), ["前面", "一项"]);
    let level_left = editor.update(cx, |e, _| {
        e.book().chapters[0]
            .doc
            .line(1)
            .block
            .get(block::LIST_LEVEL)
            .cloned()
    });
    assert_eq!(level_left, None);
    // The second Backspace joins as usual.
    cx.simulate_keystrokes("backspace");
    assert_eq!(lines(&editor, cx), ["前面一项"]);
}

#[gpui::test]
fn backspace_inside_an_item_deletes_as_always(cx: &mut TestAppContext) {
    let (editor, cx) = note(cx, &[("一项", Some(("bullet", 0)))]);
    select(&editor, cx, 0, 1);
    cx.simulate_keystrokes("backspace");
    assert_eq!(lines(&editor, cx), ["项"]);
    assert!(item(&editor, cx, 0).is_some());
}

#[gpui::test]
fn tab_and_shift_tab_change_levels(cx: &mut TestAppContext) {
    let (editor, cx) = note(
        cx,
        &[
            ("一", Some(("bullet", 0))),
            ("二", Some(("bullet", 0))),
            ("夹着的段落", None),
            ("三", Some(("task", 3))),
        ],
    );
    select(&editor, cx, 0, 3);
    cx.simulate_keystrokes("tab");
    assert_eq!(level(&editor, cx, 1), Some(1));
    for _ in 0..10 {
        cx.simulate_keystrokes("tab");
    }
    assert_eq!(level(&editor, cx, 1), Some(8), "level 8 at most");
    cx.simulate_keystrokes("shift-tab");
    assert_eq!(level(&editor, cx, 1), Some(7));
    undo(&editor, cx);
    assert_eq!(level(&editor, cx, 1), Some(8), "one undo step per press");
    // A selection over several items moves each of them; the plain
    // paragraph between is untouched.
    editor.update_in(cx, |e, window, cx| e.select(0, 0..11, window, cx));
    cx.simulate_keystrokes("shift-tab");
    assert_eq!(
        (0..4).map(|l| level(&editor, cx, l)).collect::<Vec<_>>(),
        [Some(0), Some(7), None, Some(2)]
    );
    assert_eq!(lines(&editor, cx), ["一", "二", "夹着的段落", "三"]);
    // Level 0 is stored as no level.
    let stored = editor.update(cx, |e, _| {
        e.book().chapters[0]
            .doc
            .line(0)
            .block
            .get(block::LIST_LEVEL)
            .cloned()
    });
    assert_eq!(stored, None);
    // Outside any item the editor leaves Tab alone.
    select(&editor, cx, 0, 7);
    let handled = editor.update_in(cx, |e, window, cx| e.shift_list_level(1, window, cx));
    assert!(!handled);
    assert_eq!(level(&editor, cx, 2), None);
}

#[gpui::test]
fn command_enter_ticks_tasks_through_the_host(cx: &mut TestAppContext) {
    let (editor, cx) = note(
        cx,
        &[
            ("买灯芯", Some(("task", 0))),
            ("问钟楼", Some(("bullet", 0))),
            ("修门", Some(("task", 0))),
        ],
    );
    let seen: Rc<RefCell<Vec<DecorationEvent>>> = Rc::default();
    cx.update(|_, cx| {
        let seen = seen.clone();
        cx.subscribe(&editor, move |_, event: &DecorationEvent, _| {
            seen.borrow_mut().push(event.clone())
        })
        .detach();
    });
    select(&editor, cx, 0, 1);
    cx.simulate_keystrokes("cmd-enter");
    assert_eq!(
        *seen.borrow(),
        [DecorationEvent::TaskClicked {
            chapter: 0,
            line: 0
        }]
    );
    seen.borrow_mut().clear();
    // On a bullet: nothing for the host.
    select(&editor, cx, 0, 5);
    cx.simulate_keystrokes("cmd-enter");
    assert!(seen.borrow().is_empty());
    // Over all three: each task once.
    editor.update_in(cx, |e, window, cx| e.select(0, 0..10, window, cx));
    cx.simulate_keystrokes("cmd-enter");
    assert_eq!(
        *seen.borrow(),
        [
            DecorationEvent::TaskClicked {
                chapter: 0,
                line: 0
            },
            DecorationEvent::TaskClicked {
                chapter: 0,
                line: 2
            }
        ]
    );
    // The text never changed.
    assert_eq!(lines(&editor, cx), ["买灯芯", "问钟楼", "修门"]);
}

#[gpui::test]
fn markdown_markers_make_items_where_the_host_allows_lists(cx: &mut TestAppContext) {
    let (editor, cx) = note(cx, &[("", None), ("正文", None)]);
    select(&editor, cx, 0, 0);
    // Off by default (chapters): the marker stays text.
    commit(&editor, cx, "-");
    commit(&editor, cx, " ");
    assert_eq!(lines(&editor, cx), ["- ", "正文"]);
    assert_eq!(item(&editor, cx, 0), None);
    undo(&editor, cx);
    assert_eq!(lines(&editor, cx), ["", "正文"]);
    editor.update(cx, |e, _| e.set_list_shortcuts(true));
    for (typed, mark) in [
        ("- ", ListMark::Bullet),
        ("3. ", ListMark::Ordered(1)),
        ("[x] ", ListMark::Task { done: true }),
    ] {
        for c in typed.chars() {
            commit(&editor, cx, &c.to_string());
        }
        assert_eq!(lines(&editor, cx), ["", "正文"], "{typed:?}");
        assert_eq!(
            item(&editor, cx, 0).map(|i| i.mark),
            Some(mark),
            "{typed:?}"
        );
        // One undo brings the marker back as typed, a second removes it.
        undo(&editor, cx);
        assert_eq!(lines(&editor, cx)[0], typed);
        assert_eq!(item(&editor, cx, 0), None);
        undo(&editor, cx);
        assert_eq!(lines(&editor, cx)[0], "");
    }
    // Only at a paragraph's start.
    select(&editor, cx, 0, 3);
    commit(&editor, cx, "- ");
    assert_eq!(item(&editor, cx, 1), None);
}
