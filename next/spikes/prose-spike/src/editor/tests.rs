//! Editor behaviour with GPUI's deterministic test platform. The input method
//! is driven the way macOS drives it: through the `EntityInputHandler` calls
//! that `setMarkedText:`, `insertText:` and `unmarkText` turn into.

use gpui::{Entity, EntityInputHandler, TestAppContext, VisualTestContext};

use super::*;
use crate::book::Chapter;

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
        editor.book().chapters[chapter].doc.text().to_string()
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
    editor.update_in(cx, |editor, window, cx| editor.undo(&Undo, window, cx));
}

#[gpui::test]
fn marked_text_stays_out_of_loro_until_confirmed(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "正文第一段")]]);
    editor.update_in(cx, |editor, window, cx| editor.select(0, 2..2, window, cx));
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
    editor.update_in(cx, |editor, window, cx| editor.select(0, 2..2, window, cx));
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
    editor.update_in(cx, |editor, window, cx| editor.select(0, 3..3, window, cx));
    mark(&editor, cx, "wu");
    editor.update(cx, |editor, cx| {
        editor.agent_write(0, 0..0, "【补】", "s1", cx)
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
    editor.update_in(cx, |editor, window, cx| editor.select(0, 1..1, window, cx));
    commit(&editor, cx, "甲");
    editor.update_in(cx, |editor, window, cx| editor.select(1, 1..1, window, cx));
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
    editor.update_in(cx, |editor, window, cx| editor.select(0, 2..2, window, cx));
    let update = editor.update(cx, |editor, _| {
        let doc = editor.book().chapters[0].doc.loro();
        let remote = loro::LoroDoc::new();
        remote
            .import(&doc.export(loro::ExportMode::Snapshot).unwrap())
            .unwrap();
        let from = remote.oplog_vv();
        remote
            .get_text(crate::doc::TEXT_KEY)
            .insert(0, "远端")
            .unwrap();
        remote.commit();
        remote.export(loro::ExportMode::updates(&from)).unwrap()
    });
    editor.update(cx, |editor, cx| editor.import_remote(0, &update, cx));
    assert_eq!(loro_text(&editor, cx, 0), "远端甲乙\n");
    editor.update(cx, |editor, _| assert_eq!(editor.selection().head, 4));
}
