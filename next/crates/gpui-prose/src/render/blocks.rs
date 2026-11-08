//! Block styles: quote, indent 0–8, alignment and the rule, from the
//! paragraph attributes on each `\n` (loro-schema v0). H1, H2 and H3 take
//! them exactly like body paragraphs.
//!
//! - **Quote**: the text set in by an inset and washed with a tint, in a
//!   softer ink; adjacent quote paragraphs read as one block (the wash runs
//!   through the space between them). No bar at the left edge (Drifting's
//!   rule: wash, spacing or type, never an inset vertical accent).
//! - **Indent**: the whole paragraph moves right by `level × indent_step`
//!   and wraps narrower (it is a block indent, unlike the first-line indent
//!   of the editor settings).
//! - **Alignment**: each visual row is centred or set right in the column.
//! - **Rule**: an empty paragraph shown as a short centred hairline.
//! - **Lists** (notes; `list`, `list_level`, `checked`, `todo`): one item a
//!   paragraph, set in by `(level + 1) × list_step` with its mark in the
//!   space left of the text, on the first row: a dot (level 0), a ring
//!   (level 1), a small square (level 2, then round again); a number for an
//!   ordered item, counted along the adjacent items of its level (deeper
//!   items do not break the count); a box for a task, ticked when done,
//!   its text then fainter and struck through. A task linked to a TODO
//!   shows the TODO's state (the host's [`crate::ProseExtension::task_done`]),
//!   never a `checked` of its own. Adjacent items sit closer than
//!   paragraphs (`list_gap`, the old note editor's 0.15 em).
//! - **Code blocks** (notes; `code_block`, its language): one line a
//!   paragraph, adjacent code lines read as one block — a
//!   rounded wash of the paper's deeper tone, padded on every side, the
//!   text in the monospace face, smaller and tighter, never indented,
//!   justified or squeezed.
//! - **Callouts** (notes; `callout`, its kind): adjacent paragraphs of one
//!   kind read as one aside — a rounded wash with a faint edge, padded,
//!   paragraphs inside a little closer (no bar at the left edge either).
//!
//! These are layout too: the editor's paragraph metrics
//! ([`crate::ProseEditor::para_metrics`]) take the gaps and pads from here,
//! so the height estimates and the painted paragraphs agree.

use gpui::{Hsla, Pixels, hsla, px};
use loro::LoroValue;

use crate::{schema::block, text::BlockAttrs};

/// How block attributes look. Colours are the host's (Drifting: the paper's
/// deeper tone, the second ink, the rule colour).
#[derive(Clone, Debug, PartialEq)]
pub struct BlockStyle {
    /// One indent level, in ems of the body size.
    pub indent_step: f32,
    /// How far a quote's text is set in, in ems of the body size.
    pub quote_inset: f32,
    /// The quote's wash; `None` for none.
    pub quote_wash: Option<Hsla>,
    /// The quote's text colour (in place of the plain text colour; links
    /// and other coloured words keep theirs). `None`: unchanged.
    pub quote_ink: Option<Hsla>,
    /// The rule's colour.
    pub rule: Hsla,
    /// The rule's share of the column (0–1).
    pub rule_width: f32,
    /// One list level, in ems of the body size.
    pub list_step: f32,
    /// The list marks' colour; `None`: the text colour.
    pub list_ink: Option<Hsla>,
    /// A task box's edge, and its fill when done (the tick is the paper's
    /// colour, `task_tick`).
    pub task_box: Hsla,
    pub task_done: Hsla,
    pub task_tick: Hsla,
    /// A done task's text colour; `None`: unchanged.
    pub task_done_ink: Option<Hsla>,
    /// The gap between adjacent list items, in ems of the body size (in
    /// place of the paragraph spacing).
    pub list_gap: f32,
    /// A code block's wash; `None` for none.
    pub code_wash: Option<Hsla>,
    /// A code block's text colour; `None`: unchanged.
    pub code_ink: Option<Hsla>,
    /// Code's size, as a share of the body size, and its line height.
    pub code_size: f32,
    pub code_line_height: f32,
    /// A code block's padding above and below its text, and left and right
    /// of it, in ems of the body size.
    pub code_pad: f32,
    pub code_inset: f32,
    /// A callout's wash and edge; `None` for none.
    pub callout_wash: Option<Hsla>,
    pub callout_edge: Option<Hsla>,
    /// A callout's padding above and below, and left and right, and the gap
    /// between its paragraphs, in ems of the body size.
    pub callout_pad: f32,
    pub callout_inset: f32,
    pub callout_gap: f32,
    /// The corner of a quote's, a code block's and a callout's wash.
    pub block_radius: Pixels,
}

