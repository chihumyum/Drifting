//! An entry's page (`kernel-v5.md` §8, §16 「条目页」): one head (its mark
//! and its title, both editable, the template's name under them), what is
//! drawn under the head for some entries (a lane's colour), its modules in
//! its template's order, and two blocks whose switches are their heads:
//! 「下面的条目」 (`层级`: what lives under it) and 「挂在这里的条目」
//! (`收别处的条目`: what is attached to it). A block whose switch is off is
//! its head alone. Renderers own editing; the page owns the order and the
//! lifetime of each part.
pub use super::level_switch::{
    SwitchInspection, TurnOffLevelDialog, inspect_level_switch, toggle_level,
};
use super::{
    DisplaySurface, EntryHost, LevelHost, ModuleHost, Rendered,
    card::EntryAction,
    level_switch::{host_still_valid, toast_save_failed},
};
use crate::{
    book::Book,
    nav::{Lines, Open, Target},
    pages::{PageMenuHost, PageViewHost},
    strings::{t, tf},
};
use dr_i18n::keys;
use dr_ui::{
    Theme,
    components::{
        Button, Switch,
        menu::RowIcon,
        select::{Choice, Select},
    },
    fonts::Role as FontRole,
    sand::{self, Icon, KindMark},
    style::DrStyled,
};
use dr_workspace::{Actor, WritePreconditions, commands::v3::types::ModuleSpec};
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::{collections::BTreeMap, rc::Rc};

/// The composition state is also the debug bridge's contract. It describes
/// the parts actually mounted by this view, in the same order as the window.
#[derive(Clone, serde::Serialize)]
pub struct Section {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub registered: bool,
    /// A block's display (列表、网格、看板、岛屿) while its switch is on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
}

/// The two blocks of an entry page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Block {
    /// 「下面的条目」: what lives under the entry; its switch is `层级`.
    Below,
    /// 「挂在这里的条目」: what is attached to it; its switch is
    /// `收别处的条目`.
    Attached,
}

impl Block {
    /// The page's part that lists the block's entries.
    fn part(self) -> &'static str {
        match self {
            Block::Below => "display",
            Block::Attached => "members",
        }
    }
    /// Its section's kind, and the module kind that places it.
    pub fn kind(self) -> &'static str {
        match self {
            Block::Below => "children",
            Block::Attached => "members",
        }
    }
    fn surface(self) -> DisplaySurface {
        match self {
            Block::Below => DisplaySurface::Page,
            Block::Attached => DisplaySurface::Members,
        }
    }
    fn of(kind: &str) -> Option<Block> {
        match kind {
            "children" => Some(Block::Below),
            "members" => Some(Block::Attached),
            _ => None,
        }
    }
    /// Whether the block's switch is on for `id`.
    pub fn on(self, book: &Book, id: &str) -> bool {
        let Some(v) = book.v3() else {
            return false;
        };
        match self {
            Block::Below => v.entry(id).is_some_and(|e| e.level),
            Block::Attached => v.accepts_members(id),
        }
    }
}

