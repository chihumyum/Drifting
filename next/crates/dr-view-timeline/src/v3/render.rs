use super::interaction::{PinDrag, PinEdit, Resizing};
use super::*;
use dr_shell::book::color_of;
use dr_ui::{
    Theme,
    components::{
        Layer, Menu, MenuItem, PanelIconButton, SandCell,
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
        if let Some(edit) = &self.editing {
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
                        this.popup = Some(Popup {
                            of: MenuOf::Views,
                            at: e.position(),
                        });
                        cx.notify();
                    })),
            );
        }
        row.child(
            PanelIconButton::new("v3-timeline-new", Icon::Plus)
                .label(t(cx, keys::v3_timeline::NEW_VIEW))
                .on_click(cx.listener(|this, _, w, cx| this.rename(true, w, cx))),
        )
        .child(div().flex_1())
        .when(self.view().is_some_and(|v| !v.lanes.is_empty()), |el| {
            el.child(
                PanelIconButton::new("v3-place-entry", Icon::FileText)
                    .label(t(cx, keys::v3_timeline::PLACE_ENTRY))
                    .on_click(cx.listener(|this, e: &ClickEvent, _, cx| {
                        this.popup = Some(Popup {
                            of: MenuOf::PickLane,
                            at: e.position(),
                        });
                        cx.notify();
                    })),
            )
        })
        .when(self.view().is_some(), |el| {
            el.child(
                PanelIconButton::new("v3-timeline-lanes", Icon::Layers)
                    .label(t(cx, keys::v3_timeline::ADD_LANE))
                    .on_click(cx.listener(|this, e: &ClickEvent, _, cx| {
                        this.popup = Some(Popup {
                            of: MenuOf::Lanes,
                            at: e.position(),
                        });
                        cx.notify();
                    })),
            )
        })
        .into_any_element()
    }

    fn popup(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let popup = self.popup.as_ref()?;
        let book = self.book.v3()?;
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
            MenuOf::PickLane => {
                for lane in self.lanes() {
                    let id = lane.id.clone();
                    let icon = if lane.act_track {
                        Icon::LanesStagger
                    } else {
                        Icon::Branch
                    };
                    menu = menu.child(
                        MenuItem::new(
                            SharedString::from(format!("v3-pick-lane-{id}")),
                            icon,
                            lane.title,
                        )
                        .on_click(cx.listener(
                            move |this, e: &ClickEvent, _, cx| {
                                this.popup = Some(Popup {
                                    of: MenuOf::Entries(id.clone()),
                                    at: e.position(),
                                });
                                cx.notify();
                            },
                        )),
                    );
                }
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
                    if !bind
                        && (&e.id == lane
                            || !book.levels.get(lane).is_some_and(|level| {
                                level.settings.allow.is_empty()
                                    || e.template
                                        .as_ref()
                                        .is_some_and(|t| level.settings.allow.contains(t))
                            }))
                    {
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
                            this.popup = Some(Popup {
                                of: MenuOf::Bind(pin_id.clone()),
                                at: e.position(),
                            });
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
            MenuOf::Lanes => {
                menu = menu.child(
                    MenuItem::new(
                        "v3-lane-new-act-track",
                        Icon::Plus,
                        t(cx, keys::v3_timeline::NEW_ACT_TRACK),
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.create_act_track(cx))),
                );
                let shown = self.view_scope();
                for e in &book.entries {
                    if e.deleted_at.is_some()
                        || !book
                            .template_of(&e.id)
                            .is_some_and(|t| t.kind == "level" && t.lane)
                    {
                        continue;
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
                    if let Some(lane_row) = in_view {
                        let is_act = lane_row.act_track == Some(true);
                        let toggle_label = dr_shell::strings::tf(
                            cx,
                            if is_act {
                                keys::v3_timeline::UNSET_ACT_TRACK
                            } else {
                                keys::v3_timeline::SET_ACT_TRACK
                            },
                            &[("name", &e.title)],
                        );
                        let toggle_id = e.id.clone();
                        let toggle_scope = shown.clone();
                        menu = menu.child(
                            MenuItem::new(
                                SharedString::from(format!("v3-lane-act-{}", e.id)),
                                Icon::LanesStagger,
                                toggle_label,
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    if let Some(shown) = &toggle_scope {
                                        this.edit_view_at(
                                            shown.clone(),
                                            write::ViewEdit::SetActTrack(
                                                toggle_id.clone(),
                                                !is_act,
                                            ),
                                            cx,
                                        );
                                    }
                                },
                            )),
                        );
                    }
                }
            }
        }
        let label = t(
            cx,
            match &popup.of {
                MenuOf::Bind(_) => keys::v3_timeline::BIND_ENTRY,
                MenuOf::PickLane => keys::v3_timeline::SELECT_LANE,
                _ => keys::v3_timeline::PLACE_ENTRY,
            },
        );
        let scroll = div()
            .id("v3-timeline-popup-scroll")
            .role(gpui::Role::Group)
            .aria_label(label)
            .max_h(px(360.))
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

    fn rails(&self, lanes: &[model::Lane], cx: &mut Context<Self>) -> AnyElement {
        let mut rail = div()
            .w(px(model::RAIL))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .child(div().h(px(model::RULER)).flex_none());
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
            let row = div()
                .min_h(px(model::ROW))
                .flex_1()
                .flex()
                .items_center()
                .child(
                    div().flex_1().min_w_0().child(
                        SandCell::new(
                            SharedString::from(format!("v3-lane-name-{id}")),
                            lane.title.clone(),
                        )
                        .mark(mark)
                        .color_opt(color)
                        .italic(true)
                        .on_click(cx.listener(move |this, e, _, cx| this.open(&id, e, cx))),
                    ),
                )
                .child(
                    div()
                        .id(SharedString::from(format!("v3-lane-count-{}", lane.id)))
                        .flex_none()
                        .text_xs()
                        .role(gpui::Role::Label)
                        .aria_label(count)
                        .child(lane.members.to_string()),
                );
            let mut actions = div().flex().items_center();
            if lane.act_track {
                let id = lane.id.clone();
                actions = actions.child(
                    PanelIconButton::new(
                        SharedString::from(format!("v3-lane-entries-{id}")),
                        Icon::Plus,
                    )
                    .label(t(cx, keys::v3_timeline::NEW_ENTRY_IN_LANE))
                    .on_click(cx.listener(
                        move |this, e: &ClickEvent, _, cx| {
                            this.popup = Some(Popup {
                                of: MenuOf::Entries(id.clone()),
                                at: e.position(),
                            });
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
            rail = rail.child(row.child(actions));
        }
        rail.into_any_element()
    }

    fn tracks(
        &self,
        view: &TimelineView,
        lanes: &[model::Lane],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let palette = theme.palette;
        let (min, max) = model::extent(view);
        let unit = model::UNIT * self.zoom;
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
                if drag.book == this.book.id
                    && this.view().is_some_and(|v| v.id == drag.view)
                    && let Some(at) = this.order_at(w.mouse_position().x - px(drag.grab.get()))
                {
                    this.edit_pin(drag.pin.clone(), PinEdit::At(at), cx);
                }
            }));
        let first = ((min + f64::from(left / unit)) / 5.).floor() * 5.;
        for step in 0..(visible / unit / 5.).ceil() as usize + 2 {
            let tick = first + step as f64 * 5.;
            ruler = ruler.child(
                div()
                    .absolute()
                    .left(px((tick - min) as f32 * unit))
                    .id(SharedString::from(format!("v3-tick-{tick}")))
                    .role(gpui::Role::Label)
                    .aria_label(tick.to_string())
                    .w(px(40.))
                    .top(px(22.))
                    .whitespace_nowrap()
                    .text_xs()
                    .text_color(palette.muted().solid())
                    .child(tick.to_string()),
            );
        }
        for pin in &view.pins {
            let x = (pin.at - min) as f32 * unit;
            if x < left - 200. || x > left + visible {
                continue;
            }
            let id = pin.id.clone();
            let drag = PinDrag {
                book: self.book.id.clone(),
                view: view.id.clone(),
                pin: id.clone(),
                title: pin.label.clone().into(),
                grab: Rc::default(),
            };
            ruler = ruler.child(
                div()
                    .id(SharedString::from(format!("v3-pin-{id}")))
                    .absolute()
                    .left(px(x))
                    .top_0()
                    .h(px(20.))
                    .px_2()
                    .whitespace_nowrap()
                    .text_xs()
                    .text_color(
                        pin.color
                            .as_deref()
                            .and_then(color_of)
                            .unwrap_or(palette.accent)
                            .solid(),
                    )
                    .role(gpui::Role::Button)
                    .aria_label(pin.label.clone())
                    .cursor_grab()
                    .child(pin.label.clone())
                    .on_click(cx.listener(move |this, e: &ClickEvent, w, cx| {
                        cx.stop_propagation();
                        if e.click_count() > 1 {
                            this.rename_pin(id.clone(), w, cx);
                        } else {
                            this.popup = Some(Popup {
                                of: MenuOf::Pin(id.clone()),
                                at: e.position(),
                            });
                            cx.notify();
                        }
                    }))
                    .on_drag(drag, |drag, offset, _, cx| {
                        drag.grab.set(f32::from(offset.x));
                        cx.new(|_| Ghost {
                            title: drag.title.clone(),
                        })
                    }),
            );
        }
        let mut content = div().w(px(width)).h_full().flex().flex_col().child(ruler);
        for lane in lanes {
            let color = lane
                .color
                .as_deref()
                .and_then(color_of)
                .unwrap_or(palette.accent);
            let mut row = div()
                .id(SharedString::from(format!("v3-track-{}", lane.id)))
                .debug_selector({
                    let id = format!("v3-track-{}", lane.id);
                    move || id.clone()
                })
                .min_h(px(model::ROW))
                .flex_1()
                .relative()
                .rounded(px(5.))
                .bg(palette.paper.solid())
                .border_b_1()
                .border_color(palette.desk.solid());
            let lane_id = lane.id.clone();
            let page = self.page_host();
            row = row
                .role(gpui::Role::Group)
                .aria_label(dr_shell::strings::tf(
                    cx,
                    keys::v3_timeline::LANE_TRACK,
                    &[("name", &lane.title)],
                ))
                .can_drop(move |value, _, _| {
                    value
                        .downcast_ref::<EntryDrag>()
                        .is_some_and(|drag| page.as_ref().is_some_and(|page| drag.matches(page)))
                })
                .on_drop::<EntryDrag>(cx.listener(move |this, drag, w, cx| {
                    this.dropped_entry(drag, lane_id.clone(), w, cx)
                }));
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
                let w = if short_segment {
                    (effective_span as f32 * unit).clamp(14., 24.)
                } else {
                    (effective_span as f32 * unit).max(8.)
                };
                if x + w < left || x > left + visible {
                    continue;
                }
                let title = self
                    .book
                    .v3()
                    .and_then(|b| b.entry(&clip.entry))
                    .map(|e| e.title.clone())
                    .unwrap_or_default();
                let id = clip.entry.clone();
                let drag = self.page_host().map(|page| {
                    let mut drag = EntryDrag::new(page, id.clone(), title.clone());
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
                let more = PanelIconButton::new(
                    SharedString::from(format!("v3-clip-menu-{}-{id}", lane.id)),
                    Icon::More,
                )
                .label(t(cx, keys::v3_timeline::PLACEMENT_ACTIONS))
                .on_click(cx.listener(move |this, e: &ClickEvent, _, cx| {
                    cx.stop_propagation();
                    this.popup = Some(Popup {
                        of: MenuOf::Clip {
                            entry: entry.clone(),
                            lane: lane_id.clone(),
                        },
                        at: e.position(),
                    });
                    cx.notify();
                }));
                let drop_lane = lane.id.clone();
                let page = self.page_host();
                let clip_selector = format!("v3-clip-{}-{id}", lane.id);
                let clip_body = glass::glass_box(
                    SharedString::from(clip_selector.clone()),
                    Kind::Rest,
                    Mode::default(),
                    false,
                    Spec::new(Tone::Color(color), 5.),
                    window,
                    cx,
                )
                .debug_selector(move || clip_selector.clone())
                .absolute()
                .left_0()
                .right_0()
                .top_0()
                .bottom_0()
                .flex()
                .items_center()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_color(color.solid())
                .role(gpui::Role::Button)
                .aria_label(title.clone())
                .cursor_grab()
                .when(!short_segment, |body| {
                    body.px_2().child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_ellipsis()
                            .child(title.clone()),
                    )
                })
                .on_click(cx.listener(move |this, e, _, cx| {
                    cx.stop_propagation();
                    this.open(&id, e, cx);
                }))
                .can_drop(move |value, _, _| {
                    value
                        .downcast_ref::<EntryDrag>()
                        .is_some_and(|drag| page.as_ref().is_some_and(|page| drag.matches(page)))
                })
                .on_drop::<EntryDrag>(cx.listener(move |this, drag, w, cx| {
                    this.dropped_entry(drag, drop_lane.clone(), w, cx)
                }))
                .when_some(drag, |body, drag| {
                    body.on_drag(drag, |drag, offset, _, cx| {
                        drag.set_grab(f32::from(offset.x));
                        cx.new(|_| Ghost {
                            title: drag.title.clone(),
                        })
                    })
                });
                let resize_selector = format!("v3-resize-{}-{}", lane.id, clip.entry);
                let handle = div()
                    .id(SharedString::from(resize_selector.clone()))
                    .debug_selector(move || resize_selector.clone())
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
                    .role(gpui::Role::Group)
                    .aria_label(title)
                    .child(clip_body);
                if w > 32. {
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
                row = row.child(slab.child(handle));
            }
            content = content.child(row);
        }
        div()
            .id("v3-timeline-scroll")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_x_scroll()
            .track_scroll(&self.scroll)
            .child(content)
            .on_scroll(cx.listener(|this, e, w, cx| this.wheel(e, w, cx)))
            .into_any_element()
    }
}

impl Render for Timeline {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
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
        if let Some(view) = self.view() {
            panel = panel.child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(self.rails(&lanes, cx))
                    .child(self.tracks(view, &lanes, window, cx))
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
        panel.children(self.popup(cx))
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
