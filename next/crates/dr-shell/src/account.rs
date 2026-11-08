//! The account menu (the 0.1 client's user menu), shared by the bookshelf's
//! account cell (M01) and the left sidebar's: who (this build is local
//! only: 本地), then the theme, the language and Settings. It opens upward
//! from the cell that owns it; each owner keeps whether it is open.
//! 提交反馈 opens F7's feedback dialog (`SendFeedback`).

use std::rc::Rc;

use dr_i18n::{Locale, keys};
use dr_ui::{
    Theme,
    components::{
        Choice, Menu, MenuWidth, Segmented, Select,
        overlay::{self, Align, Layer, Place},
    },
    fonts::{Role, weight},
    glass::{self, Kind as GlassKind, Mode, Spec, Tone},
    sand::Icon,
    style::DrStyled,
    tokens::{Story, menu as m, radius},
};
use gpui::{
    AnyElement, App, Bounds, Div, InteractiveElement, IntoElement, ParentElement, Pixels,
    SharedString, StatefulInteractiveElement, Styled, Window, div, linear_color_stop,
    linear_gradient, px,
};

use crate::actions::OpenSettings;
use crate::settings::registry;
use crate::{Settings, t};

/// Closes the menu (its owner's flag).
pub type Close = Rc<dyn Fn(&mut Window, &mut App)>;

/// The account's round avatar: the first letter of its name on the
/// storylines' first and fifth colours.
pub fn avatar(size: f32, window: &Window, cx: &App) -> Div {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let initial: String = t(cx, keys::common::LOCAL)
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect())
        .unwrap_or_default();
    div()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .bg(linear_gradient(
            135.0,
            linear_color_stop(p.story(Story::S1).solid(), 0.0),
            linear_color_stop(p.story(Story::S5).solid(), 1.0),
        ))
        .flex()
        .items_center()
        .justify_center()
        .font_role(Role::Ui)
        .type_px(size * 0.47, size * 0.47)
        .weight(weight::MEDIUM)
        .italic()
        .text_color(p.paper.solid())
        .child(initial)
}

