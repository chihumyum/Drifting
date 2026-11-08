//! The bottom timeline's view (the 0.1 client's `DesktopBottomTimeline`).
//!
//! Top to bottom: the header row (书序 / 叙事时, 未归属, 未放置; on the right
//! 定位到当前章节 and the story graph), then the lanes. Each lane is a
//! storyline: its name on the left in a fixed column, its chapters on a
//! track that scrolls sideways with every other track. Above the tracks
//! runs the act rail (reading order) or the time axis (narrative order).
//!
//! A chapter is a slab of glass in its lane's colour, drawn on the lane of
//! its main storyline. Dragging it onto another lane makes that storyline
//! its main one (the others stay), onto 未归属 takes it off every
//! storyline; where it is let go is its new place on the axis. A double
//! click on an empty spot of a track makes a chapter there.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;
use std::time::Instant;

use dr_i18n::keys;
use dr_shell::book::{Book, color_of, seal_of};
use dr_shell::nav::{Open, Target};
use dr_shell::strings::tf;
use dr_shell::workspace::SuperView;
use dr_shell::{Services, Workspace, t};
use dr_ui::{
    Theme,
    components::{
        IconButton, Layer, Menu, PanelIconButton, SandCell, Segmented,
        overlay::{self, Align, Place},
    },
    fonts::{Role, weight},
    glass::{self, Kind as GlassKind, Mode, Spec, Tone},
    sand::{self, Icon, KindMark},
    style::DrStyled,
    tokens::{Palette, Rgb, radius},
};
use dr_workspace::{
    Actor, Workspace as Library,
    commands::chapter::{
        ChapterCreate, ChapterCreateIn, ChapterPlace, ChapterPlaceIn, ChapterSetPlace,
        ChapterSpread, ChapterSpreadIn, ChapterUpdate, ChapterUpdateIn, OrderAxis,
    },
    dto::ChapterInfo,
};
use gpui::{
    AnyElement, App, AppContext as _, Bounds, ClickEvent, Context, DragMoveEvent, ElementId,
    Entity, InteractiveElement as _, IntoElement, ParentElement as _, PathBuilder, Pixels, Render,
    ScrollEvent, ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Task, WeakEntity, Window, canvas, div, point, prelude::FluentBuilder as _, px,
};

use crate::kept::{self, Kept};
use crate::model::{
    self, Axis, HEAD_HEIGHT, LaneId, Layout, MAX_ZOOM, MIN_ZOOM, Membership, RAIL_WIDTH,
    ROW_MIN_HEIGHT, STRIP_HEIGHT, SYNTHETIC_CLIP, WHEEL_SENSITIVITY,
};
use crate::spring::{Row, SlabSpring};

mod cards;
mod marks;

pub use marks::{Mark, MarkDrag, default_act_name};

/// A chapter in the hand: from a lane, or from 未放置's list.
#[derive(Clone)]
pub struct ClipDrag {
    pub chapter: String,
    pub title: SharedString,
    pub status: String,
    /// The colour it wears off every lane.
    pub color: Rgb,
    pub size: (f32, f32),
    pub from_drawer: bool,
    timeline: WeakEntity<BottomTimeline>,
}

/// Where the chapter in the hand would land now.
#[derive(Clone, Debug, PartialEq)]
pub struct DropAt {
    pub lane: LaneId,
    pub order: f64,
}

#[derive(Clone)]
struct Dragging {
    chapter: String,
    /// How far into the clip it was taken, so it lands where it is seen.
    grab_x: f32,
    grab_y: f32,
    over: Option<DropAt>,
    /// A slab taken from a lane has weight ([`crate::spring`]); one from
    /// 未放置's list follows the hand.
    weight: Option<Weight>,
}

/// The weighted slab's spring, shared with the slab in the hand.
#[derive(Clone)]
struct Weight {
    spring: Rc<RefCell<SlabSpring>>,
    /// Where the pointer took it (window y).
    start_y: f32,
    clock: Instant,
}

/// A move written but not yet in the book's snapshot: drawn where it went
/// until the snapshot catches up.
#[derive(Clone, Debug)]
struct Moved {
    chapter: String,
    axis: Axis,
    to: DropAt,
    membership: Membership,
}

pub struct BottomTimeline {
    ws: WeakEntity<Workspace>,
    lib: Option<Library>,
    book: Rc<Book>,
    current: Option<Target>,
    axis: Axis,
    unaffiliated_shown: bool,
    unplaced_open: bool,
    zoom: f32,
    scroll: ScrollHandle,
    /// The lanes' box (names and tracks) as last drawn.
    body: Rc<Cell<Option<Bounds<Pixels>>>>,
    dragging: Option<Dragging>,
    moved: Option<Moved>,
    /// The book whose kept settings ([`Kept`]) are in force.
    kept_for: Option<String>,
    /// Keeps the scroll a moment after the wheel stops.
    keep_soon: Option<Task<()>>,
    /// The narrative axis's time pins, read with each book snapshot.
    pins: Rc<Vec<dr_workspace::commands::time_pin::TimePinInfo>>,
    pins_task: Option<gpui::Task<()>>,
    /// A pin or an act boundary in the hand.
    mark_drag: Option<MarkDrag>,
    /// A mark being renamed.
    editing: Option<marks::Editing>,
    /// A pin just made: renamed once it shows.
    rename_next: Option<Mark>,
    /// The card whose 绑定构想… list is unfolded.
    bind_open: Option<Mark>,
    /// Where the pointer is on an act chip (its card's 在此处开始新幕).
    act_spot: Rc<Cell<f64>>,
    /// A hover card held open regardless of the pointer (captures).
    held_card: Option<String>,
    /// Where the pointer is while something is dragged, and when the edge
    /// last scrolled the tracks.
    drag_pointer: Option<gpui::Point<Pixels>>,
    edge_clock: Option<Instant>,
    /// Each act boundary's focus (←/→ move a focused one), and where the
    /// keys have put one until the book shows it.
    act_focus: std::collections::HashMap<String, gpui::FocusHandle>,
    nudged: std::collections::HashMap<String, f64>,
    /// The pins' and acts' writes, one after another.
    writes: Option<(
        futures::channel::mpsc::UnboundedSender<marks::WriteJob>,
        gpui::Task<()>,
    )>,
    _subs: Vec<Subscription>,
}

/// How long after the wheel stops the scroll and zoom are kept.
const KEEP_AFTER: Duration = Duration::from_millis(400);

