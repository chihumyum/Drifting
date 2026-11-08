//! Editor behaviour with GPUI's deterministic test platform. The input method
//! is driven the way macOS drives it: through the `EntityInputHandler` calls
//! that `setMarkedText:`, `insertText:` and `unmarkText` turn into.

use gpui::{Entity, EntityInputHandler, TestAppContext, VisualTestContext};

use super::actions::*;
use crate::{
    EditorEvent, ProseEditor, ProseStyle,
    layout::{Book, Chapter},
    schema::{BODY, inline},
    text::{BlockKind, ProseDoc},
};

fn book(chapters: &[&[(BlockKind, &str)]]) -> Book {
    Book::new(
        chapters
            .iter()
            .enumerate()
            .map(|(ix, paragraphs)| Chapter {
                title: format!("第{}章", ix + 1).into(),
                doc: ProseDoc::from_paragraphs(paragraphs.iter().copied()),
            })
            .collect(),
    )
}

fn editor<'a>(
    cx: &'a mut TestAppContext,
    chapters: &[&[(BlockKind, &str)]],
) -> (Entity<ProseEditor>, &'a mut VisualTestContext) {
    let book = book(chapters);
    let (editor, cx) =
        cx.add_window_view(|window, cx| ProseEditor::new(book, ProseStyle::default(), window, cx));
    cx.run_until_parked();
    (editor, cx)
}

fn loro_text(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, chapter: usize) -> String {
    editor.update(cx, |editor, _| {
        editor.book().chapters[chapter]
            .doc
            .loro_source()
            .unwrap()
            .text()
            .to_string()
    })
}

fn mark(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, text: &str) {
    editor.update_in(cx, |editor, window, cx| {
        let len = text.encode_utf16().count();
        editor.replace_and_mark_text_in_range(None, text, Some(len..len), window, cx);
    });
}

fn commit(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, text: &str) {
    editor.update_in(cx, |editor, window, cx| {
        editor.replace_text_in_range(None, text, window, cx)
    });
}

fn undo(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) {
    editor.update_in(cx, |editor, window, cx| editor.undo(window, cx));
}

fn select(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, chapter: usize, at: usize) {
    editor.update_in(cx, |editor, window, cx| {
        editor.select(chapter, at..at, window, cx)
    });
}

fn head(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> usize {
    editor.update(cx, |editor, _| editor.selection().head)
}

#[gpui::test]
fn marked_text_stays_out_of_loro_until_confirmed(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "正文第一段")]]);
    select(&editor, cx, 0, 2);
    for step in ["n", "ni", "ni h", "ni hao"] {
        mark(&editor, cx, step);
        assert_eq!(
            loro_text(&editor, cx, 0),
            "正文第一段\n",
            "marked text leaked into Loro"
        );
    }
    editor.update_in(cx, |editor, window, cx| {
        assert_eq!(editor.marked_text_range(window, cx), Some(2..8));
        let mut actual = None;
        let whole = editor.text_for_range(0..100, &mut actual, window, cx);
        assert_eq!(whole.as_deref(), Some("正文ni hao第一段\n"));
        assert_eq!(actual, Some(0..12));
        let selected = editor.selected_text_range(false, window, cx).unwrap();
        assert_eq!(selected.range, 8..8);
    });
    commit(&editor, cx, "你好");
    assert_eq!(loro_text(&editor, cx, 0), "正文你好第一段\n");
    editor.update(cx, |editor, _| {
        assert!(editor.composition().is_none());
        assert_eq!(editor.selection().head, 4);
    });
    // One undo takes the whole confirmed word away.
    undo(&editor, cx);
    assert_eq!(loro_text(&editor, cx, 0), "正文第一段\n");
}

#[gpui::test]
fn typing_over_a_selection_replaces_it_only_on_confirm(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "正文第一段")]]);
    editor.update_in(cx, |editor, window, cx| editor.select(0, 0..2, window, cx));
    mark(&editor, cx, "ti");
    assert_eq!(loro_text(&editor, cx, 0), "正文第一段\n");
    editor.update_in(cx, |editor, window, cx| {
        let mut actual = None;
        let whole = editor.text_for_range(0..100, &mut actual, window, cx);
        assert_eq!(whole.as_deref(), Some("ti第一段\n"));
        assert_eq!(editor.text_length_utf16(window, cx), Some(6));
    });
    commit(&editor, cx, "替换");
    assert_eq!(loro_text(&editor, cx, 0), "替换第一段\n");
    undo(&editor, cx);
    assert_eq!(loro_text(&editor, cx, 0), "正文第一段\n");
}

#[gpui::test]
fn deleting_all_marked_text_changes_nothing(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "正文")]]);
    editor.update_in(cx, |editor, window, cx| editor.select(0, 0..2, window, cx));
    mark(&editor, cx, "z");
    mark(&editor, cx, "");
    assert_eq!(loro_text(&editor, cx, 0), "正文\n");
    editor.update(cx, |editor, _| assert!(editor.composition().is_none()));
}

#[gpui::test]
fn unmark_accepts_the_marked_text(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "正文")]]);
    select(&editor, cx, 0, 2);
    mark(&editor, cx, "abc");
    editor.update_in(cx, |editor, window, cx| editor.unmark_text(window, cx));
    assert_eq!(loro_text(&editor, cx, 0), "正文abc\n");
}

#[gpui::test]
fn losing_focus_drops_the_composition(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "正文")]]);
    // Focus events only flow in the active window.
    cx.update(|window, _| window.activate_window());
    cx.run_until_parked();
    let elsewhere = cx.update(|_, cx| cx.focus_handle());
    editor.update_in(cx, |editor, window, cx| {
        window.focus(&editor.focus, cx);
        editor.select(0, 1..1, window, cx);
    });
    // Focus events are dispatched when the window draws.
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    editor.update_in(cx, |editor, window, _| {
        assert!(editor.focus.is_focused(window))
    });
    mark(&editor, cx, "ni");
    cx.update(|window, cx| {
        window.focus(&elsewhere, cx);
        window.refresh();
    });
    cx.run_until_parked();
    editor.update(cx, |editor, _| {
        assert!(editor.composition().is_none(), "marked text left behind")
    });
    assert_eq!(loro_text(&editor, cx, 0), "正文\n");
}

#[gpui::test]
fn undo_is_ignored_while_composing(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "")]]);
    commit(&editor, cx, "一");
    mark(&editor, cx, "er");
    undo(&editor, cx);
    assert_eq!(loro_text(&editor, cx, 0), "一\n");
    editor.update(cx, |editor, _| {
        assert_eq!(editor.composition().unwrap().text, "er")
    });
    commit(&editor, cx, "二");
    assert_eq!(loro_text(&editor, cx, 0), "一二\n");
}

/// The Agent writes while the author is composing further down: the marked
/// text keeps its place and the confirmed word lands where it was typed.
#[gpui::test]
fn foreign_writes_move_the_composition_anchor(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "甲乙丙丁")]]);
    select(&editor, cx, 0, 3);
    mark(&editor, cx, "wu");
    editor.update(cx, |editor, cx| {
        editor.agent_write(0, 0..0, "【补】", "s1/1", cx)
    });
    editor.update(cx, |editor, _| {
        assert_eq!(editor.composition().unwrap().at, 6)
    });
    commit(&editor, cx, "戊");
    assert_eq!(loro_text(&editor, cx, 0), "【补】甲乙丙戊丁\n");
    // The author's undo removes the author's word and keeps the Agent's.
    undo(&editor, cx);
    assert_eq!(loro_text(&editor, cx, 0), "【补】甲乙丙丁\n");
}

