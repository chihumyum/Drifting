//! Entry checkpoints from the 0.1 snapshot history (`m10-import.md`
//! 「快照历史」).
//!
//! The current format's history (`entry_snapshot.list` / `preview` /
//! `restore`, the entry's 「快照历史」 dialog) reads entry checkpoints, the
//! manifests in `checkpoints:<book>`, not the store's history labels. So
//! every 0.1 history row the import replays becomes one, once the book
//! document holds the row's metadata:
//!
//! - its book version is the one that carries the row's metadata, the body
//!   the row is a version of is at that version, and every other body of the
//!   entry is at its imported version;
//! - the manifest is made with dr-workspace's own checksum and content
//!   fingerprint (`checkpoint_manifest_checksum`,
//!   `checkpoint_history_fingerprint`), on the stored documents checked out
//!   at exactly those versions, as preview loads them;
//! - its id is a function of the row's id ([`checkpoint_id`]), so a resumed
//!   import writes the same manifests again;
//! - its reason is the import's origin (`import`, the name
//!   `entry_snapshot.create` gives a point the importer saves), not an
//!   automatic one: thinning only ever takes `periodic` and `close` points,
//!   so an imported point stays however old it is.
//!
//! What restoring one brings back is what the row holds: the prose and the
//! fields 0.1 kept beside it. Everything else the entry owns is at its
//! imported value in that book version (0.1 did not record it), so it stays
//! as imported, as 0.1's own restore left it.

use std::collections::{BTreeMap, HashMap};

use dr_doc::loro_types::Frontiers;
use dr_doc::prose::ProseReader;
use dr_doc::v3::BorrowedBookV3;
use dr_model::DocId;
use dr_model::id::BookId;
use dr_store::Library;
use dr_workspace::commands::v3::snapshots::{self as api, EntryIn, Point};
use dr_workspace::naming::{frontiers_from_hex, frontiers_hex};
use loro::LoroDoc;

use crate::error::{ImportError, Result};
use crate::meta::{Fields, Owner};
use crate::prose::{Para, read};

/// The id of the entry checkpoint 0.1 history row `row` becomes.
pub fn checkpoint_id(row: &str) -> String {
    format!("import-v1:{row}")
}

/// The reason an imported checkpoint carries: who saved it, as
/// `entry_snapshot.create` names the points an actor saves.
pub fn reason() -> String {
    dr_store::Origin::Import.to_string()
}

/// No checkpoint: the row's body belongs to no entry of the book at the
/// row's book version.
pub const ENTRY_MISSING: &str = "history-checkpoint-entry-missing";
/// No checkpoint: the row's body is not an entry's body document.
pub const NOT_AN_ENTRY_BODY: &str = "history-checkpoint-not-an-entry-body";
/// No checkpoint: the documents could not be read at the row's versions.
pub const UNREADABLE: &str = "history-checkpoint-unreadable";
/// A written checkpoint that does not read back as the row (the import's
/// own check, `Options::verify_history`).
pub const DIFFERS: &str = "history-checkpoint-differs";
/// A written checkpoint whose entry lived, at the row's time, under an entry
/// the imported book no longer has (an element's 0.1 group no other element
/// keeps): it previews, and `entry_snapshot.restore` restores it with the
/// entry staying where it lives now, as for any point whose place is gone.
pub const PLACE_GONE: &str = "history-checkpoint-place-gone";

/// One replayed 0.1 history row.
pub(crate) struct Row<'a> {
    pub row: &'a str,
    /// The body document the row is a version of.
    pub doc: &'a str,
    pub ts_ms: i64,
    /// The body's version for the row.
    pub body_at: &'a Frontiers,
    /// The book document's version that carries the row's metadata.
    pub book_at: &'a Frontiers,
}

/// What [`plan`] made.
#[derive(Default)]
pub(crate) struct Planned {
    /// In row order.
    pub points: Vec<Point>,
    /// Rows that could not become a checkpoint: row id → code.
    pub without: BTreeMap<String, String>,
    /// Rows whose checkpoint places the entry under an entry the book no
    /// longer has ([`PLACE_GONE`]).
    pub place_gone: Vec<String>,
}

