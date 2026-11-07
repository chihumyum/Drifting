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
//! - A run holds at most [`RUN_CHARS`] characters, because AccessKit stores
//!   word starts as bytes (`u8`): a long paragraph is several runs, cut at
//!   word starts where possible and linked with `next_on_line` /
//!   `previous_on_line`, so to a screen reader **one paragraph is one
//!   line** (the editor's own soft wrapping is not exposed).
//! - Every paragraph but the chapter's last ends with its line break, as one
//!   character; a caret at a paragraph's end sits on that break.
//! - Word starts are the editor's own words (ICU; Chinese by dictionary), so
//!   reading by word agrees with ⌥← / ⌥→.
//!
//! What is not there yet: per-character screen positions (so a magnifier or
//! the VoiceOver cursor frames the whole field, not the character), the
//! marked text of an input-method composition (screen readers hear the
//! input method itself), and selections across chapters.
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
    A11ySubtreeBuilder, App, Context, Entity, ParentElement as _, Stateful,
    StatefulInteractiveElement, StyleRefinement, Styled as _, Window,
    accesskit::{Action, ActionData, Node, NodeId, Role, TextPosition, TextSelection},
    div,
};

use super::Selection;
use crate::{
    ProseEditor,
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

    /// The run holding character `ch` and its index there; `newline` says
    /// whether the paragraph's last run ends with its line break.
    fn locate(&self, ch: usize) -> (usize, usize) {
        let run = self
            .runs
            .iter()
            .position(|r| ch < r.end)
            .unwrap_or(self.runs.len() - 1);
        (run, ch - self.runs[run].start)
    }

    /// The AccessKit node of run `run` of a paragraph with text `text`.
    fn node(&self, text: &str, run: usize, newline: bool) -> Node {
        let range = self.runs[run].clone();
        let last = run + 1 == self.runs.len();
        let byte_start = self.bytes.get(range.start).copied().unwrap_or(text.len());
        let byte_end = self.bytes.get(range.end).copied().unwrap_or(text.len());
        let mut value = text[byte_start..byte_end].to_owned();
        let mut lengths = self.lengths[range.clone()].to_vec();
        if last && newline {
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

/// A run with what it stands for and its link to the next run of the same
/// paragraph.
#[derive(Debug)]
pub struct A11yRun {
    /// Stable across edits while the paragraph keeps its block id.
    pub key: RunKey,
    pub node: Node,
    pub target: RunTarget,
    /// The next run continues this paragraph (same line for AccessKit).
    pub continues: bool,
}

/// What a run's node id is derived from.
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub enum RunKey {
    Block(usize, String, usize),
    Line(usize, usize, usize),
}

/// The chapter as screen readers see it: runs in order and the selection as
/// (run, character) pairs.
#[derive(Debug, Default)]
pub struct A11yText {
    pub label: String,
    pub runs: Vec<A11yRun>,
    pub anchor: Option<(usize, usize)>,
    pub focus: Option<(usize, usize)>,
}

impl A11yText {
    /// The nodes with their ids (from `id_of`), linked along each paragraph,
    /// and the selection in those ids.
    pub fn assemble(
        self,
        id_of: impl Fn(&RunKey) -> NodeId,
    ) -> (Vec<(NodeId, Node, RunTarget)>, Option<TextSelection>) {
        let ids: Vec<NodeId> = self.runs.iter().map(|run| id_of(&run.key)).collect();
        let mut nodes = Vec::with_capacity(self.runs.len());
        let mut previous_continues = false;
        for (ix, run) in self.runs.into_iter().enumerate() {
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
        let position = |(run, ch): (usize, usize)| TextPosition {
            node: ids[run],
            character_index: ch,
        };
        let selection = self
            .anchor
            .zip(self.focus)
            .map(|(anchor, focus)| TextSelection {
                anchor: position(anchor),
                focus: position(focus),
            });
        (nodes, selection)
    }
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
        let mut paragraphs = Vec::with_capacity(visible);
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
            let newline = ix + 1 < visible;
            let first_run = text.runs.len();
            for run in 0..runs.runs.len() {
                let key = match bid {
                    Some(bid) => RunKey::Block(chapter, bid.to_owned(), run),
                    None => RunKey::Line(chapter, ix, run),
                };
                text.runs.push(A11yRun {
                    key,
                    node: runs.node(&line.text, run, newline),
                    target: RunTarget {
                        chapter,
                        line: ix,
                        first: runs.runs[run].start,
                    },
                    continues: run + 1 < runs.runs.len(),
                });
            }
            paragraphs.push((first_run, runs));
        }
        cache.paragraphs = fresh;
        let position = |offset: usize| {
            let (line, inner) = doc.locate(offset);
            let line = line.min(visible.saturating_sub(1));
            let (first_run, runs) = &paragraphs[line];
            let (run, ch) = runs.locate(runs.char_at(inner));
            (first_run + run, ch)
        };
        let sel = self.selection;
        text.anchor = Some(position(sel.anchor));
        text.focus = Some(position(sel.head));
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
        let live = window.is_a11y_active();
        self.input.a11y.live.set(live);
        if !live {
            return root;
        }
        let text = self.a11y_text();
        let label = text.label.clone();
        let targets = Rc::clone(&self.input.a11y.targets);
        let weak_targets: Weak<RefCell<HashMap<NodeId, RunTarget>>> = Rc::downgrade(&targets);
        let editor = cx.entity().downgrade();
        root.role(Role::MultilineTextInput)
            .aria_label(label)
            .a11y_synthetic_children(move |builder: &mut A11ySubtreeBuilder| {
                let (nodes, selection) = text.assemble(|key| builder.synthetic_node_id(key));
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