#[gpui::test]
fn enter_and_backspace_split_and_join_paragraphs(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::H2, "标题"), (BlockKind::Body, "正文")]]);
    let items = editor.update(cx, |editor, _| editor.book().item_count());
    assert_eq!(items, 3);
    editor.update_in(cx, |editor, window, cx| {
        editor.select(0, 2..2, window, cx);
        editor.press_enter(window, cx);
    });
    editor.update(cx, |editor, _| {
        let doc = &editor.book().chapters[0].doc;
        assert_eq!(doc.line(0).kind, BlockKind::H2);
        assert_eq!(doc.line(1).kind, BlockKind::Body);
        assert_eq!(editor.book().item_count(), 4);
        assert_eq!(editor.list_state().item_count(), 4);
        assert_eq!(editor.selection().head, 3);
    });
    commit(&editor, cx, "新");
    editor.update_in(cx, |editor, window, cx| {
        editor.select(0, 3..3, window, cx);
        editor.press_backspace(window, cx);
    });
    editor.update(cx, |editor, _| {
        let doc = &editor.book().chapters[0].doc;
        assert_eq!(doc.line(0).text.as_ref(), "标题新");
        assert_eq!(doc.line(0).kind, BlockKind::H2);
        assert_eq!(editor.list_state().item_count(), 3);
    });
    assert_eq!(loro_text(&editor, cx, 0), "标题新\n正文\n");
}

#[gpui::test]
fn undo_walks_back_across_chapters(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[&[(BlockKind::Body, "一")], &[(BlockKind::Body, "二")]],
    );
    select(&editor, cx, 0, 1);
    commit(&editor, cx, "甲");
    select(&editor, cx, 1, 1);
    commit(&editor, cx, "乙");
    undo(&editor, cx);
    assert_eq!(loro_text(&editor, cx, 1), "二\n");
    assert_eq!(loro_text(&editor, cx, 0), "一甲\n");
    editor.update(cx, |editor, _| assert_eq!(editor.selection().chapter, 1));
    undo(&editor, cx);
    assert_eq!(loro_text(&editor, cx, 0), "一\n");
    editor.update(cx, |editor, _| assert_eq!(editor.selection().chapter, 0));
}

#[gpui::test]
fn utf16_positions_with_astral_characters(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "a😀b"), (BlockKind::Body, "中")]]);
    editor.update_in(cx, |editor, window, cx| {
        editor.select(0, 2..2, window, cx);
        let selected = editor.selected_text_range(false, window, cx).unwrap();
        assert_eq!(selected.range, 3..3);
        assert_eq!(editor.text_length_utf16(window, cx), Some(7));
        let mut actual = None;
        assert_eq!(
            editor
                .text_for_range(1..5, &mut actual, window, cx)
                .as_deref(),
            Some("😀b\n")
        );
    });
    mark(&editor, cx, "x");
    editor.update_in(cx, |editor, window, cx| {
        assert_eq!(editor.marked_text_range(window, cx), Some(3..4));
        assert_eq!(editor.text_length_utf16(window, cx), Some(8));
    });
}

#[gpui::test]
fn remote_import_moves_the_selection(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "甲乙")]]);
    select(&editor, cx, 0, 2);
    let update = editor.update(cx, |editor, _| {
        let doc = editor.book().chapters[0].doc.loro_source().unwrap().loro();
        let remote = loro::LoroDoc::new();
        crate::schema::configure(&remote);
        remote
            .import(&doc.export(loro::ExportMode::Snapshot).unwrap())
            .unwrap();
        let from = remote.oplog_vv();
        remote.get_text(BODY).insert(0, "远端").unwrap();
        remote.commit();
        remote.export(loro::ExportMode::updates(&from)).unwrap()
    });
    editor.update(cx, |editor, cx| editor.import_remote(0, &update, cx));
    assert_eq!(loro_text(&editor, cx, 0), "远端甲乙\n");
    assert_eq!(head(&editor, cx), 4);
}

// ----- words and grapheme clusters --------------------------------------------------

#[gpui::test]
fn option_arrows_move_by_chinese_words(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[&[
            (BlockKind::Body, "我们今天去公园。"),
            (BlockKind::Body, "明天下雨"),
        ]],
    );
    select(&editor, cx, 0, 0);
    let mut stops = Vec::new();
    for _ in 0..6 {
        editor.update_in(cx, |editor, window, cx| {
            editor.on_move_word_right(&MoveWordRight, window, cx)
        });
        stops.push(head(&editor, cx));
    }
    // 我们|今天|去|公园|。⏎明天|下雨 — the period is skipped, then into the
    // next paragraph.
    #[cfg(feature = "icu")]
    assert_eq!(stops, [2, 4, 5, 7, 11, 13]);
    let mut back = Vec::new();
    for _ in 0..3 {
        editor.update_in(cx, |editor, window, cx| {
            editor.on_move_word_left(&MoveWordLeft, window, cx)
        });
        back.push(head(&editor, cx));
    }
    #[cfg(feature = "icu")]
    assert_eq!(back, [11, 9, 5]);
    // ⌥⌫ deletes the word before the caret: 公园 from after it.
    select(&editor, cx, 0, 7);
    editor.update_in(cx, |editor, window, cx| {
        editor.on_delete_word_backward(&DeleteWordBackward, window, cx)
    });
    #[cfg(feature = "icu")]
    assert_eq!(loro_text(&editor, cx, 0), "我们今天去。\n明天下雨\n");
}

#[gpui::test]
fn double_click_selects_a_word(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "他说：Hello, world！")]]);
    editor.update(cx, |editor, _| {
        #[cfg(feature = "icu")]
        assert_eq!(editor.word_range_at(0, 0), 0..1);
        assert_eq!(editor.word_range_at(0, 5), 3..8);
        assert_eq!(editor.word_range_at(0, 11), 10..15);
    });
}

#[gpui::test]
fn arrows_and_backspace_step_over_whole_clusters(cx: &mut TestAppContext) {
    let family = "👨\u{200D}👩\u{200D}👧";
    let text = format!("前{family}后🇨🇳");
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, text.as_str())]]);
    select(&editor, cx, 0, 1);
    editor.update_in(cx, |editor, window, cx| {
        editor.on_move_right(&MoveRight, window, cx)
    });
    // The family is five scalars, one cluster.
    assert_eq!(head(&editor, cx), 6);
    editor.update_in(cx, |editor, window, cx| {
        editor.on_move_right(&MoveRight, window, cx);
        editor.on_move_right(&MoveRight, window, cx);
    });
    assert_eq!(head(&editor, cx), 9);
    // One Backspace removes the whole flag, another the 后, then the family.
    editor.update_in(cx, |editor, window, cx| {
        editor.press_backspace(window, cx);
        editor.press_backspace(window, cx);
        editor.press_backspace(window, cx);
    });
    assert_eq!(loro_text(&editor, cx, 0), "前\n");
}

