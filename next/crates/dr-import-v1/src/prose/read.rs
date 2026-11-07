//! Reading a prose document back in the shape of a plan.

use dr_doc::prose::ProseView;

use super::plan::Para;

/// Every paragraph as stored (ids before the duplicate rule, embeds read).
pub fn read_paras(view: &ProseView<'_>) -> Vec<Para> {
    view.paragraphs()
        .map(|p| Para {
            id: p.stored_id.clone(),
            embed: p.embed().and_then(|e| view.embed(e)),
            attrs: p.attrs,
            runs: p.runs,
        })
        .collect()
}