/// The account menu, floating up from `anchor` (the cell that opened it,
/// which toggles it itself: a press there does not close it here).
pub fn menu(
    id: &'static str,
    anchor: Option<Bounds<Pixels>>,
    close: Close,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let file = Settings::read(cx);
    let modes = ["light", "dark", "system"];
    let mode = file.str(registry::THEME).unwrap_or_else(|| "system".into());
    let mode_index = modes.iter().position(|m| *m == mode).unwrap_or(2);
    let theme_icon = match mode_index {
        0 => Icon::Enso,
        1 => Icon::InkDisc,
        _ => Icon::Taiji,
    };
    let locale = Settings::locale(cx);
    let locale_index = Locale::ALL.iter().position(|l| *l == locale).unwrap_or(0);
    let child = |name: &str| SharedString::from(format!("{id}-{name}"));
    let row = |icon: Icon, label: SharedString, tail: Option<AnyElement>| {
        div()
            .mx(px(m::ROW_INSET))
            .px(px(m::ROW_PAD_X))
            .min_h(px(s.menu_row))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(m::ICON_GAP))
            .font_role(Role::Ui)
            .type_px(s.menu_text, s.menu_line)
            .text_color(p.ink(1).solid())
            .child(dr_ui::sand::icon(icon, m::ICON, p.ink(2).solid()))
            .child(div().flex_1().child(label))
            .children(tail)
    };
    let header = div()
        .px(px(m::HOVER_CARD_PAD))
        .pt(px(10.0))
        .pb(px(8.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .child(avatar(32.0, window, cx))
        .child(
            div()
                .flex()
                .flex_col()
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.body, s.line_body)
                        .text_color(p.ink(1).solid())
                        .child(t(cx, keys::common::LOCAL)),
                )
                .child(
                    div()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.muted().solid())
                        .child(t(cx, keys::user_menu::LOCAL_STATUS)),
                ),
        );
    let themes = Segmented::new(
        child("theme"),
        [
            t(cx, keys::user_menu::THEME_LIGHT_SHORT),
            t(cx, keys::user_menu::THEME_DARK_SHORT),
            t(cx, keys::user_menu::THEME_SYSTEM_SHORT),
        ],
        mode_index,
    )
    .on_change(move |i, _, cx| {
        let value = modes[i.min(2)];
        Settings::update(cx, |f| f.set(registry::THEME, value.into(), None).ok());
    });
    let languages = Select::new(
        child("language"),
        Locale::ALL
            .iter()
            .map(|l| Choice::new(Icon::Wen, l.native_name()))
            .collect(),
        locale_index,
    )
    .on_change(|i, _, cx| {
        let code = Locale::ALL[i.min(Locale::ALL.len() - 1)].code();
        Settings::update(cx, |f| f.set(registry::UI_LOCALE, code.into(), None).ok());
    });
    let to_feedback = close.clone();
    let feedback = glass::glass_box(
        child("feedback"),
        GlassKind::Hidden,
        Mode::default(),
        false,
        Spec::new(Tone::Clear, radius::MENU_ROW),
        window,
        cx,
    )
    .cursor_pointer()
    .on_click(move |_, window, cx| {
        to_feedback(window, cx);
        window.dispatch_action(Box::new(crate::actions::SendFeedback), cx);
    })
    .child(row(Icon::Comment, t(cx, keys::user_menu::FEEDBACK), None));
    // Inside a book: 「导入」 Markdown, text and Word files into it (M41; the
    // 0.1 user menu's row).
    let import = (id == "workspace-account").then(|| {
        let to_import = close.clone();
        glass::glass_box(
            child("import"),
            GlassKind::Hidden,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, radius::MENU_ROW),
            window,
            cx,
        )
        .cursor_pointer()
        .on_click(move |_, window, cx| {
            to_import(window, cx);
            window.dispatch_action(Box::new(crate::actions::ImportDocuments), cx);
        })
        .child(row(
            Icon::CaseDew,
            t(cx, keys::user_menu::IMPORT),
            Some(
                div()
                    .flex_none()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.muted().solid())
                    .child("MD · DOCX · TXT")
                    .into_any_element(),
            ),
        ))
    });
    let to_settings = close.clone();
    let settings = glass::glass_box(
        child("settings"),
        GlassKind::Hidden,
        Mode::default(),
        false,
        Spec::new(Tone::Clear, radius::MENU_ROW),
        window,
        cx,
    )
    .cursor_pointer()
    .on_click(move |_, window, cx| {
        to_settings(window, cx);
        window.dispatch_action(Box::new(OpenSettings), cx);
    })
    .child(row(
        Icon::DharmaWheel,
        t(cx, keys::user_menu::SETTINGS),
        None,
    ));
    let menu = Menu::new(child("menu"))
        .width(MenuWidth::Wide)
        .child(header)
        .child(row(
            theme_icon,
            t(cx, keys::user_menu::THEME),
            Some(themes.into_any_element()),
        ))
        .child(row(
            Icon::Wen,
            t(cx, keys::user_menu::LANGUAGE),
            Some(
                div()
                    .w(px(150.0))
                    .flex_none()
                    .child(languages)
                    .into_any_element(),
            ),
        ))
        .children(import)
        .child(feedback)
        .child(settings);
    let place = match anchor {
        Some(rect) => Place::Rect {
            rect,
            align: Align::Start,
            gap: m::HOVER_CARD_GAP,
        },
        None => Place::Center,
    };
    overlay::float(
        place,
        Layer::Popover,
        div()
            .id(child("float"))
            .occlude()
            .on_mouse_down_out(move |e, window, cx| {
                // The cell that owns the menu toggles it itself.
                if anchor.is_some_and(|b| b.contains(&e.position)) {
                    return;
                }
                close(window, cx);
            })
            .child(menu),
    )
    .into_any_element()
}
