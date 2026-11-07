//! The editor's live counts, for the readings that follow it.
//!
//! The derived index catches up when a document's holder is idle; the
//! counts of what the editor has open come from the editor itself
//! (`dr_text::LiveCount` over its own paragraphs, by the index's rule). The
//! editor (F4e) reports them here; the Stats tab reads them and swaps them
//! into the index's totals.
//!
//! ```ignore
//! let mut live = dr_text::LiveCount::from_view(&view);
//! // after each change set:
//! for s in &change.splices { live.splice(s.start, s.old, s.new); }
//! live.recount(|i| lines[i].text.clone());
//! dr_view_stats::LiveWords::set_doc(doc_id, live.total(), cx);
//! dr_view_stats::LiveWords::set_selection(Some(dr_text::count_words(&selected)), cx);
//! // when the editor closes:
//! dr_view_stats::LiveWords::clear_doc(doc_id, cx);
//! ```

use dr_text::TextMetrics;
use gpui::{App, Global};

use crate::model::Live;

/// The editor's counts (a GPUI global; views observe it).
#[derive(Default)]
pub struct LiveWords(pub(crate) Live);

impl Global for LiveWords {}

impl LiveWords {
    pub fn read(cx: &App) -> &Live {
        match cx.try_global::<LiveWords>() {
            Some(l) => &l.0,
            None => {
                static EMPTY: std::sync::OnceLock<Live> = std::sync::OnceLock::new();
                EMPTY.get_or_init(Live::default)
            }
        }
    }

    /// The open document `doc` (`node:<id>`, …) counts `metrics` now.
    pub fn set_doc(doc: impl Into<String>, metrics: TextMetrics, cx: &mut App) {
        let doc = doc.into();
        if LiveWords::read(cx).docs.get(&doc) == Some(&metrics) {
            return;
        }
        cx.default_global::<LiveWords>().0.docs.insert(doc, metrics);
    }

    /// The editor of `doc` closed: its count comes from the index again.
    pub fn clear_doc(doc: &str, cx: &mut App) {
        if LiveWords::read(cx).docs.contains_key(doc) {
            cx.default_global::<LiveWords>().0.docs.remove(doc);
        }
    }

    /// Words in the editor's selection (`None`: no selection).
    pub fn set_selection(words: Option<u64>, cx: &mut App) {
        if LiveWords::read(cx).selection != words {
            cx.default_global::<LiveWords>().0.selection = words;
        }
    }
}
