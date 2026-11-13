//! V3 root-level tabs and the template collection. G2 owns display contents;
//! K5 owns creating and editing templates.
use super::{DisplaySurface, LevelHost, Rendered};
use crate::{
    nav::{Open, Target},
    pages::PageViewHost,
    strings::t,
};
use dr_i18n::keys;
use dr_ui::{
    Theme,
    components::{Button, SandCell, Segmented},
    fonts::Role,
};
use gpui::{prelude::*, *};
use std::{collections::BTreeMap, rc::Rc};

pub const MEMORY_KEY: &str = "v3.sidebar.level";

pub struct Sidebar {
    host: PageViewHost,
    selected: Option<String>,
    restored: bool,
    displays: BTreeMap<String, (String, Rendered)>,
}
impl Sidebar {
    pub fn new(host: PageViewHost) -> Self {
        Self {
            host,
            selected: None,
            restored: false,
            displays: BTreeMap::new(),
        }
    }
    pub fn sync(
        &mut self,
        host: PageViewHost,
        remembered: Option<String>,
        ready: bool,
        cx: &mut Context<Self>,
    ) {
        let previous = self.selected.clone();
        if self.host.book_id != host.book_id {
            self.selected = None;
            self.restored = false;
            self.displays.clear();
        }
        if !self.restored && ready {
            self.selected = remembered;
            self.restored = true;
        }
        let changed = !Rc::ptr_eq(&self.host.book, &host.book);
        self.host = host;
        let roots = self.roots();
        if !self.selected.as_ref().is_some_and(|id| roots.contains(id)) {
            self.selected = roots.first().cloned();
        }
        if changed {
            self.displays.retain(|id, (kind, _)| {
                self.host
                    .book
                    .v3()
                    .and_then(|v| v.levels.get(id))
                    .is_some_and(|level| roots.contains(id) && level.settings.display == *kind)
            });
            for (_, part) in self.displays.values() {
                if let Some(refresh) = &part.refresh {
                    refresh(self.host.book.clone(), cx);
                }
            }
        }
        if changed || self.selected != previous {
            cx.notify();
        }
    }
    pub fn roots(&self) -> Vec<String> {
        self.host
            .book
            .v3()
            .map(|v| {
                v.roots
                    .iter()
                    .filter(|id| v.levels.contains_key(*id))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
    pub fn select(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.roots().iter().any(|root| root == id) {
            return;
        }
        self.selected = Some(id.into());
        self.restored = true;
        if let Some(ws) = self.host.workspace.upgrade() {
            ws.update(cx, |ws, cx| {
                ws.set_book_memory(MEMORY_KEY, serde_json::json!(id), cx)
            });
        }
        cx.notify();
    }
    pub fn state(&self) -> serde_json::Value {
        let v = self.host.book.v3();
        serde_json::json!({
            "roots": self.roots(), "selected": self.selected,
            "display": self.selected.as_ref().and_then(|id| v?.levels.get(id)).map(|l| &l.settings.display),
            "registered": self.selected.as_ref().is_some_and(|id| self.displays.contains_key(id)),
            "templates": v.map(|v| v.templates.iter().filter(|t| t.deleted_at.is_none()).map(|t| &t.id).collect::<Vec<_>>()).unwrap_or_default()
        })
    }
}
impl Render for Sidebar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let roots = self.roots();
        let book = self.host.book.clone();
        let Some(v) = book.v3() else {
            return div().into_any_element();
        };
        let selected = self
            .selected
            .as_ref()
            .and_then(|id| roots.iter().position(|r| r == id))
            .unwrap_or(0);
        let labels: Vec<SharedString> = roots
            .iter()
            .filter_map(|id| v.entry(id))
            .map(|e| e.title.clone().into())
            .collect();
        let mut content = div().flex().flex_col().min_h_0().size_full();
        if !roots.is_empty() {
            let tabs = roots.clone();
            let weak = cx.entity().downgrade();
            content = content.child(
                div()
                    .id("v3-level-tabs-scroll")
                    .overflow_x_scroll()
                    .flex_shrink_0()
                    .px_2()
                    .child(
                        Segmented::new("v3-level-tabs", labels, selected)
                            .font(Role::Structure)
                            .on_change(move |index, _, cx| {
                                if let Some(id) = tabs.get(index) {
                                    let _ = weak.update(cx, |this, cx| this.select(id, cx));
                                }
                            }),
                    ),
            );
        }
        let body = if let Some(id) = self.selected.clone() {
            if !self.displays.contains_key(&id)
                && let Some(part) = super::level_display(
                    LevelHost {
                        page: self.host.clone(),
                        level: id.clone(),
                        surface: DisplaySurface::Sidebar,
                    },
                    window,
                    cx,
                )
            {
                self.displays
                    .insert(id.clone(), (v.levels[&id].settings.display.clone(), part));
            }
            match self.displays.get(&id) {
                Some((_, part)) => part.view.clone().into_any_element(),
                None => div()
                    .id("v3-sidebar-placeholder")
                    .overflow_y_scroll()
                    .size_full()
                    .child(super::page::placeholder_display(&self.host, &id, cx))
                    .into_any_element(),
            }
        } else {
            div().into_any_element()
        };
        let loose_roots: Vec<AnyElement> = v
            .roots
            .iter()
            .filter(|id| !v.levels.contains_key(*id))
            .filter_map(|id| {
                let entry = v.entry(id)?;
                let target = super::entry_target(id)?;
                let weak = self.host.workspace.clone();
                let (mark, color) = book.mark(&target);
                let selected = weak
                    .upgrade()
                    .is_some_and(|ws| ws.read(cx).nav.is_selected(&target));
                let card_target = target.clone();
                let card_ws = weak.upgrade();
                let cell = SandCell::new(
                    SharedString::from(format!("v3-root-row-{id}")),
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
                        format!("v3-root-entry-{id}"),
                        cell,
                        &card_target,
                        &ws,
                        Default::default(),
                        cx,
                    ),
                    None => cell.into_any_element(),
                })
            })
            .collect();
        content = content.child(div().flex_1().min_h_0().px_2().py_2().child(body));
        if !loose_roots.is_empty() {
            content = content.child(
                div()
                    .id("v3-loose-roots")
                    .flex_shrink_0()
                    .max_h(px(144.0))
                    .overflow_y_scroll()
                    .px_2()
                    .py_1()
                    .flex()
                    .flex_col()
                    .children(loose_roots),
            );
        }
        let mut templates = div()
            .id("v3-template-list")
            .overflow_y_scroll()
            .max_h(px(168.0))
            .flex()
            .flex_col();
        for template in v.templates.iter().filter(|t| t.deleted_at.is_none()) {
            let Ok(id) = template.id.parse() else {
                continue;
            };
            let target = Target::Template(id);
            let (mark, color) = book.mark(&target);
            let weak = self.host.workspace.clone();
            let selected = weak
                .upgrade()
                .is_some_and(|ws| ws.read(cx).nav.is_selected(&target));
            templates = templates.child(
                SandCell::new(
                    SharedString::from(format!("v3-template-{}", template.id)),
                    template.name.clone(),
                )
                .mark(mark)
                .color_opt(color)
                .selected(selected)
                .on_click(move |_, _, cx| {
                    if let Some(ws) = weak.upgrade() {
                        ws.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
                    }
                }),
            );
        }
        let host = self.host.clone();
        content
            .child(
                div()
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_2()
                    .child(
                        div()
                            .text_color(theme.palette.muted().solid())
                            .child(t(cx, keys::v3_shell::TEMPLATES)),
                    )
                    .child(templates)
                    .child(
                        Button::new("v3-new-template", t(cx, keys::v3_shell::NEW_TEMPLATE))
                            .disabled(!super::has_template_creator(cx))
                            .on_click(move |_, window, cx| {
                                super::create_template(host.clone(), window, cx)
                            }),
                    ),
            )
            .into_any_element()
    }
}
