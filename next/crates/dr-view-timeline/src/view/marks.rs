//! The marks over the tracks: the narrative axis's time pins (the 0.1
//! client's `TimelinePin`) and the act rail's acts (`ActRail`).
//!
//! - **Time pins** (narrative order): a glass label on the time axis and a
//!   1 px line down every track. Drag it sideways to move it; double-click
//!   it to rename it (Enter keeps, Esc puts the name back, an empty name
//!   deletes it). A double click on the bare axis, or the axis head's ＋
//!   (the middle of what shows), puts a new pin there, its name ready to
//!   type. Its hover card: 重命名, 绑定构想… (the ideas no pin or act holds
//!   unfold in the card), or for a bound one 打开构想 and 解绑; last 删除标记.
//!   A click on a bound pin opens its idea.
//! - **Acts** (reading order): each act's chip at its boundary, a handle
//!   on the boundary to drag it between its neighbours, a double click on
//!   the chip to rename it, a double click on the bare rail (or the rail
//!   head's ＋) for a new act there, named by its place (第三幕). Its hover
//!   card: 重命名, 在此处开始新幕 (where the pointer came onto the chip),
//!   绑定构想… or 打开幕笔记 / 解绑构想, and last 删除此幕.
//!
//! Every write is F3's (`time_pin.*`, `act.*`), off the main thread; the
//! book's next snapshot shows it.

use super::*;

use dr_ui::components::{CardAction, CardBody, HoverCard, menu::RowIcon};
use dr_ui::input::field::{FieldEvent, TextField};
use dr_workspace::commands::{
    BookIn, EntityIn,
    chapter::{ActCreate, ActCreateIn, ActDelete, ActUpdate, ActUpdateIn},
    time_pin::{
        TimePinCreate, TimePinCreateIn, TimePinDelete, TimePinInfo, TimePinList, TimePinUpdate,
        TimePinUpdateIn,
    },
};
use gpui::{Focusable as _, Task};

/// One write of the queue.
pub(super) type WriteJob = Box<dyn FnOnce() + Send>;

/// A time pin or an act.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mark {
    Pin(String),
    Act(String),
}

/// A pin or an act boundary in the hand.
#[derive(Clone)]
pub struct MarkDrag {
    pub mark: Mark,
    /// The pointer's x and the tracks' scroll when it was taken, and the
    /// mark's order then.
    start_x: f32,
    start_scroll: f32,
    from: f64,
    /// Where it would go now.
    pub order: f64,
}

/// A mark being renamed in place.
pub(super) struct Editing {
    pub mark: Mark,
    pub field: Entity<TextField>,
    _sub: Subscription,
}

/// What a pin or a boundary in the hand shows: nothing; the mark itself
/// moves on the rail.
struct Nothing;

impl Render for Nothing {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

/// `第N幕` (the 0.1 client's `defaultActName`).
pub fn default_act_name(n: usize) -> String {
    const DIGITS: [&str; 10] = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    if !(1..=99).contains(&n) {
        return format!("第{n}幕");
    }
    if n < 10 {
        return format!("第{}幕", DIGITS[n]);
    }
    let (tens, ones) = (n / 10, n % 10);
    let tens = if tens == 1 {
        "十".to_owned()
    } else {
        format!("{}十", DIGITS[tens])
    };
    let ones = if ones == 0 { "" } else { DIGITS[ones] };
    format!("第{tens}{ones}幕")
}

impl BottomTimeline {
    // ---- reading ------------------------------------------------------------

    /// The time pins as last read (tests).
    pub fn pins(&self) -> Rc<Vec<TimePinInfo>> {
        self.pins.clone()
    }

    /// Reads the time pins for the book now shown.
    pub(super) fn load_pins(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        if self.book.id.is_empty() {
            return;
        }
        let book = self.book.id.clone();
        let task = cx.background_executor().spawn(async move {
            lib.run::<TimePinList>(&Actor::User, BookIn { book })
                .map(|o| o.output)
        });
        self.pins_task = Some(cx.spawn(async move |this, cx| {
            let pins = task.await;
            this.update(cx, |t, cx| {
                match pins {
                    Ok(pins) => t.pins = Rc::new(pins),
                    Err(e) => log::warn!("timeline: the time pins could not be read: {e}"),
                }
                t.pins_task = None;
                cx.notify();
            })
            .ok();
        }));
    }

    /// Every act boundary keeps its focus from frame to frame (←/→ move a
    /// focused one); called before drawing.
    pub(super) fn keep_act_focus(&mut self, cx: &mut Context<Self>) {
        let live: Vec<String> = self.book.acts.iter().map(|a| a.id.clone()).collect();
        self.act_focus.retain(|id, _| live.contains(id));
        for id in live {
            self.act_focus
                .entry(id)
                .or_insert_with(|| cx.focus_handle().tab_index(0).tab_stop(true));
        }
    }

    /// Act `id`'s boundary handle's focus (tests).
    pub fn act_focus(&self, id: &str) -> Option<gpui::FocusHandle> {
        self.act_focus.get(id).cloned()
    }

