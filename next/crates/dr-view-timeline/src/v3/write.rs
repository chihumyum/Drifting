use super::*;
use dr_model::pos::PosKey;
use dr_workspace::{
    Actor, RecordKey, RecordObservation, WritePreconditions, WsError,
    commands::{
        BookIn, EntityIn,
        v3::{
            timeline,
            types::{TimelinePin, TimelineView},
        },
    },
};
use futures::StreamExt;
use serde_json::{Map, Value};

pub(super) type Job = Box<dyn FnOnce() + Send>;
pub(super) enum ViewEdit {
    Rename(String),
    AddLane(String),
    RemoveLane(String),
    Reorder(String, isize),
    SetActTrack(String, bool),
}

/// The guard is that of the displayed F6 snapshot the edit was made from.
/// Never replace it with a fresh one when submitting a draft.
#[derive(Clone)]
pub(super) struct ViewScope {
    pub book: String,
    pub view: String,
    pub guard: WritePreconditions,
    pub lanes: Vec<(String, bool)>,
}

fn run_view_edit(lib: &Library, scope: ViewScope, edit: ViewEdit) -> Result<(), WsError> {
    let (command, input) = match edit {
        ViewEdit::Rename(name) => (
            "timeline_view.rename",
            serde_json::json!({"book":scope.book,"view":scope.view,"name":name}),
        ),
        ViewEdit::AddLane(lane) => (
            "timeline_view.add_lane",
            serde_json::json!({"book":scope.book,"view":scope.view,"lane":lane}),
        ),
        ViewEdit::RemoveLane(lane) => (
            "timeline_view.remove_lane",
            serde_json::json!({"book":scope.book,"view":scope.view,"lane":lane}),
        ),
        ViewEdit::SetActTrack(lane, act_track) => (
            "timeline_view.set_lane_act_track",
            serde_json::json!({"book":scope.book,"view":scope.view,"lane":lane,"act_track":act_track}),
        ),
        ViewEdit::Reorder(lane, delta) => {
            let is_act = scope
                .lanes
                .iter()
                .find(|(id, _)| id == &lane)
                .map(|(_, act)| *act)
                .ok_or_else(|| WsError::NotFound {
                    what: "timeline lane",
                    id: lane.clone(),
                })?;
            let group: Vec<&str> = scope
                .lanes
                .iter()
                .filter(|(_, act)| *act == is_act)
                .map(|(id, _)| id.as_str())
                .collect();
            let i = group
                .iter()
                .position(|id| *id == lane)
                .expect("lane belongs to its own group");
            let j = i.saturating_add_signed(delta).min(group.len() - 1);
            if i == j {
                return Ok(());
            }
            let place = if j < i {
                dr_workspace::naming::Place::Before(group[j].to_owned())
            } else {
                dr_workspace::naming::Place::After(group[j].to_owned())
            };
            (
                "timeline_view.move_lane",
                serde_json::json!({"book":scope.book,"view":scope.view,"lane":lane,"place":place}),
            )
        }
    };
    lib.call_guarded(&Actor::User, command, input, scope.guard)?;
    Ok(())
}

pub fn fresh_id(_: &str) -> String {
    dr_model::id::new_uuid_v7()
}

fn record(value: impl serde::Serialize, key: &str) -> Result<Value, WsError> {
    let mut value = serde_json::to_value(value).map_err(|e| WsError::Internal(e.to_string()))?;
    value.as_object_mut().unwrap().remove(key);
    Ok(value)
}

// Compare the entire preimage that a replacement writes, including fields
// projected to null (not just records omitted from the effective query).
// Absent nullable fields/empty collections carry no data to overwrite.
fn covers(raw: &Value, expected: &Value) -> bool {
    if let Value::Object(expected) = expected {
        let Some(raw) = raw.as_object() else {
            return false;
        };
        raw.keys().all(|k| expected.contains_key(k))
            && expected.iter().all(|(k, v)| match raw.get(k) {
                Some(raw) => covers(raw, v),
                None => v.is_null() || v.as_object().is_some_and(Map::is_empty),
            })
    } else {
        raw == expected
    }
}