/// The checkpoints of `rows` (in time order), from the stored book and
/// bodies of `book`. Writes nothing.
pub(crate) fn plan(lib: &Library, book: &BookId, rows: &[Row<'_>]) -> Result<Planned> {
    let mut out = Planned::default();
    if rows.is_empty() {
        return Ok(out);
    }
    let book_doc = DocId::Book(book.clone()).to_string();
    let stored = lib.load_copy(&book_doc)?;
    // The entries of the book as imported, trashed ones included.
    let now: std::collections::BTreeSet<_> = BorrowedBookV3::new(&stored, book)?
        .view()
        .entries_raw()
        .into_iter()
        .map(|e| e.id)
        .collect();
    // The raw inventory of every entry's bodies, as a checkpoint lists them.
    let mut bodies_of: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for info in lib.docs(Some(book.as_str()), None)? {
        if let Ok(DocId::Body(b)) = DocId::parse(&info.doc_id) {
            bodies_of
                .entry(b.entry().to_string())
                .or_default()
                .push(info.doc_id);
        }
    }
    let mut copies: HashMap<String, LoroDoc> = HashMap::new();
    for r in rows {
        let Ok(DocId::Body(body)) = DocId::parse(r.doc) else {
            out.without
                .insert(r.row.to_owned(), NOT_AN_ENTRY_BODY.into());
            continue;
        };
        let entry = body.entry().clone();
        if stored.checkout(r.book_at).is_err() {
            out.without.insert(r.row.to_owned(), UNREADABLE.into());
            continue;
        }
        let Some(then) = BorrowedBookV3::new(&stored, book)?.view().entry_raw(&entry) else {
            out.without.insert(r.row.to_owned(), ENTRY_MISSING.into());
            continue;
        };
        let gone = then.parent.as_ref().is_some_and(|p| !now.contains(p));
        let title = then.title;
        let mut docs: BTreeMap<String, LoroDoc> = BTreeMap::new();
        docs.insert(book_doc.clone(), stored.clone());
        let mut readable = true;
        for id in bodies_of.get(entry.as_str()).into_iter().flatten() {
            if !copies.contains_key(id) {
                copies.insert(id.clone(), lib.load_copy(id)?);
            }
            let copy = &copies[id];
            readable &= if id == r.doc {
                copy.checkout(r.body_at).is_ok()
            } else {
                copy.try_checkout_to_latest().is_ok()
            };
            docs.insert(id.clone(), copy.clone());
        }
        if !readable || !docs.contains_key(r.doc) {
            out.without.insert(r.row.to_owned(), UNREADABLE.into());
            continue;
        }
        let target = EntryIn {
            book: book.to_string(),
            entry: entry.to_string(),
        };
        let Ok(content_hash) = api::checkpoint_history_fingerprint(&docs, &target) else {
            out.without.insert(r.row.to_owned(), UNREADABLE.into());
            continue;
        };
        let bodies = docs
            .iter()
            .filter(|(id, _)| **id != book_doc)
            .map(|(id, d)| (id.clone(), frontiers_hex(&d.state_frontiers())))
            .collect();
        let mut p = Point {
            id: checkpoint_id(r.row),
            format: 1,
            book: target.book,
            entry: target.entry,
            ts: r.ts_ms,
            title,
            reason: reason(),
            book_version: frontiers_hex(&stored.state_frontiers()),
            bodies,
            checksum: String::new(),
            content_hash,
        };
        p.checksum = api::checkpoint_manifest_checksum(&p).map_err(ws)?;
        out.points.push(p);
        if gone {
            out.place_gone.push(r.row.to_owned());
        }
    }
    Ok(out)
}

/// What a checkpoint of a row must read back as: the row's body version,
/// and its metadata when the row's was replayed.
pub(crate) struct Want<'a> {
    pub doc: &'a str,
    pub paras: &'a [Para],
    pub meta: Option<(&'a Owner, &'a Fields)>,
}

/// Read back the checkpoints of `points` as the history dialog does: each
/// manifest stored and sound (`checked_checkpoint`), equal to the one
/// planned, its history the content it fingerprints
/// (`checkpoint_history_matches`, on copies loaded at its versions), its
/// body the row's version, and the row's metadata held at its book version.
/// Returns how many hold; the others are noted ([`DIFFERS`]).
pub(crate) fn verify(
    lib: &Library,
    book: &BookId,
    points: &[Point],
    wants: &HashMap<String, Want<'_>>,
    notes: &mut crate::prose::Notes,
) -> Result<usize> {
    let stored = lib.load_copy(&DocId::Checkpoints(book.clone()).to_string())?;
    let manifests: HashMap<String, String> = dr_doc::side::BorrowedCheckpoints::new(&stored, book)?
        .view()
        .entry_checkpoints()
        .into_iter()
        .collect();
    let mut held = 0;
    for p in points {
        let holds = (|| -> Result<bool> {
            let Some(want) = wants.get(&p.id) else {
                return Ok(false);
            };
            let target = EntryIn {
                book: p.book.clone(),
                entry: p.entry.clone(),
            };
            let Some(value) = manifests.get(&p.id) else {
                return Ok(false);
            };
            let Ok(read_back) = api::checked_checkpoint(value, &target, &p.id) else {
                return Ok(false);
            };
            if serde_json::to_value(&read_back)? != serde_json::to_value(p)? {
                return Ok(false);
            }
            let mut docs = BTreeMap::new();
            for (id, version) in std::iter::once((
                DocId::Book(book.clone()).to_string(),
                p.book_version.clone(),
            ))
            .chain(p.bodies.clone())
            {
                let at = frontiers_from_hex(&version).map_err(ws)?;
                docs.insert(id.clone(), lib.load_copy_at(&id, &at)?);
            }
            if !api::checkpoint_history_matches(&docs, &target, &p.content_hash).map_err(ws)? {
                return Ok(false);
            }
            let Some(body) = docs.get(want.doc) else {
                return Ok(false);
            };
            let doc_id = DocId::parse(want.doc).map_err(|e| ImportError::Invalid(e.to_string()))?;
            let reader = ProseReader::from_loro(doc_id, body)?;
            if read::read_paras_v3(&reader.view()) != want.paras {
                return Ok(false);
            }
            if let Some((owner, fields)) = want.meta {
                let b = BorrowedBookV3::new(&docs[&DocId::Book(book.clone()).to_string()], book)?;
                if !crate::v3::holds(&b.view(), owner, fields) {
                    return Ok(false);
                }
            }
            Ok(true)
        })()?;
        if holds {
            held += 1;
        } else {
            notes.add(DIFFERS);
        }
    }
    Ok(held)
}

fn ws(e: dr_workspace::WsError) -> ImportError {
    ImportError::Invalid(e.to_string())
}
