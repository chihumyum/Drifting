//! Lower-left paper sync status mark, hover card, bell danger seal, and
//! scheduling hooks between the shell and the app's Hosted Sync runtime
//! (`docs/hosted-sync/sync-status.md`, `docs/design-system/components.md`).

use std::f32::consts::TAU;
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dr_ui::{
    Theme,
    anim::{self, Tween},
    components::{
        menu::{float_shadow, slab_edge},
        overlay::{self, Align, Layer, Place},
    },
    fonts::{Role, weight},
    glass::{self, Ground, Kind as GlassKind, Mode, Spec, Tone},
    sand::{self, Icon},
    style::DrStyled,
    tokens::{Easing, Palette, glass as g, menu as m, motion, radius, space},
};
use futures::future::LocalBoxFuture;
use gpui::{
    AnyElement, App, ElementId, Global, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement as _, Styled, Task, Window, div, px,
};

use crate::workspace::{Workspace, corner::CORNER_INSET};

/// Dwell delay before opening the sync status hover card (`components.md`).
pub const HOVER_CARD_DWELL: Duration = Duration::from_millis(220);

/// Grace period keeping the hover card open while moving across the gap into it.
const HOVER_CARD_CLOSE_GRACE: Duration = Duration::from_millis(140);

/// Breathing period for active transfers (`1.8s` cosine cycle).
pub const BREATH_PERIOD_SECS: f32 = 1.8;

/// Slow-blink period for automatic background retries (`2.4s` cosine cycle).
pub const BLINK_PERIOD_SECS: f32 = 2.4;

/// Quiet window after the last keystroke before a faded `Syncing` mark returns (`2s`).
pub const TYPING_SETTLE: Duration = Duration::from_millis(2_020);

/// Visual state of the lower-left paper sync mark.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MarkVisual {
    #[default]
    Hidden,
    BreathingCloud,
    BlinkingCloud,
    LooseSandCloud,
    DangerExclamation,
}

/// Click handler for a sync hover-card action row.
pub type MarkActionCallback = Rc<dyn Fn(&mut Window, &mut App)>;

/// One action button at the foot of the sync hover card (`Retry`, `Sign in`, `Open Settings`).
#[derive(Clone)]
pub struct MarkAction {
    pub id: &'static str,
    pub icon: Icon,
    pub label: SharedString,
    pub run: MarkActionCallback,
}

/// Presentation of the paper corner mark and its hover card for the current frame.
#[derive(Clone)]
pub struct MarkSpec {
    pub visual: MarkVisual,
    pub faded_for_typing: bool,
    pub title: SharedString,
    pub detail: SharedString,
    pub meta: Option<SharedString>,
    pub progress: Option<f32>,
    pub actions: Vec<MarkAction>,
}

type MarkHookFn = Rc<dyn Fn(Option<&str>, bool, Option<u64>, u64, &App) -> Option<MarkSpec>>;
type BeforeAccountActionFn = Rc<dyn Fn(&mut App) -> Option<LocalBoxFuture<'static, ()>>>;
type HolderReleasedFn = Rc<dyn Fn(&mut App)>;

struct MarkHook(MarkHookFn);
impl Global for MarkHook {}

struct BeforeAccountActionHook(BeforeAccountActionFn);
impl Global for BeforeAccountActionHook {}

struct HolderReleasedHook(HolderReleasedFn);
impl Global for HolderReleasedHook {}

/// Registers the evaluator that maps the open book and typing state to a [`MarkSpec`].
pub fn set_mark_hook(
    cx: &mut App,
    hook: impl Fn(Option<&str>, bool, Option<u64>, u64, &App) -> Option<MarkSpec> + 'static,
) {
    cx.set_global(MarkHook(Rc::new(hook)));
}

/// Registers an optional async drain that runs before signing out (from the
/// sidebar account menu or Settings › Account) while the session token is still valid.
pub fn set_before_account_action(
    cx: &mut App,
    hook: impl Fn(&mut App) -> Option<LocalBoxFuture<'static, ()>> + 'static,
) {
    cx.set_global(BeforeAccountActionHook(Rc::new(hook)));
}

