//! Immersive writing in the shell (M26; m26-immersive.md, 「给 F6 的接口」):
//! only the paper (素纸), the caret's paragraph clear (段, the editor's).
//!
//! - **In and out**: the incense stick at the toolbar's right, ⌘⇧↩, Esc;
//!   and typing (F4's `WritingTyped`, only what the author types) when
//!   「打字时自动沉浸」 is on. Every open editor runs its typewriter line
//!   while immersed (`set_immersive`, kept in step each frame).
//! - **Typed in**: a press anywhere in the window but the paper and the
//!   exit leaves (the press itself lands as usual); entered by hand, it
//!   does not. Opening a Super View or the bookshelf leaves either way.
//! - **Reveal**: within 56 px of the top the traffic lights and the tab
//!   dots come back (the dots work); a key without modifiers, or the
//!   pointer leaving the window, puts them away again. The exit at the
//!   paper's bottom right comes out within reach of the pointer, with the
//!   words written since entering (`+N`, today's net words of the book on
//!   this device, as the left sidebar's 今日) and today's sand stroke toward
//!   the daily goal.
//! - **Traffic lights** (macOS): their alpha goes to 0 while immersed; the
//!   title bar's frames are put back in the same turn (AppKit lays it out
//!   again when the alpha changes, [`super::chrome::set_traffic_lights_hidden`]).
//! - Comments, the outline rail, entity links and hover cards stay as they
//!   were.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use dr_ui::{Theme, components::IconButton, fonts::Role, sand, style::DrStyled};
use gpui::{
    AnyElement, App, Bounds, Context, InteractiveElement as _, IntoElement as _,
    ParentElement as _, Pixels, Styled as _, Task, Window, div, px,
};

use super::Workspace;
use super::corner::CORNER_INSET;
use crate::actions::ToggleImmersiveWriting;
use crate::settings::registry as r;
use crate::strings::t;
use crate::{Services, Settings};

/// The top band that brings the traffic lights and the tab dots back.
pub const REVEAL_TOP: f32 = 56.0;
/// The exit's reach: it comes out with the pointer this near.
pub const EXIT_REACH: f32 = 48.0;
/// The exit's corner box (the button, its reach, the words beside it).
const EXIT_BOX: (f32, f32) = (176.0, 104.0);

/// Immersive writing's state beyond on and off.
#[derive(Default)]
pub struct Immersion {
    /// Entered by typing (a press elsewhere leaves).
    pub typed: bool,
    /// The pointer is in the top band.
    pub top: bool,
    /// Today's words of the book when it began.
    from_words: Option<i64>,
    /// The book's daily goal, once read.
    goal: Option<i64>,
    goal_read: Option<Task<()>>,
    /// The traffic lights are hidden now.
    lights_hidden: bool,
    /// Where each shown page's paper was last drawn, by page key.
    pub(super) papers: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
}

impl Workspace {
    /// Immersive writing on or off, as by hand (the incense stick, ⌘⇧↩,
    /// Esc): the sidebars, the dock, the toggles and the corner go; only
    /// the paper stays.
    pub fn set_immersive(&mut self, on: bool, cx: &mut Context<Self>) {
        self.immerse(on, false, cx);
    }

    /// Whether it was entered by typing.
    pub fn immersed_by_typing(&self) -> bool {
        self.immersive && self.immersion.typed
    }

    fn immerse(&mut self, on: bool, typed: bool, cx: &mut Context<Self>) {
        if self.immersive == on {
            return;
        }
        self.immersive = on;
        self.immersion.typed = on && typed;
        self.immersion.top = false;
        self.immersion.goal_read = None;
        if on {
            self.immersion.from_words = dr_view_stats::today_live(&self.book_id, cx);
            self.read_goal(cx);
        } else {
            self.immersion.from_words = None;
        }
        cx.notify();
    }

    /// The author wrote in a page on the paper (F4's `WritingTyped`): in,
    /// when 「打字时自动沉浸」 is on. The caret stays where it is.
    pub(crate) fn author_wrote(&mut self, cx: &mut Context<Self>) {
        if !self.immersive && Settings::read(cx).bool(r::AUTO_IMMERSIVE) {
            self.immerse(true, true, cx);
        }
    }

    /// The book's daily goal, read off the main thread for the exit's
    /// stroke.
    fn read_goal(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = cx.try_global::<Services>().and_then(|s| s.library.clone()) else {
            return;
        };
        let book = self.book_id.clone();
        let live = dr_view_stats::today_live(&book, cx);
        self.immersion.goal_read = Some(cx.spawn(async move |this, cx| {
            let today = dr_view_stats::clock::today();
            let read = cx
                .background_executor()
                .spawn(async move { dr_view_stats::load_progress(&lib, &book, &today, live) })
                .await;
            this.update(cx, |ws, cx| {
                ws.immersion.goal = read.ok().and_then(|p| p.daily_word_target);
                cx.notify();
            })
            .ok();
        }));
    }

