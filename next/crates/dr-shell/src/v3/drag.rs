//! Neutral payload for entry drags between v3 tree and module surfaces.

use std::{any::Any, cell::Cell, rc::Rc};

use gpui::{App, SharedString};

use crate::pages::PageViewHost;

/// Source lane when dragging a card from a bottom timeline lane (`W9Bottom`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelineClipDrag {
    pub view: String,
    pub lane: String,
}

/// The source retains its observed book and library lease until the drag ends.
/// Receivers must check `matches`/`is_current` and commit with version guards;
/// these UI checks cannot replace a guarded backend write.
#[derive(Clone)]
pub struct EntryDrag {
    pub book: String,
    pub entry: String,
    pub title: SharedString,
    pub span: Option<f64>,
    /// Set when dragging a hung row (`Row::Member`) in the left tree (`W31Hung`).
    pub hung_host: Option<String>,
    /// Set when dragging a placement card from a bottom timeline lane (`W9Bottom`).
    pub timeline_clip: Option<TimelineClipDrag>,
    page: PageViewHost,
    grab: Rc<Cell<f32>>,
    source: Option<Rc<dyn Any>>,
}

impl EntryDrag {
    pub fn new(
        page: PageViewHost,
        entry: impl Into<String>,
        title: impl Into<SharedString>,
    ) -> Self {
        Self {
            book: page.book_id.clone(),
            entry: entry.into(),
            title: title.into(),
            span: None,
            hung_host: None,
            timeline_clip: None,
            page,
            grab: Rc::default(),
            source: None,
        }
    }

    pub fn with_hung_host(mut self, host: impl Into<String>) -> Self {
        self.hung_host = Some(host.into());
        self
    }

    pub fn with_timeline_clip(mut self, view: impl Into<String>, lane: impl Into<String>) -> Self {
        self.timeline_clip = Some(TimelineClipDrag {
            view: view.into(),
            lane: lane.into(),
        });
        self
    }

    pub fn page(&self) -> &PageViewHost {
        &self.page
    }

    /// Optional renderer-private gesture state, shared by clones. Other
    /// receivers need not know its type (for example, a board's press point).
    pub fn with_source<T: Any>(mut self, source: T) -> Self {
        self.source = Some(Rc::new(source));
        self
    }

    pub fn source<T: Any>(&self) -> Option<&T> {
        self.source.as_ref()?.downcast_ref()
    }

    /// Horizontal distance from the source's left edge at the original press.
    /// Shared state survives GPUI cloning the drag value for its preview.
    pub fn set_grab(&self, x: f32) {
        if x.is_finite() {
            self.grab.set(x);
        }
    }

    pub fn grab(&self) -> f32 {
        self.grab.get()
    }

    /// Compare immutable hosts without borrowing the live workspace during
    /// rendering. Equal seeded book IDs in different libraries are distinct.
    pub fn matches(&self, page: &PageViewHost) -> bool {
        let Some(source) = self.page.book.v3() else {
            return false;
        };
        let Some(target) = page.book.v3() else {
            return false;
        };
        self.book == self.page.book_id
            && self.page.book.id == self.book
            && page.book_id == self.book
            && page.book.id == self.book
            && self.page.workspace.entity_id() == page.workspace.entity_id()
            && std::ptr::eq(self.page.library.library(), page.library.library())
            && source.revision == target.revision
            && source.entry(&self.entry).is_some()
    }

    /// Call from an input callback, outside a borrow of the owning workspace.
    /// A delayed drag from a closed/replaced book or library is rejected.
    pub fn is_current(&self, cx: &App) -> bool {
        let Some(owner) = self.page.workspace.upgrade() else {
            return false;
        };
        let ws = owner.read(cx);
        let Some(library) = &ws.library else {
            return false;
        };
        self.matches(&PageViewHost {
            workspace: owner.downgrade(),
            library: library.clone(),
            book_id: ws.book_id.clone(),
            book: ws.book.clone(),
        })
    }
}