    /// The pin or act boundary in the hand (tests).
    pub fn mark_in_hand(&self) -> Option<MarkDrag> {
        self.mark_drag.clone()
    }

    /// The order a mark is drawn at: where it is, or where the hand has it.
    pub(super) fn mark_order(&self, mark: &Mark, at: f64) -> f64 {
        match (&self.mark_drag, mark) {
            (Some(d), _) if &d.mark == mark => d.order,
            (_, Mark::Act(id)) => self.nudged.get(id).copied().unwrap_or(at),
            _ => at,
        }
    }

    /// Moves act `id`'s boundary one pixel's worth (`dir` −1 or 1) between
    /// its neighbours (←/→ on a focused boundary, `moveBoundaryFromKeyboard`).
    pub fn nudge_act(&mut self, id: &str, dir: f64, cx: &mut Context<Self>) {
        let Some(at) = self
            .book
            .acts
            .iter()
            .find(|a| a.id == id)
            .and_then(|a| a.start_order)
            .map(|s| self.nudged.get(id).copied().unwrap_or(s))
        else {
            return;
        };
        let unit = f64::from(self.layout().scale.unit());
        let (lo, hi) = self.act_bounds(id);
        let next = (at + dir / unit).clamp(lo, hi);
        if (next - at).abs() < 1e-12 {
            return;
        }
        self.nudged.insert(id.to_owned(), next);
        let mut edit = self.act_edit(id);
        edit.start_order = Some(Some(next));
        self.update_act(edit, cx);
        cx.notify();
    }

    /// The ideas no pin or act holds, most recent first as F3 lists them.
    fn free_ideas(&self) -> Vec<(String, SharedString)> {
        let held: Vec<&str> = self
            .pins
            .iter()
            .filter_map(|p| p.idea.as_deref())
            .chain(self.book.acts.iter().filter_map(|a| a.drift.as_deref()))
            .collect();
        self.book
            .ideas
            .iter()
            .filter(|i| !i.trashed && !held.contains(&i.id.as_str()))
            .map(|i| (i.id.clone(), i.title.clone().into()))
            .collect()
    }

    fn idea_title(&self, id: &str, cx: &App) -> SharedString {
        self.book
            .ideas
            .iter()
            .find(|i| i.id == id)
            .map(|i| untitled(&i.title, cx))
            .unwrap_or_else(|| t(cx, keys::common::UNTITLED))
    }

    // ---- writing ------------------------------------------------------------

    /// Runs `f` on the timeline's write queue: the pins' and acts' writes
    /// land in the order they were asked for (four quick ←/→ presses end
    /// where the last one put the boundary), each off the main thread.
    fn write(
        &mut self,
        what: &'static str,
        cx: &mut Context<Self>,
        f: impl FnOnce(&Library, String) -> Result<(), dr_workspace::WsError> + Send + 'static,
    ) -> Option<Task<Result<(), dr_workspace::WsError>>> {
        let lib = self.lib.clone()?;
        let book = self.book.id.clone();
        let (done, out) = futures::channel::oneshot::channel();
        let job: WriteJob = Box::new(move || {
            let result = f(&lib, book);
            if let Err(e) = &result {
                log::warn!("timeline: {what} failed: {e}");
            }
            let _ = done.send(result);
        });
        self.writer(cx).unbounded_send(job).ok()?;
        Some(
            cx.background_executor()
                .spawn(async move { out.await.unwrap_or(Ok(())) }),
        )
    }

    /// The write queue, started the first time it is needed.
    fn writer(
        &mut self,
        cx: &mut Context<Self>,
    ) -> futures::channel::mpsc::UnboundedSender<WriteJob> {
        if let Some((tx, _)) = &self.writes {
            return tx.clone();
        }
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<WriteJob>();
        let task = cx.background_executor().spawn(async move {
            use futures::StreamExt as _;
            while let Some(job) = rx.next().await {
                job();
            }
        });
        self.writes = Some((tx.clone(), task));
        tx
    }

    /// A new pin at `order`, its name ready to type.
    pub fn add_pin(&mut self, order: f64, cx: &mut Context<Self>) {
        let (Some(lib), true) = (self.lib.clone(), order.is_finite()) else {
            return;
        };
        let book = self.book.id.clone();
        let label = t(cx, keys::bottom_timeline::marker::DEFAULT_LABEL).to_string();
        let task = cx.background_executor().spawn(async move {
            lib.run::<TimePinCreate>(
                &Actor::User,
                TimePinCreateIn {
                    book,
                    narrative_order: order,
                    label,
                    idea: None,
                    id: None,
                },
            )
            .map(|o| o.output.id)
        });
        cx.spawn(async move |this, cx| match task.await {
            Ok(id) => {
                this.update(cx, |t, cx| {
                    t.rename_next = Some(Mark::Pin(id));
                    t.load_pins(cx);
                })
                .ok();
            }
            Err(e) => log::warn!("timeline: making a time pin failed: {e}"),
        })
        .detach();
    }

