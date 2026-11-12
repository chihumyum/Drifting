//! V3 bottom panel. V2.2 continues to use `BottomTimeline` unchanged.
mod interaction;
pub mod model;
mod render;
mod write;
pub use dr_shell::v3::EntryDrag;
pub use interaction::PinEdit;

use dr_i18n::keys;
use dr_shell::{
    Workspace,
    book::Book,
    nav::{Open, Target},
    pages::{self, BottomHost, BottomPane, BottomPanel, PageViewHost},
    t,
};
use dr_ui::input::field::{FieldEvent, TextField};
use dr_workspace::{Workspace as Library, WritePreconditions, commands::v3::types::TimelineView};
use gpui::{prelude::*, *};
use std::{cell::Cell, rc::Rc};

#[derive(Clone)]
enum MenuOf {
    Views,
    Lanes,
    PickLane,
    Entries(String),
    Clip { entry: String, lane: String },
    Pin(String),
    Bind(String),
}
struct Popup {
    of: MenuOf,
    at: Point<Pixels>,
}
#[derive(Clone, Copy)]
enum EditKind {
    View { new: bool },
    PinLabel,
    PinColor,
}
struct Editing {
    id: String,
    kind: EditKind,
    field: Entity<TextField>,
    /// The guard of the snapshot this draft was started from.
    guard: WritePreconditions,
    failed: bool,
    _sub: Subscription,
}

pub struct Timeline {
    ws: WeakEntity<Workspace>,
    lib: Option<Library>,
    book: Rc<Book>,
    selected: Option<String>,
    scroll: ScrollHandle,
    zoom: f32,
    kept_for: Option<String>,
    popup: Option<Popup>,
    editing: Option<Editing>,
    submitting: Option<Editing>,
    latest_edit: Option<EntityId>,
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    writer: Option<futures::channel::mpsc::UnboundedSender<write::Job>>,
    pending: std::collections::BTreeMap<String, interaction::Pending>,
    resize: Option<interaction::Resizing>,
}

pub fn init(cx: &mut App) {
    pages::add_v3_bottom_panel(cx, BottomPane::Timeline, |host, _, cx| {
        let timeline = cx.new(|_| Timeline::new(host));
        timeline.update(cx, |t, cx| t.refresh(host, cx));
        let weak = timeline.downgrade();
        let refresh = weak.clone();
        Some(
            BottomPanel::new(timeline)
                .min_height(move |cx| weak.upgrade().map_or(180.0, |t| t.read(cx).min_height()))
                .on_refresh(move |host, cx| {
                    refresh.update(cx, |t, cx| t.refresh(host, cx)).ok();
                }),
        )
    });
}

