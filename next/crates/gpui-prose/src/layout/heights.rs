//! Paragraph heights for the scrollbar and for proportional jumps.
//!
//! GPUI's `list()` keeps its own per-item heights, but it has no API for
//! per-item height hints, counts never-rendered items as zero height, and wipes
//! every height on the first layout and on each width change. Its scrolling is
//! anchored to an item index, which is exactly what an editor wants, so the
//! editor keeps `list()` for virtualization and keeps this separate index for
//! everything that needs a whole-document pixel height: an estimate for every
//! paragraph (cheap, from character widths, computed off the main thread), and
//! the measured height once a paragraph has been laid out.

use super::linebreak::advance_em;

/// Layout metrics of one paragraph kind, in pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BlockMetrics {
    pub font_size: f32,
    pub line_height: f32,
    pub pad_top: f32,
    pub pad_bottom: f32,
}

/// Estimated height of a paragraph wrapped at `wrap_width`.
pub fn estimate_height(text: &str, metrics: &BlockMetrics, wrap_width: f32) -> f32 {
    let ems: f32 = text.chars().map(advance_em).sum();
    let per_row = (wrap_width / metrics.font_size).max(1.0);
    let rows = (ems / per_row).ceil().max(1.0);
    metrics.pad_top + rows * metrics.line_height + metrics.pad_bottom
}

#[derive(Clone, Copy, Debug, Default)]
struct Entry {
    height: f32,
    measured: bool,
}

/// Per-item heights with lazily rebuilt prefix sums.
#[derive(Debug, Default)]
pub struct HeightIndex {
    entries: Vec<Entry>,
    prefix: Vec<f64>,
    dirty: bool,
    /// Estimate error on first measurement: sum of |estimate − measured|, sum
    /// of measured, and how many items were compared.
    pub error_abs: f64,
    pub error_base: f64,
    pub error_count: usize,
}

impl HeightIndex {
    pub fn new(heights: impl IntoIterator<Item = f32>) -> HeightIndex {
        HeightIndex {
            entries: heights
                .into_iter()
                .map(|height| Entry {
                    height,
                    measured: false,
                })
                .collect(),
            dirty: true,
            ..HeightIndex::default()
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn height(&self, ix: usize) -> f32 {
        self.entries.get(ix).map_or(0.0, |entry| entry.height)
    }

    pub fn is_measured(&self, ix: usize) -> bool {
        self.entries.get(ix).is_some_and(|entry| entry.measured)
    }

    /// Replaces `range` with new estimated items.
    pub fn splice(
        &mut self,
        range: std::ops::Range<usize>,
        heights: impl IntoIterator<Item = f32>,
    ) {
        let end = range.end.min(self.entries.len());
        let start = range.start.min(end);
        self.entries.splice(
            start..end,
            heights.into_iter().map(|height| Entry {
                height,
                measured: false,
            }),
        );
        self.dirty = true;
    }

    /// Replaces unmeasured estimates (a background estimate pass finished).
    pub fn set_estimates(&mut self, heights: &[f32]) {
        if heights.len() != self.entries.len() {
            return;
        }
        for (entry, &height) in self.entries.iter_mut().zip(heights) {
            if !entry.measured {
                entry.height = height;
            }
        }
        self.dirty = true;
    }

    /// Forgets measurements (the wrap width changed) and takes new estimates.
    pub fn reset_estimates(&mut self, heights: &[f32]) {
        for entry in &mut self.entries {
            entry.measured = false;
        }
        self.set_estimates(heights);
    }

    /// Re-estimates one item whose text changed.
    pub fn set_estimate(&mut self, ix: usize, height: f32) {
        if let Some(entry) = self.entries.get_mut(ix) {
            entry.height = height;
            entry.measured = false;
            self.dirty = true;
        }
    }

    /// Records the real height of an item after layout.
    pub fn set_measured(&mut self, ix: usize, height: f32) {
        let Some(entry) = self.entries.get_mut(ix) else {
            return;
        };
        if !entry.measured {
            self.error_abs += f64::from((entry.height - height).abs());
            self.error_base += f64::from(height);
            self.error_count += 1;
        }
        if !entry.measured || entry.height != height {
            entry.height = height;
            entry.measured = true;
            self.dirty = true;
        }
    }

    fn ensure_prefix(&mut self) {
        if !self.dirty {
            return;
        }
        self.prefix.clear();
        self.prefix.reserve(self.entries.len() + 1);
        let mut at = 0.0f64;
        self.prefix.push(at);
        for entry in &self.entries {
            at += f64::from(entry.height);
            self.prefix.push(at);
        }
        self.dirty = false;
    }

    /// Top of item `ix` in document pixels.
    pub fn top(&mut self, ix: usize) -> f64 {
        self.ensure_prefix();
        self.prefix[ix.min(self.entries.len())]
    }

    pub fn total(&mut self) -> f64 {
        self.top(self.entries.len())
    }

    /// The item at document pixel `y`, and the offset into it.
    pub fn item_at(&mut self, y: f64) -> (usize, f64) {
        self.ensure_prefix();
        if self.entries.is_empty() {
            return (0, 0.0);
        }
        let y = y.clamp(0.0, self.prefix[self.entries.len()]);
        let ix = match self.prefix.binary_search_by(|top| top.total_cmp(&y)) {
            Ok(ix) => ix,
            Err(ix) => ix - 1,
        }
        .min(self.entries.len() - 1);
        (ix, y - self.prefix[ix])
    }

    /// Mean relative estimate error so far (0.1 = 10 %).
    pub fn mean_error(&self) -> Option<f64> {
        (self.error_base > 0.0).then(|| self.error_abs / self.error_base)
    }

    /// How many items have been measured.
    pub fn measured_count(&self) -> usize {
        self.entries.iter().filter(|entry| entry.measured).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_and_lookup() {
        let mut index = HeightIndex::new([10.0, 20.0, 30.0]);
        assert_eq!(index.total(), 60.0);
        assert_eq!(index.item_at(0.0), (0, 0.0));
        assert_eq!(index.item_at(15.0), (1, 5.0));
        assert_eq!(index.item_at(60.0), (2, 30.0));
        index.splice(1..2, [5.0, 5.0]);
        assert_eq!(index.len(), 4);
        assert_eq!(index.top(3), 20.0);
        index.set_measured(0, 12.0);
        assert_eq!(index.total(), 52.0);
        assert!((index.mean_error().unwrap() - 2.0 / 12.0).abs() < 1e-9);
    }

    #[test]
    fn estimate_counts_rows() {
        let metrics = BlockMetrics {
            font_size: 20.0,
            line_height: 30.0,
            pad_top: 0.0,
            pad_bottom: 10.0,
        };
        // 30 ideographs at 20 px in a 200 px column: 10 per row, 3 rows.
        let text = "字".repeat(30);
        assert_eq!(estimate_height(&text, &metrics, 200.0), 100.0);
        assert_eq!(estimate_height("", &metrics, 200.0), 40.0);
    }
}
