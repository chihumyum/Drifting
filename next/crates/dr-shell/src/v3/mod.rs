//! V3 composition contracts. Renderers own editing; the shell owns ordering,
//! navigation, the snapshot and the lifetime of each rendered part.
use crate::{
    book::Book,
    nav::{Lines, Target},
    pages::PageViewHost,
};
use dr_workspace::commands::v3::types::ModuleSpec;
use gpui::{AnyElement, AnyView, App, FocusHandle, Global, Window};
use std::{collections::BTreeMap, rc::Rc};

pub mod card;
mod drag;
mod editor;
pub mod history;
pub mod level_switch;
pub mod manage;
pub mod mark;
pub mod page;
pub mod sidebar;
pub mod tab_fill;
pub mod tabs;
pub mod template_structure;
pub mod trash;

pub use crate::workspace::review::register_entry_comment_card;
pub use drag::{EntryDrag, TimelineClipDrag};
pub use editor::{register_editor, register_editor_status};
pub(crate) use editor::{registered_editor, registered_editor_status};

/// Unread prose edit badge kind surfaced on sidebar rows, folded levels, and tabs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnreadBadge {
    Agent,
    External,
}

/// Reads unread Agent / External prose edit badges for every entry in `lib`'s
/// open `AgentMarks` ledger without mutating state.
pub fn unread_badges(lib: &dr_workspace::Workspace, cx: &App) -> BTreeMap<String, UnreadBadge> {
    let Some(ledger) = dr_editor::decor::AgentMarks::peek(lib, cx) else {
        return BTreeMap::new();
    };
    ledger
        .read(cx)
        .all_unread_entries()
        .into_iter()
        .map(|(id, kind)| {
            let badge = match kind {
                dr_editor::decor::MarkKind::External => UnreadBadge::External,
                dr_editor::decor::MarkKind::New | dr_editor::decor::MarkKind::Changed => {
                    UnreadBadge::Agent
                }
            };
            (id, badge)
        })
        .collect()
}

/// Returns the dominant unread badge for `entry` or any live descendant/member
/// living beneath it (used for sidebar group rollups).
pub fn entry_or_subtree_badge(
    v: &crate::book::v3::BookV3,
    entry: &str,
    badges: &BTreeMap<String, UnreadBadge>,
) -> Option<UnreadBadge> {
    if badges.is_empty() {
        return None;
    }
    let mut best: Option<UnreadBadge> = None;
    let mut stack = vec![entry];
    let mut visited = std::collections::HashSet::new();
    while let Some(cur) = stack.pop() {
        if !visited.insert(cur) {
            continue;
        }
        if let Some(&b) = badges.get(cur) {
            if b == UnreadBadge::External {
                return Some(UnreadBadge::External);
            }
            best = Some(UnreadBadge::Agent);
        }
        if let Some(level) = v.levels.get(cur) {
            for child in &level.children {
                stack.push(child.as_str());
            }
            for member in &level.members {
                stack.push(member.as_str());
            }
        }
    }
    best
}

/// Returns whether a left-sidebar Tab's mount contains any unread Agent/External edits.
pub fn tab_has_unread(
    v: &crate::book::v3::BookV3,
    mount: &dr_workspace::commands::v3::types::TabMount,
    badges: &BTreeMap<String, UnreadBadge>,
) -> bool {
    if badges.is_empty() {
        return false;
    }
    match mount {
        dr_workspace::commands::v3::types::TabMount::Root => {
            v.entries.iter().any(|e| badges.contains_key(&e.id))
        }
        dr_workspace::commands::v3::types::TabMount::Entry { entry } => {
            entry_or_subtree_badge(v, entry, badges).is_some()
        }
        dr_workspace::commands::v3::types::TabMount::Book => {
            v.book_entries().iter().any(|id| badges.contains_key(id))
        }
        dr_workspace::commands::v3::types::TabMount::View { .. } => false,
    }
}

/// Compact word count formatter for narrow sidebar rows (`342`, `1.2k`, `12k`).
pub fn format_short_words(words: u64) -> String {
    if words >= 10_000 {
        format!("{}k", words / 1_000)
    } else if words >= 1_000 {
        format!("{:.1}k", words as f64 / 1_000.0)
    } else {
        words.to_string()
    }
}