// ----- inline marks -------------------------------------------------------------------

#[gpui::test]
fn bold_toggles_on_a_selection_and_at_the_caret(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "普通文字")]]);
    editor.update_in(cx, |editor, window, cx| {
        editor.select(0, 2..4, window, cx);
        editor.on_toggle_bold(&ToggleBold, window, cx);
        assert!(editor.mark_active(inline::BOLD));
        assert!(
            editor.book.chapters[0]
                .doc
                .range_has_mark(2..4, inline::BOLD)
        );
    });
    // ⌘B at a bare caret: the next typed text is bold, the text before not.
    select(&editor, cx, 0, 0);
    editor.update_in(cx, |editor, window, cx| {
        editor.on_toggle_bold(&ToggleBold, window, cx);
        assert!(editor.mark_active(inline::BOLD));
    });
    commit(&editor, cx, "粗");
    editor.update(cx, |editor, _| {
        let doc = &mut editor.book.chapters[0].doc;
        assert!(doc.range_has_mark(0..1, inline::BOLD));
        assert!(!doc.range_has_mark(1..3, inline::BOLD));
    });
    // After bold text, typing continues bold (bold expands after) — through
    // the input method too.
    select(&editor, cx, 0, 5);
    mark(&editor, cx, "zi");
    commit(&editor, cx, "字");
    editor.update(cx, |editor, _| {
        let doc = &mut editor.book.chapters[0].doc;
        assert_eq!(doc.line(0).text.as_ref(), "粗普通文字字");
        assert!(doc.range_has_mark(3..6, inline::BOLD));
    });
    // ⌘I with the caret inside bold, then type: italic and still bold.
    editor.update_in(cx, |editor, window, cx| {
        editor.on_toggle_italic(&ToggleItalic, window, cx)
    });
    commit(&editor, cx, "斜");
    editor.update(cx, |editor, _| {
        let doc = &mut editor.book.chapters[0].doc;
        assert!(doc.range_has_mark(6..7, inline::ITALIC));
        assert!(doc.range_has_mark(6..7, inline::BOLD));
    });
}

#[gpui::test]
fn links_render_with_their_own_run(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "见这里说明")]]);
    editor.update_in(cx, |editor, window, cx| {
        editor.select(0, 1..3, window, cx);
        editor.set_link(Some("https://example.com"), window, cx);
        let display = editor.display(0, 0);
        let lens: Vec<usize> = display.runs.iter().map(|run| run.len).collect();
        assert_eq!(lens, [3, 6, 6]);
        assert_eq!(display.runs[1].color, editor.style.link);
        assert!(display.runs[1].underline.is_some());
        assert_eq!(editor.marks_at(0, 1).link(), Some("https://example.com"));
    });
}

// ----- anchors ------------------------------------------------------------------------

#[gpui::test]
fn undo_reports_restored_anchors(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "甲乙丙丁戊")]]);
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = events.clone();
    cx.update(|_, cx| {
        cx.subscribe(&editor, move |_, event: &EditorEvent, _| {
            if let EditorEvent::AnchorsChanged { changes, .. } = event {
                seen.borrow_mut()
                    .extend(changes.iter().map(|c| c.range.clone()));
            }
        })
        .detach();
    });
    editor.update_in(cx, |editor, window, cx| {
        editor.book.chapters[0].doc.add_anchor("note", 1..3);
        editor.select(0, 0..4, window, cx);
        editor.press_backspace(window, cx);
    });
    assert_eq!(loro_text(&editor, cx, 0), "戊\n");
    undo(&editor, cx);
    cx.run_until_parked();
    assert_eq!(loro_text(&editor, cx, 0), "甲乙丙丁戊\n");
    let restored: Vec<std::ops::Range<usize>> = std::iter::once(1..3).collect();
    assert_eq!(*events.borrow(), restored);
}

/// An extension that turns `**x**` at the caret into bold `x`.
struct Stars;

impl crate::ProseExtension for Stars {
    fn input_rule(&self, typed: &crate::Typed<'_>) -> Option<crate::InputRule> {
        let chars: Vec<char> = typed.before.chars().collect();
        let n = chars.len();
        if n < 5 || !typed.before.ends_with("**") {
            return None;
        }
        let open = chars[..n - 2].iter().collect::<String>().rfind("**")?;
        let open = typed.before[..open].chars().count();
        (open + 2 < n - 2).then(|| crate::InputRule::Mark {
            open: open..open + 2,
            inner: open + 2..n - 2,
            close: n - 2..n,
            key: inline::BOLD.into(),
            value: true.into(),
        })
    }
}

#[gpui::test]
fn input_rules_apply_as_their_own_step(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "")]]);
    editor.update(cx, |e, _| e.set_extension(std::rc::Rc::new(Stars)));
    select(&editor, cx, 0, 0);
    for c in "a**b**".chars() {
        commit(&editor, cx, &c.to_string());
    }
    commit(&editor, cx, "c");
    assert_eq!(loro_text(&editor, cx, 0), "abc\n");
    let (bold, after) = editor.update(cx, |e, _| {
        let doc = &e.book().chapters[0].doc;
        (
            doc.range_has_mark(1..2, inline::BOLD),
            doc.range_has_mark(2..3, inline::BOLD),
        )
    });
    assert!(bold && !after, "b is bold, typing went on without it");
    undo(&editor, cx);
    assert_eq!(
        loro_text(&editor, cx, 0),
        "a**b**\n",
        "undo brings the literal text back"
    );
}

// ----- F4c: find and replace ------------------------------------------------------------

use super::{
    FindEvent, FindHit, FindOptions, FindOutcome, FindScope, FindStatus, KeyScheme, bind_keys_for,
};

fn set_find(
    editor: &Entity<ProseEditor>,
    cx: &mut VisualTestContext,
    query: &str,
    options: FindOptions,
) -> FindOutcome {
    editor.update_in(cx, |editor, window, cx| {
        editor.set_find(query, options, window, cx)
    })
}

