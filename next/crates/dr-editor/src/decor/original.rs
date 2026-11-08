//! A comment's passage as it was written (its 原文 snapshot), and whether
//! the prose under it has changed since: what the Review tab's source card
//! shows on its slip. Read off the main thread, from the book document and
//! the target's prose document; nothing is written.

use dr_doc::book::BookReader;
use dr_doc::schema::prose;
use dr_model::id::{BookId, CommentId};
use dr_store::OpenDoc;
use dr_workspace::Workspace;

use crate::anchors;

/// The passage a comment was written on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Original {
    /// The words selected then, or else the paragraphs it spanned (one
    /// blank line between them).
    pub text: String,
    /// Whether the words under its anchor now differ, or are gone. `None`:
    /// not compared (no anchor, or only the paragraphs were kept).
    pub changed: Option<bool>,
}

/// Comment `comment`'s passage in book `book`; `None` when it kept none.
pub fn original(ws: &Workspace, book: &str, comment: &str) -> Result<Option<Original>, String> {
    let book_id = BookId::parse(book).map_err(|e| e.to_string())?;
    let id = CommentId::parse(comment).map_err(|e| e.to_string())?;
    let found = ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
        .map_err(|e| e.to_string())?
        .read(move |d| BookReader::from_loro(book_id, d).map(|r| r.view().comment(&id)))
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let Some(c) = found else {
        return Ok(None);
    };
    let quote = c
        .quote
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(str::to_owned);
    let text = match &quote {
        Some(q) => q.clone(),
        None => c
            .snapshots
            .iter()
            .map(|s| s.text.trim())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
    };
    if text.is_empty() {
        return Ok(None);
    }
    let changed = match (quote, c.target.as_ref(), c.anchor.clone()) {
        (Some(quote), Some(target), Some(anchor)) => {
            let doc = format!("{}:{}", target.kind.as_str(), target.id);
            ws.library()
                .open_doc(&doc, OpenDoc::Existing)
                .map_err(|e| e.to_string())?
                .read(move |d| {
                    let now = anchors::decode(&anchor)
                        .and_then(|a| a.resolve(d))
                        .filter(|r| !r.collapsed)
                        .and_then(|r| {
                            d.get_text(prose::BODY)
                                .slice(r.range.start, r.range.end)
                                .ok()
                        });
                    Some(now.is_none_or(|now| now.trim() != quote))
                })
                .map_err(|e| e.to_string())?
        }
        _ => None,
    };
    Ok(Some(Original { text, changed }))
}
