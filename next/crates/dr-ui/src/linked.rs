//! Short text with entry links (RL, `kernel-v5.md` §19, 「描述和批注里的
//! 链接」): a relation's description, a comment's words.
//!
//! - [`linked`]: the text read-only, wrapped by the writing rules like
//!   [`crate::text::wrapped`]. A link looks like an entity link in the
//!   prose: the accent's words over a dry sand underline (`ul.png`, 0.7,
//!   0.95 under the pointer). A press on it opens what it links to
//!   ([`LinkedText::on_open`]) and goes no further: the card under it does
//!   not take the press.
//! - [`LinkedArea`]: the same text being edited, in F5's multi-line input.
//!   The links ride along as the words around them change; typing inside
//!   one undoes it. `@` followed by a few letters opens a list of entries at
//!   the `@` (its owner says which, [`Candidates`]); picking one (a press,
//!   or Enter for the first) puts the entry's name there as a link. Esc
//!   closes the list first.
//!
//! Positions here are UTF-8 byte offsets; [`Draft::from_chars`] and
//! [`Draft::char_links`] convert from and to the Unicode scalar offsets the
//! book stores (`dr_model::v3::LinkedText`).

use std::{cell::Cell, ops::Range, rc::Rc};

use gpui::{
    App, AppContext as _, AvailableSpace, Bounds, Context, CursorStyle, DispatchPhase, ElementId,
    Entity, EventEmitter, FocusHandle, Focusable, GlobalElementId, Hitbox, HitboxBehavior,
    InspectorElementId, InteractiveElement as _, IntoElement, LayoutId, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Render, ScrollHandle,
    SharedString, StatefulInteractiveElement as _, Style, Styled as _, Subscription, TextAlign,
    TextRun, Window, div, point, prelude::FluentBuilder as _, px, relative, size,
};
use prose_linebreak as linebreak;

use crate::{
    components::{Layer, Menu, MenuItem, Place, RowIcon, float},
    input::{
        FieldEvent, TextArea,
        area::{Down, Newline, Up},
        field::{Cancel, Submit},
    },
    sand::{self, SandMask},
    text::{Paragraph, shape},
    theme::Theme,
};

/// One link: a byte range of the text and what it opens (an entry's id).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    pub range: Range<usize>,
    pub target: SharedString,
}

/// Text and its links: byte ranges in order, never overlapping, each on
/// character boundaries.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Draft {
    pub text: String,
    pub links: Vec<Link>,
}

impl Draft {
    pub fn new(text: impl Into<String>, links: Vec<Link>) -> Draft {
        let text = text.into();
        let mut links: Vec<Link> = links
            .into_iter()
            .filter(|l| {
                l.range.start < l.range.end
                    && l.range.end <= text.len()
                    && text.is_char_boundary(l.range.start)
                    && text.is_char_boundary(l.range.end)
            })
            .collect();
        links.sort_by_key(|l| l.range.start);
        let mut after = 0;
        links.retain(|l| {
            let ok = l.range.start >= after;
            if ok {
                after = l.range.end;
            }
            ok
        });
        Draft { text, links }
    }

    /// Plain text, no links.
    pub fn plain(text: impl Into<String>) -> Draft {
        Draft::new(text, Vec::new())
    }

    /// From Unicode scalar offsets (`start`, `end`, target), as the book
    /// stores them. Ranges past the text are dropped.
    pub fn from_chars(
        text: impl Into<String>,
        links: impl IntoIterator<Item = (usize, usize, SharedString)>,
    ) -> Draft {
        let text = text.into();
        let byte = byte_offsets(&text);
        let links = links
            .into_iter()
            .filter_map(|(start, end, target)| {
                Some(Link {
                    range: *byte.get(start)?..*byte.get(end)?,
                    target,
                })
            })
            .collect();
        Draft::new(text, links)
    }

    /// The links as Unicode scalar offsets (`start`, `end`, target).
    pub fn char_links(&self) -> Vec<(usize, usize, SharedString)> {
        self.links
            .iter()
            .map(|l| {
                (
                    self.text[..l.range.start].chars().count(),
                    self.text[..l.range.end].chars().count(),
                    l.target.clone(),
                )
            })
            .collect()
    }

