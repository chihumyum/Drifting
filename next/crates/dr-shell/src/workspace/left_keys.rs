//! The keyboard in the left column (KB, `kernel-v5.md` §15 item 48; the
//! author's whole-window prototype of 2026-11-17).
//!
//! ⌘⇧L ([`FocusLeftSidebar`]) takes the keyboard from the page into the left
//! column: into the selected Tab's tree, on the row of the page in front,
//! or onto the Tab row when the Tab shows no tree the keyboard walks (a
//! board, islands, the book, a Tab whose mount is gone). A closed column
//! opens first and stays open after; a filled one does nothing. Pressed
//! again with the keyboard anywhere in the column (the tree, the Tab row, a
//! row's card), and Esc there, and a press on the paper, all give the page
//! back the keyboard where it had it: the caret and selection as they were,
//! the page not scrolled ([`Workspace::keyboard_to_page`]).
//!
//! The tree and the Tab row each hold their own focus and keys
//! ([`crate::keymap::LEFT_TREE`], [`crate::keymap::LEFT_TABS`]); this file
//! only moves the keyboard in and out.
//!
//! [`FocusLeftSidebar`]: crate::actions::FocusLeftSidebar
use gpui::{Context, FocusHandle, Window};

use super::{FillPlace, Workspace};

impl Workspace {
    /// ⌘⇧L: the keyboard into the left column, or out of it back to the
    /// page. Nothing while a layer covers the workspace, while immersed,
    /// while the column fills or while its Tabs are being managed.
    pub fn toggle_left_keyboard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.covered() || self.immersive || self.book.v3().is_none() {
            return;
        }
        if self.is_filled(FillPlace::Left) {
            return;
        }
        if let Some(sidebar) = &self.v3_sidebar {
            if sidebar.read(cx).is_managing() {
                return;
            }
            if self.left.open && self.keyboard_in_left(window, cx) {
                self.keyboard_to_page(window, cx);
                return;
            }
        }
        if !self.left.open {
            let reduce = self.reduce_motion(window, cx);
            self.left.set_open(true, reduce);
            self.changed(cx);
        }
        // The column takes it once drawn: its Tab's tree may not be made
        // yet (`sidebar::left`, `Sidebar::take_keyboard`).
        self.want_left_keyboard = true;
        cx.notify();
    }

    /// Whether the keyboard is anywhere in the left column: its tree, its
    /// Tab row, a row's card, or the column itself while managing.
    pub fn keyboard_in_left(&self, window: &Window, cx: &gpui::App) -> bool {
        self.left.open
            && self
                .v3_sidebar
                .as_ref()
                .is_some_and(|sidebar| sidebar.read(cx).has_keyboard(window, cx))
    }

    /// Whether ⌘⇧L asked for the keyboard in the left column, which it then
    /// takes (once).
    pub(crate) fn take_left_keyboard_wish(&mut self) -> bool {
        std::mem::take(&mut self.want_left_keyboard)
    }

    /// The keyboard back to the page in front (from the left column: Esc,
    /// ⌘⇧L, a press on the paper; a double click or Enter on the row in
    /// front): where it was in that page, its caret and selection as they
    /// were, the page not scrolled. When another page has come to the front
    /// meanwhile (a preview from the tree), that page's own place takes it.
    pub fn keyboard_to_page(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(handle) = self.gave_focus.clone()
            && self.front_page_holds(&handle, window, cx)
        {
            window.focus(&handle, cx);
            cx.notify();
            return;
        }
        self.refocus(window, cx);
    }

    /// A press on the paper begins (capture phase): whether the keyboard
    /// comes from the left column, for [`Self::pressed_paper`].
    pub(crate) fn pressing_paper(&mut self, window: &Window, cx: &gpui::App) {
        self.paper_press_from_left = self.keyboard_in_left(window, cx)
            && !self
                .v3_sidebar
                .as_ref()
                .is_some_and(|sidebar| sidebar.read(cx).is_managing());
    }

    /// The press on the paper that [`Self::pressing_paper`] began, after
    /// the page had it (bubble phase). With the keyboard coming from the
    /// left column, a press nothing in the page took (a margin, below the
    /// text) or that only the entry page itself took gives the page back the
    /// keyboard as it had it; a press an editor or a field took leaves the
    /// keyboard there, its caret where the press put it.
    pub(crate) fn pressed_paper(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !std::mem::take(&mut self.paper_press_from_left) {
            return;
        }
        if window.default_prevented() && !self.front_page_itself_focused(window, cx) {
            return;
        }
        self.keyboard_to_page(window, cx);
        window.prevent_default();
    }

    /// The handle the keyboard was last given in a page, for tests.
    pub fn page_keyboard(&self) -> Option<FocusHandle> {
        self.gave_focus.clone()
    }
}