#[derive(Clone)]
pub struct ModuleHost {
    pub page: PageViewHost,
    pub entry: String,
    pub module: ModuleSpec,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplaySurface {
    /// An entry page's 「下面的条目」: the entries living under it.
    Page,
    /// An entry page's 「挂在这里的条目」: the entries attached to it that
    /// do not also live under it (`kernel-v5.md` §16 「条目页」).
    Members,
    /// A left-column Tab: the tree, the level itself first.
    Sidebar,
    /// A book Tab's flat sequence, shown as grid or board while filled.
    BookTab,
}

impl DisplaySurface {
    pub fn is_sidebar(self) -> bool {
        matches!(self, Self::Sidebar | Self::BookTab)
    }
}

/// The entry an entry page's head or one of its head parts is drawn for.
#[derive(Clone)]
pub struct EntryHost {
    pub page: PageViewHost,
    pub entry: String,
    /// The entry page the head is drawn on (invalid when drawn alone).
    pub entry_page: gpui::WeakEntity<page::EntryPage>,
}

#[derive(Clone)]
pub struct LevelHost {
    pub page: PageViewHost,
    pub level: String,
    pub surface: DisplaySurface,
}

/// A stateful view is constructed once per part, retained while its tab is
/// open, and refreshed only when the book snapshot changes. Its refresh hook
/// must accept module/template changes without overwriting pending editor input.
pub type Refresh = Rc<dyn Fn(Rc<Book>, &mut App)>;
pub type Reveal = Rc<dyn Fn(Option<Lines>, &mut Window, &mut App)>;
/// Hands a part the page it is drawn in (an entry page): its scroll, for a
/// part as tall as its content that keeps something in view itself (a
/// body's caret), and the flag such a part raises when it scrolls the page
/// for the author ([`gpui_prose::render::PageScroll`]).
pub type GivePageScroll = Rc<dyn Fn(gpui_prose::render::PageScroll, &mut App)>;

#[derive(Clone)]
pub struct Rendered {
    pub view: AnyView,
    pub focus: Option<FocusHandle>,
    pub refresh: Option<Refresh>,
    pub reveal: Option<Reveal>,
    pub page_scroll: Option<GivePageScroll>,
    /// Called when the shell takes the part away while it is still
    /// wanted (the structure's floating panel closing), so what it holds
    /// is stored rather than dropped. Not called when its thing is gone.
    pub leave: Option<Leave>,
    /// A left-column Tab's tree the keyboard walks (KB): the shell gives it
    /// the keyboard with this, and it lands on the row of the page in front
    /// (or the nearest row shown above it, or its first row). A part
    /// without it (a board, islands) leaves the keyboard on the Tab row.
    pub land: Option<Land>,
    /// Where the keyboard is in that tree, for the debug bridge.
    pub keyboard_state: Option<KeyboardState>,
    /// What a module puts at the right end of its title row on the entry
    /// page (the key-value table's 「新增字段」), instead of a second title
    /// row of its own (UP, kernel-v5 §15 item 50).
    pub head_action: Option<HeadAction>,
    /// Optional scrollbar tick strip (find/comment/Agent marks) pinned on the
    /// right edge of the EntryPage scroll viewport when the module flows in page.
    pub tick_strip: Option<TickStrip>,
    /// Optional Collapse-All / Expand-All handler for sidebar tree displays.
    pub toggle_collapse_all: Option<ToggleCollapseAll>,
    /// Optional layered Escape dismissal hook for filled canvases (returns
    /// `true` if an inner overlay/sheet/mode was dismissed, keeping Fill open).
    pub close_panel: Option<ClosePanel>,
}
pub type ToggleCollapseAll = Rc<dyn Fn(&mut App)>;
pub type ClosePanel = Rc<dyn Fn(&mut App) -> bool>;
pub type Leave = Rc<dyn Fn(&mut App)>;
pub type HeadAction = Rc<dyn Fn(&Window, &App) -> AnyElement>;
pub type TickStrip = Rc<dyn Fn(&mut Window, &mut App) -> Option<AnyElement>>;
pub type Land = Rc<dyn Fn(&mut Window, &mut App)>;
pub type KeyboardState = Rc<dyn Fn(&Window, &App) -> serde_json::Value>;
impl Rendered {
    pub fn new(view: impl Into<AnyView>) -> Self {
        Self {
            view: view.into(),
            focus: None,
            refresh: None,
            reveal: None,
            page_scroll: None,
            leave: None,
            land: None,
            keyboard_state: None,
            head_action: None,
            tick_strip: None,
            toggle_collapse_all: None,
            close_panel: None,
        }
    }
    /// Registers a Collapse-All / Expand-All handler for sidebar tree displays.
    pub fn on_toggle_collapse_all(mut self, f: impl Fn(&mut App) + 'static) -> Self {
        self.toggle_collapse_all = Some(Rc::new(f));
        self
    }
    /// Registers an Escape handler for inner floating panels inside a filled canvas.
    pub fn on_close_panel(mut self, f: impl Fn(&mut App) -> bool + 'static) -> Self {
        self.close_panel = Some(Rc::new(f));
        self
    }
    /// Optional tick strip rendered along the right edge of EntryPage.
    pub fn on_tick_strip(
        mut self,
        f: impl Fn(&mut Window, &mut App) -> Option<AnyElement> + 'static,
    ) -> Self {
        self.tick_strip = Some(Rc::new(f));
        self
    }
    /// Something at the right end of the module's title row
    /// ([`Rendered::head_action`]).
    pub fn with_head_action(mut self, f: impl Fn(&Window, &App) -> AnyElement + 'static) -> Self {
        self.head_action = Some(Rc::new(f));
        self
    }
    /// Where the keyboard is in this part, for the debug bridge.
    pub fn on_keyboard_state(
        mut self,
        f: impl Fn(&Window, &App) -> serde_json::Value + 'static,
    ) -> Self {
        self.keyboard_state = Some(Rc::new(f));
        self
    }
    /// The keyboard lands in this part ([`Rendered::land`]).
    pub fn on_land(mut self, f: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.land = Some(Rc::new(f));
        self
    }
    pub fn on_leave(mut self, f: impl Fn(&mut App) + 'static) -> Self {
        self.leave = Some(Rc::new(f));
        self
    }
    pub fn focus(mut self, focus: FocusHandle) -> Self {
        self.focus = Some(focus);
        self
    }
    pub fn on_refresh(mut self, f: impl Fn(Rc<Book>, &mut App) + 'static) -> Self {
        self.refresh = Some(Rc::new(f));
        self
    }
    pub fn on_reveal(mut self, f: impl Fn(Option<Lines>, &mut Window, &mut App) + 'static) -> Self {
        self.reveal = Some(Rc::new(f));
        self
    }
    pub fn on_page_scroll(
        mut self,
        f: impl Fn(gpui_prose::render::PageScroll, &mut App) + 'static,
    ) -> Self {
        self.page_scroll = Some(Rc::new(f));
        self
    }
}

type ModuleMaker = Rc<dyn Fn(ModuleHost, &mut Window, &mut App) -> Rendered>;
type TabCanvasMaker = Rc<dyn Fn(tab_fill::TabCanvasHost, &mut Window, &mut App) -> Rendered>;
type DisplayMaker = Rc<dyn Fn(LevelHost, &mut Window, &mut App) -> Rendered>;
type ActionMaker =
    Rc<dyn Fn(&Target, &crate::pages::PageMenuHost, &App) -> Option<crate::pages::RunRow>>;
type CardMaker = Rc<dyn Fn(&Target, &crate::pages::PageMenuHost, &App) -> crate::pages::CardRows>;
type CompactTemplateEditor = Rc<dyn Fn(CompactTemplate, &mut Window, &mut App) -> Option<Rendered>>;
type TemplateCreator = Rc<dyn Fn(PageViewHost, &mut Window, &mut App)>;
type HeadMaker = Rc<dyn Fn(EntryHost, &mut Window, &mut App) -> Rendered>;
type EntryOverlayMaker = Rc<dyn Fn(EntryHost, &mut App) -> AnyView>;
type HeadPartMaker = Rc<dyn Fn(EntryHost, &mut Window, &mut App) -> Option<Rendered>>;
#[derive(Default)]
struct Registry {
    modules: BTreeMap<String, ModuleMaker>,
    displays: BTreeMap<String, DisplayMaker>,
    tab_canvas: Option<TabCanvasMaker>,
    settings: Option<DisplayMaker>,
    head: Option<HeadMaker>,
    head_parts: Vec<HeadPartMaker>,
    entry_overlay: Option<EntryOverlayMaker>,
    actions: BTreeMap<card::EntryAction, ActionMaker>,
    cards: Vec<CardMaker>,
    template_creator: Option<TemplateCreator>,
    compact_template_editor: Option<CompactTemplateEditor>,
}
impl Global for Registry {}

/// Register once at application initialization. Open string kinds preserve
/// forward compatibility with future module definitions.
pub fn add_module_view(
    cx: &mut App,
    kind: impl Into<String>,
    make: impl Fn(ModuleHost, &mut Window, &mut App) -> Rendered + 'static,
) {
    if !cx.has_global::<Registry>() {
        cx.set_global(Registry::default());
    }
    cx.global_mut::<Registry>()
        .modules
        .insert(kind.into(), Rc::new(make));
}
pub fn add_level_display(
    cx: &mut App,
    display: impl Into<String>,
    make: impl Fn(LevelHost, &mut Window, &mut App) -> Rendered + 'static,
) {
    if !cx.has_global::<Registry>() {
        cx.set_global(Registry::default());
    }
    cx.global_mut::<Registry>()
        .displays
        .insert(display.into(), Rc::new(make));
}
/// The third part of a level page: its settings with their effective values
/// and sources (G2). One maker for every level; the page keeps the instance
/// while the entry stays a level and calls its `on_refresh` on each snapshot.
pub fn add_level_settings(
    cx: &mut App,
    make: impl Fn(LevelHost, &mut Window, &mut App) -> Rendered + 'static,
) {
    cx.default_global::<Registry>().settings = Some(Rc::new(make));
}

/// An entry page's head: its mark and its title, both editable, and the name
/// of its template under them (`kernel-v5.md` §8; the shell's own head draws
/// them read-only until one is registered). One maker for every entry; the
/// page keeps the instance and calls its `on_refresh` on each snapshot.
pub fn add_entry_head(
    cx: &mut App,
    make: impl Fn(EntryHost, &mut Window, &mut App) -> Rendered + 'static,
) {
    cx.default_global::<Registry>().head = Some(Rc::new(make));
}

pub fn entry_head(host: EntryHost, window: &mut Window, cx: &mut App) -> Option<Rendered> {
    let make = cx.try_global::<Registry>()?.head.clone()?;
    Some(make(host, window, cx))
}

/// Something drawn under an entry page's head for the entries it applies to
/// (a lane's colour). Asked while the page has none from it; the view it
/// gives draws nothing once it no longer applies.
pub fn add_entry_head_part(
    cx: &mut App,
    make: impl Fn(EntryHost, &mut Window, &mut App) -> Option<Rendered> + 'static,
) {
    cx.default_global::<Registry>()
        .head_parts
        .push(Rc::new(make));
}

pub(crate) fn entry_head_parts(cx: &App) -> Vec<HeadPartMaker> {
    cx.try_global::<Registry>()
        .map(|r| r.head_parts.clone())
        .unwrap_or_default()
}

/// Registers a view drawn above an entry page's scrolling modules.
pub fn add_entry_overlay(cx: &mut App, make: impl Fn(EntryHost, &mut App) -> AnyView + 'static) {
    cx.default_global::<Registry>().entry_overlay = Some(Rc::new(make));
}

fn entry_overlay(host: EntryHost, cx: &mut App) -> Option<AnyView> {
    let make = cx.try_global::<Registry>()?.entry_overlay.clone()?;
    Some(make(host, cx))
}

pub fn level_settings(host: LevelHost, window: &mut Window, cx: &mut App) -> Option<Rendered> {
    let make = cx.try_global::<Registry>()?.settings.clone()?;
    Some(make(host, window, cx))
}

pub fn module_view(host: ModuleHost, window: &mut Window, cx: &mut App) -> Option<Rendered> {
    let make = cx
        .try_global::<Registry>()?
        .modules
        .get(&host.module.kind)?
        .clone();
    Some(make(host, window, cx))
}
pub fn level_display(host: LevelHost, window: &mut Window, cx: &mut App) -> Option<Rendered> {
    let kind = host
        .page
        .book
        .v3()?
        .levels
        .get(&host.level)?
        .settings
        .display
        .clone();
    level_display_as(host, &kind, window, cx)
}

/// The display registered as `kind`, for `host` (the outermost entries,
/// which are no level of their own, are a list: [`ROOT_LEVEL`]).
pub fn level_display_as(
    host: LevelHost,
    kind: &str,
    window: &mut Window,
    cx: &mut App,
) -> Option<Rendered> {
    let make = cx.try_global::<Registry>()?.displays.get(kind)?.clone();
    Some(make(host, window, cx))
}

/// Registers the canvases for the Island and Relation choices of a left Tab.
pub fn set_tab_canvas(
    cx: &mut App,
    make: impl Fn(tab_fill::TabCanvasHost, &mut Window, &mut App) -> Rendered + 'static,
) {
    cx.default_global::<Registry>().tab_canvas = Some(Rc::new(make));
}

pub fn tab_canvas(
    host: tab_fill::TabCanvasHost,
    window: &mut Window,
    cx: &mut App,
) -> Option<Rendered> {
    let make = cx.try_global::<Registry>()?.tab_canvas.clone()?;
    Some(make(host, window, cx))
}

/// The [`LevelHost::level`] of the outermost entries (a Tab mounted on the
/// root, `kernel-v5.md` §5): they live under no entry.
pub const ROOT_LEVEL: &str = "";
pub fn entry_target(id: &str) -> Option<Target> {
    Some(Target::Entry {
        id: id.parse().ok()?,
        module: None,
    })
}

/// G2 supplies the picker opened by the common card row. Return None when the
/// action does not apply; no no-op callback is needed for a disabled row.
pub fn add_entry_action(
    cx: &mut App,
    action: card::EntryAction,
    make: impl Fn(&Target, &crate::pages::PageMenuHost, &App) -> Option<crate::pages::RunRow> + 'static,
) {
    cx.default_global::<Registry>()
        .actions
        .insert(action, Rc::new(make));
}
pub fn entry_action(
    action: card::EntryAction,
    target: &Target,
    host: &crate::pages::PageMenuHost,
    cx: &App,
) -> Option<crate::pages::RunRow> {
    cx.try_global::<Registry>()?.actions.get(&action)?(target, host, cx)
}
/// Additional card rows, composed with the rows supplied by a particular view.
pub fn add_entry_card_rows(
    cx: &mut App,
    make: impl Fn(&Target, &crate::pages::PageMenuHost, &App) -> crate::pages::CardRows + 'static,
) {
    cx.default_global::<Registry>().cards.push(Rc::new(make));
}
pub fn entry_card_rows(
    target: &Target,
    host: &crate::pages::PageMenuHost,
    cx: &App,
) -> crate::pages::CardRows {
    let mut out = crate::pages::CardRows::default();
    if let Some(registry) = cx.try_global::<Registry>() {
        for make in &registry.cards {
            let rows = make(target, host, cx);
            out.lead.extend(rows.lead);
            out.before_danger.extend(rows.before_danger);
        }
    }
    out
}
/// K5 supplies the new-template flow. The collection button is disabled until
/// it is registered; editing an existing template uses `Target::Template`.
pub fn add_template_creator(
    cx: &mut App,
    create: impl Fn(PageViewHost, &mut Window, &mut App) + 'static,
) {
    cx.default_global::<Registry>().template_creator = Some(Rc::new(create));
}
pub fn has_template_creator(cx: &App) -> bool {
    cx.try_global::<Registry>()
        .is_some_and(|r| r.template_creator.is_some())
}
pub fn create_template(host: PageViewHost, window: &mut Window, cx: &mut App) {
    if let Some(create) = cx
        .try_global::<Registry>()
        .and_then(|r| r.template_creator.clone())
    {
        create(host, window, cx);
    }
}

/// Opens a template's full editor, by its id.
pub type OpenTemplate = Rc<dyn Fn(String, &mut Window, &mut App)>;
/// A new template was stored under this id.
pub type TemplateStored = Rc<dyn Fn(String, &mut App)>;

/// What the structure's floating panel gives the settings-only template
/// editor (`kernel-v5.md` §9 「在结构里改」).
#[derive(Clone)]
pub struct CompactTemplate {
    pub page: PageViewHost,
    /// The template; `None` for a new one, written only once the author
    /// changes something in it.
    pub template: Option<String>,
    /// 「完整编辑」: opens the stored template's full editor.
    pub full: OpenTemplate,
    /// Esc in one of its fields: the panel closes.
    pub close: crate::pages::RunRow,
    /// A new template was stored under this id.
    pub created: TemplateStored,
}

/// Registers the settings-only version of the template editor.
pub fn add_compact_template_editor(
    cx: &mut App,
    make: impl Fn(CompactTemplate, &mut Window, &mut App) -> Option<Rendered> + 'static,
) {
    cx.default_global::<Registry>().compact_template_editor = Some(Rc::new(make));
}

pub fn compact_template_editor(
    host: CompactTemplate,
    window: &mut Window,
    cx: &mut App,
) -> Option<Rendered> {
    let make = cx
        .try_global::<Registry>()?
        .compact_template_editor
        .clone()?;
    make(host, window, cx)
}