impl Default for BlockStyle {
    fn default() -> Self {
        BlockStyle {
            indent_step: 2.,
            quote_inset: 1.,
            quote_wash: Some(hsla(40. / 360., 0.25, 0.45, 0.08)),
            quote_ink: Some(hsla(0., 0., 0.3, 1.)),
            rule: hsla(0., 0., 0.45, 0.55),
            rule_width: 0.3,
            list_step: 1.5,
            list_ink: None,
            task_box: hsla(0., 0., 0.45, 0.7),
            task_done: hsla(0.58, 0.6, 0.45, 1.),
            task_tick: hsla(0., 0., 1., 1.),
            task_done_ink: Some(hsla(0., 0., 0.55, 1.)),
            // The old note editor (material-workbench.css) at its 15.5 px:
            // items 0.15 em apart; code 13 px on 1.55, padded 10 / 12 px;
            // callouts padded 10 / 14 px, paragraphs 0.4 em apart.
            list_gap: 0.15,
            code_wash: Some(hsla(40. / 360., 0.2, 0.45, 0.08)),
            code_ink: None,
            code_size: 0.84,
            code_line_height: 1.55,
            code_pad: 0.65,
            code_inset: 0.75,
            callout_wash: Some(hsla(210. / 360., 0.9, 0.55, 0.09)),
            callout_edge: Some(hsla(210. / 360., 0.9, 0.55, 0.18)),
            callout_pad: 0.65,
            callout_inset: 0.9,
            callout_gap: 0.4,
            block_radius: px(4.),
        }
    }
}

/// Horizontal alignment of a paragraph's rows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
}

/// A list item's mark.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListMark {
    Bullet,
    /// Its number in the list.
    Ordered(u32),
    Task {
        done: bool,
    },
}

/// A paragraph that is a list item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListItem {
    pub mark: ListMark,
    /// Nesting level, 0–8.
    pub level: u8,
}

/// What a paragraph's attributes do to its layout and paint.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BlockLook {
    /// Indent level, 0–8.
    pub indent: u8,
    pub quote: bool,
    /// The quote block goes on above / below this paragraph.
    pub quote_above: bool,
    pub quote_below: bool,
    pub align: Align,
    pub rule: bool,
    /// A list item, with its mark.
    pub list: Option<ListItem>,
    /// The paragraph below is a list item too (the gap is `list_gap`).
    pub list_below: bool,
    /// A code line; the code block goes on above / below it.
    pub code: bool,
    pub code_above: bool,
    pub code_below: bool,
    /// In a callout; the callout goes on above / below it.
    pub callout: bool,
    pub callout_above: bool,
    pub callout_below: bool,
    /// Left inset of the text inside the column (indent, a callout's and a
    /// code block's padding, quote inset and list levels).
    pub inset: Pixels,
    /// Right inset of the text (a callout's and a code block's padding).
    pub inset_right: Pixels,
}

