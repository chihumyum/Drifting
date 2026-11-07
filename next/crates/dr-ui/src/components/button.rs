//! Buttons (components.md, 「主按钮」「次按钮与文字按钮」「危险操作的按钮」
//! 「工作区级按钮」「面板与菜单里的图标按钮」).
//!
//! - [`Button`]: primary (the accent's selected glass at rest, accent ink,
//!   never a fill), secondary (a resting line), text (no glass; the pointer
//!   deepens the words) and danger (a resting line, words and icon in the
//!   danger colour).
//! - [`IconButton`]: round glass, one size (28px, a 16px brush icon). A
//!   resting line on its own, nothing at rest inside a tray, an opaque
//!   paper fill when it floats.
//! - [`PanelIconButton`]: the plain low-level button of a panel header: no
//!   glass, the pointer deepens the icon over a desk wash; a danger one
//!   (a book card's trash) turns the danger colour instead.

use std::rc::Rc;

use gpui::{
    App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement, RenderOnce,
    SharedString, StatefulInteractiveElement, Styled, Transformation, Window, div, percentage,
    prelude::FluentBuilder as _, px,
};

use crate::{
    anim,
    fonts::{Role, weight},
    glass::{self, Kind, Mode, Spec, Tone},
    sand::{self, Icon},
    style::DrStyled,
    theme::Theme,
    tokens::{glass as g, motion, radius},
};

pub type OnClick = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Variant {
    Primary,
    #[default]
    Secondary,
    Text,
    Danger,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Size {
    #[default]
    Regular,
    /// 4px lower, for a row (a version's restore, a relation card's delete).
    Small,
}

#[derive(IntoElement)]
pub struct Button {
    id: ElementId,
    label: SharedString,
    icon: Option<Icon>,
    variant: Variant,
    size: Size,
    disabled: bool,
    busy: bool,
    full_width: bool,
    on_click: Option<OnClick>,
}

impl Button {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Button {
        Button {
            id: id.into(),
            label: label.into(),
            icon: None,
            variant: Variant::Secondary,
            size: Size::Regular,
            disabled: false,
            busy: false,
            full_width: false,
            on_click: None,
        }
    }

    pub fn primary(mut self) -> Self {
        self.variant = Variant::Primary;
        self
    }

    pub fn text(mut self) -> Self {
        self.variant = Variant::Text;
        self
    }

    pub fn danger(mut self) -> Self {
        self.variant = Variant::Danger;
        self
    }

    pub fn variant(mut self, variant: Variant) -> Self {
        self.variant = variant;
        self
    }

    pub fn small(mut self) -> Self {
        self.size = Size::Small;
        self
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Running: the icon becomes the turning loader.
    pub fn busy(mut self, busy: bool) -> Self {
        self.busy = busy;
        self
    }

    pub fn full_width(mut self) -> Self {
        self.full_width = true;
        self
    }

    pub fn on_click(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(f));
        self
    }
}

/// The loader (缺角圆相) turning once in 0.9s.
pub fn spinner(size: f32, color: gpui::Hsla, window: &Window, reduce: bool) -> gpui::Svg {
    let turn = if reduce {
        0.0
    } else {
        window.request_animation_frame();
        let lap = motion::dwell::LOADING_LAP.as_secs_f32();
        (anim::now().elapsed_since_start() % lap) / lap
    };
    sand::icon(Icon::Loader, size, color)
        .with_transformation(Transformation::rotate(percentage(turn)))
}

/// Seconds since the process first asked, for looping animations.
trait SinceStart {
    fn elapsed_since_start(self) -> f32;
}

impl SinceStart for std::time::Instant {
    fn elapsed_since_start(self) -> f32 {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        self.saturating_duration_since(*START.get_or_init(std::time::Instant::now))
            .as_secs_f32()
    }
}

impl RenderOnce for Button {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let height = s.control_height
            - match self.size {
                Size::Regular => 0.0,
                Size::Small => 4.0,
            };
        let ink = match (self.variant, self.disabled) {
            (_, true) => p.muted().alpha(0.7),
            (Variant::Primary, _) => p.accent.solid(),
            (Variant::Danger, _) => p.danger.solid(),
            (Variant::Secondary, _) => p.ink(2).solid(),
            (Variant::Text, _) => p.ink(3).solid(),
        };
        let content = |el: gpui::Stateful<gpui::Div>, window: &Window| {
            let icon_size = 14.0;
            el.h(px(height))
                .px(px(if self.variant == Variant::Text {
                    6.0
                } else {
                    12.0
                }))
                .flex()
                .flex_row()
                .flex_none()
                .items_center()
                .justify_center()
                .gap(px(6.0))
                .rounded(px(radius::SM))
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .weight(weight::MEDIUM)
                .text_color(ink)
                .when(self.full_width, |el| el.w_full())
                .when(self.busy, |el| {
                    el.child(spinner(icon_size, ink, window, theme.reduce_motion))
                })
                .when_some(self.icon.filter(|_| !self.busy), |el, icon| {
                    el.child(sand::icon(icon, icon_size, ink))
                })
                .child(self.label.clone())
        };
        let interactive = !self.disabled;
        let el = if self.variant == Variant::Text {
            let deeper = p.ink(1).solid();
            content(div().id(self.id.clone()), window)
                .when(interactive, |el| el.hover(move |st| st.text_color(deeper)))
        } else {
            let tone = match (self.variant, self.disabled) {
                (_, true) => Tone::Clear,
                (Variant::Primary, _) => Tone::Accent,
                (Variant::Danger, _) => Tone::Danger,
                _ => Tone::Clear,
            };
            let mode = Mode {
                primary: self.variant == Variant::Primary,
                disabled: self.disabled,
                ..Mode::default()
            };
            let el = glass::glass_box(
                self.id.clone(),
                Kind::Rest,
                mode,
                false,
                Spec::new(tone, radius::SM),
                window,
                cx,
            );
            content(el, window)
        };
        el.role(gpui::Role::Button)
            .aria_label(self.label.clone())
            .when(interactive, |el| el.cursor_pointer())
            .when_some(self.on_click.filter(|_| interactive), |el, f| {
                el.on_click(move |e, w, cx| f(e, w, cx))
            })
    }
}

