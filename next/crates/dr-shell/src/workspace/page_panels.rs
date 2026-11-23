//! What a page brings into the side columns while it is in front
//! (`custom-modules.md` §8, CM3: the module workbench, the first page that
//! does). The page's module registers the panels
//! ([`crate::pages::add_page_panels`]); the shell asks once per page, the
//! first time it is in front, and keeps them while its pill stays open.
//!
//! The columns hold them only while the page shows on the paper: it is the
//! page with the focus (a split's focused side), nothing fills the middle
//! column (a panel's fill or a module's), the window is not immersed and
//! 全部项目 does not cover it. Otherwise, and as soon as another pill comes
//! to the front, they hold what they held before. Their widths, opening and
//! closing stay the columns' own; while the panels show, neither side
//! fills (its full moon is dimmed, as the right one's is on 统计 and Agent).

use std::collections::HashSet;

use gpui::{Context, SharedString, Window};

use super::Workspace;
use crate::nav::Target;
use crate::pages::{self, AGENT_TAB, PagePanels};

impl Workspace {
    /// Makes the panels of the page in front, once, after its page was
    /// made ([`Workspace::ensure_pages`]); forgets those of closed pages.
    pub(super) fn ensure_page_panels(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let open: HashSet<String> = self
            .nav
            .tabs()
            .iter()
            .flat_map(|t| t.leaves())
            .map(|l| l.target.key())
            .collect();
        self.page_panels.retain(|key, _| open.contains(key));
        self.page_tabs.retain(|key, _| open.contains(key));
        let Some(target) = self.nav.current().cloned() else {
            return;
        };
        let key = target.key();
        if self.page_panels.contains_key(&key) || !self.editors.contains_key(&key) {
            return;
        }
        let Some(library) = self.library.clone() else {
            return;
        };
        if self.book.is_empty() {
            return;
        }
        let host = pages::PageViewHost {
            workspace: cx.entity().downgrade(),
            library,
            book_id: self.book_id.clone(),
            book: self.book.clone(),
        };
        let made = pages::page_panels_for(&target, host, window, cx);
        self.page_panels.insert(key, made);
    }

    /// The panels the side columns hold now, if the page in front brought
    /// some and shows on the paper.
    pub fn page_panels(&self) -> Option<&PagePanels> {
        if self.immersive
            || self.shelf_open
            || self.filled().is_some()
            || self.filled_module().is_some()
        {
            return None;
        }
        let target = self.nav.current()?;
        self.page_panels.get(&target.key())?.as_ref()
    }

    /// Whether the side columns hold a page's panels now.
    pub fn page_panels_shown(&self) -> bool {
        self.page_panels().is_some()
    }

    /// The right-column tab the page in front shows: one of its own
    /// ([`pages::PageTab::slug`]) or [`AGENT_TAB`]; its first until one is
    /// chosen.
    pub fn page_tab(&self) -> Option<SharedString> {
        let target = self.nav.current()?;
        let panels = self.page_panels.get(&target.key())?.as_ref()?;
        match self.page_tabs.get(&target.key()) {
            Some(slug) => Some(slug.clone()),
            None => Some(
                panels
                    .right
                    .first()
                    .map(|t| t.slug.clone())
                    .unwrap_or_else(|| AGENT_TAB.into()),
            ),
        }
    }

    /// Shows `slug` (one of the page's tabs, or [`AGENT_TAB`]) in the right
    /// column of `target`'s page (the column stays open or closed).
    pub fn show_page_tab(&mut self, target: &Target, slug: &str, cx: &mut Context<Self>) {
        let before = self.page_tabs.insert(target.key(), slug.to_owned().into());
        if before.as_deref() != Some(slug) {
            cx.notify();
        }
    }
}