pub struct EntryPage {
    host: PageViewHost,
    target: Target,
    pub focus: FocusHandle,
    scroll: ScrollHandle,
    parts: BTreeMap<String, (String, Rendered)>,
    pub sections: Vec<Section>,
    pub revealed: Option<Lines>,
    pub synced: bool,
    pending_reveal: bool,
    /// The section a target named (`entry:<id>/<module>`), kept in view while
    /// the page settles (a body loads and grows to its text's height) until
    /// the author scrolls, clicks or types in the page, or a body scrolls it
    /// for them (`author_scrolled`).
    pinned: Option<String>,
    /// Raised by a body that scrolled the page for the author (to its caret,
    /// to a position): the page is theirs again.
    author_scrolled: Rc<std::cell::Cell<bool>>,
    /// The module an open asked for after the page was made (one page per
    /// entry: the page was open under another of the entry's targets). It
    /// is where the page reveals and what takes typing.
    asked: Option<String>,
    _review_focus: Subscription,
}
impl EntryPage {
    pub fn new(host: PageViewHost, target: Target, cx: &mut Context<Self>) -> Self {
        let review_focus = cx.observe_global::<crate::ReviewFocus>(|_, cx| cx.notify());
        Self {
            host,
            target,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            parts: BTreeMap::new(),
            sections: Vec::new(),
            revealed: None,
            synced: false,
            pending_reveal: true,
            pinned: None,
            author_scrolled: Rc::default(),
            asked: None,
            _review_focus: review_focus,
        }
    }
    pub fn refresh(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        self.host.book = book.clone();
        self.synced = false;
        if let Target::Entry { id, .. } = &self.target
            && let Some(v3) = book.v3()
        {
            let id = id.as_str();
            self.parts.retain(|key, (kind, _)| {
                if let Some(block) = [Block::Below, Block::Attached]
                    .into_iter()
                    .find(|b| b.part() == key)
                {
                    return block.on(&book, id)
                        && v3
                            .levels
                            .get(id)
                            .is_some_and(|l| l.settings.display == *kind);
                }
                if key == "settings" {
                    return v3.has_below(id);
                }
                if key == "head" || key.starts_with("head-part:") {
                    return true;
                }
                v3.template_of(id).is_some_and(|t| {
                    t.modules.iter().any(|m| {
                        Block::of(&m.kind).is_none()
                            && key == &format!("module:{}", m.id)
                            && m.kind == *kind
                    })
                })
            });
        }
        for (_, part) in self.parts.values() {
            if let Some(refresh) = &part.refresh {
                refresh(book.clone(), cx);
            }
        }
        cx.notify();
    }
    pub fn reveal(&mut self, lines: Lines, cx: &mut Context<Self>) {
        self.revealed = Some(lines);
        self.pending_reveal = true;
        cx.notify();
    }
    /// Brings `module`'s section into view, as when the page opens at it:
    /// the entry's page was already open under another of its targets.
    pub fn show_module(&mut self, module: String, cx: &mut Context<Self>) {
        self.asked = Some(module.clone());
        self.pinned = Some(module);
        cx.notify();
    }
    /// Reveals `lines` in `module`'s body (or the module the page was opened
    /// at): a location asked for on a page already open.
    pub fn reveal_in(&mut self, module: Option<String>, lines: Lines, cx: &mut Context<Self>) {
        if module.is_some() {
            self.asked = module;
        }
        self.reveal(lines, cx);
    }
    /// The section kept in view while the page settles, if any.
    pub fn pinned(&self) -> Option<&str> {
        self.pinned.as_deref()
    }
    /// The author took the page (a scroll, a press, a key): the section is
    /// no longer held in view.
    pub fn release_pin(&mut self, cx: &mut Context<Self>) {
        if self.pinned.take().is_some() {
            cx.notify();
        }
    }
    /// Brings the page's child `ix` (a section) into view at the next frame,
    /// once the page has been laid out with it: one that fits as little as
    /// needed to show all of it; one taller than the page (a body as tall as
    /// its text) only if its top is not showing, to its top, so the page head
    /// stays above a body that starts on screen. Nothing is asked of GPUI
    /// while the section shows: its request is carried out at the next
    /// prepaint, by the section's size then (a body that loaded in between
    /// would be put at the top).
    fn show_section(&self, ix: usize) {
        let view = self.scroll.bounds();
        let Some(item) = self.scroll.bounds_for_item(ix) else {
            return;
        };
        let offset = self.scroll.offset().y;
        let (top, bottom) = (item.top() + offset, item.bottom() + offset);
        if item.size.height > view.size.height {
            if top < view.top() || top >= view.bottom() {
                self.scroll.scroll_to_top_of_item(ix);
            }
        } else if top < view.top() || bottom > view.bottom() {
            self.scroll.scroll_to_item(ix);
        }
    }
    /// The requested module, otherwise the first prose editor, takes typing
    /// when its tab returns to the front. Placeholders use the page's handle.
    pub fn preferred_focus(&self) -> FocusHandle {
        let selected = self.asked.as_deref().or(match &self.target {
            Target::Entry { module, .. } => module.as_ref().map(|m| m.as_str()),
            _ => None,
        });
        let section = match selected {
            Some(id) => self.sections.iter().find(|s| s.id == id),
            None => self.sections.iter().find(|s| s.kind == "prose"),
        };
        section
            .and_then(|s| self.parts.get(&format!("module:{}", s.id)))
            .and_then(|(_, part)| part.focus.clone())
            .unwrap_or_else(|| self.focus.clone())
    }
    /// Only the module views currently retained by this particular page.
    pub(crate) fn editor_views(&self) -> Vec<(String, EntityId)> {
        self.sections
            .iter()
            .filter_map(|section| {
                let (_, part) = self.parts.get(&format!("module:{}", section.id))?;
                Some((section.id.clone(), part.view.entity_id()))
            })
            .collect()
    }
    pub fn state(&self) -> serde_json::Value {
        serde_json::json!({ "target": self.target.key(), "sections": self.sections, "module": match &self.target { Target::Entry { module, .. } => module.as_ref().map(ToString::to_string), _ => None }, "reveal": self.revealed, "head": self.parts.contains_key("head") })
    }
    fn entry_host(&self, id: &str, cx: &Context<Self>) -> EntryHost {
        EntryHost {
            page: self.host.clone(),
            entry: id.to_owned(),
            entry_page: cx.entity().downgrade(),
        }
    }
    /// What takes the caret when the head hands it to the text: the first
    /// body's, if the entry has one.
    pub fn body_focus(&self) -> Option<FocusHandle> {
        self.sections
            .iter()
            .filter(|s| s.kind == "prose")
            .find_map(|s| self.parts.get(&format!("module:{}", s.id)))
            .and_then(|(_, part)| part.focus.clone())
    }
    fn mount_module(
        &mut self,
        id: &str,
        module: ModuleSpec,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = format!("module:{}", module.id);
        if self
            .parts
            .get(&key)
            .is_some_and(|(kind, _)| kind != &module.kind)
        {
            self.parts.remove(&key);
        }
        if !self.parts.contains_key(&key)
            && let Some(part) = super::module_view(
                ModuleHost {
                    page: self.host.clone(),
                    entry: id.into(),
                    module: module.clone(),
                },
                window,
                cx,
            )
        {
            if let Some(page_scroll) = &part.page_scroll {
                page_scroll(
                    gpui_prose::render::PageScroll {
                        handle: self.scroll.clone(),
                        for_author: self.author_scrolled.clone(),
                    },
                    cx,
                );
            }
            self.parts.insert(key.clone(), (module.kind.clone(), part));
        }
        self.sections.push(Section {
            id: module.id,
            kind: module.kind,
            name: module.name,
            registered: self.parts.contains_key(&key),
            display: None,
        });
    }
    fn render_module(&self, module: &Section, window: &Window, cx: &App) -> AnyElement {
        let key = format!("module:{}", module.id);
        let theme = Theme::of(window, cx);
        let selector = format!("v3-section-{}", module.id);
        let entry_id = match &self.target {
            Target::Entry { id, .. } => Some(id.as_str()),
            _ => None,
        };
        let mod_comments = entry_id
            .and_then(|eid| {
                self.host
                    .book
                    .v3()
                    .map(|b| b.module_header_comments(eid, &module.id))
            })
            .unwrap_or_default();
        let mod_ul = crate::comment_underline(
            SharedString::from(format!("v3-mod-ul-{}", module.id)),
            mod_comments,
            self.host.workspace.clone(),
            cx,
        );
        let head_group: SharedString = format!("v3-mod-head-{}", module.id).into();
        let comment_btn = entry_id.map(|eid| {
            let ws = self.host.workspace.clone();
            let eid = eid.to_owned();
            let mid = module.id.clone();
            let label = t(cx, keys::v3_review::WRITE_COMMENT);
            div()
                .id(SharedString::from(format!("v3-mod-comment-{}", module.id)))
                .size(px(22.0))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.0))
                .cursor_pointer()
                .role(gpui::Role::Button)
                .aria_label(label)
                .invisible()
                .group_hover(head_group.clone(), |st| st.visible())
                .hover(|st| st.bg(theme.palette.ink(1).alpha(0.05)))
                .on_click(move |e, window, cx| {
                    cx.stop_propagation();
                    if let Some(ws) = ws.upgrade() {
                        let pos = e.position();
                        let eid = eid.clone();
                        let mid = mid.clone();
                        ws.update(cx, |ws, cx| {
                            ws.open_module_composer(&eid, &mid, Some(pos), None, window, cx);
                        });
                    }
                })
                .child(dr_ui::sand::icon(
                    Icon::CommentPlus,
                    14.0,
                    theme.palette.ink(3).solid(),
                ))
        });
        div()
            .id(SharedString::from(key.clone()))
            .debug_selector(move || selector.clone())
            .py_3()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .group(head_group)
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .font_role(FontRole::Structure)
                                    .text_color(theme.palette.ink(2).solid())
                                    .child(module.name.clone()),
                            )
                            .children(mod_ul),
                    )
                    .children(comment_btn),
            )
            .children(self.parts.get(&key).map(|(_, p)| p.view.clone()))
            .into_any_element()
    }
    /// Mounts `block`'s list while its switch is on, and notes its section
    /// (a block is on the page whether its switch is on or off).
    fn mount_block(
        &mut self,
        id: &str,
        block: Block,
        section_id: String,
        name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let book = self.host.book.clone();
        let key = block.part().to_owned();
        let display = book
            .v3()
            .and_then(|v| v.levels.get(id))
            .map(|l| l.settings.display.clone())
            .filter(|_| block.on(&book, id));
        match display.clone() {
            Some(display) => {
                if self
                    .parts
                    .get(&key)
                    .is_some_and(|(kind, _)| kind != &display)
                {
                    self.parts.remove(&key);
                }
                if !self.parts.contains_key(&key)
                    && let Some(view) = super::level_display(
                        LevelHost {
                            page: self.host.clone(),
                            level: id.to_string(),
                            surface: block.surface(),
                        },
                        window,
                        cx,
                    )
                {
                    self.parts.insert(key.clone(), (display, view));
                }
            }
            None => {
                self.parts.remove(&key);
            }
        }
        self.sections.push(Section {
            id: section_id,
            kind: block.kind().to_owned(),
            name,
            registered: self.parts.contains_key(&key),
            display,
        });
    }
    pub fn sync_parts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let book = self.host.book.clone();
        self.sections.clear();
        let Some(v3) = book.v3() else {
            self.synced = false;
            return;
        };
        let mut active: Vec<String> = Vec::new();
        if let Target::Entry { id, .. } = self.target.clone()
            && v3.entry(id.as_str()).is_some()
        {
            let id = id.to_string();
            if !self.parts.contains_key("head")
                && let Some(head) = super::entry_head(self.entry_host(&id, cx), window, cx)
            {
                self.parts.insert("head".into(), ("head".into(), head));
            }
            active.push("head".into());
            for (i, make) in super::entry_head_parts(cx).into_iter().enumerate() {
                let key = format!("head-part:{i}");
                if !self.parts.contains_key(&key)
                    && let Some(part) = make(self.entry_host(&id, cx), window, cx)
                {
                    self.parts.insert(key.clone(), ("head-part".into(), part));
                }
                active.push(key);
            }
            let mut placed = (false, false);
            if let Some(template) = v3.template_of(&id) {
                for spec in &template.modules {
                    match Block::of(&spec.kind) {
                        Some(Block::Below) if !placed.0 => {
                            placed.0 = true;
                            self.mount_block(
                                &id,
                                Block::Below,
                                spec.id.clone(),
                                spec.name.clone(),
                                window,
                                cx,
                            );
                        }
                        Some(Block::Attached) if !placed.1 => {
                            placed.1 = true;
                            self.mount_block(
                                &id,
                                Block::Attached,
                                spec.id.clone(),
                                spec.name.clone(),
                                window,
                                cx,
                            );
                        }
                        Some(_) => {}
                        None => self.mount_module(&id, spec.clone(), window, cx),
                    }
                }
            }
            // A template without the module places the block after the
            // modules, 「挂在这里的条目」 after 「下面的条目」.
            if !placed.0 {
                let name = t(cx, keys::v3_shell::CHILDREN_ENTRIES).to_string();
                self.mount_block(&id, Block::Below, "display".into(), name, window, cx);
            }
            if !placed.1 {
                let name = t(cx, keys::v3_shell::ATTACHED_ENTRIES).to_string();
                self.mount_block(&id, Block::Attached, "members".into(), name, window, cx);
            }
            if v3.has_below(&id) {
                let key = "settings".to_owned();
                if !self.parts.contains_key(&key)
                    && let Some(view) = super::level_settings(
                        LevelHost {
                            page: self.host.clone(),
                            level: id.clone(),
                            surface: DisplaySurface::Page,
                        },
                        window,
                        cx,
                    )
                {
                    self.parts.insert(key.clone(), ("settings".into(), view));
                }
                self.sections.push(Section {
                    id: key.clone(),
                    kind: "settings".into(),
                    name: t(cx, keys::v3_shell::SETTINGS).to_string(),
                    registered: self.parts.contains_key(&key),
                    display: None,
                });
            }
            for section in &self.sections {
                active.push(match Block::of(&section.kind) {
                    Some(block) => block.part().to_owned(),
                    None if section.kind == "settings" => "settings".into(),
                    None => format!("module:{}", section.id),
                });
            }
        }
        self.parts.retain(|k, _| active.contains(k));
        self.synced = true;
    }

    /// The head drawn until a renderer registers one: the mark and the
    /// title, read-only, and the template's name.
    fn plain_head(&self, id: &str, window: &Window, cx: &App) -> AnyElement {
        let theme = Theme::of(window, cx);
        let book = &self.host.book;
        let Some(v3) = book.v3() else {
            return div().into_any_element();
        };
        let Some(entry) = v3.entry(id) else {
            return div().into_any_element();
        };
        let (mark, color) = book.mark(&self.target);
        let kind_mark = KindMark::new(SharedString::from(format!("v3-entry-mark-{id}")), mark);
        let kind_mark = match color {
            Some(c) => kind_mark.color(c),
            None => kind_mark,
        };
        // Comments on the title (T6): a sand underline, and where the title
        // is, for the composer opened from a menu.
        let title_ul = crate::comment_underline(
            SharedString::from(format!("v3-entry-title-ul-{id}")),
            v3.entry_title_comments(id),
            self.host.workspace.clone(),
            cx,
        );
        let probe_entry_id = id.to_owned();
        let title_probe = canvas(
            move |bounds, _, cx| {
                crate::record_entry_title_bounds(probe_entry_id.clone(), bounds, cx);
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        div()
            .flex()
            .flex_col()
            .min_w_0()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(kind_mark)
                    .child(
                        div()
                            .relative()
                            .flex()
                            .flex_col()
                            .child(title_probe)
                            .child(
                                div()
                                    .font_role(FontRole::Structure)
                                    .type_px(theme.scale.heading, theme.scale.heading + 12.0)
                                    .child(entry.title.clone()),
                            )
                            .children(title_ul),
                    ),
            )
            .children(v3.template_of(id).map(|t| {
                div()
                    .font_role(FontRole::Ui)
                    .type_px(theme.scale.caption, theme.scale.line_caption)
                    .text_color(theme.palette.muted().solid())
                    .child(t.name.clone())
            }))
            .into_any_element()
    }

    /// A block's head: its switch, its name, the switch's name in small
    /// grey, the view that orders it, and 「新建」 while it is on.
    fn block_head(
        &self,
        id: &str,
        block: Block,
        name: &str,
        window: &Window,
        cx: &App,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let book = &self.host.book;
        let on = block.on(book, id);
        let (switch_id, switch_label) = match block {
            Block::Below => ("v3-entry-level-toggle", keys::v3_shell::LEVEL_SWITCH),
            Block::Attached => ("v3-entry-accept-toggle", keys::v3_levels::ACCEPT),
        };
        let label = t(cx, switch_label);
        let host = self.host.clone();
        let entry = id.to_owned();
        let switch = div()
            .id(switch_id)
            .role(gpui::Role::CheckBox)
            .aria_label(label.clone())
            .aria_toggled(if on {
                gpui::Toggled::True
            } else {
                gpui::Toggled::False
            })
            .flex_none()
            .cursor_pointer()
            .on_click(move |_, window, cx| match block {
                Block::Below => toggle_level(host.clone(), entry.clone(), window, cx),
                Block::Attached => {
                    set_override(&host, &entry, "accept", Some(json!(!on)), cx);
                }
            })
            .child(Switch::new(
                SharedString::from(format!("{switch_id}-switch-{id}")),
                on,
            ));
        let view_tag = (block == Block::Attached && on)
            .then(|| book.v3().and_then(|v| v.ordering_view(id)))
            .flatten()
            .map(|view| view_tag(view.name.clone(), window, cx));
        let create = on
            .then(|| {
                let target = super::entry_target(id)?;
                let menu_host = PageMenuHost {
                    workspace: self.host.workspace.clone(),
                    library: Some(self.host.library.clone()),
                    book_id: self.host.book_id.clone(),
                    book: book.clone(),
                };
                let action = match block {
                    Block::Below => EntryAction::New,
                    Block::Attached => EntryAction::NewAttached,
                };
                super::entry_action(action, &target, &menu_host, cx)
            })
            .flatten()
            .map(|run| {
                Button::new(
                    SharedString::from(format!("v3-block-new-{}", block.kind())),
                    t(cx, keys::v3_shell::NEW_ENTRY),
                )
                .small()
                .text()
                .icon(Icon::Plus)
                .on_click(move |_, window, cx| run(window, cx))
            });
        div()
            .id(SharedString::from(format!(
                "v3-block-head-{}",
                block.kind()
            )))
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .pb_1()
            .border_b_1()
            .border_color(p.hairline())
            .child(switch)
            .child(
                div()
                    .font_role(FontRole::Structure)
                    .text_color(if on { p.ink(2) } else { p.ink(4) }.solid())
                    .child(name.to_owned()),
            )
            .child(
                div()
                    .font_role(FontRole::Ui)
                    .type_px(theme.scale.caption, theme.scale.line_caption)
                    .text_color(p.muted().solid())
                    .child(label),
            )
            .children(view_tag)
            .child(div().flex_1())
            .children(create)
            .into_any_element()
    }

    /// The setting under a block's head: 「自动链接」 for what lives under
    /// it, 「新条目住在」 for what is attached to it.
    fn block_setting(&self, id: &str, block: Block, window: &Window, cx: &App) -> AnyElement {
        let theme = Theme::of(window, cx);
        let book = &self.host.book;
        let Some(v3) = book.v3() else {
            return div().into_any_element();
        };
        let Some(level) = v3.levels.get(id) else {
            return div().into_any_element();
        };
        let row = div()
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .font_role(FontRole::Ui)
            .type_px(theme.scale.body, theme.scale.line_body)
            .text_color(theme.palette.ink(2).solid());
        match block {
            Block::Below => {
                let on = level.settings.auto_link;
                let label = t(cx, keys::v3_levels::AUTO_LINK);
                let host = self.host.clone();
                let entry = id.to_owned();
                row.child(
                    div()
                        .id("v3-entry-autolink-toggle")
                        .role(gpui::Role::CheckBox)
                        .aria_label(label.clone())
                        .aria_toggled(if on {
                            gpui::Toggled::True
                        } else {
                            gpui::Toggled::False
                        })
                        .cursor_pointer()
                        .on_click(move |_, _, cx| {
                            set_override(&host, &entry, "auto_link", Some(json!(!on)), cx);
                        })
                        .child(Switch::new(
                            SharedString::from(format!("v3-entry-autolink-switch-{id}")),
                            on,
                        )),
                )
                .child(label)
                .into_any_element()
            }
            Block::Attached => {
                let entry = v3.entry(id);
                let unset = match entry {
                    Some(e) if e.level => e.title.clone().into(),
                    _ => t(cx, keys::v3_shell::OUTERMOST),
                };
                let mut homes: Vec<(Option<String>, Choice)> =
                    vec![(None, Choice::new(Icon::Layers, unset))];
                homes.extend(v3.entries.iter().filter(|e| e.level).map(|e| {
                    let (mark, color) = super::entry_target(&e.id)
                        .map(|t| book.mark(&t))
                        .unwrap_or((sand::Kind::Element, None));
                    (
                        Some(e.id.clone()),
                        Choice::new(RowIcon::Mark(mark, color), e.title.clone()),
                    )
                }));
                let selected = level
                    .settings
                    .home
                    .as_ref()
                    .and_then(|home| homes.iter().position(|(id, _)| id.as_ref() == Some(home)))
                    .unwrap_or(0);
                let ids: Vec<Option<String>> = homes.iter().map(|(id, _)| id.clone()).collect();
                let host = self.host.clone();
                let entry = id.to_owned();
                row.child(t(cx, keys::v3_levels::HOME))
                    .child(
                        div().id("v3-entry-home").child(
                            Select::new(
                                SharedString::from(format!("v3-entry-home-{id}")),
                                homes.into_iter().map(|(_, c)| c).collect(),
                                selected,
                            )
                            .on_change(move |ix, _, cx| {
                                let value = ids.get(ix).cloned().flatten();
                                set_override(&host, &entry, "home", Some(json!(value)), cx);
                            }),
                        ),
                    )
                    .into_any_element()
            }
        }
    }

    fn render_block(
        &self,
        id: &str,
        block: Block,
        section: &Section,
        window: &Window,
        cx: &App,
    ) -> AnyElement {
        let on = block.on(&self.host.book, id);
        let list = on.then(|| match self.parts.get(block.part()) {
            Some((_, p)) => p.view.clone().into_any_element(),
            None if block == Block::Below => placeholder_display(&self.host, id, cx),
            None => div().into_any_element(),
        });
        // 「自动链接」 only manages what lives under the entry.
        let setting = on.then(|| self.block_setting(id, block, window, cx));
        div()
            .id(SharedString::from(format!("section:{}", section.id)))
            .flex()
            .flex_col()
            .gap_2()
            .child(self.block_head(id, block, &section.name, window, cx))
            .children(setting)
            .children(list)
            .into_any_element()
    }
}

