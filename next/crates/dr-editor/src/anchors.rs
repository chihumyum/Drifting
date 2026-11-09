//! The anchors of comments on the open document: loaded from the book
//! document, so the editor can carry them through deletions and undo.
//!
//! An anchor is two encoded Loro cursors (`loro-schema.md`, 锚点): `start`
//! is `Side::Left` on the first anchored character, `end` `Side::Right` on
//! the last. gpui-prose and dr-doc encode them the same way, so the bytes go
//! between the book document and the editor unchanged.

use std::collections::HashMap;

use dr_doc::book::BookReader;
use dr_doc::loro_types::Cursor;
use dr_model::book::EncodedAnchor;
use dr_model::id::BookId;
use dr_store::OpenDoc;
use dr_workspace::Workspace;
use gpui_prose::text::Anchor;

/// The editor's anchor as the book document stores it.
pub fn encode(anchor: &Anchor) -> EncodedAnchor {
    EncodedAnchor {
        start: anchor.start.encode(),
        end: anchor.end.encode(),
    }
}

/// A stored anchor as the editor holds it (`None` if damaged).
pub fn decode(encoded: &EncodedAnchor) -> Option<Anchor> {
    Some(Anchor {
        start: Cursor::decode(&encoded.start).ok()?,
        end: Cursor::decode(&encoded.end).ok()?,
    })
}

/// `(comment id, anchor)` of every comment on prose document `doc`
/// (`node:<id>` …) in `book`, read on the book document's holder thread.
pub fn comment_anchors(
    ws: &Workspace,
    book: &str,
    doc: &str,
) -> Result<Vec<(String, Anchor)>, String> {
    Ok(book_comment_anchors(ws, book)?
        .remove(doc)
        .unwrap_or_default())
}

/// Every anchored comment of `book`, by the prose document it is on (one
/// read of the book document, for the whole-book view).
pub fn book_comment_anchors(
    ws: &Workspace,
    book: &str,
) -> Result<HashMap<String, Vec<(String, Anchor)>>, String> {
    let book_id = BookId::parse(book).map_err(|e| e.to_string())?;
    let handle = ws
        .library()
        .open_doc(&format!("book:{book}"), OpenDoc::Existing)
        .map_err(|e| e.to_string())?;
    let found = handle
        .read(move |d| {
            let reader = BookReader::from_loro(book_id.clone(), d)?;
            let mut out = Vec::new();
            if reader.view().meta().schema_version == 3 {
                let reader = dr_doc::v3::BookReaderV3::from_loro(book_id, d)?;
                for c in reader.view().comments() {
                    if let (Some(target), Some(anchor)) = (c.target.as_ref(), c.anchor.as_ref()) {
                        let doc = if target.kind == dr_model::kind::EntityKind::Entry {
                            let Some(module) = c.target_module.as_ref() else {
                                continue;
                            };
                            format!("body:{}/{}", target.id, module)
                        } else {
                            format!("{}:{}", target.kind.as_str(), target.id)
                        };
                        out.push((doc, c.id.to_string(), anchor.clone()));
                    }
                }
                return Ok::<_, dr_doc::DocError>(out);
            }
            for c in reader.view().comments() {
                if let (Some(t), Some(a)) = (c.target.as_ref(), c.anchor.as_ref()) {
                    out.push((
                        format!("{}:{}", t.kind.as_str(), t.id),
                        c.id.to_string(),
                        a.clone(),
                    ));
                }
            }
            Ok::<_, dr_doc::DocError>(out)
        })
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let mut by_doc: HashMap<String, Vec<(String, Anchor)>> = HashMap::new();
    for (doc, id, a) in found {
        if let Some(anchor) = decode(&a) {
            by_doc.entry(doc).or_default().push((id, anchor));
        }
    }
    Ok(by_doc)
}