fn find_next(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> FindOutcome {
    editor.update_in(cx, |editor, window, cx| editor.find_next(window, cx))
}

fn sel_range(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> (usize, Range<usize>) {
    editor.update(cx, |editor, _| {
        (editor.selection().chapter, editor.selection().range())
    })
}

fn hit(chapter: usize, range: Range<usize>) -> FindHit {
    FindHit { chapter, range }
}

use std::ops::Range;

#[gpui::test]
fn find_steps_through_matches_and_goes_round(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[&[
            (BlockKind::Body, "安娜走了。安娜回来。"),
            (BlockKind::Body, "她说：安娜！"),
        ]],
    );
    select(&editor, cx, 0, 3);
    // As the find bar types, the first match at or after the caret.
    assert_eq!(
        set_find(&editor, cx, "安娜", FindOptions::default()),
        FindOutcome::Found(hit(0, 5..7))
    );
    assert_eq!(sel_range(&editor, cx), (0, 5..7));
    assert_eq!(find_next(&editor, cx), FindOutcome::Found(hit(0, 14..16)));
    assert_eq!(find_next(&editor, cx), FindOutcome::Wrapped(hit(0, 0..2)));
    editor.update(cx, |editor, _| {
        assert_eq!(&*editor.find_matches(0), &[0..2, 5..7, 14..16]);
        assert_eq!(editor.find_current(), Some(hit(0, 0..2)));
        assert_eq!(
            editor.find_status(),
            FindStatus {
                total: 3,
                current: Some(0)
            }
        );
    });
    let back = editor.update_in(cx, |editor, window, cx| editor.find_previous(window, cx));
    assert_eq!(back, FindOutcome::Wrapped(hit(0, 14..16)));
    // Moving the caret away: no current match; the next step starts there.
    select(&editor, cx, 0, 8);
    editor.update(cx, |editor, _| {
        assert_eq!(editor.find_current(), None);
        assert_eq!(editor.find_status().current, None);
    });
    assert_eq!(find_next(&editor, cx), FindOutcome::Found(hit(0, 14..16)));
    // Clearing find leaves no matches.
    editor.update(cx, |editor, cx| editor.clear_find(cx));
    editor.update(cx, |editor, _| assert!(editor.find_matches(0).is_empty()));
}

#[gpui::test]
fn matches_follow_edits_and_other_writers(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[&[
            (BlockKind::Body, "风起了，风停了。"),
            (BlockKind::Body, "第二段没有。"),
        ]],
    );
    select(&editor, cx, 0, 0);
    set_find(&editor, cx, "风", FindOptions::default());
    assert_eq!(sel_range(&editor, cx), (0, 0..1));
    // Typing before the matches moves them.
    select(&editor, cx, 0, 0);
    commit(&editor, cx, "忽然");
    editor.update(cx, |editor, _| {
        assert_eq!(&*editor.find_matches(0), &[2..3, 6..7]);
    });
    // An edit inside a paragraph that adds the query adds a match.
    select(&editor, cx, 0, 12);
    commit(&editor, cx, "风");
    editor.update(cx, |editor, _| {
        assert_eq!(&*editor.find_matches(0), &[2..3, 6..7, 12..13]);
    });
    // The current match is the selection, so another writer's edit carries it.
    editor.update_in(cx, |editor, window, cx| editor.select(0, 6..7, window, cx));
    editor.update(cx, |editor, cx| {
        editor.agent_write(0, 0..0, "【补】", "s1/1", cx)
    });
    editor.update(cx, |editor, _| {
        assert_eq!(&*editor.find_matches(0), &[5..6, 9..10, 15..16]);
        assert_eq!(editor.find_current(), Some(hit(0, 9..10)));
    });
    // Splitting and joining paragraphs keeps the matches right.
    select(&editor, cx, 0, 7);
    editor.update_in(cx, |editor, window, cx| editor.press_enter(window, cx));
    editor.update(cx, |editor, _| {
        assert_eq!(&*editor.find_matches(0), &[5..6, 10..11, 16..17]);
    });
    editor.update_in(cx, |editor, window, cx| editor.press_backspace(window, cx));
    editor.update(cx, |editor, _| {
        assert_eq!(&*editor.find_matches(0), &[5..6, 9..10, 15..16]);
    });
    // Undo of the author's typing takes its match away again.
    for _ in 0..3 {
        undo(&editor, cx);
    }
    editor.update(cx, |editor, _| {
        let text = editor.book().chapters[0].doc.plain_text();
        let expected: Vec<Range<usize>> = text
            .chars()
            .enumerate()
            .filter(|(_, c)| *c == '风')
            .map(|(i, _)| i..i + 1)
            .collect();
        assert_eq!(&*editor.find_matches(0), expected.as_slice());
    });
}

#[gpui::test]
fn replacing_one_and_all_are_single_undo_steps(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[&[
            (BlockKind::Body, "阿明来了，阿明笑了。"),
            (BlockKind::Body, "大家都等阿明。"),
        ]],
    );
    // The middle 阿明 is bold: its replacement stays bold.
    editor.update_in(cx, |editor, window, cx| {
        editor.select(0, 5..7, window, cx);
        editor.on_toggle_bold(&ToggleBold, window, cx);
    });
    select(&editor, cx, 0, 0);
    set_find(&editor, cx, "阿明", FindOptions::default());
    // A first press with the selection already on a match replaces it.
    let replaced = editor.update_in(cx, |editor, window, cx| {
        editor.replace_current("明哥", window, cx)
    });
    assert!(replaced);
    assert_eq!(
        loro_text(&editor, cx, 0),
        "明哥来了，阿明笑了。\n大家都等阿明。\n"
    );
    // …and selects the next one.
    assert_eq!(sel_range(&editor, cx), (0, 5..7));
    editor.update_in(cx, |editor, window, cx| {
        editor.replace_current("明哥", window, cx)
    });
    editor.update(cx, |editor, _| {
        let doc = &editor.book().chapters[0].doc;
        assert!(
            doc.range_has_mark(5..7, inline::BOLD),
            "the bold match stays bold"
        );
        assert!(!doc.range_has_mark(7..8, inline::BOLD));
    });
    undo(&editor, cx);
    assert_eq!(
        loro_text(&editor, cx, 0),
        "明哥来了，阿明笑了。\n大家都等阿明。\n"
    );
    // With the caret elsewhere, the first press only selects.
    select(&editor, cx, 0, 0);
    let replaced = editor.update_in(cx, |editor, window, cx| {
        editor.replace_current("明哥", window, cx)
    });
    assert!(!replaced);
    assert_eq!(sel_range(&editor, cx), (0, 5..7));
    // Replace all: every match in the chapter, one undo step.
    let count = editor.update_in(cx, |editor, window, cx| {
        editor.replace_all("小明", window, cx)
    });
    assert_eq!(count, 2);
    assert_eq!(
        loro_text(&editor, cx, 0),
        "明哥来了，小明笑了。\n大家都等小明。\n"
    );
    editor.update(cx, |editor, _| {
        let lines: Vec<String> = editor.book().chapters[0]
            .doc
            .lines()
            .iter()
            .map(|l| l.text.to_string())
            .collect();
        assert!(
            editor.find_matches(0).is_empty(),
            "{:?} in {lines:?}",
            editor.find_matches(0)
        )
    });
    undo(&editor, cx);
    assert_eq!(
        loro_text(&editor, cx, 0),
        "明哥来了，阿明笑了。\n大家都等阿明。\n"
    );
    editor.update(cx, |editor, _| {
        assert_eq!(&*editor.find_matches(0), &[5..7, 15..17]);
        let doc = &editor.book().chapters[0].doc;
        assert!(
            doc.range_has_mark(5..7, inline::BOLD),
            "undo brings the bold back"
        );
    });
    // A replacement that contains the query is not found again.
    select(&editor, cx, 0, 0);
    set_find(&editor, cx, "阿明", FindOptions::default());
    editor.update_in(cx, |editor, window, cx| {
        editor.replace_current("阿明哥", window, cx);
        assert_eq!(editor.selection().range(), 16..18);
    });
}

