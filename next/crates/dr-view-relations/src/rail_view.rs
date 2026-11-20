//! How the 「关系」 rail is drawn (the prototype's third version): the head
//! row, the cards, their rows, the ＋ list.

use dr_i18n::keys;
use dr_model::v3::{RelationDirection, RelationSide};
use dr_shell::strings::{t, tf, tp};
use dr_ui::{
    Theme, anim,
    components::{
        Button, Layer, Menu, MenuItem, PanelIconButton, Place, RowIcon, ScopeToggle, float,
    },
    fonts::{Role, weight},
    glass::{self, Kind, Mode, Spec, Tone},
    linked,
    sand::{self, Icon, KindMark},
    style::DrStyled as _,
    tokens::radius,
};
use gpui::{
    AnyElement, Bounds, ClickEvent, Context, ElementId, Entity, InteractiveElement as _,
    IntoElement, MouseButton, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, canvas, div,
    prelude::FluentBuilder as _, px, size,
};

use crate::rail::{Card, DraftRow, RelationsRail, RowKey, shown_text};

/// The head row in the tab's header: how many, 「当前」, ＋.
pub struct RailHead {
    rail: Entity<RelationsRail>,
    _sub: Subscription,
}

impl RailHead {
    pub fn new(rail: Entity<RelationsRail>, cx: &mut Context<Self>) -> RailHead {
        let sub = cx.observe(&rail, |_, _, cx| cx.notify());
        RailHead { rail, _sub: sub }
    }
}

impl Render for RailHead {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let rail = self.rail.read(cx);
        let shown = rail.cards().len();
        let current = rail.current_only();
        let count = tp(
            cx,
            keys::v5_relations::KINDS,
            shown as u64,
            &[("count", &shown)],
        );
        let (on_scope, on_new) = (self.rail.clone(), self.rail.clone());
        div()
            .size_full()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.muted().solid())
                    .child(count),
            )
            .child(
                ScopeToggle::new(
                    "relations-current",
                    t(cx, keys::review_panel::scopes::CURRENT),
                    current,
                )
                .on_change(move |on, _, cx| {
                    on_scope.update(cx, |rail, cx| rail.set_current_only(on, cx));
                }),
            )
            .child(
                PanelIconButton::new("relations-new", Icon::Plus)
                    .label(t(cx, keys::v5_relations::NEW_RELATION))
                    .on_click(move |_, window, cx| {
                        on_new.update(cx, |rail, cx| rail.new_card(window, cx));
                    }),
            )
    }
}

/// The two glyphs between a row's sides and on a card's button.
fn glyph(direction: RelationDirection) -> &'static str {
    match direction {
        RelationDirection::Directed => "→",
        RelationDirection::Symmetric => "↔",
    }
}

/// The flash of a revealed row: the accent at 26 % for the first third,
/// then fading out (the prototype's `flash`).
fn flash_alpha(t: f32) -> f32 {
    if t < 0.35 {
        0.26
    } else {
        0.26 * (1.0 - (t - 0.35) / 0.65).max(0.0)
    }
}

impl Render for RelationsRail {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        self.row_bounds.borrow_mut().clear();
        let cards: Vec<AnyElement> = self
            .cards()
            .into_iter()
            .map(|card| self.card(card, window, cx))
            .collect();
        let picker = self.picker_float(window, cx);
        let me = cx.weak_entity();
        // After the rows are laid out: a waiting reveal can find its row.
        let reveal_probe = canvas(
            move |_, window, cx| {
                let me = me.clone();
                window.defer(cx, move |_, cx| {
                    me.update(cx, |rail, cx| rail.reveal_drawn(cx)).ok();
                });
            },
            |_, _, _, _| {},
        )
        .w_full()
        .h(px(0.0));
        div()
            .id("relations-rail")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .role(gpui::Role::Group)
            .aria_label(t(cx, keys::v5_relations::TAB))
            .child(
                div()
                    .id("relations-list")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .px(px(12.0))
                    .pt(px(4.0))
                    .pb(px(16.0))
                    .flex()
                    .flex_col()
                    .gap(px(10.0))
                    .text_color(p.ink(1).solid())
                    .children(cards)
                    .child(reveal_probe),
            )
            .children(picker)
    }
}

