//! Bottom collapsible and top-edge resizable drawer for M23:
//! left column shows unsorted (unlinked) materials with hover actions;
//! right column shows resolved TODOs and comments with reopen and delete.

use dr_i18n::keys;
use dr_shell::t;
use dr_ui::{
    Theme,
    components::{Button, EmptyState, PanelIconButton},
    fonts::{Role, weight},
    sand::{self, Icon},
    style::DrStyled,
    tokens::{Story, radius},
};
use dr_view_material::card;
use dr_workspace::dto::CommentInfo;
use gpui::{
    AnyElement, AppContext as _, Context, InteractiveElement, IntoElement, MouseButton,
    MouseDownEvent, ParentElement, Render, SharedString, StatefulInteractiveElement as _, Styled,
    Window, div, list, px,
};

use crate::{
    model::DRAWER_HEADER_HEIGHT,
    view::{ShelfReviewView, sync_list_state},
};

#[derive(Clone, Copy)]
pub(crate) struct DrawerResizeDrag;

pub(crate) struct EmptyDragGhost;

impl Render for EmptyDragGhost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

impl ShelfReviewView {
    pub fn resolved_items(&self, cx: &gpui::App) -> Vec<(CommentInfo, SharedString)> {
        self.review_snapshot(cx).resolved_items.to_vec()
    }

