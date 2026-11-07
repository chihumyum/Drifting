//! Screen readers (VoiceOver, Narrator, Orca) through GPUI's AccessKit tree.
//!
//! The editor's root element is a multi-line text field
//! ([`Role::MultilineTextInput`], labelled with the chapter title) whose
//! children are the text of the selection's chapter as AccessKit text runs,
//! and whose text selection is the editor's. AccessKit's platform adapters
//! turn that into the system's text protocol (on macOS `AXTextArea` with
//! `AXSelectedTextRange`, `AXStringForRange`, line ranges …) and announce
//! selection changes, so a screen reader reads the chapter, follows the
//! caret and the selection, and can move the caret itself
//! ([`Action::SetTextSelection`]).
//!
//! How text is cut into runs:
//!
//! - AccessKit's characters are what the caret steps over: grapheme
//!   clusters (👨‍👩‍👧 is one), each with its UTF-8 length.
//! - **A paragraph laid out this frame is one run per screen row**, each its
//!   own line, with the row's bounds and every character's position and
//!   width (from the paragraph's layout: indent, alignment, squeezing and
//!   justification included), so a screen reader reads line by line as the
//!   author sees them and a magnifier or the VoiceOver cursor frames the
//!   character. The rows are recorded while the paragraphs prepaint, which
//!   GPUI does before it asks the editor for its accessibility children.
//! - A paragraph off screen has no rows yet: it is runs of at most
//!   [`RUN_CHARS`] characters (AccessKit stores word starts as bytes),
//!   cut at word starts where possible and linked with `next_on_line`, so
//!   it reads as one line, without positions.
//! - Every paragraph but the chapter's last ends with its line break, as one
//!   character; a caret at a paragraph's end sits on that break.
//! - Word starts are the editor's own words (ICU; Chinese by dictionary), so
//!   reading by word agrees with ⌥← / ⌥→.
//!
//! What is not there: the marked text of an input-method composition (screen
//! readers hear the input method itself; that paragraph is exposed by
//! chunks while it lasts), and the other chapters' parts of a selection
//! across chapters (the part in the caret's chapter is there).
//!
//! Only built while a screen reader is connected ([`Window::is_a11y_active`]);
//! paragraphs that did not change reuse their runs. While one is connected
//! the editor is drawn uncached ([`editor_view`]): GPUI v1.27 drops the
//! accessibility nodes of a cached view on frames that reuse it.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ops::Range,
    rc::{Rc, Weak},
};

use gpui::{
    A11ySubtreeBuilder, App, Context, Entity, ParentElement as _, Pixels, SharedString, Stateful,
    StatefulInteractiveElement, StyleRefinement, Styled as _, Window,
    accesskit::{
        Action, ActionData, Node, NodeId, Rect, Role, TextDirection, TextPosition, TextSelection,
    },
    div,
};

use super::Selection;
use crate::{
    ProseEditor,
    render::{FrameCache, PaintedLine},
    text::{ProseDoc, segment},
};

/// Characters per text run at most (AccessKit's word starts are `u8`).
pub const RUN_CHARS: usize = 200;

// ----- one paragraph -------------------------------------------------------------------

/// A paragraph cut into AccessKit characters and runs.
#[derive(Debug, PartialEq)]
pub struct ParagraphRuns {
    /// Each character's start, in scalars of the paragraph.
    pub starts: Vec<usize>,
    /// Each character's UTF-8 length.
    pub lengths: Vec<u8>,
    /// Each character's start byte.
    bytes: Vec<usize>,
    /// The runs, as character ranges.
    pub runs: Vec<Range<usize>>,
    /// Characters where a word starts.
    words: Vec<usize>,
}

impl ParagraphRuns {
    pub fn new(text: &str) -> ParagraphRuns {
        let mut starts = Vec::new();
        let mut lengths = Vec::new();
        let mut bytes = Vec::new();
        let boundaries = segment::grapheme_boundaries(text);
        let mut scalar = 0;
        for pair in boundaries.windows(2) {
            let (mut from, to) = (pair[0], pair[1]);
            // A cluster longer than a byte can count (stacked combining
            // marks) becomes several characters, cut between scalars.
            while from < to {
                let mut end = to.min(from + u8::MAX as usize);
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                starts.push(scalar);
                bytes.push(from);
                lengths.push((end - from) as u8);
                scalar += text[from..end].chars().count();
                from = end;
            }
        }
        let words: Vec<usize> = segment::word_segments(text)
            .into_iter()
            .filter(|s| s.word)
            .filter_map(|s| bytes.binary_search(&s.range.start).ok())
            .collect();
        let mut runs = Vec::new();
        let mut at = 0;
        let n = starts.len();
        while at < n || runs.is_empty() {
            let mut end = (at + RUN_CHARS).min(n);
            if end < n {
                // Cut where a word starts, if one does in the second half.
                let floor = at + RUN_CHARS / 2;
                if let Some(&w) = words.iter().rev().find(|&&w| w > floor && w <= end) {
                    end = w;
                }
            }
            runs.push(at..end);
            at = end;
            if n == 0 {
                break;
            }
        }
        ParagraphRuns {
            starts,
            lengths,
            bytes,
            runs,
            words,
        }
    }

