//! What the shell (F6, `dr-shell`) needs from the workspace to find, name
//! and forget the things it opens in tabs, without GPUI here:
//!
//! - [`BookCatalog`]: location-link lookup by group and name or id, the
//!   shape of `dr_shell::nav::location::Catalog` (its `impl` is three
//!   one-line methods over this), plus the title a tab shows;
//! - [`NavTarget`]: the entities a tab can show, as in `dr_shell::nav::Target`
//!   (same variants, same [`NavTarget::key`]);
//! - removals ([`crate::events::Removed`], on the bus): what went to the
//!   trash or was deleted for good, so the shell can call
//!   `Navigator::forget`;
//! - [`crate::Workspace::before_quit`], for `dr_shell::quit::before_quit`.
//!
//! Lookups read the workspace's query caches, so they cost a scan of a
//! cached list, not a read of the book.

use dr_model::id::{BookId, CategoryId, ElementId, MaterialId, NodeId, StorylineId};

use crate::commands::{categories, elements, materials, meta, nodes, storylines};
use crate::error::{Result, WsError};
use crate::workspace::{BookSlot, Workspace};

/// The groups of a location link (`drifting:<group>/<title | id-<id>>/…`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LinkGroup {
    Chapters,
    /// 构想.
    Drifts,
    Elements,
    Categories,
    Storylines,
}

impl LinkGroup {
    pub const ALL: [LinkGroup; 5] = [
        LinkGroup::Chapters,
        LinkGroup::Drifts,
        LinkGroup::Elements,
        LinkGroup::Categories,
        LinkGroup::Storylines,
    ];

    /// The path segment, as in the link.
    pub fn segment(self) -> &'static str {
        match self {
            LinkGroup::Chapters => "chapters",
            LinkGroup::Drifts => "drifts",
            LinkGroup::Elements => "elements",
            LinkGroup::Categories => "categories",
            LinkGroup::Storylines => "storylines",
        }
    }

    pub fn from_segment(s: &str) -> Option<LinkGroup> {
        LinkGroup::ALL.into_iter().find(|g| g.segment() == s)
    }
}

/// Something a tab can show.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum NavTarget {
    /// The whole book (通览全书).
    Book,
    Chapter(NodeId),
    /// 构想 (internal name drift).
    Idea(NodeId),
    Storyline(StorylineId),
    Element(ElementId),
    Category(CategoryId),
    Material(MaterialId),
}

impl NavTarget {
    /// A stable key, unique among a book's targets (the shell's
    /// `Target::key`).
    pub fn key(&self) -> String {
        match self {
            NavTarget::Book => "book".to_owned(),
            NavTarget::Chapter(id) => format!("chapter:{id}"),
            NavTarget::Idea(id) => format!("idea:{id}"),
            NavTarget::Storyline(id) => format!("storyline:{id}"),
            NavTarget::Element(id) => format!("element:{id}"),
            NavTarget::Category(id) => format!("category:{id}"),
            NavTarget::Material(id) => format!("material:{id}"),
        }
    }
}

/// Finds a book's live entities (not in the trash) by link group and name
/// or id. Cheap to clone; lookups never fail (a book that cannot be read
/// finds nothing, and says so in the log).
#[derive(Clone)]
pub struct BookCatalog {
    ws: Workspace,
    book: BookId,
}

impl Workspace {
    /// The catalog of `book` (opens the book; `not_found` if there is none).
    pub fn catalog(&self, book: &str) -> Result<BookCatalog> {
        let id =
            BookId::parse(book).map_err(|_| WsError::invalid(format!("bad book id {book:?}")))?;
        self.book_slot(&id)?;
        Ok(BookCatalog {
            ws: self.clone(),
            book: id,
        })
    }
}

impl BookCatalog {
    pub fn book_id(&self) -> &str {
        self.book.as_str()
    }

    fn slot(&self) -> Option<std::sync::Arc<BookSlot>> {
        match self.ws.book_slot(&self.book) {
            Ok(s) => Some(s),
            Err(e) => {
                log::warn!("catalog of {}: {e}", self.book);
                None
            }
        }
    }

