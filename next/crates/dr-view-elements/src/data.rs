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

/// Versioned G2 mutations. Every edit compares the book revision used to
/// prepare it; a stale dialog cannot replace newer overrides or layout.
pub mod v3 {
    use dr_shell::{book::Book, pages::PageViewHost};
    use dr_workspace::{Actor, Workspace, WritePreconditions, WsError};
    use serde_json::{Value, json};

    pub fn fresh(host: &PageViewHost, cx: &gpui::App) -> Option<PageViewHost> {
        let ws = host.workspace.upgrade()?;
        let ws = ws.read(cx);
        if ws.book_id != host.book_id
            || ws.book.v3().is_none()
            || !ws
                .library
                .as_ref()
                .is_some_and(|lib| std::ptr::eq(lib.library(), host.library.library()))
        {
            return None;
        }
        Some(PageViewHost {
            book: ws.book.clone(),
            ..host.clone()
        })
    }
    /// A sendable edit prepared from the exact snapshot shown to the author.
    pub struct Mutation {
        command: &'static str,
        input: Value,
        preconditions: WritePreconditions,
    }
    impl Mutation {
        pub fn commit(self, lib: &Workspace) -> Result<Value, WsError> {
            lib.call_guarded(&Actor::User, self.command, self.input, self.preconditions)
                .map(|answer| answer["output"].clone())
        }
    }
    pub fn prepare(
        book: &Book,
        command: &'static str,
        mut input: Value,
    ) -> Result<Mutation, WsError> {
        let v = book
            .v3()
            .ok_or_else(|| WsError::Invalid("v3 book required".into()))?;
        input
            .as_object_mut()
            .ok_or_else(|| WsError::Invalid("object input required".into()))?
            .insert("book".into(), json!(book.id));
        Ok(Mutation {
            command,
            input,
            preconditions: WritePreconditions {
                versions: [(format!("book:{}", book.id), v.revision.clone())].into(),
                require_all: false,
            },
        })
    }
    pub fn prepare_edit(book: &Book, id: &str, mut changes: Value) -> Result<Mutation, WsError> {
        let v = book
            .v3()
            .ok_or_else(|| WsError::Invalid("v3 book required".into()))?;
        if v.entry(id).is_none() {
            return Err(WsError::Invalid("entry is no longer live".into()));
        }
        let map = changes
            .as_object_mut()
            .ok_or_else(|| WsError::Invalid("entry changes required".into()))?;
        map.insert("id".into(), json!(id));
        prepare(book, "entry.update", changes)
    }
    pub fn prepare_override(
        book: &Book,
        id: &str,
        key: &str,
        value: Option<Value>,
    ) -> Result<Mutation, WsError> {
        if ![
            "default_template",
            "allow",
            "display",
            "auto_link",
            "accept",
            "home",
            "is_manuscript",
            "format_shortcuts",
        ]
        .contains(&key)
        {
            return Err(WsError::Invalid("unknown level setting".into()));
        }
        let v = book
            .v3()
            .ok_or_else(|| WsError::Invalid("v3 book required".into()))?;
        let entry = v
            .entry(id)
            .filter(|_| v.levels.contains_key(id))
            .ok_or_else(|| WsError::Invalid("level is no longer live".into()))?;
        let mut overrides = entry
            .overrides
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|e| WsError::Internal(e.to_string()))?
            .unwrap_or(json!({}));
        let map = overrides.as_object_mut().expect("level settings object");
        if let Some(value) = value {
            map.insert(key.into(), value);
        } else {
            map.remove(key);
        }
        prepare_edit(book, id, json!({"overrides":overrides}))
    }
}