    pub fn update_pin(&mut self, input: TimePinUpdateIn, cx: &mut Context<Self>) {
        if let Some(task) = self.write("changing a time pin", cx, move |lib, _| {
            lib.run::<TimePinUpdate>(&Actor::User, input).map(|_| ())
        }) {
            self.reload_after(task, cx);
        }
    }

    pub fn delete_pin(&mut self, id: &str, cx: &mut Context<Self>) {
        let id = id.to_owned();
        if let Some(task) = self.write("deleting a time pin", cx, move |lib, book| {
            lib.run::<TimePinDelete>(&Actor::User, EntityIn { book, id })
                .map(|_| ())
        }) {
            self.reload_after(task, cx);
        }
    }

    fn pin_edit(&self, id: &str) -> TimePinUpdateIn {
        TimePinUpdateIn {
            book: self.book.id.clone(),
            id: id.to_owned(),
            narrative_order: None,
            label: None,
            idea: None,
        }
    }

    /// Reads the pins again once `task` wrote.
    fn reload_after(
        &mut self,
        task: Task<Result<(), dr_workspace::WsError>>,
        cx: &mut Context<Self>,
    ) {
        cx.spawn(async move |this, cx| {
            task.await.ok();
            this.update(cx, |t, cx| t.load_pins(cx)).ok();
        })
        .detach();
    }

    /// A new act starting at `order`, named by its place among the acts.
    pub fn add_act(&mut self, order: f64, cx: &mut Context<Self>) {
        if !order.is_finite()
            || self
                .book
                .acts
                .iter()
                .any(|a| a.start_order.is_some_and(|s| (s - order).abs() < 1e-9))
        {
            return;
        }
        let place = self
            .book
            .acts
            .iter()
            .filter(|a| a.start_order.is_none_or(|s| s < order))
            .count()
            + 1;
        let name = default_act_name(place);
        if let Some(task) = self.write("making an act", cx, move |lib, book| {
            lib.run::<ActCreate>(
                &Actor::User,
                ActCreateIn {
                    book,
                    name,
                    start_chapter: None,
                    start_order: Some(order),
                    color: None,
                    id: None,
                },
            )
            .map(|_| ())
        }) {
            task.detach();
        }
    }

    pub fn update_act(&mut self, input: ActUpdateIn, cx: &mut Context<Self>) {
        if let Some(task) = self.write("changing an act", cx, move |lib, _| {
            lib.run::<ActUpdate>(&Actor::User, input).map(|_| ())
        }) {
            task.detach();
        }
    }

    pub fn delete_act(&mut self, id: &str, cx: &mut Context<Self>) {
        let id = id.to_owned();
        if let Some(task) = self.write("deleting an act", cx, move |lib, book| {
            lib.run::<ActDelete>(&Actor::User, EntityIn { book, id })
                .map(|_| ())
        }) {
            task.detach();
        }
    }

    fn act_edit(&self, id: &str) -> ActUpdateIn {
        ActUpdateIn {
            book: self.book.id.clone(),
            id: id.to_owned(),
            name: None,
            color: None,
            start_chapter: None,
            start_order: None,
            drift: None,
        }
    }

    /// Where an act's boundary may go: strictly between its neighbours'
    /// (after a head act, from the axis's start).
    pub(super) fn act_bounds(&self, id: &str) -> (f64, f64) {
        let axis_start = self.layout().scale.min_order;
        let starts: Vec<(String, f64)> = self
            .book
            .acts
            .iter()
            .filter_map(|a| a.start_order.map(|s| (a.id.clone(), s)))
            .collect();
        let i = starts.iter().position(|(a, _)| a == id);
        let lo = i
            .and_then(|i| i.checked_sub(1))
            .map_or(axis_start, |j| starts[j].1 + 0.01);
        let hi = i
            .and_then(|i| starts.get(i + 1))
            .map_or(f64::INFINITY, |(_, s)| s - 0.01);
        (lo, hi)
    }

    // ---- renaming -----------------------------------------------------------

    pub fn editing(&self) -> Option<Mark> {
        self.editing.as_ref().map(|e| e.mark.clone())
    }

    /// Puts `mark`'s name in a field, selected.
    pub fn start_rename(&mut self, mark: Mark, window: &mut Window, cx: &mut Context<Self>) {
        let text = match &mark {
            Mark::Pin(id) => self
                .pins
                .iter()
                .find(|p| &p.id == id)
                .map(|p| p.label.clone()),
            Mark::Act(id) => self
                .book
                .acts
                .iter()
                .find(|a| &a.id == id)
                .map(|a| a.name.clone()),
        };
        let Some(text) = text else {
            return;
        };
        let field = cx.new(|cx| {
            TextField::new("timeline-rename", window, cx)
                .small()
                .with_text(text)
        });
        let sub = cx.subscribe_in(
            &field,
            window,
            |t, field, e: &FieldEvent, window, cx| match e {
                FieldEvent::Submitted(_) | FieldEvent::Blurred => {
                    let text = field.read(cx).text().trim().to_owned();
                    t.finish_rename(Some(text), window, cx);
                }
                FieldEvent::Cancelled => t.finish_rename(None, window, cx),
                FieldEvent::Changed(_) => {}
            },
        );
        field.update(cx, |f, cx| f.select_all_text(cx));
        field.focus_handle(cx).focus(window, cx);
        self.editing = Some(Editing {
            mark,
            field,
            _sub: sub,
        });
        cx.notify();
    }

