//! My modules on 全部项目 (`custom-modules.md` §10, CM3; 原型第三页): under
//! 「我的模板」 in the rail, 「我的模块」 one row a module (the 「线装」 mark,
//! the most recently changed first, hidden while there are none). A row's
//! hover card: the module's name, its 一块 drawn with its sample, a line,
//! 编辑, 导出（.driftingmodule）, and 删除 after a question (as 「我的模板」).
//!
//! 编辑 opens the module's workbench: a pill of the project the window has
//! open, as the workbench always is (§8 甲); 全部项目 gives way to it.

use std::cell::Cell;
use std::rc::Rc;

use dr_i18n::keys::{self, module_bench as mb};
use dr_model::custom_module::{LookSize, ModuleValue};
use dr_shell::strings::{t, tf};
use dr_ui::{
    Theme,
    components::{Button, CardAction, CardBody, Dialog, HoverCard},
    fonts::Role,
    glass::{self, Kind as GlassKind, Mode, Spec, Tone},
    sand::{self, Icon},
    style::DrStyled,
};
use dr_view_module_look::{Blanks, Scope};
use dr_workspace::commands::v3::custom_module::ModuleSummary;
use gpui::{
    AnyElement, App, ClickEvent, Context, ElementId, InteractiveElement, IntoElement, MouseButton,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::view::{ExportModule, Shelf};

/// The 「我的模块」 section of the rail, or nothing without modules.
pub(crate) fn render_rail_modules(
    modules: &[(ModuleSummary, Option<ModuleValue>)],
    press_taken: Rc<Cell<bool>>,
    window: &mut Window,
    cx: &mut Context<Shelf>,
) -> Option<AnyElement> {
    if modules.is_empty() {
        return None;
    }
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let entity = cx.entity();
    let mut rows = Vec::with_capacity(modules.len());
    for (summary, value) in modules {
        let mid = summary.id.clone();
        let row_id = format!("shelf-module-{mid}");
        let row_sel = row_id.clone();
        let group = SharedString::from(row_id.clone());
        let taken = press_taken.clone();
        let name: SharedString = summary.name.clone().into();
        let row = glass::glass_box(
            ElementId::Name(row_id.into()),
            GlassKind::Hidden,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, 10.0),
            window,
            cx,
        )
        .debug_selector(move || row_sel.clone())
        .group(group.clone())
        .role(gpui::Role::ListItem)
        .aria_label(name.clone())
        .w_full()
        .min_h(px(32.0))
        .px(px(10.0))
        .py(px(6.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .text_color(p.ink(2).solid())
        .group_hover(group, move |st| st.text_color(p.ink(1).solid()))
        .on_mouse_down(MouseButton::Left, move |_, _, _| taken.set(true))
        // A row itself does nothing (as 「我的模板」's).
        .on_click(|_, _, cx| cx.stop_propagation())
        .child(sand::icon(Icon::Stitched, 15.0, p.muted().solid()))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .font_role(Role::Ui)
                .type_px(s.body, 20.0)
                .truncate()
                .child(name),
        );
        let card_summary = summary.clone();
        let card_value = value.clone();
        let card_entity = entity.clone();
        let hc_id = format!("shelf-module-hc-{mid}");
        let row = HoverCard::new(ElementId::Name(hc_id.into()), row, move |window, cx| {
            module_card(&card_summary, card_value.as_ref(), &card_entity, window, cx)
        })
        .beside();
        rows.push(row.into_any_element());
    }
    Some(
        div()
            .id("shelf-my-modules-section")
            .debug_selector(|| "shelf-my-modules-section".into())
            .mt(px(18.0))
            .min_h_0()
            .flex()
            .flex_col()
            .child(
                div()
                    .mx(px(10.0))
                    .mb(px(4.0))
                    .flex_none()
                    .font_role(Role::Index)
                    .type_px(13.0, 18.0)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, mb::MY_MODULES)),
            )
            .child(
                div()
                    .id("shelf-my-modules")
                    .debug_selector(|| "shelf-my-modules".into())
                    .min_h_0()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(1.0))
                    .children(rows),
            )
            .into_any_element(),
    )
}