#[gpui::test]
fn whole_words_and_case_in_the_editor(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[&[(BlockKind::Body, "Cat cat concatenate。公园里去公园")]],
    );
    select(&editor, cx, 0, 0);
    let exact = FindOptions {
        case_sensitive: true,
        ..FindOptions::default()
    };
    set_find(&editor, cx, "cat", exact);
    editor.update(cx, |editor, _| {
        assert_eq!(&*editor.find_matches(0), &[4..7, 11..14]);
    });
    let words = FindOptions {
        whole_word: true,
        ..FindOptions::default()
    };
    set_find(&editor, cx, "cat", words.clone());
    editor.update(cx, |editor, _| {
        assert_eq!(&*editor.find_matches(0), &[0..3, 4..7]);
    });
    #[cfg(feature = "icu")]
    {
        set_find(&editor, cx, "园", words);
        editor.update(cx, |editor, _| assert!(editor.find_matches(0).is_empty()));
    }
}

#[gpui::test]
fn book_scope_crosses_chapters_and_the_end_is_reported(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[
            &[(BlockKind::Body, "第一章有灯。")],
            &[(BlockKind::Body, "第二章没有。")],
            &[(BlockKind::Body, "第三章也有灯，灯亮了。")],
        ],
    );
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = events.clone();
    cx.update(|_, cx| {
        cx.subscribe(&editor, move |_, event: &FindEvent, _| {
            seen.borrow_mut().push(event.clone())
        })
        .detach();
    });
    select(&editor, cx, 0, 0);
    let book = FindOptions {
        scope: FindScope::Book,
        ..FindOptions::default()
    };
    assert_eq!(
        set_find(&editor, cx, "灯", book.clone()),
        FindOutcome::Found(hit(0, 4..5))
    );
    assert_eq!(find_next(&editor, cx), FindOutcome::Found(hit(2, 5..6)));
    assert_eq!(sel_range(&editor, cx), (2, 5..6));
    editor.update(cx, |editor, _| {
        assert_eq!(
            editor.find_status(),
            FindStatus {
                total: 3,
                current: Some(1)
            }
        );
    });
    find_next(&editor, cx);
    assert_eq!(find_next(&editor, cx), FindOutcome::Wrapped(hit(0, 4..5)));
    // Without wrapping, the end is reported and the selection stays: a host
    // searching other documents takes over there.
    let no_wrap = FindOptions {
        wrap: false,
        scope: FindScope::Chapter,
        ..book
    };
    select(&editor, cx, 2, 0);
    set_find(&editor, cx, "灯", no_wrap);
    find_next(&editor, cx);
    assert_eq!(find_next(&editor, cx), FindOutcome::PassedEnd);
    assert_eq!(sel_range(&editor, cx), (2, 7..8));
    cx.run_until_parked();
    assert_eq!(*events.borrow(), [FindEvent::PassedEnd { forward: true }]);
    let first = editor.update_in(cx, |editor, window, cx| editor.find_first(true, window, cx));
    assert_eq!(first, FindOutcome::Found(hit(2, 5..6)));
    // ⌘E: the selection becomes the query and the find bar hears of it.
    editor.update_in(cx, |editor, window, cx| {
        editor.select(2, 0..3, window, cx);
        editor.use_selection_for_find(window, cx);
    });
    cx.run_until_parked();
    assert_eq!(
        events.borrow().last(),
        Some(&FindEvent::QueryChanged("第三章".into()))
    );
    editor.update(cx, |editor, _| {
        assert_eq!(editor.find_query().map(|(q, _)| q), Some("第三章"))
    });
}

// ----- F4c: word and paragraph drags --------------------------------------------------------

#[gpui::test]
fn a_double_click_drag_extends_by_words(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "我们今天去公园。")]]);
    editor.update(cx, |editor, cx| {
        // Double click inside 今天.
        editor.click_at(0, 3, 2, false, cx);
        #[cfg(feature = "icu")]
        assert_eq!(editor.selection().range(), 2..4);
        // Drag into 公园: the selection keeps 今天 and reaches the end of 公园.
        editor.drag_to(6, cx);
        #[cfg(feature = "icu")]
        assert_eq!((editor.selection().anchor, editor.selection().head), (2, 7));
        // Back over 今天 into 我们: anchored at the end of 今天.
        editor.drag_to(1, cx);
        #[cfg(feature = "icu")]
        assert_eq!((editor.selection().anchor, editor.selection().head), (4, 0));
        editor.release();
        // A plain drag after the release is by characters again.
        editor.click_at(0, 1, 1, false, cx);
        editor.drag_to(3, cx);
        assert_eq!(editor.selection().range(), 1..3);
    });
}

#[gpui::test]
fn a_triple_click_drag_extends_by_paragraphs(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[&[
            (BlockKind::Body, "第一段"),
            (BlockKind::Body, "第二段长一些"),
            (BlockKind::Body, "第三段"),
        ]],
    );
    editor.update(cx, |editor, cx| {
        editor.click_at(0, 6, 3, false, cx);
        assert_eq!(editor.selection().range(), 4..10);
        editor.drag_to(12, cx);
        assert_eq!(
            (editor.selection().anchor, editor.selection().head),
            (4, 14)
        );
        editor.drag_to(1, cx);
        assert_eq!(
            (editor.selection().anchor, editor.selection().head),
            (10, 0)
        );
        // Inside the first paragraph again: just it.
        editor.drag_to(5, cx);
        assert_eq!(editor.selection().range(), 4..10);
        editor.release();
    });
}

// ----- F4c: paragraph moves and the two key schemes ---------------------------------------

/// A focused editor in an active window, with `scheme`'s keys bound.
fn keyed_editor<'a>(
    cx: &'a mut TestAppContext,
    scheme: KeyScheme,
    chapters: &[&[(BlockKind, &str)]],
) -> (Entity<ProseEditor>, &'a mut VisualTestContext) {
    cx.update(|cx| bind_keys_for(scheme, cx));
    let (editor, cx) = editor(cx, chapters);
    cx.update(|window, _| window.activate_window());
    editor.update_in(cx, |editor, window, cx| window.focus(&editor.focus, cx));
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    (editor, cx)
}

#[gpui::test]
fn paragraph_moves(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[&[
            (BlockKind::Body, "一二三"),
            (BlockKind::Body, "四五六"),
            (BlockKind::Body, "七八"),
        ]],
    );
    select(&editor, cx, 0, 5);
    editor.update_in(cx, |editor, window, cx| {
        editor.on_move_to_paragraph_start(&MoveToParagraphStart, window, cx);
        assert_eq!(editor.selection().head, 4);
        // Already at the start: the previous paragraph's start.
        editor.on_move_to_paragraph_start(&MoveToParagraphStart, window, cx);
        assert_eq!(editor.selection().head, 0);
        editor.on_move_to_paragraph_end(&MoveToParagraphEnd, window, cx);
        assert_eq!(editor.selection().head, 3);
        // Already at the end: the next paragraph's end.
        editor.on_move_to_paragraph_end(&MoveToParagraphEnd, window, cx);
        assert_eq!(editor.selection().head, 7);
        editor.on_move_to_next_paragraph(&MoveToNextParagraph, window, cx);
        assert_eq!(editor.selection().head, 8);
        // In the last paragraph: its end.
        editor.on_move_to_next_paragraph(&MoveToNextParagraph, window, cx);
        assert_eq!(editor.selection().head, 10);
        editor.on_select_to_paragraph_start(&SelectToParagraphStart, window, cx);
        assert_eq!(editor.selection().range(), 8..10);
    });
}

