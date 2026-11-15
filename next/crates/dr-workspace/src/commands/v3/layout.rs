//! Free-canvas positions (`layout:<book>`, `kernel-v5.md` §8 & §10).
//!
//! Coordinates live in the side document `layout:<book>` under `<scope>/<mode>`
//! (`<entry_id>/board`, `<entry_id>/grid`, `root/relation_graph`, …). Reading
//! or writing them never touches `book:<id>`, never enters the undo journal,
//! and never participates in book record write guards (`LAYOUT-DOC-QUIET`).
use super::*;
use dr_doc::side::BorrowedLayout;

pub(crate) fn register(r: &mut Registry) {
    r.add::<LayoutGet>().add::<LayoutPut>().add::<LayoutClear>();
}

fn scope_mode_key(scope: &str, mode: &str) -> Result<String> {
    let s = scope.trim();
    let m = mode.trim();
    if s.is_empty() || m.is_empty() || s.contains('/') || m.contains('/') {
        return Err(WsError::invalid(
            "layout scope and mode must be non-empty strings without '/'",
        ));
    }
    Ok(format!("{s}/{m}"))
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LayoutGetIn {
    pub book: String,
    pub scope: String,
    pub mode: String,
}

op! {
    LayoutGet = "layout.get", Read, Shared,
    "Read the free-canvas coordinates stored for a `<scope>/<mode>` view in `layout:<book>`.",
    fn(cx, input: LayoutGetIn) -> BTreeMap<String, (f64, f64)> {
        let slot = cx.book_v3(&input.book)?;
        let key = scope_mode_key(&input.scope, &input.mode)?;
        let Some(side) = cx
            .workspace()
            .side_slot(&DocId::Layout(slot.book.clone()), &slot.book, false)?
        else {
            return Ok(BTreeMap::new());
        };
        let book = slot.book.clone();
        let positions = side.handle.read(move |doc| -> Result<_> {
            Ok(BorrowedLayout::new(doc, &book)?.view().positions(&key))
        })??;
        Ok(positions
            .into_iter()
            .map(|(id, pt)| (id.to_string(), pt))
            .collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LayoutPutIn {
    pub book: String,
    pub scope: String,
    pub mode: String,
    pub positions: BTreeMap<String, (f64, f64)>,
}

op! {
    LayoutPut = "layout.put", Write, Book,
    "Set entry coordinates in a `<scope>/<mode>` view of `layout:<book>` (not undoable; leaves the book document untouched).",
    fn(cx, input: LayoutPutIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let key = scope_mode_key(&input.scope, &input.mode)?;
        if input.positions.is_empty() {
            return Err(WsError::invalid("positions must not be empty"));
        }
        let v = slot.reader_v3.view();
        let mut parsed: Vec<(EntryId, (f64, f64))> = Vec::with_capacity(input.positions.len());
        for (raw_id, (x, y)) in &input.positions {
            if !x.is_finite() || !y.is_finite() {
                return Err(WsError::invalid("layout coordinates must be finite"));
            }
            // Only a live entry has a place on a canvas.
            parsed.push((live(&v, raw_id)?.id, (*x, *y)));
        }
        let unchanged = match cx
            .workspace()
            .side_slot(&DocId::Layout(slot.book.clone()), &slot.book, false)?
        {
            Some(side) => {
                let (book, k, want) = (slot.book.clone(), key.clone(), parsed.clone());
                side.handle.read(move |doc| -> Result<bool> {
                    let cur = BorrowedLayout::new(doc, &book)?.view().positions(&k);
                    Ok(want.iter().all(|(id, pt)| cur.get(id) == Some(pt)))
                })??
            }
            None => false,
        };
        if !unchanged {
            let k = key.clone();
            cx.write_layout(&slot.book, move |txn| {
                for (id, (x, y)) in &parsed {
                    txn.put_position(&k, id, *x, *y)?;
                }
                Ok(())
            })?;
        }
        cx.irreversible();
        Ok(Done { id: key })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LayoutClearIn {
    pub book: String,
    pub scope: String,
    pub mode: String,
    /// Specific entry IDs to clear from `<scope>/<mode>`, or `None` to clear
    /// the entire `<scope>/<mode>` canvas.
    #[serde(default)]
    pub entries: Option<Vec<String>>,
}

op! {
    LayoutClear = "layout.clear", Write, Book,
    "Clear entry coordinates (or the whole `<scope>/<mode>` view) in `layout:<book>` (not undoable; leaves the book document untouched).",
    fn(cx, input: LayoutClearIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let key = scope_mode_key(&input.scope, &input.mode)?;
        let entries: Option<Vec<EntryId>> = input
            .entries
            .as_ref()
            .map(|ids| ids.iter().map(|s| pid("entry", s)).collect())
            .transpose()?;
        let has_work = match cx
            .workspace()
            .side_slot(&DocId::Layout(slot.book.clone()), &slot.book, false)?
        {
            Some(side) => {
                let (book, k, ids) = (slot.book.clone(), key.clone(), entries.clone());
                side.handle.read(move |doc| -> Result<bool> {
                    let cur = BorrowedLayout::new(doc, &book)?.view().positions(&k);
                    Ok(match ids {
                        Some(ids) => ids.iter().any(|id| cur.contains_key(id)),
                        None => !cur.is_empty(),
                    })
                })??
            }
            None => false,
        };
        if has_work {
            let k = key.clone();
            cx.write_layout(&slot.book, move |txn| {
                match &entries {
                    Some(ids) => {
                        for id in ids {
                            txn.remove_position(&k, id)?;
                        }
                    }
                    None => txn.clear_scope(&k)?,
                }
                Ok(())
            })?;
        }
        cx.irreversible();
        Ok(Done { id: key })
    }
}
