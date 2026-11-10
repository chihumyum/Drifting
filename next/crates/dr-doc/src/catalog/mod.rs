//! Shared catalog codecs and data operations. No legacy book genesis,
//! runtime reader or source-format collections are reachable through this module.
pub(crate) mod fields;
pub(crate) mod read;
pub mod write;
use dr_model::id::{BookId, RelationTypeId};
pub use read::EntitySnapshot;
pub fn generic_relation_type_id(book: &BookId) -> RelationTypeId {
    RelationTypeId::parse(&format!("system:generic-association:{book}")).expect("valid id")
}
pub(crate) const GENERIC_NAME: &str = "Generic association";
pub(crate) const GENERIC_DESCRIPTION: &str =
    "Built-in association for TODO and library item links.";