    /// The character at scalar offset `inner` of the paragraph (its count of
    /// characters at the paragraph's end).
    pub fn char_at(&self, inner: usize) -> usize {
        self.starts.partition_point(|&s| s < inner)
    }

    /// The AccessKit node for characters `range` of a paragraph with text
    /// `text`; `newline`: the run ends with the paragraph's line break.
    fn node(&self, text: &str, range: Range<usize>, newline: bool) -> Node {
        let byte_start = self.byte_of(range.start, text);
        let byte_end = self.byte_of(range.end, text);
        let mut value = text[byte_start..byte_end].to_owned();
        let mut lengths = self.lengths[range.clone()].to_vec();
        if newline {
            value.push('\n');
            lengths.push(1);
        }
        let words: Vec<u8> = self
            .words
            .iter()
            .filter(|&&w| w >= range.start && w < range.end)
            .map(|&w| (w - range.start) as u8)
            .collect();
        let mut node = Node::new(Role::TextRun);
        node.set_value(value);
        node.set_character_lengths(lengths);
        node.set_word_starts(words);
        node
    }

    /// The byte where character `ch` starts (the text end past the last).
    fn byte_of(&self, ch: usize, text: &str) -> usize {
        self.bytes.get(ch).copied().unwrap_or(text.len())
    }

    /// The characters of each screen row, cut further where a row is longer
    /// than [`RUN_CHARS`].
    fn row_ranges(&self, layout: &crate::layout::ProseLayout) -> Vec<(usize, Range<usize>)> {
        let mut out = Vec::new();
        for (row, bytes) in layout.rows.iter().enumerate() {
            let start = self.bytes.partition_point(|&b| b < bytes.start);
            let end = self.bytes.partition_point(|&b| b < bytes.end);
            let mut at = start;
            loop {
                let to = (at + RUN_CHARS).min(end);
                out.push((row, at..to));
                at = to;
                if at >= end {
                    break;
                }
            }
        }
        out
    }
}

// ----- the chapter ---------------------------------------------------------------------

/// What one run stands for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RunTarget {
    pub chapter: usize,
    pub line: usize,
    /// The run's first character in the paragraph.
    pub first: usize,
}

/// What a run's node id is derived from.
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub enum RunKey {
    Block(usize, String, usize),
    Line(usize, usize, usize),
}

/// One paragraph of the chapter, ready to be cut into runs.
#[derive(Clone, Debug)]
pub struct A11yParagraph {
    pub chapter: usize,
    pub line: usize,
    /// The mirror's revision, to match the paragraph's layout this frame.
    pub rev: u64,
    /// Its block id, when unique in the chapter (stable node ids).
    pub bid: Option<String>,
    pub text: SharedString,
    pub runs: Rc<ParagraphRuns>,
    /// Ends with a line break (every paragraph but the chapter's last).
    pub newline: bool,
}

/// How a paragraph was laid out this frame, for runs by screen row.
pub struct RowsOf {
    pub painted: PaintedLine,
    /// Window pixels to the platform's (AccessKit's bounds are physical).
    pub scale: f32,
}

/// One run as built, before node ids.
struct Built {
    key: RunKey,
    node: Node,
    target: RunTarget,
    /// The next run is on the same line (a chunked paragraph).
    continues: bool,
    /// Characters of the paragraph it holds.
    chars: Range<usize>,
    paragraph: usize,
}

/// The chapter as screen readers see it: its paragraphs and the selection
/// as (paragraph, character) pairs.
#[derive(Debug, Default)]
pub struct A11yText {
    pub label: String,
    pub paragraphs: Vec<A11yParagraph>,
    pub anchor: Option<(usize, usize)>,
    pub focus: Option<(usize, usize)>,
}

