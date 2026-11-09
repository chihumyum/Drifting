use super::*;
use dr_model::pos::PosKey;
use dr_workspace::{
    Actor, Observation, WritePreconditions, WsError,
    commands::{
        BookIn, EntityIn,
        v3::{
            membership, timeline,
            types::{TimelineLane, TimelinePin, TimelineView},
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

pub(super) fn complete_view(raw: Option<&Value>, view: &TimelineView) -> Result<(), WsError> {
    let mut expected = record(view, "id")?;
    for (field, key) in [("lanes", "entry"), ("placements", "entry"), ("pins", "id")] {
        let records = expected[field].as_array().unwrap();
        let mut keyed = Map::new();
        for row in records {
            keyed.insert(row[key].as_str().unwrap().to_owned(), record(row, key)?);
        }
        expected[field] = Value::Object(keyed);
    }
    require_coverage(raw, &expected)
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

pub(super) fn replace(
    lib: &Library,
    command: &str,
    input: Value,
    observed: Observation,
) -> Result<(), WsError> {
    lib.call_guarded(
        &Actor::User,
        command,
        input,
        WritePreconditions::from_observations([observed]),
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
                if let Some(draft) = draft
                    && timeline.latest_edit == Some(draft.field.entity_id())
                {
                    if result.is_err()
                        && timeline.book.id == submitted_book
                        && timeline.editing.is_none()
                    {
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
            let observed = lib.observe(&format!("book:{book}"))?;
            if observed.value["timeline_views"].get(&id).is_some() {
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
                observed,
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
            let raw = observed
                .value
                .get("timeline_views")
                .and_then(|views| views.get(&id));
            complete_view(raw, &v)?;
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
            replace(
                &lib,
                "timeline_view.put",
                serde_json::json!({"book":book,"view":v}),
                observed,
            )?;
            Ok(())
        });
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
    fn coverage_checks_every_replaced_field_and_record_identity() {
        let (_dir, lib, book, view) = fixture();
        let raw =
            lib.observe(&format!("book:{book}")).unwrap().value["timeline_views"][&view.id].clone();
        complete_view(Some(&raw), &view).unwrap();
        let pin = view.pins.iter().find(|p| p.id == "coverage-pin").unwrap();
        complete_pin(raw["pins"].get(&pin.id), pin).unwrap();
        for (field, value) in [
            ("name", json!("Synthetic hidden name")),
            ("pos", json!("z0")),
            ("deleted_at", json!(1)),
        ] {
            let mut changed = raw.clone();
            changed[field] = value;
            assert!(
                matches!(
                    complete_view(Some(&changed), &view),
                    Err(WsError::Conflict(_))
                ),
                "{field}"
            );
        }
        for (collection, id, field, value) in [
            ("lanes", view.lanes[0].entry.as_str(), "pos", json!("z0")),
            (
                "placements",
                view.placements[0].entry.as_str(),
                "at",
                json!(99.),
            ),
            (
                "placements",
                view.placements[0].entry.as_str(),
                "span",
                json!(99.),
            ),
            ("pins", pin.id.as_str(), "at", json!(99.)),
            (
                "pins",
                pin.id.as_str(),
                "label",
                json!("Synthetic hidden label"),
            ),
            ("pins", pin.id.as_str(), "color", json!("#654321")),
            (
                "pins",
                pin.id.as_str(),
                "entry",
                json!("synthetic-hidden-target"),
            ),
        ] {
            let mut changed = raw.clone();
            changed[collection][id][field] = value;
            assert!(
                matches!(
                    complete_view(Some(&changed), &view),
                    Err(WsError::Conflict(_))
                ),
                "{collection}.{field}"
            );
            if collection == "pins" {
                assert!(
                    matches!(
                        complete_pin(changed["pins"].get(id), pin),
                        Err(WsError::Conflict(_))
                    ),
                    "pin.{field}"
                );
            }
        }
        for collection in ["lanes", "placements", "pins"] {
            let mut changed = raw.clone();
            let records = changed[collection].as_object_mut().unwrap();
            let key = records.keys().next().unwrap().clone();
            let row = records.remove(&key).unwrap();
            records.insert("synthetic-unread-id".into(), row);
            assert!(
                matches!(
                    complete_view(Some(&changed), &view),
                    Err(WsError::Conflict(_))
                ),
                "identity of {collection}"
            );
        }
        let mut unknown = raw.clone();
        unknown["future_field"] = json!({"synthetic":"retained"});
        assert!(matches!(
            complete_view(Some(&unknown), &view),
            Err(WsError::Conflict(_))
        ));
        lib.shutdown().unwrap();
    }

    #[::core::prelude::v1::test]
    fn guarded_replacements_refuse_stale_versions_and_explicit_retries_keep_both_writers() {
        let (_dir, lib, book, mut view) = fixture();
        let first = lib.observe(&format!("book:{book}")).unwrap();
        complete_view(first.value["timeline_views"].get(&view.id), &view).unwrap();
        view.name = "Synthetic first writer".into();
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
                pin: pin.clone(),
            },
        )
        .unwrap();
        assert!(matches!(
            replace(
                &lib,
                "timeline_view.put",
                json!({"book":book,"view":view}),
                first
            ),
            Err(WsError::Conflict(_))
        ));
        let fresh = lib.observe(&format!("book:{book}")).unwrap();
        let mut latest = listed(&lib, &book);
        complete_view(fresh.value["timeline_views"].get(&latest.id), &latest).unwrap();
        latest.name = view.name.clone();
        replace(
            &lib,
            "timeline_view.put",
            json!({"book":book,"view":latest}),
            fresh,
        )
        .unwrap();
        let raw =
            lib.observe(&format!("book:{book}")).unwrap().value["timeline_views"][&view.id].clone();
        assert_eq!(raw["name"], view.name);
        assert_eq!(raw["pins"][&pin.id]["color"], "#654321");

        let first = lib.observe(&format!("book:{book}")).unwrap();
        let mut renamed = pin.clone();
        renamed.label = "Synthetic second writer".into();
        complete_pin(
            first.value["timeline_views"][&view.id]["pins"].get(&pin.id),
            &pin,
        )
        .unwrap();
        pin.at = 99.;
        lib.run::<timeline::PinPut>(
            &Actor::User,
            timeline::PinIn {
                book: book.clone(),
                view: view.id.clone(),
                pin: pin.clone(),
            },
        )
        .unwrap();
        assert!(matches!(
            replace(
                &lib,
                "timeline_view.put_pin",
                json!({"book":book,"view":view.id,"pin":renamed}),
                first
            ),
            Err(WsError::Conflict(_))
        ));
        let fresh = lib.observe(&format!("book:{book}")).unwrap();
        let latest = listed(&lib, &book);
        let mut latest = latest.pins.into_iter().find(|p| p.id == pin.id).unwrap();
        complete_pin(
            fresh.value["timeline_views"][&view.id]["pins"].get(&pin.id),
            &latest,
        )
        .unwrap();
        latest.label = renamed.label.clone();
        replace(
            &lib,
            "timeline_view.put_pin",
            json!({"book":book,"view":view.id,"pin":latest}),
            fresh,
        )
        .unwrap();
        let raw =
            lib.observe(&format!("book:{book}")).unwrap().value["timeline_views"][&view.id].clone();
        assert_eq!(raw["pins"][&pin.id]["label"], renamed.label);
        assert_eq!(raw["pins"][&pin.id]["at"], 99.);
        assert_eq!(raw["pins"][&pin.id]["color"], "#654321");
        lib.shutdown().unwrap();
    }
}