/// Registers a callback invoked when open editors or the active book release their holders.
pub fn set_holder_released_hook(cx: &mut App, hook: impl Fn(&mut App) + 'static) {
    cx.set_global(HolderReleasedHook(Rc::new(hook)));
}

/// Current wall-clock timestamp in Unix milliseconds.
#[must_use]
pub fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn notify_holder_released(cx: &mut App) {
    if let Some(hook) = cx.try_global::<HolderReleasedHook>().map(|h| h.0.clone()) {
        hook(cx);
    }
}

/// Invokes the registered pre-sign-out drain hook (if any) while the current
/// bearer token is still valid, returning a future that resolves once pending
/// outbound sync uploads have settled best-effort.
pub fn run_before_sign_out(cx: &mut App) -> Option<LocalBoxFuture<'static, ()>> {
    cx.try_global::<BeforeAccountActionHook>()
        .map(|h| h.0.clone())
        .and_then(|h| h(cx))
}

/// Evaluates the registered [`MarkHook`] directly (for tests and inspection).
#[must_use]
pub fn evaluate_mark(
    book_id: Option<&str>,
    is_trailing_pane: bool,
    last_typing_ms: Option<u64>,
    now_ms: u64,
    cx: &App,
) -> Option<MarkSpec> {
    cx.try_global::<MarkHook>()
        .and_then(|h| (h.0)(book_id, is_trailing_pane, last_typing_ms, now_ms, cx))
}

/// Small danger seal worn by the notification bell while any severe sync notice is pinned.
pub fn bell_danger_seal(p: Palette) -> AnyElement {
    div()
        .id("notifications-danger-seal")
        .absolute()
        .top(px(1.0))
        .right(px(1.0))
        .size(px(11.0))
        .rounded_full()
        .bg(p.desk.solid())
        .flex()
        .items_center()
        .justify_center()
        .child(sand::icon(Icon::StatusWarning, 10.0, p.danger.solid()))
        .into_any_element()
}

struct MarkPresence {
    level: Tween,
    visual: MarkVisual,
    epoch: Instant,
}

impl MarkPresence {
    fn new() -> Self {
        Self {
            level: Tween::still(0.0),
            visual: MarkVisual::Hidden,
            epoch: anim::now(),
        }
    }

    fn update_target(&mut self, next: MarkVisual, visible: bool, reduce_motion: bool) {
        let at = anim::now();
        if next != MarkVisual::Hidden {
            self.visual = next;
        }
        let target = if visible && next != MarkVisual::Hidden {
            1.0
        } else {
            0.0
        };
        let dur = if reduce_motion {
            Duration::ZERO
        } else {
            motion::sand::FADE
        };
        self.level.retarget(target, at, dur, Easing::EASE_OUT);
        if self.level.settled(at) && target == 0.0 {
            self.visual = MarkVisual::Hidden;
        }
    }
}

#[derive(Default)]
struct HoverState {
    mark_hovered: bool,
    card_hovered: bool,
    open: bool,
    dwell_task: Option<Task<()>>,
    close_task: Option<Task<()>>,
}

