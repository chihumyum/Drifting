//! What is open: one navigation model.
//!
//! The 0.1 client kept "what is open" three times (the URL, the tab tree and
//! the selection) and synchronised them in both directions
//! (`useSyncSplitFocusedUrl.ts`, 322 lines). Here there is one [`Navigator`]:
//! the tab tree plus its own history. The page on the paper, the highlighted
//! cell in a sidebar and what Back and Forward go to are all read from it.
//!
//! The rules for opening, previews and splits are the 0.1 client's
//! (`store/ui-store.ts`, `docs/editor/split-tab-preview.md`):
//!
//! - opening something already open activates it (either side of a split);
//! - a single click opens a **preview**: it replaces the existing preview tab
//!   in place, or is appended; a double click (or [`Navigator::promote`])
//!   keeps it;
//! - when the active tab is a split whose focused side is a preview, a new
//!   preview replaces that side; a kept side leaves the split alone;
//! - splits never nest; the whole book always opens at the top level;
//! - closing the active tab activates its right neighbour, else the last.
//!
//! No tab active means the Project Home is showing.

pub mod location;

use std::collections::VecDeque;

use dr_model::id::{CategoryId, ElementId, MaterialId, NodeId, StorylineId};
use serde::{Deserialize, Serialize};

/// Something a tab can show.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "kebab-case")]
pub enum Target {
    Chapter(NodeId),
    /// 构想 (internal name drift).
    Idea(NodeId),
    Storyline(StorylineId),
    Element(ElementId),
    Category(CategoryId),
    Material(MaterialId),
    /// 通览全书: the whole book in one scroll. One per book.
    Book,
}

impl Target {
    /// The target a [`Target::key`] names.
    pub fn from_key(key: &str) -> Option<Target> {
        if key == "book" {
            return Some(Target::Book);
        }
        let (kind, id) = key.split_once(':')?;
        Some(match kind {
            "chapter" => Target::Chapter(id.parse().ok()?),
            "idea" => Target::Idea(id.parse().ok()?),
            "storyline" => Target::Storyline(id.parse().ok()?),
            "element" => Target::Element(id.parse().ok()?),
            "category" => Target::Category(id.parse().ok()?),
            "material" => Target::Material(id.parse().ok()?),
            _ => return None,
        })
    }

    /// A stable key, unique among a book's targets.
    pub fn key(&self) -> String {
        match self {
            Target::Chapter(id) => format!("chapter:{id}"),
            Target::Idea(id) => format!("idea:{id}"),
            Target::Storyline(id) => format!("storyline:{id}"),
            Target::Element(id) => format!("element:{id}"),
            Target::Category(id) => format!("category:{id}"),
            Target::Material(id) => format!("material:{id}"),
            Target::Book => "book".to_owned(),
        }
    }

    pub fn is_singleton(&self) -> bool {
        matches!(self, Target::Book)
    }
}

/// One side of a split, or a whole tab.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Leaf {
    pub target: Target,
    /// A preview is replaced by the next single-click open.
    pub preview: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Side {
    Left,
    Right,
}

impl Side {
    pub fn other(self) -> Side {
        match self {
            Side::Left => Side::Right,
            Side::Right => Side::Left,
        }
    }
}

/// Two leaves side by side in one tab.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Split {
    pub id: u64,
    pub left: Leaf,
    pub right: Leaf,
    pub focused: Side,
    /// The left pane's share of the width, 0.2–0.8.
    pub ratio: f32,
}

impl Split {
    pub fn side(&self, side: Side) -> &Leaf {
        match side {
            Side::Left => &self.left,
            Side::Right => &self.right,
        }
    }

    fn side_mut(&mut self, side: Side) -> &mut Leaf {
        match side {
            Side::Left => &mut self.left,
            Side::Right => &mut self.right,
        }
    }

