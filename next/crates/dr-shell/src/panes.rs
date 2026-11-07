//! A sidebar's halves: which tab each shows, which one has the focus, and
//! when the sidebar splits in two. The 0.1 client's `lib/sidebar-tabs.ts`
//! and docs/design-system/workspace.md (「Persistence and responsive
//! behavior」):
//!
//! - wide enough for two tab rows, a sidebar splits on its own: the current
//!   tab stays, the other half opens the next tab in order (the last wraps
//!   to the first);
//! - clicking a half's selected tab closes that half; the only half's
//!   selected tab closes the whole sidebar;
//! - going back to one half by hand while two fit is remembered
//!   (`keep_single`): crossing the width again does not split until the
//!   author splits by hand; the split comes back on the side last closed.

use serde::{Deserialize, Serialize};

/// The stable identity of a half: closing the first leaves the second
/// mounted, even when it fills the sidebar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PaneId {
    Primary,
    Secondary,
}

impl PaneId {
    fn other(self) -> PaneId {
        match self {
            PaneId::Primary => PaneId::Secondary,
            PaneId::Secondary => PaneId::Primary,
        }
    }
}

/// Which end of the tab row offers the split, and where the new half comes in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Edge {
    Start,
    #[default]
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pane<T> {
    pub id: PaneId,
    pub tab: T,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Panes<T> {
    /// One or two, in order from the window's edge inwards.
    pub panes: Vec<Pane<T>>,
    pub focused: PaneId,
    /// Two halves fit at the current width.
    pub can_split: bool,
    #[serde(default)]
    pub split_edge: Edge,
    #[serde(default)]
    pub keep_single: bool,
}

impl<T: Copy + PartialEq> Panes<T> {
    pub fn single(tab: T) -> Panes<T> {
        Panes {
            panes: vec![Pane {
                id: PaneId::Primary,
                tab,
            }],
            focused: PaneId::Primary,
            can_split: false,
            split_edge: Edge::End,
            keep_single: false,
        }
    }

    pub fn focused_tab(&self) -> T {
        self.panes
            .iter()
            .find(|p| p.id == self.focused)
            .unwrap_or(&self.panes[0])
            .tab
    }

    pub fn is_split(&self) -> bool {
        self.panes.len() == 2
    }

    /// Splits by hand (the 「恢复双栏」 button), or on reaching the width.
    pub fn split(&mut self, order: &[T]) {
        if !self.can_split || self.is_split() {
            return;
        }
        let current = self.panes[0];
        let at = order.iter().position(|t| *t == current.tab).unwrap_or(0);
        let added = Pane {
            id: current.id.other(),
            tab: order[(at + 1) % order.len()],
        };
        self.panes = match self.split_edge {
            Edge::Start => vec![added, current],
            Edge::End => vec![current, added],
        };
        self.keep_single = false;
    }

    /// The sidebar's width changed so that two halves do or do not fit.
    pub fn resize(&mut self, can_split: bool, order: &[T]) {
        if self.can_split == can_split {
            return;
        }
        self.can_split = can_split;
        if can_split {
            if !self.keep_single {
                self.split(order);
            }
        } else {
            let pane = self
                .panes
                .iter()
                .copied()
                .find(|p| p.id == self.focused)
                .unwrap_or(self.panes[0]);
            self.panes = vec![pane];
            self.focused = pane.id;
        }
    }

    /// A tab clicked in `pane`'s row. Returns `false` when it closed the
    /// last half, so the sidebar closes (the half is kept for reopening).
    pub fn click(&mut self, pane: PaneId, tab: T) -> bool {
        let Some(at) = self.panes.iter().position(|p| p.id == pane) else {
            return true;
        };
        if self.panes[at].tab == tab {
            if self.panes.len() == 1 {
                return false;
            }
            self.split_edge = if at == 0 { Edge::Start } else { Edge::End };
            self.panes.remove(at);
            self.focused = self.panes[0].id;
            self.keep_single = true;
            return true;
        }
        self.panes[at].tab = tab;
        self.focused = pane;
        true
    }

    /// Navigation to a tab (a shortcut, a link): a half already showing it
    /// takes the focus, else the focused half shows it.
    pub fn reveal(&mut self, tab: T) {
        if let Some(p) = self.panes.iter().find(|p| p.tab == tab) {
            self.focused = p.id;
            return;
        }
        let focused = self.focused;
        if let Some(p) = self.panes.iter_mut().find(|p| p.id == focused) {
            p.tab = tab;
        }
    }

    pub fn focus(&mut self, pane: PaneId) {
        if self.panes.iter().any(|p| p.id == pane) {
            self.focused = pane;
        }
    }

    /// A saved value, checked: unknown or repeated halves are dropped.
    pub fn restored(mut self, fallback: T, valid: impl Fn(&T) -> bool) -> Panes<T> {
        let mut seen = Vec::new();
        self.panes.retain(|p| {
            let keep = valid(&p.tab) && !seen.contains(&p.id);
            seen.push(p.id);
            keep
        });
        self.panes.truncate(if self.can_split { 2 } else { 1 });
        if self.panes.is_empty() {
            return Panes::single(fallback);
        }
        if !self.panes.iter().any(|p| p.id == self.focused) {
            self.focused = self.panes[0].id;
        }
        self
    }
}

/// Sidebar widths (workspace.md): at least the tab row's width, at most 60%
/// of the window, and never so wide the paper gets under 420px.
pub fn clamp_width(width: f32, min: f32, window: f32, other_sidebar: f32) -> f32 {
    let max = (window * 0.6)
        .min(window - other_sidebar - PAPER_MIN)
        .max(min);
    width.clamp(min, max).round()
}

/// The narrowest the paper area may get.
pub const PAPER_MIN: f32 = 420.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum T {
        A,
        B,
        C,
    }
    const ORDER: [T; 3] = [T::A, T::B, T::C];

    fn tabs(p: &Panes<T>) -> Vec<T> {
        p.panes.iter().map(|p| p.tab).collect()
    }

    #[test]
    fn reaching_the_width_opens_the_next_tab_beside_the_current_one() {
        let mut p = Panes::single(T::C);
        p.resize(true, &ORDER);
        assert_eq!(tabs(&p), [T::C, T::A]);
        p.resize(false, &ORDER);
        assert_eq!(tabs(&p), [T::C]);
    }

    #[test]
    fn closing_a_half_by_hand_is_remembered_until_splitting_by_hand() {
        let mut p = Panes::single(T::A);
        p.resize(true, &ORDER);
        // Clicking the outer half's selected tab closes it.
        assert!(p.click(PaneId::Primary, T::A));
        assert_eq!(tabs(&p), [T::B]);
        assert!(p.keep_single);
        assert_eq!(p.split_edge, Edge::Start);
        p.resize(false, &ORDER);
        p.resize(true, &ORDER);
        assert_eq!(tabs(&p), [T::B], "keeps the author's single half");
        p.split(&ORDER);
        assert_eq!(
            tabs(&p),
            [T::C, T::B],
            "the new half comes in where one was closed"
        );
        assert!(!p.keep_single);
    }

    #[test]
    fn the_only_halfs_selected_tab_closes_the_sidebar() {
        let mut p = Panes::single(T::A);
        assert!(!p.click(PaneId::Primary, T::A));
        assert!(p.click(PaneId::Primary, T::B));
        assert_eq!(p.focused_tab(), T::B);
    }

    #[test]
    fn revealing_reuses_a_half_that_shows_the_tab() {
        let mut p = Panes::single(T::A);
        p.resize(true, &ORDER);
        p.reveal(T::B);
        assert_eq!(p.focused, PaneId::Secondary);
        p.reveal(T::C);
        assert_eq!(tabs(&p), [T::A, T::C]);
    }

    #[test]
    fn widths_leave_the_paper_its_room() {
        assert_eq!(clamp_width(100.0, 200.0, 1440.0, 0.0), 200.0);
        assert_eq!(clamp_width(2000.0, 200.0, 1440.0, 0.0), 864.0);
        // Both sidebars open on a small window: the paper keeps 420px.
        assert_eq!(clamp_width(600.0, 200.0, 1000.0, 300.0), 280.0);
        // Never under the minimum, even when the window is too small.
        assert_eq!(clamp_width(100.0, 260.0, 600.0, 300.0), 260.0);
    }
}
