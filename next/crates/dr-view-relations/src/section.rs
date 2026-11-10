//! Entry/material relations module.

use dr_i18n::keys;
use dr_i18n::keys::references_panel as rp;
use dr_shell::nav::Open;
use dr_shell::strings::t;
use dr_ui::Theme;
use dr_ui::components::Button;
use dr_ui::sand::Icon;
use dr_workspace::dto::Target as End;
use gpui::{
    App, AppContext as _, Context, IntoElement, ParentElement as _, Render, SharedString,
    Styled as _, Window, div,
};

use crate::look::{self};
use crate::model;

pub fn register_modules(cx: &mut App) {
    dr_shell::v3::add_module_view(cx, "relations", |host, window, cx| {
        let view = cx.new(|cx| EntryRelations::new(host, window, cx));
        let weak = view.downgrade();
        dr_shell::v3::Rendered::new(view).on_refresh(move |book, cx| {
            weak.update(cx, |v, cx| {
                v.host.page.book = book;
                v.reload(cx);
            })
            .ok();
        })
    });
}

struct EntryRelations {
    host: dr_shell::v3::ModuleHost,
    rows: Vec<dr_workspace::commands::v3::content::Relation>,
    types: Vec<dr_workspace::commands::v3::content::RelationTypeInfo>,
    materials: Vec<(String, String)>,
    other: Option<End>,
    relation_type: Option<String>,
    incoming: bool,
    busy: bool,
    error: bool,
    reading: bool,
    stale: bool,
}
impl EntryRelations {
    fn allows(&self, ty: &dr_workspace::commands::v3::content::RelationType) -> bool {
        let Some(other) = &self.other else {
            return false;
        };
        let own = model::end("entry", &self.host.entry);
        let (from, to) = if self.incoming {
            (other, &own)
        } else {
            (&own, other)
        };
        let fits = |end: &End, kinds: &[String], templates: &[String]| {
            (kinds.is_empty() || kinds.contains(&end.kind))
                && (templates.is_empty()
                    || (end.kind == "entry"
                        && self
                            .host
                            .page
                            .book
                            .v3()
                            .and_then(|b| b.entry(&end.id))
                            .and_then(|e| e.template.as_ref())
                            .is_some_and(|t| templates.contains(t))))
        };
        fits(from, &ty.source_kinds, &ty.source_templates)
            && fits(to, &ty.target_kinds, &ty.target_templates)
    }
    fn new(host: dr_shell::v3::ModuleHost, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut v = Self {
            host,
            rows: Vec::new(),
            types: Vec::new(),
            materials: Vec::new(),
            other: None,
            relation_type: None,
            incoming: false,
            busy: false,
            error: false,
            reading: false,
            stale: false,
        };
        v.reload(cx);
        v
    }
    fn target(&self) -> dr_workspace::commands::v3::module::In {
        dr_workspace::commands::v3::module::In {
            book: self.host.page.book_id.clone(),
            entry: self.host.entry.clone(),
            module: self.host.module.id.clone(),
        }
    }
    fn reload(&mut self, cx: &mut Context<Self>) {
        if self.reading {
            self.stale = true;
            return;
        }
        self.reading = true;
        let (lib, input) = (self.host.page.library.clone(), self.target());
        let job = cx.background_spawn(async move {
            use dr_workspace::{
                Actor,
                commands::{
                    BookIn,
                    v3::{content::RelationTypes, module::ModuleRead},
                },
            };
            let types = lib
                .run::<RelationTypes>(
                    &Actor::User,
                    BookIn {
                        book: input.book.clone(),
                    },
                )?
                .output;
            let handle = lib
                .library()
                .open_doc(&format!("book:{}", input.book), dr_store::OpenDoc::Existing)?;
            let book = dr_model::id::BookId::parse(&input.book)
                .map_err(|e| dr_workspace::WsError::Invalid(e.to_string()))?;
            let materials = handle.read(move |d| {
                dr_doc::v3::BookReaderV3::from_loro(book, d).map(|r| {
                    r.view()
                        .materials()
                        .into_iter()
                        .map(|m| (m.id.to_string(), m.title))
                        .collect::<Vec<_>>()
                })
            })??;
            let data = lib.run::<ModuleRead>(&Actor::User, input)?.output;
            Ok::<_, dr_workspace::WsError>((types, data.relations, materials))
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |v, cx| {
                v.reading = false;
                match result {
                    Ok((types, rows, materials)) => {
                        v.types = types;
                        v.rows = rows;
                        v.materials = materials;
                    }
                    Err(e) => {
                        log::warn!("entry relations: {e}");
                        v.error = true;
                    }
                }
                if v.stale {
                    v.stale = false;
                    v.reload(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
    fn save(&mut self, remove: Option<String>, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let (lib, input, other, relation_type, incoming) = (
            self.host.page.library.clone(),
            self.target(),
            self.other.clone(),
            self.relation_type.clone(),
            self.incoming,
        );
        if remove.is_none() && (other.is_none() || relation_type.is_none()) {
            return;
        }
        self.busy = true;
        self.error = false;
        let job = cx.background_spawn(async move {
            use dr_workspace::{Actor, commands::v3::content};
            if let Some(id) = remove {
                lib.run::<content::RelationRemove>(
                    &Actor::User,
                    content::RecordIn { target: input, id },
                )?;
            } else if let (Some(other), Some(relation_type)) = (other, relation_type) {
                lib.run::<content::RelationPut>(
                    &Actor::User,
                    content::RelationIn {
                        target: input,
                        other: content::Ref {
                            kind: other.kind,
                            id: other.id,
                        },
                        relation_type,
                        incoming,
                    },
                )?;
            }
            Ok::<_, dr_workspace::WsError>(())
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |v, cx| {
                v.busy = false;
                match result {
                    Ok(()) => v.reload(cx),
                    Err(e) => {
                        log::warn!("entry relation write: {e}");
                        v.error = true;
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
    fn shown(
        &self,
        end: &dr_workspace::commands::v3::content::Ref,
    ) -> Option<(dr_shell::nav::Target, String)> {
        if end.kind == "entry" {
            let entry = self.host.page.book.v3()?.entry(&end.id)?;
            Some((dr_shell::v3::entry_target(&end.id)?, entry.title.clone()))
        } else if end.kind == "material" {
            let title = self
                .materials
                .iter()
                .find(|(id, _)| id == &end.id)?
                .1
                .clone();
            Some((dr_shell::nav::Target::Material(end.id.parse().ok()?), title))
        } else {
            None
        }
    }
}
impl Render for EntryRelations {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use dr_ui::components::{Select, select::Choice};
        let mut content = div().flex().flex_col().gap_3();
        for row in &self.rows {
            let outgoing = row.from.kind == "entry" && row.from.id == self.host.entry;
            let other = if outgoing { &row.to } else { &row.from };
            let Some((target, title)) = self.shown(other) else {
                continue;
            };
            let ty = self
                .types
                .iter()
                .find(|t| t.definition.id == row.relation_type)
                .map(|t| t.definition.name.clone())
                .unwrap_or_default();
            let ws = self.host.page.workspace.clone();
            let (mark, color) = self.host.page.book.mark(&target);
            let id = row.id.clone();
            content = content.child(
                div()
                    .flex()
                    .flex_row()
                    .gap_3()
                    .items_center()
                    .child(
                        dr_ui::components::SandCell::new(
                            SharedString::from(format!("v3-related-{id}")),
                            title,
                        )
                        .mark(mark)
                        .color_opt(color)
                        .on_click(move |_, _, cx| {
                            ws.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx))
                                .ok();
                        }),
                    )
                    .child(format!("{} {ty}", if outgoing { "→" } else { "←" }))
                    .child(
                        Button::new(
                            SharedString::from(format!("v3-unlink-{id}")),
                            t(cx, keys::common::DELETE),
                        )
                        .on_click(cx.listener(move |v, _, _, cx| v.save(Some(id.clone()), cx))),
                    ),
            );
        }
        let mut ends = Vec::new();
        if let Some(book) = self.host.page.book.v3() {
            ends.extend(
                book.entries
                    .iter()
                    .filter(|e| e.id != self.host.entry && e.deleted_at.is_none())
                    .map(|e| (model::end("entry", &e.id), e.title.clone())),
            );
        }
        ends.extend(
            self.materials
                .iter()
                .map(|(id, title)| (model::end("material", id), title.clone())),
        );
        let mut choices = vec![Choice::new(Icon::Plus, t(cx, keys::k4_pages::UNSET))];
        choices.extend(
            ends.iter()
                .map(|(_, title)| Choice::new(Icon::ChevronRight, title.clone())),
        );
        let selected = self
            .other
            .as_ref()
            .and_then(|o| {
                ends.iter()
                    .position(|(e, _)| e.kind == o.kind && e.id == o.id)
            })
            .map_or(0, |i| i + 1);
        let weak = cx.weak_entity();
        let pick = Select::new("v3-relation-target", choices, selected)
            .max_menu_height(280.0)
            .on_change(move |i, _, cx| {
                weak.update(cx, |v, cx| {
                    v.other = i
                        .checked_sub(1)
                        .and_then(|i| ends.get(i))
                        .map(|(e, _)| e.clone());
                    v.relation_type = None;
                    cx.notify();
                })
                .ok();
            });
        let types: Vec<_> = self
            .types
            .iter()
            .filter(|t| !t.locked && self.allows(&t.definition))
            .map(|t| (t.definition.id.clone(), t.definition.name.clone()))
            .collect();
        let selected = self
            .relation_type
            .as_ref()
            .and_then(|id| types.iter().position(|(i, _)| i == id))
            .map_or(0, |i| i + 1);
        let mut choices = vec![Choice::new(Icon::Plus, t(cx, keys::k4_pages::UNSET))];
        choices.extend(
            types
                .iter()
                .map(|(_, title)| Choice::new(Icon::ChevronRight, title.clone())),
        );
        let weak = cx.weak_entity();
        let type_pick = Select::new("v3-relation-type", choices, selected)
            .max_menu_height(280.0)
            .on_change(move |i, _, cx| {
                weak.update(cx, |v, cx| {
                    v.relation_type = i
                        .checked_sub(1)
                        .and_then(|i| types.get(i))
                        .map(|(id, _)| id.clone());
                    cx.notify();
                })
                .ok();
            });
        content = content.child(
            div()
                .flex()
                .flex_row()
                .flex_wrap()
                .gap_2()
                .child(pick)
                .child(type_pick)
                .child(
                    Button::new(
                        "v3-relation-direction",
                        if self.incoming { "←" } else { "→" },
                    )
                    .on_click(cx.listener(|v, _, _, cx| {
                        v.incoming = !v.incoming;
                        v.relation_type = None;
                        cx.notify();
                    })),
                )
                .child(
                    Button::new("v3-relation-add", t(cx, rp::actions::LINK_ENTITY))
                        .disabled(self.busy || self.other.is_none() || self.relation_type.is_none())
                        .on_click(cx.listener(|v, _, _, cx| v.save(None, cx))),
                ),
        );
        if self.error {
            content = content.child(t(cx, keys::k4_pages::SAVE_FAILED));
        }
        look::column(look::look(cx), content)
            .text_color(Theme::of(window, cx).palette.ink(1).solid())
    }
}