    pub fn side_of(&self, target: &Target) -> Option<Side> {
        if &self.left.target == target {
            Some(Side::Left)
        } else if &self.right.target == target {
            Some(Side::Right)
        } else {
            None
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "tab", rename_all = "kebab-case")]
pub enum Tab {
    Leaf(Leaf),
    Split(Split),
}

impl Tab {
    /// Unique among the open tabs: a leaf's target key, `split:<id>`.
    pub fn key(&self) -> String {
        match self {
            Tab::Leaf(leaf) => leaf.target.key(),
            Tab::Split(split) => format!("split:{}", split.id),
        }
    }

    /// The leaf whose page has the focus.
    pub fn focused(&self) -> &Leaf {
        match self {
            Tab::Leaf(leaf) => leaf,
            Tab::Split(split) => split.side(split.focused),
        }
    }

    /// Its one leaf, or a split's two (left first).
    pub fn leaves(&self) -> impl Iterator<Item = &Leaf> {
        let (a, b) = match self {
            Tab::Leaf(leaf) => (leaf, None),
            Tab::Split(split) => (&split.left, Some(&split.right)),
        };
        std::iter::once(a).chain(b)
    }

    pub fn contains(&self, target: &Target) -> bool {
        match self {
            Tab::Leaf(leaf) => &leaf.target == target,
            Tab::Split(split) => split.side_of(target).is_some(),
        }
    }

    fn is_preview_leaf(&self) -> bool {
        matches!(self, Tab::Leaf(leaf) if leaf.preview)
    }
}

/// How [`Navigator::open`] opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Open {
    pub preview: bool,
    pub activate: bool,
    /// The page's title takes the caret, not its text (a chapter just made
    /// with ⁂ 新建下一章: its head focuses the title once drawn, so the
    /// shell does not hand the editor the keyboard).
    pub title: bool,
}

impl Open {
    /// A single click: a preview, brought to the front.
    pub const PREVIEW: Open = Open {
        preview: true,
        activate: true,
        title: false,
    };
    /// A double click, a new entity, a link: kept.
    pub const KEEP: Open = Open {
        preview: false,
        activate: true,
        title: false,
    };

    /// The same, the page's title taking the caret.
    pub const fn at_title(self) -> Open {
        Open {
            title: true,
            ..self
        }
    }
}

/// A place in the history: the home page, or a target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Page {
    Home,
    Target(Target),
}

/// Line numbers of the canonical Markdown view a location link names
/// (`#L12-L18`), handed to the editor to scroll to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lines {
    pub start: u32,
    pub end: Option<u32>,
}

/// The longest history kept.
pub const HISTORY_LIMIT: usize = 100;

/// The tab tree, which tab is active, and the history of pages.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Navigator {
    tabs: Vec<Tab>,
    /// Index into `tabs`; `None` shows the Project Home.
    active: Option<usize>,
    next_split_id: u64,
    #[serde(skip)]
    history: VecDeque<Page>,
    #[serde(skip)]
    cursor: usize,
    /// Lines a location link asked for, for the page being opened.
    #[serde(skip)]
    reveal: Option<(Target, Lines)>,
}

impl Default for Navigator {
    fn default() -> Self {
        Navigator {
            tabs: Vec::new(),
            active: None,
            next_split_id: 1,
            history: VecDeque::from([Page::Home]),
            cursor: 0,
            reveal: None,
        }
    }
}

impl Navigator {
    pub fn tabs(&self) -> &[Tab] {
        &self.tabs
    }

    pub fn active_index(&self) -> Option<usize> {
        self.active
    }

    pub fn active_tab(&self) -> Option<&Tab> {
        self.active.and_then(|i| self.tabs.get(i))
    }

    /// The page on the paper.
    pub fn page(&self) -> Page {
        match self.current() {
            Some(target) => Page::Target(target.clone()),
            None => Page::Home,
        }
    }

    /// The target with the focus, if any (the focused side of a split).
    pub fn current(&self) -> Option<&Target> {
        self.active_tab().map(|tab| &tab.focused().target)
    }

    /// Whether a sidebar cell for `target` is drawn selected. A split's
    /// unfocused side is not: only the page with the focus is "where the
    /// author is".
    pub fn is_selected(&self, target: &Target) -> bool {
        self.current() == Some(target)
    }