    /// Every live entity in `group` called `name` (both sides trimmed), so a
    /// duplicate shows as more than one.
    pub fn by_name(&self, group: LinkGroup, name: &str) -> Vec<NavTarget> {
        let name = name.trim();
        if name.is_empty() {
            return Vec::new();
        }
        self.slot()
            .map(|s| {
                entries(&s, group)
                    .into_iter()
                    .filter(|(_, n)| n.trim() == name)
                    .map(|(t, _)| t)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The live entity in `group` with this id.
    pub fn by_id(&self, group: LinkGroup, id: &str) -> Option<NavTarget> {
        let s = self.slot()?;
        let target = target_of(group, id)?;
        self.title_in(&s, &target).map(|_| target)
    }

    /// What a tab or a page calls `target`; `None` when it is gone or in the
    /// trash.
    pub fn title(&self, target: &NavTarget) -> Option<String> {
        let s = self.slot()?;
        self.title_in(&s, target)
    }

    pub fn exists(&self, target: &NavTarget) -> bool {
        self.title(target).is_some()
    }

    fn title_in(&self, s: &BookSlot, target: &NavTarget) -> Option<String> {
        match target {
            NavTarget::Book => {
                let m = meta(s);
                m.deleted_at.is_none().then(|| m.name.clone())
            }
            NavTarget::Chapter(id) | NavTarget::Idea(id) => {
                let n = nodes(s).get(id).cloned()?;
                let kind_ok = match target {
                    NavTarget::Chapter(_) => n.is_chapter(),
                    _ => n.is_drift(),
                };
                (kind_ok && !n.is_trashed()).then_some(n.title)
            }
            NavTarget::Storyline(id) => storylines(s)
                .iter()
                .find(|x| &x.id == id && x.deleted_at.is_none())
                .map(|x| x.name.clone()),
            NavTarget::Element(id) => elements(s)
                .iter()
                .find(|x| &x.id == id && x.deleted_at.is_none())
                .map(|x| x.name.clone()),
            NavTarget::Category(id) => categories(s)
                .iter()
                .find(|x| &x.id == id && x.deleted_at.is_none())
                .map(|x| x.name.clone()),
            NavTarget::Material(id) => materials(s)
                .iter()
                .find(|x| &x.id == id)
                .map(|x| x.title.clone()),
        }
    }
}

fn target_of(group: LinkGroup, id: &str) -> Option<NavTarget> {
    Some(match group {
        LinkGroup::Chapters => NavTarget::Chapter(NodeId::parse(id).ok()?),
        LinkGroup::Drifts => NavTarget::Idea(NodeId::parse(id).ok()?),
        LinkGroup::Elements => NavTarget::Element(ElementId::parse(id).ok()?),
        LinkGroup::Categories => NavTarget::Category(CategoryId::parse(id).ok()?),
        LinkGroup::Storylines => NavTarget::Storyline(StorylineId::parse(id).ok()?),
    })
}

/// The live entities of `group` with their names.
fn entries(s: &BookSlot, group: LinkGroup) -> Vec<(NavTarget, String)> {
    match group {
        LinkGroup::Chapters | LinkGroup::Drifts => nodes(s)
            .values()
            .filter(|n| !n.is_trashed())
            .filter(|n| match group {
                LinkGroup::Chapters => n.is_chapter(),
                _ => n.is_drift(),
            })
            .map(|n| {
                let t = match group {
                    LinkGroup::Chapters => NavTarget::Chapter(n.id.clone()),
                    _ => NavTarget::Idea(n.id.clone()),
                };
                (t, n.title.clone())
            })
            .collect(),
        LinkGroup::Elements => elements(s)
            .iter()
            .filter(|e| e.deleted_at.is_none())
            .map(|e| (NavTarget::Element(e.id.clone()), e.name.clone()))
            .collect(),
        LinkGroup::Categories => categories(s)
            .iter()
            .filter(|c| c.deleted_at.is_none())
            .map(|c| (NavTarget::Category(c.id.clone()), c.name.clone()))
            .collect(),
        LinkGroup::Storylines => storylines(s)
            .iter()
            .filter(|l| l.deleted_at.is_none())
            .map(|l| (NavTarget::Storyline(l.id.clone()), l.name.clone()))
            .collect(),
    }
}
