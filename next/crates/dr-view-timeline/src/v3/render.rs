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
            row = row.child(div().w(px(220.)).child(edit.field.clone()));
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
        let mut menu = Menu::new("v3-timeline-menu");
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
            MenuOf::Lanes => {
                for e in &book.entries {
                    if e.deleted_at.is_some()
                        || !book
                            .template_of(&e.id)
                            .is_some_and(|t| t.kind == "level" && t.lane)
                    {
                        continue;
                    }
                    let added = self
                        .view()
                        .is_some_and(|v| v.lanes.iter().any(|l| l.entry == e.id));
                    let id = e.id.clone();
                    menu = menu.child(
                        MenuItem::new(
                            SharedString::from(format!("v3-lane-add-{}", e.id)),
                            Icon::Branch,
                            e.title.clone(),
                        )
                        .checked(added)
                        .disabled(added)
                        .on_click(cx.listener(move |this, _, _, cx| this.add_lane(id.clone(), cx))),
                    );
                }
            }
        }
        Some(
            overlay::float(
                Place::Point(popup.at),
                Layer::Popover,
                div()
                    .child(menu)
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
                        .mark(sand::Kind::Storyline)
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
            if i > 0 {
                let id = lane.id.clone();
                actions = actions.child(
                    PanelIconButton::new(
                        SharedString::from(format!("v3-lane-up-{id}")),
                        Icon::ChevronUp,
                    )
                    .label(t(cx, keys::v3_timeline::MOVE_UP))
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.reorder_lane(id.clone(), -1, cx)),
                    ),
                );
            }
            if i + 1 < lanes.len() {
                let id = lane.id.clone();
                actions = actions.child(
                    PanelIconButton::new(
                        SharedString::from(format!("v3-lane-down-{id}")),
                        Icon::ChevronDown,
                    )
                    .label(t(cx, keys::v3_timeline::MOVE_DOWN))
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.reorder_lane(id.clone(), 1, cx)),
                    ),
                );
            }
            let id = lane.id.clone();
            actions = actions.child(
                PanelIconButton::new(
                    SharedString::from(format!("v3-lane-remove-{id}")),
                    Icon::Minus,
                )
                .label(t(cx, keys::v3_timeline::REMOVE_LANE))
                .on_click(cx.listener(move |this, _, _, cx| this.remove_lane(id.clone(), cx))),
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
        let mut ruler = div().h(px(model::RULER)).flex_none().relative();
        let first = ((min + f64::from(left / unit)) / 5.).floor() * 5.;
        for step in 0..(visible / unit / 5.).ceil() as usize + 2 {
            let tick = first + step as f64 * 5.;
            ruler = ruler.child(
                div()
                    .absolute()
                    .left(px((tick - min) as f32 * unit))
                    .w(px(40.))
                    .whitespace_nowrap()
                    .text_xs()
                    .text_color(palette.muted().solid())
                    .child(tick.to_string()),
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
                .min_h(px(model::ROW))
                .flex_1()
                .relative()
                .rounded(px(5.))
                .bg(palette.paper.solid())
                .border_b_1()
                .border_color(palette.desk.solid());
            for clip in &lane.clips {
                let x = (clip.at - min) as f32 * unit;
                let w = (clip.span.unwrap_or(model::DEFAULT_SPAN) as f32 * unit).max(8.);
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
                row = row.child(
                    glass::glass_box(
                        SharedString::from(format!("v3-clip-{}-{}", lane.id, id)),
                        Kind::Rest,
                        Mode::default(),
                        false,
                        Spec::new(Tone::Clear, 5.),
                        window,
                        cx,
                    )
                    .child(
                        div()
                            .px_2()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .child(title.clone()),
                    )
                    .absolute()
                    .left(px(x))
                    .top(px(3.))
                    .bottom(px(3.))
                    .w(px(w))
                    .text_color(color.solid())
                    .role(gpui::Role::Button)
                    .aria_label(title)
                    .on_click(cx.listener(move |this, e, _, cx| this.open(&id, e, cx))),
                );
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
            .on_scroll(cx.listener(|this, _, _, cx| {
                this.remember(cx);
                cx.notify();
            }))
            .into_any_element()
    }
}

impl Render for Timeline {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let lanes = self.lanes();
        let body = self.bounds.clone();
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
                        canvas(move |b, _, _| body.set(Some(b)), |_, _, _, _| ())
                            .absolute()
                            .size_full(),
                    ),
            );
        }
        panel.children(self.popup(cx))
    }
}