    pub fn is_open(&self, target: &Target) -> bool {
        self.tabs.iter().any(|tab| tab.contains(target))
    }

    /// Opens `target` as `how` says. Returns whether anything changed.
    pub fn open(&mut self, target: Target, how: Open) -> bool {
        let before = (self.tabs.clone(), self.active);
        self.open_inner(target, how);
        let changed = (self.tabs.clone(), self.active) != before;
        self.record();
        changed
    }

    /// Opens `target` (kept) and remembers `lines` for its editor.
    pub fn open_at(&mut self, target: Target, lines: Option<Lines>) {
        self.reveal = lines.map(|lines| (target.clone(), lines));
        self.open(target, Open::KEEP);
    }

    /// The lines a link asked for, once, for `target`'s editor.
    pub fn take_reveal(&mut self, target: &Target) -> Option<Lines> {
        match &self.reveal {
            Some((t, _)) if t == target => self.reveal.take().map(|(_, lines)| lines),
            _ => None,
        }
    }

    fn open_inner(&mut self, target: Target, how: Open) {
        // Something already open is activated, including either side of a
        // split that is not active.
        if let Some(index) = self.tabs.iter().position(|tab| tab.contains(&target)) {
            if !how.activate {
                return;
            }
            if let Tab::Split(split) = &mut self.tabs[index]
                && let Some(side) = split.side_of(&target)
            {
                split.focused = side;
            }
            if !how.preview
                && let Some(leaf) = self.leaf_mut(index, &target)
            {
                leaf.preview = false;
            }
            self.active = Some(index);
            return;
        }
        let leaf = Leaf {
            target: target.clone(),
            preview: how.preview,
        };
        // A preview replaces the focused side of the active split, if that
        // side is a preview. The whole book always opens at the top level.
        if how.activate
            && how.preview
            && !target.is_singleton()
            && let Some(index) = self.active
            && let Tab::Split(split) = &mut self.tabs[index]
            && split.side(split.focused).preview
        {
            let focused = split.focused;
            *split.side_mut(focused) = leaf;
            return;
        }
        let index = if how.preview {
            match self.tabs.iter().position(Tab::is_preview_leaf) {
                Some(index) => {
                    self.tabs[index] = Tab::Leaf(leaf);
                    index
                }
                None => {
                    self.tabs.push(Tab::Leaf(leaf));
                    self.tabs.len() - 1
                }
            }
        } else {
            self.tabs.push(Tab::Leaf(leaf));
            self.tabs.len() - 1
        };
        if how.activate {
            self.active = Some(index);
        }
    }

    fn leaf_mut(&mut self, index: usize, target: &Target) -> Option<&mut Leaf> {
        match self.tabs.get_mut(index)? {
            Tab::Leaf(leaf) if &leaf.target == target => Some(leaf),
            Tab::Split(split) => {
                let side = split.side_of(target)?;
                Some(split.side_mut(side))
            }
            _ => None,
        }
    }

    /// Keeps a preview (a double click on its pill or its cell).
    pub fn promote(&mut self, target: &Target) -> bool {
        let Some(index) = self.tabs.iter().position(|tab| tab.contains(target)) else {
            return false;
        };
        match self.leaf_mut(index, target) {
            Some(leaf) if leaf.preview => {
                leaf.preview = false;
                true
            }
            _ => false,
        }
    }

    /// Activates the tab at `index`.
    pub fn activate(&mut self, index: usize) -> bool {
        if index >= self.tabs.len() || self.active == Some(index) {
            return false;
        }
        self.active = Some(index);
        self.record();
        true
    }

    /// The next (`+1`) or previous (`-1`) tab, wrapping.
    pub fn cycle(&mut self, step: i32) -> bool {
        let n = self.tabs.len() as i32;
        if n == 0 {
            return false;
        }
        let from = match self.active {
            Some(i) => i as i32,
            None if step > 0 => -1,
            None => 0,
        };
        let next = (from + step).rem_euclid(n) as usize;
        self.activate(next)
    }