impl A11yText {
    /// The runs as nodes with their ids (from `id_of`) and what they stand
    /// for, and the selection in those ids. `rows_of` gives a paragraph's
    /// layout this frame, if it has one: its runs are then its screen rows.
    pub fn assemble(
        self,
        id_of: impl Fn(&RunKey) -> NodeId,
        rows_of: impl Fn(&A11yParagraph) -> Option<RowsOf>,
    ) -> (Vec<(NodeId, Node, RunTarget)>, Option<TextSelection>) {
        let mut built: Vec<Built> = Vec::new();
        for (p, para) in self.paragraphs.iter().enumerate() {
            let key = |run: usize| match &para.bid {
                Some(bid) => RunKey::Block(para.chapter, bid.clone(), run),
                None => RunKey::Line(para.chapter, para.line, run),
            };
            let target = |first: usize| RunTarget {
                chapter: para.chapter,
                line: para.line,
                first,
            };
            match rows_of(para) {
                Some(rows) => {
                    let layout = &rows.painted.layout;
                    let ranges = para.runs.row_ranges(layout);
                    let last = ranges.len() - 1;
                    for (ix, (row, chars)) in ranges.into_iter().enumerate() {
                        let newline = para.newline && ix == last;
                        let mut node = para.runs.node(&para.text, chars.clone(), newline);
                        place(&mut node, &para.runs, &para.text, row, chars.clone(), &rows);
                        built.push(Built {
                            key: key(ix),
                            node,
                            target: target(chars.start),
                            continues: false,
                            chars,
                            paragraph: p,
                        });
                    }
                }
                None => {
                    let count = para.runs.runs.len();
                    for (ix, chars) in para.runs.runs.iter().enumerate() {
                        let newline = para.newline && ix + 1 == count;
                        built.push(Built {
                            key: key(ix),
                            node: para.runs.node(&para.text, chars.clone(), newline),
                            target: target(chars.start),
                            continues: ix + 1 < count,
                            chars: chars.clone(),
                            paragraph: p,
                        });
                    }
                }
            }
        }
        let ids: Vec<NodeId> = built.iter().map(|run| id_of(&run.key)).collect();
        // (paragraph, character) → (run, index in it): the run holding the
        // character, or the paragraph's last run at its end.
        let position = |(p, ch): (usize, usize)| {
            let first = built.partition_point(|b| b.paragraph < p);
            let end = built.partition_point(|b| b.paragraph <= p);
            let run = (first..end)
                .find(|&r| ch < built[r].chars.end)
                .unwrap_or(end.saturating_sub(1).max(first));
            TextPosition {
                node: ids[run],
                character_index: ch.saturating_sub(built[run].chars.start),
            }
        };
        let selection = self
            .anchor
            .zip(self.focus)
            .filter(|_| !built.is_empty())
            .map(|(anchor, focus)| TextSelection {
                anchor: position(anchor),
                focus: position(focus),
            });
        let mut nodes = Vec::with_capacity(built.len());
        let mut previous_continues = false;
        for (ix, run) in built.into_iter().enumerate() {
            let mut node = run.node;
            if run.continues {
                node.set_next_on_line(ids[ix + 1]);
            }
            if previous_continues {
                node.set_previous_on_line(ids[ix - 1]);
            }
            previous_continues = run.continues;
            nodes.push((ids[ix], node, run.target));
        }
        (nodes, selection)
    }
}

/// Gives a run on screen row `row` its bounds and each character's position
/// and width, in platform pixels, relative to the run's left edge.
fn place(
    node: &mut Node,
    runs: &ParagraphRuns,
    text: &str,
    row: usize,
    chars: Range<usize>,
    rows: &RowsOf,
) {
    let painted = &rows.painted;
    let layout = &painted.layout;
    let scale = rows.scale;
    let x_of = |ch: usize| layout.x_at(row, runs.byte_of(ch, text));
    let left = x_of(chars.start);
    let right = layout.x_at(row, layout.rows[row].end).max(x_of(chars.end));
    let top = painted.origin.y + painted.line_height * row as f32;
    let at = |x: Pixels| f64::from(f32::from(painted.origin.x + x) * scale);
    node.set_bounds(Rect {
        x0: at(left),
        y0: f64::from(f32::from(top) * scale),
        x1: at(right),
        y1: f64::from(f32::from(top + painted.line_height) * scale),
    });
    let mut positions = Vec::with_capacity(chars.len() + 1);
    let mut widths = Vec::with_capacity(chars.len() + 1);
    for ch in chars.clone() {
        let x = x_of(ch);
        let next = if ch + 1 < chars.end {
            x_of(ch + 1)
        } else {
            layout.x_at(row, runs.byte_of(ch + 1, text).min(layout.rows[row].end))
        };
        positions.push(f32::from(x - left) * scale);
        widths.push(f32::from((next - x).max(gpui::px(0.))) * scale);
    }
    if node.character_lengths().len() > chars.len() {
        // The line break: where an end-of-paragraph mark would go, no width.
        positions.push(f32::from(right - left) * scale);
        widths.push(0.);
    }
    node.set_character_positions(positions);
    node.set_character_widths(widths);
    // Positions mean nothing to AccessKit without a direction.
    node.set_text_direction(TextDirection::LeftToRight);
}

