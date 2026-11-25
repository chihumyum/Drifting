use super::interaction::{PinDrag, PinEdit, Resizing};
use super::*;
use dr_shell::{book::color_of, workspace::FillPlace};
use dr_ui::{
    Theme,
    components::{
        CardAction, CardBody, HoverCard, Layer, Menu, MenuItem, PanelIconButton, SandCell,
        menu::{section_label, separator},
        overlay::{self, Place},
    },
    fonts::Role as FontRole,
    glass::{self, Kind, Mode, Spec, Tone},
    sand::{self, Icon},
    style::DrStyled,
};

impl Timeline {
    fn header(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let mut row = div()
            .h(px(model::HEAD))
            .flex_none()
            .flex()
            .items_center()
            .gap_1()
            .px_2()
            .bg(theme.palette.desk.solid());
        if let Some(edit) = self
            .editing
            .as_ref()
            .filter(|e| matches!(e.kind, EditKind::View { .. }))
        {
            row = row.child(
                div()
                    .id("v3-timeline-editor")
                    .w(px(220.))
                    .role(gpui::Role::Group)
                    .aria_label(edit.field.read(cx).text())
                    .child(edit.field.clone()),
            );
        } else {
            let name = self
                .view()
                .map(|v| v.name.clone())
                .unwrap_or_else(|| t(cx, keys::v3_timeline::VIEWS).to_string());
            row = row.child(
                div()
                    .id("v3-timeline-views")
                    .role(gpui::Role::Button)
                    .aria_label(name.clone())
                    .cursor_pointer()
                    .flex()
                    .items_center()
                    .gap_1()
                    .child(name)
                    .child(sand::icon(
                        Icon::ChevronDown,
                        12.,
                        theme.palette.ink(3).solid(),
                    ))
                    .on_click(cx.listener(|this, e: &ClickEvent, _, cx| {
                        this.popup = Some(Popup::new(MenuOf::Views, e.position()));
                        cx.notify();
                    })),
            );
        }
        let filled = self
            .ws
            .upgrade()
            .is_some_and(|ws| ws.read(cx).is_filled(FillPlace::Bottom));
        let workspace = self.ws.clone();
        let has_view = self.view().is_some();
        let has_placed = self.has_placed_entries();
        let has_active_placed = self.active_entry_id(cx).is_some();
        row.when(has_view, |el| {
            el.child(
                PanelIconButton::new("v3-timeline-view-actions", Icon::More)
                    .label(t(cx, keys::v3_timeline::VIEW_ACTIONS))
                    .on_click(cx.listener(|this, e: &ClickEvent, _, cx| {
                        this.popup = Some(Popup::new(MenuOf::ViewActions, e.position()));
                        cx.notify();
                    })),
            )
        })
        .child(
            PanelIconButton::new("v3-timeline-new", Icon::Plus)
                .label(t(cx, keys::v3_timeline::NEW_VIEW))
                .on_click(cx.listener(|this, _, w, cx| this.rename(true, w, cx))),
        )
        .child(div().flex_1())
        .when(has_view, |el| {
            let book_view_label = t(cx, keys::v3_shell::BOOK_VIEW);
            let book_view_tip = if has_placed {
                book_view_label.clone()
            } else {
                t(cx, keys::v3_timeline::EMPTY_BOOK_VIEW)
            };
            el.child(
                PanelIconButton::new("v3-view-open-book", Icon::OpenBook)
                    .label(book_view_label)
                    .tooltip(book_view_tip)
                    .disabled(!has_placed)
                    .on_click(cx.listener(|this, _, _, cx| this.open_book_view(cx))),
            )
            .child(
                PanelIconButton::new("v3-timeline-spread", Icon::LanesStagger)
                    .label(t(cx, keys::story_graph::SPREAD))
                    .disabled(!has_placed)
                    .on_click(cx.listener(|this, _, _, cx| this.spread_overlaps(cx))),
            )
            .child(
                PanelIconButton::new("v3-timeline-locate", Icon::Locate)
                    .label(t(cx, keys::v3_timeline::LOCATE_CURRENT))
                    .disabled(!has_active_placed)
                    .on_click(cx.listener(|this, _, _, cx| this.locate_current_entry(cx))),
            )
            .child(
                div().debug_selector(|| "v3-timeline-lanes".into()).child(
                    PanelIconButton::new("v3-timeline-lanes", Icon::Layers)
                        .label(t(cx, keys::v3_timeline::ADD_LANE))
                        .on_click(cx.listener(|this, e: &ClickEvent, _, cx| {
                            this.popup = Some(Popup::new(MenuOf::Lanes, e.position()));
                            cx.notify();
                        })),
                ),
            )
        })
        .child(
            PanelIconButton::new(
                "v3-timeline-fill",
                if filled {
                    Icon::WindowRestore
                } else {
                    Icon::Fullscreen
                },
            )
            .label(t(
                cx,
                if filled {
                    keys::v5_fill::EXIT_FILL
                } else {
                    keys::v5_fill::FILL
                },
            ))
            .on_click(move |_, window, cx| {
                let _ =
                    workspace.update(cx, |ws, cx| ws.toggle_fill(FillPlace::Bottom, window, cx));
            }),
        )
        .into_any_element()
    }