    /// Focuses one side of the split at `index`.
    pub fn focus_side(&mut self, index: usize, side: Side) -> bool {
        let Some(Tab::Split(split)) = self.tabs.get_mut(index) else {
            return false;
        };
        let changed = split.focused != side || self.active != Some(index);
        split.focused = side;
        self.active = Some(index);
        self.record();
        changed
    }

    /// The Project Home: no tab active.
    pub fn go_home(&mut self) -> bool {
        let changed = self.active.is_some();
        self.active = None;
        self.record();
        changed
    }

    /// Closes the tab at `index`. The active tab passes to its right
    /// neighbour, else to the new last tab; with none left, the home page.
    pub fn close(&mut self, index: usize) -> bool {
        if index >= self.tabs.len() {
            return false;
        }
        self.tabs.remove(index);
        self.active = match self.active {
            Some(active) if active == index => {
                if self.tabs.is_empty() {
                    None
                } else {
                    Some(index.min(self.tabs.len() - 1))
                }
            }
            Some(active) if active > index => Some(active - 1),
            other => other,
        };
        self.record();
        true
    }

    /// Closes the active tab (⌘W).
    pub fn close_active(&mut self) -> bool {
        match self.active {
            Some(index) => self.close(index),
            None => false,
        }
    }

    /// Closes one side of a split; the other side becomes the whole tab.
    pub fn close_side(&mut self, index: usize, side: Side) -> bool {
        let Some(Tab::Split(split)) = self.tabs.get(index) else {
            return false;
        };
        let keep = split.side(side.other()).clone();
        self.tabs[index] = Tab::Leaf(keep);
        self.record();
        true
    }

    /// Moves the tab at `from` so it lands at `to` (an index into the list
    /// without it), keeping the active tab active.
    pub fn reorder(&mut self, from: usize, to: usize) -> bool {
        if from >= self.tabs.len() {
            return false;
        }
        let to = to.min(self.tabs.len() - 1);
        if from == to {
            return false;
        }
        let active_key = self.active_tab().map(Tab::key);
        let tab = self.tabs.remove(from);
        self.tabs.insert(to, tab);
        self.active = active_key.and_then(|key| self.tabs.iter().position(|t| t.key() == key));
        true
    }

    /// A pill dragged onto one half of the paper: the active page and the
    /// dragged tab's page share the tab, the dragged one on `side`. A split
    /// active tab gets its `side` replaced. Returns whether a split happened.
    pub fn split_with(&mut self, dragged: usize, side: Side) -> bool {
        let Some(active) = self.active else {
            return false;
        };
        if dragged == active || dragged >= self.tabs.len() {
            return false;
        }
        let incoming = match &self.tabs[dragged] {
            Tab::Leaf(leaf) => leaf.clone(),
            Tab::Split(split) => split.side(split.focused).clone(),
        };
        if incoming.target.is_singleton() && matches!(self.tabs[active], Tab::Split(_)) {
            return false;
        }
        let id = self.next_split_id;
        let replaced = match &self.tabs[active] {
            Tab::Leaf(leaf) => {
                let (left, right) = match side {
                    Side::Left => (incoming, leaf.clone()),
                    Side::Right => (leaf.clone(), incoming),
                };
                self.next_split_id += 1;
                Tab::Split(Split {
                    id,
                    left,
                    right,
                    focused: side,
                    ratio: 0.5,
                })
            }
            Tab::Split(split) => {
                let mut split = split.clone();
                *split.side_mut(side) = incoming;
                split.focused = side;
                Tab::Split(split)
            }
        };
        self.tabs[active] = replaced;
        self.tabs.remove(dragged);
        self.active = Some(if dragged < active { active - 1 } else { active });
        self.record();
        true
    }

    /// Sets a split's width share.
    pub fn set_ratio(&mut self, index: usize, ratio: f32) {
        if let Some(Tab::Split(split)) = self.tabs.get_mut(index) {
            split.ratio = ratio.clamp(0.2, 0.8);
        }
    }