/// A row's hover card: the name, the module's 一块 with its sample, then
/// 编辑 and 导出, then 删除.
fn module_card(
    summary: &ModuleSummary,
    value: Option<&ModuleValue>,
    shelf: &gpui::Entity<Shelf>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    let mid = summary.id.clone();
    let mut card = CardBody::new(
        ElementId::Name(format!("shelf-module-card-{mid}").into()),
        summary.name.clone(),
    );
    if let Some(value) = value {
        let look = dr_view_module_look::render(
            ElementId::Name(format!("shelf-module-look-{mid}").into()),
            value,
            &Scope::sample(value),
            LookSize::Block,
            Blanks::Dash,
            None,
            window,
            cx,
        );
        let sel = format!("shelf-module-preview-{mid}");
        card = card.section(vec![
            div()
                .debug_selector(move || sel.clone())
                .mx(px(6.0))
                .max_h(px(120.0))
                .overflow_hidden()
                .rounded(px(3.0))
                .bg(p.page.solid())
                .p(px(8.0))
                .child(look)
                .into_any_element(),
        ]);
    }
    let edit_id = mid.clone();
    let edit_shelf = shelf.clone();
    let export_id = mid.clone();
    let delete = summary.clone();
    let delete_shelf = shelf.clone();
    let edit_sel = format!("shelf-module-edit-{mid}");
    let export_sel = format!("shelf-module-export-{mid}");
    let delete_sel = format!("shelf-module-delete-{mid}");
    card = card
        .section(vec![
            div()
                .debug_selector({
                    let s = edit_sel.clone();
                    move || s.clone()
                })
                .child(
                    CardAction::new(
                        ElementId::Name(edit_sel.into()),
                        Icon::Edit,
                        t(cx, keys::common::EDIT),
                    )
                    .on_click(move |_, window, cx| {
                        edit_shelf.update(cx, |s, cx| s.edit_module(&edit_id, window, cx));
                    }),
                )
                .into_any_element(),
            div()
                .debug_selector({
                    let s = export_sel.clone();
                    move || s.clone()
                })
                .child(
                    CardAction::new(
                        ElementId::Name(export_sel.into()),
                        Icon::ArrowOut,
                        t(cx, mb::EXPORT_FILE),
                    )
                    .on_click(move |_, window, cx| {
                        window.dispatch_action(
                            Box::new(ExportModule {
                                module: export_id.clone(),
                            }),
                            cx,
                        );
                    }),
                )
                .into_any_element(),
        ])
        .section(vec![
            div()
                .debug_selector({
                    let s = delete_sel.clone();
                    move || s.clone()
                })
                .child(
                    CardAction::new(
                        ElementId::Name(delete_sel.into()),
                        Icon::Trash,
                        t(cx, keys::common::DELETE),
                    )
                    .danger()
                    .on_click(move |_, window, cx| {
                        delete_shelf
                            .update(cx, |s, cx| s.ask_delete_module(delete.clone(), window, cx));
                    }),
                )
                .into_any_element(),
        ]);
    card.into_any_element()
}

/// The question before deleting a module of mine for good (as a saved
/// template's): its title, 取消 and 删除.
pub(crate) fn render_delete_module_dialog(
    module: &ModuleSummary,
    busy: bool,
    error: Option<AnyElement>,
    close: impl Fn(&mut Window, &mut App) + Clone + 'static,
    cx: &mut Context<Shelf>,
) -> AnyElement {
    let entity = cx.entity();
    let cancel = {
        let close = close.clone();
        move |_: &ClickEvent, window: &mut Window, cx: &mut App| close(window, cx)
    };
    Dialog::new(
        "shelf-delete-module",
        tf(cx, mb::DELETE_TITLE, &[("name", &module.name)]),
    )
    .close_label(t(cx, keys::common::CLOSE))
    .when_some(error, |d, e| d.status(e))
    .action(
        div()
            .debug_selector(|| "shelf-delete-module-cancel".into())
            .child(
                Button::new("shelf-delete-module-cancel", t(cx, keys::common::CANCEL))
                    .disabled(busy)
                    .on_click(cancel),
            ),
    )
    .action(
        div()
            .debug_selector(|| "shelf-delete-module-confirm".into())
            .child(
                Button::new(
                    "shelf-delete-module-confirm",
                    if busy {
                        t(cx, keys::project_picker::delete::DELETING)
                    } else {
                        t(cx, keys::common::DELETE)
                    },
                )
                .danger()
                .icon(Icon::Trash)
                .busy(busy)
                .disabled(busy)
                .on_click(move |_, window, cx| {
                    entity.update(cx, |s, cx| s.confirm_delete_module(window, cx));
                }),
            ),
    )
    .on_close(close)
    .into_any_element()
}