#[gpui::test]
fn windows_keys(cx: &mut TestAppContext) {
    let (editor, cx) = keyed_editor(
        cx,
        KeyScheme::Windows,
        &[&[
            (BlockKind::Body, "我们今天去公园。"),
            (BlockKind::Body, "明天下雨天"),
        ]],
    );
    select(&editor, cx, 0, 0);
    cx.simulate_keystrokes("ctrl-right");
    #[cfg(feature = "icu")]
    assert_eq!(head(&editor, cx), 2);
    cx.simulate_keystrokes("end");
    assert_eq!(head(&editor, cx), 8);
    cx.simulate_keystrokes("home");
    assert_eq!(head(&editor, cx), 0);
    cx.simulate_keystrokes("ctrl-down");
    assert_eq!(head(&editor, cx), 9);
    cx.simulate_keystrokes("ctrl-end");
    assert_eq!(head(&editor, cx), 14);
    cx.simulate_keystrokes("ctrl-shift-home");
    assert_eq!(sel_range(&editor, cx), (0, 0..14));
    cx.simulate_keystrokes("ctrl-up");
    assert_eq!(head(&editor, cx), 0);
    // Ctrl+Backspace deletes a word; Ctrl+Z / Ctrl+Y undo and redo.
    select(&editor, cx, 0, 4);
    cx.simulate_keystrokes("ctrl-backspace");
    #[cfg(feature = "icu")]
    assert_eq!(loro_text(&editor, cx, 0), "我们去公园。\n明天下雨天\n");
    cx.simulate_keystrokes("ctrl-z");
    assert_eq!(loro_text(&editor, cx, 0), "我们今天去公园。\n明天下雨天\n");
    cx.simulate_keystrokes("ctrl-y");
    #[cfg(feature = "icu")]
    assert_eq!(loro_text(&editor, cx, 0), "我们去公园。\n明天下雨天\n");
    // Ctrl+B bolds; F3 finds again.
    editor.update_in(cx, |editor, window, cx| editor.select(0, 0..2, window, cx));
    cx.simulate_keystrokes("ctrl-b");
    editor.update(cx, |editor, _| {
        assert!(
            editor.book().chapters[0]
                .doc
                .range_has_mark(0..2, inline::BOLD)
        )
    });
    select(&editor, cx, 0, 0);
    set_find(&editor, cx, "天", FindOptions::default());
    let first = sel_range(&editor, cx);
    cx.simulate_keystrokes("f3");
    assert_ne!(sel_range(&editor, cx), first);
    cx.simulate_keystrokes("shift-f3");
    assert_eq!(sel_range(&editor, cx), first);
}

#[gpui::test]
fn mac_keys_for_paragraphs_and_find(cx: &mut TestAppContext) {
    let (editor, cx) = keyed_editor(
        cx,
        KeyScheme::Mac,
        &[&[(BlockKind::Body, "甲乙"), (BlockKind::Body, "丙丁甲")]],
    );
    select(&editor, cx, 0, 4);
    cx.simulate_keystrokes("alt-up");
    assert_eq!(head(&editor, cx), 3);
    cx.simulate_keystrokes("alt-down");
    assert_eq!(head(&editor, cx), 6);
    cx.simulate_keystrokes("cmd-up");
    assert_eq!(head(&editor, cx), 0);
    set_find(&editor, cx, "甲", FindOptions::default());
    assert_eq!(sel_range(&editor, cx), (0, 0..1));
    cx.simulate_keystrokes("cmd-g");
    assert_eq!(sel_range(&editor, cx), (0, 5..6));
    cx.simulate_keystrokes("cmd-shift-g");
    assert_eq!(sel_range(&editor, cx), (0, 0..1));
}

// ----- F4c: screen readers ------------------------------------------------------------------

#[gpui::test]
fn the_author_typing_is_told_apart(cx: &mut TestAppContext) {
    use std::{cell::RefCell, rc::Rc};
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "开头")]]);
    let typed: Rc<RefCell<Vec<usize>>> = Rc::default();
    cx.update(|_, cx| {
        let typed = typed.clone();
        cx.subscribe(&editor, move |_, e: &crate::AuthorTyped, _| {
            typed.borrow_mut().push(e.chapter)
        })
        .detach();
    });
    let count = |cx: &mut VisualTestContext| {
        cx.run_until_parked();
        typed.borrow().len()
    };
    select(&editor, cx, 0, 2);
    commit(&editor, cx, "字");
    assert_eq!(count(cx), 1, "a typed character");
    // The input method composing is not writing yet; its confirmed text is.
    mark(&editor, cx, "ni");
    assert_eq!(count(cx), 1);
    commit(&editor, cx, "你");
    assert_eq!(count(cx), 2);
    editor.update_in(cx, |e, window, cx| e.press_enter(window, cx));
    assert_eq!(count(cx), 3, "Enter");
    // Not writing: a paste, a deletion, an undo.
    editor.update_in(cx, |e, window, cx| e.paste_text("贴进来", window, cx));
    editor.update_in(cx, |e, window, cx| e.press_backspace(window, cx));
    undo(&editor, cx);
    assert_eq!(count(cx), 3);
    assert_eq!(*typed.borrow(), [0, 0, 0]);
}

mod a11y {
    use accesskit_consumer::Tree;
    use gpui::accesskit::{
        Node, NodeId, Role, TextPosition, TextSelection, Tree as AkTree, TreeId, TreeUpdate,
    };

    use super::*;
    use crate::input::a11y::{RUN_CHARS, RunTarget};

    /// The editor's accessibility subtree as a whole tree, as GPUI would send
    /// it (a window root with the field as its only child), and the run
    /// targets by node id. `rows`: paragraphs laid out in the last frame are
    /// cut by screen rows, as in the app.
    fn ak_tree_with(
        editor: &Entity<ProseEditor>,
        cx: &mut VisualTestContext,
        rows: bool,
    ) -> (Tree, std::collections::HashMap<NodeId, RunTarget>) {
        let (text, frame) =
            editor.update(cx, |editor, _| (editor.a11y_text(), editor.frame.clone()));
        let keys = std::cell::RefCell::new(Vec::new());
        let (runs, selection) = text.assemble(
            |key| {
                let mut keys = keys.borrow_mut();
                if let Some(ix) = keys.iter().position(|k| k == key) {
                    return NodeId(10 + ix as u64);
                }
                keys.push(key.clone());
                NodeId(10 + keys.len() as u64 - 1)
            },
            |para| {
                if rows {
                    crate::input::a11y::rows_of(&frame, para, 1.)
                } else {
                    None
                }
            },
        );
        let mut root = Node::new(Role::Window);
        root.set_children(vec![NodeId(1)]);
        let mut field = Node::new(Role::MultilineTextInput);
        field.set_children(runs.iter().map(|(id, _, _)| *id).collect::<Vec<_>>());
        if let Some(selection) = selection {
            field.set_text_selection(selection);
        }
        let targets = runs.iter().map(|(id, _, target)| (*id, *target)).collect();
        let mut nodes = vec![(NodeId(0), root), (NodeId(1), field)];
        nodes.extend(runs.into_iter().map(|(id, node, _)| (id, node)));
        let update = TreeUpdate {
            nodes,
            tree: Some(AkTree::new(NodeId(0))),
            tree_id: TreeId::ROOT,
            focus: NodeId(1),
        };
        (Tree::new(update, true), targets)
    }