pub(super) fn complete_pin(raw: Option<&Value>, pin: &TimelinePin) -> Result<(), WsError> {
    require_coverage(raw, &record(pin, "id")?)
}

fn require_coverage(raw: Option<&Value>, expected: &Value) -> Result<(), WsError> {
    if raw.is_some_and(|raw| covers(raw, expected)) {
        Ok(())
    } else {
        Err(WsError::Conflict(
            "timeline projection is incomplete".into(),
        ))
    }
}

/// The stored state of one time pin (`null`: not stored), observed before
/// anything is read to build its replacement.
pub(super) fn observe_pin(
    lib: &Library,
    book: &str,
    view: &str,
    pin: &str,
) -> Result<RecordObservation, WsError> {
    observe(lib, book, RecordKey::timeline_view(view).at(["pins", pin]))
}

pub(super) fn observe(
    lib: &Library,
    book: &str,
    key: RecordKey,
) -> Result<RecordObservation, WsError> {
    Ok(lib
        .observe_records(&format!("book:{book}"), &[key])?
        .remove(0))
}

/// A replacement held to the record it was built from.
pub(super) fn replace(
    lib: &Library,
    command: &str,
    input: Value,
    stored: RecordObservation,
) -> Result<(), WsError> {
    lib.call_guarded(
        &Actor::User,
        command,
        input,
        WritePreconditions::from_records([stored]),
    )?;
    Ok(())
}