impl BottomTimeline {
    pub fn new(ws: WeakEntity<Workspace>, cx: &mut Context<Self>) -> BottomTimeline {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        cx.spawn(async move |this, cx| this.update(cx, |t, cx| t.follow(cx)).ok())
            .detach();
        BottomTimeline {
            ws,
            lib,
            book: Rc::default(),
            current: None,
            axis: Axis::default(),
            unaffiliated_shown: false,
            unplaced_open: false,
            zoom: 1.0,
            scroll: ScrollHandle::new(),
            body: Rc::default(),
            dragging: None,
            moved: None,
            kept_for: None,
            keep_soon: None,
            pins: Rc::default(),
            pins_task: None,
            mark_drag: None,
            editing: None,
            rename_next: None,
            bind_open: None,
            act_spot: Rc::default(),
            held_card: None,
            drag_pointer: None,
            edge_clock: None,
            act_focus: Default::default(),
            nudged: Default::default(),
            writes: None,
            _subs: Vec::new(),
        }
    }

    /// What this book keeps (another book's settings stay with it).
    fn apply(&mut self, kept: Kept) {
        self.axis = kept.axis;
        self.unaffiliated_shown = kept.unaffiliated;
        self.zoom = kept.zoom;
        self.unplaced_open = false;
        self.scroll.set_offset(point(px(-kept.scroll_x), px(0.0)));
    }

    /// Keeps the order, 未归属, the zoom and the scroll for the book shown.
    fn remember(&mut self, cx: &mut Context<Self>) {
        self.keep_soon = None;
        let Some(book) = self.kept_for.clone() else {
            return;
        };
        let kept = Kept {
            axis: self.axis,
            unaffiliated: self.unaffiliated_shown,
            zoom: self.zoom,
            scroll_x: self.scroll_x().max(0.0).round(),
        };
        let Ok(value) = serde_json::to_value(kept) else {
            return;
        };
        self.ws
            .update(cx, |ws, cx| {
                if ws.book_id == book {
                    ws.set_book_memory(kept::KEY, value, cx);
                }
            })
            .ok();
    }

