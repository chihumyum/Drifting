//! Entity links (人物链接) as the editor shows them, and what the editor
//! adds to gpui-prose through its extension hooks.
//!
//! An `entity:<id>` mark gets a look from what it shows as
//! ([`dr_model::v3::link_show`], `kernel-v5.md` §16 「自动链接」, the one rule
//! every reader of links follows): a live link in the link colour with a
//! thin underline; a link whose target is gone (deleted, or in the trash)
//! muted, with the underline only; an automatic link to an entry whose own
//! 「自动链接」 is off, or any automatic link while the author's setting is
//! off, as ordinary text (its data stays in the text). A link picked with @
//! shows whatever the switches say. What the targets are comes from the
//! book, cached per target until the book changes.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use dr_model::kind::EntityKind;
use dr_model::v3::{LinkEntries, LinkEntry, LinkShow};
use gpui_prose::render::RunStyle;
use gpui_prose::schema::inline;
use gpui_prose::style::ProseStyle;
use gpui_prose::text::Marks;
use gpui_prose::{InputRule, ProseExtension, Typed};
use loro::LoroValue;

use crate::rules::markdown_rule;
use crate::settings::{EntityLinkColorMode, LinkAppearance, parse_hex_hsla};

/// Bulk link targets for one book state: every entry of the book with its
/// state (Recently Deleted too), and the live files.
pub type TargetSnapshot = (LinkEntries, HashSet<String>);

/// What entity link targets are.
pub trait LinkTargets {
    fn alive(&self, kind: &EntityKind, id: &str) -> bool;

    /// The state of entry `id` for [`dr_model::v3::link_show`], `None` when
    /// the book has no such entry. Without it, an entry reads as live and
    /// linking when [`Self::alive`] says so.
    fn entry(&self, id: &str) -> Option<LinkEntry> {
        self.alive(&EntityKind::Entry, id).then_some(LinkEntry {
            live: true,
            auto_link: true,
        })
    }

    /// Optional bulk snapshot ([`TargetSnapshot`]) so an editor can populate
    /// its cache in a single book read instead of one read per distinct link
    /// target.
    fn snapshot(&self) -> Option<TargetSnapshot> {
        None
    }

    /// The author's setting `editor.auto_entity_links` (on by default):
    /// off, every automatic link reads as ordinary text.
    fn auto_links(&self) -> bool {
        true
    }

    /// Live asset IDs whose `kind` is PDF, so file-link badges pick the right icon.
    fn pdf_assets(&self) -> HashSet<String> {
        HashSet::new()
    }

    /// Entry colours and effective template names (`id -> (hex_color, template_name)`),
    /// for `EntityLinkColorMode::Kind`.
    fn entry_colors(&self) -> HashMap<String, (Option<String>, Option<String>)> {
        HashMap::new()
    }
}

/// Whether an entity mark's value says the author made the link: picked
/// with @ ([`dr_model::prose::LINK_MANUAL`]), or into a module or a range of
/// blocks, which automatic linking never writes
/// ([`dr_model::v3::EntityLinkV3::picked`], `kernel-v5.md` §16).
pub fn link_manual(value: &LoroValue) -> bool {
    let LoroValue::Map(map) = value else {
        return false;
    };
    matches!(
        map.get(dr_model::prose::LINK_MANUAL),
        Some(LoroValue::Bool(true))
    ) || ["module", "block", "end_block"]
        .iter()
        .any(|k| map.get(*k).is_some_and(|v| !matches!(v, LoroValue::Null)))
}

/// The kind an entity mark's value names (elements when unsaid).
pub fn link_kind(value: &LoroValue) -> EntityKind {
    match value {
        LoroValue::Map(map) => match map.get("kind") {
            Some(LoroValue::String(s)) => EntityKind::parse(s),
            _ => EntityKind::Element,
        },
        _ => EntityKind::Element,
    }
}

/// Cached `entry_id -> (entry_hex_color, template_name)` for `Kind` colour mode.
type EntryColorMap = HashMap<String, (Option<String>, Option<String>)>;

