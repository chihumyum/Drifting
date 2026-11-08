//! The caret around embeds: selected as one thing, stepped over, deleted
//! whole, never typed over; the host may take the caret inside; a host's
//! own commits join the undo history.

use std::{cell::Cell, rc::Rc};

use gpui::{
    AnyElement, App, Entity, IntoElement, Styled, TestAppContext, VisualTestContext, Window, div,
    px,
};

use super::*;
use crate::embeds::EmbedViews;

/// Draws every embed as a 40 px box; takes the caret on ↑ ↓ when `take`.
struct Boxes {
    take: bool,
    entered: Rc<Cell<Option<bool>>>,
}

impl EmbedViews for Boxes {
    fn view(&self, _: usize, _: &str, _: bool, _: &mut Window, _: &mut App) -> Option<AnyElement> {
        Some(div().h(px(40.)).into_any_element())
    }

    fn enter(&self, _: usize, _: &str, from_below: bool, _: &mut Window, _: &mut App) -> bool {
        if self.take {
            self.entered.set(Some(from_below));
        }
        self.take
    }
}

/// `paragraphs`, where `"\u{FFFC}"` is an embed (`e<line>`), in a focused
/// editor that draws embeds.
fn with_embeds<'a>(
    cx: &'a mut TestAppContext,
    paragraphs: &[&str],
    take: bool,
) -> (
    Entity<ProseEditor>,
    &'a mut VisualTestContext,
    Rc<Cell<Option<bool>>>,
) {
    let texts: Vec<(BlockKind, &str)> = paragraphs.iter().map(|t| (BlockKind::Body, *t)).collect();
    let (editor, cx) = keyed_editor(cx, KeyScheme::Mac, &[&texts]);
    let entered = Rc::new(Cell::new(None));
    editor.update(cx, |e, cx| {
        let doc = &mut e.book_mut().chapters[0].doc;
        for (line, text) in paragraphs.iter().enumerate() {
            if *text == "\u{FFFC}" {
                let at = doc.line_start(line);
                doc.mark(at..at + 1, inline::EMBED, format!("e{line}").into(), "seed");
            }
        }
        e.refresh_chapter(0, cx);
        e.set_embed_views(
            Some(Rc::new(Boxes {
                take,
                entered: entered.clone(),
            })),
            cx,
        );
    });
    cx.run_until_parked();
    (editor, cx, entered)
}