impl RelationsRail {
    fn card(&self, card: Card, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let key: SharedString = card
            .relation
            .as_ref()
            .map_or("new".into(), |r| r.id.clone().into());
        let id = |part: &str| ElementId::Name(format!("relations-card-{key}-{part}").into());
        let hovered = self.hover_card.as_deref() == Some(key.as_ref());
        let direction = card
            .relation
            .as_ref()
            .map_or(RelationDirection::Directed, |r| r.direction);
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(self.card_head(&card, hovered, window, cx));
        if let Some(desc) = self.card_description(&card, hovered, window, cx) {
            body = body.child(desc);
        }
        for row in &card.rows {
            let key = RowKey::Stored(row.id.clone());
            body = body.child(self.row(&card, key, &row.left, &row.right, direction, window, cx));
        }
        for d in &card.drafts {
            body = body.child(self.draft_row(&card, d, direction, window, cx));
        }
        let hover_key = key.clone();
        div()
            .id(id("wrap"))
            .w_full()
            .on_hover(cx.listener(move |rail, hovered: &bool, _, cx| {
                let now = hovered.then(|| hover_key.to_string());
                if *hovered || rail.hover_card.as_deref() == Some(hover_key.as_ref()) {
                    rail.hover_card = now;
                    cx.notify();
                }
            }))
            .child(
                glass::glass_box(
                    id("card"),
                    Kind::Surface,
                    Mode::default(),
                    false,
                    Spec::new(Tone::Clear, radius::MD),
                    window,
                    cx,
                )
                .relative()
                .w_full()
                .px(px(10.0))
                .pt(px(8.0))
                .pb(px(10.0))
                .text_color(p.ink(1).solid())
                .child(body),
            )
            .into_any_element()
    }