    /// The text became `text` by one edit (typing, deleting, pasting over a
    /// selection): links before the change stay, links after it move with
    /// the words, a link the change touches inside is undone.
    pub fn changed(&mut self, text: &str) {
        self.changed_at(text, None);
    }

    /// [`Draft::changed`], knowing the caret ends up at `cursor` in `text`
    /// (the end of what was typed or pasted). With it, typing right before
    /// a link moves the link even when the typed letters are the link's own
    /// first ones (阿 before 阿Q).
    pub fn changed_at(&mut self, text: &str, cursor: Option<usize>) {
        if self.text == text {
            return;
        }
        let old = self.text.as_str();
        let common = |cap: usize| {
            let mut p = old
                .bytes()
                .zip(text.bytes())
                .take(cap)
                .take_while(|(a, b)| a == b)
                .count();
            while !old.is_char_boundary(p) || !text.is_char_boundary(p) {
                p -= 1;
            }
            p
        };
        // The edit ends at the caret when the words after the caret are the
        // words that were after the edit.
        let at_caret = cursor.and_then(|c| {
            let old_end = (c + old.len()).checked_sub(text.len())?;
            (c <= text.len()
                && text.is_char_boundary(c)
                && old.is_char_boundary(old_end)
                && text[c..] == old[old_end..])
                .then_some((old_end, c))
        });
        let (p, old_end, new_end) = match at_caret {
            Some((old_end, new_end)) => (common(old_end.min(new_end)), old_end, new_end),
            None => {
                let p = common(usize::MAX);
                let room = old.len().min(text.len()) - p;
                let mut s = old
                    .bytes()
                    .rev()
                    .zip(text.bytes().rev())
                    .take(room)
                    .take_while(|(a, b)| a == b)
                    .count();
                while !old.is_char_boundary(old.len() - s) || !text.is_char_boundary(text.len() - s)
                {
                    s -= 1;
                }
                (p, old.len() - s, text.len() - s)
            }
        };
        let links = std::mem::take(&mut self.links);
        self.links = links
            .into_iter()
            .filter_map(|l| {
                if l.range.end <= p {
                    Some(l)
                } else if l.range.start >= old_end {
                    let shift = |at: usize| at - old_end + new_end;
                    Some(Link {
                        range: shift(l.range.start)..shift(l.range.end),
                        target: l.target,
                    })
                } else {
                    None
                }
            })
            .collect();
        self.text = text.to_owned();
    }

    /// The `@` and the letters after it that end at `cursor`, if the caret
    /// is right after such a run (no space or second `@` in it) and the `@`
    /// is not inside a link: its range (the `@` included) and the letters.
    pub fn at_query(&self, cursor: usize) -> Option<(Range<usize>, String)> {
        let cursor = cursor.min(self.text.len());
        if !self.text.is_char_boundary(cursor) {
            return None;
        }
        let before = &self.text[..cursor];
        let (at, sign) = before
            .char_indices()
            .rev()
            .find(|(_, c)| *c == '@' || *c == '＠' || c.is_whitespace())?;
        if sign.is_whitespace() {
            return None;
        }
        if self
            .links
            .iter()
            .any(|l| l.range.start <= at && at < l.range.end)
        {
            return None;
        }
        let query = before[at + sign.len_utf8()..].to_owned();
        Some((at..cursor, query))
    }

    /// Puts `label` over `range` as a link to `target`; links the range
    /// touches go, links after it move. Returns where the caret goes (right
    /// after the link).
    pub fn insert_link(
        &mut self,
        range: Range<usize>,
        label: &str,
        target: impl Into<SharedString>,
    ) -> usize {
        let end = range.start + label.len();
        let links = std::mem::take(&mut self.links);
        let mut out: Vec<Link> = links
            .into_iter()
            .filter_map(|l| {
                if l.range.end <= range.start {
                    Some(l)
                } else if l.range.start >= range.end {
                    Some(Link {
                        range: l.range.start - range.end + end..l.range.end - range.end + end,
                        target: l.target,
                    })
                } else {
                    None
                }
            })
            .collect();
        self.text.replace_range(range.clone(), label);
        if !label.is_empty() {
            out.push(Link {
                range: range.start..end,
                target: target.into(),
            });
        }
        out.sort_by_key(|l| l.range.start);
        self.links = out;
        end
    }
}