    fn popup(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let popup = self.popup.as_ref()?;
        let book = self.book.v3()?;
        let theme = Theme::of(window, cx);
        let mut menu = div().flex().flex_col().flex_none();
        match &popup.of {
            MenuOf::Views => {
                for v in book
                    .timeline_views
                    .iter()
                    .filter(|v| v.deleted_at.is_none())
                {
                    let id = v.id.clone();
                    menu = menu.child(
                        MenuItem::new(
                            SharedString::from(format!("v3-view-{}", v.id)),
                            Icon::Bamboo,
                            v.name.clone(),
                        )
                        .checked(self.view().is_some_and(|selected| selected.id == v.id))
                        .on_click(cx.listener(move |this, _, _, cx| this.select(id.clone(), cx))),
                    );
                }
            }
            MenuOf::ViewActions => {
                menu = menu
                    .child(
                        MenuItem::new(
                            "v3-view-rename",
                            Icon::Edit,
                            t(cx, keys::v3_timeline::RENAME_VIEW),
                        )
                        .disabled(self.view().is_none())
                        .on_click(
                            cx.listener(|this, _, window, cx| this.rename(false, window, cx)),
                        ),
                    )
                    .child(
                        MenuItem::new(
                            "v3-view-delete",
                            Icon::Trash,
                            t(cx, keys::v3_timeline::DELETE_VIEW),
                        )
                        .danger()
                        .disabled(self.view().is_none())
                        .on_click(cx.listener(|this, _, _, cx| this.delete_view(cx))),
                    );
            }
            MenuOf::Entries(lane) | MenuOf::Bind(lane) => {
                let bind = matches!(&popup.of, MenuOf::Bind(_));
                if !bind {
                    let target = lane.clone();
                    menu = menu.child(
                        MenuItem::new(
                            "v3-lane-new-entry",
                            Icon::Plus,
                            t(cx, keys::v3_timeline::NEW_ENTRY_IN_LANE),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.create_entry_in_lane(target.clone(), cx);
                        })),
                    );
                }
                for e in book.entries.iter().filter(|e| e.deleted_at.is_none()) {
                    // Any entry can join a lane that accepts members.
                    if !bind && (&e.id == lane || !book.accepts_members(lane)) {
                        continue;
                    }
                    let id = e.id.clone();
                    let target = lane.clone();
                    let drag = self
                        .page_host()
                        .map(|page| EntryDrag::new(page, id.clone(), e.title.clone()));
                    let appearance = book.appearance(&id).expect("live entry appearance");
                    let mark = sand::KindMark::new(
                        SharedString::from(format!("v3-entry-pick-mark-{id}")),
                        appearance.sand,
                    )
                    .when_some(
                        appearance.color.as_deref().and_then(color_of),
                        |mark, color| mark.color(color),
                    );
                    let row = div()
                        .id(SharedString::from(format!("v3-entry-picker-{id}")))
                        .role(gpui::Role::Button)
                        .aria_label(e.title.clone())
                        .cursor_grab()
                        .px_3()
                        .py_1()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(mark)
                        .child(e.title.clone())
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if bind {
                                this.edit_pin(target.clone(), PinEdit::Bind(Some(id.clone())), cx);
                            } else {
                                let end = this
                                    .view()
                                    .map(|v| {
                                        v.placements
                                            .iter()
                                            .map(|p| p.at + p.span.unwrap_or(model::DEFAULT_SPAN))
                                            .fold(0., f64::max)
                                    })
                                    .unwrap_or(0.);
                                this.place(id.clone(), Some(target.clone()), end + 1., None, cx);
                            }
                        }))
                        .when_some(drag, |row, drag| {
                            row.on_drag(drag, {
                                let entity = cx.entity();
                                move |drag: &EntryDrag, offset, _, cx| {
                                    drag.set_grab(f32::from(offset.x));
                                    entity.update(cx, |this, cx| {
                                        this.popup = None;
                                        cx.notify();
                                    });
                                    cx.new(|_| Ghost {
                                        title: drag.title.clone(),
                                    })
                                }
                            })
                        });
                    menu = menu.child(row);
                }
            }
            MenuOf::Clip { entry, lane } => {
                let (entry, lane) = (entry.clone(), lane.clone());
                menu = menu.child(
                    MenuItem::new(
                        "v3-remove-entry",
                        Icon::Minus,
                        t(cx, keys::v3_timeline::REMOVE_ENTRY),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.remove_entry(entry.clone(), lane.clone(), cx)
                    })),
                );
            }
            MenuOf::Pin(id) => {
                let pin_id = id.clone();
                menu = menu.child(
                    MenuItem::new(
                        "v3-pin-rename",
                        Icon::Edit,
                        t(cx, keys::v3_timeline::RENAME_PIN),
                    )
                    .on_click(
                        cx.listener(move |this, _, w, cx| this.rename_pin(pin_id.clone(), w, cx)),
                    ),
                );
                let pin_id = id.clone();
                menu = menu.child(
                    MenuItem::new(
                        "v3-pin-bind",
                        Icon::KnotLinks,
                        t(cx, keys::v3_timeline::BIND_ENTRY),
                    )
                    .on_click(cx.listener(
                        move |this, e: &ClickEvent, _, cx| {
                            this.popup =
                                Some(Popup::new(MenuOf::Bind(pin_id.clone()), e.position()));
                            cx.notify();
                        },
                    )),
                );
                if let Some(pin) = self
                    .view()
                    .and_then(|v| v.pins.iter().find(|p| &p.id == id))
                    && let Some(entry) = &pin.entry
                {
                    let entry = entry.clone();
                    menu = menu.child(
                        MenuItem::new("v3-pin-open", Icon::ArrowIn, t(cx, keys::v3_shell::OPEN))
                            .on_click(cx.listener(move |this, e, _, cx| this.open(&entry, e, cx))),
                    );
                    let pin_id = id.clone();
                    menu = menu.child(
                        MenuItem::new(
                            "v3-pin-detach",
                            Icon::Minus,
                            t(cx, keys::v3_timeline::DETACH_ENTRY),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.edit_pin(pin_id.clone(), PinEdit::Bind(None), cx)
                        })),
                    );
                }
                menu = menu
                    .child(separator(theme.palette))
                    .child(section_label(t(cx, keys::v3_timeline::PIN_COLOR), &theme));
                let mut colors = div().flex().gap_1().px_3().py_2();
                for hex in ["#b46a62", "#738f9a", "#9a8567", "#8b9472", "#8b7f9b"] {
                    let pin_id = id.clone();
                    colors = colors.child(
                        div()
                            .id(SharedString::from(format!("v3-pin-color-{hex}")))
                            .size(px(24.))
                            .rounded_full()
                            .bg(color_of(hex).unwrap().solid())
                            .role(gpui::Role::Button)
                            .aria_label(hex)
                            .cursor_pointer()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.edit_pin(pin_id.clone(), PinEdit::Color(Some(hex.into())), cx)
                            })),
                    );
                }
                menu = menu.child(colors);
                let pin_id = id.clone();
                menu = menu.child(
                    MenuItem::new(
                        "v3-pin-custom-color",
                        Icon::Enso,
                        t(cx, keys::common::CUSTOM_COLOR),
                    )
                    .on_click(cx.listener(move |this, _, w, cx| {
                        this.custom_pin_color(pin_id.clone(), w, cx)
                    })),
                );
                let pin_id = id.clone();
                menu = menu.child(
                    MenuItem::new("v3-pin-delete", Icon::Trash, t(cx, keys::common::DELETE))
                        .danger()
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.delete_pin(pin_id.clone(), cx)),
                        ),
                );
            }
            MenuOf::LaneTemplates => {
                for tpl in model::lane_templates(book) {
                    let id = tpl.id.clone();
                    menu = menu.child(
                        MenuItem::new(
                            SharedString::from(format!("v3-lane-template-{id}")),
                            Icon::Branch,
                            tpl.name.clone(),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.create_lane(id.clone(), false, cx)
                        })),
                    );
                }
            }
            MenuOf::ActTrackTemplates => {
                for tpl in model::lane_templates(book) {
                    let id = tpl.id.clone();
                    menu =
                        menu.child(
                            MenuItem::new(
                                SharedString::from(format!("v3-act-template-{id}")),
                                Icon::LanesStagger,
                                tpl.name.clone(),
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| this.create_act_track(id.clone(), cx),
                            )),
                        );
                }
            }
            MenuOf::LaneActions(lane_id) => {
                // Every lane takes entries from elsewhere (DV, 2026-11-16):
                // what goes on it is hung on it, a new entry or one picked.
                let target_lane = lane_id.clone();
                let lane_row = self
                    .view()
                    .and_then(|v| v.lanes.iter().find(|l| &l.entry == lane_id));
                let is_act = lane_row.is_some_and(|l| l.act_track == Some(true));
                let lane_title = book
                    .entry(lane_id)
                    .map(|e| e.title.clone())
                    .unwrap_or_default();
                let toggle_label = dr_shell::strings::tf(
                    cx,
                    if is_act {
                        keys::v3_timeline::UNSET_ACT_TRACK
                    } else {
                        keys::v3_timeline::SET_ACT_TRACK
                    },
                    &[("name", &lane_title)],
                );
                let toggle_id = lane_id.clone();
                let toggle_scope = self.view_scope();
                menu = menu
                    .child(
                        MenuItem::new(
                            "v3-lane-action-new-entry",
                            Icon::Plus,
                            t(cx, keys::v3_timeline::NEW_ENTRY_IN_LANE),
                        )
                        .on_click(cx.listener(
                            move |this, e: &ClickEvent, _, cx| {
                                this.popup = Some(Popup::new(
                                    MenuOf::Entries(target_lane.clone()),
                                    e.position(),
                                ));
                                cx.notify();
                            },
                        )),
                    )
                    .child({
                        let target_lane = lane_id.clone();
                        MenuItem::new(
                            "v3-lane-open-book",
                            Icon::OpenBook,
                            t(cx, keys::v3_shell::BOOK_VIEW),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.open_lane_book_view(target_lane.clone(), cx)
                        }))
                    })
                    .child(separator(theme.palette))
                    .child(
                        MenuItem::new(
                            SharedString::from(format!("v3-lane-act-{lane_id}")),
                            Icon::LanesStagger,
                            toggle_label,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(shown) = &toggle_scope {
                                this.edit_view_at(
                                    shown.clone(),
                                    write::ViewEdit::SetActTrack(toggle_id.clone(), !is_act),
                                    cx,
                                );
                            }
                        })),
                    );
            }
            MenuOf::Lanes => {
                let templates = model::lane_templates(book);
                let mut new_lane = MenuItem::new(
                    "v3-lane-new-lane",
                    Icon::Plus,
                    t(cx, keys::v3_timeline::NEW_LANE),
                )
                .disabled(templates.is_empty());
                if templates.len() == 1 {
                    let tpl = templates[0].id.clone();
                    new_lane = new_lane.on_click(cx.listener(move |this, _, _, cx| {
                        this.create_lane(tpl.clone(), false, cx);
                    }));
                } else if templates.len() > 1 {
                    new_lane = new_lane.on_click(cx.listener(|this, e: &ClickEvent, _, cx| {
                        this.popup = Some(Popup::new(MenuOf::LaneTemplates, e.position()));
                        cx.notify();
                    }));
                }
                let mut new_act = MenuItem::new(
                    "v3-lane-new-act-track",
                    Icon::Plus,
                    t(cx, keys::v3_timeline::NEW_ACT_TRACK),
                )
                .disabled(templates.is_empty());
                if templates.len() == 1 {
                    let tpl = templates[0].id.clone();
                    new_act = new_act.on_click(cx.listener(move |this, _, _, cx| {
                        this.create_act_track(tpl.clone(), cx);
                    }));
                } else if templates.len() > 1 {
                    new_act = new_act.on_click(cx.listener(|this, e: &ClickEvent, _, cx| {
                        this.popup = Some(Popup::new(MenuOf::ActTrackTemplates, e.position()));
                        cx.notify();
                    }));
                }
                menu = menu
                    .child(section_label(
                        t(cx, keys::v3_timeline::SECTION_CREATE),
                        &theme,
                    ))
                    .child(new_lane)
                    .child(new_act);
                let shown = self.view_scope();
                let mut has_existing = false;
                for e in &book.entries {
                    // A lane takes entries from elsewhere (DV, 2026-11-16).
                    if e.deleted_at.is_some() || !book.accepts_members(&e.id) {
                        continue;
                    }
                    if !has_existing {
                        menu = menu.child(separator(theme.palette)).child(section_label(
                            t(cx, keys::v3_timeline::SECTION_EXISTING),
                            &theme,
                        ));
                        has_existing = true;
                    }
                    let in_view = self
                        .view()
                        .and_then(|v| v.lanes.iter().find(|l| l.entry == e.id));
                    let added = in_view.is_some();
                    let id = e.id.clone();
                    let add_scope = shown.clone();
                    menu = menu.child(
                        MenuItem::new(
                            SharedString::from(format!("v3-lane-add-{}", e.id)),
                            Icon::Branch,
                            e.title.clone(),
                        )
                        .checked(added)
                        .disabled(added)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(shown) = &add_scope {
                                this.edit_view_at(
                                    shown.clone(),
                                    write::ViewEdit::AddLane(id.clone()),
                                    cx,
                                );
                            }
                        })),
                    );
                }
            }
        }
        let label = t(
            cx,
            match &popup.of {
                MenuOf::Views => keys::v3_timeline::VIEWS,
                MenuOf::ViewActions => keys::v3_timeline::VIEW_ACTIONS,
                MenuOf::Bind(_) => keys::v3_timeline::BIND_ENTRY,
                MenuOf::Lanes => keys::v3_timeline::SELECT_LANE,
                MenuOf::LaneTemplates => keys::v3_timeline::NEW_LANE,
                MenuOf::ActTrackTemplates => keys::v3_timeline::NEW_ACT_TRACK,
                MenuOf::LaneActions(_) => keys::v3_timeline::LANE_ACTIONS,
                _ => keys::v3_timeline::PLACE_ENTRY,
            },
        );
        let scroll = div()
            .id("v3-timeline-popup-scroll")
            .role(gpui::Role::Group)
            .aria_label(label)
            .max_h(px(360.))
            .track_scroll(&popup.scroll)
            .overflow_y_scroll()
            .child(menu);
        Some(
            overlay::float(
                Place::Point(popup.at),
                Layer::Popover,
                div()
                    .child(Menu::new("v3-timeline-menu").child(scroll))
                    .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                        this.popup = None;
                        cx.notify();
                    })),
            )
            .into_any_element(),
        )
    }

    fn rails(
        &self,
        lanes: &[model::Lane],
        lane_h: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let page = self.page_host();
        let existing_lanes: std::collections::BTreeSet<String> = self
            .view()
            .map(|v| v.lanes.iter().map(|l| l.entry.clone()).collect())
            .unwrap_or_default();
        let rail = div()
            .id("v3-lane-rail")
            .debug_selector(|| "v3-lane-rail".into())
            .w(px(self.rail_width()))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .can_drop(move |value, _, _| {
                value.downcast_ref::<EntryDrag>().is_some_and(|drag| {
                    page.as_ref().is_some_and(|page| {
                        drag.matches(page)
                            && !existing_lanes.contains(&drag.entry)
                            && page
                                .book
                                .v3()
                                .is_some_and(|b| b.accepts_members(&drag.entry))
                    })
                })
            })
            .on_drop::<EntryDrag>(cx.listener(|this, drag, _, cx| this.dropped_lane(drag, cx)))
            .on_pinch(cx.listener(|this, e, w, cx| this.pinch(e, w, cx)))
            .child(div().h(px(model::RULER)).flex_none());
        let mut rail_rows = div()
            .id("v3-lane-rail-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.rail_scroll)
            .on_scroll(cx.listener(|this, _, _, cx| this.sync_vertical_scroll(true, cx)))
            .flex()
            .flex_col();
        for (i, lane) in lanes.iter().enumerate() {
            let id = lane.id.clone();
            let color = lane.color.as_deref().and_then(color_of);
            let count =
                dr_shell::strings::tf(cx, keys::v3_timeline::MEMBERS, &[("count", &lane.members)]);
            let mark = if lane.act_track {
                sand::Kind::DriftGroup
            } else {
                sand::Kind::Storyline
            };
            // `W9Bottom` draws the column as the lane's mark and name only
            // (the count only once filled); the lane's buttons come over
            // the name's end under the hand.
            let lane_words: u64 = self
                .book
                .v3()
                .map(|b| lane.clips.iter().map(|c| b.entry_words(&c.entry)).sum())
                .unwrap_or(0);
            let lane_cell = SandCell::new(
                SharedString::from(format!("v3-lane-name-{id}")),
                lane.title.clone(),
            )
            .mark(mark)
            .color_opt(color)
            .italic(true)
            .on_click(cx.listener({
                let id = id.clone();
                move |this, e, _, cx| this.open(&id, e, cx)
            }));
            let weak_lane = cx.weak_entity();
            let card_lane_id = id.clone();
            let card_lane_title = lane.title.clone();
            let card_lane_count = count.clone();
            let lane_cell_hover = HoverCard::new(
                SharedString::from(format!("v3-lane-hc-{id}")),
                lane_cell,
                move |_, cx| {
                    let mut body = CardBody::new(
                        SharedString::from(format!("v3-lane-hc-body-{card_lane_id}")),
                        card_lane_title.clone(),
                    )
                    .mark(mark, color)
                    .meta(card_lane_count.clone());
                    if lane_words > 0 {
                        body = body.count(dr_shell::strings::tf(
                            cx,
                            keys::shell_ui::WORDS_SHORT,
                            &[("count", &lane_words)],
                        ));
                    }
                    let open_weak = weak_lane.clone();
                    let open_id = card_lane_id.clone();
                    let book_weak = weak_lane.clone();
                    let book_id = card_lane_id.clone();
                    body.section(vec![
                        CardAction::new(
                            SharedString::from(format!("v3-lane-hc-open-{card_lane_id}")),
                            Icon::ArrowIn,
                            t(cx, keys::v3_shell::OPEN),
                        )
                        .on_click(move |e, _, cx| {
                            let _ = open_weak.update(cx, |this, cx| this.open(&open_id, e, cx));
                        })
                        .into_any_element(),
                        CardAction::new(
                            SharedString::from(format!("v3-lane-hc-book-{card_lane_id}")),
                            Icon::OpenBook,
                            t(cx, keys::v3_shell::BOOK_VIEW),
                        )
                        .on_click(move |_, _, cx| {
                            let _ = book_weak.update(cx, |this, cx| {
                                this.open_lane_book_view(book_id.clone(), cx)
                            });
                        })
                        .into_any_element(),
                    ])
                    .into_any_element()
                },
            );
            let group: SharedString = format!("v3-lane-row-{id}").into();
            let row = div()
                .id(SharedString::from(format!("v3-lane-row-{id}")))
                .group(group.clone())
                .relative()
                .h(px(lane_h))
                .flex_none()
                .flex()
                .items_center()
                .child(div().flex_1().min_w_0().child(lane_cell_hover))
                .child(
                    div()
                        .id(SharedString::from(format!("v3-lane-count-{}", lane.id)))
                        .flex_none()
                        .text_xs()
                        .opacity(self.fill_t)
                        .role(gpui::Role::Label)
                        .aria_label(count)
                        .child(lane.members.to_string()),
                );
            let mut actions = div()
                .absolute()
                .top_0()
                .bottom_0()
                .right_0()
                .flex()
                .items_center()
                .bg(theme.palette.desk.solid())
                .opacity(0.0)
                .group_hover(group, |st| st.opacity(1.0));
            {
                let id = lane.id.clone();
                actions = actions.child(
                    PanelIconButton::new(
                        SharedString::from(format!("v3-lane-entries-{id}")),
                        Icon::Plus,
                    )
                    .label(t(cx, keys::v3_timeline::NEW_ENTRY_IN_LANE))
                    .on_click(cx.listener(
                        move |this, e: &ClickEvent, _, cx| {
                            this.popup =
                                Some(Popup::new(MenuOf::Entries(id.clone()), e.position()));
                            cx.notify();
                        },
                    )),
                );
            }
            let can_up = i > 0 && lanes[i - 1].act_track == lane.act_track;
            let can_down = i + 1 < lanes.len() && lanes[i + 1].act_track == lane.act_track;
            if can_up {
                let id = lane.id.clone();
                let shown = self.view_scope();
                actions = actions.child(
                    PanelIconButton::new(
                        SharedString::from(format!("v3-lane-up-{id}")),
                        Icon::ChevronUp,
                    )
                    .label(t(cx, keys::v3_timeline::MOVE_UP))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(shown) = &shown {
                            this.edit_view_at(
                                shown.clone(),
                                write::ViewEdit::Reorder(id.clone(), -1),
                                cx,
                            );
                        }
                    })),
                );
            }
            if can_down {
                let id = lane.id.clone();
                let shown = self.view_scope();
                actions = actions.child(
                    PanelIconButton::new(
                        SharedString::from(format!("v3-lane-down-{id}")),
                        Icon::ChevronDown,
                    )
                    .label(t(cx, keys::v3_timeline::MOVE_DOWN))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(shown) = &shown {
                            this.edit_view_at(
                                shown.clone(),
                                write::ViewEdit::Reorder(id.clone(), 1),
                                cx,
                            );
                        }
                    })),
                );
            }
            let id = lane.id.clone();
            let actions_id = format!("v3-lane-actions-{id}");
            actions = actions.child(
                div()
                    .debug_selector({
                        let actions_id = actions_id.clone();
                        move || actions_id.clone()
                    })
                    .child(
                        PanelIconButton::new(SharedString::from(actions_id), Icon::More)
                            .label(t(cx, keys::v3_timeline::LANE_ACTIONS))
                            .on_click(cx.listener(move |this, e: &ClickEvent, _, cx| {
                                this.popup =
                                    Some(Popup::new(MenuOf::LaneActions(id.clone()), e.position()));
                                cx.notify();
                            })),
                    ),
            );
            let id = lane.id.clone();
            let shown = self.view_scope();
            actions = actions.child(
                PanelIconButton::new(
                    SharedString::from(format!("v3-lane-remove-{id}")),
                    Icon::Minus,
                )
                .label(t(cx, keys::v3_timeline::REMOVE_LANE))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(shown) = &shown {
                        this.edit_view_at(
                            shown.clone(),
                            write::ViewEdit::RemoveLane(id.clone()),
                            cx,
                        );
                    }
                })),
            );
            rail_rows = rail_rows.child(row.child(actions));
        }
        rail.child(rail_rows).into_any_element()
    }

    fn tracks(
        &self,
        view: &TimelineView,
        lanes: &[model::Lane],
        lane_h: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let palette = theme.palette;
        let (min, max) = model::extent(view);
        let unit = self.scale().unit();
        let width = ((max - min) as f32 * unit).clamp(800., 10_000_000.);
        let left = -f32::from(self.scroll.offset().x);
        let visible = self.bounds.get().map_or(1200., |b| f32::from(b.size.width));
        let mut ruler = div()
            .id("v3-time-ruler")
            .h(px(model::RULER))
            .flex_none()
            .relative()
            .role(gpui::Role::Group)
            .aria_label(t(cx, keys::v3_timeline::RULER))
            .on_click(cx.listener(|this, e: &ClickEvent, w, cx| {
                if e.click_count() == 2
                    && let Some(at) = this.order_at(e.position().x)
                {
                    this.new_pin(at, w, cx);
                }
            }))
            .on_drop::<PinDrag>(cx.listener(|this, drag: &PinDrag, w, cx| {
                this.pin_drag_x = None;
                if drag.book == this.book.id
                    && this.view().is_some_and(|v| v.id == drag.view)
                    && let Some(at) = this.order_at(w.mouse_position().x - px(drag.grab.get()))
                {
                    this.edit_pin(drag.pin.clone(), PinEdit::At(at), cx);
                }
            }));
        if let Some(guide_x) = self.pin_drag_x {
            ruler = ruler.child(
                div()
                    .absolute()
                    .left(px(guide_x))
                    .top_0()
                    .bottom_0()
                    .w(px(1.5))
                    .bg(palette.accent.solid()),
            );
        }
        // A label gives way to the next pin's: it is cut with an ellipsis
        // where that one starts, so two pins close together on the scale do
        // not print over each other. The whole label stays the button's
        // accessible name.
        let mut pin_starts: Vec<f64> = view
            .pins
            .iter()
            .map(|p| p.at)
            .filter(|at| at.is_finite())
            .collect();
        pin_starts.sort_by(f64::total_cmp);
        let editing_pin_id = self
            .editing
            .as_ref()
            .filter(|e| matches!(e.kind, EditKind::PinLabel | EditKind::PinColor))
            .map(|e| e.id.clone());
        let mut rendered_pin_editor = false;
        for pin in &view.pins {
            let x = (pin.at - min) as f32 * unit;
            if editing_pin_id.as_deref() == Some(pin.id.as_str())
                && let Some(edit) = &self.editing
            {
                rendered_pin_editor = true;
                let editor_x = x.clamp(left + 4.0, (left + visible - 188.0).max(left + 4.0));
                ruler = ruler.child(
                    div()
                        .id("v3-timeline-editor")
                        .absolute()
                        .left(px(editor_x))
                        .top(px(4.0))
                        .w(px(180.0))
                        .role(gpui::Role::Group)
                        .aria_label(edit.field.read(cx).text())
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(edit.field.clone()),
                );
                continue;
            }
            if x < left - 200. || x > left + visible {
                continue;
            }
            let room = pin_starts
                .iter()
                .find(|at| **at > pin.at)
                .map(|next| ((next - pin.at) as f32 * unit - PIN_LABEL_GAP).max(PIN_LABEL_MIN));
            let id = pin.id.clone();
            let bound_entry = pin.entry.clone();
            let bound_title = bound_entry
                .as_deref()
                .and_then(|eid| self.book.v3().and_then(|b| b.entry(eid)))
                .map(|e| e.title.clone());
            let pin_color = pin
                .color
                .as_deref()
                .and_then(color_of)
                .unwrap_or(palette.accent);
            let drag = PinDrag {
                book: self.book.id.clone(),
                view: view.id.clone(),
                pin: id.clone(),
                title: pin.label.clone().into(),
                grab: Rc::default(),
            };
            let pin_selector = format!("v3-pin-{id}");
            let weak_pin = cx.weak_entity();
            let hc_pin_id = id.clone();
            let hc_pin_label = pin.label.clone();
            let hc_bound_entry = bound_entry.clone();
            let hc_bound_title = bound_title.clone();
            let pin_btn = div()
                .id(SharedString::from(format!("v3-pin-{id}")))
                .debug_selector(move || pin_selector)
                .h(px(20.))
                .px_2()
                .truncate()
                .when_some(room, |el, room| el.max_w(px(room)))
                .text_xs()
                .text_color(pin_color.solid())
                .role(gpui::Role::Button)
                .aria_label(pin.label.clone())
                .cursor_grab()
                .child(pin.label.clone())
                .on_click(cx.listener({
                    let id = id.clone();
                    let bound_entry = bound_entry.clone();
                    move |this, e: &ClickEvent, w, cx| {
                        cx.stop_propagation();
                        if (e.modifiers().platform || e.modifiers().control)
                            && let Some(entry) = &bound_entry
                        {
                            this.open(entry, e, cx);
                        } else if e.click_count() > 1 {
                            this.rename_pin(id.clone(), w, cx);
                        } else {
                            this.popup = Some(Popup::new(MenuOf::Pin(id.clone()), e.position()));
                            cx.notify();
                        }
                    }
                }))
                .on_drag(drag, |drag, offset, _, cx| {
                    drag.grab.set(f32::from(offset.x));
                    cx.new(|_| Ghost {
                        title: drag.title.clone(),
                    })
                });
            let pin_hover = HoverCard::new(
                SharedString::from(format!("v3-pin-hc-{id}")),
                pin_btn,
                move |_, cx| {
                    let mut body = CardBody::new(
                        SharedString::from(format!("v3-pin-hc-body-{hc_pin_id}")),
                        hc_pin_label.clone(),
                    )
                    .mark(sand::Kind::Storyline, Some(pin_color));
                    if let Some(bt) = &hc_bound_title {
                        body = body.meta(bt.clone());
                    }
                    let mut rows = Vec::new();
                    if let Some(be) = &hc_bound_entry {
                        let w_open = weak_pin.clone();
                        let be = be.clone();
                        rows.push(
                            CardAction::new(
                                SharedString::from(format!("v3-pin-hc-open-{hc_pin_id}")),
                                Icon::ArrowIn,
                                t(cx, keys::v3_shell::OPEN),
                            )
                            .on_click(move |e, _, cx| {
                                let _ = w_open.update(cx, |this, cx| this.open(&be, e, cx));
                            })
                            .into_any_element(),
                        );
                    }
                    let w_ren = weak_pin.clone();
                    let rid = hc_pin_id.clone();
                    rows.push(
                        CardAction::new(
                            SharedString::from(format!("v3-pin-hc-ren-{hc_pin_id}")),
                            Icon::Edit,
                            t(cx, keys::v3_timeline::RENAME_PIN),
                        )
                        .on_click(move |_, w, cx| {
                            let _ =
                                w_ren.update(cx, |this, cx| this.rename_pin(rid.clone(), w, cx));
                        })
                        .into_any_element(),
                    );
                    let w_del = weak_pin.clone();
                    let did = hc_pin_id.clone();
                    body.section(rows)
                        .section(vec![
                            CardAction::new(
                                SharedString::from(format!("v3-pin-hc-del-{hc_pin_id}")),
                                Icon::Trash,
                                t(cx, keys::common::DELETE),
                            )
                            .danger()
                            .on_click(move |_, _, cx| {
                                let _ =
                                    w_del.update(cx, |this, cx| this.delete_pin(did.clone(), cx));
                            })
                            .into_any_element(),
                        ])
                        .into_any_element()
                },
            );
            ruler = ruler.child(div().absolute().left(px(x)).top(px(10.0)).child(pin_hover));
        }
        // Fallback if editing a brand-new pin not yet in the snapshot.
        if !rendered_pin_editor
            && let Some(edit) = self
                .editing
                .as_ref()
                .filter(|e| matches!(e.kind, EditKind::PinLabel | EditKind::PinColor))
        {
            ruler = ruler.child(
                div()
                    .id("v3-timeline-editor")
                    .absolute()
                    .left(px(left + 12.0))
                    .top(px(4.0))
                    .w(px(180.0))
                    .role(gpui::Role::Group)
                    .aria_label(edit.field.read(cx).text())
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(edit.field.clone()),
            );
        }
        let content = div().w(px(width)).h_full().flex().flex_col().child(ruler);
        let mut tracks_col = div()
            .id("v3-timeline-vscroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.v_scroll)
            .flex()
            .flex_col();
        if lanes.is_empty() {
            let page = self.page_host();
            let existing_lanes: std::collections::BTreeSet<String> =
                view.lanes.iter().map(|l| l.entry.clone()).collect();
            tracks_col = tracks_col.child(
                div()
                    .id("v3-empty-lanes-drop")
                    .debug_selector(|| "v3-empty-lanes-drop".into())
                    .flex_1()
                    .min_h(px(lane_h))
                    .can_drop(move |value, _, _| {
                        value.downcast_ref::<EntryDrag>().is_some_and(|drag| {
                            page.as_ref().is_some_and(|page| {
                                drag.matches(page)
                                    && !existing_lanes.contains(&drag.entry)
                                    && page
                                        .book
                                        .v3()
                                        .is_some_and(|b| b.accepts_members(&drag.entry))
                            })
                        })
                    })
                    .on_drop::<EntryDrag>(
                        cx.listener(|this, drag, _, cx| this.dropped_lane(drag, cx)),
                    ),
            );
        }
        self.lane_rows.borrow_mut().clear();
        let active_entry = self.active_entry_id(cx);
        for lane in lanes {
            let color = lane
                .color
                .as_deref()
                .and_then(color_of)
                .unwrap_or(palette.accent);
            let lane_rows_ref = self.lane_rows.clone();
            let probe_lane_id = lane.id.clone();
            let dbl_lane = lane.id.clone();
            let mut row = div()
                .id(SharedString::from(format!("v3-track-{}", lane.id)))
                .debug_selector({
                    let id = format!("v3-track-{}", lane.id);
                    move || id.clone()
                })
                .h(px(lane_h))
                .flex_none()
                .relative()
                .rounded(px(5.))
                .bg(palette.paper.solid())
                .border_b_1()
                .border_color(palette.desk.solid())
                .child(
                    canvas(
                        move |b, _, _| {
                            let mut rows = lane_rows_ref.borrow_mut();
                            let top = f32::from(b.origin.y);
                            let h = f32::from(b.size.height);
                            if let Some(slot) =
                                rows.iter_mut().find(|(id, _, _)| id == &probe_lane_id)
                            {
                                slot.1 = top;
                                slot.2 = h;
                            } else {
                                rows.push((probe_lane_id.clone(), top, h));
                            }
                        },
                        |_, _, _, _| {},
                    )
                    .absolute()
                    .inset_0(),
                )
                .on_click(cx.listener(move |this, e: &ClickEvent, _, cx| {
                    if e.click_count() == 2
                        && let Some(at) = this.order_at(e.position().x)
                    {
                        this.create_entry_in_lane_at(dbl_lane.clone(), Some(at), cx);
                    }
                }));
            let lane_id = lane.id.clone();
            let can_drop_lane = lane.id.clone();
            let page = self.page_host();
            row = row
                .role(gpui::Role::Group)
                .aria_label(dr_shell::strings::tf(
                    cx,
                    keys::v3_timeline::LANE_TRACK,
                    &[("name", &lane.title)],
                ))
                .can_drop(move |value, _, _| {
                    value.downcast_ref::<EntryDrag>().is_some_and(|drag| {
                        page.as_ref().is_some_and(|page| {
                            drag.matches(page)
                                && drag.entry != can_drop_lane
                                && page
                                    .book
                                    .v3()
                                    .is_some_and(|b| b.accepts_members(&can_drop_lane))
                        })
                    })
                })
                .on_drop::<EntryDrag>(cx.listener(move |this, drag, w, cx| {
                    this.dropped_entry(drag, lane_id.clone(), w, cx)
                }));
            if let Some(guide_x) = self.pin_drag_x {
                row = row.child(
                    div()
                        .absolute()
                        .left(px(guide_x))
                        .top_0()
                        .bottom_0()
                        .w(px(1.5))
                        .bg(palette.accent.alpha(0.7)),
                );
            }
            for pin in &view.pins {
                let x = (pin.at - min) as f32 * unit;
                if x >= left && x <= left + visible {
                    row = row.child(
                        div()
                            .absolute()
                            .left(px(x))
                            .top_0()
                            .bottom_0()
                            .w(px(1.))
                            .bg(pin
                                .color
                                .as_deref()
                                .and_then(color_of)
                                .unwrap_or(palette.rule)
                                .alpha(0.6)),
                    );
                }
            }
            for clip in &lane.clips {
                let short_segment = lane.act_track && clip.span.is_none();
                let effective_span = clip.span.unwrap_or(if lane.act_track {
                    model::SHORT_ACT_SPAN
                } else {
                    model::DEFAULT_SPAN
                });
                let x = (clip.at - min) as f32 * unit;
                let span_w = effective_span as f32 * unit;
                if x + span_w.max(NARROW_CARD) < left || x > left + visible {
                    continue;
                }
                let title = self
                    .book
                    .v3()
                    .and_then(|b| b.entry(&clip.entry))
                    .map(|e| e.title.clone())
                    .unwrap_or_default();
                // However far the scale is pinched in, a card keeps the
                // title's first whole character (`kernel-v5.md` §17).
                let w = if short_segment {
                    span_w.clamp(14., 24.)
                } else if span_w >= NARROW_CARD {
                    span_w
                } else {
                    span_w.max(model::card_min_width(
                        &title,
                        NARROW_PAD,
                        px(narrow_font(&theme)),
                        dr_ui::fonts::Role::Ui.font(dr_ui::fonts::weight::REGULAR),
                        window,
                    ))
                };
                let full_summary = self
                    .book
                    .v3()
                    .and_then(|b| model::entry_summary(b, &clip.entry));
                let summary = (w >= 104. && lane_h >= 68.)
                    .then(|| full_summary.clone())
                    .flatten();
                let entry_words = self
                    .book
                    .v3()
                    .map(|b| b.entry_words(&clip.entry))
                    .unwrap_or(0);
                let entry_status = self
                    .book
                    .v3()
                    .and_then(|b| b.entry_status(&clip.entry))
                    .map(str::to_owned);
                let muted_clip = self
                    .book
                    .v3()
                    .is_some_and(|b| b.is_resting_or_discarded(&clip.entry));
                let finished_clip = entry_status.as_deref() == Some("finished");
                let is_active = active_entry.as_deref() == Some(clip.entry.as_str());
                let is_dragging_self = self
                    .clip_drag
                    .as_ref()
                    .is_some_and(|d| d.entry == clip.entry && d.source_lane == lane.id);
                let id = clip.entry.clone();
                // A preview can arrive before its hang is in the book.
                // Wait for the committed placement before editing it again.
                let can_edit_placement = !self.pending.contains_key(&id)
                    && self.book.v3().is_some_and(|b| {
                        b.accepts_members(&lane.id)
                            && b.memberships
                                .iter()
                                .any(|m| m.host == lane.id && m.member == id)
                    });
                let drag = self.page_host().filter(|_| can_edit_placement).map(|page| {
                    let mut drag = EntryDrag::new(page, id.clone(), title.clone())
                        .with_timeline_clip(view.id.clone(), lane.id.clone());
                    drag.span = clip.span;
                    drag
                });
                let resize = Resizing {
                    book: self.book.id.clone(),
                    guard: self.book.v3().unwrap().guard(),
                    entry: id.clone(),
                    at: clip.at,
                    view: view.id.clone(),
                    end: clip.at + effective_span,
                };
                let entry = id.clone();
                let lane_id = lane.id.clone();
                let show_more = w > 48. && can_edit_placement;
                let more = PanelIconButton::new(
                    SharedString::from(format!("v3-clip-menu-{}-{id}", lane.id)),
                    Icon::More,
                )
                .label(t(cx, keys::v3_timeline::PLACEMENT_ACTIONS))
                .on_click(cx.listener(move |this, e: &ClickEvent, _, cx| {
                    cx.stop_propagation();
                    this.popup = Some(Popup::new(
                        MenuOf::Clip {
                            entry: entry.clone(),
                            lane: lane_id.clone(),
                        },
                        e.position(),
                    ));
                    cx.notify();
                }));
                let drop_lane = lane.id.clone();
                let can_drop_clip_lane = lane.id.clone();
                let page = self.page_host();
                let clip_selector = format!("v3-clip-{}-{id}", lane.id);
                let narrow_card = short_segment || w < NARROW_CARD;
                let pad_x = if narrow_card { NARROW_PAD } else { 8.0 };
                let title_font_px = if narrow_card {
                    narrow_font(&theme)
                } else {
                    theme.scale.secondary
                };
                let avail_title_w = (w - pad_x * 2.0 - if show_more { 20.0 } else { 0.0 }).max(0.0);
                let shown_title = model::slice_whole_chars(
                    &title,
                    avail_title_w,
                    px(title_font_px),
                    dr_ui::fonts::Role::Ui.font(dr_ui::fonts::weight::REGULAR),
                    window,
                );
                let spring_entity = cx.entity();
                let spring_lane = lane.id.clone();
                let spring_entry = id.clone();
                let spring_title = SharedString::from(title.clone());
                let spring_h = (lane_h - 6.0).max(16.0);
                let clip_body = glass::glass_box(
                    SharedString::from(clip_selector.clone()),
                    Kind::Rest,
                    Mode::default(),
                    is_active,
                    Spec::new(Tone::Color(color), 5.),
                    window,
                    cx,
                )
                .debug_selector(move || clip_selector.clone())
                .w(px(w))
                .h(px(spring_h))
                .flex()
                .when(summary.is_some(), |b| {
                    b.flex_col().justify_center().items_start()
                })
                .when(summary.is_none(), |b| b.items_center())
                .overflow_hidden()
                .text_color(color.solid())
                .role(gpui::Role::Button)
                .aria_label(title.clone())
                .when(can_edit_placement, |body| body.cursor_grab())
                .px(px(pad_x))
                .child({
                    let title_id = format!("v3-clip-title-{}-{id}", lane.id);
                    div()
                        .id(SharedString::from(title_id.clone()))
                        .debug_selector(move || title_id)
                        .w_full()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .flex()
                        .items_center()
                        .gap(px(3.0))
                        .type_px(title_font_px, theme.scale.line_caption)
                        .when(finished_clip && w >= 36., |el| {
                            el.child(sand::icon(Icon::Check, 10., color.solid()))
                        })
                        .child(shown_title)
                })
                .when_some(summary, |body, sum| {
                    body.child(
                        div()
                            .w_full()
                            .min_w_0()
                            .overflow_hidden()
                            .line_clamp(2)
                            .type_px(theme.scale.caption, theme.scale.line_caption)
                            .text_color(palette.ink(3).solid())
                            .child(sum),
                    )
                })
                .on_click(cx.listener({
                    let id = id.clone();
                    move |this, e, _, cx| {
                        cx.stop_propagation();
                        this.open(&id, e, cx);
                    }
                }))
                .can_drop(move |value, _, _| {
                    value.downcast_ref::<EntryDrag>().is_some_and(|drag| {
                        page.as_ref().is_some_and(|page| {
                            drag.matches(page)
                                && drag.entry != can_drop_clip_lane
                                && page
                                    .book
                                    .v3()
                                    .is_some_and(|b| b.accepts_members(&can_drop_clip_lane))
                        })
                    })
                })
                .on_drop::<EntryDrag>(cx.listener(move |this, drag, w, cx| {
                    this.dropped_entry(drag, drop_lane.clone(), w, cx)
                }))
                .when_some(drag, |body, drag| {
                    body.on_drag(drag, move |drag, offset, window, cx| {
                        drag.set_grab(f32::from(offset.x));
                        let ptr = window.mouse_position();
                        let grab = (f32::from(offset.x), f32::from(offset.y));
                        spring_entity.update(cx, |this, cx| {
                            this.start_clip_spring_drag(
                                spring_entry.clone(),
                                spring_lane.clone(),
                                spring_title.clone(),
                                color,
                                w,
                                spring_h,
                                grab,
                                ptr,
                                cx,
                            );
                        });
                        cx.new(|_| Ghost {
                            title: drag.title.clone(),
                        })
                    })
                });
                let resize_selector = format!("v3-resize-{}-{}", lane.id, clip.entry);
                let resize_focus = window
                    .use_keyed_state(
                        SharedString::from(format!("v3-resize-focus-{}-{}", lane.id, clip.entry)),
                        cx,
                        |_, cx| cx.focus_handle(),
                    )
                    .read(cx)
                    .clone();
                let nudge_entry = id.clone();
                let nudge_at = clip.at;
                let nudge_cur_span = effective_span;
                let handle = div()
                    .id(SharedString::from(resize_selector.clone()))
                    .debug_selector(move || resize_selector.clone())
                    .track_focus(&resize_focus)
                    .tab_index(0)
                    .absolute()
                    .right_0()
                    .top_0()
                    .bottom_0()
                    .w(px(6.))
                    .cursor_col_resize()
                    .role(gpui::Role::Slider)
                    .aria_label(t(cx, keys::v3_timeline::RESIZE))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, _, cx| {
                            this.resize = Some(resize.clone());
                            cx.stop_propagation();
                            cx.notify();
                        }),
                    )
                    .on_key_down(cx.listener(move |this, e: &KeyDownEvent, _, cx| {
                        let step = if e.keystroke.modifiers.shift {
                            2.0
                        } else {
                            0.5
                        };
                        let delta = match e.keystroke.key.as_str() {
                            "left" => -step,
                            "right" => step,
                            _ => return,
                        };
                        cx.stop_propagation();
                        this.nudge_span(
                            nudge_entry.clone(),
                            nudge_at,
                            (nudge_cur_span + delta).max(0.25),
                            cx,
                        );
                    }));
                let weak_clip = cx.weak_entity();
                let hc_entry = id.clone();
                let hc_lane = lane.id.clone();
                let hc_title = title.clone();
                let hc_summary = full_summary.clone();
                let hc_status = entry_status.clone();
                let hc_mark = self
                    .book
                    .v3()
                    .and_then(|b| b.appearance(&clip.entry))
                    .map_or_else(
                        || sand::Kind::Chapter(dr_shell::book::seal_of(&clip.entry)),
                        |a| a.sand,
                    );
                let clip_hover = HoverCard::new(
                    SharedString::from(format!("v3-clip-hc-{}-{id}", lane.id)),
                    div().w(px(w)).h(px(spring_h)).child(clip_body),
                    move |_, cx| {
                        let mut body = CardBody::new(
                            SharedString::from(format!("v3-clip-hc-body-{hc_lane}-{hc_entry}")),
                            hc_title.clone(),
                        )
                        .mark(hc_mark, Some(color));
                        if entry_words > 0 {
                            body = body.count(dr_shell::strings::tf(
                                cx,
                                keys::shell_ui::WORDS_SHORT,
                                &[("count", &entry_words)],
                            ));
                        }
                        if let Some(st) = &hc_status {
                            body = body.meta(st.clone());
                        }
                        if let Some(sum) = &hc_summary {
                            body = body.summary(sum.clone());
                        }
                        let mut rows = vec![{
                            let w_open = weak_clip.clone();
                            let eid = hc_entry.clone();
                            CardAction::new(
                                SharedString::from(format!("v3-clip-hc-open-{hc_entry}")),
                                Icon::ArrowIn,
                                t(cx, keys::v3_shell::OPEN),
                            )
                            .on_click(move |e, _, cx| {
                                let _ = w_open.update(cx, |this, cx| this.open(&eid, e, cx));
                            })
                            .into_any_element()
                        }];
                        if can_edit_placement {
                            let w_rm = weak_clip.clone();
                            let eid = hc_entry.clone();
                            let lid = hc_lane.clone();
                            rows.push(
                                CardAction::new(
                                    SharedString::from(format!("v3-clip-hc-rm-{hc_entry}")),
                                    Icon::Minus,
                                    t(cx, keys::v3_timeline::REMOVE_ENTRY),
                                )
                                .on_click(move |_, _, cx| {
                                    let _ = w_rm.update(cx, |this, cx| {
                                        this.remove_entry(eid.clone(), lid.clone(), cx)
                                    });
                                })
                                .into_any_element(),
                            );
                        }
                        body.section(rows).into_any_element()
                    },
                );
                let mut slab = div()
                    .id(SharedString::from(format!(
                        "v3-placement-{}-{}",
                        lane.id, clip.entry
                    )))
                    .absolute()
                    .left(px(x))
                    .top(px(3.))
                    .bottom(px(3.))
                    .w(px(w))
                    .when(is_dragging_self, |el| el.opacity(0.25))
                    .when(!is_dragging_self && muted_clip, |el| el.opacity(0.55))
                    .role(gpui::Role::Group)
                    .aria_label(title)
                    .child(div().relative().size_full().child(clip_hover));
                if show_more {
                    slab = slab.child(
                        div()
                            .absolute()
                            .right(px(6.))
                            .top_0()
                            .bottom_0()
                            .flex()
                            .items_center()
                            .child(more),
                    );
                }
                row = row.child(slab.children(can_edit_placement.then_some(handle)));
            }
            tracks_col = tracks_col.child(row);
        }
        div()
            .id("v3-timeline-scroll")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_x_scroll()
            .track_scroll(&self.scroll)
            .child(content.child(tracks_col))
            .on_scroll(cx.listener(|this, e, w, cx| this.wheel(e, w, cx)))
            .on_pinch(cx.listener(|this, e, w, cx| this.pinch(e, w, cx)))
            .into_any_element()
    }
}