    fn card_head(
        &self,
        card: &Card,
        hovered: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Theme::of(window, cx).palette;
        let relation = card.relation.as_ref();
        let rel_id = relation.map(|r| r.id.clone());
        let key = rel_id.clone().unwrap_or_else(|| "new".into());
        let id = |part: &str| ElementId::Name(format!("relations-card-{key}-{part}").into());
        let renaming = self
            .rename
            .as_ref()
            .filter(|r| r.relation.as_deref() == rel_id.as_deref());
        let name: AnyElement = match renaming {
            Some(r) => div()
                .w(px(140.0))
                .h(px(24.0))
                .px(px(6.0))
                .flex()
                .items_center()
                .rounded(px(radius::SM))
                .bg(p.page.solid())
                .font_role(Role::Prose)
                .weight(weight::SEMIBOLD)
                .type_px(15.0, 22.0)
                .child(r.field.clone())
                .into_any_element(),
            None => {
                let name = relation.map(|r| r.name.clone()).unwrap_or_default();
                let target = rel_id.clone();
                div()
                    .id(id("name"))
                    .px(px(2.0))
                    .rounded(px(radius::SM))
                    .cursor_pointer()
                    .font_role(Role::Prose)
                    .weight(weight::SEMIBOLD)
                    .type_px(15.0, 22.0)
                    .text_color(p.ink(1).solid())
                    .role(gpui::Role::Button)
                    .aria_label(SharedString::from(name.clone()))
                    .child(name)
                    .on_click(cx.listener(move |rail, _, window, cx| {
                        rail.start_rename(target.clone(), window, cx);
                    }))
                    .into_any_element()
            }
        };
        let direction = relation.map_or(RelationDirection::Directed, |r| r.direction);
        let dir_target = rel_id.clone();
        let dir = glass::glass_box(
            id("direction"),
            Kind::Rest,
            Mode {
                disabled: relation.is_none(),
                ..Mode::default()
            },
            false,
            Spec::new(Tone::Clear, radius::SM),
            window,
            cx,
        )
        .min_w(px(30.0))
        .h(px(26.0))
        .px(px(6.0))
        .flex()
        .items_center()
        .justify_center()
        .font_role(Role::Index)
        .type_px(15.0, 26.0)
        .text_color(
            if relation.is_some() {
                p.ink(2)
            } else {
                p.ink(3)
            }
            .solid(),
        )
        .role(gpui::Role::Button)
        .aria_label(t(cx, keys::v5_relations::DIRECTION))
        .when(relation.is_some(), |d| d.cursor_pointer())
        .child(glyph(direction))
        .on_click(cx.listener(move |rail, _, _, cx| {
            if let Some(id) = &dir_target {
                rail.toggle_direction(id, cx);
            }
        }));
        let count = relation.map(|r| r.pair_count).unwrap_or(0);
        let add_target = rel_id.clone();
        let mut head = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .min_h(px(26.0))
            .child(name)
            .child(dir)
            .child(
                div()
                    .id(id("pairs"))
                    .font_role(Role::Index)
                    .type_px(12.0, 16.0)
                    .text_color(p.ink(4).solid())
                    .role(gpui::Role::Label)
                    .aria_label(tp(
                        cx,
                        keys::v5_relations::PAIRS,
                        count as u64,
                        &[("count", &count)],
                    ))
                    .child(SharedString::from(count.to_string())),
            )
            .child(div().flex_1());
        if hovered && relation.is_some() {
            head = head.child(
                PanelIconButton::new(id("add-row"), Icon::Plus)
                    .label(t(cx, keys::v5_relations::ADD_ROW))
                    .on_click(cx.listener(move |rail, _, _, cx| {
                        if let Some(id) = &add_target {
                            rail.add_row(id, cx);
                        }
                    })),
            );
        }
        let failed = renaming.is_some_and(|r| r.failed);
        div()
            .flex()
            .flex_col()
            .child(head)
            .when(failed, |d| {
                d.child(self.save_failed(&key, "name", window, cx))
            })
            .into_any_element()
    }

    /// 「未能保存」 and 「重试」 under something that did not save, as under
    /// an entry's title.
    fn save_failed(
        &self,
        key: &str,
        part: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap_2()
            .font_role(Role::Ui)
            .type_px(theme.scale.caption, theme.scale.line_caption)
            .text_color(theme.palette.danger.solid())
            .child(t(cx, keys::k4_pages::SAVE_FAILED))
            .child(
                Button::new(
                    ElementId::Name(format!("relations-card-{key}-{part}-retry").into()),
                    t(cx, keys::markdown_share::RETRY),
                )
                .small()
                .text()
                .on_click(cx.listener(|rail, _, window, cx| rail.retry(window, cx))),
            )
            .into_any_element()
    }