/// Byte offset of each character, and the text's length after the last.
fn byte_offsets(text: &str) -> Vec<usize> {
    text.char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(text.len()))
        .collect()
}

/// What a press on a link does with its target.
pub type OnOpen = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

/// Text with links, read-only; see the module notes.
pub fn linked(id: impl Into<ElementId>, draft: Draft) -> LinkedText {
    LinkedText {
        id: id.into(),
        text: draft.text.into(),
        links: draft.links,
        on_open: None,
    }
}

pub struct LinkedText {
    id: ElementId,
    text: SharedString,
    links: Vec<Link>,
    on_open: Option<OnOpen>,
}

impl LinkedText {
    /// What a press on a link opens.
    pub fn on_open(mut self, f: impl Fn(&SharedString, &mut Window, &mut App) + 'static) -> Self {
        self.on_open = Some(Rc::new(f));
        self
    }
}

impl IntoElement for LinkedText {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

/// A link's stretch on one row, in window coordinates.
struct Segment {
    link: usize,
    /// The sand stroke under it.
    stroke: Bounds<Pixels>,
}

/// What [`LinkedText`] paints.
pub struct LinkedRows {
    rows: Vec<(gpui::ShapedLine, Pixels)>,
    segments: Vec<(Segment, Hitbox)>,
    line_height: Pixels,
}

/// Which link the pointer is on and which one a press began on.
#[derive(Default)]
struct PointerState {
    hovered: Cell<Option<usize>>,
    pressed: Cell<Option<usize>>,
}

/// The text's runs: the style in force, the links in `link`.
fn runs(text: &str, links: &[Link], base: &TextRun, link: gpui::Hsla) -> Vec<TextRun> {
    let mut out = Vec::new();
    let mut at = 0;
    for l in links {
        if l.range.start > at {
            out.push(TextRun {
                len: l.range.start - at,
                ..base.clone()
            });
        }
        out.push(TextRun {
            len: l.range.len(),
            color: link,
            ..base.clone()
        });
        at = l.range.end;
    }
    if text.len() > at || out.is_empty() {
        out.push(TextRun {
            len: text.len() - at,
            ..base.clone()
        });
    }
    out
}

/// Where a link's stroke sits under a row: 7 px high, its middle 4 px
/// below the baseline (gpui-prose's entity underline).
fn stroke_under(
    para: &Paragraph,
    x0: Pixels,
    x1: Pixels,
    row_top: Pixels,
    lh: Pixels,
) -> Bounds<Pixels> {
    let (ascent, descent) = (para.line.ascent, para.line.descent);
    let baseline = row_top + (lh - (ascent + descent)) / 2.0 + ascent;
    Bounds::new(
        point(x0 - px(1.0), baseline + px(0.5)),
        size(x1 - x0 + px(2.0), px(7.0)),
    )
}

impl gpui::Element for LinkedText {
    type RequestLayoutState = ();
    type PrepaintState = LinkedRows;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let style = window.text_style();
        let font_size = style.font_size.to_pixels(window.rem_size());
        let line_height = window.pixel_snap(window.line_height());
        let accent = Theme::of(window, cx).palette.accent.solid();
        let text = self.text.clone();
        let runs = runs(&text, &self.links, &style.to_run(text.len()), accent);
        let mut layout_style = Style::default();
        layout_style.size.width = relative(1.).into();
        let id =
            window.request_measured_layout(layout_style, move |known, available, window, _| {
                let wrap = known.width.or(match available.width {
                    AvailableSpace::Definite(w) => Some(w),
                    _ => None,
                });
                let paragraphs = shape(
                    &text,
                    &runs,
                    font_size,
                    wrap,
                    linebreak::Overflow::Hang,
                    window,
                );
                let rows: usize = paragraphs.iter().map(|p| p.breaks.len()).sum();
                let width = wrap.unwrap_or_else(|| {
                    paragraphs
                        .iter()
                        .map(|p| p.line.width())
                        .fold(px(0.0), |a, b| a.max(b))
                });
                size(width, line_height * rows.max(1) as f32)
            });
        (id, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> LinkedRows {
        let style = window.text_style();
        let font_size = style.font_size.to_pixels(window.rem_size());
        let line_height = window.pixel_snap(window.line_height());
        let accent = Theme::of(window, cx).palette.accent.solid();
        let runs = runs(
            &self.text,
            &self.links,
            &style.to_run(self.text.len()),
            accent,
        );
        let paragraphs = shape(
            &self.text,
            &runs,
            font_size,
            Some(bounds.size.width),
            linebreak::Overflow::Hang,
            window,
        );
        let mut rows = Vec::new();
        let mut segments = Vec::new();
        let mut y = px(0.0);
        for para in &paragraphs {
            let mut cursor = para.line.cursor();
            for (range, x0) in &para.breaks {
                let (row_start, row_end) = (para.start + range.start, para.start + range.end);
                for (ix, link) in self.links.iter().enumerate() {
                    let (a, b) = (link.range.start.max(row_start), link.range.end.min(row_end));
                    if a >= b {
                        continue;
                    }
                    let xa = para.line.x_for_index(a - para.start) - *x0;
                    let xb = para.line.x_for_index(b - para.start) - *x0;
                    let top = bounds.origin.y + y;
                    let left = bounds.origin.x;
                    let seg = Bounds::new(point(left + xa, top), size(xb - xa, line_height));
                    let stroke = stroke_under(para, left + xa, left + xb, top, line_height);
                    let hitbox = window.insert_hitbox(seg, HitboxBehavior::Normal);
                    segments.push((Segment { link: ix, stroke }, hitbox));
                }
                rows.push((cursor.take_until(range.end), y));
                y += line_height;
            }
        }
        LinkedRows {
            rows,
            segments,
            line_height,
        }
    }

    fn paint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut LinkedRows,
        window: &mut Window,
        cx: &mut App,
    ) {
        let p = Theme::of(window, cx).palette;
        let state = window.with_element_state(
            global_id.expect("a linked text has an id"),
            |s: Option<Rc<PointerState>>, _| {
                let s = s.unwrap_or_default();
                (s.clone(), s)
            },
        );
        for (piece, y) in prepaint.rows.drain(..) {
            let _ = piece.paint(
                point(bounds.origin.x, bounds.origin.y + y),
                prepaint.line_height,
                TextAlign::Left,
                None,
                window,
                cx,
            );
        }
        let hovered = prepaint
            .segments
            .iter()
            .find(|(_, h)| h.is_hovered(window))
            .map(|(s, _)| s.link);
        state.hovered.set(hovered);
        for (seg, hitbox) in &prepaint.segments {
            let strength = if hovered == Some(seg.link) { 0.95 } else { 0.7 };
            sand::paint_mask(
                SandMask::Ul,
                seg.stroke,
                p.accent.alpha(strength),
                window,
                cx,
            );
            window.set_cursor_style(CursorStyle::PointingHand, hitbox);
        }
        if prepaint.segments.is_empty() {
            return;
        }
        let hits: Rc<Vec<(usize, Hitbox)>> = Rc::new(
            prepaint
                .segments
                .iter()
                .map(|(s, h)| (s.link, h.clone()))
                .collect(),
        );
        let under = move |window: &Window| {
            hits.iter()
                .find(|(_, h)| h.is_hovered(window))
                .map(|(l, _)| *l)
        };
        {
            let (under, state) = (under.clone(), state.clone());
            window.on_mouse_event(move |_: &MouseMoveEvent, phase, window, _| {
                if phase == DispatchPhase::Bubble && under(window) != state.hovered.get() {
                    window.refresh();
                }
            });
        }
        {
            let (under, state) = (under.clone(), state.clone());
            window.on_mouse_event(move |e: &MouseDownEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble
                    && e.button == MouseButton::Left
                    && let Some(link) = under(window)
                {
                    state.pressed.set(Some(link));
                    cx.stop_propagation();
                }
            });
        }
        let targets: Vec<SharedString> = self.links.iter().map(|l| l.target.clone()).collect();
        let on_open = self.on_open.clone();
        window.on_mouse_event(move |e: &MouseUpEvent, phase, window, cx| {
            if phase != DispatchPhase::Bubble || e.button != MouseButton::Left {
                return;
            }
            let Some(pressed) = state.pressed.take() else {
                return;
            };
            if under(window) == Some(pressed)
                && let (Some(open), Some(target)) = (&on_open, targets.get(pressed))
            {
                cx.stop_propagation();
                open(target, window, cx);
            }
        });
    }
}