    /// A target was deleted (or trashed): its tabs close and it leaves the
    /// history. The 0.1 client's `closeTabsForEntity`.
    pub fn forget(&mut self, target: &Target) {
        let mut index = 0;
        while index < self.tabs.len() {
            match &self.tabs[index] {
                Tab::Leaf(leaf) if &leaf.target == target => {
                    self.close(index);
                    continue;
                }
                Tab::Split(split) => {
                    if let Some(side) = split.side_of(target) {
                        self.close_side(index, side);
                    }
                }
                _ => {}
            }
            index += 1;
        }
        let gone = Page::Target(target.clone());
        let before = self.cursor;
        let mut kept = VecDeque::new();
        let mut cursor = 0;
        for (i, page) in self.history.drain(..).enumerate() {
            if page == gone {
                continue;
            }
            if kept.back() == Some(&page) {
                continue;
            }
            if i <= before {
                cursor = kept.len();
            }
            kept.push_back(page);
        }
        if kept.is_empty() {
            kept.push_back(Page::Home);
        }
        self.history = kept;
        self.cursor = cursor.min(self.history.len() - 1);
        self.record();
    }

    // History.

    /// Notes the current page, unless it already is the one under the
    /// cursor. Anything forward of the cursor is dropped.
    fn record(&mut self) {
        let page = self.page();
        if self.history.get(self.cursor) == Some(&page) {
            return;
        }
        self.history.truncate(self.cursor + 1);
        self.history.push_back(page);
        while self.history.len() > HISTORY_LIMIT {
            self.history.pop_front();
        }
        self.cursor = self.history.len() - 1;
    }

    pub fn can_go_back(&self) -> bool {
        self.cursor > 0
    }

    pub fn can_go_forward(&self) -> bool {
        self.cursor + 1 < self.history.len()
    }

    /// Back (⌘[): the previous page, opened again as a preview if its tab
    /// was closed.
    pub fn back(&mut self) -> bool {
        if !self.can_go_back() {
            return false;
        }
        self.cursor -= 1;
        self.show_history_page();
        true
    }

    /// Forward (⌘]).
    pub fn forward(&mut self) -> bool {
        if !self.can_go_forward() {
            return false;
        }
        self.cursor += 1;
        self.show_history_page();
        true
    }

    fn show_history_page(&mut self) {
        match self.history[self.cursor].clone() {
            Page::Home => self.active = None,
            Page::Target(target) => self.open_inner(target, Open::PREVIEW),
        }
    }

    pub fn history(&self) -> impl Iterator<Item = &Page> {
        self.history.iter()
    }

