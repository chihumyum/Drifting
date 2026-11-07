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
    /// Left inset of the text inside the column (indent plus quote inset).
    pub inset: Pixels,
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
        let mut inset = body_size * (f32::from(indent) * style.indent_step);
        if quote {
            inset += body_size * style.quote_inset;
        }
        BlockLook {
            indent,
            quote,
            quote_above: false,
            quote_below: false,
            align,
            rule,
            inset,
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
