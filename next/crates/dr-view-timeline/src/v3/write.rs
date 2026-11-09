use super::*;
use dr_model::pos::PosKey;
use dr_workspace::{
    Actor, WsError,
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
    fn write(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(Library, String) -> Result<(), WsError> + Send + 'static,
    ) {
        let Some(lib) = self.lib.clone() else { return };
        if self.writer.is_none() {
            let (tx, mut rx) = futures::channel::mpsc::unbounded::<Job>();
            let task = cx.background_executor().spawn(async move {
                while let Some(job) = rx.next().await {
                    job();
                }
            });
            self.writer = Some((tx, task));
        }
        let book = self.book.id.clone();
        let (tx, rx) = futures::channel::oneshot::channel();
        let job = Box::new(move || {
            let _ = tx.send(f(lib, book));
        });
        if self.writer.as_ref().unwrap().0.unbounded_send(job).is_err() {
            return;
        }
        cx.spawn(async move |this, cx| {
            if let Ok(Err(e)) = rx.await {
                log::warn!("v3 timeline write failed: {e}");
                this.update(cx, |timeline, cx| {
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
            let mut v = lib
                .run::<timeline::ViewList>(&Actor::User, BookIn { book: book.clone() })?
                .output
                .into_iter()
                .find(|v| v.id == id)
                .ok_or_else(|| WsError::NotFound {
                    what: "timeline view",
                    id: id.clone(),
                })?;
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
            lib.run::<timeline::ViewPut>(&Actor::User, timeline::PutIn { book, view: v })?;
            Ok(())
        });
    }
}