    fn ak_tree(
        editor: &Entity<ProseEditor>,
        cx: &mut VisualTestContext,
    ) -> (Tree, std::collections::HashMap<NodeId, RunTarget>) {
        ak_tree_with(editor, cx, false)
    }

    fn selection16(tree: &Tree) -> std::ops::Range<usize> {
        let state = tree.state();
        let field = state.focus().unwrap();
        let range = field.text_selection().unwrap();
        range.start().to_global_utf16_index()..range.end().to_global_utf16_index()
    }

    #[gpui::test]
    fn screen_readers_read_the_chapter_and_its_selection(cx: &mut TestAppContext) {
        let family = "👨\u{200D}👩\u{200D}👧";
        let first = format!("前{family}后");
        let (editor, cx) = editor(
            cx,
            &[&[
                (BlockKind::H1, "标题"),
                (BlockKind::Body, first.as_str()),
                (BlockKind::Body, ""),
                (BlockKind::Body, "末段"),
            ]],
        );
        editor.update_in(cx, |editor, window, cx| editor.select(0, 3..9, window, cx));
        let (tree, _) = ak_tree(&editor, cx);
        let state = tree.state();
        let field = state.focus().unwrap();
        assert!(field.supports_text_ranges());
        assert_eq!(field.role(), Role::MultilineTextInput);
        let text = format!("标题\n前{family}后\n\n末段");
        assert_eq!(field.document_range().text(), text);
        // 前 and the family: UTF-16 3..12 (the family is 8 units).
        assert_eq!(selection16(&tree), 3..12);
        assert_eq!(
            field.text_selection().unwrap().text(),
            format!("前{family}")
        );
        // Each paragraph is a line.
        let line = |ix| field.line_range_from_index(ix).unwrap().text();
        assert_eq!(line(0), "标题\n");
        assert_eq!(line(2), "\n");
        assert_eq!(line(3), "末段");
        // The family is one character: one step from 前 lands after it.
        let run = field.children().nth(1).unwrap();
        assert_eq!(run.data().character_lengths(), &[3, 18, 3, 1]);
        // A caret at a paragraph's end sits on its line break.
        editor.update_in(cx, |editor, window, cx| editor.select(0, 2..2, window, cx));
        let (tree, _) = ak_tree(&editor, cx);
        let state = tree.state();
        let field = state.focus().unwrap();
        let focus = field.text_selection_focus().unwrap();
        assert_eq!(focus.to_global_utf16_index(), 2);
        assert!(!focus.is_line_start());
    }

    #[gpui::test]
    fn long_paragraphs_are_cut_into_runs_of_one_line(cx: &mut TestAppContext) {
        let long: String = "我们今天去公园看花。".repeat(60);
        let (editor, cx) = editor(cx, &[&[(BlockKind::Body, long.as_str())]]);
        editor.update_in(cx, |editor, window, cx| {
            editor.select(0, 450..450, window, cx)
        });
        let (tree, _) = ak_tree(&editor, cx);
        let state = tree.state();
        let field = state.focus().unwrap();
        let runs: Vec<_> = field.children().collect();
        assert!(runs.len() >= 3, "600 characters need several runs");
        for run in &runs {
            assert!(run.data().character_lengths().len() <= RUN_CHARS + 1);
        }
        assert_eq!(field.document_range().text(), long);
        // All runs make one line: the paragraph.
        assert_eq!(field.line_range_from_index(0).unwrap().text(), long);
        assert!(field.line_range_from_index(1).is_none());
        assert_eq!(selection16(&tree), 450..450);
        #[cfg(feature = "icu")]
        for run in &runs[1..] {
            // Cut where a word starts (每段 begins with 我们).
            let value = run.data().value().unwrap();
            assert!(
                ["我们", "今天", "去", "公园", "看", "花"]
                    .iter()
                    .any(|w| value.starts_with(w)),
                "{value}"
            );
        }
    }

    #[gpui::test]
    fn a_screen_reader_moves_the_caret(cx: &mut TestAppContext) {
        let (editor, cx) = editor(
            cx,
            &[&[(BlockKind::Body, "第一段"), (BlockKind::Body, "第二段文字")]],
        );
        let (_, targets) = ak_tree(&editor, cx);
        // The second paragraph's run, by the id GPUI would have derived.
        let second_id = targets
            .iter()
            .find(|(_, t)| t.line == 1)
            .map(|(id, _)| *id)
            .unwrap();
        let selection = TextSelection {
            anchor: TextPosition {
                node: second_id,
                character_index: 1,
            },
            focus: TextPosition {
                node: second_id,
                character_index: 4,
            },
        };
        editor.update(cx, |editor, cx| {
            editor.a11y_select(&selection, &targets, cx)
        });
        assert_eq!(sel_range(&editor, cx), (0, 5..8));
        // Past the last character of a run: on its line break.
        let caret = TextSelection {
            anchor: TextPosition {
                node: second_id,
                character_index: 5,
            },
            focus: TextPosition {
                node: second_id,
                character_index: 5,
            },
        };
        editor.update(cx, |editor, cx| editor.a11y_select(&caret, &targets, cx));
        assert_eq!(sel_range(&editor, cx), (0, 9..9));
    }

    #[gpui::test]
    fn painted_paragraphs_are_read_row_by_row(cx: &mut TestAppContext) {
        let long: String = "他把吸铁石拍在桌上，说这东西能把河里的铁钉都吸上来。".repeat(4);
        let (editor, cx) = editor(
            cx,
            &[&[(BlockKind::Body, long.as_str()), (BlockKind::Body, "短段")]],
        );
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        let row_texts: Vec<String> = editor.update(cx, |e, _| {
            let frame = e.frame.borrow();
            let painted = frame.prepainted.iter().find(|p| p.line == 0).unwrap();
            painted
                .layout
                .rows
                .iter()
                .map(|r| long[r.clone()].to_string())
                .collect()
        });
        assert!(
            row_texts.len() >= 2,
            "a long paragraph wraps: {row_texts:?}"
        );
        let select = |editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, at: usize| {
            editor.update_in(cx, |e, window, cx| e.select(0, at..at, window, cx));
            cx.run_until_parked();
        };
        // The caret on the second row.
        let second = row_texts[0].chars().count() + 1;
        select(&editor, cx, second);
        let (tree, _) = ak_tree_with(&editor, cx, true);
        let state = tree.state();
        let field = state.focus().unwrap();
        assert_eq!(field.document_range().text(), format!("{long}\n短段"));
        // Each screen row is a line; the paragraph's last row ends with its
        // line break.
        for (ix, row) in row_texts.iter().enumerate() {
            let expected = if ix + 1 == row_texts.len() {
                format!("{row}\n")
            } else {
                row.clone()
            };
            assert_eq!(field.line_range_from_index(ix).unwrap().text(), expected);
        }
        assert_eq!(
            field.text_selection_focus().unwrap().to_line_index(),
            1,
            "the caret is on the second line"
        );
        // Rows carry bounds and every character's position, left to right.
        let first = field.children().next().unwrap();
        let positions = first.data().character_positions().unwrap().to_vec();
        let widths = first.data().character_widths().unwrap().to_vec();
        assert_eq!(positions.len(), first.data().character_lengths().len());
        assert!(positions.windows(2).all(|w| w[0] < w[1]), "{positions:?}");
        assert!(widths.iter().all(|w| *w > 0.));
        assert!(first.data().bounds().is_some());
        // So the caret's character has a frame on screen (a magnifier, the
        // VoiceOver cursor).
        let caret = field.text_selection().unwrap();
        let mut one = caret;
        one.set_end(caret.start().forward_to_character_end());
        let boxes = one.bounding_boxes();
        assert_eq!(boxes.len(), 1, "{boxes:?}");
        assert!(boxes[0].x1 > boxes[0].x0 && boxes[0].y1 > boxes[0].y0);
    }