    /// Ends a rename: `Some(text)` keeps it (a pin with none goes, an act
    /// keeps its name), `None` puts the name back.
    fn finish_rename(&mut self, text: Option<String>, _: &mut Window, cx: &mut Context<Self>) {
        let Some(editing) = self.editing.take() else {
            return;
        };
        cx.notify();
        let Some(text) = text else {
            return;
        };
        match editing.mark {
            Mark::Pin(id) => {
                let old = self
                    .pins
                    .iter()
                    .find(|p| p.id == id)
                    .map(|p| p.label.clone());
                if text.is_empty() {
                    self.delete_pin(&id, cx);
                } else if old.as_deref() != Some(text.as_str()) {
                    let mut edit = self.pin_edit(&id);
                    edit.label = Some(text);
                    self.update_pin(edit, cx);
                }
            }
            Mark::Act(id) => {
                let old = self.book.acts.iter().find(|a| a.id == id).map(|a| &a.name);
                if !text.is_empty() && old != Some(&text) {
                    let mut edit = self.act_edit(&id);
                    edit.name = Some(text);
                    self.update_act(edit, cx);
                }
            }
        }
    }

    // ---- dragging -----------------------------------------------------------

    pub(super) fn mark_drag_moved(&mut self, e: &DragMoveEvent<MarkDrag>, cx: &mut Context<Self>) {
        self.drag_pointer = Some(e.event.position);
        self.aim_mark(e.event.position, cx);
        cx.notify();
    }

    /// Where the mark in the hand goes with the pointer at `position`, the
    /// tracks scrolled since it was taken counted in.
    pub(super) fn aim_mark(&mut self, position: gpui::Point<Pixels>, cx: &mut Context<Self>) {
        let Some(d) = self.mark_drag.clone() else {
            return;
        };
        let scale = self.layout().scale;
        let dx = f32::from(position.x) - d.start_x + (self.scroll_x() - d.start_scroll);
        let mut order = scale.order_at(scale.x(d.from) + dx);
        if let Mark::Act(id) = &d.mark {
            let id = id.clone();
            let (lo, hi) = self.act_bounds(&id);
            order = order.clamp(lo, hi);
        }
        if let Some(d) = self.mark_drag.as_mut()
            && d.order != order
        {
            d.order = order;
            cx.notify();
        }
    }

    pub(super) fn mark_dropped(&mut self, cx: &mut Context<Self>) {
        let Some(d) = self.mark_drag.take() else {
            return;
        };
        cx.notify();
        if (d.order - d.from).abs() < 1e-9 || !d.order.is_finite() {
            return;
        }
        match d.mark {
            Mark::Pin(id) => {
                let mut edit = self.pin_edit(&id);
                edit.narrative_order = Some(d.order);
                // Drawn there until the pins are read again.
                if let Some(p) = Rc::make_mut(&mut self.pins).iter_mut().find(|p| p.id == id) {
                    p.narrative_order = d.order;
                }
                self.update_pin(edit, cx);
            }
            Mark::Act(id) => {
                let mut edit = self.act_edit(&id);
                edit.start_order = Some(Some(d.order));
                self.update_act(edit, cx);
            }
        }
    }

    /// Moves `mark` to `order` as a drag and drop would (tests).
    pub fn move_mark(&mut self, mark: Mark, order: f64, cx: &mut Context<Self>) {
        let from = match &mark {
            Mark::Pin(id) => self
                .pins
                .iter()
                .find(|p| &p.id == id)
                .map(|p| p.narrative_order),
            Mark::Act(id) => self
                .book
                .acts
                .iter()
                .find(|a| &a.id == id)
                .and_then(|a| a.start_order),
        };
        let Some(from) = from else {
            return;
        };
        let order = match &mark {
            Mark::Act(id) => {
                let (lo, hi) = self.act_bounds(id);
                order.clamp(lo, hi)
            }
            Mark::Pin(_) => order,
        };
        self.mark_drag = Some(MarkDrag {
            mark,
            start_x: 0.0,
            start_scroll: 0.0,
            from,
            order,
        });
        self.mark_dropped(cx);
    }

    fn drag_handle(
        &self,
        mark: Mark,
        from: f64,
        el: gpui::Stateful<gpui::Div>,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let entity = cx.entity();
        let drag = MarkDrag {
            mark,
            start_x: 0.0,
            start_scroll: 0.0,
            from,
            order: from,
        };
        el.on_drag(drag, move |drag, _, window, cx| {
            let mut drag = drag.clone();
            drag.start_x = f32::from(window.mouse_position().x);
            entity.update(cx, |t, cx| {
                drag.start_scroll = t.scroll_x();
                t.mark_drag = Some(drag);
                cx.notify();
            });
            cx.new(|_| Nothing)
        })
    }