/// Paragraph runs cached by paragraph text (by content: GPUI's
/// `SharedString` keeps short strings inline, so addresses say nothing).
#[derive(Default)]
struct RunCache {
    paragraphs: HashMap<gpui::SharedString, Rc<ParagraphRuns>>,
}

/// The screen-reader state in the editor.
#[derive(Default)]
pub(crate) struct A11yState {
    /// A screen reader was connected at the last render.
    pub live: Cell<bool>,
    cache: RefCell<RunCache>,
    /// Node ids of the last tree's runs, for [`Action::SetTextSelection`].
    targets: Rc<RefCell<HashMap<NodeId, RunTarget>>>,
}

impl ProseEditor {
    /// The selection's chapter as screen readers see it.
    pub fn a11y_text(&self) -> A11yText {
        let chapter = self.selection.chapter;
        let doc = &self.book.chapters[chapter].doc;
        let mut cache = self.input.a11y.cache.borrow_mut();
        let mut fresh = HashMap::with_capacity(cache.paragraphs.len());
        let visible = doc.visible_lines();
        let mut text = A11yText {
            label: self.book.chapters[chapter].title.to_string(),
            ..A11yText::default()
        };
        // A block id seen twice (before the source repairs it) must not give
        // two runs one node id.
        let mut bids = std::collections::HashSet::with_capacity(visible);
        for (ix, line) in doc.lines()[..visible].iter().enumerate() {
            let bid = line.block.bid().filter(|bid| bids.insert(*bid));
            let runs = match fresh.get(&line.text) {
                Some(runs) => Rc::clone(runs),
                None => {
                    let runs = cache
                        .paragraphs
                        .remove(&line.text)
                        .unwrap_or_else(|| Rc::new(ParagraphRuns::new(&line.text)));
                    fresh.insert(line.text.clone(), Rc::clone(&runs));
                    runs
                }
            };
            text.paragraphs.push(A11yParagraph {
                chapter,
                line: ix,
                rev: line.rev,
                bid: bid.map(String::from),
                text: line.text.clone(),
                runs,
                newline: ix + 1 < visible,
            });
        }
        cache.paragraphs = fresh;
        let position = |offset: usize| {
            let (line, inner) = doc.locate(offset);
            let line = line.min(visible.saturating_sub(1));
            (line, text.paragraphs[line].runs.char_at(inner))
        };
        let sel = self.selection;
        // A selection across chapters shows as its part in this chapter: the
        // anchor at the chapter's start or end.
        let anchor = match sel.anchor_chapter.cmp(&chapter) {
            std::cmp::Ordering::Equal => sel.anchor,
            std::cmp::Ordering::Less => 0,
            std::cmp::Ordering::Greater => doc.max_cursor(),
        };
        let (anchor, focus) = (position(anchor), position(sel.head));
        text.anchor = Some(anchor);
        text.focus = Some(focus);
        text
    }

    /// Moves the selection where a screen reader asks.
    pub(crate) fn a11y_select(
        &mut self,
        selection: &TextSelection,
        targets: &HashMap<NodeId, RunTarget>,
        cx: &mut Context<Self>,
    ) {
        let (Some(anchor), Some(focus)) = (
            targets.get(&selection.anchor.node),
            targets.get(&selection.focus.node),
        ) else {
            return;
        };
        if anchor.chapter != focus.chapter || self.composition.is_some() {
            return;
        }
        let a = self.a11y_offset(anchor, selection.anchor.character_index);
        let f = self.a11y_offset(focus, selection.focus.character_index);
        self.set_selection(Selection::new(anchor.chapter, a, f), cx);
    }

