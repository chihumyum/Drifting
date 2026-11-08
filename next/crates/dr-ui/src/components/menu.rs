//! Menus (interaction.md, 「Menu surfaces」).
//!
//! A menu floats off the desk: the desk's opaque colour, a 16px corner, a
//! resting line of glass for an edge (the renderer's pre-tinted ring under
//! the fill) and the floating shadow; no hairline. Widths are 240 (one
//! column of actions), 320 (menus that hold more) and 420 (settings
//! panels). Every row starts with an icon — a 16px brush icon or the mark of
//! the thing the row makes — and one menu never mixes rows with and without
//! icons: [`MenuItem`] cannot be built without one. Rows are not filled:
//! under the pointer a row's own outline becomes a hairline of flowing
//! glass; its words keep their colour. Groups are parted by a 0.5px
//! hairline. There are no custom context menus.

use std::rc::Rc;

use gpui::{
    AnyElement, App, BoxShadow, ClickEvent, ElementId, Hsla, InteractiveElement, IntoElement,
    ParentElement, RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, canvas,
    div, point, prelude::FluentBuilder as _, px,
};

use crate::{
    fonts::{Role, weight},
    glass::{self, Ground, Kind, Mode, SLAB_ORIGIN, Spec, Tone},
    sand::{self, Icon, KindMark},
    style::DrStyled,
    theme::Theme,
    tokens::{Palette, Rgb, menu as m, radius},
};

use super::button::OnClick;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MenuWidth {
    #[default]
    Standard,
    Wide,
    Settings,
}

impl MenuWidth {
    pub const fn px(self) -> f32 {
        match self {
            MenuWidth::Standard => m::WIDTH_STANDARD,
            MenuWidth::Wide => m::WIDTH_WIDE,
            MenuWidth::Settings => m::WIDTH_SETTINGS,
        }
    }
}

/// What a row starts with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RowIcon {
    Brush(Icon),
    /// The mark of the thing the row makes or names.
    Mark(sand::Kind, Option<Rgb>),
}

impl From<Icon> for RowIcon {
    fn from(icon: Icon) -> RowIcon {
        RowIcon::Brush(icon)
    }
}

#[derive(IntoElement)]
pub struct MenuItem {
    id: ElementId,
    icon: RowIcon,
    label: SharedString,
    danger: bool,
    checked: bool,
    current: bool,
    disabled: bool,
    trailing: Option<SharedString>,
    on_click: Option<OnClick>,
}

impl MenuItem {
    pub fn new(
        id: impl Into<ElementId>,
        icon: impl Into<RowIcon>,
        label: impl Into<SharedString>,
    ) -> MenuItem {
        MenuItem {
            id: id.into(),
            icon: icon.into(),
            label: label.into(),
            danger: false,
            checked: false,
            current: false,
            disabled: false,
            trailing: None,
            on_click: None,
        }
    }

    /// Delete and the like: the danger colour's words and ring.
    pub fn danger(mut self) -> Self {
        self.danger = true;
        self
    }

    /// The current choice of a single-choice group: deeper words and a tick.
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }

    /// The row the keyboard is on: the ring, still.
    pub fn current(mut self, current: bool) -> Self {
        self.current = current;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// A faint word at the row's end (a kind, a shortcut).
    pub fn trailing(mut self, text: impl Into<SharedString>) -> Self {
        self.trailing = Some(text.into());
        self
    }

    pub fn on_click(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(f));
        self
    }
}

pub(crate) fn row_icon(icon: RowIcon, id: &ElementId, ink: Hsla) -> AnyElement {
    match icon {
        RowIcon::Brush(icon) => sand::icon(icon, m::ICON, ink).into_any_element(),
        RowIcon::Mark(kind, color) => {
            let mark = KindMark::new(crate::style::child_id(&id.clone(), "mark"), kind)
                .scale(m::ICON / sand::MARK_SLOT);
            match color {
                Some(c) => mark.color(c),
                None => mark,
            }
            .into_any_element()
        }
    }
}