/// How a round button sits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Seat {
    /// On its own on the desk or a panel: a resting line.
    #[default]
    Alone,
    /// Inside a long pill (the paper's toolbar): nothing at rest.
    Tray,
    /// Floating over the page (a collapsed sidebar's toggle): an opaque
    /// paper fill under a resting line.
    Floating,
}

#[derive(IntoElement)]
pub struct IconButton {
    id: ElementId,
    icon: Icon,
    seat: Seat,
    selected: bool,
    disabled: bool,
    tone: Tone,
    label: Option<SharedString>,
    on_click: Option<OnClick>,
}

impl IconButton {
    pub fn new(id: impl Into<ElementId>, icon: Icon) -> IconButton {
        IconButton {
            id: id.into(),
            icon,
            seat: Seat::Alone,
            selected: false,
            disabled: false,
            tone: Tone::Clear,
            label: None,
            on_click: None,
        }
    }

    /// What the button does, in words, for screen readers (it is a button
    /// named `label` in the accessibility tree). Never drawn: a round
    /// button shows only its icon.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn seat(mut self, seat: Seat) -> Self {
        self.seat = seat;
        self
    }

    pub fn in_tray(self) -> Self {
        self.seat(Seat::Tray)
    }

    pub fn floating(self) -> Self {
        self.seat(Seat::Floating)
    }

    /// Open, locked, on: the selected glass, still.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The Agent composer's send and add are primary round buttons.
    pub fn tone(mut self, tone: Tone) -> Self {
        self.tone = tone;
        self
    }

    pub fn on_click(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for IconButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let kind = match self.seat {
            Seat::Tray => Kind::Hidden,
            _ => Kind::Rest,
        };
        let mode = Mode {
            disabled: self.disabled,
            primary: self.tone == Tone::Accent,
            ..Mode::default()
        };
        let mut spec = Spec::new(self.tone, g::ROUND / 2.0);
        if self.seat == Seat::Floating {
            spec = spec.filled(p.page);
        }
        let ink = if self.disabled {
            p.ink(4).solid()
        } else if self.tone == Tone::Accent {
            p.accent.solid()
        } else if self.selected {
            p.ink(2).solid()
        } else {
            p.ink(3).solid()
        };
        let interactive = !self.disabled;
        glass::glass_box(self.id, kind, mode, self.selected, spec, window, cx)
            .size(px(g::ROUND))
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .rounded_full()
            .when(self.seat == Seat::Floating, |el| el.bg(p.page.solid()))
            .child(sand::icon(self.icon, g::ROUND_ICON, ink))
            .when_some(self.label, |el, label| {
                el.role(gpui::Role::Button).aria_label(label)
            })
            .when(interactive, |el| el.cursor_pointer())
            .when_some(self.on_click.filter(|_| interactive), |el, f| {
                el.on_click(move |e, w, cx| f(e, w, cx))
            })
    }
}

#[derive(IntoElement)]
pub struct PanelIconButton {
    id: ElementId,
    icon: Icon,
    accent: bool,
    danger: bool,
    label: Option<SharedString>,
    on_click: Option<OnClick>,
}

impl PanelIconButton {
    pub fn new(id: impl Into<ElementId>, icon: Icon) -> PanelIconButton {
        PanelIconButton {
            id: id.into(),
            icon,
            accent: false,
            danger: false,
            label: None,
            on_click: None,
        }
    }

    /// What the button does, for screen readers; never drawn.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// A panel header's “new” keeps the accent's ink.
    pub fn accent(mut self) -> Self {
        self.accent = true;
        self
    }

    /// Something that cannot be taken back (a book card's trash): at rest
    /// like the others, the danger's ink and a wash of it under the pointer.
    pub fn danger(mut self) -> Self {
        self.danger = true;
        self
    }

    pub fn on_click(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for PanelIconButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let rest = if self.accent { p.accent } else { p.ink(3) };
        let (deep, wash) = if self.danger {
            (p.danger, p.danger.alpha(0.1))
        } else if self.accent {
            (p.accent, p.ink(1).alpha(0.05))
        } else {
            (p.ink(1), p.ink(1).alpha(0.05))
        };
        let icon = self.icon;
        let id = self.id.clone();
        let group = SharedString::from(format!("panel-icon-{id:?}"));
        div()
            .id(self.id)
            .size(px(24.0))
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .rounded(px(radius::SM))
            .cursor_pointer()
            .hover(move |st| st.bg(wash))
            .group(group.clone())
            .child(
                // The icon's colour is settled when it paints, so the
                // pointer's deepening reaches it (an icon built in the
                // parent's colour would keep the colour it was built with).
                sand::icon(icon, 16.0, rest.solid())
                    .group_hover(group, move |st| st.text_color(deep.solid())),
            )
            .when_some(self.label, |el, label| {
                el.role(gpui::Role::Button).aria_label(label)
            })
            .when_some(self.on_click, |el, f| {
                el.on_click(move |e, w, cx| f(e, w, cx))
            })
    }
}