impl BlockLook {
    pub fn of(attrs: &BlockAttrs, style: &BlockStyle, body_size: Pixels) -> BlockLook {
        let indent = match attrs.get(block::INDENT) {
            Some(LoroValue::I64(level)) => (*level).clamp(0, 8) as u8,
            Some(LoroValue::Double(level)) => level.clamp(0., 8.) as u8,
            _ => 0,
        };
        let quote = truthy(attrs.get(block::QUOTE));
        let align = match attrs.get(block::ALIGN) {
            Some(LoroValue::String(a)) if a.as_str() == "center" => Align::Center,
            Some(LoroValue::String(a)) if a.as_str() == "right" => Align::Right,
            _ => Align::Left,
        };
        let rule = truthy(attrs.get(block::RULE));
        let list = list_item(attrs);
        let code = code_language(attrs).is_some();
        let callout = callout_kind(attrs).is_some();
        // Outside in: the indent, the callout's padding, the quote, the
        // list's levels, the code block's padding.
        let mut inset = body_size * (f32::from(indent) * style.indent_step);
        let mut inset_right = px(0.);
        if callout {
            inset += body_size * style.callout_inset;
            inset_right += body_size * style.callout_inset;
        }
        if quote {
            inset += body_size * style.quote_inset;
        }
        if let Some(item) = list {
            inset += body_size * (style.list_step * f32::from(item.level + 1));
        }
        if code {
            inset += body_size * style.code_inset;
            inset_right += body_size * style.code_inset;
        }
        BlockLook {
            indent,
            quote,
            quote_above: false,
            quote_below: false,
            align,
            rule,
            list,
            list_below: false,
            code,
            code_above: false,
            code_below: false,
            callout,
            callout_above: false,
            callout_below: false,
            inset,
            inset_right,
        }
    }

    /// Sets the flags that join this paragraph to its neighbours' blocks
    /// (`above` / `below`: the attributes of the paragraphs around it).
    pub(crate) fn join(
        &mut self,
        attrs: &BlockAttrs,
        above: Option<&BlockAttrs>,
        below: Option<&BlockAttrs>,
    ) {
        let quote = |a: Option<&BlockAttrs>| a.is_some_and(|a| truthy(a.get(block::QUOTE)));
        if self.quote {
            self.quote_above = quote(above);
            self.quote_below = quote(below);
        }
        self.list_below = self.list.is_some() && below.and_then(list_item).is_some();
        // Adjacent code lines are one block whatever their language;
        // adjacent callout paragraphs only when of one kind (loro-schema.md).
        if self.code {
            self.code_above = above.and_then(code_language).is_some();
            self.code_below = below.and_then(code_language).is_some();
        }
        if self.callout {
            let kind = callout_kind(attrs);
            self.callout_above = above.and_then(callout_kind) == kind;
            self.callout_below = below.and_then(callout_kind) == kind;
        }
    }

    /// Whether anything differs from a plain paragraph.
    pub fn is_plain(&self) -> bool {
        *self == BlockLook::default()
    }

    /// How far row `row` of width `row_width` moves right in a column of
    /// `wrap` (a hanging mark may make a row wider than the column).
    pub fn row_shift(&self, row_width: Pixels, wrap: Pixels) -> Pixels {
        let room = (wrap - row_width).max(px(0.));
        match self.align {
            Align::Left => px(0.),
            Align::Center => (room / 2.).round(),
            Align::Right => room,
        }
    }
}

/// The list item `attrs` make, if any (`ordered` numbered 1 until the
/// editor counts it; a task's `checked` until a linked TODO says otherwise).
pub(crate) fn list_item(attrs: &BlockAttrs) -> Option<ListItem> {
    let Some(LoroValue::String(kind)) = attrs.get(block::LIST) else {
        return None;
    };
    let mark = match kind.as_str() {
        "bullet" => ListMark::Bullet,
        "ordered" => ListMark::Ordered(1),
        "task" => ListMark::Task {
            done: truthy(attrs.get(block::CHECKED)),
        },
        _ => return None,
    };
    let level = match attrs.get(block::LIST_LEVEL) {
        Some(LoroValue::I64(level)) => (*level).clamp(0, 8) as u8,
        Some(LoroValue::Double(level)) => level.clamp(0., 8.) as u8,
        _ => 0,
    };
    Some(ListItem { mark, level })
}

