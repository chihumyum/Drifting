//! The account menu (the 0.1 client's user menu), shared by the bookshelf's
//! account cell (M01) and the left sidebar's: who (`本地` in local mode, or the
//! signed-in Hosted user's display name and avatar in M35), then the theme,
//! the language, feedback, and Settings (plus sign-in / sign-out when Hosted
//! is configured). It opens upward from the cell that owns it; each owner
//! keeps whether it is open.
//! 提交反馈 opens F7's feedback dialog (`SendFeedback`).

use std::rc::Rc;
use std::sync::Arc;

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
    AnyElement, App, Bounds, Div, Global, ImageSource, InteractiveElement, IntoElement, ObjectFit,
    ParentElement, Pixels, RenderImage, SharedString, StatefulInteractiveElement, Styled,
    StyledImage, Window, div, img, linear_color_stop, linear_gradient, prelude::FluentBuilder as _,
    px,
};

use crate::actions::OpenSettings;
use crate::settings::registry;
use crate::{Settings, t};

/// Closes the menu (its owner's flag).
pub type Close = Rc<dyn Fn(&mut Window, &mut App)>;

/// Optional action row contributed by `dr-view-account` at the bottom of the account menu.
#[derive(Clone)]
pub struct AccountMenuAction {
    pub label: SharedString,
    pub disabled: bool,
    pub on_click: Rc<dyn Fn(&mut Window, &mut App)>,
}

/// Snapshot of the current account presentation contributed by `dr-view-account`.
#[derive(Clone, Default)]
pub struct AccountViewInfo {
    pub signed_in: bool,
    pub hosted_configured: bool,
    pub display_name: Option<SharedString>,
    pub status_line: Option<SharedString>,
    pub avatar: Option<Arc<RenderImage>>,
    pub on_header_click: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
    pub action: Option<AccountMenuAction>,
}

type AccountHookFn = Rc<dyn Fn(&App) -> AccountViewInfo>;
type AuthLinkFn = Rc<dyn Fn(&str, &mut Window, &mut App)>;

struct AccountHook(AccountHookFn);

impl Global for AccountHook {}

struct AuthLinkHook(AuthLinkFn);

impl Global for AuthLinkHook {}

/// Registers the Hosted account hook (`dr-view-account`).
pub fn set_hook(cx: &mut App, hook: impl Fn(&App) -> AccountViewInfo + 'static) {
    cx.set_global(AccountHook(Rc::new(hook)));
}

/// Registers the `auth/` deep-link handler (`dr-view-account`).
pub fn set_auth_link_handler(
    cx: &mut App,
    handler: impl Fn(&str, &mut Window, &mut App) + 'static,
) {
    cx.set_global(AuthLinkHook(Rc::new(handler)));
}

pub(crate) fn handle_auth_link(url: &str, window: &mut Window, cx: &mut App) {
    if let Some(h) = cx.try_global::<AuthLinkHook>().map(|h| h.0.clone()) {
        h(url, window, cx);
    }
}

fn current_info(cx: &App) -> AccountViewInfo {
    cx.try_global::<AccountHook>()
        .map(|h| (h.0)(cx))
        .unwrap_or_default()
}

/// Display name shown in the sidebar and shelf account cell (`本地` when signed out).
pub fn display_name(cx: &App) -> SharedString {
    current_info(cx)
        .display_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| t(cx, keys::common::LOCAL))
}

/// Accessible label for the account cell button (`账号菜单` when signed in, else `本地书库菜单`).
pub fn menu_aria_label(cx: &App) -> SharedString {
    if current_info(cx).signed_in {
        t(cx, keys::user_menu::ACCOUNT_MENU)
    } else {
        t(cx, keys::user_menu::LOCAL_MENU)
    }
}

/// The account's round avatar: either the user's cropped 256×256 JPEG avatar
/// or the first letter of its display name on the storylines' first and fifth colours.
pub fn avatar(size: f32, window: &Window, cx: &App) -> Div {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let info = current_info(cx);
    if let Some(render_img) = info.avatar {
        return div()
            .flex_none()
            .size(px(size))
            .rounded_full()
            .overflow_hidden()
            .child(
                img(ImageSource::Render(render_img))
                    .size(px(size))
                    .rounded_full()
                    .object_fit(ObjectFit::Cover),
            );
    }
    let name = info
        .display_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| t(cx, keys::common::LOCAL));
    let initial: String = name
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
    let info = current_info(cx);
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
    let header_name = info
        .display_name
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| t(cx, keys::common::LOCAL));
    let header_status = info
        .status_line
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| t(cx, keys::user_menu::LOCAL_STATUS));
    let header_close = close.clone();
    let header = div()
        .id(child("header"))
        .px(px(m::HOVER_CARD_PAD))
        .pt(px(10.0))
        .pb(px(8.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .when_some(info.on_header_click.clone(), |el, on_click| {
            el.cursor_pointer().on_click(move |_, window, cx| {
                header_close(window, cx);
                on_click(window, cx);
            })
        })
        .child(avatar(32.0, window, cx))
        .child(
            div()
                .min_w_0()
                .flex_1()
                .flex()
                .flex_col()
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.body, s.line_body)
                        .text_color(p.ink(1).solid())
                        .truncate()
                        .child(header_name),
                )
                .child(
                    div()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.muted().solid())
                        .truncate()
                        .child(header_status),
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
    let account_action = info.action.map(|act| {
        let to_act = close.clone();
        let on_click = act.on_click.clone();
        let disabled = act.disabled;
        glass::glass_box(
            child("account-action"),
            GlassKind::Hidden,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, radius::MENU_ROW),
            window,
            cx,
        )
        .when(!disabled, |el| {
            el.cursor_pointer().on_click(move |_, window, cx| {
                to_act(window, cx);
                on_click(window, cx);
            })
        })
        .child(row(Icon::Torii, act.label, None))
    });
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
        .child(settings)
        .children(account_action);
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
