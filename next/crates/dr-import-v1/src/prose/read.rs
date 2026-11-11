//! Reading a prose document back in the shape of a plan.

use std::collections::BTreeMap;

use dr_doc::prose::{EmbedView, ProseView};

use super::plan::{Para, TableCellPlan};

/// Every paragraph as stored (ids before the duplicate rule, embeds read).
pub fn read_paras(view: &ProseView<'_>) -> Vec<Para> {
    view.paragraphs()
        .map(|p| Para {
            id: p.stored_id.clone(),
            embed: p.embed().and_then(|e| view.embed(e)),
            attrs: p.attrs,
            runs: p.runs,
            table_cells: BTreeMap::new(),
            v3_links: Vec::new(),
        })
        .collect()
}

/// Every canonical v3 paragraph as stored, including version-explicit entity
/// links and rich table-cell runs/links.
pub fn read_paras_v3(view: &ProseView<'_>) -> Vec<Para> {
    let body_links = view.entity_links_v3();
    view.paragraphs()
        .map(|p| {
            let embed = p.embed().and_then(|e| view.embed(e));
            let mut table_cells = BTreeMap::new();
            if let Some(EmbedView::Table { id, cells, .. }) = &embed {
                for (r, c) in cells.keys() {
                    table_cells.insert(
                        (r.clone(), c.clone()),
                        TableCellPlan {
                            runs: view.table_cell(id, r, c).unwrap_or_default(),
                            v3_links: view
                                .table_cell_entity_links_v3(id, r, c)
                                .unwrap_or_default(),
                        },
                    );
                }
            }
            let v3_links = body_links
                .iter()
                .filter(|(r, _)| r.start >= p.range.start && r.end <= p.range.end)
                .map(|(r, l)| (r.start - p.range.start..r.end - p.range.start, l.clone()))
                .collect();
            Para {
                id: p.stored_id.clone(),
                embed,
                attrs: p.attrs,
                runs: p.runs,
                table_cells,
                v3_links,
            }
        })
        .collect()
}
