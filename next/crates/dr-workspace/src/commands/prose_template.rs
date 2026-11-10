//! Paragraph DTO and preserving replacement for v3 module templates.
use crate::Result;
use dr_doc::prose::{ProseTxn, ProseView};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
/// One paragraph of a body template.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TemplateParagraph {
    /// 1, 2 or 3 for H1/H2/H3; omitted for body text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading: Option<u8>,
    #[serde(default)]
    pub text: String,
}
pub(crate) fn blank(view: &ProseView<'_>) -> bool {
    view.len() <= 1
}
fn shape(view: &ProseView<'_>) -> Vec<(Option<u8>, String, std::ops::Range<usize>)> {
    if blank(view) {
        return Vec::new();
    }
    view.paragraphs()
        .map(|p| {
            (
                p.attrs.heading.map(|h| h.level() as u8),
                p.text(),
                p.range.clone(),
            )
        })
        .collect()
}
pub(crate) fn replace_paragraphs(txn: &mut ProseTxn<'_>, new: &[TemplateParagraph]) -> Result<()> {
    let old = shape(&txn.view());
    let want: Vec<(Option<u8>, String)> = new.iter().map(|p| (p.heading, p.text.clone())).collect();
    let same = |o: &(Option<u8>, String, std::ops::Range<usize>), w: &(Option<u8>, String)| {
        o.0 == w.0 && o.1 == w.1
    };
    let (n, m) = (old.len(), want.len());
    let mut k = 0;
    while k < n.min(m) && same(&old[k], &want[k]) {
        k += 1;
    }
    let mut s = 0;
    while s < n.min(m) - k && same(&old[n - 1 - s], &want[m - 1 - s]) {
        s += 1;
    }
    if k == n && k == m {
        return Ok(());
    }
    let joined = want[k..m - s]
        .iter()
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let inserting = m - s > k;
    if s > 0 {
        // Whole paragraphs out, the new ones in front of the shared end.
        let at = old[k].2.start;
        if n - s > k {
            txn.delete(at..old[n - s].2.start)?;
        }
        if inserting {
            txn.insert_paragraphs(at, &format!("{joined}\n"))?;
        }
    } else if k > 0 {
        // From the end of the shared start to the end of the text.
        let at = old[k - 1].2.end;
        if n > k {
            txn.delete(at..old[n - 1].2.end)?;
        }
        if inserting {
            txn.insert_paragraphs(at, &format!("\n{joined}"))?;
        }
    } else {
        if n > 0 {
            txn.delete(0..old[n - 1].2.end)?;
        }
        if inserting {
            txn.insert_paragraphs(0, &joined)?;
        }
    }
    let heading_of = |i: usize| {
        want.get(i).and_then(|(h, _)| match h {
            Some(1) => Some(dr_model::prose::Heading::H1),
            Some(2) => Some(dr_model::prose::Heading::H2),
            Some(3) => Some(dr_model::prose::Heading::H3),
            _ => None,
        })
    };
    // The new paragraphs carry nothing of the ones they replaced; a kept
    // empty paragraph next to them may have lost its heading to a split.
    let now: Vec<(usize, Option<dr_model::prose::Heading>)> = txn
        .view()
        .paragraphs()
        .map(|p| (p.range.start, p.attrs.heading))
        .collect();
    let fresh = if m == 0 { 0..1 } else { k..m - s };
    for (i, (at, heading)) in now.into_iter().enumerate() {
        if fresh.contains(&i) {
            txn.set_block_attrs(
                at,
                &dr_model::prose::BlockAttrs {
                    heading: heading_of(i),
                    ..Default::default()
                },
            )?;
        } else if heading != heading_of(i) && i < m {
            txn.set_heading(at, heading_of(i))?;
        }
    }
    Ok(())
}