    // ---- drawing ------------------------------------------------------------

    /// The time axis (`btl-axis`): the pins' labels; a double click on the
    /// bare axis puts a pin there.
    pub(super) fn time_axis(
        &self,
        layout: &Layout,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let scale = layout.scale;
        let entity = cx.entity();
        let mut axis = div()
            .id("timeline-time-axis")
            .debug_selector(|| "timeline-time-axis".into())
            .relative()
            .h(px(STRIP_HEIGHT))
            .flex_none()
            .w(px(scale.width()))
            .bg(p.paper.solid())
            .on_click({
                let entity = entity.clone();
                move |e: &ClickEvent, _, cx| {
                    if e.click_count() != 2 {
                        return;
                    }
                    let x = f32::from(e.position().x);
                    entity.update(cx, |t, cx| {
                        if let Some(order) = t.order_at_window_x(x) {
                            t.add_pin(order, cx);
                        }
                    });
                }
            });
        for pin in self.pins.iter() {
            axis = axis.child(self.pin(pin, layout, window, cx));
        }
        axis.into_any_element()
    }

    /// The order under window `x` on the tracks.
    pub(super) fn order_at_window_x(&self, x: f32) -> Option<f64> {
        let body = self.body.get()?;
        let track_left = f32::from(body.origin.x) + RAIL_WIDTH - self.scroll_x();
        Some(self.layout().scale.order_at(x - track_left))
    }

    /// The order in the middle of what shows (the heads' ＋).
    pub(super) fn middle_order(&self) -> Option<f64> {
        let body = self.body.get()?;
        let x =
            f32::from(body.origin.x) + RAIL_WIDTH + (f32::from(body.size.width) - RAIL_WIDTH) / 2.0;
        self.order_at_window_x(x)
    }