/// gpui-prose's extension for Drifting: entity link looks and Markdown
/// input rules.
pub struct DriftingExtension {
    targets: Option<Box<dyn LinkTargets>>,
    alive: RefCell<HashMap<(EntityKind, String), bool>>,
    preloaded: RefCell<Option<Option<TargetSnapshot>>>,
    /// Entry states read one at a time (no snapshot).
    entries: RefCell<HashMap<String, Option<LinkEntry>>>,
    /// The author's setting, read once until [`Self::invalidate`].
    auto_links: std::cell::Cell<Option<bool>>,
    pdf_assets: RefCell<Option<HashSet<String>>>,
    markdown: bool,
    /// A material note's rules too (`==highlight==`).
    note: std::cell::Cell<bool>,
    /// The paint layers draw the links' dry underline (crate::decor), so
    /// the run gets none of its own.
    dry_underline: std::cell::Cell<bool>,
    /// Whether each TODO of the book is done, for task items linked to one
    /// (the paint layers keep it, crate::decor).
    todos: RefCell<std::collections::HashMap<String, bool>>,
    /// Painted `"links"` decoration ids that point to live files (`(id, is_pdf)`),
    /// per chapter, so `Assist` draws their trailing file badge.
    file_link_badges: RefCell<HashMap<usize, Vec<(gpui::SharedString, bool)>>>,
    /// Visual appearance settings for entity links (`color_mode`, `highlight_mode`,
    /// `band_style`, `kind_colors`).
    appearance: RefCell<LinkAppearance>,
    /// Cached `entry_id -> (entry_hex_color, template_name)` for `Kind` colour mode.
    entry_colors: RefCell<Option<EntryColorMap>>,
}

impl DriftingExtension {
    /// Rules of a material note too (`==highlight==`); set per document.
    pub fn set_note(&self, note: bool) {
        self.note.set(note);
    }

    /// Updates entity link visual appearance settings.
    pub fn set_appearance(&self, appearance: LinkAppearance) {
        *self.appearance.borrow_mut() = appearance;
    }

    /// Current entity link visual appearance settings.
    pub fn appearance(&self) -> LinkAppearance {
        self.appearance.borrow().clone()
    }

    /// Resolves the colour to paint a live entity link to `(kind, id)` under
    /// the current [`LinkAppearance`], falling back to `default_link`.
    pub fn resolve_link_color(
        &self,
        kind: &EntityKind,
        id: &str,
        default_link: gpui::Hsla,
    ) -> gpui::Hsla {
        let appearance = self.appearance.borrow();
        if appearance.color_mode != EntityLinkColorMode::Kind {
            return default_link;
        }
        // Check explicit kind override first (by kind string, e.g. "entry", "asset",
        // or by the entry's template name).
        if let Some(hex) = appearance.kind_colors.get(kind.as_str())
            && let Some(c) = parse_hex_hsla(hex)
        {
            return c;
        }
        if *kind == EntityKind::Entry {
            if self.entry_colors.borrow().is_none()
                && let Some(targets) = &self.targets
            {
                *self.entry_colors.borrow_mut() = Some(targets.entry_colors());
            }
            if let Some(map) = self.entry_colors.borrow().as_ref()
                && let Some((hex, tpl)) = map.get(id)
            {
                if let Some(tpl_name) = tpl
                    && let Some(override_hex) = appearance.kind_colors.get(tpl_name)
                    && let Some(c) = parse_hex_hsla(override_hex)
                {
                    return c;
                }
                if let Some(hex) = hex
                    && let Some(c) = parse_hex_hsla(hex)
                {
                    return c;
                }
            }
        }
        default_link
    }

    /// `targets`: where to look link targets up (`None`: every link alive).
    pub fn new(targets: Option<Box<dyn LinkTargets>>) -> DriftingExtension {
        DriftingExtension {
            targets,
            alive: RefCell::default(),
            preloaded: RefCell::new(None),
            entries: RefCell::default(),
            auto_links: std::cell::Cell::new(None),
            pdf_assets: RefCell::new(None),
            markdown: true,
            note: std::cell::Cell::new(false),
            dry_underline: std::cell::Cell::new(false),
            todos: RefCell::default(),
            file_link_badges: RefCell::default(),
            appearance: RefCell::default(),
            entry_colors: RefCell::new(None),
        }
    }

    /// Turns the Markdown input rules on or off.
    pub fn with_markdown(mut self, on: bool) -> DriftingExtension {
        self.markdown = on;
        self
    }

    /// Forgets cached link targets (the book changed, or the author's
    /// setting did).
    pub fn invalidate(&self) {
        self.alive.borrow_mut().clear();
        *self.preloaded.borrow_mut() = None;
        self.entries.borrow_mut().clear();
        self.auto_links.set(None);
        *self.pdf_assets.borrow_mut() = None;
        *self.entry_colors.borrow_mut() = None;
    }