fn texts(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> Vec<String> {
    editor.update(cx, |e, _| {
        let doc = &e.book().chapters[0].doc;
        (0..doc.visible_lines())
            .map(|l| doc.line(l).text.to_string())
            .collect()
    })
}

fn selected(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> Option<usize> {
    editor.update(cx, |e, _| e.selected_embed().map(|(_, line)| line))
}

fn range(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> std::ops::Range<usize> {
    editor.update(cx, |e, _| e.selection().range())
}

const OBJ: &str = "\u{FFFC}";

#[gpui::test]
fn a_caret_on_an_embed_selects_it_and_arrows_step_over(cx: &mut TestAppContext) {
    // 前 = 0..1, its newline 1; the embed 2, its newline 3; 后 = 4..5.
    let (editor, cx, _) = with_embeds(cx, &["前", OBJ, "后"], false);
    assert_eq!(
        editor.update(cx, |e, _| e.embed_at(0, 1)),
        Some(("e1".into(), 2))
    );
    select(&editor, cx, 0, 1);
    cx.simulate_keystrokes("right");
    assert_eq!(
        selected(&editor, cx),
        Some(1),
        "→ onto the embed selects it"
    );
    assert_eq!(range(&editor, cx), 2..3);
    cx.simulate_keystrokes("right");
    assert_eq!(range(&editor, cx), 4..4, "→ again: the start of 后");
    cx.simulate_keystrokes("left");
    assert_eq!(selected(&editor, cx), Some(1));
    cx.simulate_keystrokes("left");
    assert_eq!(range(&editor, cx), 1..1, "← again: the end of 前");
    // ↓ from 前 without a host that takes the caret: selected.
    cx.simulate_keystrokes("down");
    assert_eq!(selected(&editor, cx), Some(1));
    cx.simulate_keystrokes("down");
    assert_eq!(range(&editor, cx), 4..4);
}

#[gpui::test]
fn backspace_after_an_embed_selects_it_then_deletes_it(cx: &mut TestAppContext) {
    let (editor, cx, _) = with_embeds(cx, &["前", OBJ, "后"], false);
    select(&editor, cx, 0, 4);
    cx.simulate_keystrokes("backspace");
    assert_eq!(texts(&editor, cx), ["前", OBJ, "后"], "nothing joined");
    assert_eq!(selected(&editor, cx), Some(1));
    cx.simulate_keystrokes("backspace");
    assert_eq!(texts(&editor, cx), ["前", "后"]);
    assert_eq!(range(&editor, cx), 2..2, "the caret at the start of 后");
    undo(&editor, cx);
    assert_eq!(texts(&editor, cx), ["前", OBJ, "后"]);
    assert_eq!(
        editor.update(cx, |e, _| e.embed_at(0, 1)),
        Some(("e1".into(), 2)),
        "the undo brings the embed back with its id"
    );
    // Delete at the end of 前: selects it too.
    select(&editor, cx, 0, 1);
    cx.simulate_keystrokes("delete");
    assert_eq!(selected(&editor, cx), Some(1));
    assert_eq!(texts(&editor, cx), ["前", OBJ, "后"]);
}

#[gpui::test]
fn an_empty_paragraph_next_to_an_embed_goes_first(cx: &mut TestAppContext) {
    let (editor, cx, _) = with_embeds(cx, &["前", OBJ, "", "后"], false);
    // The empty paragraph starts at 4.
    select(&editor, cx, 0, 4);
    cx.simulate_keystrokes("backspace");
    assert_eq!(texts(&editor, cx), ["前", OBJ, "后"]);
    assert_eq!(selected(&editor, cx), Some(1));
}

#[gpui::test]
fn the_last_paragraph_after_an_embed_stays(cx: &mut TestAppContext) {
    // Its newline is never deleted: Backspace only selects.
    let (editor, cx, _) = with_embeds(cx, &["前", OBJ, ""], false);
    select(&editor, cx, 0, 4);
    cx.simulate_keystrokes("backspace");
    assert_eq!(texts(&editor, cx), ["前", OBJ, ""]);
    assert_eq!(selected(&editor, cx), Some(1));
}

#[gpui::test]
fn enter_and_typing_on_a_selected_embed_go_after_it(cx: &mut TestAppContext) {
    let (editor, cx, _) = with_embeds(cx, &["前", OBJ, "后"], false);
    editor.update_in(cx, |e, window, cx| e.select_embed(0, 1, window, cx));
    cx.simulate_keystrokes("enter");
    assert_eq!(texts(&editor, cx), ["前", OBJ, "", "后"]);
    assert_eq!(range(&editor, cx), 4..4);
    undo(&editor, cx);
    assert_eq!(texts(&editor, cx), ["前", OBJ, "后"]);
    editor.update_in(cx, |e, window, cx| e.select_embed(0, 1, window, cx));
    commit(&editor, cx, "字");
    assert_eq!(
        texts(&editor, cx),
        ["前", OBJ, "字", "后"],
        "never typed over"
    );
    // An input method composes after it as well.
    editor.update_in(cx, |e, window, cx| e.select_embed(0, 1, window, cx));
    mark(&editor, cx, "zi");
    commit(&editor, cx, "子");
    assert_eq!(texts(&editor, cx), ["前", OBJ, "子", "字", "后"]);
}

#[gpui::test]
fn arrows_offer_the_host_the_caret(cx: &mut TestAppContext) {
    let (editor, cx, entered) = with_embeds(cx, &["前", OBJ, "后"], true);
    select(&editor, cx, 0, 0);
    cx.simulate_keystrokes("down");
    assert_eq!(entered.get(), Some(false), "↓ from above");
    assert_eq!(
        range(&editor, cx),
        0..0,
        "the host took it; the editor's caret stays"
    );
    select(&editor, cx, 0, 4);
    cx.simulate_keystrokes("up");
    assert_eq!(entered.get(), Some(true), "↑ from below");
}

#[gpui::test]
fn a_hosts_commits_join_the_undo_history(cx: &mut TestAppContext) {
    let (editor, cx, _) = with_embeds(cx, &["前", OBJ, "后"], false);
    select(&editor, cx, 0, 1);
    commit(&editor, cx, "文");
    // The host writes the embed's contents in the same document.
    let loro = editor.update(cx, |e, _| {
        e.book().chapters[0]
            .doc
            .loro_source()
            .unwrap()
            .loro()
            .clone()
    });
    loro.get_map("embeds").insert("e1", "格").unwrap();
    loro.set_next_commit_origin("user");
    loro.commit();
    editor.update(cx, |e, _| e.record_host_items(0, 1, true));
    undo(&editor, cx);
    assert!(
        loro.get_map("embeds").get("e1").is_none(),
        "the host's step goes first"
    );
    assert_eq!(texts(&editor, cx), ["前文", OBJ, "后"]);
    undo(&editor, cx);
    assert_eq!(texts(&editor, cx), ["前", OBJ, "后"]);
}
