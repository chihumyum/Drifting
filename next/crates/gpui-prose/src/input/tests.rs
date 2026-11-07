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