/// Renders the lower-left paper sync mark (`left: 16px, bottom: 16px`) on the
/// leading paper pane (`is_trailing_pane == false`).
pub fn paper_corner(
    ws: &Workspace,
    pane_key: &'static str,
    is_trailing_pane: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    if is_trailing_pane {
        return div()
            .id("paper-sync-mark-trailing-hidden")
            .into_any_element();
    }

    let now_ms = current_time_ms();
    let book_id = (!ws.book_id.is_empty()).then_some(ws.book_id.as_str());
    let spec = evaluate_mark(book_id, false, ws.last_typing_ms, now_ms, cx);

    let theme = Theme::of(window, cx);
    let p = theme.palette;

    let (next_visual, want_visible) = match &spec {
        Some(sp) if sp.visual != MarkVisual::Hidden => (sp.visual, !sp.faded_for_typing),
        _ => (MarkVisual::Hidden, false),
    };

    let presence_entity = window.use_keyed_state(
        ElementId::Name(format!("paper-sync-presence-{pane_key}").into()),
        cx,
        |_, _| MarkPresence::new(),
    );
    let (fade_alpha, active_visual, settled, elapsed_secs) = presence_entity.update(cx, |st, _| {
        st.update_target(next_visual, want_visible, theme.reduce_motion);
        let at = anim::now();
        (
            st.level.value(at),
            st.visual,
            st.level.settled(at),
            at.saturating_duration_since(st.epoch).as_secs_f32(),
        )
    });
    anim::keep_going(!settled, window);

    let hover_entity = window.use_keyed_state(
        ElementId::Name(format!("paper-sync-hover-{pane_key}").into()),
        cx,
        |_, _| HoverState::default(),
    );
    if !want_visible || active_visual == MarkVisual::Hidden {
        hover_entity.update(cx, |h, _| {
            h.mark_hovered = false;
            h.card_hovered = false;
            h.open = false;
            h.dwell_task = None;
            h.close_task = None;
        });
    }

    if fade_alpha <= 0.004 || active_visual == MarkVisual::Hidden {
        return div().id("paper-sync-mark-hidden").into_any_element();
    }

    let animate_periodic = want_visible && !ws.immersive && !theme.reduce_motion;
    let (icon_el, wave_alpha) = match active_visual {
        MarkVisual::Hidden => return div().id("paper-sync-mark-hidden").into_any_element(),
        MarkVisual::BreathingCloud => {
            let w = if animate_periodic {
                anim::keep_going_within(anim::SLOW_FRAME, window, cx);
                let phase = (elapsed_secs / BREATH_PERIOD_SECS) * TAU;
                0.42 + 0.50 * (0.5 - 0.5 * phase.cos())
            } else {
                0.78
            };
            (
                sand::icon(Icon::Cloud, 16.0, p.muted().solid()).into_any_element(),
                w,
            )
        }
        MarkVisual::BlinkingCloud => {
            let w = if animate_periodic {
                anim::keep_going_within(anim::SLOW_FRAME, window, cx);
                let phase = (elapsed_secs / BLINK_PERIOD_SECS) * TAU;
                0.25 + 0.70 * (0.5 + 0.5 * phase.cos())
            } else {
                0.85
            };
            (
                sand::icon(Icon::Cloud, 16.0, p.ink(2).solid()).into_any_element(),
                w,
            )
        }
        MarkVisual::LooseSandCloud => (
            sand::icon(Icon::Cloud, 16.0, p.muted().alpha(0.52)).into_any_element(),
            1.0,
        ),
        MarkVisual::DangerExclamation => (
            sand::icon(Icon::StatusWarning, 16.0, p.danger.solid()).into_any_element(),
            1.0,
        ),
    };

    let mark_bounds = overlay::use_bounds(
        ElementId::Name(format!("paper-sync-bounds-{pane_key}").into()),
        window,
        cx,
    );
    let card_open = hover_entity.read(cx).open && want_visible;
    let hover_for_mark = hover_entity.clone();

    let popover = match (card_open, &spec, *mark_bounds.read(cx)) {
        (true, Some(spec), Some(bounds)) => Some(render_hover_card(
            pane_key,
            spec,
            bounds,
            hover_entity,
            &theme,
            window,
            cx,
        )),
        _ => None,
    };

    div()
        .id("paper-sync-mark")
        .absolute()
        .left(px(CORNER_INSET))
        .bottom(px(CORNER_INSET))
        .size(px(g::ROUND))
        .flex()
        .items_center()
        .justify_center()
        .cursor_default()
        .opacity((fade_alpha * wave_alpha).clamp(0.0, 1.0))
        .on_hover(move |hovered, window, cx| {
            let hover_inner = hover_for_mark.clone();
            hover_for_mark.update(cx, |h, cx| {
                h.mark_hovered = *hovered;
                if *hovered {
                    h.close_task = None;
                    if !h.open && h.dwell_task.is_none() {
                        let target = hover_inner.clone();
                        h.dwell_task = Some(window.spawn(cx, async move |cx| {
                            cx.background_executor().timer(HOVER_CARD_DWELL).await;
                            cx.update(|window, cx| {
                                target.update(cx, |st, cx| {
                                    st.dwell_task = None;
                                    if st.mark_hovered {
                                        st.open = true;
                                        cx.notify();
                                        window.refresh();
                                    }
                                });
                            })
                            .ok();
                        }));
                    }
                } else {
                    h.dwell_task = None;
                    schedule_card_close(h, hover_inner, window, cx);
                }
            });
        })
        .child(overlay::probe(mark_bounds))
        .child(icon_el)
        .children(popover)
        .into_any_element()
}