    fn pin(
        &self,
        pin: &TimePinInfo,
        layout: &Layout,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let mark = Mark::Pin(pin.id.clone());
        let x = layout.scale.x(self.mark_order(&mark, pin.narrative_order));
        let editing = self
            .editing
            .as_ref()
            .filter(|e| e.mark == mark)
            .map(|e| e.field.clone());
        let bound = pin.idea.clone();
        let label: SharedString = match &bound {
            Some(idea) => pin
                .idea_title
                .clone()
                .filter(|t| !t.trim().is_empty())
                .map(SharedString::from)
                .unwrap_or_else(|| self.idea_title(idea, cx)),
            None => pin.label.clone().into(),
        };
        let entity = cx.entity();
        let chip = glass::glass_box(
            ElementId::Name(format!("timeline-pin-{}", pin.id).into()),
            GlassKind::Rest,
            Mode::default(),
            editing.is_some(),
            Spec::new(Tone::Clear, 2.0),
            window,
            cx,
        )
        .h(px(STRIP_HEIGHT - 4.0))
        .px(px(6.0))
        .rounded(px(2.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(4.0))
        .font_role(Role::Index)
        .type_px(10.0, 12.0)
        .text_color(p.ink(2).solid())
        .cursor_grab()
        .when_some(bound.clone(), |el, idea| {
            el.child(
                KindMark::new(
                    ElementId::Name(format!("timeline-pin-mark-{}", pin.id).into()),
                    sand::Kind::Drift { loose: false },
                )
                .color(p.accent),
            )
            .on_click({
                let entity = entity.clone();
                move |e: &ClickEvent, _, cx| {
                    if e.click_count() == 1
                        && let Ok(id) = idea.parse()
                    {
                        entity.update(cx, |t, cx| t.open(Target::Idea(id), Open::KEEP, cx));
                    }
                }
            })
        })
        .when(bound.is_none(), |el| {
            let id = mark.clone();
            el.on_click({
                let entity = entity.clone();
                move |e: &ClickEvent, window, cx| {
                    if e.click_count() == 2 {
                        let id = id.clone();
                        entity.update(cx, |t, cx| t.start_rename(id, window, cx));
                    }
                }
            })
        })
        .child(match &editing {
            Some(field) => div().w(px(96.0)).child(field.clone()).into_any_element(),
            None => div()
                .whitespace_nowrap()
                .child(label.clone())
                .into_any_element(),
        });
        let chip = if editing.is_some() {
            chip.into_any_element()
        } else {
            let chip = self.drag_handle(mark.clone(), pin.narrative_order, chip, cx);
            let key = format!("timeline-pin-card-{}", pin.id);
            let (entity, pin) = (entity.clone(), pin.clone());
            self.held(
                &key,
                HoverCard::new(
                    ElementId::Name(key.clone().into()),
                    chip,
                    move |window, cx| pin_card(&entity, &pin, window, cx),
                ),
            )
            .into_any_element()
        };
        div()
            .absolute()
            .top(px(2.0))
            .left(px(x))
            .child(chip)
            .into_any_element()
    }

    /// The act rail (`ActRail`): each act's chip at its boundary, the
    /// boundary's handle; a double click on the bare rail starts an act.
    pub(super) fn act_rail(
        &self,
        layout: &Layout,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let scale = layout.scale;
        let entity = cx.entity();
        let mut rail = div()
            .id("timeline-act-rail")
            .debug_selector(|| "timeline-act-rail".into())
            .relative()
            .h(px(STRIP_HEIGHT))
            .flex_none()
            .w(px(scale.width()))
            .bg(p.paper.solid())
            .border_b_1()
            .border_color(p.rule.solid())
            .on_click({
                let entity = entity.clone();
                move |e: &ClickEvent, _, cx| {
                    if e.click_count() != 2 {
                        return;
                    }
                    let x = f32::from(e.position().x);
                    entity.update(cx, |t, cx| {
                        if let Some(order) = t.order_at_window_x(x) {
                            t.add_act(order, cx);
                        }
                    });
                }
            });
        for (i, info) in self.book.acts.iter().enumerate() {
            let mark = Mark::Act(info.id.clone());
            let start = info.start_order.map(|s| self.mark_order(&mark, s));
            let x = start.map_or(0.0, |o| scale.x(o));
            if let Some(from) = info.start_order {
                let focus = self
                    .act_focus
                    .get(&info.id)
                    .cloned()
                    .unwrap_or_else(|| cx.focus_handle());
                let held = self.mark_drag.as_ref().is_some_and(|d| d.mark == mark)
                    || focus.is_focused(window);
                let id = info.id.clone();
                let handle = div()
                    .id(ElementId::Name(
                        format!("timeline-act-edge-{}", info.id).into(),
                    ))
                    .track_focus(&focus)
                    .role(gpui::Role::Slider)
                    .aria_label(t(cx, keys::bottom_timeline::act::DRAG_BOUNDARY))
                    // A press takes the keys; ←/→ then move it a pixel at a time.
                    .on_mouse_down(gpui::MouseButton::Left, {
                        let focus = focus.clone();
                        move |_, window, cx| focus.focus(window, cx)
                    })
                    .on_key_down({
                        let entity = entity.clone();
                        move |e: &gpui::KeyDownEvent, _, cx| {
                            let m = &e.keystroke.modifiers;
                            if m.control || m.alt || m.platform || m.function {
                                return;
                            }
                            let dir = match e.keystroke.key.as_str() {
                                "left" => -1.0,
                                "right" => 1.0,
                                _ => return,
                            };
                            cx.stop_propagation();
                            entity.update(cx, |t, cx| t.nudge_act(&id, dir, cx));
                        }
                    })
                    .debug_selector({
                        let id = info.id.clone();
                        move || format!("timeline-act-edge-{id}")
                    })
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px(x - 3.5))
                    .w(px(7.0))
                    .cursor_col_resize()
                    .group("act-edge")
                    .child(
                        div()
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .left(px(3.0))
                            .w(px(if held { 2.0 } else { 1.0 }))
                            .bg(if held {
                                p.accent.solid()
                            } else {
                                p.rule.solid()
                            })
                            .group_hover("act-edge", |st| st.w(px(2.0)).bg(p.accent.solid())),
                    );
                rail = rail.child(self.drag_handle(mark.clone(), from, handle, cx));
            }
            rail = rail.child(
                div()
                    .absolute()
                    .top(px(2.0))
                    .bottom(px(2.0))
                    .left(px(x))
                    .px(px(6.0))
                    .flex()
                    .items_center()
                    .child(self.act_chip(i, info, layout, window, cx)),
            );
        }
        rail.into_any_element()
    }