    pub(crate) fn render_bottom_drawer(
        &self,
        container_height: Option<f32>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let entity = cx.entity();

        let mats = self.materials_snapshot(cx);
        let orphans = mats.orphans;
        let orphan_keys = mats.orphan_keys;
        let rev = self.review_snapshot(cx);
        let resolved = rev.resolved_items;
        let resolved_keys = rev.resolved_keys;
        let open = self.memory.drawer_open;
        let open_height =
            crate::model::clamp_drawer_height(self.memory.drawer_height, container_height);

        let toggle_label = if open {
            t(cx, keys::memo_material::super_::COLLAPSE_DRAWER)
        } else {
            t(cx, keys::memo_material::super_::EXPAND_DRAWER)
        };
        let toggle_icon = if open {
            Icon::ChevronDown
        } else {
            Icon::ChevronRight
        };
        let toggle_ent = entity.clone();

        let header = div()
            .id("shelf-review-drawer-bar")
            .h(px(DRAWER_HEADER_HEIGHT))
            .px(px(14.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.0))
            .cursor_pointer()
            .role(gpui::Role::Button)
            .aria_label(toggle_label)
            .on_click(move |_, _, cx| {
                toggle_ent.update(cx, |this, cx| this.toggle_drawer(cx));
            })
            .child(sand::icon(toggle_icon, 12.0, p.ink(3).solid()))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_baseline()
                    .gap(px(5.0))
                    .child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(2).solid())
                            .child(t(cx, keys::memo_material::super_::ORPHANS)),
                    )
                    .child(
                        div()
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(3).solid())
                            .child(orphans.len().to_string()),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_baseline()
                    .gap(px(5.0))
                    .child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(2).solid())
                            .child(t(cx, keys::memo_material::super_::RESOLVED)),
                    )
                    .child(
                        div()
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.ink(3).solid())
                            .child(resolved.len().to_string()),
                    ),
            );

        if !open {
            return div()
                .flex_none()
                .w_full()
                .border_t(px(0.5))
                .border_color(p.hairline())
                .bg(p.desk.solid())
                .child(header)
                .into_any_element();
        }

        // Left half: Unsorted / unlinked materials.
        let orphan_body = if orphans.is_empty() {
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .items_center()
                .justify_center()
                .px(px(16.0))
                .child(
                    EmptyState::new(
                        "shelf-drawer-no-orphans",
                        t(cx, keys::memo_material::super_::NO_ORPHANS),
                    )
                    .mark(sand::Kind::Material),
                )
                .into_any_element()
        } else {
            sync_list_state(&self.orphan_list, &self.orphan_list_sig, &orphan_keys, 0);
            let weak = cx.weak_entity();
            let orphan_len = orphans.len();
            div()
                .id("shelf-drawer-orphans-scroll")
                .flex_1()
                .min_h_0()
                .overflow_hidden()
                .child(
                    list(self.orphan_list.clone(), move |ix, window, cx| {
                        let Some(mat) = orphans.get(ix) else {
                            return div().into_any_element();
                        };
                        let Some(ent) = weak.upgrade() else {
                            return div().into_any_element();
                        };
                        let theme = Theme::of(window, cx);
                        let (p, s) = (theme.palette, theme.scale);
                        let open_id = mat.id.clone();
                        let open_ent = ent.clone();
                        let title: SharedString = if mat.title.trim().is_empty() {
                            t(cx, keys::material_folders::UNTITLED)
                        } else {
                            mat.title.clone().into()
                        };
                        let sub = card::subline(mat, cx);
                        let row = div()
                            .id(SharedString::from(format!("drawer-orphan-row-{}", mat.id)))
                            .px(px(8.0))
                            .py(px(6.0))
                            .rounded(px(radius::SM))
                            .border(px(0.5))
                            .border_color(p.subtle_hairline())
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.0))
                            .cursor_pointer()
                            .on_click(move |_, _, cx| {
                                open_ent.update(cx, |this, cx| this.open_material(&open_id, cx));
                            })
                            .child(card::thumb(mat, 28.0, window, cx))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .gap(px(1.0))
                                    .child(
                                        div()
                                            .font_role(Role::Ui)
                                            .type_px(s.secondary, s.line_body)
                                            .text_color(p.ink(1).solid())
                                            .truncate()
                                            .child(title),
                                    )
                                    .child(
                                        div()
                                            .font_role(Role::Ui)
                                            .type_px(s.caption, s.line_caption)
                                            .text_color(p.ink(3).solid())
                                            .truncate()
                                            .child(sub),
                                    ),
                            );
                        let hover_el = ent.update(cx, |this, cx| {
                            this.render_material_hover_card("drawer-mat", mat, row, cx)
                        });
                        div()
                            .px(px(12.0))
                            .pt(px(if ix == 0 { 8.0 } else { 0.0 }))
                            .pb(px(if ix + 1 == orphan_len { 8.0 } else { 4.0 }))
                            .child(hover_el)
                            .into_any_element()
                    })
                    .size_full(),
                )
                .into_any_element()
        };

        let left_col = div()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .border_r(px(0.5))
            .border_color(p.subtle_hairline())
            .flex()
            .flex_col()
            .child(
                div()
                    .flex_none()
                    .px(px(14.0))
                    .py(px(6.0))
                    .border_b(px(0.5))
                    .border_color(p.subtle_hairline())
                    .font_role(Role::Structure)
                    .type_px(s.caption, s.line_caption)
                    .weight(weight::MEDIUM)
                    .text_color(p.ink(3).solid())
                    .child(t(cx, keys::memo_material::super_::ORPHAN_HEADER)),
            )
            .child(orphan_body);

        // Right half: Resolved TODOs & comments.
        let resolved_body = if resolved.is_empty() {
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .items_center()
                .justify_center()
                .px(px(16.0))
                .child(
                    EmptyState::new(
                        "shelf-drawer-no-resolved",
                        t(cx, keys::memo_material::super_::NO_RESOLVED),
                    )
                    .icon(Icon::Check),
                )
                .into_any_element()
        } else {
            sync_list_state(
                &self.resolved_list,
                &self.resolved_list_sig,
                &resolved_keys,
                0,
            );
            let weak = cx.weak_entity();
            let rv_opt = self.review.clone();
            let resolved_len = resolved.len();
            div()
                .id("shelf-drawer-resolved-scroll")
                .flex_1()
                .min_h_0()
                .overflow_hidden()
                .child(
                    list(self.resolved_list.clone(), move |ix, window, cx| {
                        let Some((item, source_title)) = resolved.get(ix) else {
                            return div().into_any_element();
                        };
                        let Some(ent) = weak.upgrade() else {
                            return div().into_any_element();
                        };
                        let theme = Theme::of(window, cx);
                        let (p, s) = (theme.palette, theme.scale);
                        let todo = item.kind == "todo";
                        let badge_color = if todo {
                            p.story(Story::S4).mix(p.ink(1), 0.16)
                        } else {
                            p.comment
                        };
                        let badge_word = if todo {
                            t(cx, keys::review_panel::filters::TODO)
                        } else {
                            t(cx, keys::review_panel::filters::COMMENT)
                        };
                        let body_text: SharedString = if item.body.trim().is_empty() {
                            t(cx, keys::memo_material::todo::EMPTY)
                        } else {
                            item.body.clone().into()
                        };
                        let writing = rv_opt
                            .as_ref()
                            .is_some_and(|rv| rv.read(cx).is_writing(&item.id));
                        let reopen_id = item.id.clone();
                        let del_id = item.id.clone();
                        let reopen_ent = ent.clone();
                        let del_ent = ent;

                        let row = div()
                            .id(SharedString::from(format!(
                                "drawer-resolved-row-{}",
                                item.id
                            )))
                            .px(px(8.0))
                            .py(px(6.0))
                            .rounded(px(radius::SM))
                            .border(px(0.5))
                            .border_color(p.subtle_hairline())
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .flex_none()
                                    .font_role(Role::Index)
                                    .type_px(s.caption, s.line_caption)
                                    .text_color(badge_color.solid())
                                    .child(badge_word),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .gap(px(1.0))
                                    .child(
                                        div()
                                            .font_role(Role::Ui)
                                            .type_px(s.secondary, s.line_body)
                                            .text_color(p.ink(2).solid())
                                            .truncate()
                                            .child(body_text),
                                    )
                                    .child(
                                        div()
                                            .font_role(Role::Ui)
                                            .type_px(s.caption, s.line_caption)
                                            .text_color(p.ink(4).solid())
                                            .truncate()
                                            .child(source_title.clone()),
                                    ),
                            )
                            .child(
                                Button::new(
                                    SharedString::from(format!("drawer-reopen-{}", item.id)),
                                    t(cx, keys::memo_material::super_::REOPEN_SHORT),
                                )
                                .text()
                                .small()
                                .disabled(writing || crate::is_frozen(cx))
                                .on_click(move |_, _, cx| {
                                    reopen_ent.update(cx, |this, cx| {
                                        this.reopen_review_item(&reopen_id, cx);
                                    });
                                }),
                            )
                            .child(
                                PanelIconButton::new(
                                    SharedString::from(format!("drawer-delete-{}", item.id)),
                                    Icon::Trash,
                                )
                                .label(t(cx, keys::common::DELETE))
                                .danger()
                                .on_click(move |_, _, cx| {
                                    del_ent.update(cx, |this, cx| {
                                        this.delete_review_item(&del_id, cx);
                                    });
                                }),
                            );
                        div()
                            .px(px(12.0))
                            .pt(px(if ix == 0 { 8.0 } else { 0.0 }))
                            .pb(px(if ix + 1 == resolved_len { 8.0 } else { 4.0 }))
                            .child(row)
                            .into_any_element()
                    })
                    .size_full(),
                )
                .into_any_element()
        };

        let right_col = div()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex_none()
                    .px(px(14.0))
                    .py(px(6.0))
                    .border_b(px(0.5))
                    .border_color(p.subtle_hairline())
                    .font_role(Role::Structure)
                    .type_px(s.caption, s.line_caption)
                    .weight(weight::MEDIUM)
                    .text_color(p.ink(3).solid())
                    .child(t(cx, keys::memo_material::super_::RESOLVED_HEADER)),
            )
            .child(resolved_body);

        let down_ent = entity.clone();
        let top_resize = div()
            .id("shelf-review-drawer-resize")
            .absolute()
            .top(px(-3.0))
            .left_0()
            .right_0()
            .h(px(6.0))
            .cursor_row_resize()
            .on_mouse_down(MouseButton::Left, move |e: &MouseDownEvent, _, cx| {
                down_ent.update(cx, |this, _| {
                    this.drawer_drag_start = Some((f32::from(e.position.y), open_height));
                });
            })
            .on_drag(DrawerResizeDrag, |_, _, _, cx| cx.new(|_| EmptyDragGhost));

        div()
            .relative()
            .flex_none()
            .w_full()
            .h(px(open_height))
            .border_t(px(0.5))
            .border_color(p.hairline())
            .bg(p.desk.solid())
            .flex()
            .flex_col()
            .child(top_resize)
            .child(header)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .border_t(px(0.5))
                    .border_color(p.subtle_hairline())
                    .flex()
                    .flex_row()
                    .child(left_col)
                    .child(right_col),
            )
            .into_any_element()
    }
}