    fn card_description(
        &self,
        card: &Card,
        hovered: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let relation = card.relation.as_ref()?;
        let rel = relation.id.clone();
        let id = |part: &str| ElementId::Name(format!("relations-card-{rel}-{part}").into());
        if let Some(d) = self.describe.as_ref().filter(|d| d.relation == relation.id) {
            let failed = d.failed;
            return Some(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .w_full()
                            .px(px(4.0))
                            .py(px(2.0))
                            .rounded(px(radius::SM))
                            .bg(p.page.solid())
                            .border_1()
                            .border_color(p.hairline())
                            .font_role(Role::Ui)
                            .type_px(14.0, 20.0)
                            .text_color(p.ink(2).solid())
                            .child(d.area.clone()),
                    )
                    .when(failed, |el| {
                        el.child(self.save_failed(&rel, "description", window, cx))
                    })
                    .into_any_element(),
            );
        }
        let start = relation.id.clone();
        if relation.description.text.trim().is_empty() {
            if !hovered {
                return None;
            }
            return Some(
                div()
                    .id(id("describe"))
                    .h(px(22.0))
                    .w(px(22.0))
                    .flex()
                    .items_center()
                    .cursor_pointer()
                    .role(gpui::Role::Button)
                    .aria_label(t(cx, keys::v5_relations::DESCRIPTION))
                    .child(sand::icon(Icon::Edit, 12.0, p.ink(4).solid()))
                    .on_click(cx.listener(move |rail, _, window, cx| {
                        rail.start_describe(&start, window, cx);
                    }))
                    .into_any_element(),
            );
        }
        let open = self.entry_opener(cx);
        Some(
            div()
                .id(id("description"))
                .w_full()
                .px(px(2.0))
                .cursor_text()
                .font_role(Role::Ui)
                .type_px(14.0, 20.0)
                .text_color(p.ink(3).solid())
                .role(gpui::Role::Button)
                .aria_label(t(cx, keys::v5_relations::DESCRIPTION))
                .child(
                    linked::linked(id("description-text"), shown_text(&relation.description))
                        .on_open(move |target, window, cx| open(target, window, cx)),
                )
                .on_click(cx.listener(move |rail, _, window, cx| {
                    rail.start_describe(&start, window, cx);
                }))
                .into_any_element(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn row(
        &self,
        card: &Card,
        key: RowKey,
        left: &[String],
        right: &[String],
        direction: RelationDirection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let rel = card
            .relation
            .as_ref()
            .map(|r| r.id.clone())
            .unwrap_or_default();
        let slug = match &key {
            RowKey::Stored(id) => id.clone(),
            RowKey::Draft(k) => format!("draft-{k}"),
        };
        let id = |part: &str| ElementId::Name(format!("relations-row-{slug}-{part}").into());
        let hovered = self.hover.as_ref() == Some(&key);
        let bare = left.is_empty() || right.is_empty();
        let show = hovered || bare;
        let flash = match &key {
            RowKey::Stored(row) => self.flash_of(row),
            RowKey::Draft(_) => None,
        };
        if let Some(t) = flash {
            anim::keep_going(t < 1.0, window);
        }
        let side = |members: &[String],
                    side: RelationSide,
                    window: &mut Window,
                    cx: &mut Context<Self>| {
            let mut el = div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_row()
                .flex_wrap()
                .items_center()
                .gap_x(px(4.0))
                .gap_y(px(2.0));
            for entry in members {
                el = el.child(self.chip(&key, &slug, entry, hovered, window, cx));
            }
            if show && !rel.is_empty() {
                el = el.child(self.plus(&key, &slug, &rel, side, window, cx));
            }
            el
        };
        let left_el = side(left, RelationSide::Left, window, cx);
        let right_el = side(right, RelationSide::Right, window, cx);
        let hover_key = key.clone();
        let delete_key = key.clone();
        let mut row = div()
            .id(id("row"))
            .relative()
            .flex()
            .flex_row()
            .items_start()
            .gap(px(6.0))
            .pl(px(6.0))
            .pr(px(22.0))
            .py(px(4.0))
            .mx(px(-6.0))
            .rounded(px(3.0))
            .role(gpui::Role::Group)
            .when(hovered, |d| d.bg(p.ink(1).alpha(0.045)))
            .when_some(flash, |d, t| d.bg(p.accent.alpha(flash_alpha(t))))
            .on_hover(cx.listener(move |rail, hovered: &bool, _, cx| {
                if *hovered {
                    rail.set_hover(Some(hover_key.clone()), cx);
                } else if rail.hover.as_ref() == Some(&hover_key) {
                    rail.set_hover(None, cx);
                }
            }))
            .child(left_el)
            .child({
                let arrow_selector = format!("relations-row-{slug}-arrow");
                div()
                    .debug_selector(move || arrow_selector)
                    .flex_none()
                    .px(px(2.0))
                    .font_role(Role::Index)
                    .type_px(14.0, 24.0)
                    .text_color(p.ink(3).solid())
                    .child(glyph(direction))
            })
            .child(right_el);
        if show {
            row = row.child(
                div()
                    .id(id("delete"))
                    .absolute()
                    .right(px(0.0))
                    .top(px(6.0))
                    .size(px(20.0))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(|s| s.bg(p.ink(1).alpha(0.06)))
                    .role(gpui::Role::Button)
                    .aria_label(t(cx, keys::v5_relations::DELETE_ROW))
                    .child(sand::icon(Icon::Trash, 11.0, p.ink(4).solid()))
                    .on_click(cx.listener(move |rail, _, _, cx| {
                        rail.delete_row(&delete_key, cx);
                    })),
            );
        }
        if let RowKey::Stored(row_id) = &key {
            let (bounds, row_id) = (self.row_bounds.clone(), row_id.clone());
            row = row.child(
                canvas(
                    move |b, _, _| {
                        bounds.borrow_mut().insert(row_id.clone(), b);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        }
        row.into_any_element()
    }

    fn draft_row(
        &self,
        card: &Card,
        d: &DraftRow,
        direction: RelationDirection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = d.key;
        div()
            .flex()
            .flex_col()
            .child(self.row(
                card,
                RowKey::Draft(key),
                &d.left,
                &d.right,
                direction,
                window,
                cx,
            ))
            .when_some(d.duplicate.as_ref(), |el, pair| {
                let title = |id: &str| {
                    self.entry_look(id)
                        .map(|entry| entry.title)
                        .unwrap_or_default()
                };
                let left = title(&pair.left);
                let right = title(&pair.right);
                let arrow = if direction == RelationDirection::Symmetric {
                    "↔"
                } else {
                    "→"
                };
                let pair = format!("{left} {arrow} {right}");
                let message = tf(cx, keys::v5_relations::DUPLICATE_PAIR, &[("pair", &pair)]);
                el.child(
                    div()
                        .id(("relations-duplicate-pair", key))
                        .debug_selector(move || format!("relations-draft-{key}-duplicate"))
                        .role(gpui::Role::Status)
                        .aria_label(message.clone())
                        .text_color(Theme::of(window, cx).palette.danger.solid())
                        .child(message),
                )
            })
            .when(d.failed, |el| {
                el.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .text_color(Theme::of(window, cx).palette.danger.solid())
                        .child(t(cx, keys::k4_pages::SAVE_FAILED))
                        .child(
                            Button::new(
                                ElementId::Name(format!("relations-draft-{key}-retry").into()),
                                t(cx, keys::markdown_share::RETRY),
                            )
                            .small()
                            .text()
                            .on_click(cx.listener(move |rail, _, _, cx| rail.retry_draft(key, cx))),
                        ),
                )
            })
            .into_any_element()
    }

    /// One name in a row: its entry's mark and title, opening it; × after
    /// it while the pointer is on the row.
    fn chip(
        &self,
        row: &RowKey,
        slug: &str,
        entry: &str,
        hovered: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let id =
            |part: &str| ElementId::Name(format!("relations-row-{slug}-{entry}-{part}").into());
        let Some(look) = self.entry_look(entry) else {
            return div().into_any_element();
        };
        let open = self.entry_opener(cx);
        let target = entry.to_owned();
        let remove_row = row.clone();
        let remove_entry = entry.to_owned();
        // A name longer than its side of the row is cut with an ellipsis
        // there (the whole name stays the button's accessible name): it never
        // runs under the arrow or into the other side.
        let chip_selector = format!("relations-row-{slug}-{entry}-chip");
        div()
            .debug_selector(move || chip_selector)
            .max_w_full()
            .min_w_0()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .h(px(24.0))
            .px(px(2.0))
            .rounded(px(3.0))
            .child(
                div()
                    .id(id("open"))
                    .min_w_0()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(5.0))
                    .cursor_pointer()
                    .font_role(Role::Ui)
                    .type_px(15.0, 22.0)
                    .text_color(p.ink(1).solid())
                    .role(gpui::Role::Button)
                    .aria_label(look.title.clone())
                    .child(
                        div().flex_none().child(
                            KindMark::new(id("mark"), look.mark)
                                .color(p.ink(3))
                                .scale(10.0 / sand::MARK_SLOT),
                        ),
                    )
                    .child(div().min_w_0().truncate().child(look.title.clone()))
                    .on_click(move |_, window, cx| open(&target, window, cx)),
            )
            .when(hovered, |d| {
                d.child(
                    div()
                        .id(id("remove"))
                        .flex()
                        .items_center()
                        .cursor_pointer()
                        .role(gpui::Role::Button)
                        .aria_label(tf(
                            cx,
                            keys::v5_relations::REMOVE_ENTRY,
                            &[("name", &look.title.as_ref())],
                        ))
                        .child(sand::icon(Icon::Close, 10.0, p.ink(4).solid()))
                        .on_click(cx.listener(move |rail, _, _, cx| {
                            rail.remove_entry(&remove_row, &remove_entry, cx);
                        })),
                )
            })
            .into_any_element()
    }

    /// A side's ＋: the `@` list of the book's entries.
    fn plus(
        &self,
        row: &RowKey,
        slug: &str,
        relation: &str,
        side: RelationSide,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let which = match side {
            RelationSide::Left => "left",
            RelationSide::Right => "right",
        };
        let (row, relation) = (row.clone(), relation.to_owned());
        div()
            .id(ElementId::Name(
                format!("relations-row-{slug}-add-{which}").into(),
            ))
            .size(px(20.0))
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(|s| s.bg(p.ink(1).alpha(0.06)))
            .role(gpui::Role::Button)
            .aria_label(t(cx, keys::v5_relations::ADD_ENTRY))
            .child(sand::icon(Icon::Plus, 11.0, p.ink(4).solid()))
            .on_click(cx.listener(move |rail, e: &ClickEvent, window, cx| {
                let at = e.position();
                let anchor = Bounds::new(at, size(px(1.0), px(1.0)));
                rail.open_picker(row.clone(), &relation, side, anchor, window, cx);
            }))
            .into_any_element()
    }

    /// The open ＋ list, floating under the ＋.
    fn picker_float(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let picker = self.picker.as_ref()?;
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let field = div()
            .mx(px(8.0))
            .mb(px(6.0))
            .h(px(30.0))
            .px(px(10.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .rounded(px(radius::SM))
            .bg(p.page.solid())
            .font_role(Role::Ui)
            .type_px(s.body, s.line_body)
            .text_color(p.ink(1).solid())
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(14.0, 18.0)
                    .text_color(p.ink(4).solid())
                    .child("@"),
            )
            .child(div().flex_1().min_w_0().child(picker.field.clone()));
        let mut list = div()
            .id("relations-pick-list")
            .max_h(px(196.0))
            .overflow_y_scroll()
            .flex()
            .flex_col();
        for (ix, item) in self.picker_items().into_iter().take(60).enumerate() {
            let target = item.target.clone();
            let row = MenuItem::new(
                ElementId::Name(format!("relations-pick-{ix}").into()),
                RowIcon::Mark(item.mark, None),
                item.label.clone(),
            )
            .on_click(cx.listener(move |rail, _, window, cx| {
                rail.pick(&target, window, cx);
            }));
            list = list.child(match item.detail {
                Some(d) => row.trailing(d),
                None => row,
            });
        }
        let menu = Menu::new("relations-pick")
            .exactly(220.0)
            .child(field)
            .child(list);
        Some(
            float(
                Place::below(picker.anchor, 6.0),
                Layer::Popover,
                div()
                    .on_mouse_down_out(cx.listener(|rail, _, _, cx| rail.close_picker(cx)))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(menu),
            )
            .into_any_element(),
        )
    }
}