/// Air between the end of a pin's label and the next pin.
const PIN_LABEL_GAP: f32 = 2.0;
/// A pin's label is never cut narrower than its own padding, so there is
/// always something to press where the pin stands.
const PIN_LABEL_MIN: f32 = 16.0;
/// Under this a card is narrow: little padding, a smaller title.
const NARROW_CARD: f32 = 44.0;
/// A narrow card's padding on each side.
const NARROW_PAD: f32 = 2.0;

/// A narrow card's title size.
fn narrow_font(theme: &Theme) -> f32 {
    (theme.scale.caption - 1.0).max(11.0)
}

impl Render for Timeline {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        self.follow_fill(cx);
        let lanes = self.lanes();
        let body = self.bounds.clone();
        let mouse = cx.weak_entity();
        let mut panel = div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme.palette.desk.solid())
            .font_role(FontRole::Ui)
            .type_px(theme.scale.secondary, theme.scale.line_body)
            .child(self.header(window, cx));
        let spring_overlay = if let Some(drag) = &mut self.clip_drag {
            let now = drag.started.elapsed().as_secs_f32();
            let moving = drag.spring.step(now);
            if moving {
                dr_ui::anim::keep_going(true, window);
            }
            self.bounds.get().map(|b| {
                let lx = drag.spring.x - f32::from(b.origin.x);
                let ly = drag.spring.y - f32::from(b.origin.y);
                let color = drag.color;
                div()
                    .absolute()
                    .left(px(lx))
                    .top(px(ly))
                    .w(px(drag.width))
                    .h(px(drag.height))
                    .px_2()
                    .rounded(px(5.0))
                    .bg(color.alpha(0.22))
                    .border_1()
                    .border_color(color.solid())
                    .flex()
                    .items_center()
                    .overflow_hidden()
                    .text_color(color.solid())
                    .type_px(theme.scale.secondary, theme.scale.line_caption)
                    .child(drag.title.clone())
                    .into_any_element()
            })
        } else {
            None
        };
        if let Some(view) = self.view() {
            let lane_h = self.scale().band.round();
            panel = panel.child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .on_drag_move::<EntryDrag>(cx.listener(Self::clip_drag_moved))
                    .on_drag_move::<PinDrag>(cx.listener(|this, e, _, cx| {
                        this.pin_drag_moved(e, cx);
                    }))
                    .child(self.rails(&lanes, lane_h, window, cx))
                    .child(self.tracks(view, &lanes, lane_h, window, cx))
                    .children(spring_overlay)
                    .child(
                        canvas(
                            move |b, _, _| body.set(Some(b)),
                            move |_, _, window, _| {
                                let moved = mouse.clone();
                                window.on_mouse_event(
                                    move |event: &MouseMoveEvent, phase, _, cx| {
                                        if phase == DispatchPhase::Capture {
                                            moved
                                                .update(cx, |this, cx| {
                                                    if this.resize.is_some() {
                                                        if event.pressed_button
                                                            == Some(MouseButton::Left)
                                                        {
                                                            this.resize_moved(event.position, cx);
                                                            cx.stop_propagation();
                                                        } else {
                                                            this.resize = None;
                                                            cx.notify();
                                                        }
                                                    }
                                                })
                                                .ok();
                                        }
                                    },
                                );
                                let ended = mouse.clone();
                                window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                                    if phase == DispatchPhase::Capture
                                        && event.button == MouseButton::Left
                                    {
                                        ended
                                            .update(cx, |this, cx| {
                                                if this.resize.is_some() {
                                                    this.resize_ended(event.position, cx);
                                                    cx.stop_propagation();
                                                }
                                            })
                                            .ok();
                                    } else if phase == DispatchPhase::Bubble
                                        && event.button == MouseButton::Left
                                    {
                                        ended
                                            .update(cx, |this, cx| {
                                                let mut changed = false;
                                                if this.clip_drag.take().is_some() {
                                                    changed = true;
                                                }
                                                if this.pin_drag_x.take().is_some() {
                                                    changed = true;
                                                }
                                                if changed {
                                                    cx.notify();
                                                }
                                            })
                                            .ok();
                                    }
                                });
                            },
                        )
                        .absolute()
                        .left_0()
                        .top_0()
                        .size_full(),
                    ),
            );
        }
        panel.children(self.popup(window, cx))
    }
}

struct Ghost {
    title: SharedString,
}
impl Render for Ghost {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Theme::of(window, cx).palette;
        glass::glass_box(
            "v3-drag-ghost",
            Kind::Rest,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, 5.),
            window,
            cx,
        )
        .w(px(90.))
        .h(px(30.))
        .px_2()
        .rounded(px(5.))
        .bg(p.paper.solid())
        .text_color(p.ink(2).solid())
        .child(self.title.clone())
    }
}