impl RenderOnce for MenuItem {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let ink = if self.disabled {
            p.ink(4)
        } else if self.danger {
            p.danger
        } else if self.checked {
            p.ink(1)
        } else {
            p.ink(2)
        };
        let tone = if self.danger {
            Tone::Danger
        } else {
            Tone::Clear
        };
        let interactive = !self.disabled;
        let id = self.id.clone();
        let label = self.label.clone();
        glass::glass_box(
            self.id,
            Kind::Hidden,
            Mode {
                disabled: self.disabled,
                ..Mode::default()
            },
            self.current,
            Spec::new(tone, radius::MENU_ROW).rim(3.0),
            window,
            cx,
        )
        .mx(px(m::ROW_INSET))
        .min_h(px(s.menu_row))
        .px(px(m::ROW_PAD_X))
        .py(px(m::ROW_PAD_Y))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(m::ICON_GAP))
        .rounded(px(radius::MENU_ROW))
        .font_role(Role::Ui)
        .type_px(s.menu_text, s.menu_line)
        .text_color(ink.solid())
        .when(self.checked, |el| el.weight(weight::MEDIUM))
        .child(row_icon(self.icon, &id, ink.solid()))
        .child(div().flex_1().min_w_0().child(self.label))
        .when_some(self.trailing, |el, t| {
            el.child(
                div()
                    .flex_none()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(3).solid())
                    .child(t),
            )
        })
        .when(self.checked, |el| {
            el.child(sand::icon(Icon::Check, m::ICON, ink.solid()))
        })
        .when(interactive, |el| el.cursor_pointer())
        // In the accessibility tree by its words (VoiceOver, and the debug
        // bridge's `ui.press`).
        .role(gpui::Role::MenuItem)
        .aria_label(label)
        .when_some(self.on_click.filter(|_| interactive), |el, f| {
            el.on_click(move |e, w, cx| f(e, w, cx))
        })
    }
}

/// A hairline between groups.
pub fn separator(p: &Palette) -> impl IntoElement + use<> {
    div()
        .mx(px(m::SEPARATOR_INSET))
        .my(px(m::SEPARATOR_MARGIN))
        .h(px(m::SEPARATOR))
        .bg(p.hairline())
}

/// A group's name: 12px (plus the step), medium, faint, never upper-cased.
pub fn section_label(label: impl Into<SharedString>, theme: &Theme) -> impl IntoElement {
    div()
        .px(px(m::ROW_INSET + m::ROW_PAD_X))
        .pt(px(4.0))
        .pb(px(2.0))
        .font_role(Role::Ui)
        .type_px(theme.scale.caption - 2.0, theme.scale.line_caption)
        .weight(weight::MEDIUM)
        .text_color(theme.palette.ink(3).solid())
        .child(label.into())
}

/// The floating shadow of menus, hover cards and dialogs (`--menu-shadow`).
pub fn float_shadow(p: &Palette) -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: p.shadow_ink.alpha(p.menu_shadow),
        offset: point(px(0.0), px(16.0)),
        blur_radius: px(15.0),
        spread_radius: px(-16.0),
        inset: false,
    }]
}

/// The resting glass edge of a menu or hover card, painted as its own
/// background: the ring texture under the desk fill inset 1px.
pub fn slab_edge(p: &'static Palette, radius: f32) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            glass::paint_slab(bounds, radius, p.desk, p.dark, SLAB_ORIGIN, window);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// A menu surface holding `children` (rows, separators, labels or anything
/// richer). Place it in a [`crate::components::overlay::float`] to float it.
#[derive(IntoElement)]
pub struct Menu {
    id: ElementId,
    width: MenuWidth,
    width_px: Option<f32>,
    children: Vec<AnyElement>,
}

impl Menu {
    pub fn new(id: impl Into<ElementId>) -> Menu {
        Menu {
            id: id.into(),
            width: MenuWidth::Standard,
            width_px: None,
            children: Vec::new(),
        }
    }

    pub fn width(mut self, width: MenuWidth) -> Self {
        self.width = width;
        self
    }

    /// A select's list is as wide as its trigger, never narrower than 240.
    pub fn at_least(mut self, width: f32) -> Self {
        self.width_px = Some(width.max(m::WIDTH_STANDARD));
        self
    }

    pub fn item(mut self, item: MenuItem) -> Self {
        self.children.push(item.into_any_element());
        self
    }

    pub fn separator(mut self, theme: &Theme) -> Self {
        self.children
            .push(separator(theme.palette).into_any_element());
        self
    }

    pub fn section(mut self, label: impl Into<SharedString>, theme: &Theme) -> Self {
        self.children
            .push(section_label(label, theme).into_any_element());
        self
    }
}

impl ParentElement for Menu {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for Menu {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let w = self.width_px.unwrap_or(self.width.px());
        glass::surface(
            Ground::flat(p.desk),
            div()
                .id(self.id)
                .relative()
                .w(px(w))
                .rounded(px(radius::SHEET))
                .shadow(float_shadow(p))
                .occlude()
                .child(slab_edge(p, radius::SHEET))
                .child(
                    div()
                        .relative()
                        .py(px(m::PAD_Y))
                        .flex()
                        .flex_col()
                        .children(self.children),
                ),
        )
    }
}