/// One entry the `@` list offers.
#[derive(Clone, Debug, PartialEq)]
pub struct AtItem {
    pub target: SharedString,
    pub label: SharedString,
    /// A faint word at the row's end (the entry's template).
    pub detail: Option<SharedString>,
    pub mark: sand::Kind,
}

/// The entries the `@` list offers for the letters typed after `@` (all of
/// them for none), best first; the list scrolls after seven rows.
pub type Candidates = Rc<dyn Fn(&str, &App) -> Vec<AtItem>>;

/// How many rows the `@` list shows.
pub const AT_ROWS: usize = 7;

/// What a [`LinkedArea`] says to its owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkedEvent {
    /// Enter (in a field that submits on Enter) or ⌘↵.
    Submitted,
    /// Esc with no `@` list open.
    Cancelled,
    /// The caret left the field.
    Blurred,
}

/// An `@` being typed: where it is and the entries it offers.
struct At {
    range: Range<usize>,
    items: Vec<AtItem>,
    selected: usize,
    scroll: ScrollHandle,
}

/// F5's multi-line input with links; see the module notes.
pub struct LinkedArea {
    id: ElementId,
    area: Entity<TextArea>,
    draft: Draft,
    candidates: Candidates,
    at: Option<At>,
    _area: Subscription,
}

