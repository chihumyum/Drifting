//! The relations and their guards must describe the same read. A draft keeps
//! these records even when the visible list refreshes underneath it.

use dr_model::v3::{RelationDirection, RelationRow, RelationSide};
use dr_shell::book::Book;
use dr_workspace::commands::v3::relations::{List, ListIn, RelationInfo};
use dr_workspace::{Actor, RecordKey, Workspace, WritePreconditions, WsError};

pub(super) fn load(
    lib: &Workspace,
    book: &str,
) -> dr_workspace::Result<(
    Vec<RelationInfo>,
    Book,
    WritePreconditions,
    Vec<RelationRow>,
)> {
    let book_id = book
        .parse::<dr_model::id::BookId>()
        .map_err(|e| WsError::Invalid(e.to_string()))?;
    lib.with_book_lease(&book_id, || {
        let snapshot = Book::load(lib, book)?;
        let relations = lib
            .run::<List>(
                &Actor::User,
                ListIn {
                    book: book.to_owned(),
                    entry: None,
                },
            )?
            .output;
        let id = book
            .parse::<dr_model::id::BookId>()
            .map_err(|e| WsError::Invalid(e.to_string()))?;
        let (records, rows) = lib.read_book_v3(book, move |doc, _| {
            let borrowed = dr_doc::v3::BorrowedBookV3::new(doc, &id)
                .map_err(|e| WsError::Invalid(e.to_string()))?;
            let view = borrowed.view();
            // Individual records, never the collection: an unknown remote
            // row must not be covered when deleting an apparently empty card.
            let keys: Vec<_> = view
                .relation_types_raw()
                .into_iter()
                .map(|r| RecordKey::record("relation_types", r.id.to_string()))
                .chain(
                    view.relations_raw()
                        .into_iter()
                        .map(|r| RecordKey::record("relations", r.id.to_string())),
                )
                .collect();
            let records = dr_workspace::observe_records_in(&format!("book:{id}"), doc, &id, &keys)?;
            Ok((records, view.relations_raw()))
        })?;
        Ok((
            relations,
            snapshot,
            WritePreconditions::default().with_shown(records.into_iter().map(Into::into)),
            rows,
        ))
    })
}

/// Accept concurrent additions on the same side, but never expand against an
/// opposite side or direction the author did not see. Observe and compare in
/// one read, then CAS that exact record in the write; no UI draft is authorized
/// merely by replacing its old observation with a new one.
pub(super) fn adding(
    lib: &Workspace,
    book: &str,
    shown: RelationRow,
    relation: String,
    direction: RelationDirection,
    side: RelationSide,
) -> dr_workspace::Result<WritePreconditions> {
    let id = book
        .parse::<dr_model::id::BookId>()
        .map_err(|e| WsError::Invalid(e.to_string()))?;
    lib.read_book_v3(book, move |doc, _| {
        let borrowed = dr_doc::v3::BorrowedBookV3::new(doc, &id)
            .map_err(|e| WsError::Invalid(e.to_string()))?;
        let view = borrowed.view();
        let current = view
            .relations_raw()
            .into_iter()
            .find(|r| r.id == shown.id)
            .ok_or_else(|| WsError::Conflict("relation row disappeared".into()))?;
        let winners = view.relation_type_winners();
        let kind = winners
            .get(&current.relation_type)
            .and_then(|id| view.relation_type_raw(id))
            .ok_or_else(|| WsError::Conflict("relation disappeared".into()))?;
        if current.opposite(side) != shown.opposite(side)
            || current.relation_type != shown.relation_type
            || current.created_at != shown.created_at
            || kind.id.as_str() != relation
            || kind.direction != direction
        {
            return Err(WsError::Conflict(
                "relation changed while choosing a member".into(),
            ));
        }
        // The definitions guard also catches a new same-name canonical winner
        // appearing between this read and the mutation. It is read now only
        // after verifying the user's opposite-side/direction expectations.
        let keys = [
            RecordKey::record("relations", current.id.to_string()),
            RecordKey::collection("relation_types"),
        ];
        Ok(WritePreconditions::from_records(
            dr_workspace::observe_records_in(&format!("book:{id}"), doc, &id, &keys)?,
        ))
    })
}