    fn remember_soon(&mut self, cx: &mut Context<Self>) {
        self.keep_soon = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(KEEP_AFTER).await;
            this.update(cx, |t, cx| t.remember(cx)).ok();
        }));
    }

    fn follow(&mut self, cx: &mut Context<Self>) {
        let Some(ws) = self.ws.upgrade() else {
            return;
        };
        self.read_workspace(&ws, cx);
        self._subs.push(cx.observe(&ws, |t, ws, cx| {
            t.read_workspace(&ws, cx);
            cx.notify();
        }));
        cx.notify();
    }

    fn read_workspace(&mut self, ws: &Entity<Workspace>, cx: &mut Context<Self>) {
        let (book, current) = {
            let w = ws.read(cx);
            // What this book keeps, once the workspace has read it.
            if w.book_memory_ready() && self.kept_for.as_deref() != Some(w.book_id.as_str()) {
                let kept = Kept::read(w.book_memory(kept::KEY));
                self.kept_for = Some(w.book_id.clone());
                self.apply(kept);
            }
            (w.book.clone(), w.nav.current().cloned())
        };
        if !Rc::ptr_eq(&book, &self.book) {
            self.book = book;
            // Boundaries the keys moved, once the book has them.
            let acts = self.book.acts.clone();
            self.nudged.retain(|id, at| {
                !acts
                    .iter()
                    .any(|a| &a.id == id && a.start_order.is_some_and(|s| (s - *at).abs() < 1e-9))
            });
            // The pins live in the book's document: read them again.
            self.load_pins(cx);
            // The move is in the snapshot once the chapter is where it went.
            if let Some(m) = &self.moved
                && let Some(c) = self.book.chapters.iter().find(|c| c.id == m.chapter)
                && arrived(c, m)
            {
                self.moved = None;
            }
        }
        self.current = current;
    }

    /// What is drawn now (tests).
    pub fn layout(&self) -> Layout {
        let moved = self
            .moved
            .as_ref()
            .and_then(|m| moved_chapter(&self.book, m));
        let mut layout = model::layout(
            &self.book,
            self.axis,
            self.unaffiliated_shown,
            self.zoom,
            moved.as_ref(),
        );
        // The narrative axis runs past its last pin too.
        if self.axis == Axis::Narrative {
            let last = self
                .pins
                .iter()
                .map(|p| p.narrative_order)
                .chain(self.mark_drag.as_ref().map(|d| d.order))
                .fold(f64::NEG_INFINITY, f64::max);
            layout.scale = layout.scale.reaching(last);
        }
        layout
    }

    pub fn axis(&self) -> Axis {
        self.axis
    }

    pub fn set_axis(&mut self, axis: Axis, cx: &mut Context<Self>) {
        self.axis = axis;
        self.unplaced_open = false;
        self.remember(cx);
        cx.notify();
    }

    pub fn unaffiliated_shown(&self) -> bool {
        self.unaffiliated_shown
    }

    pub fn toggle_unaffiliated(&mut self, cx: &mut Context<Self>) {
        self.unaffiliated_shown = !self.unaffiliated_shown;
        self.remember(cx);
        cx.notify();
    }

    pub fn toggle_unplaced(&mut self, cx: &mut Context<Self>) {
        self.unplaced_open = !self.unplaced_open;
        cx.notify();
    }

    pub fn unplaced_open(&self) -> bool {
        self.unplaced_open
    }

    pub fn zoom(&self) -> f32 {
        self.zoom
    }

    /// Where the chapter in the hand would land (tests).
    pub fn drop_target(&self) -> Option<DropAt> {
        self.dragging.as_ref().and_then(|d| d.over.clone())
    }

    /// The least height the Bottom Panel can be dragged to.
    pub fn min_height(&self) -> f32 {
        self.layout().min_height()
    }

    fn open(&self, target: Target, how: Open, cx: &mut App) {
        self.ws.update(cx, |ws, cx| ws.open(target, how, cx)).ok();
    }

    /// Puts `chapter` on `lane` at `order` of the axis shown: as a drop
    /// does. The new place shows at once; F3 writes it off the main thread.
    pub fn move_chapter(&mut self, chapter: &str, to: DropAt, cx: &mut Context<Self>) {
        let (Some(lib), Some(info)) = (
            self.lib.clone(),
            self.book.chapters.iter().find(|c| c.id == chapter).cloned(),
        ) else {
            return;
        };
        if !to.order.is_finite() {
            return;
        }
        let axis = self.axis;
        let membership = model::membership(&info, &to.lane);
        self.moved = Some(Moved {
            chapter: chapter.to_owned(),
            axis,
            to: to.clone(),
            membership: membership.clone(),
        });
        cx.notify();
        let book = self.book.id.clone();
        // The storylines and the place in one commit, one undo step (F3's
        // chapter.place, the 0.1 client's persistChapterTimelineMove).
        let storyline = if membership.is_empty() {
            None
        } else {
            match &to.lane {
                LaneId::Book => None,
                LaneId::Unaffiliated => Some(None),
                LaneId::Storyline(s) => Some(Some(s.clone())),
            }
        };
        let task = cx.background_executor().spawn(async move {
            lib.run::<ChapterSetPlace>(
                &Actor::User,
                ChapterPlaceIn {
                    book,
                    id: info.id.clone(),
                    axis: order_axis(axis),
                    order: to.order,
                    storyline,
                },
            )
            .map(|_| ())
        });
        cx.spawn(async move |this, cx| {
            if let Err(e) = task.await {
                log::warn!("timeline: moving a chapter failed: {e}");
                this.update(cx, |t, cx| {
                    t.moved = None;
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    /// Makes a chapter on `lane` at `order` of the axis shown and opens it
    /// (a double click on an empty spot, `createChapterAt`).
    pub fn create_at(&mut self, lane: &LaneId, order: f64, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if !order.is_finite() {
            return;
        }
        let axis = self.axis;
        let book = self.book.id.clone();
        let opened_in = book.clone();
        let storyline = lane.storyline().map(str::to_owned);
        let task = cx.background_executor().spawn(async move {
            let made = lib
                .run::<ChapterCreate>(
                    &Actor::User,
                    ChapterCreateIn {
                        book,
                        title: String::new(),
                        place: Some(match axis {
                            Axis::Book => ChapterPlace::Order(order),
                            Axis::Narrative => ChapterPlace::Last,
                        }),
                        summary: String::new(),
                        storyline,
                        text: None,
                        narrative_order: (axis == Axis::Narrative).then_some(order),
                    },
                )?
                .output;
            Ok::<_, dr_workspace::WsError>(made.id)
        });
        cx.spawn(async move |this, cx| match task.await {
            Ok(id) => {
                this.update(cx, |t, cx| {
                    // The write belongs to the book where it began. Opening
                    // another book while it runs must not navigate back.
                    if !t
                        .ws
                        .upgrade()
                        .is_some_and(|ws| ws.read(cx).book_id == opened_in)
                    {
                        return;
                    }
                    if let Ok(id) = id.parse() {
                        t.open(Target::Chapter(id), Open::KEEP, cx);
                    }
                })
                .ok();
            }
            Err(e) => log::warn!("timeline: making a chapter failed: {e}"),
        })
        .detach();
    }

    /// Scrolls the chapter in front to the middle (定位到当前章节).
    pub fn locate_current(&mut self, cx: &mut Context<Self>) {
        let Some(Target::Chapter(id)) = &self.current else {
            return;
        };
        let layout = self.layout();
        let Some(order) = self
            .book
            .chapters
            .iter()
            .find(|c| c.id == id.as_str())
            .and_then(|c| self.axis.order(c))
        else {
            return;
        };
        let view_w = self
            .body
            .get()
            .map(|b| f32::from(b.size.width) - RAIL_WIDTH)
            .unwrap_or(0.0);
        let left = layout.scale.x(order) - view_w / 2.0 + layout.scale.clip_width() / 2.0;
        self.scroll.set_offset(point(px(-left.max(0.0)), px(0.0)));
        self.remember(cx);
        cx.notify();
    }

    /// 打散: the placed chapters on the axis shown, same order, one stride
    /// apart; on reading order the act boundaries move along. One step
    /// (F3's chapter.spread).
    pub fn spread(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let (book, axis) = (self.book.id.clone(), order_axis(self.axis));
        cx.background_executor()
            .spawn(async move {
                if let Err(e) =
                    lib.run::<ChapterSpread>(&Actor::User, ChapterSpreadIn { book, axis })
                {
                    log::warn!("timeline: spreading the chapters failed: {e}");
                }
            })
            .detach();
    }

    /// The lanes' box (names and tracks) as last drawn (tests).
    pub fn body_bounds(&self) -> Option<Bounds<Pixels>> {
        self.body.get()
    }

    /// The horizontal scroll, in px from the axis's start.
    pub fn scroll_x(&self) -> f32 {
        -f32::from(self.scroll.offset().x)
    }

    /// The lane and order under `position` (window coordinates), the clip
    /// held `grab_x` in from its left edge (`resolveChapterLanePointerTarget`).
    fn target_at(
        &self,
        layout: &Layout,
        position: gpui::Point<Pixels>,
        grab_x: f32,
    ) -> Option<DropAt> {
        let body = self.body.get()?;
        let top = f32::from(body.origin.y) + STRIP_HEIGHT;
        let height = f32::from(body.size.height) - STRIP_HEIGHT;
        let n = layout.lanes.len();
        let y = f32::from(position.y) - top;
        if n == 0 || height <= 0.0 || y < 0.0 || y >= height {
            return None;
        }
        let x0 = f32::from(position.x);
        if x0 < f32::from(body.origin.x) || x0 > f32::from(body.origin.x + body.size.width) {
            return None;
        }
        let row = ((y / (height / n as f32)) as usize).min(n - 1);
        let track_left = f32::from(body.origin.x) + RAIL_WIDTH - self.scroll_x();
        let order = layout.scale.order_at(x0 - track_left - grab_x);
        Some(DropAt {
            lane: layout.lanes[row].id.clone(),
            order,
        })
    }

    /// The lanes' boxes in window coordinates, top to bottom.
    fn rows(&self, layout: &Layout) -> Vec<Row> {
        let Some(body) = self.body.get() else {
            return Vec::new();
        };
        let n = layout.lanes.len();
        if n == 0 {
            return Vec::new();
        }
        let top = f32::from(body.origin.y) + STRIP_HEIGHT;
        let height = (f32::from(body.size.height) - STRIP_HEIGHT) / n as f32;
        (0..n)
            .map(|i| Row {
                top: top + height * i as f32,
                height,
            })
            .collect()
    }

    fn drag_moved(&mut self, e: &DragMoveEvent<ClipDrag>, cx: &mut Context<Self>) {
        self.drag_pointer = Some(e.event.position);
        self.aim_clip(e.event.position, cx);
        // Near an edge the next frame scrolls.
        cx.notify();
    }

    /// Where the chapter in the hand would land with the pointer at
    /// `position` (window coordinates).
    fn aim_clip(&mut self, position: gpui::Point<Pixels>, cx: &mut Context<Self>) {
        let layout = self.layout();
        let Some((grab_x, grab_y, weight)) = self
            .dragging
            .as_ref()
            .map(|d| (d.grab_x, d.grab_y, d.weight.clone()))
        else {
            return;
        };
        let over = match weight {
            // The lane the weighted slab is in; carried clear of the lanes,
            // where the pointer is.
            Some(w) => {
                let rows = self.rows(&layout);
                let pointer = (f32::from(position.x), f32::from(position.y));
                let now = w.clock.elapsed().as_secs_f32();
                let row =
                    w.spring
                        .borrow_mut()
                        .aim(pointer, (grab_x, grab_y), &rows, w.start_y, now);
                match row {
                    Some(row) => self.body.get().map(|body| {
                        let track_left = f32::from(body.origin.x) + RAIL_WIDTH - self.scroll_x();
                        DropAt {
                            lane: layout.lanes[row].id.clone(),
                            order: layout.scale.order_at(pointer.0 - track_left - grab_x),
                        }
                    }),
                    None => self.target_at(&layout, position, grab_x),
                }
            }
            None => self.target_at(&layout, position, grab_x),
        };
        if let Some(d) = self.dragging.as_mut()
            && d.over != over
        {
            d.over = over;
            cx.notify();
        }
    }

    fn dropped(&mut self, drag: &ClipDrag, cx: &mut Context<Self>) {
        let over = self
            .dragging
            .take()
            .filter(|d| d.chapter == drag.chapter)
            .and_then(|d| d.over);
        if drag.from_drawer {
            self.unplaced_open = false;
        }
        if let Some(to) = over {
            self.move_chapter(&drag.chapter, to, cx);
        }
        cx.notify();
    }

    /// While something is dragged near the tracks' left or right edge, the
    /// tracks scroll that way, faster the closer, and what is in the hand
    /// aims again at what is now under it.
    fn edge_scroll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let dragging = self.dragging.is_some() || self.mark_drag.is_some();
        let (Some(pointer), Some(body), true) = (self.drag_pointer, self.body.get(), dragging)
        else {
            self.drag_pointer = None;
            self.edge_clock = None;
            return;
        };
        let now = Instant::now();
        let dt = self
            .edge_clock
            .map_or(1.0 / 60.0, |t| now.duration_since(t).as_secs_f32());
        let left = f32::from(body.origin.x) + RAIL_WIDTH;
        let right = f32::from(body.origin.x + body.size.width);
        let max = self.layout().scale.width() - (right - left);
        let scroll = self.scroll_x();
        let step = model::edge_step(f32::from(pointer.x), left, right, scroll, max, dt);
        if step == 0.0 {
            self.edge_clock = None;
            return;
        }
        self.edge_clock = Some(now);
        self.scroll.set_offset(point(px(-(scroll + step)), px(0.0)));
        if self.dragging.is_some() {
            self.aim_clip(pointer, cx);
        }
        if self.mark_drag.is_some() {
            self.aim_mark(pointer, cx);
        }
        window.request_animation_frame();
    }

    /// ⌘ or Ctrl and the wheel: zoom, the spot under the pointer staying put.
    fn wheel(&mut self, e: &ScrollEvent, window: &mut Window, cx: &mut Context<Self>) {
        if !(e.modifiers.platform || e.modifiers.control) {
            // A plain scroll: kept once the wheel stops.
            self.remember_soon(cx);
            return;
        }
        let Some(body) = self.body.get() else {
            return;
        };
        let dy = f32::from(e.delta.pixel_delta(window.line_height()).y);
        let zoom = (self.zoom * (1.0 + dy * WHEEL_SENSITIVITY)).clamp(MIN_ZOOM, MAX_ZOOM);
        if zoom == self.zoom {
            cx.stop_propagation();
            return;
        }
        let local = f32::from(e.position.x) - f32::from(body.origin.x) - RAIL_WIDTH;
        let anchor = (local + self.scroll_x()) / self.zoom;
        self.zoom = zoom;
        let left = (anchor * zoom - local).max(0.0);
        self.scroll.set_offset(point(px(-left), px(0.0)));
        self.remember_soon(cx);
        cx.stop_propagation();
        cx.notify();
    }

    pub fn set_zoom(&mut self, zoom: f32, cx: &mut Context<Self>) {
        self.zoom = zoom.clamp(MIN_ZOOM, MAX_ZOOM);
        self.remember(cx);
        cx.notify();
    }
}

/// F3's name for an axis.
fn order_axis(axis: Axis) -> OrderAxis {
    match axis {
        Axis::Book => OrderAxis::Book,
        Axis::Narrative => OrderAxis::Narrative,
    }
}

/// Whether the snapshot shows `m` done.
fn arrived(c: &ChapterInfo, m: &Moved) -> bool {
    let placed = m
        .axis
        .order(c)
        .is_some_and(|o| (o - m.to.order).abs() < 1e-6);
    let on = match &m.to.lane {
        LaneId::Book => true,
        LaneId::Unaffiliated => c.storylines.is_empty(),
        LaneId::Storyline(s) => c.primary_storyline.as_deref() == Some(s.as_str()),
    };
    placed && on
}

/// `m`'s chapter as it will be once written.
fn moved_chapter(book: &Book, m: &Moved) -> Option<ChapterInfo> {
    let mut c = book.chapters.iter().find(|c| c.id == m.chapter)?.clone();
    match m.axis {
        Axis::Book => c.book_order = Some(m.to.order),
        Axis::Narrative => c.narrative_order = Some(m.to.order),
    }
    c.storylines.retain(|s| !m.membership.remove.contains(s));
    for s in &m.membership.add {
        if !c.storylines.contains(s) {
            c.storylines.push(s.clone());
        }
    }
    if let Some(p) = &m.membership.primary {
        c.primary_storyline = p.clone();
    }
    Some(c)
}

/// A chapter in the hand, under the pointer: its slab, in the colour of the
/// lane it would land on (its own off every lane).
struct Ghost {
    drag: ClipDrag,
    /// Where it was taken: GPUI draws the hand's view at the pointer less
    /// this.
    grab: (f32, f32),
    weight: Option<Weight>,
}

impl Render for Ghost {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // A weighted slab is drawn where its spring is, off GPUI's anchor.
        let (dx, dy) = match &self.weight {
            Some(w) => {
                let mut spring = w.spring.borrow_mut();
                if spring.step(w.clock.elapsed().as_secs_f32()) {
                    window.request_animation_frame();
                }
                let mouse = window.mouse_position();
                (
                    spring.x - (f32::from(mouse.x) - self.grab.0),
                    spring.y - (f32::from(mouse.y) - self.grab.1),
                )
            }
            None => (0.0, 0.0),
        };
        let color = self
            .drag
            .timeline
            .upgrade()
            .and_then(|t| {
                let t = t.read(cx);
                let over = t.dragging.as_ref()?.over.as_ref()?.lane.clone();
                Some(lane_color(&t.book, &over))
            })
            .unwrap_or(self.drag.color);
        let (w, h) = self.drag.size;
        div().relative().left(px(dx)).top(px(dy)).child(
            slab(
                ElementId::Name(format!("timeline-ghost-{}", self.drag.chapter).into()),
                self.drag.title.clone(),
                &self.drag.status,
                color,
                true,
                window,
                cx,
            )
            .w(px(w))
            .h(px(h)),
        )
    }
}

/// The glass a chapter wears on `lane`.
fn lane_color(book: &Book, lane: &LaneId) -> Rgb {
    lane.storyline()
        .and_then(|id| book.storylines.iter().find(|s| s.id == id))
        .and_then(|s| color_of(&s.color))
        .unwrap_or(Rgb::hex(SYNTHETIC_CLIP))
}

/// A chapter's slab (`.btl-clip.glass`): the page's fill, a rim in its lane's
/// colour that flows under the pointer and is pressed while selected; a
/// draft's title a shade lighter, a discarded one faded.
fn slab(
    id: ElementId,
    title: SharedString,
    status: &str,
    color: Rgb,
    selected: bool,
    window: &mut Window,
    cx: &mut App,
) -> gpui::Stateful<gpui::Div> {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    glass::glass_box(
        id,
        GlassKind::Rest,
        Mode::default(),
        selected,
        Spec::new(Tone::Color(color), 2.0).rim(9.0),
        window,
        cx,
    )
    .rounded(px(2.0))
    .bg(p.page.solid())
    .overflow_hidden()
    .flex()
    .items_center()
    .px(px(10.0))
    .when(status == "discarded", |el| el.opacity(0.55))
    .child(
        div()
            .relative()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis()
            .font_role(Role::Ui)
            .type_px(s.secondary, s.secondary * 1.15)
            .text_color(if status == "draft" {
                p.ink(2).solid()
            } else {
                p.ink(1).solid()
            })
            .when(status == "discarded", |el| el.line_through())
            .child(title),
    )
}

fn untitled(title: &str, cx: &App) -> SharedString {
    if title.trim().is_empty() {
        t(cx, keys::common::UNTITLED)
    } else {
        title.to_owned().into()
    }
}

impl Render for BottomTimeline {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        if self.dragging.is_some() && !cx.has_active_drag() {
            self.dragging = None;
        }
        if self.mark_drag.is_some() && !cx.has_active_drag() {
            self.mark_drag = None;
        }
        self.edge_scroll(window, cx);
        self.keep_act_focus(cx);
        // A pin just made: its name ready to type once it shows.
        if let Some(mark) = self.rename_next.clone()
            && let Mark::Pin(id) = &mark
            && self.pins.iter().any(|p| &p.id == id)
        {
            self.rename_next = None;
            self.start_rename(mark, window, cx);
        }
        let layout = self.layout();
        let entity = cx.entity();
        let head = self.head(&layout, window, cx);
        let rails = self.rails(&layout, window, cx);
        let tracks = self.tracks(&layout, window, cx);
        let probe = {
            let cell = self.body.clone();
            canvas(move |bounds, _, _| cell.set(Some(bounds)), |_, _, _, _| {})
                .absolute()
                .top_0()
                .left_0()
                .size_full()
        };
        let body = div()
            .id("timeline-body")
            .relative()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_row()
            .child(probe)
            .child(rails)
            .child(tracks)
            .on_drag_move::<ClipDrag>({
                let entity = entity.clone();
                move |e, _, cx| entity.update(cx, |t, cx| t.drag_moved(e, cx))
            })
            .on_drop::<ClipDrag>({
                let entity = entity.clone();
                move |drag, _, cx| entity.update(cx, |t, cx| t.dropped(drag, cx))
            });
        glass::surface(
            glass::Ground::flat(p.desk),
            div()
                .id("bottom-timeline")
                .on_drag_move::<MarkDrag>({
                    let entity = entity.clone();
                    move |e, _, cx| entity.update(cx, |t, cx| t.mark_drag_moved(e, cx))
                })
                .on_drop::<MarkDrag>({
                    let entity = entity.clone();
                    move |_, _, cx| entity.update(cx, |t, cx| t.mark_dropped(cx))
                })
                .size_full()
                .flex()
                .flex_col()
                .bg(p.desk.solid())
                .text_color(p.ink(1).solid())
                .child(head)
                .child(body),
        )
    }
}

impl BottomTimeline {
    /// The header row (`BottomPanelHeader`): 书序 / 叙事时, 未归属 and 未放置 on
    /// the left; 定位到当前章节 and the story graph on the right.
    fn head(&self, layout: &Layout, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let entity = cx.entity();
        let views = Segmented::new(
            "timeline-axis",
            [
                t(cx, keys::bottom_timeline::view::BOOK),
                t(cx, keys::bottom_timeline::view::NARRATIVE),
            ],
            match self.axis {
                Axis::Book => 0,
                Axis::Narrative => 1,
            },
        )
        .on_change({
            let entity = entity.clone();
            move |i, _, cx| {
                let axis = if i == 1 { Axis::Narrative } else { Axis::Book };
                entity.update(cx, |t, cx| t.set_axis(axis, cx));
            }
        });
        let unaffiliated = (!self.book.storylines.is_empty()).then(|| {
            toggle(
                "timeline-unaffiliated",
                t(cx, keys::bottom_timeline::synthetic::UNAFFILIATED),
                layout.unaffiliated,
                self.unaffiliated_shown,
                false,
                {
                    let entity = entity.clone();
                    move |_, _, cx| entity.update(cx, |t, cx| t.toggle_unaffiliated(cx))
                },
                window,
                cx,
            )
            .into_any_element()
        });
        let unplaced = (self.axis == Axis::Narrative).then(|| {
            let bounds = overlay::use_bounds("timeline-unplaced-bounds", window, cx);
            let button = toggle(
                "timeline-unplaced",
                t(cx, keys::bottom_timeline::unplaced::LABEL),
                layout.unplaced.len(),
                self.unplaced_open,
                true,
                {
                    let entity = entity.clone();
                    move |_, _, cx| entity.update(cx, |t, cx| t.toggle_unplaced(cx))
                },
                window,
                cx,
            )
            .child(overlay::probe(bounds.clone()));
            let list = self
                .unplaced_open
                .then(|| *bounds.read(cx))
                .flatten()
                .map(|rect| self.unplaced_list(layout, rect, window, cx));
            div().child(button).children(list).into_any_element()
        });
        // 打散 (needs two placed chapters).
        let mode = t(
            cx,
            match self.axis {
                Axis::Book => keys::bottom_timeline::view::BOOK,
                Axis::Narrative => keys::bottom_timeline::view::NARRATIVE,
            },
        );
        let can_spread = layout.placed >= 2;
        let spread = PanelIconButton::new("timeline-spread", Icon::Spread)
            .label(if can_spread {
                tf(cx, keys::bottom_timeline::spread::TITLE, &[("mode", &mode)])
            } else {
                t(cx, keys::bottom_timeline::spread::NEED_TWO)
            })
            // dr-ui's panel icon button has no disabled look: with fewer
            // than two it does nothing and says why.
            .on_click({
                let entity = entity.clone();
                move |_, _, cx| {
                    if can_spread {
                        entity.update(cx, |t, cx| t.spread(cx))
                    }
                }
            });
        let locate = PanelIconButton::new("timeline-locate", Icon::Locate)
            .label(t(cx, keys::bottom_timeline::LOCATE_CURRENT))
            .on_click({
                let entity = entity.clone();
                move |_, _, cx| entity.update(cx, |t, cx| t.locate_current(cx))
            });
        let graph = IconButton::new("timeline-story-graph", Icon::Fullscreen)
            .label(t(cx, keys::bottom_status_bar::STORY_GRAPH))
            .on_click({
                let ws = self.ws.clone();
                move |_, _, cx| {
                    ws.update(cx, |ws, cx| ws.toggle_super_view(SuperView::StoryGraph, cx))
                        .ok();
                }
            });
        div()
            .h(px(HEAD_HEIGHT))
            .flex_none()
            .px(px(8.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .child(views)
            .children(unaffiliated)
            .children(unplaced)
            .child(div().flex_1())
            .child(spread)
            .child(locate)
            .child(graph)
            .into_any_element()
    }

    /// 未放置's list: the chapters not on the narrative axis, to drag onto a
    /// lane or open.
    fn unplaced_list(
        &self,
        layout: &Layout,
        rect: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let entity = cx.entity();
        let live: std::collections::HashMap<&str, usize> = self
            .book
            .storylines
            .iter()
            .enumerate()
            .map(|(i, s)| (s.id.as_str(), i))
            .collect();
        let mut menu = Menu::new("timeline-unplaced-list")
            .section(t(cx, keys::bottom_timeline::unplaced::TITLE), &theme);
        if layout.unplaced.is_empty() {
            menu = menu.child(
                div()
                    .px(px(14.0))
                    .py(px(6.0))
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.muted().solid())
                    .child(t(cx, keys::bottom_timeline::unplaced::EMPTY)),
            );
        }
        for c in &layout.unplaced {
            let main = model::main_storyline(c, &live)
                .and_then(|id| self.book.storylines.iter().find(|s| s.id == id));
            let color = main.and_then(|s| color_of(&s.color));
            let title = untitled(&c.title, cx);
            let drag = ClipDrag {
                chapter: c.id.clone(),
                title: title.clone(),
                status: c.status.clone(),
                color: color.unwrap_or(Rgb::hex(SYNTHETIC_CLIP)),
                size: (80.0, 28.0),
                from_drawer: true,
                timeline: entity.downgrade(),
            };
            let id = c.id.clone();
            let row = glass::glass_box(
                ElementId::Name(format!("timeline-unplaced-{}", c.id).into()),
                GlassKind::Hidden,
                Mode::default(),
                false,
                Spec::new(
                    dr_ui::components::cell::ring_tone(color, p.glass_clear),
                    radius::SM,
                )
                .rim(dr_ui::components::cell::RING_RIM),
                window,
                cx,
            )
            .mx(px(6.0))
            .h(px(s.menu_row))
            .px(px(8.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .rounded(px(radius::SM))
            .cursor_grab()
            .child({
                let mark = KindMark::new(
                    ElementId::Name(format!("timeline-unplaced-mark-{}", c.id).into()),
                    sand::Kind::Chapter(seal_of(&c.id)),
                );
                match color {
                    Some(c) => mark.color(c),
                    None => mark,
                }
            })
            .child(
                div()
                    .flex_none()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.muted().solid())
                    .child(format!("§ {:02}", c.number.unwrap_or(0))),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .font_role(Role::Ui)
                    .type_px(s.menu_text, s.menu_line)
                    .child(title),
            )
            .on_click({
                let entity = entity.clone();
                move |e: &ClickEvent, _, cx| {
                    let Ok(id) = id.parse() else {
                        return;
                    };
                    let how = if e.click_count() > 1 {
                        Open::KEEP
                    } else {
                        Open::PREVIEW
                    };
                    entity.update(cx, |t, cx| t.open(Target::Chapter(id), how, cx));
                }
            })
            .on_drag(drag, {
                let entity = entity.clone();
                move |drag, offset, _, cx| {
                    let drag = drag.clone();
                    let grab = (
                        f32::from(offset.x).min(drag.size.0),
                        f32::from(offset.y).min(drag.size.1),
                    );
                    entity.update(cx, |t, cx| {
                        t.dragging = Some(Dragging {
                            chapter: drag.chapter.clone(),
                            grab_x: grab.0,
                            grab_y: grab.1,
                            over: None,
                            weight: None,
                        });
                        cx.notify();
                    });
                    cx.new(|_| Ghost {
                        drag,
                        grab,
                        weight: None,
                    })
                }
            });
            menu = menu.child(row);
        }
        overlay::float(
            Place::Rect {
                rect,
                align: Align::Start,
                gap: 6.0,
            },
            Layer::Popover,
            menu,
        )
        .into_any_element()
    }

    /// The fixed column of lane names (`btl-rail`), under the strip's head
    /// cell (幕 / 时间).
    fn rails(&self, layout: &Layout, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let entity = cx.entity();
        let strip_head = div()
            .h(px(STRIP_HEIGHT))
            .flex_none()
            .pl(px(16.0))
            .pr(px(10.0))
            .flex()
            .items_center()
            .bg(p.paper.solid())
            .when(layout.axis == Axis::Book, |el| {
                el.border_b_1().border_color(p.rule.solid())
            })
            .font_role(Role::Index)
            .type_px(s.caption - 2.5, s.caption)
            .text_color(p.ink(4).solid())
            .child(div().flex_1().child(t(
                cx,
                match layout.axis {
                    Axis::Book => keys::bottom_timeline::act::RAIL_LABEL,
                    Axis::Narrative => keys::bottom_timeline::axis::TIME,
                },
            )))
            .child(
                // ＋: a new act (the first at the axis's head) or a pin, in
                // the middle of what shows.
                PanelIconButton::new("timeline-strip-add", Icon::Plus)
                    .label(t(
                        cx,
                        match layout.axis {
                            Axis::Book => keys::bottom_timeline::act::NEW_ACT,
                            Axis::Narrative => keys::bottom_timeline::axis::ADD_PIN,
                        },
                    ))
                    .on_click({
                        let entity = entity.clone();
                        let axis = layout.axis;
                        let head = layout.scale.min_order;
                        move |_, _, cx| {
                            entity.update(cx, |t, cx| {
                                let middle = t.middle_order().unwrap_or(head);
                                match axis {
                                    Axis::Book if t.book.acts.is_empty() => t.add_act(head, cx),
                                    Axis::Book => t.add_act(middle, cx),
                                    Axis::Narrative => t.add_pin(middle, cx),
                                }
                            })
                        }
                    }),
            );
        let mut col = div()
            .w(px(RAIL_WIDTH))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .border_r_1()
            .border_color(p.rule.solid())
            .bg(p.desk.solid())
            .child(strip_head);
        for lane in &layout.lanes {
            let count = tf(
                cx,
                keys::bottom_timeline::storyline::CHAPTER_COUNT,
                &[("count", &lane.members)],
            );
            let readout = div()
                .flex_none()
                .font_role(Role::Index)
                .type_px(s.caption - 3.0, s.caption)
                .text_color(p.muted().solid())
                .child(count.clone());
            let cell = match &lane.id {
                LaneId::Storyline(id) => {
                    let target = id.parse().ok().map(Target::Storyline);
                    let selected = target.is_some() && self.current == target;
                    let color = lane.color.as_deref().and_then(color_of);
                    let name = lane
                        .name
                        .clone()
                        .filter(|n| !n.trim().is_empty())
                        .map(SharedString::from)
                        .unwrap_or_else(|| t(cx, keys::top_timeline::untitled::STORYLINE));
                    let cell =
                        SandCell::new(ElementId::Name(format!("timeline-rail-{id}").into()), name)
                            .mark(sand::Kind::Storyline)
                            .color_opt(Some(color.unwrap_or(p.ink(4))))
                            .italic(true)
                            .selected(selected)
                            .children([readout.into_any_element()])
                            .on_click({
                                let entity = entity.clone();
                                move |e: &ClickEvent, _, cx| {
                                    let Some(target) = target.clone() else {
                                        return;
                                    };
                                    let how = if e.click_count() > 1 {
                                        Open::KEEP
                                    } else {
                                        Open::PREVIEW
                                    };
                                    entity.update(cx, |t, cx| t.open(target, how, cx));
                                }
                            });
                    self.with_card(
                        format!("timeline-rail-card-{id}"),
                        cell,
                        cards::CardOf::Storyline(id.clone()),
                        cx,
                    )
                }
                synthetic => {
                    let (name, color) = match synthetic {
                        LaneId::Book => (t(cx, keys::bottom_timeline::synthetic::BOOK), p.accent),
                        _ => (
                            t(cx, keys::bottom_timeline::synthetic::UNAFFILIATED),
                            p.ink(3),
                        ),
                    };
                    div()
                        .px(px(10.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            KindMark::new(
                                ElementId::Name(format!("timeline-rail-mark-{synthetic:?}").into()),
                                sand::Kind::Storyline,
                            )
                            .color(color),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .italic()
                                .font_role(Role::Ui)
                                .type_px(s.secondary, s.line_body)
                                .weight(weight::MEDIUM)
                                .text_color(p.ink(2).solid())
                                .child(name),
                        )
                        .child(readout)
                        .into_any_element()
                }
            };
            col = col.child(
                div()
                    .flex_1()
                    .min_h(px(ROW_MIN_HEIGHT))
                    .px(px(4.0))
                    .flex()
                    .flex_col()
                    .justify_center()
                    .child(cell),
            );
        }
        col.into_any_element()
    }

    /// The tracks, scrolling sideways together under the act rail or the
    /// time axis, with the links between lanes over them.
    fn tracks(&self, layout: &Layout, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let entity = cx.entity();
        let scale = layout.scale;
        let width = scale.width();
        let strip = match layout.axis {
            Axis::Book => self.act_rail(layout, window, cx),
            Axis::Narrative => self.time_axis(layout, window, cx),
        };
        // The pins' lines run down every track.
        let pin_lines: Vec<f32> = match layout.axis {
            Axis::Narrative => self
                .pins
                .iter()
                .map(|pin| {
                    scale.x(self.mark_order(&Mark::Pin(pin.id.clone()), pin.narrative_order))
                })
                .collect(),
            Axis::Book => Vec::new(),
        };
        let dragging = self.dragging.as_ref().map(|d| d.chapter.clone());
        let mut lanes = div().flex_1().min_h_0().w(px(width)).flex().flex_col();
        for (i, lane) in layout.lanes.iter().enumerate() {
            let color = lane_color(&self.book, &lane.id);
            let mut track = div()
                .id(ElementId::Name(format!("timeline-track-{i}").into()))
                .relative()
                .flex_1()
                .min_h(px(ROW_MIN_HEIGHT))
                .w(px(width))
                .rounded(px(4.0))
                .bg(p.page.solid())
                .when(i > 0, |el| {
                    el.border_t(px(0.5)).border_color(p.desk.solid())
                })
                .on_click({
                    let entity = entity.clone();
                    let lane = lane.id.clone();
                    move |e: &ClickEvent, _, cx| {
                        if e.click_count() != 2 {
                            return;
                        }
                        entity.update(cx, |t, cx| {
                            let Some(body) = t.body.get() else {
                                return;
                            };
                            let track_left = f32::from(body.origin.x) + RAIL_WIDTH - t.scroll_x();
                            let order = t
                                .layout()
                                .scale
                                .order_at(f32::from(e.position().x) - track_left);
                            t.create_at(&lane, order, cx);
                        });
                    }
                });
            // Act boundaries (where the hand has one, while dragged) and
            // the pins run down every track.
            let acts = self
                .book
                .acts
                .iter()
                .filter_map(|a| {
                    a.start_order
                        .map(|s| self.mark_order(&Mark::Act(a.id.clone()), s))
                })
                .map(|o| (scale.x(o), p.desk));
            for (x, color) in acts.chain(pin_lines.iter().map(|x| (*x, p.rule))) {
                track = track.child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left(px(x))
                        .w(px(if color == p.rule { 1.0 } else { 0.5 }))
                        .bg(color.solid()),
                );
            }
            for c in &lane.clips {
                let Some(order) = layout.axis.order(c) else {
                    continue;
                };
                track = track.child(self.clip(
                    c,
                    order,
                    color,
                    layout,
                    dragging.as_deref(),
                    window,
                    cx,
                ));
            }
            if lane.clips.is_empty() {
                let empty = t(cx, keys::bottom_timeline::empty::NO_CHAPTERS_IN_STORYLINE);
                track = track.child(
                    div()
                        .id(ElementId::Name(format!("timeline-empty-{i}").into()))
                        .role(gpui::Role::Label)
                        .aria_label(empty.clone())
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left_0()
                        .right_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .italic()
                        .font_role(Role::Ui)
                        .type_px(s.secondary - 1.0, s.secondary)
                        .text_color(p.muted().solid())
                        .child(empty),
                );
            }
            lanes = lanes.child(track);
        }
        let links = self.links(layout, p);
        let content = div()
            .id("timeline-content")
            .relative()
            .h_full()
            .w(px(width))
            .flex()
            .flex_col()
            .child(strip)
            .child(lanes)
            .child(links)
            .on_scroll(cx.listener(|t, e: &ScrollEvent, window, cx| t.wheel(e, window, cx)));
        div()
            .id("timeline-scroll")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_x_scroll()
            .track_scroll(&self.scroll)
            .child(content)
            .into_any_element()
    }

    /// One chapter's slab on its lane.
    #[allow(clippy::too_many_arguments)]
    fn clip(
        &self,
        c: &ChapterInfo,
        order: f64,
        color: Rgb,
        layout: &Layout,
        dragging: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entity = cx.entity();
        let scale = layout.scale;
        let selected = matches!(&self.current, Some(Target::Chapter(id)) if id.as_str() == c.id);
        let title = untitled(&c.title, cx);
        let w = scale.clip_width();
        let id = c.id.clone();
        let drag = ClipDrag {
            chapter: c.id.clone(),
            title: title.clone(),
            status: c.status.clone(),
            color,
            size: (w, 0.0),
            from_drawer: false,
            timeline: entity.downgrade(),
        };
        // As high as its lane (the card's wrapper has no height of its own).
        let h = self
            .rows(layout)
            .first()
            .map_or(ROW_MIN_HEIGHT, |r| r.height)
            - 1.0;
        let slab = slab(
            ElementId::Name(format!("timeline-clip-{}", c.id).into()),
            title,
            &c.status,
            color,
            selected,
            window,
            cx,
        )
        .w(px(w))
        .h(px(h))
        .cursor_grab()
        .when(dragging == Some(c.id.as_str()), |el| el.opacity(0.0))
        .on_click({
            let entity = entity.clone();
            move |e: &ClickEvent, _, cx| {
                cx.stop_propagation();
                let Ok(id) = id.parse() else {
                    return;
                };
                let how = if e.click_count() > 1 {
                    Open::KEEP
                } else {
                    Open::PREVIEW
                };
                entity.update(cx, |t, cx| t.open(Target::Chapter(id), how, cx));
            }
        })
        .on_drag(drag, {
            let entity = entity.clone();
            move |drag, offset, window, cx| {
                let mut drag = drag.clone();
                let mouse = window.mouse_position();
                let grab = (f32::from(offset.x), f32::from(offset.y));
                // Taken where the slab is: its top left under the pointer
                // less the grab.
                let weight = Weight {
                    spring: Rc::new(RefCell::new(SlabSpring::new(
                        f32::from(mouse.x) - grab.0,
                        f32::from(mouse.y) - grab.1,
                    ))),
                    start_y: f32::from(mouse.y),
                    clock: Instant::now(),
                };
                entity.update(cx, |t, cx| {
                    // The slab is as high as its lane.
                    if let Some(body) = t.body.get() {
                        let n = t.layout().lanes.len().max(1) as f32;
                        drag.size.1 = (f32::from(body.size.height) - STRIP_HEIGHT) / n - 1.0;
                    }
                    t.dragging = Some(Dragging {
                        chapter: drag.chapter.clone(),
                        grab_x: grab.0.clamp(0.0, drag.size.0),
                        grab_y: grab.1,
                        over: None,
                        weight: Some(weight.clone()),
                    });
                    cx.notify();
                });
                cx.new(|_| Ghost {
                    drag,
                    grab,
                    weight: Some(weight),
                })
            }
        });
        div()
            .absolute()
            .top_0()
            .left(px(scale.x(order)))
            .child(self.with_card(
                format!("timeline-clip-card-{}", c.id),
                slab,
                cards::CardOf::Chapter(c.id.clone()),
                cx,
            ))
            .into_any_element()
    }

    /// The dashed curves between lanes (`btl-crosslinks`).
    fn links(&self, layout: &Layout, p: &Palette) -> AnyElement {
        let links = layout.links.clone();
        let scale = layout.scale;
        let n = layout.lanes.len();
        let fallback = p.ink(4);
        canvas(
            |_, _, _| (),
            move |bounds, _, window, _| {
                if n == 0 {
                    return;
                }
                let top = f32::from(bounds.origin.y) + STRIP_HEIGHT;
                let row = (f32::from(bounds.size.height) - STRIP_HEIGHT) / n as f32;
                let left = f32::from(bounds.origin.x);
                let half = scale.clip_width() / 2.0;
                for link in &links {
                    let (x1, y1) = (
                        left + scale.x(link.from.0) + half,
                        top + row * (link.from.1 as f32 + 0.5),
                    );
                    let (x2, y2) = (
                        left + scale.x(link.to.0) + half,
                        top + row * (link.to.1 as f32 + 0.5),
                    );
                    let mid = (y1 + y2) / 2.0;
                    let mut b = PathBuilder::stroke(px(1.0)).dash_array(&[px(2.0), px(3.0)]);
                    b.move_to(point(px(x1), px(y1)));
                    b.cubic_bezier_to(
                        point(px(x2), px(y2)),
                        point(px(x1), px(mid)),
                        point(px(x2), px(mid)),
                    );
                    let color = link.color.as_deref().and_then(color_of).unwrap_or(fallback);
                    if let Ok(path) = b.build() {
                        window.paint_path(path, color.alpha(0.6));
                    }
                }
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .into_any_element()
    }
}

/// A header toggle (`.btl__toggle`): its word and count in index type, the
/// resting glass line while off, the still selected glass while on; 未放置
/// carries a small chevron.
#[allow(clippy::too_many_arguments)]
fn toggle(
    id: &'static str,
    label: SharedString,
    count: usize,
    on: bool,
    chevron: bool,
    click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> gpui::Stateful<gpui::Div> {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    glass::glass_box(
        id,
        GlassKind::Rest,
        Mode::default(),
        on,
        Spec::new(Tone::Clear, radius::SM),
        window,
        cx,
    )
    .h(px(20.0))
    .px(px(8.0))
    .flex()
    .flex_row()
    .items_center()
    .gap(px(6.0))
    .rounded(px(radius::SM))
    .font_role(Role::Index)
    .type_px(s.caption - 2.0, s.caption)
    .text_color(if on {
        p.ink(1).solid()
    } else {
        p.muted().solid()
    })
    .cursor_pointer()
    .child(label)
    .child(div().text_color(p.muted().solid()).child(count.to_string()))
    .when(chevron, |el| {
        el.child(sand::icon(Icon::ChevronDown, 8.0, p.muted().solid()))
    })
    .on_click(click)
}
