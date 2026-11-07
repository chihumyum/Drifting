//! What the element and category pages read and write.
//!
//! - Reading: the shell's snapshot of the book (`dr_shell::book::Book`),
//!   which it reads again from F3 whenever the book changes (here, the
//!   Agent, another window). The pages hold no copy of their own.
//! - Writing: F3's `element.update` and `category.update`, as the author,
//!   off the main thread. The book event that follows brings the new
//!   snapshot.

use dr_shell::book::Book;
use dr_workspace::{
    Actor, Workspace as Library, WsError,
    commands::{
        element::{CategoryUpdate, CategoryUpdateIn, ElementUpdate, ElementUpdateIn},
        storyline::{StorylineUpdate, StorylineUpdateIn},
    },
    dto::{CategoryInfo, ElementInfo, StorylineInfo},
};

/// The element `id` of `book`, if it is still there.
pub fn element<'a>(book: &'a Book, id: &str) -> Option<&'a ElementInfo> {
    book.elements.iter().find(|e| e.id == id)
}

/// The category `id` of `book`, if it is still there.
pub fn category<'a>(book: &'a Book, id: &str) -> Option<&'a CategoryInfo> {
    book.categories.iter().find(|c| c.id == id)
}

/// The storyline `id` of `book`, if it is still there.
pub fn storyline<'a>(book: &'a Book, id: &str) -> Option<&'a StorylineInfo> {
    book.storylines.iter().find(|l| l.id == id)
}

/// A `storyline.update` that changes nothing yet.
pub fn storyline_edit(book: &str, id: &str) -> StorylineUpdateIn {
    StorylineUpdateIn {
        book: book.to_owned(),
        id: id.to_owned(),
        ..StorylineUpdateIn::default()
    }
}

/// Runs `storyline.update` as the author. Call it off the main thread.
pub fn update_storyline(lib: &Library, edit: StorylineUpdateIn) -> Result<(), WsError> {
    lib.run::<StorylineUpdate>(&Actor::User, edit).map(|_| ())
}

/// The elements of category `id`, in the book's order.
pub fn elements_of<'a>(book: &'a Book, id: &str) -> Vec<&'a ElementInfo> {
    book.elements
        .iter()
        .filter(|e| e.category.as_deref() == Some(id))
        .collect()
}

/// An `element.update` that changes nothing yet.
pub fn element_edit(book: &str, id: &str) -> ElementUpdateIn {
    ElementUpdateIn {
        book: book.to_owned(),
        id: id.to_owned(),
        ..ElementUpdateIn::default()
    }
}

/// A `category.update` that changes nothing yet.
pub fn category_edit(book: &str, id: &str) -> CategoryUpdateIn {
    CategoryUpdateIn {
        book: book.to_owned(),
        id: id.to_owned(),
        ..CategoryUpdateIn::default()
    }
}

/// Runs `element.update` as the author. Call it off the main thread.
pub fn update_element(lib: &Library, edit: ElementUpdateIn) -> Result<(), WsError> {
    lib.run::<ElementUpdate>(&Actor::User, edit).map(|_| ())
}

/// Runs `category.update` as the author. Call it off the main thread.
pub fn update_category(lib: &Library, edit: CategoryUpdateIn) -> Result<(), WsError> {
    lib.run::<CategoryUpdate>(&Actor::User, edit).map(|_| ())
}