    /// The author's setting `editor.auto_entity_links` (cached until
    /// [`Self::invalidate`]); on without targets.
    pub fn auto_links(&self) -> bool {
        let Some(targets) = &self.targets else {
            return true;
        };
        if let Some(on) = self.auto_links.get() {
            return on;
        }
        let on = targets.auto_links();
        self.auto_links.set(Some(on));
        on
    }

    fn preload(&self, targets: &dyn LinkTargets) {
        if self.preloaded.borrow().is_none() {
            *self.preloaded.borrow_mut() = Some(targets.snapshot());
        }
    }

    fn entry_state(&self, id: &str) -> Option<LinkEntry> {
        let targets = self.targets.as_ref()?;
        self.preload(targets.as_ref());
        if let Some((entries, _)) = self.preloaded.borrow().as_ref().and_then(Option::as_ref) {
            return entries.get(id);
        }
        if let Some(state) = self.entries.borrow().get(id) {
            return *state;
        }
        let state = targets.entry(id);
        self.entries.borrow_mut().insert(id.to_owned(), state);
        state
    }

    /// What the entity mark `entity:<id>` with `value` shows as
    /// ([`dr_model::v3::link_show`]): the one rule the editor's paint, name
    /// cards, clicks, relation lines and suggestions read. A file link is a
    /// link while its file is live and ordinary text otherwise. Without
    /// targets every link is live.
    pub fn show(&self, kind: &EntityKind, id: &str, value: &LoroValue) -> LinkShow {
        if self.targets.is_none() {
            return LinkShow::Live;
        }
        match kind {
            EntityKind::Asset | EntityKind::Material => {
                if self.is_alive(kind, id) {
                    LinkShow::Live
                } else {
                    LinkShow::Plain
                }
            }
            EntityKind::Entry => {
                dr_model::v3::link_show(link_manual(value), self.entry_state(id), self.auto_links())
            }
            _ => {
                if self.is_alive(kind, id) {
                    LinkShow::Live
                } else {
                    LinkShow::Gone
                }
            }
        }
    }

    pub fn is_pdf_asset(&self, id: &str) -> bool {
        let Some(targets) = &self.targets else {
            return false;
        };
        if self.pdf_assets.borrow().is_none() {
            *self.pdf_assets.borrow_mut() = Some(targets.pdf_assets());
        }
        self.pdf_assets
            .borrow()
            .as_ref()
            .is_some_and(|set| set.contains(id))
    }

    pub(crate) fn set_file_link_badges(
        &self,
        chapter: usize,
        badges: Vec<(gpui::SharedString, bool)>,
    ) {
        self.file_link_badges.borrow_mut().insert(chapter, badges);
    }

    pub(crate) fn file_link_badges(&self, chapter: usize) -> Vec<(gpui::SharedString, bool)> {
        self.file_link_badges
            .borrow()
            .get(&chapter)
            .cloned()
            .unwrap_or_default()
    }

    /// Whether the paint layers draw the links' underline.
    pub fn set_dry_underline(&self, on: bool) {
        self.dry_underline.set(on);
    }

    /// The book's TODOs and whether each is done; whether anything changed.
    pub fn set_todos(&self, todos: std::collections::HashMap<String, bool>) -> bool {
        let mut held = self.todos.borrow_mut();
        let changed = *held != todos;
        *held = todos;
        changed
    }

    /// Whether a link's target still exists (cached until [`Self::invalidate`]).
    pub fn alive(&self, kind: &EntityKind, id: &str) -> bool {
        self.is_alive(kind, id)
    }

    fn is_alive(&self, kind: &EntityKind, id: &str) -> bool {
        let Some(targets) = &self.targets else {
            return true;
        };
        let key = (kind.clone(), id.to_owned());
        if let Some(&cached) = self.alive.borrow().get(&key) {
            return cached;
        }
        self.preload(targets.as_ref());
        let alive = match self.preloaded.borrow().as_ref().and_then(Option::as_ref) {
            Some((entries, materials)) => match kind {
                EntityKind::Entry => entries.is_live(id),
                EntityKind::Asset | EntityKind::Material => materials.contains(id),
                _ => false,
            },
            None => targets.alive(kind, id),
        };
        self.alive.borrow_mut().insert(key, alive);
        alive
    }
}