    /// The words written since entering, and today's share of the goal.
    pub fn immersed_words(&self, cx: &App) -> (i64, Option<f32>) {
        let now = dr_view_stats::today_live(&self.book_id, cx);
        let written = match (now, self.immersion.from_words) {
            (Some(now), Some(from)) => now - from,
            _ => 0,
        };
        let share = match (now, self.immersion.goal) {
            (Some(now), Some(goal)) if goal > 0 => Some((now.max(0) as f32 / goal as f32).min(1.0)),
            _ => None,
        };
        (written, share)
    }

    /// A press in the window (capture phase): one typed in leaves unless it
    /// lands on the paper or the exit, or on a layer over the workspace.
    pub(super) fn pressed_while_immersed(
        &mut self,
        at: gpui::Point<Pixels>,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        if !self.immersed_by_typing() || self.top_layer().is_some() || self.modal() {
            return;
        }
        let shown: Vec<String> = self
            .nav
            .active_tab()
            .map(|tab| tab.leaves().map(|l| l.target.key()).collect())
            .unwrap_or_default();
        let on_paper = shown.iter().any(|key| {
            self.immersion
                .papers
                .borrow()
                .get(key)
                .is_some_and(|b| b.contains(&at))
        });
        let size = window.viewport_size();
        let on_exit = f32::from(at.x) > f32::from(size.width) - EXIT_BOX.0
            && f32::from(at.y) > f32::from(size.height) - EXIT_BOX.1;
        if !on_paper && !on_exit {
            self.set_immersive(false, cx);
        }
    }

    /// The pointer moved: the top band shows the traffic lights and dots.
    pub(super) fn pointer_while_immersed(&mut self, y: f32, cx: &mut Context<Self>) {
        if !self.immersive {
            return;
        }
        let top = y < REVEAL_TOP;
        if top != self.immersion.top {
            self.immersion.top = top;
            cx.notify();
        }
    }

    /// A key without modifiers, or the pointer out of the window: the
    /// reveal goes.
    pub(super) fn conceal(&mut self, cx: &mut Context<Self>) {
        if self.immersion.top {
            self.immersion.top = false;
            cx.notify();
        }
    }

    /// The traffic lights follow (macOS): hidden while immersed, unless the
    /// pointer is in the top band. Changed after this frame, on the main
    /// thread.
    pub(super) fn sync_traffic_lights(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let hide = self.immersive && !self.immersion.top;
        if hide == self.immersion.lights_hidden {
            return;
        }
        self.immersion.lights_hidden = hide;
        cx.defer_in(window, move |_, window, _| {
            super::chrome::set_traffic_lights_hidden(window, hide)
        });
    }
}

/// The exit at the paper's bottom right while immersed: the incense stick
/// (selected), the words written since entering to its left, today's
/// stroke toward the daily goal under them. It comes out when the pointer
/// is near.
pub fn exit(ws: &Workspace, window: &mut Window, cx: &mut App) -> AnyElement {
    let theme = Theme::of(window, cx);
    let (p, s) = (theme.palette, theme.scale);
    let (written, share) = ws.immersed_words(cx);
    let words = if written >= 0 {
        format!("+{written}")
    } else {
        format!("−{}", -written)
    };
    let readout = div()
        .flex()
        .flex_col()
        .items_end()
        .gap(px(3.0))
        .child(
            div()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.muted().solid())
                .child(words),
        )
        .children(share.map(|share| {
            div()
                .w(px(56.0))
                .child(sand::Readout::new("immersive-today", share).color(p.ink(2)))
        }));
    div()
        .id("immersive-leave-zone")
        .group("immersive-leave")
        .absolute()
        .right_0()
        .bottom_0()
        .w(px(EXIT_BOX.0))
        .h(px(EXIT_BOX.1))
        .child(
            div()
                .absolute()
                .right(px(CORNER_INSET))
                .bottom(px(CORNER_INSET))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(10.0))
                .opacity(0.0)
                .group_hover("immersive-leave", |st| st.opacity(1.0))
                .child(readout)
                .child(
                    IconButton::new("immersive-leave", dr_ui::sand::Icon::Incense)
                        .floating()
                        .selected(true)
                        .label(t(cx, dr_i18n::keys::immersive_writing::LEAVE))
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(ToggleImmersiveWriting), cx)
                        }),
                ),
        )
        .into_any_element()
}
