//! The chapter page around its text (`index.css` `.page`, `.page__folio`,
//! `.page__title`, `.page__sub`, `.page__rule`, `.page__ornament`;
//! `chapter-end-menu.css`; `guide.css` `.paper-empty-hints`;
//! `all-chapters.css` `.act-break`). These follow the paper, not the
//! interface's text size; px unless noted.

use std::time::Duration;

/// Above the folio line (the page's top padding).
pub const TOP: f32 = 48.0;
/// Below ⁂ (the page's bottom padding): with the next page's top, the
/// space between chapters in the whole book.
pub const BOTTOM: f32 = 80.0;

/// The folio line 「第 N 章 · 故事线 · 字数」: index type in ink 4.
pub const FOLIO_SIZE: f32 = 9.5;
pub const FOLIO_LINE: f32 = 13.5;
/// Between its items, and between rows when it wraps.
pub const FOLIO_GAP: f32 = 12.0;
pub const FOLIO_ROW_GAP: f32 = 4.0;
/// From the storyline's dash to its name.
pub const FOLIO_MARK_GAP: f32 = 5.0;
/// Under its words, down to its dotted rule; then down to the title.
pub const FOLIO_PAD: f32 = 14.0;
pub const FOLIO_MARGIN: f32 = 28.0;

/// The title: the page's face at 42px on 1.3.
pub const TITLE_SIZE: f32 = 42.0;
pub const TITLE_LINE: f32 = 1.3;
pub const TITLE_GAP: f32 = 10.0;

/// The synopsis: two px under the text's size, on 1.5, ink 3.
pub const SYNOPSIS_LESS: f32 = 2.0;
pub const SYNOPSIS_LINE: f32 = 1.5;
/// Under the synopsis, down to the rule; under the rule, down to the text.
pub const SYNOPSIS_GAP: f32 = 28.0;
pub const RULE_GAP: f32 = 28.0;

/// ⁂ (the brush's three stones): 20px in ink 4, the accent once the chapter
/// is finished.
pub const ORNAMENT: f32 = 20.0;
pub const ORNAMENT_TOP: f32 = 36.0;
pub const ORNAMENT_BOTTOM: f32 = 12.0;
/// What the pointer can rest on around ⁂.
pub const ORNAMENT_TARGET: (f32, f32) = (48.0, 32.0);
/// One row of ⁂'s actions (`--chapter-end-row`).
pub const END_ROW: f32 = 22.0;
/// The pointer moving on ⁂ this long opens its actions, so a page scrolling
/// under a still pointer or a sweep across it never does.
pub const END_INTENT: Duration = Duration::from_millis(70);
/// ⁂ turning into its actions, and back.
pub const END_OPEN: Duration = Duration::from_millis(150);
pub const END_CLOSE: Duration = Duration::from_millis(110);
/// A click this soon after a hover opened the actions was meant for ⁂.
pub const END_CLICK_GUARD: Duration = Duration::from_millis(250);
/// How small ⁂ gets as it gives way (×).
pub const END_SHRINK: f32 = 0.6;

/// The empty page's hint: under where the first line goes, two columns.
pub const HINTS_TOP: f32 = 96.0;
pub const HINTS_COLUMN_GAP: f32 = 40.0;
pub const HINTS_ROW_GAP: f32 = 8.0;

/// An act's title page in the whole book: 「第一幕」 in the structure face,
/// the act's name in the page's face, one dry stroke of the brush, then
/// 「N 章 · x.xk 字」 in the index face.
pub const ACT_TOP: f32 = 120.0;
pub const ACT_BOTTOM: f32 = 112.0;
pub const ACT_ORDINAL_SIZE: f32 = 15.0;
/// Between 「第一幕」 and the name.
pub const ACT_ORDINAL_GAP: f32 = 14.0;
pub const ACT_NAME_SIZE: f32 = 30.0;
pub const ACT_NAME_LINE: f32 = 1.25;
pub const ACT_STROKE: f32 = 180.0;
/// Above the stroke, and above the counts.
pub const ACT_GAP: f32 = 16.0;
pub const ACT_META_SIZE: f32 = 11.5;
pub const ACT_META_LINE: f32 = 16.0;