    #[gpui::test]
    fn test_windows_get_no_system_input_method(cx: &mut TestAppContext) {
        let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "正文")]]);
        mark(&editor, cx, "ni");
        editor.update(cx, |editor, _| assert!(editor.hooks.is_none()));
    }
}

/// Rough costs on a chapter of about 19 000 characters (400 paragraphs), printed:
/// `cargo test --release -p gpui-prose --lib costs_on_a_long_chapter -- --ignored --nocapture`.
#[gpui::test]
#[ignore = "timing, run by hand in release"]
fn costs_on_a_long_chapter(cx: &mut TestAppContext) {
    use std::time::Instant;
    let paragraph =
        "安娜站在窗前，看着雨一点一点地落下来，她想起那年夏天的事情，心里忽然有些说不清的滋味。";
    let texts: Vec<String> = (0..400).map(|i| format!("{i:03}{paragraph}")).collect();
    let paragraphs: Vec<(BlockKind, &str)> = texts
        .iter()
        .map(|t| (BlockKind::Body, t.as_str()))
        .collect();
    let (editor, cx) = editor(cx, &[paragraphs.as_slice()]);
    let chars = editor.update(cx, |e, _| e.book().chapters[0].doc.len_chars());
    let time = |label: &str, f: &mut dyn FnMut()| {
        let runs = 20;
        let start = Instant::now();
        for _ in 0..runs {
            f();
        }
        println!(
            "{label}: {:.3} ms",
            start.elapsed().as_secs_f64() * 1e3 / runs as f64
        );
    };
    println!("chapter: {chars} characters, 400 paragraphs");
    for (label, options) in [
        ("find, default", FindOptions::default()),
        (
            "find, whole word",
            FindOptions {
                whole_word: true,
                ..FindOptions::default()
            },
        ),
    ] {
        time(
            &format!("{label}: cold (query set, every paragraph searched)"),
            &mut || {
                editor.update(cx, |e, cx| {
                    e.clear_find(cx);
                });
                set_find(&editor, cx, "安娜", options.clone());
                editor.update(cx, |e, _| assert_eq!(e.find_matches(0).len(), 400));
            },
        );
        select(&editor, cx, 0, 10);
        time(
            &format!("{label}: typing one character (no find query)"),
            &mut || {
                commit(&editor, cx, "雨");
            },
        );
        let mut spent = std::time::Duration::ZERO;
        time(
            &format!("{label}: typing one character, then matches"),
            &mut || {
                commit(&editor, cx, "雨");
                let start = Instant::now();
                editor.update(cx, |e, _| assert_eq!(e.find_matches(0).len(), 400));
                spent += start.elapsed();
            },
        );
        println!(
            "{label}: of which matches after the edit: {:.3} ms",
            spent.as_secs_f64() * 1e3 / 20.
        );
        time(&format!("{label}: unchanged"), &mut || {
            editor.update(cx, |e, _| assert_eq!(e.find_matches(0).len(), 400));
        });
    }
    time("screen reader text: cold", &mut || {
        editor.update(cx, |e, _| {
            e.input.a11y = Default::default();
            e.a11y_text();
        });
    });
    let mut spent = std::time::Duration::ZERO;
    time(
        "screen reader text: typing one character, then the text",
        &mut || {
            commit(&editor, cx, "雨");
            let start = Instant::now();
            editor.update(cx, |e, _| {
                e.a11y_text();
            });
            spent += start.elapsed();
        },
    );
    println!(
        "screen reader text: of which the text after the edit: {:.3} ms",
        spent.as_secs_f64() * 1e3 / 20.
    );
    let first = editor.update(cx, |e, _| e.book().chapters[0].doc.line(0).text.to_string());
    time("ICU words of the edited paragraph", &mut || {
        crate::text::segment::word_segments(&first);
    });
    time("screen reader text: unchanged", &mut || {
        editor.update(cx, |e, _| {
            e.a11y_text();
        });
    });
}

/// Replace-all and its undo on chapters of n matching paragraphs, printed:
/// `cargo test --release -p gpui-prose --lib replace_all_costs -- --ignored --nocapture`.
#[gpui::test]
#[ignore = "timing, run by hand in release"]
fn replace_all_costs(cx: &mut TestAppContext) {
    use std::time::Instant;
    let paragraph = "安娜站在窗前，看着雨一点一点地落下来，她想起那年夏天的事情。";
    for n in [50usize, 100, 200, 400] {
        let texts: Vec<String> = (0..n).map(|i| format!("{i:03}{paragraph}")).collect();
        let paragraphs: Vec<(BlockKind, &str)> = texts
            .iter()
            .map(|t| (BlockKind::Body, t.as_str()))
            .collect();
        let (editor, cx) = editor(cx, &[paragraphs.as_slice()]);
        let (mut replacing, mut undoing) = (0., 0.);
        let runs = 3;
        for _ in 0..runs {
            select(&editor, cx, 0, 0);
            set_find(&editor, cx, "安娜", FindOptions::default());
            let t = Instant::now();
            let replaced = editor.update_in(cx, |e, window, cx| e.replace_all("小安", window, cx));
            replacing += t.elapsed().as_secs_f64() * 1e3;
            assert_eq!(replaced, n);
            let t = Instant::now();
            undo(&editor, cx);
            undoing += t.elapsed().as_secs_f64() * 1e3;
        }
        println!(
            "replace all, {n} matches: {:.1} ms; its undo: {:.1} ms",
            replacing / runs as f64,
            undoing / runs as f64
        );
        // For comparison: the same replacements as n separate commits (as
        // before batches), undone item by item in the source alone.
        let mut doc = ProseDoc::from_paragraphs(paragraphs.iter().copied());
        let starts: Vec<usize> = (0..n).map(|i| doc.line_start(i) + 3).collect();
        doc.checkpoint();
        for &at in starts.iter().rev() {
            doc.replace(at..at + 2, "小安", crate::text::ORIGIN_USER);
        }
        let t = Instant::now();
        for _ in 0..n {
            doc.source_mut().undo_item();
        }
        println!(
            "  as {n} separate commits, the source's undo alone: {:.1} ms",
            t.elapsed().as_secs_f64() * 1e3
        );
    }
}

mod across;
mod lists;
mod objects;
mod windows_ime;
