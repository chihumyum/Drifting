use super::*;
use dr_workspace::{
    Actor, WsError,
    commands::{
        BookIn,
        v3::{
            timeline,
            types::{TimelinePin, TimelinePlacement},
        },
    },
};

/// Shared source for v3 entry drags. Dropping adds membership without moving
/// residence or removing any existing membership. G2 can use the same payload.
#[derive(Clone)]
pub struct EntryDrag {
    pub book: String,
    pub entry: String,
    pub title: SharedString,
    pub span: Option<f64>,
    pub(super) grab: Rc<Cell<f32>>,
}
impl EntryDrag {
    pub fn new(book: String, entry: String, title: impl Into<SharedString>) -> Self {
        Self {
            book,
            entry,
            title: title.into(),
            span: None,
            grab: Rc::default(),
        }
    }
    pub fn set_grab(&self, x: f32) {
        self.grab.set(x);
    }
}
#[derive(Clone)]
pub(super) struct Resizing {
    pub book: String,
    pub view: String,
    pub entry: String,
    pub at: f64,
    pub end: f64,
}
#[derive(Clone)]
pub(super) struct PinDrag {
    pub book: String,
    pub view: String,
    pub pin: String,
    pub title: SharedString,
    pub grab: Rc<Cell<f32>>,
}
pub(super) struct Pending {
    pub view: String,
    pub place: TimelinePlacement,
    pub lane: Option<String>,
    pub base: String,
    pub settled: bool,
}
pub enum PinEdit {
    Label(String),
    Color(Option<String>),
    Bind(Option<String>),
    At(f64),
}

