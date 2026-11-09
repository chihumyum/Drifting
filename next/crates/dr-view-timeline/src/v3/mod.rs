//! V3 bottom panel. V2.2 continues to use `BottomTimeline` unchanged.
pub mod model;
mod render;
mod write;

use dr_i18n::keys;
use dr_shell::{
    Workspace,
    book::Book,
    nav::{Open, Target},
    pages::{self, BottomHost, BottomPane, BottomPanel},
    t,
};
use dr_ui::input::field::{FieldEvent, TextField};
use dr_workspace::{Workspace as Library, commands::v3::types::TimelineView};
use gpui::{prelude::*, *};
use std::{cell::Cell, rc::Rc};

#[derive(Clone)]
enum MenuOf {
    Views,
    Lanes,
}
struct Popup {
    of: MenuOf,
    at: Point<Pixels>,
}
struct Editing {
    id: String,
    new: bool,
    field: Entity<TextField>,
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
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    writer: Option<futures::channel::mpsc::UnboundedSender<write::Job>>,
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
            bounds: Rc::default(),
            writer: None,
        }
    }
    pub fn refresh(&mut self, host: &BottomHost, cx: &mut Context<Self>) {
        if self.book.id != host.book.id {
            self.selected = None;
            self.kept_for = None;
            self.editing = None;
            self.popup = None;
        }
        self.book = host.book.clone();
        // The shell may itself be borrowed while delivering on_refresh.
        cx.spawn(async move |this, cx| {
            this.update(cx, |this, cx| this.read_memory(cx)).ok();
        })
        .detach();
        cx.notify();
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
            (Some(b), Some(v)) => model::lanes(b, v),
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
        let value = serde_json::json!({"view": self.view().map(|v| &v.id), "zoom": self.zoom, "scroll": -f32::from(self.scroll.offset().x)});
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
        let field = cx.new(|cx| {
            TextField::new("v3-timeline-name", window, cx)
                .small()
                .with_text(text)
        });
        let sub = cx.subscribe_in(&field, window, |t, field, event, _, cx| match event {
            FieldEvent::Submitted(_) | FieldEvent::Blurred => {
                let name = field.read(cx).text().trim().to_owned();
                if let Some(edit) = t.editing.take()
                    && !name.is_empty()
                {
                    if edit.new {
                        t.create_view(edit.id, name, cx);
                    } else {
                        t.edit_view(edit.id, write::ViewEdit::Rename(name), cx);
                    }
                }
                cx.notify();
            }
            FieldEvent::Cancelled => {
                t.editing = None;
                cx.notify();
            }
            FieldEvent::Changed(_) => {}
        });
        field.update(cx, |f, cx| f.select_all_text(cx));
        field.focus_handle(cx).focus(window, cx);
        self.editing = Some(Editing {
            id,
            new,
            field,
            _sub: sub,
        });
        cx.notify();
    }
}