    fn act_chip(
        &self,
        i: usize,
        info: &dr_workspace::dto::ActInfo,
        layout: &Layout,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let mark = Mark::Act(info.id.clone());
        let editing = self
            .editing
            .as_ref()
            .filter(|e| e.mark == mark)
            .map(|e| e.field.clone());
        let name = layout
            .acts
            .get(i)
            .map(|a| a.name.clone())
            .unwrap_or_else(|| info.name.clone());
        let color = info.color.as_deref().and_then(color_of);
        let entity = cx.entity();
        let chip = glass::glass_box(
            ElementId::Name(format!("timeline-act-{i}").into()),
            GlassKind::Rest,
            Mode::default(),
            editing.is_some(),
            Spec::new(
                color.map_or(Tone::Color(p.glass_clear.mix(p.ink(3), 0.5)), Tone::Color),
                2.0,
            ),
            window,
            cx,
        )
        .px(px(7.0))
        .py(px(2.0))
        .rounded(px(2.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(5.0))
        .when_some(info.drift.clone(), |el, _| {
            el.child(
                KindMark::new(
                    ElementId::Name(format!("timeline-act-note-{}", info.id).into()),
                    sand::Kind::Drift { loose: false },
                )
                .color(p.accent),
            )
        })
        .child(match &editing {
            Some(field) => div().w(px(96.0)).child(field.clone()).into_any_element(),
            None => div()
                .font_role(Role::Structure)
                .type_px(11.0, 13.0)
                .weight(weight::MEDIUM)
                .text_color(p.ink(2).solid())
                .whitespace_nowrap()
                .child(name)
                .into_any_element(),
        })
        .child(
            div()
                .font_role(Role::Index)
                .type_px(9.0, 13.0)
                .text_color(p.ink(4).solid())
                .whitespace_nowrap()
                .child(tf(
                    cx,
                    keys::bottom_timeline::act::CHAPTER_COUNT,
                    &[("count", &info.chapters.len())],
                )),
        )
        .on_click({
            let (entity, mark) = (entity.clone(), mark.clone());
            move |e: &ClickEvent, window, cx| {
                cx.stop_propagation();
                if e.click_count() == 2 {
                    let mark = mark.clone();
                    entity.update(cx, |t, cx| t.start_rename(mark, window, cx));
                }
            }
        })
        // Where the pointer is on the chip: 在此处开始新幕 splits there.
        .on_mouse_move({
            let spot = self.act_spot.clone();
            let entity = entity.clone();
            move |e, _, cx| {
                if let Some(order) = entity.read(cx).order_at_window_x(f32::from(e.position.x)) {
                    spot.set(order);
                }
            }
        });
        if editing.is_some() {
            return chip.into_any_element();
        }
        let key = format!("timeline-act-card-{}", info.id);
        let (entity, act, spot) = (entity.clone(), info.clone(), self.act_spot.clone());
        self.held(
            &key,
            HoverCard::new(
                ElementId::Name(key.clone().into()),
                chip,
                move |window, cx| act_card(&entity, &act, spot.get(), i == 0, window, cx),
            ),
        )
        .into_any_element()
    }
}

/// The rows a bound or unbound mark's card offers for its idea.
fn idea_rows(
    entity: &Entity<BottomTimeline>,
    key: &str,
    mark: &Mark,
    bound: Option<&str>,
    open_label: SharedString,
    unbind_label: SharedString,
    cx: &mut App,
) -> Vec<AnyElement> {
    let mut rows = Vec::new();
    match bound {
        Some(idea) => {
            let idea = idea.to_owned();
            rows.push(
                CardAction::new(
                    ElementId::Name(format!("{key}-open-idea").into()),
                    Icon::ArrowOut,
                    open_label,
                )
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| {
                        if let Ok(id) = idea.parse() {
                            entity.update(cx, |t, cx| t.open(Target::Idea(id), Open::KEEP, cx));
                        }
                    }
                })
                .into_any_element(),
            );
            let mark = mark.clone();
            rows.push(
                CardAction::new(
                    ElementId::Name(format!("{key}-unbind").into()),
                    Icon::Close,
                    unbind_label,
                )
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| entity.update(cx, |t, cx| t.bind(&mark, None, cx))
                })
                .into_any_element(),
            );
        }
        None => {
            let open = entity.read(cx).bind_open.as_ref() == Some(mark);
            let free = entity.read(cx).free_ideas();
            let toggle_mark = mark.clone();
            rows.push(
                CardAction::new(
                    ElementId::Name(format!("{key}-bind").into()),
                    Icon::KnotLinks,
                    t(cx, keys::bottom_timeline::pin_menu::BIND_DRIFT),
                )
                .current(open)
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| {
                        entity.update(cx, |t, cx| {
                            t.bind_open = if t.bind_open.as_ref() == Some(&toggle_mark) {
                                None
                            } else {
                                Some(toggle_mark.clone())
                            };
                            cx.notify();
                        })
                    }
                })
                .into_any_element(),
            );
            if open {
                for (id, title) in free {
                    let mark = mark.clone();
                    let title = if title.trim().is_empty() {
                        t(cx, keys::common::UNTITLED)
                    } else {
                        title
                    };
                    rows.push(
                        CardAction::new(
                            ElementId::Name(format!("{key}-idea-{id}").into()),
                            RowIcon::Mark(sand::Kind::Drift { loose: false }, None),
                            title,
                        )
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| {
                                entity.update(cx, |t, cx| t.bind(&mark, Some(id.clone()), cx))
                            }
                        })
                        .into_any_element(),
                    );
                }
            }
        }
    }
    rows
}

impl BottomTimeline {
    /// Binds `idea` to `mark` (`None` unbinds; an unbound pin keeps its
    /// label, or takes the idea's title if it had none).
    pub fn bind(&mut self, mark: &Mark, idea: Option<String>, cx: &mut Context<Self>) {
        self.bind_open = None;
        match mark {
            Mark::Pin(id) => {
                let mut edit = self.pin_edit(id);
                if idea.is_none()
                    && let Some(pin) = self.pins.iter().find(|p| &p.id == id)
                    && pin.label.trim().is_empty()
                {
                    edit.label = Some(pin.idea_title.clone().unwrap_or_else(|| {
                        t(cx, keys::bottom_timeline::marker::DEFAULT_LABEL).to_string()
                    }));
                }
                edit.idea = Some(idea);
                self.update_pin(edit, cx);
            }
            Mark::Act(id) => {
                let mut edit = self.act_edit(id);
                edit.drift = Some(idea);
                self.update_act(edit, cx);
            }
        }
        cx.notify();
    }
}