impl EventEmitter<LinkedEvent> for LinkedArea {}

impl Focusable for LinkedArea {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.area.read(cx).focus_handle(cx)
    }
}

impl LinkedArea {
    /// `area` builds the input (its placeholder, whether Enter submits);
    /// `draft` is the text it starts with.
    pub fn new(
        id: impl Into<ElementId>,
        draft: Draft,
        candidates: Candidates,
        area: impl FnOnce(TextArea) -> TextArea,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> LinkedArea {
        let id: ElementId = id.into();
        let field_id = crate::style::child_id(&id, "area");
        let text = draft.text.clone();
        let links: Vec<Range<usize>> = draft.links.iter().map(|l| l.range.clone()).collect();
        let area = cx.new(|cx| {
            let mut a = area(TextArea::new(field_id, window, cx).with_text(text));
            a.set_links(links, cx);
            a
        });
        let sub = cx.subscribe_in(&area, window, |this, _, e: &FieldEvent, window, cx| {
            match e {
                FieldEvent::Changed(text) => this.changed(text, window, cx),
                FieldEvent::Submitted(text) => {
                    this.changed(text, window, cx);
                    this.at = None;
                    cx.emit(LinkedEvent::Submitted);
                }
                FieldEvent::Cancelled => cx.emit(LinkedEvent::Cancelled),
                FieldEvent::Blurred => {
                    this.at = None;
                    cx.emit(LinkedEvent::Blurred);
                }
            }
            cx.notify();
        });
        // The input's own text is the source: it may have cleaned newlines.
        let mut draft = draft;
        let cleaned = area.read(cx).text();
        draft.changed(&cleaned);
        LinkedArea {
            id,
            area,
            draft,
            candidates,
            at: None,
            _area: sub,
        }
    }

    /// The text and its links now.
    pub fn draft(&self) -> &Draft {
        &self.draft
    }

    /// Replaces the words while retaining links outside the changed range.
    pub fn set_text(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        let text = text.into();
        self.draft.changed(&text);
        self.at = None;
        self.area.update(cx, |a, cx| a.set_text(text, cx));
        self.push_links(cx);
        cx.notify();
    }

    pub fn text(&self) -> String {
        self.draft.text.clone()
    }

    pub fn set_disabled(&mut self, disabled: bool, cx: &mut Context<Self>) {
        if disabled {
            self.at = None;
        }
        self.area.update(cx, |a, cx| a.set_disabled(disabled, cx));
        cx.notify();
    }

    pub fn area(&self) -> &Entity<TextArea> {
        &self.area
    }

    /// The entries the open `@` list shows (none when it is closed).
    pub fn at_items(&self) -> Vec<AtItem> {
        self.at
            .as_ref()
            .map(|a| a.items.clone())
            .unwrap_or_default()
    }

    /// Puts the caret in the field, at the end.
    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        let handle = self.area.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
    }