/// A small tag naming the view whose scale orders a list.
pub fn view_tag(name: impl Into<SharedString>, window: &Window, cx: &App) -> AnyElement {
    let theme = Theme::of(window, cx);
    let ink = theme.palette.muted().solid();
    let name = name.into();
    div()
        .id(SharedString::from(format!("v3-view-tag-{name}")))
        .role(gpui::Role::Label)
        .aria_label(name.clone())
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .font_role(FontRole::Ui)
        .type_px(theme.scale.caption, theme.scale.line_caption)
        .text_color(ink)
        .child(sand::icon(Icon::LanesStagger, 11.0, ink))
        .child(name)
        .into_any_element()
}

/// Writes `key` of `id`'s own level settings (`entry.update`'s
/// `overrides`; `None` defers to the template again), held to what the
/// page showed. A refused write says so in a notice.
pub fn set_override(
    host: &PageViewHost,
    id: &str,
    key: &'static str,
    value: Option<Value>,
    cx: &mut App,
) {
    if !host_still_valid(host, cx) {
        return;
    }
    let Some(v) = host.book.v3() else {
        return;
    };
    let Some(entry) = v.entry(id) else {
        return;
    };
    let mut overrides = entry
        .overrides
        .as_ref()
        .and_then(|o| serde_json::to_value(o).ok())
        .unwrap_or_else(|| json!({}));
    let Some(map) = overrides.as_object_mut() else {
        return;
    };
    match value {
        Some(value) => {
            map.insert(key.into(), value);
        }
        None => {
            map.remove(key);
        }
    }
    let input = json!({ "book": host.book_id, "id": id, "overrides": overrides });
    let guard = WritePreconditions {
        require_all: false,
        ..v.guard_for(&input)
    };
    let lib = host.library.clone();
    let job = cx
        .background_executor()
        .spawn(async move { lib.call_guarded(&Actor::User, "entry.update", input, guard) });
    let host = host.clone();
    cx.spawn(async move |cx| {
        if let Err(error) = job.await {
            log::warn!("entry setting write failed: {error}");
            cx.update(|cx| toast_save_failed(&host, cx));
        }
    })
    .detach();
}

