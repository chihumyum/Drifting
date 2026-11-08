//! What the ideas panel writes through F3 (`idea.*`, `idea_group.*`), as
//! the author. Call these off the main thread; the book event that follows
//! brings the shell a new snapshot.

use dr_workspace::commands::EntityIn;
use dr_workspace::commands::idea::{
    GroupCreateIn, GroupUpdateIn, IdeaCreate, IdeaCreateIn, IdeaGroupCreate, IdeaGroupDelete,
    IdeaGroupUpdate, IdeaTrash, IdeaUpdate, IdeaUpdateIn,
};
use dr_workspace::{Actor, Workspace as Library, WsError};

/// A new idea called `title`, in `group` (or at the top level); its id.
pub fn create_idea(
    lib: &Library,
    book: &str,
    title: &str,
    group: Option<&str>,
) -> Result<String, WsError> {
    Ok(lib
        .run::<IdeaCreate>(
            &Actor::User,
            IdeaCreateIn {
                book: book.to_owned(),
                title: title.to_owned(),
                group: group.map(str::to_owned),
                position: None,
                summary: String::new(),
                text: None,
            },
        )?
        .output
        .id)
}

fn update_idea(lib: &Library, input: IdeaUpdateIn) -> Result<(), WsError> {
    lib.run::<IdeaUpdate>(&Actor::User, input).map(|_| ())
}

fn idea_edit(book: &str, id: &str) -> IdeaUpdateIn {
    IdeaUpdateIn {
        book: book.to_owned(),
        id: id.to_owned(),
        ..IdeaUpdateIn::default()
    }
}

/// Idea `id` into `group` (`None`: out of every group).
pub fn move_idea(lib: &Library, book: &str, id: &str, group: Option<&str>) -> Result<(), WsError> {
    update_idea(
        lib,
        IdeaUpdateIn {
            group: Some(group.map(str::to_owned)),
            ..idea_edit(book, id)
        },
    )
}

/// 漂流 / 休息 (`drifting` / `resting`).
pub fn set_status(lib: &Library, book: &str, id: &str, status: &str) -> Result<(), WsError> {
    update_idea(
        lib,
        IdeaUpdateIn {
            status: Some(status.to_owned()),
            ..idea_edit(book, id)
        },
    )
}

/// Idea `id` into the trash.
pub fn trash_idea(lib: &Library, book: &str, id: &str) -> Result<(), WsError> {
    lib.run::<IdeaTrash>(
        &Actor::User,
        EntityIn {
            book: book.to_owned(),
            id: id.to_owned(),
        },
    )
    .map(|_| ())
}

/// A new group under `parent` (or at the top level); its id.
pub fn create_group(
    lib: &Library,
    book: &str,
    name: &str,
    parent: Option<&str>,
) -> Result<String, WsError> {
    Ok(lib
        .run::<IdeaGroupCreate>(
            &Actor::User,
            GroupCreateIn {
                book: book.to_owned(),
                name: name.to_owned(),
                parent: parent.map(str::to_owned),
                color: None,
            },
        )?
        .output
        .id)
}

fn group_edit(book: &str, id: &str) -> GroupUpdateIn {
    GroupUpdateIn {
        book: book.to_owned(),
        id: id.to_owned(),
        ..GroupUpdateIn::default()
    }
}

pub fn rename_group(lib: &Library, book: &str, id: &str, name: &str) -> Result<(), WsError> {
    lib.run::<IdeaGroupUpdate>(
        &Actor::User,
        GroupUpdateIn {
            name: Some(name.to_owned()),
            ..group_edit(book, id)
        },
    )
    .map(|_| ())
}

/// Group `id` under `parent` (`None`: the top level).
pub fn move_group(
    lib: &Library,
    book: &str,
    id: &str,
    parent: Option<&str>,
) -> Result<(), WsError> {
    lib.run::<IdeaGroupUpdate>(
        &Actor::User,
        GroupUpdateIn {
            parent: Some(parent.map(str::to_owned)),
            ..group_edit(book, id)
        },
    )
    .map(|_| ())
}

/// Group `id` goes; its sub-groups and ideas move up to its parent (F3).
pub fn delete_group(lib: &Library, book: &str, id: &str) -> Result<(), WsError> {
    lib.run::<IdeaGroupDelete>(
        &Actor::User,
        EntityIn {
            book: book.to_owned(),
            id: id.to_owned(),
        },
    )
    .map(|_| ())
}