impl ProseExtension for DriftingExtension {
    fn style_run(&self, marks: &Marks, run: &mut RunStyle, style: &ProseStyle) {
        let mut linked: Option<(bool, Option<gpui::Hsla>)> = None;
        for (key, value) in marks.iter() {
            if let Some(id) = inline::entity_target(key) {
                let kind = link_kind(value);
                // Format 5 (`v5-tracks.md` §T5): a link to a trashed file
                // reads like ordinary prose text until the file is restored;
                // so does an automatic link whose entry's 「自动链接」 is off
                // (`kernel-v5.md` §16).
                match self.show(&kind, id, value) {
                    LinkShow::Live => {
                        let color = self.resolve_link_color(&kind, id, style.link);
                        linked = Some((true, Some(color)));
                    }
                    LinkShow::Gone => {
                        if linked.is_none() {
                            linked = Some((false, None));
                        }
                    }
                    LinkShow::Plain => {}
                }
            }
        }
        let appearance = self.appearance.borrow();
        match linked {
            Some((true, color)) => {
                let color = color.unwrap_or(style.link);
                let show_text = appearance.highlight_mode.styles_text()
                    && !matches!(
                        appearance.color_mode,
                        EntityLinkColorMode::Prose | EntityLinkColorMode::Hover
                    );
                if show_text {
                    run.color = color;
                }
                if !self.dry_underline.get()
                    && appearance.highlight_mode.styles_band()
                    && !matches!(
                        appearance.color_mode,
                        EntityLinkColorMode::Prose | EntityLinkColorMode::Hover
                    )
                {
                    run.underline = Some(color.opacity(0.45));
                }
            }
            Some((false, _)) if appearance.color_mode != EntityLinkColorMode::Prose => {
                if appearance.highlight_mode.styles_text() {
                    run.color = style.muted;
                }
                if !self.dry_underline.get() && appearance.highlight_mode.styles_band() {
                    run.underline = Some(style.muted.opacity(0.6));
                }
            }
            Some((false, _)) | None => {}
        }
    }

    fn task_done(&self, todo: &str) -> Option<bool> {
        self.todos.borrow().get(todo).copied()
    }

    fn input_rule(&self, typed: &Typed<'_>) -> Option<InputRule> {
        if !self.markdown {
            return None;
        }
        markdown_rule(typed).or_else(|| {
            self.note
                .get()
                .then(|| {
                    crate::rules::note_block_rule(typed)
                        .or_else(|| crate::rules::highlight_rule(typed))
                        .or_else(|| crate::rules::inline_code_rule(typed))
                })
                .flatten()
        })
    }
}

/// Optional v3 module endpoint. Reading it does not change the legacy encoder.
pub fn link_module(value: &LoroValue) -> Option<String> {
    let LoroValue::Map(map) = value else {
        return None;
    };
    let LoroValue::String(module) = map.get("module")? else {
        return None;
    };
    dr_model::v3::ModuleId::parse(module.as_str())
        .ok()
        .map(|m| m.to_string())
}

/// The G1 host supplies navigation without coupling the editor to the shell.
/// The callback receives the originating library; it must recheck that scope
/// after any asynchronous read. No live editor or library is retained here.
type V3Open =
    std::rc::Rc<dyn Fn(&dr_workspace::Workspace, &str, dr_model::v3::EntityLinkV3, &mut gpui::App)>;
struct V3Opener(V3Open);
impl gpui::Global for V3Opener {}
pub fn set_v3_opener(
    cx: &mut gpui::App,
    open: impl Fn(&dr_workspace::Workspace, &str, dr_model::v3::EntityLinkV3, &mut gpui::App) + 'static,
) {
    cx.set_global(V3Opener(std::rc::Rc::new(open)));
}
pub(crate) fn open_v3(
    ws: &dr_workspace::Workspace,
    book: &str,
    link: dr_model::v3::EntityLinkV3,
    cx: &mut gpui::App,
) -> bool {
    let Some(open) = cx.try_global::<V3Opener>().map(|o| o.0.clone()) else {
        return false;
    };
    open(ws, book, link, cx);
    true
}

struct ClipboardRefusal(std::rc::Rc<dyn Fn(&mut gpui::App)>);
impl gpui::Global for ClipboardRefusal {}
/// Host feedback for refused rich clipboard actions; the technical reason stays
/// in the log and the selection/clipboard remain available for retry.
pub fn set_clipboard_refusal(cx: &mut gpui::App, notify: impl Fn(&mut gpui::App) + 'static) {
    cx.set_global(ClipboardRefusal(std::rc::Rc::new(notify)));
}
pub(crate) fn clipboard_refused(cx: &mut gpui::App, error: impl std::fmt::Display) {
    log::error!("rich clipboard action refused: {error}");
    if let Some(notify) = cx.try_global::<ClipboardRefusal>().map(|n| n.0.clone()) {
        notify(cx);
    }
}