impl Render for EntryPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        self.sync_parts(window, cx);
        let book = self.host.book.clone();
        let mut content = div().flex().flex_col().gap_4();
        let Some(v3) = book.v3() else {
            return content.into_any_element();
        };
        match self.target.clone() {
            Target::Entry { id, module } => {
                if let Some(entry) = v3.entry(id.as_str()) {
                    let open_book = entry.level.then(|| {
                        let weak = self.host.workspace.clone();
                        let expected_book = self.host.book_id.clone();
                        let book_target = Target::Book(id.clone());
                        div().debug_selector(|| "v3-entry-open-book".into()).child(
                            Button::new("v3-entry-open-book", t(cx, keys::v3_shell::BOOK_VIEW))
                                .small()
                                .icon(Icon::OpenBook)
                                .on_click(move |_, _, cx| {
                                    if let Some(ws) = weak.upgrade() {
                                        ws.update(cx, |ws, cx| {
                                            if ws.book_id == expected_book
                                                && ws.book.exists(&book_target)
                                            {
                                                ws.open(book_target.clone(), Open::KEEP, cx);
                                            }
                                        });
                                    }
                                }),
                        )
                    });
                    let head = match self.parts.get("head") {
                        Some((_, p)) => p.view.clone().into_any_element(),
                        None => self.plain_head(id.as_str(), window, cx),
                    };
                    let mut children: Vec<AnyElement> = vec![
                        div()
                            .debug_selector(|| "v3-entry-head".into())
                            .flex()
                            .flex_row()
                            .items_start()
                            .justify_between()
                            .gap_4()
                            .child(div().flex_1().min_w_0().child(head))
                            .child(div().flex_none().children(open_book))
                            .into_any_element(),
                    ];
                    for (key, (_, part)) in &self.parts {
                        if key.starts_with("head-part:") {
                            children.push(part.view.clone().into_any_element());
                        }
                    }
                    let first_section = children.len();
                    for section in self.sections.clone() {
                        let element = match Block::of(&section.kind) {
                            Some(block) => {
                                self.render_block(id.as_str(), block, &section, window, cx)
                            }
                            None if section.kind == "settings" => {
                                let settings = match self.parts.get("settings") {
                                    Some((_, p)) => p.view.clone().into_any_element(),
                                    None => v3
                                        .levels
                                        .get(id.as_str())
                                        .map(|l| display_name(&l.settings.display, cx))
                                        .map(|n| div().child(n).into_any_element())
                                        .unwrap_or_else(|| div().into_any_element()),
                                };
                                div()
                                    .id("section:settings")
                                    .flex()
                                    .flex_col()
                                    .gap_2()
                                    .child(t(cx, keys::v3_shell::SETTINGS))
                                    .child(settings)
                                    .into_any_element()
                            }
                            None => self.render_module(&section, window, cx),
                        };
                        children.push(element);
                    }
                    content = content.children(children);
                    if self.pending_reveal {
                        let asked = self.asked.clone();
                        let wanted = asked
                            .as_deref()
                            .or(module.as_ref().map(|m| m.as_str()))
                            .or_else(|| {
                                self.revealed.and_then(|_| {
                                    self.sections
                                        .iter()
                                        .find(|s| s.kind == "prose")
                                        .map(|s| s.id.as_str())
                                })
                            });
                        if let Some(wanted) = wanted {
                            let reveal = self
                                .parts
                                .get(&format!("module:{wanted}"))
                                .and_then(|(_, part)| part.reveal.clone());
                            // Lines to reveal are the body's own to scroll
                            // to. Otherwise the section stays in view while
                            // the page settles (a body above it grows to its
                            // text's height once it loads), until the author
                            // takes the page.
                            self.pinned = (self.revealed.is_none() || reveal.is_none())
                                .then(|| wanted.to_owned());
                            if let Some(reveal) = reveal {
                                reveal(self.revealed, window, cx);
                            }
                        }
                        self.pending_reveal = false;
                    }
                    if self.author_scrolled.replace(false) {
                        self.pinned = None;
                    }
                    if let Some(pinned) = &self.pinned {
                        match self.sections.iter().position(|s| &s.id == pinned) {
                            Some(i) => self.show_section(first_section + i),
                            None => self.pinned = None,
                        }
                    }
                }
            }
            Target::Template(id) => {
                if let Some(template) = v3.template(id.as_str()) {
                    content = content.child(template.name.clone());
                }
            }
            _ => {}
        }
        content
            .id("v3-entry-page")
            .track_focus(&self.focus)
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .when(self.pinned.is_some(), |page| {
                // The author takes the page: the named section is no longer
                // held in view. GPUI hands a key to these listeners only when
                // no action took it; the workspace lets go for ⌘Z / ⇧⌘Z it
                // takes for the book (`workspace/undo.rs`).
                page.capture_any_mouse_down(cx.listener(|this, _, _, cx| this.release_pin(cx)))
                    .on_scroll(cx.listener(|this, _, _, cx| this.release_pin(cx)))
                    .capture_key_down(cx.listener(|this, _, _, cx| this.release_pin(cx)))
            })
            .px_8()
            .pt_16()
            .pb_8()
            .font_role(FontRole::Structure)
            .text_color(theme.palette.ink(1).solid())
            .into_any_element()
    }
}