    fn changed(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let area = self.area.read(cx);
        // The caret in the committed text (no composition when this is heard).
        let cursor = (!area.is_composing()).then(|| area.composer().cursor());
        self.draft.changed_at(text, cursor);
        self.push_links(cx);
        let committed_cursor = cursor.unwrap_or(self.draft.text.len());
        self.at = self
            .draft
            .at_query(committed_cursor)
            .map(|(range, query)| At {
                range,
                items: (self.candidates)(&query, cx),
                selected: 0,
                scroll: ScrollHandle::new(),
            })
            .filter(|a| !a.items.is_empty());
        let _ = window;
    }

    fn push_links(&self, cx: &mut Context<Self>) {
        let links = self.draft.links.iter().map(|l| l.range.clone()).collect();
        self.area.update(cx, |a, cx| a.set_links(links, cx));
    }

    /// Puts `item` where the `@` is, as a link.
    pub fn pick(&mut self, item: &AtItem, window: &mut Window, cx: &mut Context<Self>) {
        let Some(at) = self.at.take() else {
            return;
        };
        let mut next = self.draft.clone();
        let caret = next.insert_link(at.range.clone(), &item.label, item.target.clone());
        self.draft = next;
        let label = item.label.to_string();
        self.area.update(cx, |a, cx| {
            a.replace_committed(at.range.clone(), &label, window, cx);
            a.move_caret(caret, cx);
        });
        self.push_links(cx);
        cx.notify();
    }

    fn pick_first(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.area.read(cx).is_composing() {
            return false;
        }
        let Some(first) = self
            .at
            .as_ref()
            .and_then(|a| a.items.get(a.selected).cloned())
        else {
            return false;
        };
        self.pick(&first, window, cx);
        true
    }

    fn move_choice(&mut self, next: bool, cx: &mut Context<Self>) {
        let Some(at) = &mut self.at else {
            return;
        };
        if self.area.read(cx).is_composing() {
            return;
        }
        at.selected = if next {
            (at.selected + 1).min(at.items.len().saturating_sub(1))
        } else {
            at.selected.saturating_sub(1)
        };
        at.scroll.scroll_to_item(at.selected);
        cx.stop_propagation();
        cx.notify();
    }
}

