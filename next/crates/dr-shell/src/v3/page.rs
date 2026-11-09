use super::{DisplaySurface, LevelHost, ModuleHost, Rendered};
use crate::{
    book::Book,
    nav::{Lines, Open, Target},
    pages::PageViewHost,
    strings::t,
};
use dr_i18n::keys;
use dr_ui::{Theme, fonts::Role as FontRole, style::DrStyled};
use dr_workspace::commands::v3::types::ModuleSpec;
use gpui::{prelude::*, *};
use std::{collections::BTreeMap, rc::Rc};

/// The composition state is also the debug bridge's contract. It describes
/// the parts actually mounted by this view, in the same order as the window.
#[derive(Clone, serde::Serialize)]
pub struct Section {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub registered: bool,
}

pub struct EntryPage {
    host: PageViewHost,
    target: Target,
    pub focus: FocusHandle,
    scroll: ScrollHandle,
    parts: BTreeMap<String, (String, Rendered)>,
    pub sections: Vec<Section>,
    pub revealed: Option<Lines>,
    pending_reveal: bool,
}
impl EntryPage {
    pub fn new(host: PageViewHost, target: Target, cx: &mut Context<Self>) -> Self {
        Self {
            host,
            target,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            parts: BTreeMap::new(),
            sections: Vec::new(),
            revealed: None,
            pending_reveal: true,
        }
    }
    pub fn refresh(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
        self.host.book = book.clone();
        if let Target::Entry { id, .. } = &self.target
            && let Some(v3) = book.v3()
        {
            self.parts.retain(|key, (kind, _)| {
                if key == "display" {
                    return v3
                        .levels
                        .get(id.as_str())
                        .is_some_and(|l| l.settings.display == *kind);
                }
                if key == "module:about" && v3.levels.contains_key(id.as_str()) {
                    return true;
                }
                v3.template_of(id.as_str()).is_some_and(|t| {
                    t.modules
                        .iter()
                        .any(|m| key == &format!("module:{}", m.id) && m.kind == *kind)
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
    /// The requested module, otherwise the first prose editor, takes typing
    /// when its tab returns to the front. Placeholders use the page's handle.
    pub fn preferred_focus(&self) -> FocusHandle {
        let selected = match &self.target {
            Target::Entry { module, .. } => module.as_ref().map(|m| m.as_str()),
            _ => None,
        };
        let section = selected
            .and_then(|id| self.sections.iter().find(|s| s.id == id))
            .or_else(|| self.sections.iter().find(|s| s.kind == "prose"));
        section
            .and_then(|s| self.parts.get(&format!("module:{}", s.id)))
            .and_then(|(_, part)| part.focus.clone())
            .unwrap_or_else(|| self.focus.clone())
    }
    pub fn state(&self) -> serde_json::Value {
        serde_json::json!({ "target": self.target.key(), "sections": self.sections, "module": match &self.target { Target::Entry { module, .. } => module.as_ref().map(ToString::to_string), _ => None }, "reveal": self.revealed })
    }
    fn module(
        &mut self,
        id: &str,
        module: ModuleSpec,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
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
            self.parts.insert(key.clone(), (module.kind.clone(), part));
        }
        self.sections.push(Section {
            id: module.id.clone(),
            kind: module.kind,
            name: module.name.clone(),
            registered: self.parts.contains_key(&key),
        });
        let theme = Theme::of(window, cx);
        div()
            .id(SharedString::from(key.clone()))
            .py_3()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .font_role(FontRole::Structure)
                    .text_color(theme.palette.ink(2).solid())
                    .child(module.name),
            )
            .children(self.parts.get(&key).map(|(_, p)| p.view.clone()))
            .into_any_element()
    }
}
impl Render for EntryPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let book = self.host.book.clone();
        let mut content = div().flex().flex_col().gap_4();
        self.sections.clear();
        let Some(v3) = book.v3() else {
            return content.into_any_element();
        };
        match self.target.clone() {
            Target::Entry { id, module } => {
                if let Some(entry) = v3.entry(id.as_str()) {
                    content = content.child(
                        div()
                            .font_role(FontRole::Structure)
                            .type_px(theme.scale.heading, theme.scale.heading + 12.0)
                            .child(entry.title.clone()),
                    );
                    if let Some(level) = v3.levels.get(id.as_str()) {
                        let about = ModuleSpec {
                            id: "about".into(),
                            kind: "prose".into(),
                            name: t(cx, keys::v3_shell::ABOUT).to_string(),
                            pos: None,
                            config: Default::default(),
                            agent: None,
                        };
                        let mut description = div().flex().flex_col().child(self.module(
                            id.as_str(),
                            about,
                            window,
                            cx,
                        ));
                        if let Some(template) = v3.template_of(id.as_str()) {
                            for spec in &template.modules {
                                description = description.child(self.module(
                                    id.as_str(),
                                    spec.clone(),
                                    window,
                                    cx,
                                ));
                            }
                        }
                        content = content.child(description);
                        let key = "display".to_owned();
                        if self
                            .parts
                            .get(&key)
                            .is_some_and(|(kind, _)| kind != &level.settings.display)
                        {
                            self.parts.remove(&key);
                        }
                        if !self.parts.contains_key(&key)
                            && let Some(view) = super::level_display(
                                LevelHost {
                                    page: self.host.clone(),
                                    level: id.to_string(),
                                    surface: DisplaySurface::Page,
                                },
                                window,
                                cx,
                            )
                        {
                            self.parts
                                .insert(key.clone(), (level.settings.display.clone(), view));
                        }
                        self.sections.push(Section {
                            id: key.clone(),
                            kind: level.settings.display.clone(),
                            name: t(cx, keys::v3_shell::ENTRIES).to_string(),
                            registered: self.parts.contains_key(&key),
                        });
                        let display = if let Some((_, p)) = self.parts.get(&key) {
                            p.view.clone().into_any_element()
                        } else {
                            placeholder_display(&self.host, id.as_str(), cx)
                        };
                        content = content.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .child(t(cx, keys::v3_shell::ENTRIES))
                                .child(display),
                        );
                        self.sections.push(Section {
                            id: "settings".into(),
                            kind: "settings".into(),
                            name: t(cx, keys::v3_shell::SETTINGS).to_string(),
                            registered: false,
                        });
                        // Settings controls belong to G2/K5. Show the effective display
                        // using the agreed labels; no help text is invented here.
                        content = content.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .child(t(cx, keys::v3_shell::SETTINGS))
                                .child(display_name(&level.settings.display, cx)),
                        );
                    } else if let Some(template) = v3.template_of(id.as_str()) {
                        for spec in &template.modules {
                            content =
                                content.child(self.module(id.as_str(), spec.clone(), window, cx));
                        }
                    }
                    let active: Vec<_> = self
                        .sections
                        .iter()
                        .map(|s| format!("module:{}", s.id))
                        .chain(std::iter::once("display".into()))
                        .collect();
                    self.parts.retain(|k, _| active.contains(k));
                    if self.pending_reveal {
                        let wanted = module.as_ref().map(|m| m.as_str()).or_else(|| {
                            self.revealed.and_then(|_| {
                                self.sections
                                    .iter()
                                    .find(|s| s.kind == "prose")
                                    .map(|s| s.id.as_str())
                            })
                        });
                        if let Some(wanted) = wanted {
                            if let Some(i) = self.sections.iter().position(|s| s.id == wanted) {
                                self.scroll.scroll_to_item(
                                    if v3.levels.contains_key(id.as_str()) {
                                        1
                                    } else {
                                        i + 1
                                    },
                                );
                            }
                            if let Some((_, part)) = self.parts.get(&format!("module:{wanted}"))
                                && let Some(reveal) = &part.reveal
                            {
                                reveal(self.revealed, window, cx);
                            }
                        }
                        self.pending_reveal = false;
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
                    Some(
                        dr_ui::components::SandCell::new(
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
                        }),
                    )
                }),
        )
        .into_any_element()
}
