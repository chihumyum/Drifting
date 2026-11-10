//! Shared endpoint DTO construction.
use dr_workspace::dto::Target as End;
pub fn end(kind: &str, id: &str) -> End {
    End {
        kind: kind.to_owned(),
        id: id.to_owned(),
    }
}