fn schedule_card_close(
    h: &mut HoverState,
    entity: gpui::Entity<HoverState>,
    window: &mut Window,
    cx: &mut App,
) {
    if !h.open {
        return;
    }
    h.close_task = Some(window.spawn(cx, async move |cx| {
        cx.background_executor().timer(HOVER_CARD_CLOSE_GRACE).await;
        cx.update(|window, cx| {
            entity.update(cx, |st, cx| {
                st.close_task = None;
                if !st.mark_hovered && !st.card_hovered {
                    st.open = false;
                    cx.notify();
                    window.refresh();
                }
            });
        })
        .ok();
    }));
}

fn render_hover_card(
    pane_key: &'static str,
    spec: &MarkSpec,
    bounds: gpui::Bounds<gpui::Pixels>,
    hover_entity: gpui::Entity<HoverState>,
    theme: &Theme,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let p = theme.palette;
    let s = theme.scale;
    let hover_for_card = hover_entity.clone();

    let mut body = div()
        .px(px(m::HOVER_CARD_PAD))
        .pt(px(10.0))
        .pb(px(if spec.actions.is_empty() { 10.0 } else { 6.0 }))
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(
            div()
                .font_role(Role::Structure)
                .type_px(s.secondary, s.line_body)
                .weight(weight::MEDIUM)
                .text_color(p.ink(1).solid())
                .child(spec.title.clone()),
        )
        .child(
            div()
                .font_role(Role::Ui)
                .type_px(s.caption, s.line_caption)
                .text_color(p.ink(2).solid())
                .child(dr_ui::text::wrapped(spec.detail.clone())),
        );

    if let Some(meta) = &spec.meta {
        body = body.child(
            div()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.muted().solid())
                .child(meta.clone()),
        );
    }

    if let Some(progress) = spec.progress {
        body = body.child(
            div().pt(px(2.0)).w_full().child(
                sand::Readout::new(
                    ElementId::Name(format!("paper-sync-readout-{pane_key}").into()),
                    progress.clamp(0.0, 1.0),
                )
                .color(p.ink(2)),
            ),
        );
    }

    let mut actions_col = div().flex().flex_col().pb(px(m::PAD_Y));
    for act in &spec.actions {
        let run = act.run.clone();
        let close_hover = hover_entity.clone();
        let row_id = SharedString::from(format!("paper-sync-action-{}-{}", pane_key, act.id));
        let row = glass::glass_box(
            row_id,
            GlassKind::Hidden,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, radius::MENU_ROW),
            window,
            cx,
        )
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
        .cursor_pointer()
        .on_click(move |_, window, cx| {
            close_hover.update(cx, |st, _| {
                st.open = false;
                st.mark_hovered = false;
                st.card_hovered = false;
            });
            run(window, cx);
        })
        .child(sand::icon(act.icon, m::ICON, p.ink(2).solid()))
        .child(div().flex_1().child(act.label.clone()));
        actions_col = actions_col.child(row);
    }

    let mut card = div()
        .id("paper-sync-hover-card")
        .occlude()
        .relative()
        .w(px(248.0))
        .rounded(px(radius::SHEET))
        .bg(p.desk.solid())
        .shadow(float_shadow(p))
        .on_hover(move |hovered, window, cx| {
            let target = hover_for_card.clone();
            hover_for_card.update(cx, |h, cx| {
                h.card_hovered = *hovered;
                if *hovered {
                    h.close_task = None;
                } else {
                    schedule_card_close(h, target, window, cx);
                }
            });
        })
        .child(slab_edge(p, radius::SHEET))
        .child(body);

    if !spec.actions.is_empty() {
        card = card
            .child(
                div()
                    .mx(px(space::S3))
                    .my(px(2.0))
                    .h(px(0.5))
                    .bg(p.subtle_hairline()),
            )
            .child(actions_col);
    }

    overlay::float(
        Place::Rect {
            rect: bounds,
            align: Align::Center,
            gap: m::HOVER_CARD_GAP,
        },
        Layer::Popover,
        glass::surface(Ground::flat(p.desk), card),
    )
    .into_any_element()
}