impl Timeline {
    pub(super) fn write(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(Library, String) -> Result<(), WsError> + Send + 'static,
    ) {
        self.write_tag(cx, None, f);
    }
    pub(super) fn write_tag(
        &mut self,
        cx: &mut Context<Self>,
        receipt: Option<(String, dr_workspace::commands::v3::types::TimelinePlacement)>,
        f: impl FnOnce(Library, String) -> Result<(), WsError> + Send + 'static,
    ) {
        let draft = self.submitting.take();
        let Some(lib) = self.lib.clone() else {
            self.editing = draft.or(self.editing.take());
            return;
        };
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
        let submitted_book = book.clone();
        let (tx, rx) = futures::channel::oneshot::channel();
        let job = Box::new(move || {
            let _ = tx.send(f(lib, book));
        });
        if self.writer.as_ref().unwrap().unbounded_send(job).is_err() {
            self.editing = draft.or(self.editing.take());
            return;
        }
        cx.spawn(async move |this, cx| {
            let result = rx
                .await
                .unwrap_or_else(|_| Err(WsError::Internal("timeline write queue closed".into())));
            this.update(cx, |timeline, cx| {
                if let Some(mut draft) = draft
                    && timeline.latest_edit == Some(draft.field.entity_id())
                {
                    if result.is_err()
                        && timeline.book.id == submitted_book
                        && timeline.editing.is_none()
                    {
                        draft.failed = true;
                        timeline.editing = Some(draft);
                    } else {
                        timeline.latest_edit = None;
                    }
                }
                if let Some((view, place)) = &receipt
                    && let Some(p) = timeline.pending.get_mut(&place.entry)
                    && &p.view == view
                    && p.place == *place
                {
                    p.settled = true;
                }
                if let Err(error) = result {
                    log::warn!("v3 timeline write failed: {error}");
                    if let Some((view, place)) = receipt
                        && timeline
                            .pending
                            .get(&place.entry)
                            .is_some_and(|p| p.view == view && p.place == place)
                    {
                        timeline.pending.remove(&place.entry);
                    }
                    let text = t(cx, keys::common::SAVE_FAILED);
                    timeline.ws.update(cx, |ws, cx| ws.toast(text, cx)).ok();
                }
                timeline.reconcile_pending();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
    pub fn create_view(&mut self, id: String, name: String, cx: &mut Context<Self>) {
        self.selected = Some(id.clone());
        self.remember(cx);
        self.write(cx, move |lib, book| {
            // Held to this view not being stored: one made under the same
            // id meanwhile is not replaced.
            let stored = observe(&lib, &book, RecordKey::timeline_view(&id))?;
            if !stored.value.is_null() {
                return Err(WsError::Conflict("timeline view already exists".into()));
            }
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
            replace(
                &lib,
                "timeline_view.put",
                serde_json::to_value(timeline::PutIn {
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
                })
                .map_err(|e| WsError::Internal(e.to_string()))?,
                stored,
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
    pub fn set_lane_act_track(&mut self, lane: String, act_track: bool, cx: &mut Context<Self>) {
        if let Some(id) = self.view().map(|v| v.id.clone()) {
            self.edit_view(id, ViewEdit::SetActTrack(lane, act_track), cx);
        }
    }
    pub fn create_act_track(&mut self, template: String, cx: &mut Context<Self>) {
        let Some(view_id) = self.view().map(|v| v.id.clone()) else {
            return;
        };
        let Some(book_snap) = self.book.v3() else {
            return;
        };
        if !book_snap
            .template(&template)
            .is_some_and(|t| t.level && t.settings.lane == Some(true))
        {
            return;
        }
        let guard = book_snap.guard_for(&serde_json::json!({ "template": &template }));
        let base_name = t(cx, keys::v3_timeline::ACT_LEVEL_NAME).to_string();
        self.popup = None;
        self.write(cx, move |lib, book| {
            let entries_out = lib.call(
                &Actor::User,
                "entry.list",
                serde_json::json!({"book": book}),
            )?["output"]
                .clone();
            let root_titles: Vec<String> = entries_out
                .as_array()
                .into_iter()
                .flatten()
                .filter(|e| e["parent"].is_null() && e["deleted_at"].is_null())
                .filter_map(|e| e["title"].as_str().map(str::to_owned))
                .collect();
            let title = dr_workspace::naming::unique_name(
                &base_name,
                "幕",
                root_titles.iter().map(String::as_str),
            );
            let created = lib.call_guarded(
                &Actor::User,
                "entry.create",
                serde_json::json!({
                    "book": book,
                    "parent": serde_json::Value::Null,
                    "title": title,
                    "template": template,
                }),
                guard,
            )?;
            let lane_id = created["output"]["id"]
                .as_str()
                .ok_or_else(|| WsError::Internal("entry.create returned no id".into()))?
                .to_owned();
            let views = lib
                .run::<timeline::ViewList>(&Actor::User, BookIn { book: book.clone() })?
                .output;
            let place = views
                .iter()
                .find(|v| v.id == view_id && v.deleted_at.is_none())
                .map(|v| {
                    if let Some(last_act) = v.lanes.iter().rfind(|l| l.act_track == Some(true)) {
                        dr_workspace::naming::Place::After(last_act.entry.clone())
                    } else {
                        dr_workspace::naming::Place::First
                    }
                });
            lib.call(
                &Actor::User,
                "timeline_view.add_lane",
                serde_json::json!({
                    "book": book,
                    "view": view_id,
                    "lane": lane_id,
                    "place": place,
                    "act_track": true,
                }),
            )?;
            Ok(())
        });
    }
    pub fn create_entry_in_lane(&mut self, lane: String, cx: &mut Context<Self>) {
        let Some(view_id) = self.view().map(|v| v.id.clone()) else {
            return;
        };
        let untitled = t(cx, keys::common::UNTITLED).to_string();
        self.popup = None;
        self.write(cx, move |lib, book| {
            let entries_before = lib.call(
                &Actor::User,
                "entry.list",
                serde_json::json!({"book": book}),
            )?["output"]
                .clone();
            let memberships_before = lib.call(
                &Actor::User,
                "membership.list",
                serde_json::json!({"book": book}),
            )?["output"]
                .clone();
            let mut lane_members = std::collections::HashSet::<String>::new();
            for e in entries_before.as_array().into_iter().flatten() {
                if e["deleted_at"].is_null()
                    && e["parent"].as_str() == Some(lane.as_str())
                    && let Some(id) = e["id"].as_str()
                {
                    lane_members.insert(id.to_owned());
                }
            }
            for m in memberships_before.as_array().into_iter().flatten() {
                if m["host"].as_str() == Some(lane.as_str())
                    && let Some(id) = m["member"].as_str()
                {
                    lane_members.insert(id.to_owned());
                }
            }
            let created = lib.call(
                &Actor::User,
                "entry.create",
                serde_json::json!({
                    "book": book,
                    "parent": lane,
                    "title": untitled,
                }),
            )?;
            let entry_id = created["output"]["id"]
                .as_str()
                .ok_or_else(|| WsError::Internal("entry.create returned no id".into()))?
                .to_owned();
            let views = lib
                .run::<timeline::ViewList>(&Actor::User, BookIn { book: book.clone() })?
                .output;
            let (at, span) = views
                .iter()
                .find(|v| v.id == view_id && v.deleted_at.is_none())
                .map(|v| {
                    let is_act = v
                        .lanes
                        .iter()
                        .find(|l| l.entry == lane)
                        .is_some_and(|l| l.act_track == Some(true));
                    let lane_end = v
                        .placements
                        .iter()
                        .filter(|p| lane_members.contains(&p.entry))
                        .map(|p| p.at + p.span.unwrap_or(model::DEFAULT_SPAN))
                        .reduce(f64::max);
                    let at = match lane_end {
                        Some(end) => end + 1.0,
                        None => v
                            .placements
                            .iter()
                            .map(|p| p.at)
                            .reduce(f64::min)
                            .unwrap_or(0.0),
                    };
                    (at, is_act.then_some(model::DEFAULT_SPAN))
                })
                .unwrap_or((0.0, None));
            lib.call(
                &Actor::User,
                "timeline_view.place",
                serde_json::json!({
                    "book": book,
                    "view": view_id,
                    "entry": entry_id,
                    "lane": lane,
                    "at": at,
                    "span": span,
                }),
            )?;
            Ok(())
        });
    }
    pub(super) fn view_scope(&self) -> Option<ViewScope> {
        self.scope_for(&self.view()?.id)
    }
    fn scope_for(&self, id: &str) -> Option<ViewScope> {
        let book = self.book.v3()?;
        let view = book
            .timeline_views
            .iter()
            .find(|v| v.id == id && v.deleted_at.is_none())?;
        Some(ViewScope {
            book: self.book.id.clone(),
            view: id.into(),
            guard: book.guard(),
            lanes: view
                .lanes
                .iter()
                .map(|l| (l.entry.clone(), l.act_track == Some(true)))
                .collect(),
        })
    }
    pub(super) fn edit_view(&mut self, id: String, edit: ViewEdit, cx: &mut Context<Self>) {
        let Some(mut scope) = self.scope_for(&id) else {
            return;
        };
        if let Some(draft) = &self.submitting {
            scope.guard = draft.guard.clone();
        }
        self.edit_view_at(scope, edit, cx);
    }
    pub(super) fn edit_view_at(
        &mut self,
        scope: ViewScope,
        edit: ViewEdit,
        cx: &mut Context<Self>,
    ) {
        if scope.book != self.book.id {
            return;
        }
        self.popup = None;
        self.write(cx, move |lib, _| run_view_edit(&lib, scope, edit));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, Library, String, TimelineView) {
        let dir = tempfile::tempdir().unwrap();
        let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev"))
            .unwrap();
        let made = dr_testkit::seed::generate_v3(
            dr_testkit::seed::Preset::Tiny,
            dr_testkit::seed::DEFAULT_SEED,
        )
        .unwrap();
        let id = made.books[0].book_id().to_string();
        made.write_to(&store).unwrap();
        store.close().unwrap();
        let lib = Library::open_dir(dir.path(), "0.2.0-dev").unwrap();
        let mut view = listed(&lib, &id);
        lib.run::<timeline::PinPut>(
            &Actor::User,
            timeline::PinIn {
                book: id.clone(),
                view: view.id.clone(),
                pin: TimelinePin {
                    id: "coverage-pin".into(),
                    at: 3.,
                    label: "Synthetic coverage pin".into(),
                    color: Some("#123456".into()),
                    entry: None,
                },
            },
        )
        .unwrap();
        view = listed(&lib, &id);
        (dir, lib, id, view)
    }
    fn listed(lib: &Library, id: &str) -> TimelineView {
        lib.run::<timeline::ViewList>(&Actor::User, BookIn { book: id.into() })
            .unwrap()
            .output
            .remove(0)
    }

    #[::core::prelude::v1::test]
    fn pin_coverage_checks_each_replaced_field() {
        let (_dir, lib, book, view) = fixture();
        let raw =
            lib.observe(&format!("book:{book}")).unwrap().value["timeline_views"][&view.id]["pins"]
                ["coverage-pin"]
                .clone();
        let pin = view.pins.iter().find(|p| p.id == "coverage-pin").unwrap();
        complete_pin(Some(&raw), pin).unwrap();
        for (field, value) in [
            ("at", json!(99.)),
            ("label", json!("Synthetic hidden label")),
            ("color", json!("#654321")),
            ("entry", json!("synthetic-hidden-target")),
            ("future_field", json!({"synthetic":"retained"})),
        ] {
            let mut changed = raw.clone();
            changed[field] = value;
            assert!(
                matches!(complete_pin(Some(&changed), pin), Err(WsError::Conflict(_))),
                "{field}"
            );
        }
        lib.shutdown().unwrap();
    }

    #[::core::prelude::v1::test]
    fn local_edits_use_the_displayed_frontier_and_retry_preserves_other_writers() {
        let (_dir, lib, book, view) = fixture();
        // The guard of a displayed snapshot: the digest of the view it shows.
        let displayed = || {
            WritePreconditions::default().with_shown(
                lib.observe_records(
                    &format!("book:{book}"),
                    &[RecordKey::timeline_view(&view.id)],
                )
                .unwrap()
                .into_iter()
                .map(Into::into),
            )
        };
        let mut scope = ViewScope {
            book: book.clone(),
            view: view.id.clone(),
            guard: displayed(),
            lanes: view
                .lanes
                .iter()
                .map(|l| (l.entry.clone(), l.act_track == Some(true)))
                .collect(),
        };
        let mut pin = view
            .pins
            .iter()
            .find(|p| p.id == "coverage-pin")
            .unwrap()
            .clone();
        pin.color = Some("#654321".into());
        lib.run::<timeline::PinPut>(
            &Actor::User,
            timeline::PinIn {
                book: book.clone(),
                view: view.id.clone(),
                pin,
            },
        )
        .unwrap();
        let after_other = lib.observe(&format!("book:{book}")).unwrap();
        assert!(matches!(
            run_view_edit(
                &lib,
                scope.clone(),
                ViewEdit::Rename("Synthetic stale edit".into())
            ),
            Err(WsError::Conflict(_))
        ));
        assert_eq!(
            lib.observe(&format!("book:{book}")).unwrap().version,
            after_other.version
        );
        scope.guard = displayed();
        run_view_edit(
            &lib,
            scope,
            ViewEdit::Rename("Synthetic explicit retry".into()),
        )
        .unwrap();
        let raw =
            lib.observe(&format!("book:{book}")).unwrap().value["timeline_views"][&view.id].clone();
        assert_eq!(raw["name"], "Synthetic explicit retry");
        assert_eq!(raw["pins"]["coverage-pin"]["color"], "#654321");
        lib.shutdown().unwrap();
    }
}
