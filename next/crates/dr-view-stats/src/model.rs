//! Live editor counts and writing-day arithmetic.
use dr_text::TextMetrics;
use dr_workspace::commands::stats::WritingDaysOut;
use std::collections::HashMap;
/// The editor's own counts: the documents it has open and the selection.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Live {
    pub docs: HashMap<String, TextMetrics>,
    /// Words in the selection, when there is one.
    pub selection: Option<u64>,
}
pub fn today_words(days: &WritingDaysOut, mine_live: Option<i64>) -> i64 {
    match mine_live {
        Some(mine) => (days.today - days.mine_today).max(0) + mine,
        None => days.today,
    }
}
pub fn progress(value: u64, target: Option<i64>) -> Option<f32> {
    let target = target.filter(|t| *t > 0)?;
    Some((value as f64 / target as f64).clamp(0.0, 1.0) as f32)
}
