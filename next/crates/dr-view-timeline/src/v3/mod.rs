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
    workspace::FillPlace,
};
use dr_ui::input::field::{FieldEvent, TextField};
use dr_workspace::{Workspace as Library, WritePreconditions, commands::v3::types::TimelineView};
use gpui::{prelude::*, *};
use std::{cell::Cell, rc::Rc};

#[derive(Clone)]
enum MenuOf {
    Views,
    Lanes,
    LaneTemplates,
    ActTrackTemplates,
    LaneActions(String),
    PickLane,
    Entries(String),
    Clip { entry: String, lane: String },
    Pin(String),
    Bind(String),
}
struct Popup {
    of: MenuOf,
    at: Point<Pixels>,
    scroll: ScrollHandle,
}
impl Popup {
    fn new(of: MenuOf, at: Point<Pixels>) -> Self {
        Self {
            of,
            at,
            scroll: ScrollHandle::new(),
        }
    }
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
    v_scroll: ScrollHandle,
    rail_scroll: ScrollHandle,
    /// The bar's scale and the filled panel's (`W9Bottom`): each pinched on
    /// its own.
    bar: model::Scale,
    filled_scale: model::Scale,
    /// The bottom panel fills, and how far it has grown (read each frame).
    filled: bool,
    fill_t: f32,
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
            v_scroll: ScrollHandle::new(),
            rail_scroll: ScrollHandle::new(),
            bar: model::BAR,
            filled_scale: model::FILLED,
            filled: false,
            fill_t: 0.0,
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
            if p.lane.as_ref().is_some_and(|lane| {
                !book.accepts_members(lane) || !view.lanes.iter().any(|l| &l.entry == lane)
            }) {
                return false;
            }
            let still_detached = p.detach_from.as_ref().is_none_or(|old_host| {
                !book
                    .memberships
                    .iter()
                    .any(|m| &m.host == old_host && &m.member == entry)
            });
            let arrived = view.placements.iter().any(|x| x == &p.place)
                && p.lane.as_ref().is_none_or(|lane| {
                    book.memberships
                        .iter()
                        .any(|m| &m.host == lane && &m.member == entry)
                })
                && still_detached;
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
                    let kept = |key: &str, of: f32| v[key].as_f64().map_or(of, |f| of * f as f32);
                    self.bar = model::Scale {
                        step: kept("zoom", model::BAR.step),
                        band: kept("zoomY", model::BAR.band),
                    }
                    .clamped();
                    self.filled_scale = model::Scale {
                        step: kept("fillZoom", model::FILLED.step),
                        band: kept("fillZoomY", model::FILLED.band),
                    }
                    .clamped();
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
                        if p.detach_from.as_deref() == Some(&lane.id) {
                            continue;
                        }
                        let is_member = b.accepts_members(&lane.id)
                            && b.memberships
                                .iter()
                                .any(|m| m.host == lane.id && &m.member == entry);
                        if p.lane.as_deref() == Some(&lane.id) || is_member {
                            lane.clips.push(p.place.clone());
                            lane.clips.sort_by(|a, b| {
                                a.at.total_cmp(&b.at).then_with(|| a.entry.cmp(&b.entry))
                            });
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
    /// Reads whether the bottom panel fills and how far it has grown. On
    /// the way in or out the scale starts from the beginning again, as
    /// `W9Bottom` draws it (each state has its own scale).
    fn follow_fill(&mut self, cx: &App) {
        let (filled, t) = self.ws.upgrade().map_or((false, 0.0), |ws| {
            let ws = ws.read(cx);
            (
                ws.is_filled(FillPlace::Bottom),
                ws.fill_progress(FillPlace::Bottom),
            )
        });
        if filled != self.filled {
            self.scroll.set_offset(point(px(0.0), px(0.0)));
            self.v_scroll.set_offset(point(px(0.0), px(0.0)));
            self.rail_scroll.set_offset(point(px(0.0), px(0.0)));
        }
        self.filled = filled;
        self.fill_t = t;
    }
    /// The shown state's horizontal scale against its first one (1: as
    /// `W9Bottom` draws it).
    pub fn zoom(&self) -> f32 {
        self.active().step / self.first().step
    }
    /// The shown state's lane height against its first one.
    pub fn zoom_y(&self) -> f32 {
        self.active().band / self.first().band
    }
    /// The scale of the state shown (the bar's, or the filled panel's).
    pub fn active(&self) -> model::Scale {
        if self.filled {
            self.filled_scale
        } else {
            self.bar
        }
    }
    fn active_mut(&mut self) -> &mut model::Scale {
        if self.filled {
            &mut self.filled_scale
        } else {
            &mut self.bar
        }
    }
    fn first(&self) -> model::Scale {
        if self.filled {
            model::FILLED
        } else {
            model::BAR
        }
    }
    /// The scale drawn now: between the bar's and the filled panel's while
    /// the panel grows or shrinks.
    pub fn scale(&self) -> model::Scale {
        self.bar.toward(self.filled_scale, self.fill_t)
    }
    /// The lane-name column's width now (`W9Bottom`: 96 in the bar, 140
    /// filled).
    pub fn rail_width(&self) -> f32 {
        model::RAIL + (model::FILLED_RAIL - model::RAIL) * self.fill_t
    }
    pub fn min_height(&self) -> f32 {
        (model::HEAD + model::RULER + model::ROW * self.lanes().len().min(4) as f32).max(180.0)
    }
    pub fn select(&mut self, id: String, cx: &mut Context<Self>) {
        self.selected = Some(id);
        self.popup = None;
        self.remember(cx);
        cx.notify();
    }
    fn remember(&self, cx: &mut Context<Self>) {
        let mut value = serde_json::json!({
            "view": self.selected.as_ref().or_else(|| self.view().map(|v| &v.id)),
            "zoom": self.bar.step / model::BAR.step,
            "zoomY": self.bar.band / model::BAR.band,
            "fillZoom": self.filled_scale.step / model::FILLED.step,
            "fillZoomY": self.filled_scale.band / model::FILLED.band,
            "scroll": -f32::from(self.scroll.offset().x),
        });
        let filled = self.filled;
        self.ws
            .update(cx, |ws, cx| {
                if ws.book_id == self.book.id {
                    // The kept scroll is the bar's: the fill is not kept.
                    if filled {
                        value["scroll"] = ws
                            .book_memory("timeline-v3")
                            .map_or(serde_json::json!(0.0), |old| old["scroll"].clone());
                    }
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
    pub fn open_book_view(&mut self, cx: &mut Context<Self>) {
        self.popup = None;
        let Some(view_id) = self.view().and_then(|v| v.id.parse().ok()) else {
            cx.notify();
            return;
        };
        self.ws
            .update(cx, |ws, cx| {
                ws.open(Target::BookView(view_id), Open::KEEP, cx);
            })
            .ok();
        cx.notify();
    }
    pub fn open_lane_book_view(&mut self, lane: String, cx: &mut Context<Self>) {
        self.popup = None;
        let (Some(view), Ok(entry)) = (self.view().and_then(|v| v.id.parse().ok()), lane.parse())
        else {
            cx.notify();
            return;
        };
        self.ws
            .update(cx, |ws, cx| {
                ws.open(Target::BookLane { view, entry }, Open::KEEP, cx);
            })
            .ok();
        cx.notify();
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