    /// The chapter offset of character `index` of a run.
    fn a11y_offset(&self, target: &RunTarget, index: usize) -> usize {
        let doc = &self.book.chapters[target.chapter].doc;
        let line = target.line.min(doc.visible_lines().saturating_sub(1));
        let text = &doc.line(line).text;
        let ch = target.first + index;
        let runs = ParagraphRuns::new(text);
        offset_of(doc, line, &runs, ch)
    }

    /// Adds the field's role, label, runs, selection and caret action to the
    /// editor's root element while a screen reader is connected.
    pub(crate) fn input_layer(
        &mut self,
        root: Stateful<gpui::Div>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        let root = self.register_input_actions(root, cx);
        // This frame's paragraphs record their rows again in prepaint.
        self.frame.borrow_mut().prepainted.clear();
        let live = window.is_a11y_active();
        self.input.a11y.live.set(live);
        if !live {
            return root;
        }
        let text = self.a11y_text();
        let label = text.label.clone();
        let frame = Rc::clone(&self.frame);
        let scale = window.scale_factor();
        let targets = Rc::clone(&self.input.a11y.targets);
        let weak_targets: Weak<RefCell<HashMap<NodeId, RunTarget>>> = Rc::downgrade(&targets);
        let editor = cx.entity().downgrade();
        root.role(Role::MultilineTextInput)
            .aria_label(label)
            .a11y_synthetic_children(move |builder: &mut A11ySubtreeBuilder| {
                let (nodes, selection) = text.assemble(
                    |key| builder.synthetic_node_id(key),
                    |para| rows_of(&frame, para, scale),
                );
                let mut map = HashMap::with_capacity(nodes.len());
                for (id, node, target) in nodes {
                    if builder.push_child(id, node) {
                        map.insert(id, target);
                    }
                }
                if let Some(selection) = selection {
                    builder.parent_node().set_text_selection(selection);
                }
                *targets.borrow_mut() = map;
            })
            .on_a11y_action(
                Action::SetTextSelection,
                move |data, _window, cx: &mut App| {
                    let Some(ActionData::SetTextSelection(selection)) = data else {
                        return;
                    };
                    let Some(targets) = weak_targets.upgrade() else {
                        return;
                    };
                    let targets = targets.borrow().clone();
                    editor
                        .update(cx, |editor, cx| editor.a11y_select(selection, &targets, cx))
                        .ok();
                },
            )
    }
}

/// The layout `para` got this frame (recorded in prepaint), if it has one
/// that shows the paragraph's own text (not an input method's marked text).
pub(crate) fn rows_of(
    frame: &Rc<RefCell<FrameCache>>,
    para: &A11yParagraph,
    scale: f32,
) -> Option<RowsOf> {
    let frame = frame.borrow();
    let painted = frame
        .prepainted
        .iter()
        .rev()
        .find(|p| p.chapter == para.chapter && p.line == para.line)?;
    (painted.rev == para.rev && painted.comp.is_none()).then(|| RowsOf {
        painted: painted.clone(),
        scale,
    })
}

/// The chapter offset of character `ch` of paragraph `line`.
fn offset_of(doc: &ProseDoc, line: usize, runs: &ParagraphRuns, ch: usize) -> usize {
    let start = doc.line_start(line);
    let chars = doc.line(line).chars;
    match runs.starts.get(ch) {
        Some(&inner) => start + inner,
        // On the line break, or past it (the next paragraph's start).
        None if ch == runs.starts.len() => start + chars,
        None => (start + chars + 1).min(doc.max_cursor()),
    }
}

/// The editor as a view element: cached (replayed untouched when nothing in
/// it changed) unless a screen reader was connected at its last render.
/// GPUI v1.27 builds accessibility nodes only while prepainting, and a
/// cached view that is replayed is not prepainted, so its nodes would drop
/// out of the tree on every frame something else redraws (the caret
/// blinking); drawn uncached, the text field stays in the tree. A GPUI patch
/// that replays a cached view's nodes would make this unnecessary (G7 in the
/// F4 patch ledger).
pub fn editor_view(editor: &Entity<ProseEditor>, cx: &App) -> gpui::AnyElement {
    use gpui::IntoElement as _;
    if editor.read(cx).input.a11y.live.get() {
        div().size_full().child(editor.clone()).into_any_element()
    } else {
        editor
            .clone()
            .cached(StyleRefinement::default().size_full())
            .into_any_element()
    }
}
