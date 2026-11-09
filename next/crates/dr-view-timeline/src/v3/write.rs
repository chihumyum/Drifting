use super::*;
use dr_model::pos::PosKey;
use dr_workspace::{
    Actor, WritePreconditions, WsError,
    commands::{
        BookIn, EntityIn,
        v3::{
            membership, timeline,
            types::{TimelineLane, TimelineView},
        },
    },
};
use futures::StreamExt;

pub(super) type Job = Box<dyn FnOnce() + Send>;
pub(super) enum ViewEdit {
    Rename(String),
    AddLane(String),
    RemoveLane(String),
    Reorder(String, isize),
}

pub fn fresh_id(_: &str) -> String {
    dr_model::id::new_uuid_v7()
}

impl Timeline {
    pub(super) fn write(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(Library, String) -> Result<(), WsError> + Send + 'static,
    ) {
        let Some(lib) = self.lib.clone() else { return };
        if self.writer.is_none() {
            let (tx, mut rx) = futures::channel::mpsc::unbounded::<Job>();
            cx.background_executor()
                .spawn(async move {
                    while let Some(job) = rx.next().await {
                        job();
                    }
                })
                .detach();
            // Closing the panel drops the sender. Drain accepted author writes
            // before releasing the jobs' library handles.
            self.writer = Some(tx);
        }
        let book = self.book.id.clone();
        let (tx, rx) = futures::channel::oneshot::channel();
        let job = Box::new(move || {
            let _ = tx.send(f(lib, book));
        });
        if self.writer.as_ref().unwrap().unbounded_send(job).is_err() {
            return;
        }
        cx.spawn(async move |this, cx| {
            if let Ok(Err(e)) = rx.await {
                log::warn!("v3 timeline write failed: {e}");
                this.update(cx, |timeline, cx| {
                    timeline.pending.clear();
                    let text = t(cx, keys::common::SAVE_FAILED);
                    timeline.ws.update(cx, |ws, cx| ws.toast(text, cx)).ok();
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }
    pub fn create_view(&mut self, id: String, name: String, cx: &mut Context<Self>) {
        self.selected = Some(id.clone());
        self.write(cx, move |lib, book| {
            let views = lib
                .run::<timeline::ViewList>(&Actor::User, BookIn { book: book.clone() })?
                .output;
            let pos = views
                .iter()
                .filter(|v| v.deleted_at.is_none())
                .filter_map(|v| v.pos.as_deref())
                .filter_map(|p| PosKey::parse(p).ok())
                .max()
                .map(|p| p.after())
                .unwrap_or_else(PosKey::first);
            lib.run::<timeline::ViewPut>(
                &Actor::User,
                timeline::PutIn {
                    book,
                    view: TimelineView {
                        id,
                        name,
                        pos: Some(pos.to_string()),
                        lanes: vec![],
                        placements: vec![],
                        pins: vec![],
                        deleted_at: None,
                    },
                },
            )?;
            Ok(())
        });
    }
    pub fn delete_view(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.view().map(|v| v.id.clone()) else {
            return;
        };
        self.popup = None;
        self.write(cx, move |lib, book| {
            lib.run::<timeline::ViewDelete>(&Actor::User, EntityIn { book, id })?;
            Ok(())
        });
    }
    pub fn add_lane(&mut self, lane: String, cx: &mut Context<Self>) {
        if let Some(id) = self.view().map(|v| v.id.clone()) {
            self.edit_view(id, ViewEdit::AddLane(lane), cx);
        }
    }
    pub fn remove_lane(&mut self, lane: String, cx: &mut Context<Self>) {
        if let Some(id) = self.view().map(|v| v.id.clone()) {
            self.edit_view(id, ViewEdit::RemoveLane(lane), cx);
        }
    }
    pub fn reorder_lane(&mut self, lane: String, delta: isize, cx: &mut Context<Self>) {
        if let Some(id) = self.view().map(|v| v.id.clone()) {
            self.edit_view(id, ViewEdit::Reorder(lane, delta), cx);
        }
    }
    pub(super) fn edit_view(&mut self, id: String, edit: ViewEdit, cx: &mut Context<Self>) {
        self.popup = None;
        self.write(cx, move |lib, book| {
            let observed = lib.observe(&format!("book:{book}"))?;
            let mut v = lib
                .run::<timeline::ViewList>(&Actor::User, BookIn { book: book.clone() })?
                .output
                .into_iter()
                .find(|v| v.id == id)
                .ok_or_else(|| WsError::NotFound {
                    what: "timeline view",
                    id: id.clone(),
                })?;
            // ViewList is read-tolerant and omits inactive targets. A whole
            // ViewPut must never turn that omission into permanent deletion.
            // Until F3 offers field patches, refuse these edits without a write.
            let raw = observed
                .value
                .get("timeline_views")
                .and_then(|views| views.get(&id));
            for (field, count) in [
                ("lanes", v.lanes.len()),
                ("placements", v.placements.len()),
                ("pins", v.pins.len()),
            ] {
                let raw_count = raw
                    .and_then(|v| v.get(field))
                    .and_then(|v| v.as_object())
                    .map_or(0, |v| v.len());
                if raw_count != count {
                    return Err(WsError::Conflict(
                        "timeline contains inactive targets".into(),
                    ));
                }
            }
            match edit {
                ViewEdit::Rename(name) => v.name = name,
                ViewEdit::AddLane(entry) => {
                    if !v.lanes.iter().any(|l| l.entry == entry) {
                        let pos = v
                            .lanes
                            .last()
                            .and_then(|l| l.pos.as_deref())
                            .and_then(|p| PosKey::parse(p).ok())
                            .map(|p| p.after())
                            .unwrap_or_else(PosKey::first);
                        v.lanes.push(TimelineLane {
                            entry,
                            pos: Some(pos.to_string()),
                        });
                    }
                }
                ViewEdit::RemoveLane(lane) => {
                    let ms = lib
                        .run::<membership::MembershipList>(
                            &Actor::User,
                            BookIn { book: book.clone() },
                        )?
                        .output;
                    model::remove_lane(&mut v, &lane, &ms);
                }
                ViewEdit::Reorder(lane, delta) => {
                    if let Some(i) = v.lanes.iter().position(|l| l.entry == lane) {
                        let j = i.saturating_add_signed(delta).min(v.lanes.len() - 1);
                        let row = v.lanes.remove(i);
                        v.lanes.insert(j, row);
                        let mut pos = PosKey::first();
                        for l in &mut v.lanes {
                            l.pos = Some(pos.to_string());
                            pos = pos.after();
                        }
                    }
                }
            }
            lib.call_guarded(
                &Actor::User,
                "timeline_view.put",
                serde_json::json!({"book":book,"view":v}),
                WritePreconditions::from_observations([observed]),
            )?;
            Ok(())
        });
    }
}