impl Render for LinkedArea {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let list = self.at.as_ref().map(|at| {
            let rect = self
                .area
                .read(cx)
                .offset_bounds(at.range.start)
                .unwrap_or_default();
            let mut rows = div()
                .id(crate::style::child_id(&self.id, "at-scroll"))
                .max_h(px(Theme::of(window, cx).scale.menu_row * AT_ROWS as f32))
                .overflow_y_scroll()
                .track_scroll(&at.scroll);
            for (ix, item) in at.items.iter().enumerate() {
                let picked = item.clone();
                let row = MenuItem::new(
                    crate::style::child_id(&self.id, format!("at-{ix}")),
                    RowIcon::Mark(item.mark, None),
                    item.label.clone(),
                )
                .current(at.selected == ix)
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.pick(&picked, window, cx);
                    this.focus(window, cx);
                }));
                rows = rows.child(match &item.detail {
                    Some(d) => row.trailing(d.clone()),
                    None => row,
                });
            }
            let menu = Menu::new(crate::style::child_id(&self.id, "at"))
                .exactly(220.0)
                .child(rows);
            float(Place::below(rect, 4.0), Layer::Popover, menu)
        });
        let _ = window;
        div()
            .id(self.id.clone())
            .w_full()
            .capture_action(cx.listener(|this, _: &Up, _, cx| this.move_choice(false, cx)))
            .capture_action(cx.listener(|this, _: &Down, _, cx| this.move_choice(true, cx)))
            .capture_action(cx.listener(|this, _: &Newline, window, cx| {
                if this.pick_first(window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &Submit, window, cx| {
                if this.at.is_some() && this.pick_first(window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &Cancel, _, cx| {
                if this.area.read(cx).is_composing() {
                    return;
                }
                if this.at.take().is_some() {
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            .child(self.area.clone())
            .when_some(list, |d, list| d.child(list))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(range: Range<usize>, target: &str) -> Link {
        Link {
            range,
            target: target.to_owned().into(),
        }
    }

    #[test]
    fn links_ride_along_with_the_words_around_them() {
        // 「打过阿Q的人」: 阿Q is bytes 6..10.
        let mut d = Draft::new("打过阿Q的人", vec![link(6..10, "aq")]);
        d.changed("他打过阿Q的人");
        assert_eq!(d.links, vec![link(9..13, "aq")]);
        d.changed("他打过阿Q的人们");
        assert_eq!(d.links, vec![link(9..13, "aq")]);
        // Typing right after a link keeps it whole; typing inside undoes it.
        d.changed("他打过阿QQ的人们");
        assert_eq!(d.links, vec![link(9..13, "aq")]);
        d.changed("他打过阿xQQ的人们");
        assert!(d.links.is_empty());
    }

    #[test]
    fn the_caret_tells_typing_before_a_link_from_typing_inside_it() {
        // 阿 typed before 阿Q: without the caret the change looks like it
        // went between 阿 and Q.
        let mut d = Draft::new("阿Q", vec![link(0..4, "aq")]);
        d.changed_at("阿阿Q", Some(3));
        assert_eq!(d.links, vec![link(3..7, "aq")]);
        let mut d = Draft::new("阿Q", vec![link(0..4, "aq")]);
        d.changed_at("阿阿Q", Some(6));
        assert!(d.links.is_empty(), "typed inside");
        // Deleting before a link moves it back.
        let mut d = Draft::new("x阿Q", vec![link(1..5, "aq")]);
        d.changed_at("阿Q", Some(0));
        assert_eq!(d.links, vec![link(0..4, "aq")]);
        // A caret that does not fit the change falls back to the words.
        let mut d = Draft::new("x阿Q", vec![link(1..5, "aq")]);
        d.changed_at("阿Q", Some(2));
        assert_eq!(d.links, vec![link(0..4, "aq")]);
    }

    #[test]
    fn deleting_a_link_s_words_removes_the_link() {
        let mut d = Draft::new("a王胡b", vec![link(1..7, "wh")]);
        d.changed("ab");
        assert!(d.links.is_empty());
        assert_eq!(d.text, "ab");
    }

    #[test]
    fn chars_and_bytes_convert_both_ways() {
        let d = Draft::from_chars("多半落在阿Q头上", [(4, 6, SharedString::from("aq"))]);
        assert_eq!(&d.text[d.links[0].range.clone()], "阿Q");
        assert_eq!(d.char_links(), vec![(4, 6, SharedString::from("aq"))]);
        // A range past the text is dropped, not clamped.
        let d = Draft::from_chars("短", [(0, 9, SharedString::from("x"))]);
        assert!(d.links.is_empty());
    }

    #[test]
    fn an_at_and_its_letters_before_the_caret() {
        let d = Draft::plain("写给 @小");
        assert_eq!(d.at_query(d.text.len()), Some((7..11, "小".to_owned())));
        let d = Draft::plain("写给 ＠");
        assert_eq!(d.at_query(d.text.len()), Some((7..10, String::new())));
        // A space ends it; an @ inside a link is not one.
        assert_eq!(Draft::plain("@小 尼").at_query(10), None);
        let d = Draft::new("a@b", vec![link(0..3, "x")]);
        assert_eq!(d.at_query(3), None);
    }

    #[test]
    fn a_picked_entry_replaces_the_at_as_a_link() {
        let mut d = Draft::new("王胡 和 @小", vec![link(0..6, "wh")]);
        let caret = d.insert_link(11..15, "小尼姑", "xn");
        assert_eq!(d.text, "王胡 和 小尼姑");
        assert_eq!(caret, d.text.len());
        assert_eq!(d.links, vec![link(0..6, "wh"), link(11..20, "xn")]);
    }
}
