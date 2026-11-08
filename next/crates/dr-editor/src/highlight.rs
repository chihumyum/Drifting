//! A note's highlights (the `highlight` mark, note profile only).
//!
//! The 0.1 client had one highlight, no colours (`@tiptap/extension-highlight`
//! with `multicolor: false`; old marks import with the value `""`), drawn
//! as a dry highlighter swash on every row it runs over
//! (`sand/hl-mark.png`, `hl-mark-dark.png`). Those two pictures are the
//! comment swash (`hl.png`) tinted: light (245, 196, 41) at 0.62, dark
//! (171, 133, 35) at 0.5; so here the swash is dr-ui's `Hl` mask with
//! those tints, laid under the words like a comment's, reaching 0.14 em
//! past them. Any value of the mark is the one highlight; new ones are
//! written as `""`.
//!
//! Applying it: ⌘⇧H ([`ToggleHighlight`]), the slash menu's 高亮, the
//! selection bar in a note, and `==text==` as typed.

use std::ops::Range;
use std::rc::Rc;

use dr_ui::sand::SandMask;
use gpui::{Context, Hsla, Rgba, px};
use gpui_prose::ProseEditor;
use gpui_prose::render::{Decoration, Look, SandTexture, Strength, Wash};
use gpui_prose::text::ProseDoc;
use loro::LoroValue;

/// The mark's key.
pub const KEY: &str = gpui_prose::schema::inline::HIGHLIGHT;
/// The decoration group highlights are drawn in.
pub const GROUP: &str = "highlights";

gpui::actions!(dr_editor, [ToggleHighlight]);

/// ⌘⇧H (Ctrl+Shift+H off macOS) in the editor's key context, for the
/// shell's key registry (the 0.1 note's Mod-Shift-H).
pub fn key_bindings() -> Vec<gpui::KeyBinding> {
    let keys = if cfg!(target_os = "macos") {
        "cmd-shift-h"
    } else {
        "ctrl-shift-h"
    };
    vec![gpui::KeyBinding::new(
        keys,
        ToggleHighlight,
        Some(gpui_prose::input::actions::KEY_CONTEXT),
    )]
}

/// The value new highlights are written with (the one highlight).
pub fn value() -> LoroValue {
    LoroValue::from("")
}

thread_local! {
    static SWASH: Rc<SandTexture> = Rc::new(
        SandTexture::from_png(SandMask::Hl.path(), SandMask::Hl.png())
            .expect("dr-ui's sand masks are PNGs"),
    );
}

fn rgb(r: u8, g: u8, b: u8) -> Hsla {
    Rgba {
        r: f32::from(r) / 255.,
        g: f32::from(g) / 255.,
        b: f32::from(b) / 255.,
        a: 1.,
    }
    .into()
}

/// The highlighter's swash in a light or dark theme, for text of `font_size`.
pub fn wash(dark: bool, font_size: f32) -> Wash {
    let (color, alpha) = if dark {
        (rgb(171, 133, 35), 0.5)
    } else {
        (rgb(245, 196, 41), 0.62)
    };
    let mut wash = Wash::sand(
        SWASH.with(Rc::clone),
        None,
        color,
        Strength::new(alpha, alpha),
    );
    wash.reach = px(font_size * 0.14);
    wash
}

/// The highlighted ranges of `doc` (characters), adjacent runs joined.
pub fn ranges(doc: &ProseDoc) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::new();
    for ix in 0..doc.visible_lines() {
        let line = doc.line(ix);
        let start = doc.line_start(ix);
        for span in line.spans.iter() {
            if span.marks.get(KEY).is_none_or(LoroValue::is_null) {
                continue;
            }
            let range = start + line.char_of_byte(span.range.start)
                ..start + line.char_of_byte(span.range.end);
            match out.last_mut() {
                Some(last) if last.end == range.start => last.end = range.end,
                _ => out.push(range),
            }
        }
    }
    out
}

/// Whether `style`'s paper is dark.
pub fn is_dark(style: &gpui_prose::ProseStyle) -> bool {
    style.background.l < 0.5 && style.background.a > 0.5 || style.text.l > 0.6
}

/// Draws chapter `chapter`'s highlights.
pub fn decorate(editor: &mut ProseEditor, chapter: usize, cx: &mut Context<ProseEditor>) {
    let style = editor.style().clone();
    let wash = wash(is_dark(&style), f32::from(style.body_size));
    let decorations = ranges(&editor.book().chapters[chapter].doc)
        .into_iter()
        .enumerate()
        .map(|(ix, range)| Decoration::new(format!("h{ix}"), range, Look::Wash(wash.clone())))
        .collect();
    editor.set_decorations(chapter, GROUP, decorations, cx);
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_prose::BlockKind;

    #[test]
    fn highlighted_runs_are_found_and_joined() {
        let mut doc =
            ProseDoc::from_paragraphs([(BlockKind::Body, "甲乙丙丁"), (BlockKind::Body, "戊己")]);
        doc.mark(1..2, KEY, value(), "seed");
        doc.mark(2..3, KEY, "yellow".into(), "seed");
        doc.mark(5..7, KEY, value(), "seed");
        doc.drain();
        assert_eq!(ranges(&doc), vec![1..3, 5..7]);
    }
}
