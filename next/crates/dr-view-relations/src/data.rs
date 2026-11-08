//! What the relations views read and write through F3 (`relation.*`,
//! `relation_type.*`), as the author. Every function here runs off the main
//! thread; the book event that follows a write reads the lists again.

use dr_workspace::commands::relation::{
    RelationCreate, RelationCreateIn, RelationDelete, RelationList, RelationListIn,
    RelationTypeCreate, RelationTypeCreateIn, RelationTypeDelete, RelationTypeList,
    RelationTypeUpdate, RelationTypeUpdateIn,
};
use dr_workspace::commands::{BookIn, EntityIn};
use dr_workspace::dto::{RelationInfo, RelationTypeInfo, Target as End};
use dr_workspace::{Actor, Workspace as Library, WsError};

use crate::model::Draft;

/// The book's relation types, and its relations (all of them, or those
/// touching `owner`).
pub fn load(
    lib: &Library,
    book: &str,
    owner: Option<&End>,
) -> Result<(Vec<RelationTypeInfo>, Vec<RelationInfo>), WsError> {
    let me = &Actor::User;
    let types = lib
        .run::<RelationTypeList>(
            me,
            BookIn {
                book: book.to_owned(),
            },
        )?
        .output;
    let relations = lib
        .run::<RelationList>(
            me,
            RelationListIn {
                book: book.to_owned(),
                entity: owner.cloned(),
                relation_type: None,
            },
        )?
        .output;
    Ok((types, relations))
}

/// Relate `from` to `to` with `relation_type`; the relation's id.
pub fn create(
    lib: &Library,
    book: &str,
    from: End,
    to: End,
    relation_type: &str,
) -> Result<String, WsError> {
    Ok(lib
        .run::<RelationCreate>(
            &Actor::User,
            RelationCreateIn {
                book: book.to_owned(),
                from,
                to,
                relation_type: Some(relation_type.to_owned()),
                id: None,
            },
        )?
        .output
        .id)
}

pub fn delete(lib: &Library, book: &str, id: &str) -> Result<(), WsError> {
    lib.run::<RelationDelete>(
        &Actor::User,
        EntityIn {
            book: book.to_owned(),
            id: id.to_owned(),
        },
    )
    .map(|_| ())
}

/// Give relation `id` (ends `from`, `to`) another type, or turn it round:
/// F3 has no command for it, so the new relation is made first and the old
/// one then deleted (two steps of undo; m17-relations.md, 待协调).
pub fn replace(
    lib: &Library,
    book: &str,
    id: &str,
    from: End,
    to: End,
    relation_type: &str,
) -> Result<String, WsError> {
    let made = create(lib, book, from, to, relation_type)?;
    if made != id {
        delete(lib, book, id)?;
    }
    Ok(made)
}

/// A new relation type from the editor; its id.
pub fn create_type(lib: &Library, book: &str, d: &Draft) -> Result<String, WsError> {
    let (source_role, target_role) = d.roles();
    let (source_kinds, target_kinds) = d.kinds();
    Ok(lib
        .run::<RelationTypeCreate>(
            &Actor::User,
            RelationTypeCreateIn {
                book: book.to_owned(),
                name: d.name.clone(),
                orientation: Some(if d.symmetric { "symmetric" } else { "directed" }.to_owned()),
                source_kinds,
                target_kinds,
                source_role,
                target_role,
                description: d.description.clone(),
                color: None,
            },
        )?
        .output
        .id)
}

/// Save the editor's name, description and roles over type `old` (F3
/// changes nothing else of a type; only what differs is sent).
pub fn update_type(
    lib: &Library,
    book: &str,
    old: &RelationTypeInfo,
    d: &Draft,
) -> Result<(), WsError> {
    let (source_role, target_role) = d.roles();
    let changed = |new: &str, old: &str| (new != old).then(|| new.to_owned());
    let input = RelationTypeUpdateIn {
        book: book.to_owned(),
        id: old.id.clone(),
        name: changed(&d.name, &old.name),
        description: changed(&d.description, &old.description),
        source_role: changed(&source_role, &old.source_role),
        target_role: changed(&target_role, &old.target_role),
        color: None,
    };
    if input.name.is_none()
        && input.description.is_none()
        && input.source_role.is_none()
        && input.target_role.is_none()
    {
        return Ok(());
    }
    lib.run::<RelationTypeUpdate>(&Actor::User, input)
        .map(|_| ())
}

/// A type's colour (`None`: back to the default for its id).
pub fn set_color(
    lib: &Library,
    book: &str,
    id: &str,
    color: Option<String>,
) -> Result<(), WsError> {
    lib.run::<RelationTypeUpdate>(
        &Actor::User,
        RelationTypeUpdateIn {
            book: book.to_owned(),
            id: id.to_owned(),
            color: Some(color),
            ..RelationTypeUpdateIn::default()
        },
    )
    .map(|_| ())
}

pub fn delete_type(lib: &Library, book: &str, id: &str) -> Result<(), WsError> {
    lib.run::<RelationTypeDelete>(
        &Actor::User,
        EntityIn {
            book: book.to_owned(),
            id: id.to_owned(),
        },
    )
    .map(|_| ())
}