    /// Restores a saved tab tree (the per-book layout); targets `exists`
    /// rejects are dropped, the history starts at the restored page.
    pub fn restored(mut saved: Navigator, exists: impl Fn(&Target) -> bool) -> Navigator {
        saved.tabs.retain_mut(|tab| match tab {
            Tab::Leaf(leaf) => exists(&leaf.target),
            Tab::Split(split) => match (exists(&split.left.target), exists(&split.right.target)) {
                (true, true) => true,
                (true, false) => {
                    *tab = Tab::Leaf(split.left.clone());
                    true
                }
                (false, true) => {
                    *tab = Tab::Leaf(split.right.clone());
                    true
                }
                (false, false) => false,
            },
        });
        if saved.active.is_some_and(|i| i >= saved.tabs.len()) {
            saved.active = saved.tabs.len().checked_sub(1);
        }
        let max_split = saved
            .tabs
            .iter()
            .filter_map(|t| match t {
                Tab::Split(s) => Some(s.id),
                _ => None,
            })
            .max()
            .unwrap_or(0);
        saved.next_split_id = saved.next_split_id.max(max_split + 1);
        saved.history = VecDeque::from([saved.page()]);
        saved.cursor = 0;
        saved.reveal = None;
        saved
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(n: u32) -> Target {
        Target::Chapter(NodeId::parse(&format!("c{n}")).unwrap())
    }

    fn el(n: u32) -> Target {
        Target::Element(ElementId::parse(&format!("e{n}")).unwrap())
    }

    fn keys(nav: &Navigator) -> Vec<String> {
        nav.tabs()
            .iter()
            .map(|tab| match tab {
                Tab::Leaf(leaf) if leaf.preview => format!("~{}", leaf.target.key()),
                tab => tab.key(),
            })
            .collect()
    }

    #[test]
    fn a_single_click_replaces_the_preview_and_a_double_click_keeps_it() {
        let mut nav = Navigator::default();
        nav.open(ch(1), Open::PREVIEW);
        nav.open(ch(2), Open::PREVIEW);
        assert_eq!(keys(&nav), ["~chapter:c2"]);
        assert!(nav.promote(&ch(2)));
        nav.open(ch(3), Open::PREVIEW);
        assert_eq!(keys(&nav), ["chapter:c2", "~chapter:c3"]);
        nav.open(el(1), Open::KEEP);
        assert_eq!(keys(&nav), ["chapter:c2", "~chapter:c3", "element:e1"]);
        // Something open is activated, not reopened.
        nav.open(ch(2), Open::PREVIEW);
        assert_eq!(nav.current(), Some(&ch(2)));
        assert_eq!(nav.tabs().len(), 3);
        // Opening a preview tab "kept" keeps it.
        nav.open(ch(3), Open::KEEP);
        assert_eq!(keys(&nav), ["chapter:c2", "chapter:c3", "element:e1"]);
    }

    #[test]
    fn selection_follows_the_focused_side_only() {
        let mut nav = Navigator::default();
        nav.open(ch(1), Open::KEEP);
        nav.open(ch(2), Open::KEEP);
        // Drag tab 1 (c2) onto the right half while c1 is active.
        nav.activate(0);
        assert!(nav.split_with(1, Side::Right));
        assert_eq!(nav.tabs().len(), 1);
        assert!(nav.is_selected(&ch(2)));
        assert!(!nav.is_selected(&ch(1)));
        nav.focus_side(0, Side::Left);
        assert!(nav.is_selected(&ch(1)));
        assert!(nav.is_open(&ch(2)));
    }

    #[test]
    fn a_preview_replaces_only_the_focused_preview_side_of_a_split() {
        let mut nav = Navigator::default();
        nav.open(ch(1), Open::KEEP);
        nav.open(ch(2), Open::PREVIEW);
        nav.activate(0);
        nav.split_with(1, Side::Right);
        // The right side is a preview and focused: a preview replaces it.
        nav.open(ch(3), Open::PREVIEW);
        let Tab::Split(split) = &nav.tabs()[0] else {
            panic!("split")
        };
        assert_eq!(split.right.target, ch(3));
        // The kept left side is never replaced: the preview goes to the top level.
        nav.focus_side(0, Side::Left);
        nav.open(ch(4), Open::PREVIEW);
        assert_eq!(nav.tabs().len(), 2);
        assert_eq!(nav.current(), Some(&ch(4)));
        // The whole book opens at the top level even from a preview side.
        nav.focus_side(0, Side::Right);
        nav.open(Target::Book, Open::PREVIEW);
        assert!(matches!(&nav.tabs()[0], Tab::Split(s) if s.right.target == ch(3)));
    }

    #[test]
    fn closing_the_active_tab_activates_its_right_neighbour_then_home() {
        let mut nav = Navigator::default();
        for n in 1..=3 {
            nav.open(ch(n), Open::KEEP);
        }
        nav.activate(1);
        nav.close_active();
        assert_eq!(nav.current(), Some(&ch(3)));
        nav.close_active();
        assert_eq!(nav.current(), Some(&ch(1)));
        nav.close_active();
        assert_eq!(nav.page(), Page::Home);
        assert!(!nav.close_active());
    }

    #[test]
    fn back_and_forward_walk_the_pages_and_reopen_closed_ones() {
        let mut nav = Navigator::default();
        nav.open(ch(1), Open::KEEP);
        nav.open(ch(2), Open::KEEP);
        nav.go_home();
        assert!(nav.back());
        assert_eq!(nav.current(), Some(&ch(2)));
        assert!(nav.back());
        assert_eq!(nav.current(), Some(&ch(1)));
        assert!(nav.back());
        assert_eq!(nav.page(), Page::Home);
        assert!(!nav.back());
        assert!(nav.forward());
        assert_eq!(nav.current(), Some(&ch(1)));
        // Closed in the meantime: reopened as a preview.
        nav.close(1);
        assert!(nav.forward());
        assert_eq!(nav.current(), Some(&ch(2)));
        nav.back();
        assert_eq!(nav.current(), Some(&ch(1)));
        assert!(matches!(&nav.tabs()[1], Tab::Leaf(l) if l.preview));
        // Going somewhere new drops the forward pages.
        nav.open(el(1), Open::KEEP);
        assert!(!nav.can_go_forward());
    }

    #[test]
    fn the_history_is_bounded() {
        let mut nav = Navigator::default();
        for n in 0..(HISTORY_LIMIT as u32 + 20) {
            nav.open(ch(n), Open::PREVIEW);
        }
        assert_eq!(nav.history().count(), HISTORY_LIMIT);
    }

    #[test]
    fn reordering_keeps_the_active_tab() {
        let mut nav = Navigator::default();
        for n in 1..=4 {
            nav.open(ch(n), Open::KEEP);
        }
        nav.activate(1);
        assert!(nav.reorder(0, 3));
        assert_eq!(
            keys(&nav),
            ["chapter:c2", "chapter:c3", "chapter:c4", "chapter:c1"]
        );
        assert_eq!(nav.current(), Some(&ch(2)));
        assert!(nav.cycle(-1));
        assert_eq!(nav.current(), Some(&ch(1)));
        assert!(nav.cycle(1));
        assert_eq!(nav.current(), Some(&ch(2)));
    }

    #[test]
    fn a_deleted_target_closes_its_tabs_and_leaves_the_history() {
        let mut nav = Navigator::default();
        nav.open(ch(1), Open::KEEP);
        nav.open(ch(2), Open::KEEP);
        nav.open(ch(3), Open::KEEP);
        nav.activate(0);
        nav.split_with(2, Side::Right);
        nav.forget(&ch(3));
        assert_eq!(keys(&nav), ["chapter:c1", "chapter:c2"]);
        nav.forget(&ch(1));
        assert!(nav.history().all(|p| p != &Page::Target(ch(1))));
        nav.back();
        assert_ne!(nav.current(), Some(&ch(1)));
    }

    #[test]
    fn a_location_link_carries_its_lines_to_the_page_once() {
        let mut nav = Navigator::default();
        nav.open_at(
            ch(1),
            Some(Lines {
                start: 12,
                end: Some(18),
            }),
        );
        assert_eq!(nav.current(), Some(&ch(1)));
        assert_eq!(nav.take_reveal(&ch(2)), None);
        assert_eq!(
            nav.take_reveal(&ch(1)),
            Some(Lines {
                start: 12,
                end: Some(18)
            })
        );
        assert_eq!(nav.take_reveal(&ch(1)), None);
    }

    #[test]
    fn a_saved_tree_restores_without_targets_that_are_gone() {
        let mut nav = Navigator::default();
        nav.open(ch(1), Open::KEEP);
        nav.open(ch(2), Open::KEEP);
        nav.open(ch(3), Open::KEEP);
        nav.activate(0);
        nav.split_with(1, Side::Left);
        let json = serde_json::to_string(&nav).unwrap();
        let saved: Navigator = serde_json::from_str(&json).unwrap();
        let restored = Navigator::restored(saved, |t| t != &ch(2));
        assert_eq!(keys(&restored), ["chapter:c1", "chapter:c3"]);
        assert_eq!(restored.page(), Page::Target(ch(1)));
        assert!(!restored.can_go_back());
    }
}
