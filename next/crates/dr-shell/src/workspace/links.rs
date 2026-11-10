//! V3 addresses keep the endpoint and module supplied by G1's parser.
use super::Workspace;
use crate::nav::{Lines, Target};
use dr_editor::v3_link::{Address, Endpoint};
use gpui::{Context, Window};

pub(super) struct PendingLink {
    address: Address,
    library: usize,
    book: String,
}

impl Workspace {
    pub(super) fn open_v3_link(
        &mut self,
        address: Address,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(library) = self.library.clone() else {
            return false;
        };
        // A cold launch may still be on the shelf with no selected book.
        // Only an existing book in this library may start that load.
        if self.book_id.is_empty()
            && self.book_task.is_none()
            && let Some(book) = &address.book
        {
            let known = library
                .library()
                .doc_info(&format!("book:{book}"))
                .is_ok_and(|doc| doc.is_some());
            if !known {
                return false;
            }
            self.open_book(book.as_str(), window, cx);
        }
        if !self.book_id.is_empty()
            && address
                .book
                .as_ref()
                .is_some_and(|b| b.as_str() != self.book_id)
        {
            return false;
        }
        if self.book.is_empty() && self.book_task.is_some() {
            if self.pending_v3_links.len() == dr_platform::deep_link::MAX_QUEUED {
                self.pending_v3_links.remove(0);
            }
            self.pending_v3_links.push(PendingLink {
                address,
                library: library.library() as *const _ as usize,
                book: self.book_id.clone(),
            });
            self.shelf_open = false;
            cx.notify();
            return true;
        }
        if self.book.v3().is_none() {
            return false;
        }
        let target = match address.endpoint {
            Endpoint::Entry { id, module } => Target::Entry { id, module },
            Endpoint::Material(id) => Target::Material(id),
        };
        if !self.book.exists(&target) {
            return false;
        }
        let lines = address.lines.map(|(start, end)| Lines {
            start,
            end: (start != end).then_some(end),
        });
        self.shelf_open = false;
        self.super_view = None;
        self.nav.open_at(target, lines);
        self.changed(cx);
        if self.top_layer().is_none() {
            self.refocus(window, cx);
        }
        true
    }

    pub(super) fn open_pending_v3_links(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.book.is_empty() {
            return;
        }
        for pending in std::mem::take(&mut self.pending_v3_links) {
            let current_library = self
                .library
                .as_ref()
                .map(|l| l.library() as *const _ as usize);
            if current_library == Some(pending.library)
                && (pending.book.is_empty() || pending.book == self.book_id)
            {
                self.open_v3_link(pending.address, window, cx);
            }
        }
    }
}
