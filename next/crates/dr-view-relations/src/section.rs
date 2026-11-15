//! Entry/asset relations module (`v5-tracks.md` lines 404, 413).

use std::path::PathBuf;

use dr_i18n::keys;
use dr_i18n::keys::references_panel as rp;
use dr_shell::nav::Open;
use dr_shell::pages::UsageFlash;
use dr_shell::strings::t;
use dr_store::asset::Variant;
use dr_ui::Theme;
use dr_ui::components::Button;
use dr_ui::fonts::Role;
use dr_ui::sand::{self, Icon, SandFrame};
use dr_ui::style::DrStyled as _;
use dr_ui::tokens::radius;
use dr_workspace::dto::Target as End;
use dr_workspace::events::WsEvent;
use gpui::{
    App, AppContext as _, Context, ElementId, InteractiveElement as _, IntoElement, ObjectFit,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, Task, Window, div, img, px,
};

use crate::look;
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

#[derive(Clone, Debug)]
struct LiveAssetRow {
    id: String,
    name: String,
    kind: String,
    thumb: Option<PathBuf>,
}

#[doc(hidden)]
pub struct EntryRelations {
    host: dr_shell::v3::ModuleHost,
    rows: Vec<dr_workspace::commands::v3::content::Relation>,
    types: Vec<dr_workspace::commands::v3::content::RelationTypeInfo>,
    assets: Vec<LiveAssetRow>,
    other: Option<End>,
    relation_type: Option<String>,
    incoming: bool,
    busy: bool,
    error: bool,
    reading: bool,
    stale: bool,
    _bus: Option<dr_workspace::events::Subscription>,
    _bus_task: Option<Task<()>>,
}

