//! Right-hand Material shelf for M23: kind chips, searchable v3 entry filter,
//! `+` create/import menu, grouped `MaterialCard` grid, and per-card hover
//! actions (open, open in system, v3 entry links, folder moves, delete).

use dr_i18n::keys;
use dr_shell::{nav::Target, strings::tf, t};
use dr_ui::{
    Theme,
    components::{
        Button, CardAction, CardBody, Chip, EmptyState, HoverCard, IconButton, Menu, MenuItem,
        menu::{MenuWidth, RowIcon, float_shadow, slab_edge},
        overlay::{self, Layer, Place},
    },
    fonts::{Role, weight},
    glass::{self, Ground},
    sand::{self, Icon},
    style::DrStyled,
    tokens::{menu as m, radius},
};
use dr_view_material::{
    card::{self, MaterialCard},
    folders::{Selection, Tree},
    previews,
};
use dr_workspace::dto::MaterialInfo;
use gpui::{
    AnyElement, Context, ExternalPaths, InteractiveElement, IntoElement, ParentElement,
    PathPromptOptions, SharedString, StatefulInteractiveElement as _, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::{
    model::{KIND_ORDER, matches_material, normalize_query},
    view::ShelfReviewView,
};

impl ShelfReviewView {
    /// Visible materials after search query, kind chips and v3 entry relation filter.
    pub fn visible_materials(&self, cx: &mut gpui::App) -> Vec<MaterialInfo> {
        let query = normalize_query(&self.query_text(cx));
        let folders = self.book.material_folders();
        let items = self.book.material_items();
        let tree = Tree::new(folders, items, None);
        items
            .iter()
            .filter(|mat| self.active_kinds.contains(mat.kind.as_str()))
            .filter(|mat| match &self.selected_entry {
                Some(_) => self
                    .entry_related_materials
                    .as_ref()
                    .is_some_and(|set| set.contains(&mat.id)),
                None => true,
            })
            .filter(|mat| {
                if query.is_empty() {
                    return true;
                }
                let words = if mat.kind == "text" {
                    previews::first_words(&mat.id, cx)
                } else {
                    None
                };
                let folder_path = mat
                    .folder
                    .as_deref()
                    .map(|fid| tree.path(fid))
                    .filter(|p| !p.is_empty());
                matches_material(mat, words.as_deref(), folder_path.as_deref(), &query)
            })
            .cloned()
            .collect()
    }

    /// Visible materials that currently have zero live relations to any live entity.
    pub fn orphan_materials(&self, cx: &mut gpui::App) -> Vec<MaterialInfo> {
        self.visible_materials(cx)
            .into_iter()
            .filter(|mat| !self.linked_materials.contains(&mat.id))
            .collect()
    }

    pub(crate) fn render_material_hover_card(
        &self,
        id_prefix: &'static str,
        material: &MaterialInfo,
        target_el: impl IntoElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let view_weak = cx.weak_entity();
        let mat = material.clone();
        let folders = self.book.material_folders().to_vec();
        let all_items = self.book.material_items().to_vec();
        let card_id = SharedString::from(format!("{id_prefix}-hover-{}", mat.id));

        HoverCard::new(card_id, target_el, move |_, cx| {
            let title: SharedString = if mat.title.trim().is_empty() {
                t(cx, keys::material_folders::UNTITLED)
            } else {
                mat.title.clone().into()
            };
            let tree = Tree::new(&folders, &all_items, None);
            let root_label = t(cx, keys::material_folders::ROOT).to_string();
            let folder_summary = mat
                .folder
                .as_deref()
                .map(|fid| tree.path(fid))
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| card::kind_label(&mat.kind, cx).to_string());

            let links = if let Some(view) = view_weak.upgrade() {
                view.update(cx, |this, cx| {
                    this.ensure_entry_links(&mat.id, cx);
                    this.entry_links_cache.get(&mat.id).cloned()
                })
            } else {
                None
            };

            let mut primary_rows = Vec::new();
            let open_id = mat.id.clone();
            let open_view = view_weak.clone();
            primary_rows.push(
                CardAction::new(
                    SharedString::from(format!("{id_prefix}-act-open-{}", mat.id)),
                    Icon::ArrowForward,
                    t(cx, keys::material_folders::menu::OPEN),
                )
                .on_click(move |_, _, cx| {
                    if let Some(v) = open_view.upgrade() {
                        v.update(cx, |this, cx| this.open_material(&open_id, cx));
                    }
                })
                .into_any_element(),
            );

            if matches!(mat.kind.as_str(), "image" | "pdf") {
                let sys_id = mat.id.clone();
                let sys_view = view_weak.clone();
                primary_rows.push(
                    CardAction::new(
                        SharedString::from(format!("{id_prefix}-act-sys-{}", mat.id)),
                        Icon::ArrowOut,
                        t(cx, keys::memo_material::menu::OPEN_IN_SYSTEM),
                    )
                    .on_click(move |_, _, cx| {
                        if let Some(v) = sys_view.upgrade() {
                            v.update(cx, |this, cx| this.open_material_in_system(&sys_id, cx));
                        }
                    })
                    .into_any_element(),
                );
            }

            let mut body = CardBody::new(
                SharedString::from(format!("{id_prefix}-body-{}", mat.id)),
                title,
            )
            .mark(sand::Kind::Material, None)
            .summary(folder_summary)
            .section(primary_rows);

            if let Some(choices) = links.filter(|c| !c.is_empty()) {
                let mut link_rows = Vec::new();
                for choice in choices.into_iter().take(10) {
                    let mat_id = mat.id.clone();
                    let entry_id = choice.id.clone();
                    let next_linked = !choice.linked;
                    let link_view = view_weak.clone();
                    let label: SharedString = if choice.title.trim().is_empty() {
                        t(cx, keys::material_folders::UNTITLED)
                    } else {
                        choice.title.into()
                    };
                    let icon = if choice.linked {
                        Icon::Check
                    } else {
                        Icon::Plus
                    };
                    link_rows.push(
                        CardAction::new(
                            SharedString::from(format!(
                                "{id_prefix}-link-{}-{}",
                                mat.id, choice.id
                            )),
                            icon,
                            label,
                        )
                        .current(choice.linked)
                        .on_click(move |_, _, cx| {
                            if let Some(v) = link_view.upgrade() {
                                v.update(cx, |this, cx| {
                                    this.toggle_material_entry_link(
                                        &mat_id,
                                        &entry_id,
                                        next_linked,
                                        cx,
                                    );
                                });
                            }
                        })
                        .into_any_element(),
                    );
                }
                body = body.section(link_rows);
            }

            if !folders.is_empty() {
                let sel = Selection::material(&mat.id);
                let move_choices = tree.choices(&sel, mat.folder.as_deref(), &root_label);
                let mut folder_rows = Vec::new();
                for choice in move_choices.into_iter().take(8) {
                    let mat_id = mat.id.clone();
                    let dest = choice.folder.clone();
                    let move_view = view_weak.clone();
                    folder_rows.push(
                        CardAction::new(
                            SharedString::from(format!(
                                "{id_prefix}-move-{}-{}",
                                mat.id,
                                dest.as_deref().unwrap_or("root")
                            )),
                            Icon::Folder,
                            choice.path,
                        )
                        .current(choice.current)
                        .on_click(move |_, _, cx| {
                            if let Some(v) = move_view.upgrade() {
                                v.update(cx, |this, cx| {
                                    this.move_material_to_folder(&mat_id, dest.clone(), cx);
                                });
                            }
                        })
                        .into_any_element(),
                    );
                }
                if !folder_rows.is_empty() {
                    body = body.section(folder_rows);
                }
            }

            let del_id = mat.id.clone();
            let del_title = mat.title.clone();
            let del_view = view_weak.clone();
            body = body.section(vec![
                CardAction::new(
                    SharedString::from(format!("{id_prefix}-act-del-{}", mat.id)),
                    Icon::Trash,
                    t(cx, keys::material_folders::menu::DELETE),
                )
                .danger()
                .on_click(move |_, _, cx| {
                    if let Some(v) = del_view.upgrade() {
                        v.update(cx, |this, cx| {
                            this.open_delete_material_dialog(del_id.clone(), del_title.clone(), cx);
                        });
                    }
                })
                .into_any_element(),
            ]);

            body.into_any_element()
        })
        .into_any_element()
    }

    pub(crate) fn render_material_shelf(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let entity = cx.entity();
        let all_materials = self.book.material_items();
        let visible = self.visible_materials(cx);

        let entry_bounds = overlay::use_bounds("shelf-entry-filter-bounds", window, cx);
        let add_bounds = overlay::use_bounds("shelf-add-material-bounds", window, cx);

        // Kind filter chips in fixed order.
        let mut chips_row = div().flex().flex_row().items_center().gap(px(6.0));
        for kind in KIND_ORDER {
            let on = self.active_kinds.contains(kind);
            let count = all_materials.iter().filter(|m| m.kind == kind).count();
            let label = card::kind_label(kind, cx);
            let a11y = tf(
                cx,
                if on {
                    keys::memo_material::super_::HIDE_KIND
                } else {
                    keys::memo_material::super_::SHOW_KIND
                },
                &[("kind", &label.as_ref())],
            );
            let toggle_ent = entity.clone();
            chips_row = chips_row.child(
                div()
                    .id(SharedString::from(format!("shelf-kind-wrap-{kind}")))
                    .aria_label(a11y)
                    .child(
                        Chip::new(
                            SharedString::from(format!("shelf-kind-chip-{kind}")),
                            label,
                            on,
                        )
                        .count(count)
                        .on_change(move |next, _, cx| {
                            toggle_ent.update(cx, |this, cx| this.set_kind_enabled(kind, next, cx));
                        }),
                    ),
            );
        }

        // Entry relation filter trigger + clear button.
        let selected_label: SharedString = self
            .selected_entry
            .as_deref()
            .and_then(|id| {
                self.book.v3().and_then(|b| b.entry(id)).map(|e| {
                    if e.title.trim().is_empty() {
                        t(cx, keys::material_folders::UNTITLED)
                    } else {
                        e.title.clone().into()
                    }
                })
            })
            .unwrap_or_else(|| t(cx, keys::memo_material::super_::ENTITY_FILTER_ALL));

        let open_filter_ent = entity.clone();
        let mut filter_group = div()
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(2.0))
            .child(overlay::probe(entry_bounds.clone()))
            .child(
                Button::new("shelf-entry-filter-trigger", selected_label)
                    .small()
                    .on_click(move |_, window, cx| {
                        open_filter_ent.update(cx, |this, cx| {
                            this.toggle_entry_menu(window, cx);
                        });
                    }),
            );

        if self.selected_entry.is_some() {
            let clear_ent = entity.clone();
            filter_group = filter_group.child(
                IconButton::new("shelf-entry-filter-clear", Icon::Close)
                    .label(t(cx, keys::memo_material::super_::CLEAR_ENTITY_FILTER))
                    .on_click(move |_, _, cx| {
                        clear_ent.update(cx, |this, cx| this.set_entry_filter(None, cx));
                    }),
            );
        }

        // `+` New material button.
        let add_ent = entity.clone();
        let add_trigger = div()
            .relative()
            .child(overlay::probe(add_bounds.clone()))
            .child(
                Button::new(
                    "shelf-new-material-trigger",
                    t(cx, keys::memo_material::super_::NEW_MATERIAL_BUTTON),
                )
                .small()
                .icon(Icon::Plus)
                .disabled(crate::is_frozen(cx) || self.lib.is_none())
                .on_click(move |_, _, cx| {
                    add_ent.update(cx, |this, cx| {
                        this.add_menu_open = !this.add_menu_open;
                        this.entry_menu_open = false;
                        cx.notify();
                    });
                }),
            );

        let header = div()
            .flex_none()
            .min_h(px(40.0))
            .px(px(14.0))
            .py(px(6.0))
            .border_b(px(0.5))
            .border_color(p.subtle_hairline())
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(8.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_baseline()
                    .gap(px(6.0))
                    .child(
                        div()
                            .font_role(Role::Structure)
                            .type_px(s.secondary, s.line_body)
                            .weight(weight::MEDIUM)
                            .text_color(p.ink(1).solid())
                            .child(t(cx, keys::memo_material::super_::MATERIAL)),
                    )
                    .child(
                        div()
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(3).solid())
                            .child(visible.len().to_string()),
                    ),
            )
            .child(chips_row)
            .child(div().flex_1())
            .child(filter_group)
            .child(add_trigger);

        let body = if all_materials.is_empty() {
            let empty_ent = entity.clone();
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .items_center()
                .justify_center()
                .px(px(24.0))
                .child(
                    EmptyState::new(
                        "shelf-empty-materials",
                        t(cx, keys::memo_material::super_::NO_MATERIALS),
                    )
                    .mark(sand::Kind::Material)
                    .action(
                        Button::new(
                            "shelf-empty-create-note",
                            t(cx, keys::memo_material::super_::NEW_MATERIAL_BUTTON),
                        )
                        .on_click(move |_, window, cx| {
                            empty_ent.update(cx, |this, cx| this.open_new_note_dialog(window, cx));
                        }),
                    ),
                )
                .into_any_element()
        } else if visible.is_empty() {
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .items_center()
                .justify_center()
                .px(px(24.0))
                .child(
                    EmptyState::new(
                        "shelf-empty-filtered-materials",
                        t(cx, keys::memo_material::super_::NO_FILTERED_MATERIALS),
                    )
                    .mark(sand::Kind::Material),
                )
                .into_any_element()
        } else {
            let mut sections = div()
                .id("shelf-materials-scroll")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .px(px(14.0))
                .py(px(12.0))
                .flex()
                .flex_col()
                .gap(px(16.0));

            for kind in KIND_ORDER {
                let group: Vec<_> = visible.iter().filter(|m| m.kind == kind).cloned().collect();
                if group.is_empty() {
                    continue;
                }
                let mut grid = div().flex().flex_row().flex_wrap().gap(px(10.0));
                for mat in group.iter() {
                    let open_id = mat.id.clone();
                    let open_ent = entity.clone();
                    let card_el = MaterialCard::new(
                        SharedString::from(format!("shelf-mat-card-{}", mat.id)),
                        mat,
                    )
                    .width(172.0)
                    .on_click(move |_, _, cx| {
                        open_ent.update(cx, |this, cx| this.open_material(&open_id, cx));
                    });
                    grid =
                        grid.child(self.render_material_hover_card("shelf-mat", mat, card_el, cx));
                }
                sections = sections.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_baseline()
                                .gap(px(6.0))
                                .child(
                                    div()
                                        .font_role(Role::Structure)
                                        .type_px(s.caption, s.line_caption)
                                        .weight(weight::MEDIUM)
                                        .text_color(p.ink(3).solid())
                                        .child(card::kind_label(kind, cx)),
                                )
                                .child(
                                    div()
                                        .font_role(Role::Index)
                                        .type_px(s.caption, s.line_caption)
                                        .text_color(p.ink(4).solid())
                                        .child(group.len().to_string()),
                                ),
                        )
                        .child(grid),
                );
            }
            sections.into_any_element()
        };

        let drop_ent = entity.clone();
        let mut root = div()
            .id("shelf-review-materials-pane")
            .flex_1()
            .min_w(px(crate::model::LIBRARY_MIN_WIDTH))
            .min_h_0()
            .h_full()
            .flex()
            .flex_col()
            .on_drop(move |paths: &ExternalPaths, _, cx| {
                let list = paths.paths().to_vec();
                drop_ent.update(cx, |this, cx| this.import_external_files(list, cx));
            })
            .child(header)
            .child(body);

        if self.entry_menu_open
            && let Some(rect) = *entry_bounds.read(cx)
        {
            root = root.child(self.render_entry_filter_popover(rect, window, cx));
        }
        if self.add_menu_open
            && let Some(rect) = *add_bounds.read(cx)
        {
            root = root.child(self.render_add_material_menu(rect, window, cx));
        }

        root.into_any_element()
    }

    fn render_entry_filter_popover(
        &self,
        anchor: gpui::Bounds<gpui::Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let entity = cx.entity();
        let close_ent = entity.clone();
        let all_ent = entity.clone();

        let filter_query = self
            .entry_search
            .as_ref()
            .map(|f| normalize_query(&f.read(cx).text()))
            .unwrap_or_default();

        let mut list = div()
            .id("shelf-entry-filter-list")
            .max_h(px(280.0))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .child(
                MenuItem::new(
                    "shelf-entry-opt-all",
                    Icon::Check,
                    t(cx, keys::memo_material::super_::ALL),
                )
                .checked(self.selected_entry.is_none())
                .on_click(move |_, _, cx| {
                    all_ent.update(cx, |this, cx| this.set_entry_filter(None, cx));
                }),
            );

        if let Some(book_v3) = self.book.v3() {
            for entry in &book_v3.entries {
                if !filter_query.is_empty() && !entry.title.to_lowercase().contains(&filter_query) {
                    continue;
                }
                let entry_id = entry.id.clone();
                let checked = self.selected_entry.as_deref() == Some(entry_id.as_str());
                let mark = entry_id
                    .parse()
                    .ok()
                    .map(|id| self.book.mark(&Target::Entry { id, module: None }))
                    .unwrap_or((sand::Kind::Element, None));
                let title: SharedString = if entry.title.trim().is_empty() {
                    t(cx, keys::material_folders::UNTITLED)
                } else {
                    entry.title.clone().into()
                };
                let pick_ent = entity.clone();
                list = list.child(
                    MenuItem::new(
                        SharedString::from(format!("shelf-entry-opt-{entry_id}")),
                        RowIcon::Mark(mark.0, mark.1),
                        title,
                    )
                    .checked(checked)
                    .on_click(move |_, _, cx| {
                        pick_ent.update(cx, |this, cx| {
                            this.set_entry_filter(Some(entry_id.clone()), cx);
                        });
                    }),
                );
            }
        }

        let panel = div()
            .id("shelf-entry-filter-popover")
            .occlude()
            .relative()
            .w(px(MenuWidth::Wide.px()))
            .rounded(px(radius::SHEET))
            .bg(p.desk.solid())
            .shadow(float_shadow(p))
            .child(slab_edge(p, radius::SHEET))
            .child(
                div()
                    .relative()
                    .py(px(m::PAD_Y))
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .when_some(self.entry_search.clone(), |el, search| {
                        el.child(div().px(px(10.0)).pt(px(4.0)).pb(px(2.0)).child(search))
                    })
                    .child(list),
            )
            .on_mouse_down_out(move |_, _, cx| {
                close_ent.update(cx, |this, cx| {
                    this.entry_menu_open = false;
                    cx.notify();
                });
            });

        overlay::float(
            Place::below(anchor, 4.0),
            Layer::Popover,
            glass::surface(Ground::flat(p.desk), panel),
        )
        .into_any_element()
    }

    fn render_add_material_menu(
        &self,
        anchor: gpui::Bounds<gpui::Pixels>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let close_ent = entity.clone();
        let note_ent = entity.clone();
        let import_ent = entity.clone();

        let menu = Menu::new("shelf-add-material-menu")
            .item(
                MenuItem::new(
                    "shelf-add-note",
                    Icon::FileText,
                    t(cx, keys::memo_material::kind::TEXT),
                )
                .on_click(move |_, window, cx| {
                    note_ent.update(cx, |this, cx| this.open_new_note_dialog(window, cx));
                }),
            )
            .item(
                MenuItem::new(
                    "shelf-add-import-file",
                    Icon::Image,
                    t(cx, keys::material_editor::embed::IMPORT_FILE),
                )
                .on_click(move |_, _, cx| {
                    let rx = cx.prompt_for_paths(PathPromptOptions {
                        files: true,
                        directories: false,
                        multiple: true,
                        prompt: None,
                    });
                    import_ent.update(cx, |this, cx| {
                        this.add_menu_open = false;
                        cx.spawn(async move |view, cx| {
                            if let Ok(Ok(Some(paths))) = rx.await {
                                view.update(cx, |v, cx| v.import_external_files(paths, cx))
                                    .ok();
                            }
                        })
                        .detach();
                        cx.notify();
                    });
                }),
            );

        overlay::float(
            Place::Rect {
                rect: anchor,
                align: overlay::Align::End,
                gap: 4.0,
            },
            Layer::Popover,
            div().child(menu).on_mouse_down_out(move |_, _, cx| {
                close_ent.update(cx, |this, cx| {
                    this.add_menu_open = false;
                    cx.notify();
                });
            }),
        )
        .into_any_element()
    }
}