pub fn display_name(display: &str, cx: &App) -> SharedString {
    let key = match display {
        "list" => keys::v3_shell::LIST,
        "grid" => keys::v3_shell::GRID,
        "board" => keys::v3_shell::BOARD,
        "island" => keys::v3_shell::ISLANDS,
        _ => return display.to_owned().into(),
    };
    t(cx, key)
}

/// Where an attached entry lives, as the 「挂在这里的条目」 rows say it
/// (「住在「构想」」, or the outermost entries).
pub fn lives_in(book: &Book, id: &str, cx: &App) -> SharedString {
    let parent = book
        .v3()
        .and_then(|v| v.entry(id))
        .and_then(|e| e.parent.as_deref())
        .and_then(|p| book.v3().and_then(|v| v.entry(p)));
    match parent {
        Some(p) => tf(cx, keys::v3_shell::LIVES_IN, &[("name", &p.title)]),
        None => t(cx, keys::v3_shell::LIVES_OUTERMOST),
    }
}

/// Minimal navigable fallback, also used by the sidebar until G2 registers its
/// displays. Resident and accepted entries share the same target and appearance.
pub fn placeholder_display(host: &PageViewHost, level: &str, cx: &App) -> AnyElement {
    let Some(book) = host.book.v3() else {
        return div().into_any_element();
    };
    let Some(level) = book.levels.get(level) else {
        return div().into_any_element();
    };
    let mut seen = std::collections::BTreeSet::new();
    div()
        .flex()
        .flex_col()
        .gap_2()
        .children(
            level
                .children
                .iter()
                .chain(&level.members)
                .filter(|id| seen.insert(*id))
                .filter_map(|id| {
                    let entry = book.entry(id)?;
                    let target = super::entry_target(id)?;
                    let weak = host.workspace.clone();
                    let (mark, color) = host.book.mark(&target);
                    let selected = weak
                        .upgrade()
                        .is_some_and(|ws| ws.read(cx).nav.is_selected(&target));
                    let card_target = target.clone();
                    let card_ws = weak.upgrade();
                    let cell = dr_ui::components::SandCell::new(
                        SharedString::from(format!("v3-row-{id}")),
                        entry.title.clone(),
                    )
                    .mark(mark)
                    .color_opt(color)
                    .selected(selected)
                    .on_click(move |event, _, cx| {
                        if let Some(ws) = weak.upgrade() {
                            ws.update(cx, |ws, cx| {
                                ws.open(
                                    target.clone(),
                                    if event.click_count() > 1 {
                                        Open::KEEP
                                    } else {
                                        Open::PREVIEW
                                    },
                                    cx,
                                )
                            });
                        }
                    });
                    Some(match card_ws {
                        Some(ws) => crate::workspace::page_hover_card(
                            format!("v3-entry-{id}"),
                            cell,
                            &card_target,
                            &ws,
                            Default::default(),
                            cx,
                        ),
                        None => cell.into_any_element(),
                    })
                }),
        )
        .into_any_element()
}