/// A code line's language (empty when none is named).
pub(crate) fn code_language(attrs: &BlockAttrs) -> Option<&str> {
    match attrs.get(block::CODE_BLOCK) {
        Some(LoroValue::String(lang)) => Some(lang.as_str()),
        _ => None,
    }
}

/// A callout paragraph's kind.
pub(crate) fn callout_kind(attrs: &BlockAttrs) -> Option<&str> {
    match attrs.get(block::CALLOUT) {
        Some(LoroValue::String(kind)) => Some(kind.as_str()),
        _ => None,
    }
}

/// The TODO a task item is linked to.
pub(crate) fn linked_todo(attrs: &BlockAttrs) -> Option<&str> {
    match attrs.get(block::TODO) {
        Some(LoroValue::String(id)) if !id.is_empty() => Some(id.as_str()),
        _ => None,
    }
}

fn truthy(value: Option<&LoroValue>) -> bool {
    match value {
        Some(LoroValue::Bool(b)) => *b,
        Some(LoroValue::Null) | None => false,
        Some(LoroValue::I64(n)) => *n != 0,
        Some(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attrs(pairs: &[(&str, LoroValue)]) -> BlockAttrs {
        let map: Vec<(String, LoroValue)> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        BlockAttrs::from_attributes(map.iter().map(|(k, v)| (k, v)))
    }

    #[test]
    fn attributes_become_a_look() {
        let style = BlockStyle::default();
        let body = px(16.);
        let plain = BlockLook::of(&attrs(&[]), &style, body);
        assert!(plain.is_plain());
        let look = BlockLook::of(
            &attrs(&[
                (block::INDENT, 3i64.into()),
                (block::QUOTE, true.into()),
                (block::ALIGN, "center".into()),
            ]),
            &style,
            body,
        );
        assert_eq!(look.indent, 3);
        assert!(look.quote);
        assert_eq!(look.align, Align::Center);
        // 3 levels of 2 em plus the quote's 1 em.
        assert_eq!(look.inset, px(16. * 7.));
        // Out-of-range levels are clamped, as the schema reads them.
        let deep = BlockLook::of(&attrs(&[(block::INDENT, 12i64.into())]), &style, body);
        assert_eq!(deep.indent, 8);
        let rule = BlockLook::of(&attrs(&[(block::RULE, true.into())]), &style, body);
        assert!(rule.rule);
    }

    #[test]
    fn list_items_are_set_in_by_level() {
        let style = BlockStyle::default();
        let body = px(16.);
        let bullet = BlockLook::of(&attrs(&[(block::LIST, "bullet".into())]), &style, body);
        assert_eq!(
            bullet.list,
            Some(ListItem {
                mark: ListMark::Bullet,
                level: 0
            })
        );
        assert_eq!(bullet.inset, px(16. * 1.5));
        let nested = BlockLook::of(
            &attrs(&[
                (block::LIST, "task".into()),
                (block::LIST_LEVEL, 2i64.into()),
                (block::CHECKED, true.into()),
            ]),
            &style,
            body,
        );
        assert_eq!(nested.list.unwrap().mark, ListMark::Task { done: true });
        assert_eq!(nested.inset, px(16. * 4.5));
        let odd = BlockLook::of(&attrs(&[(block::LIST, "zigzag".into())]), &style, body);
        assert_eq!(odd.list, None);
    }

    #[test]
    fn rows_shift_by_alignment() {
        let mut look = BlockLook::default();
        assert_eq!(look.row_shift(px(100.), px(300.)), px(0.));
        look.align = Align::Center;
        assert_eq!(look.row_shift(px(100.), px(300.)), px(100.));
        look.align = Align::Right;
        assert_eq!(look.row_shift(px(100.), px(300.)), px(200.));
        // A row wider than the column (a hanging mark) does not move left.
        assert_eq!(look.row_shift(px(310.), px(300.)), px(0.));
    }
}
