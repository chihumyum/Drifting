//! The review surfaces share the RD short-text wire format. The stored
//! projection supplies labels and visible links; unchanged hidden links are
//! retained by the command's existing-text reconciliation.

use std::rc::Rc;

use dr_model::v3::{EntryTextLink, LinkedText};
use dr_ui::linked::{AtItem, Candidates, Draft};
use dr_ui::sand;
use dr_workspace::{Workspace, dto::LinkedTextIn};

pub(crate) fn draft(text: &LinkedText) -> Draft {
    Draft::from_chars(
        text.text.clone(),
        text.links
            .iter()
            .map(|l| (l.start, l.end, l.entry.to_string().into())),
    )
}

pub(crate) fn input(draft: &Draft) -> LinkedTextIn {
    LinkedTextIn::Linked(LinkedText {
        text: draft.text.clone(),
        links: draft
            .char_links()
            .into_iter()
            .filter_map(|(start, end, target)| {
                Some(EntryTextLink {
                    start,
                    end,
                    entry: target.parse().ok()?,
                })
            })
            .collect(),
    })
}

/// Query current book metadata, never the snapshot from when editing began.
/// This keeps remote renames/trash out of an already open candidate list.
pub(crate) fn candidates(ws: Workspace, book: String, excluded: Option<String>) -> Candidates {
    Rc::new(move |query, _| {
        let Ok(id) = dr_model::id::BookId::parse(&book) else {
            return Vec::new();
        };
        let query = query.trim().to_lowercase();
        let excluded = excluded.clone();
        let data = ws
            .read_book_v3(&book, move |doc, _| {
                let b = dr_doc::v3::BorrowedBookV3::new(doc, &id)
                    .map_err(|e| dr_workspace::WsError::Invalid(e.to_string()))?;
                let view = b.view();
                let entries = view.entry_headers();
                let templates = view.templates_map();
                let mut hits = Vec::new();
                for e in entries.values() {
                    let title = e.title.to_lowercase();
                    if e.is_trashed()
                        || e.title.trim().is_empty()
                        || excluded.as_deref() == Some(e.id.as_str())
                        || (!query.is_empty() && !title.contains(&query))
                        || dr_model::v3::effective_ancestors(&entries, &e.id)
                            .iter()
                            .any(|a| entries.get(a).is_none_or(|a| a.is_trashed()))
                    {
                        continue;
                    }
                    let template = e.template.as_ref().and_then(|id| templates.get(id));
                    let mark = e
                        .mark
                        .clone()
                        .or_else(|| template.and_then(|t| t.mark.clone()));
                    hits.push((
                        !query.is_empty() && title.starts_with(&query),
                        e.id.to_string(),
                        e.title.clone(),
                        template.map(|t| t.name.clone()),
                        mark,
                    ));
                }
                hits.sort_by_key(|(prefix, _, _, _, _)| !*prefix);
                Ok(hits)
            })
            .unwrap_or_default();
        data.into_iter()
            .map(|(_, id, title, template, mark)| AtItem {
                mark: entry_mark(mark.as_deref(), &id),
                target: id.into(),
                label: title.into(),
                detail: template.map(Into::into),
            })
            .collect()
    })
}

fn entry_mark(mark: Option<&str>, id: &str) -> sand::Kind {
    match mark {
        Some("book") => sand::Kind::All,
        Some("file-text") => {
            let hash = id
                .encode_utf16()
                .fold(0i32, |h, c| h.wrapping_mul(31).wrapping_add(c as i32));
            sand::Kind::Chapter(((hash as i64).abs() % 6) as u8)
        }
        Some("lightbulb" | "sparkles") => sand::Kind::Drift { loose: false },
        Some("folder" | "tag") => sand::Kind::Category,
        Some("compass" | "route") => sand::Kind::Storyline,
        Some("git-branch") => sand::Kind::DriftGroup,
        Some(text)
            if dr_model::v3::is_valid_mark(text)
                && (text.len() == 1
                    || !text
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')) =>
        {
            sand::Kind::Glyph(sand::Glyph::new(text))
        }
        _ => sand::Kind::Element,
    }
}