impl Timeline {
    pub fn new(host: &BottomHost) -> Self {
        Self {
            ws: host.workspace.clone(),
            lib: host.library.clone(),
            book: host.book.clone(),
            selected: None,
            scroll: ScrollHandle::new(),
            zoom: 1.0,
            kept_for: None,
            popup: None,
            editing: None,
            submitting: None,
            latest_edit: None,
            bounds: Rc::default(),
            writer: None,
            pending: Default::default(),
            resize: None,
        }
    }
    pub fn refresh(&mut self, host: &BottomHost, cx: &mut Context<Self>) {
        if self.book.id != host.book.id {
            self.selected = None;
            self.kept_for = None;
            self.editing = None;
            self.submitting = None;
            self.latest_edit = None;
            self.popup = None;
        }
        self.book = host.book.clone();
        self.reconcile_pending();
        // The shell may itself be borrowed while delivering on_refresh.
        cx.spawn(async move |this, cx| {
            this.update(cx, |this, cx| this.read_memory(cx)).ok();
        })
        .detach();
        cx.notify();
    }
    fn reconcile_pending(&mut self) {
        let Some(book) = self.book.v3() else {
            self.pending.clear();
            return;
        };
        self.pending.retain(|entry, p| {
            if !book.entry(entry).is_some_and(|e| e.deleted_at.is_none()) {
                return false;
            }
            let Some(view) = book
                .timeline_views
                .iter()
                .find(|v| v.id == p.view && v.deleted_at.is_none())
            else {
                return false;
            };
            if p.lane
                .as_ref()
                .is_some_and(|lane| !view.lanes.iter().any(|l| &l.entry == lane))
            {
                return false;
            }
            let arrived = view.placements.iter().any(|x| x == &p.place)
                && p.lane.as_ref().is_none_or(|lane| {
                    book.memberships
                        .iter()
                        .any(|m| &m.host == lane && &m.member == entry)
                });
            !arrived && !(p.settled && book.revision != p.base)
        });
    }
    fn read_memory(&mut self, cx: &mut Context<Self>) {
        // This is a different memory key from v2.2's axis and synthetic lanes.
        if let Some(ws) = self.ws.upgrade() {
            let ws = ws.read(cx);
            if ws.book_memory_ready() && self.kept_for.as_deref() != Some(self.book.id.as_str()) {
                if let Some(v) = ws.book_memory("timeline-v3") {
                    self.selected = v["view"].as_str().map(str::to_owned);
                    self.zoom = v["zoom"].as_f64().unwrap_or(1.0).clamp(0.5, 3.0) as f32;
                    self.scroll.set_offset(point(
                        px(-v["scroll"].as_f64().unwrap_or(0.0).max(0.0) as f32),
                        px(0.0),
                    ));
                }
                self.kept_for = Some(self.book.id.clone());
            }
        }
        cx.notify();
    }
    pub fn view(&self) -> Option<&TimelineView> {
        let views = &self.book.v3()?.timeline_views;
        self.selected
            .as_ref()
            .and_then(|id| views.iter().find(|v| &v.id == id && v.deleted_at.is_none()))
            .or_else(|| views.iter().find(|v| v.deleted_at.is_none()))
    }
    pub fn lanes(&self) -> Vec<model::Lane> {
        match (self.book.v3(), self.view()) {
            (Some(b), Some(v)) => {
                let mut lanes = model::lanes(b, v);
                for (entry, p) in self.pending.iter().filter(|(_, p)| p.view == v.id) {
                    for lane in &mut lanes {
                        lane.clips.retain(|c| &c.entry != entry);
                        if p.lane.as_deref() == Some(&lane.id)
                            || b.memberships
                                .iter()
                                .any(|m| m.host == lane.id && &m.member == entry)
                        {
                            lane.clips.push(p.place.clone());
                        }
                    }
                }
                if let Some(resize) = &self.resize
                    && resize.view == v.id
                {
                    for lane in &mut lanes {
                        for clip in &mut lane.clips {
                            if clip.entry == resize.entry {
                                clip.at = resize.at;
                                clip.span = Some((resize.end - resize.at).max(0.25));
                            }
                        }
                    }
                }
                lanes
            }
            _ => Vec::new(),
        }
    }
    pub fn min_height(&self) -> f32 {
        model::HEAD + model::RULER + model::ROW * self.view().map_or(0, |v| v.lanes.len()) as f32
    }
    pub fn select(&mut self, id: String, cx: &mut Context<Self>) {
        self.selected = Some(id);
        self.popup = None;
        self.remember(cx);
        cx.notify();
    }
    fn remember(&self, cx: &mut Context<Self>) {
        let value = serde_json::json!({"view": self.selected.as_ref().or_else(||self.view().map(|v| &v.id)), "zoom": self.zoom, "scroll": -f32::from(self.scroll.offset().x)});
        self.ws
            .update(cx, |ws, cx| {
                if ws.book_id == self.book.id {
                    ws.set_book_memory("timeline-v3", value, cx);
                }
            })
            .ok();
    }
    fn open(&self, id: &str, event: &ClickEvent, cx: &mut App) {
        if let Ok(id) = id.parse() {
            self.ws
                .update(cx, |ws, cx| {
                    ws.open(
                        Target::Entry { id, module: None },
                        if event.click_count() > 1 {
                            Open::KEEP
                        } else {
                            Open::PREVIEW
                        },
                        cx,
                    )
                })
                .ok();
        }
    }
    pub fn rename(&mut self, new: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.popup = None;
        let (id, text) = if new {
            (
                write::fresh_id("timeline"),
                t(cx, keys::v3_timeline::NEW_VIEW).to_string(),
            )
        } else {
            let Some(v) = self.view() else { return };
            (v.id.clone(), v.name.clone())
        };
        self.start_edit(id, EditKind::View { new }, text, window, cx);
    }
    fn start_edit(
        &mut self,
        id: String,
        kind: EditKind,
        text: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.popup = None;
        let field = cx.new(|cx| {
            TextField::new("v3-timeline-name", window, cx)
                .small()
                .with_text(text)
        });
        let sub = cx.subscribe_in(&field, window, |t, field, event, _, cx| match event {
            FieldEvent::Submitted(_) | FieldEvent::Blurred => {
                let Some(edit) = t
                    .editing
                    .as_ref()
                    .filter(|e| e.field.entity_id() == field.entity_id())
                else {
                    return;
                };
                if edit.failed && !matches!(event, FieldEvent::Submitted(_)) {
                    return;
                }
                let mut name = field.read(cx).text().trim().to_owned();
                if name.is_empty() {
                    return;
                }
                if matches!(edit.kind, EditKind::PinColor) {
                    let Some(color) = dr_ui::components::color::parse_hex(&name) else {
                        return;
                    };
                    name = dr_ui::components::color::hex(color);
                }
                let (id, kind) = (edit.id.clone(), edit.kind);
                // The write owns this draft until its receipt arrives. On
                // failure it returns to the same editor without losing text.
                t.submitting = t.editing.take();
                if let Some(draft) = &mut t.submitting
                    && draft.failed
                    && let Some(book) = t.book.v3()
                {
                    draft.guard = book.guard();
                    draft.failed = false;
                }
                match kind {
                    EditKind::PinLabel => t.edit_pin(id, PinEdit::Label(name), cx),
                    EditKind::PinColor => {
                        t.edit_pin(id, PinEdit::Color(Some(name)), cx);
                    }
                    EditKind::View { new: true } => t.create_view(id, name, cx),
                    EditKind::View { new: false } => {
                        t.edit_view(id, write::ViewEdit::Rename(name), cx)
                    }
                }
                if let Some(draft) = t.submitting.take() {
                    t.editing = Some(draft);
                }
                cx.notify();
            }
            FieldEvent::Cancelled => {
                if t.editing
                    .as_ref()
                    .is_some_and(|e| e.field.entity_id() == field.entity_id())
                {
                    t.editing = None;
                    t.latest_edit = None;
                }
                cx.notify();
            }
            FieldEvent::Changed(_) => cx.notify(),
        });
        field.update(cx, |f, cx| f.select_all_text(cx));
        field.focus_handle(cx).focus(window, cx);
        self.latest_edit = Some(field.entity_id());
        self.editing = Some(Editing {
            id,
            kind,
            field,
            guard: self.book.v3().map(|b| b.guard()).unwrap_or_default(),
            failed: false,
            _sub: sub,
        });
        cx.notify();
    }
}
