//! What was painted this frame, for hit testing, vertical movement and the
//! input method's candidate window.

use std::rc::Rc;

use gpui::{Bounds, Pixels, Point, SharedString};

use super::decor::DecorationKey;
use crate::layout::ProseLayout;

/// The composition shown inside a paragraph, in display-text bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompSpan {
    /// Where the marked text starts.
    pub at: usize,
    /// Length of the marked text.
    pub len: usize,
    /// Length of committed text hidden behind it (a replaced selection).
    pub replaced: usize,
}

impl CompSpan {
    /// Display byte → byte in the committed line text.
    pub fn to_line_byte(&self, display: usize) -> usize {
        if display <= self.at {
            display
        } else if display < self.at + self.len {
            self.at
        } else {
            display - self.len + self.replaced
        }
    }
}

/// A paragraph as it was painted this frame.
#[derive(Clone)]
pub struct PaintedLine {
    pub chapter: usize,
    pub line: usize,
    pub rev: u64,
    pub text: SharedString,
    pub bounds: Bounds<Pixels>,
    pub origin: Point<Pixels>,
    pub layout: Rc<ProseLayout>,
    pub line_height: Pixels,
    pub comp: Option<CompSpan>,
}

/// A decoration's part of a paragraph as it was painted this frame.
#[derive(Clone, Debug)]
pub struct PaintedDecoration {
    pub chapter: usize,
    pub line: usize,
    pub key: DecorationKey,
    /// Window bounds of the words it covers, one per visual row (a wash
    /// reaches a little past them).
    pub boxes: Vec<Bounds<Pixels>>,
    /// The stroke's alpha this frame; for an ink, how far its colour is in.
    pub alpha: f32,
    /// How much of a stroke being drawn along its rows is down.
    pub drawn: Option<f32>,
}

#[derive(Default)]
pub struct FrameCache {
    pub lines: Vec<PaintedLine>,
    /// Paragraphs laid out this frame, recorded in prepaint (before the
    /// editor's accessibility children are built); cleared each render.
    pub prepainted: Vec<PaintedLine>,
    /// Decorations painted this frame (for placing things next to them, and
    /// for tests).
    pub decorations: Vec<PaintedDecoration>,
}

impl FrameCache {
    pub fn get(&self, chapter: usize, line: usize) -> Option<&PaintedLine> {
        self.lines
            .iter()
            .find(|painted| painted.chapter == chapter && painted.line == line)
    }
}