impl EntryRelations {
    pub fn new(host: dr_shell::v3::ModuleHost, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        let watched_book = host.page.book_id.clone();
        let bus = host.page.library.subscribe(move |ev| {
            if let WsEvent::Book(b) = ev
                && b.book.as_str() == watched_book
            {
                let _ = tx.unbounded_send(());
            }
        });
        let bus_task = cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                while rx.try_recv().is_ok() {}
                if this.update(cx, |v, cx| v.reload(cx)).is_err() {
                    break;
                }
            }
        });

        let mut v = Self {
            host,
            rows: Vec::new(),
            types: Vec::new(),
            assets: Vec::new(),
            other: None,
            relation_type: None,
            incoming: false,
            busy: false,
            error: false,
            reading: false,
            stale: false,
            _bus: Some(bus),
            _bus_task: Some(bus_task),
        };
        v.reload(cx);
        v
    }

    pub fn is_settled(&self) -> bool {
        !self.reading && !self.stale && !self.busy
    }

    /// Rendered relation rows `(relation_id, other_kind, other_id, display_title, type_name)`.
    pub fn visible_rows(&self, cx: &App) -> Vec<(String, String, String, String, String)> {
        let mut out = Vec::new();
        for row in &self.rows {
            let outgoing = row.from.kind == "entry" && row.from.id == self.host.entry;
            let other = if outgoing { &row.to } else { &row.from };
            let Some((_, title, _)) = self.shown(other) else {
                continue;
            };
            let ty = self
                .types
                .iter()
                .find(|t| t.definition.id == row.relation_type)
                .map(|t| crate::type_name(t, cx))
                .unwrap_or_default();
            out.push((
                row.id.clone(),
                other.kind.clone(),
                other.id.clone(),
                title,
                ty,
            ));
        }
        out
    }

    /// Target `(kind, id)` pairs offered in the relation-creation picker.
    pub fn creation_ends(&self) -> Vec<(String, String)> {
        let mut ends = Vec::new();
        if let Some(book) = self.host.page.book.v3() {
            ends.extend(
                book.entries
                    .iter()
                    .filter(|e| e.id != self.host.entry && e.deleted_at.is_none())
                    .map(|e| ("entry".to_owned(), e.id.clone())),
            );
        }
        ends
    }

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
                    BookIn, ListIn,
                    asset::AssetList,
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
            let live_assets = lib
                .run::<AssetList>(
                    &Actor::User,
                    ListIn {
                        book: input.book.clone(),
                        trashed: false,
                    },
                )
                .map(|o| o.output)
                .unwrap_or_default();
            let store = lib.library();
            let assets: Vec<LiveAssetRow> = live_assets
                .into_iter()
                .map(|a| {
                    let variant_path = |v: Variant| {
                        store
                            .asset(&a.id, v)
                            .ok()
                            .flatten()
                            .filter(|r| r.path.exists())
                            .map(|r| r.path)
                    };
                    let thumb = variant_path(Variant::Thumbnail)
                        .or_else(|| variant_path(Variant::Display))
                        .or_else(|| {
                            (a.kind != "pdf")
                                .then(|| variant_path(Variant::Source))
                                .flatten()
                        });
                    LiveAssetRow {
                        id: a.id,
                        name: a.name,
                        kind: a.kind,
                        thumb,
                    }
                })
                .collect();
            let data = lib.run::<ModuleRead>(&Actor::User, input)?.output;
            Ok::<_, dr_workspace::WsError>((types, data.relations, assets))
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |v, cx| {
                v.reading = false;
                match result {
                    Ok((types, rows, assets)) => {
                        v.types = types;
                        v.rows = rows;
                        v.assets = assets;
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
    ) -> Option<(dr_shell::nav::Target, String, Option<&LiveAssetRow>)> {
        if end.kind == "entry" {
            let entry = self.host.page.book.v3()?.entry(&end.id)?;
            Some((
                dr_shell::v3::entry_target(&end.id)?,
                entry.title.clone(),
                None,
            ))
        } else if end.kind == "asset" || end.kind == "material" {
            let asset = self.assets.iter().find(|a| a.id == end.id)?;
            Some((
                dr_shell::nav::Target::Material(end.id.parse().ok()?),
                asset.name.clone(),
                Some(asset),
            ))
        } else {
            None
        }
    }
}

impl Render for EntryRelations {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use dr_ui::components::{Select, select::Choice};
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let mut content = div().flex().flex_col().gap_3();
        for row in &self.rows {
            let outgoing = row.from.kind == "entry" && row.from.id == self.host.entry;
            let other = if outgoing { &row.to } else { &row.from };
            let Some((target, title, file_asset)) = self.shown(other) else {
                continue;
            };
            let ty = self
                .types
                .iter()
                .find(|t| t.definition.id == row.relation_type)
                .map(|t| crate::type_name(t, cx))
                .unwrap_or_default();
            let ws = self.host.page.workspace.clone();
            let id = row.id.clone();
            let rkey = format!("relation:{id}");
            let lit = if file_asset.is_some() {
                UsageFlash::strength_for(
                    &[rkey.as_str(), id.as_str(), other.id.as_str()],
                    window,
                    cx,
                ) > 0.0
            } else {
                UsageFlash::strength_for(&[rkey.as_str(), id.as_str()], window, cx) > 0.0
            };
            if let Some(asset) = file_asset {
                let thumb_el = if let Some(path) = asset.thumb.clone() {
                    div()
                        .size(px(26.0))
                        .flex_none()
                        .rounded(px(radius::XS))
                        .overflow_hidden()
                        .bg(p.ink(1).alpha(0.05))
                        .child(img(path).size_full().object_fit(ObjectFit::Cover))
                        .into_any_element()
                } else {
                    let icon = if asset.kind == "pdf" {
                        Icon::FileText
                    } else {
                        Icon::Image
                    };
                    div()
                        .size(px(26.0))
                        .flex_none()
                        .rounded(px(radius::XS))
                        .bg(p.ink(1).alpha(0.05))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(sand::icon(icon, 14.0, p.ink(3).solid()))
                        .into_any_element()
                };
                let open_target = target.clone();
                content = content.child(
                    div()
                        .relative()
                        .flex()
                        .flex_row()
                        .gap(px(10.0))
                        .min_h(px(36.0))
                        .px(px(8.0))
                        .py(px(4.0))
                        .rounded(px(radius::XS))
                        .items_center()
                        .child(
                            div()
                                .id(SharedString::from(format!("v3-related-{id}")))
                                .cursor_pointer()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(10.0))
                                .on_click(move |_, _, cx| {
                                    ws.update(cx, |ws, cx| {
                                        ws.open(open_target.clone(), Open::KEEP, cx);
                                    })
                                    .ok();
                                })
                                .child(thumb_el)
                                .child(
                                    div()
                                        .font_role(Role::Ui)
                                        .type_px(s.body, s.line_body)
                                        .text_color(p.ink(1).solid())
                                        .truncate()
                                        .child(title),
                                )
                                .child(
                                    div()
                                        .font_role(Role::Index)
                                        .type_px(s.caption, s.line_caption)
                                        .text_color(p.ink(4).solid())
                                        .child(ty),
                                ),
                        )
                        .child(
                            Button::new(
                                SharedString::from(format!("v3-unlink-{id}")),
                                t(cx, keys::common::DELETE),
                            )
                            .on_click(cx.listener(move |v, _, _, cx| v.save(Some(id.clone()), cx))),
                        )
                        .child(
                            SandFrame::new(
                                ElementId::Name(format!("v3-rel-sf-{}", row.id).into()),
                                lit,
                            )
                            .color(p.accent),
                        ),
                );
            } else {
                let (mark, color) = self.host.page.book.mark(&target);
                content = content.child(
                    div()
                        .relative()
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
                        )
                        .child(
                            SandFrame::new(
                                ElementId::Name(format!("v3-rel-sf-{}", row.id).into()),
                                lit,
                            )
                            .color(p.accent),
                        ),
                );
            }
        }
        // Only live entries are offered in the relation-creation picker
        // (`v5-tracks.md` lines 404 & 413: creating Entry <-> Asset relations
        // has no UI entry point in this track).
        let mut ends = Vec::new();
        if let Some(book) = self.host.page.book.v3() {
            ends.extend(
                book.entries
                    .iter()
                    .filter(|e| e.id != self.host.entry && e.deleted_at.is_none())
                    .map(|e| (model::end("entry", &e.id), e.title.clone())),
            );
        }
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
            .map(|t| (t.definition.id.clone(), crate::type_name(t, cx)))
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
        look::column(look::look(cx), content).text_color(p.ink(1).solid())
    }
}
