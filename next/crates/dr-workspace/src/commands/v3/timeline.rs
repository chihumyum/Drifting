use super::*;
mod edit;
pub use edit::{
    Field, LaneActTrackIn, LaneAdd, LaneAddIn, LaneIn, LaneMove, LaneMoveIn, LaneRemove,
    LaneSetActTrack, RenameIn, RestoreFields, RestoreFieldsIn, ViewRename,
};

/// Built-in swimlane level template for an act track (`tpl-act-track`).
pub fn act_track_template(name: String) -> types::EntryTemplate {
    let mut tpl = dr_doc::v3::act_track_level_template();
    tpl.name = name;
    convert(tpl).expect("valid built-in act track template")
}
pub(crate) fn register(r: &mut Registry) {
    edit::register(r);
    r.add::<ViewList>()
        .add::<ViewPut>()
        .add::<ViewDelete>()
        .add::<Place>()
        .add::<Remove>()
        .add::<PinPut>()
        .add::<PinRemove>();
}
fn view(v: &BookViewV3<'_>, id: &str) -> Result<m::TimelineView> {
    v.timeline_views_raw()
        .into_iter()
        .find(|t| t.id.as_str() == id && !t.is_trashed())
        .ok_or_else(|| WsError::not_found("timeline view", id))
}
op! {
    ViewList="timeline_view.list",Read,Shared,"List v3 timeline views with their effective lanes, placements and time pins.",fn(cx,input:BookIn)->Vec<types::TimelineView> {
        let s = cx.book_v3(&input.book)?;
        convert(s.reader_v3.view().timeline_views())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PutIn {
    pub book: String,
    pub view: types::TimelineView,
}
op! {
    ViewPut="timeline_view.put",Write,Book,"Create or edit a v3 timeline view, including its independent lane order.",fn(cx,input:PutIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let tv: m::TimelineView = convert(input.view)?;
        name_ok(&tv.name)?;
        if tv.deleted_at.is_some() {
            return Err(WsError::invalid("use timeline_view.delete"));
        }
        let entries = v.entries_map();
        let templates = v.templates_map();
        let ms = v.memberships_raw();
        let mut lanes = BTreeSet::new();
        for lane in &tv.lanes {
            m::check_timeline_lane(&lane.entry, &entries, &templates)?;
            if !lanes.insert(&lane.entry) {
                return Err(WsError::invalid("duplicate lane"));
            }
        }
        let mut placements = BTreeSet::new();
        for p in &tv.placements {
            finite(p.at, p.span)?;
            m::check_timeline_placement_in_lane(&tv, &p.entry, &ms, &entries, &templates)?;
            if !placements.insert(&p.entry) {
                return Err(WsError::invalid("duplicate placement"));
            }
        }
        let mut pins = BTreeSet::new();
        for pin in &tv.pins {
            pin_ok(&v, pin)?;
            if !pins.insert(&pin.id) {
                return Err(WsError::invalid("duplicate pin"));
            }
        }
        let old = v.timeline_views_raw().into_iter().find(|t| t.id == tv.id);
        let id = tv.id.clone();
        let (_, at) = cx.write_book_v3(&s, move |tx| {
            let w = tx.timeline_view(&tv.id)?;
            w.name(&tv.name)?.pos(tv.pos.as_ref())?.deleted_at(None)?;
            if let Some(old) = old {
                for l in old.lanes {
                    if !tv.lanes.iter().any(|x| x.entry == l.entry) {
                        w.remove_lane(&l.entry)?;
                    }
                }
                for p in old.placements {
                    if !tv.placements.iter().any(|x| x.entry == p.entry) {
                        w.remove_placement(&p.entry)?;
                    }
                }
                for p in old.pins {
                    if !tv.pins.iter().any(|x| x.id == p.id) {
                        w.remove_pin(&p.id)?;
                    }
                }
            }
            for l in tv.lanes {
                w.put_lane(&l.entry, l.pos.as_ref())?
                    .set_lane_act_track(&l.entry, l.act_track)?;
            }
            for p in tv.placements {
                w.put_placement(&p.entry, p.at, p.span)?;
            }
            for p in tv.pins {
                w.put_pin(&p)?;
            }
            Ok(())
        })?;
        undo(cx, &s, &at, vec![key("timeline_views", &id)]);
        cx.effect(EffectAction::Updated, "timeline_view", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}
op! {
    ViewDelete="timeline_view.delete",Write,Book,"Delete a v3 timeline view while retaining lane entries and memberships.",fn(cx,input:EntityIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let tv = view(&s.reader_v3.view(), &input.id)?;
        let id = tv.id.clone();
        let (_, at) = cx.write_book_v3(&s, move |t| {
            t.timeline_view(&tv.id)?.deleted_at(Some(now()))?;
            Ok(())
        })?;
        undo(cx, &s, &at, vec![key("timeline_views", &id)]);
        cx.effect(EffectAction::Trashed, "timeline_view", id.as_str(), None);
        Ok(Done { id: input.id })
    }
}
fn finite(at: f64, span: Option<f64>) -> Result<()> {
    if !at.is_finite() || span.is_some_and(|n| !n.is_finite() || n < 0.) {
        Err(WsError::invalid(
            "timeline coordinates must be finite and span nonnegative",
        ))
    } else {
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PlaceIn {
    pub book: String,
    pub view: String,
    pub entry: String,
    /// When supplied, join this lane in the same commit; omitted, keep memberships.
    #[serde(default)]
    pub lane: Option<String>,
    pub at: f64,
    #[serde(default)]
    pub span: Option<f64>,
}
op! {
    Place="timeline_view.place",Write,Book,"Place or move a v3 entry in a timeline, optionally joining a lane in the same commit.",fn(cx,input:PlaceIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let tv = view(&v, &input.view)?;
        let e = live(&v, &input.entry)?;
        let entries = v.entries_map();
        let templates = v.templates_map();
        let mut ms = v.memberships_raw();
        finite(input.at, input.span)?;
        let lane: Option<EntryId> = input.lane.as_deref().map(|s| pid("lane", s)).transpose()?;
        if let Some(lane) = &lane {
            if !tv.lanes.iter().any(|l| &l.entry == lane) {
                return Err(WsError::invalid("lane is not in this view"));
            }
            m::check_timeline_lane(lane, &entries, &templates)?;
            m::check_membership(lane, &e.id, &entries, &templates)?;
            ms.push(m::Membership {
                host: lane.clone(),
                member: e.id.clone(),
                pos: None,
                created_at: Some(now()),
            });
        }
        m::check_timeline_placement_in_lane(&tv, &e.id, &ms, &entries, &templates)?;
        graph_ok(&entries, &templates, &ms)?;
        let join = lane.as_ref().is_some_and(|lane| {
            !v.memberships_raw()
                .iter()
                .any(|m| &m.host == lane && m.member == e.id)
        });
        let mut keys = vec![key("timeline_views", &tv.id)];
        if let Some(lane) = lane.as_ref().filter(|_| join) {
            keys.push(key("memberships", m::Membership::key(lane, &e.id)));
        }
        let id = e.id.clone();
        let (_, at) = cx.write_book_v3(&s, move |t| {
            if let Some(lane) = lane.filter(|_| join) {
                t.put_membership(&lane, &e.id, None, Some(now()))?;
            }
            t.timeline_view(&tv.id)?
                .put_placement(&e.id, input.at, input.span)?;
            Ok(())
        })?;
        undo(cx, &s, &at, keys);
        cx.effect(EffectAction::Moved, "entry", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RemoveIn {
    pub book: String,
    pub view: String,
    pub entry: String,
    pub lane: String,
}
op! {
    Remove="timeline_view.remove",Write,Book,"Remove an entry from a timeline lane and prune positions where it has no remaining lane.",fn(cx,input:RemoveIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let tv = view(&v, &input.view)?;
        if !tv.lanes.iter().any(|l| l.entry.as_str() == input.lane) {
            return Err(WsError::invalid("lane is not in this view"));
        }
        live(&v, &input.entry)?;
        <membership::MembershipRemove as crate::registry::Op>::run(
            cx,
            membership::In {
                book: input.book,
                host: input.lane,
                member: input.entry,
            },
        )
    }
}
fn pin_ok(v: &BookViewV3<'_>, pin: &m::TimelinePin) -> Result<()> {
    finite(pin.at, None)?;
    if let Some(e) = &pin.entry {
        live(v, e.as_str())?;
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PinIn {
    pub book: String,
    pub view: String,
    pub pin: types::TimelinePin,
}
op! {
    PinPut="timeline_view.put_pin",Write,Book,"Add or edit a v3 time pin, optionally bound to any live entry.",fn(cx,input:PinIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let tv = view(&v, &input.view)?;
        let p: m::TimelinePin = convert(input.pin)?;
        pin_ok(&v, &p)?;
        let id = p.id.clone();
        let vid = tv.id.clone();
        let (_, at) = cx.write_book_v3(&s, move |t| {
            t.timeline_view(&tv.id)?.put_pin(&p)?;
            Ok(())
        })?;
        undo(cx, &s, &at, vec![key("timeline_views", &vid)]);
        cx.effect(EffectAction::Updated, "time_pin", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PinRemoveIn {
    pub book: String,
    pub view: String,
    pub pin: String,
}
op! {
    PinRemove="timeline_view.remove_pin",Write,Book,"Remove a time pin from a v3 timeline view.",fn(cx,input:PinRemoveIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let tv = view(&s.reader_v3.view(), &input.view)?;
        let pin: TimePinId = pid("pin", &input.pin)?;
        let vid = tv.id.clone();
        let (_, at) = cx.write_book_v3(&s, move |t| {
            t.timeline_view(&tv.id)?.remove_pin(&pin)?;
            Ok(())
        })?;
        undo(cx, &s, &at, vec![key("timeline_views", &vid)]);
        cx.effect(EffectAction::Purged, "time_pin", &input.pin, None);
        Ok(Done { id: input.pin })
    }
}