impl Timeline {
    pub fn place(
        &mut self,
        entry: String,
        lane: Option<String>,
        at: f64,
        span: Option<f64>,
        cx: &mut Context<Self>,
    ) {
        if !at.is_finite() || span.is_some_and(|n| !n.is_finite() || n < 0.) {
            return;
        }
        let Some(view) = self.view().map(|v| v.id.clone()) else {
            return;
        };
        self.pending.insert(
            entry.clone(),
            Pending {
                view: view.clone(),
                place: TimelinePlacement {
                    entry: entry.clone(),
                    at,
                    span,
                },
                lane: lane.clone(),
                base: self
                    .book
                    .v3()
                    .map(|b| b.revision.clone())
                    .unwrap_or_default(),
                settled: false,
            },
        );
        self.popup = None;
        let receipt = self
            .pending
            .get(&entry)
            .map(|p| (p.view.clone(), p.place.clone()));
        self.write_tag(cx, receipt, move |lib, book| {
            lib.run::<timeline::Place>(
                &Actor::User,
                timeline::PlaceIn {
                    book,
                    view,
                    entry,
                    lane,
                    at,
                    span,
                },
            )?;
            Ok(())
        });
        cx.notify();
    }
    pub fn remove_entry(&mut self, entry: String, lane: String, cx: &mut Context<Self>) {
        let Some(view) = self.view().map(|v| v.id.clone()) else {
            return;
        };
        self.popup = None;
        self.pending.remove(&entry);
        cx.notify();
        self.write(cx, move |lib, book| {
            lib.run::<timeline::Remove>(
                &Actor::User,
                timeline::RemoveIn {
                    book,
                    view,
                    entry,
                    lane,
                },
            )?;
            Ok(())
        });
    }
    pub fn put_pin(&mut self, pin: TimelinePin, cx: &mut Context<Self>) {
        let Some(view) = self.view().map(|v| v.id.clone()) else {
            return;
        };
        self.write(cx, move |lib, book| {
            lib.run::<timeline::PinPut>(&Actor::User, timeline::PinIn { book, view, pin })?;
            Ok(())
        });
    }
    pub fn new_pin(&mut self, at: f64, window: &mut Window, cx: &mut Context<Self>) {
        let id = write::fresh_id("pin");
        let label = t(cx, keys::common::UNTITLED).to_string();
        self.put_pin(
            TimelinePin {
                id: id.clone(),
                at,
                label: label.clone(),
                color: None,
                entry: None,
            },
            cx,
        );
        self.start_edit(id, EditKind::PinLabel, label, window, cx);
    }
    pub fn rename_pin(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(label) = self
            .view()
            .and_then(|v| v.pins.iter().find(|p| p.id == id))
            .map(|p| p.label.clone())
        {
            self.start_edit(id, EditKind::PinLabel, label, window, cx);
        }
    }
    pub(super) fn custom_pin_color(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(pin) = self.view().and_then(|v| v.pins.iter().find(|p| p.id == id)) {
            self.start_edit(
                id,
                EditKind::PinColor,
                pin.color.clone().unwrap_or_else(|| "#738f9a".into()),
                window,
                cx,
            );
        }
    }
    pub fn edit_pin(&mut self, id: String, edit: PinEdit, cx: &mut Context<Self>) {
        let Some(view) = self.view().map(|v| v.id.clone()) else {
            return;
        };
        self.popup = None;
        self.write(cx, move |lib, book| {
            // Merge one field into the latest pin, so rename/colour/binding
            // and dragging cannot clobber one another while a snapshot lags.
            let observed = lib.observe(&format!("book:{book}"))?;
            let mut pin = lib
                .run::<timeline::ViewList>(&Actor::User, BookIn { book: book.clone() })?
                .output
                .into_iter()
                .find(|v| v.id == view && v.deleted_at.is_none())
                .and_then(|v| v.pins.into_iter().find(|p| p.id == id))
                .ok_or_else(|| WsError::NotFound {
                    what: "time pin",
                    id,
                })?;
            match edit {
                PinEdit::Label(s) => pin.label = s,
                PinEdit::Color(s) => pin.color = s,
                PinEdit::Bind(s) => pin.entry = s,
                PinEdit::At(at) => pin.at = at,
            }
            lib.call_guarded(
                &Actor::User,
                "timeline_view.put_pin",
                serde_json::json!({"book":book,"view":view,"pin":pin}),
                dr_workspace::WritePreconditions::from_observations([observed]),
            )?;
            Ok(())
        });
    }
    pub fn delete_pin(&mut self, pin: String, cx: &mut Context<Self>) {
        let Some(view) = self.view().map(|v| v.id.clone()) else {
            return;
        };
        self.popup = None;
        self.write(cx, move |lib, book| {
            lib.run::<timeline::PinRemove>(
                &Actor::User,
                timeline::PinRemoveIn { book, view, pin },
            )?;
            Ok(())
        });
    }
    pub fn order_at(&self, x: Pixels) -> Option<f64> {
        let bounds = self.bounds.get()?;
        let view = self.view()?;
        let min = model::extent(view).0;
        Some(
            min + f64::from(
                (f32::from(x - bounds.origin.x) - model::RAIL - f32::from(self.scroll.offset().x))
                    / (model::UNIT * self.zoom),
            ),
        )
    }
    pub(super) fn dropped_entry(
        &mut self,
        drag: &EntryDrag,
        lane: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if drag.book != self.book.id {
            return;
        }
        if let Some(at) = self.order_at(window.mouse_position().x - px(drag.grab.get())) {
            let span = drag
                .span
                .or_else(|| {
                    self.pending
                        .get(&drag.entry)
                        .filter(|p| self.view().is_some_and(|v| v.id == p.view))
                        .and_then(|p| p.place.span)
                })
                .or_else(|| {
                    self.view()
                        .and_then(|v| v.placements.iter().find(|p| p.entry == drag.entry))
                        .and_then(|p| p.span)
                });
            self.place(drag.entry.clone(), Some(lane), at, span, cx);
        }
    }
    pub(super) fn resize_moved(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(end) = self.order_at(position.x) else {
            return;
        };
        if let Some(resize) = &mut self.resize {
            resize.end = end.max(resize.at + 0.25);
            cx.notify();
        }
    }
    pub(super) fn resize_ended(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let end = self.order_at(position.x);
        if let Some(resize) = self.resize.take()
            && resize.book == self.book.id
            && self.view().is_some_and(|v| v.id == resize.view)
            && self.bounds.get().is_some_and(|b| b.contains(&position))
            && let Some(end) = end
        {
            self.place(
                resize.entry,
                None,
                resize.at,
                Some((end - resize.at).max(0.25)),
                cx,
            );
        }
        cx.notify();
    }
    pub(super) fn wheel(&mut self, e: &ScrollEvent, window: &mut Window, cx: &mut Context<Self>) {
        if (e.modifiers.platform || e.modifiers.control)
            && let Some(bounds) = self.bounds.get()
        {
            let delta = f32::from(e.delta.pixel_delta(window.line_height()).y);
            let next = (self.zoom * (1. + delta * 0.002)).clamp(0.5, 3.);
            let x = f32::from(e.position.x - bounds.origin.x) - model::RAIL;
            let anchor = (x - f32::from(self.scroll.offset().x)) / self.zoom;
            self.zoom = next;
            self.scroll
                .set_offset(point(px(-(anchor * next - x).max(0.)), px(0.)));
            cx.stop_propagation();
        }
        self.remember(cx);
        cx.notify();
    }
}