fn pin_card(
    entity: &Entity<BottomTimeline>,
    pin: &TimePinInfo,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let key = format!("timeline-pin-card-{}", pin.id);
    let mark = Mark::Pin(pin.id.clone());
    let title: SharedString = match &pin.idea {
        Some(_) => pin
            .idea_title
            .clone()
            .unwrap_or_else(|| t(cx, keys::common::UNTITLED).to_string())
            .into(),
        None => pin.label.clone().into(),
    };
    let _ = window;
    let mut body = CardBody::new(ElementId::Name(format!("{key}-body").into()), title);
    if pin.idea.is_some() {
        body = body.mark(sand::Kind::Drift { loose: false }, None);
    }
    let mut first = Vec::new();
    if pin.idea.is_none() {
        let mark = mark.clone();
        first.push(
            CardAction::new(
                ElementId::Name(format!("{key}-rename").into()),
                Icon::Edit,
                t(cx, keys::bottom_timeline::pin_menu::RENAME),
            )
            .on_click({
                let entity = entity.clone();
                move |_, window, cx| {
                    let mark = mark.clone();
                    entity.update(cx, |t, cx| t.start_rename(mark, window, cx))
                }
            })
            .into_any_element(),
        );
    }
    first.extend(idea_rows(
        entity,
        &key,
        &mark,
        pin.idea.as_deref(),
        t(cx, keys::bottom_timeline::pin_menu::OPEN_DRIFT),
        t(cx, keys::bottom_timeline::pin_menu::UNBIND),
        cx,
    ));
    let id = pin.id.clone();
    let delete = CardAction::new(
        ElementId::Name(format!("{key}-delete").into()),
        Icon::Trash,
        t(cx, keys::bottom_timeline::pin_menu::DELETE_MARKER),
    )
    .danger()
    .on_click({
        let entity = entity.clone();
        move |_, _, cx| entity.update(cx, |t, cx| t.delete_pin(&id, cx))
    })
    .into_any_element();
    body.section(first).section(vec![delete]).into_any_element()
}

fn act_card(
    entity: &Entity<BottomTimeline>,
    act: &dr_workspace::dto::ActInfo,
    spot: f64,
    first_act: bool,
    _: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let key = format!("timeline-act-card-{}", act.id);
    let mark = Mark::Act(act.id.clone());
    let color = act.color.as_deref().and_then(color_of);
    let body = CardBody::new(
        ElementId::Name(format!("{key}-body").into()),
        act.name.clone(),
    )
    .count(tf(
        cx,
        keys::bottom_timeline::act::CHAPTER_COUNT,
        &[("count", &act.chapters.len())],
    ));
    let body = match color {
        Some(c) => body.mark(sand::Kind::Category, Some(c)),
        None => body,
    };
    let mut rows = Vec::new();
    {
        let mark = mark.clone();
        rows.push(
            CardAction::new(
                ElementId::Name(format!("{key}-rename").into()),
                Icon::Edit,
                t(cx, keys::bottom_timeline::pin_menu::RENAME),
            )
            .on_click({
                let entity = entity.clone();
                move |_, window, cx| {
                    let mark = mark.clone();
                    entity.update(cx, |t, cx| t.start_rename(mark, window, cx))
                }
            })
            .into_any_element(),
        );
    }
    rows.push(
        CardAction::new(
            ElementId::Name(format!("{key}-split").into()),
            Icon::Plus,
            t(cx, keys::bottom_timeline::act::START_HERE),
        )
        .on_click({
            let entity = entity.clone();
            move |_, _, cx| entity.update(cx, |t, cx| t.add_act(spot, cx))
        })
        .into_any_element(),
    );
    rows.extend(idea_rows(
        entity,
        &key,
        &mark,
        act.drift.as_deref(),
        t(cx, keys::bottom_timeline::act::OPEN_ACT_NOTE),
        t(cx, keys::bottom_timeline::act::UNBIND_DRIFT),
        cx,
    ));
    let id = act.id.clone();
    let delete = CardAction::new(
        ElementId::Name(format!("{key}-delete").into()),
        Icon::Trash,
        t(
            cx,
            if first_act {
                keys::bottom_timeline::act::DELETE_MERGE_NEXT
            } else {
                keys::bottom_timeline::act::DELETE_MERGE_PREV
            },
        ),
    )
    .danger()
    .on_click({
        let entity = entity.clone();
        move |_, _, cx| entity.update(cx, |t, cx| t.delete_act(&id, cx))
    })
    .into_any_element();
    body.section(rows).section(vec![delete]).into_any_element()
}

#[cfg(test)]
mod tests {
    use super::default_act_name;

    #[test]
    fn acts_are_named_by_their_place() {
        assert_eq!(default_act_name(1), "第一幕");
        assert_eq!(default_act_name(3), "第三幕");
        assert_eq!(default_act_name(10), "第十幕");
        assert_eq!(default_act_name(12), "第十二幕");
        assert_eq!(default_act_name(20), "第二十幕");
        assert_eq!(default_act_name(35), "第三十五幕");
        assert_eq!(default_act_name(100), "第100幕");
    }
}
