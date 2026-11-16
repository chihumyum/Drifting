use super::*;
mod edit;
pub use edit::{
    Field, LaneActTrackIn, LaneAdd, LaneAddIn, LaneIn, LaneMove, LaneMoveIn, LaneRemove,
    LaneSetActTrack, RenameIn, RestoreFields, RestoreFieldsIn, ViewRename,
};

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
use dr_model::pos::PosKey;

pub(super) fn pos_chain(len: usize) -> Vec<PosKey> {
    let mut out = Vec::with_capacity(len);
    let mut cur = PosKey::first();
    for _ in 0..len {
        out.push(cur.clone());
        cur = cur.after();
    }
    out
}

/// What a lane leaving its last live view writes back
/// (`VIEW-LANE-EXIT-RESTORES-ORDER`): the order of what is hung on it, along
/// the scale, into the memberships' `pos`. What lives under it keeps its
/// manual order all along (DV, 2026-11-16: a lane holds only what is hung on
/// it, so no folder order is written back).
#[derive(Default)]
pub(super) struct LaneExitWriteback {
    pub member_pos: Vec<(EntryId, PosKey)>,
}

impl LaneExitWriteback {
    pub(super) fn is_empty(&self) -> bool {
        self.member_pos.is_empty()
    }
}

pub(super) fn plan_lane_exit_writeback(
    snapshot: &dr_doc::v3::BookStructureV3,
    tv: &m::TimelineView,
    lane: &EntryId,
) -> Result<LaneExitWriteback> {
    let Some(lane_entry) = snapshot.entry(lane).filter(|e| !e.is_trashed()) else {
        return Ok(LaneExitWriteback::default());
    };
    let member_pos = if lane_entry.accepts_members(snapshot.templates_map()) {
        let members = snapshot.members_along_view(tv, lane);
        let chain = pos_chain(members.len());
        members
            .into_iter()
            .zip(chain)
            .map(|(m, pos)| (m.id.clone(), pos))
            .collect()
    } else {
        Vec::new()
    };
    Ok(LaneExitWriteback { member_pos })
}

fn view(v: &BookViewV3<'_>, id: &str) -> Result<m::TimelineView> {
    v.timeline_views_raw()
        .into_iter()
        .find(|t| t.id.as_str() == id && !t.is_trashed())
        .ok_or_else(|| WsError::not_found("timeline view", id))
}
op! {
    ViewList="timeline_view.list",Read,Shared,"List timeline views with their effective lanes, placements and time pins.",fn(cx,input:BookIn)->Vec<types::TimelineView> {
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
    ViewPut="timeline_view.put",Write,Book,"Create or edit a timeline view, including its independent lane order.",fn(cx,input:PutIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let mut tv: m::TimelineView = convert(input.view)?;
        name_ok(&tv.name)?;
        if tv.deleted_at.is_some() {
            return Err(WsError::invalid("use timeline_view.delete"));
        }
        let entries = v.entries_map();
        let templates = v.templates_map();
        let ms = v.memberships_raw();
        let all_raw_views = v.timeline_views_raw();
        let old = all_raw_views.iter().find(|t| t.id == tv.id).cloned();
        // Only a lane this write adds is checked (`kernel-v5.md` §11: the
        // command layer refuses only what this write newly breaks): a lane
        // the view already stores and no longer satisfies the rule (an old
        // folder that is only a level, DV 2026-11-16) stays as it is.
        let stored_lanes: BTreeSet<EntryId> = old
            .iter()
            .filter(|o| !o.is_trashed())
            .flat_map(|o| o.lanes.iter().map(|l| l.entry.clone()))
            .collect();
        let mut lanes = BTreeSet::new();
        for lane in &tv.lanes {
            if !stored_lanes.contains(&lane.entry) {
                m::check_timeline_lane(&lane.entry, &entries, &templates)?;
            }
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
        let snapshot = v.structure_snapshot();
        let effective_lanes = m::effective_timeline_lanes(&tv.lanes, &entries, &templates);
        let mut placed_ids: BTreeSet<EntryId> =
            tv.placements.iter().map(|p| p.entry.clone()).collect();
        let mut next_at = m::timeline_scale_end(&tv.placements);
        for lane in &effective_lanes {
            for item in snapshot.lane_members_order(&lane.entry) {
                if placed_ids.insert(item.id.clone()) {
                    tv.placements.push(m::TimelinePlacement {
                        entry: item.id.clone(),
                        at: next_at,
                        span: None,
                    });
                    next_at += 1.0;
                }
            }
        }
        let other_active_lanes: BTreeSet<EntryId> = all_raw_views
            .iter()
            .filter(|t| t.id != tv.id && !t.is_trashed())
            .flat_map(|t| {
                m::effective_timeline_lanes(&t.lanes, &entries, &templates)
                    .into_iter()
                    .map(|l| l.entry)
            })
            .collect();
        let new_effective_ids: BTreeSet<EntryId> =
            effective_lanes.iter().map(|l| l.entry.clone()).collect();
        let mut exit_writebacks = Vec::new();
        if let Some(old_tv) = old.as_ref().filter(|o| !o.is_trashed()) {
            for old_lane in m::effective_timeline_lanes(&old_tv.lanes, &entries, &templates) {
                if !new_effective_ids.contains(&old_lane.entry)
                    && !other_active_lanes.contains(&old_lane.entry)
                {
                    let wb = plan_lane_exit_writeback(&snapshot, old_tv, &old_lane.entry)?;
                    if !wb.is_empty() {
                        exit_writebacks.push((old_lane.entry, wb));
                    }
                }
            }
        }
        let id = tv.id.clone();
        let mut keys = vec![key("timeline_views", &id)];
        for (lane_id, wb) in &exit_writebacks {
            for (member_id, _) in &wb.member_pos {
                keys.push(key("memberships", m::Membership::key(lane_id, member_id)));
            }
        }
        let replaced = Replaces::record(CollectionV3::TimelineViews, &id);
        let (_, at) = cx.write_book_v3(&s, replaced, move |tx| {
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
            for (lane_id, wb) in &exit_writebacks {
                for (member_id, pos) in &wb.member_pos {
                    tx.restore_membership_pos(
                        lane_id,
                        member_id,
                        Some(&loro::LoroValue::from(pos.as_str())),
                    )?;
                }
            }
            Ok(())
        })?;
        undo(cx, &s, &at, keys);
        cx.effect(EffectAction::Updated, "timeline_view", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}
op! {
    ViewDelete="timeline_view.delete",Write,Book,"Delete a timeline view while retaining lane entries and memberships; lanes leaving their last live view save the scale order of what is hung on them back to the memberships' manual order in the same commit.",fn(cx,input:EntityIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let tv = view(&v, &input.id)?;
        let entries = v.entries_map();
        let templates = v.templates_map();
        let snapshot = v.structure_snapshot();
        let other_active_lanes: BTreeSet<EntryId> = v
            .timeline_views_raw()
            .into_iter()
            .filter(|t| t.id != tv.id && !t.is_trashed())
            .flat_map(|t| {
                m::effective_timeline_lanes(&t.lanes, &entries, &templates)
                    .into_iter()
                    .map(|l| l.entry)
            })
            .collect();
        let mut exit_writebacks = Vec::new();
        for lane in m::effective_timeline_lanes(&tv.lanes, &entries, &templates) {
            if !other_active_lanes.contains(&lane.entry) {
                let wb = plan_lane_exit_writeback(&snapshot, &tv, &lane.entry)?;
                if !wb.is_empty() {
                    exit_writebacks.push((lane.entry, wb));
                }
            }
        }
        let id = tv.id.clone();
        let mut keys = vec![key("timeline_views", &id)];
        for (lane_id, wb) in &exit_writebacks {
            for (member_id, _) in &wb.member_pos {
                keys.push(key("memberships", m::Membership::key(lane_id, member_id)));
            }
        }
        let trashed = rec(CollectionV3::TimelineViews, &id).at(["deleted_at"]);
        let (_, at) = cx.write_book_v3(&s, Replaces::records([trashed]), move |t| {
            t.timeline_view(&tv.id)?.deleted_at(Some(now()))?;
            for (lane_id, wb) in &exit_writebacks {
                for (member_id, pos) in &wb.member_pos {
                    t.restore_membership_pos(
                        lane_id,
                        member_id,
                        Some(&loro::LoroValue::from(pos.as_str())),
                    )?;
                }
            }
            Ok(())
        })?;
        undo(cx, &s, &at, keys);
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
    /// Move the membership from this host when joining the target lane.
    #[serde(default)]
    #[schemars(skip)]
    pub from_host: Option<String>,
    pub at: f64,
    #[serde(default)]
    pub span: Option<f64>,
}
op! {
    Place="timeline_view.place",Write,Book,"Place or move an entry in a timeline, optionally joining a lane in the same commit.",fn(cx,input:PlaceIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let tv = view(&v, &input.view)?;
        let e = live(&v, &input.entry)?;
        let before = v.graph();
        let (entries, templates) = (&before.entries, &before.templates);
        let mut ms = before.memberships.clone();
        finite(input.at, input.span)?;
        let lane: Option<EntryId> = input.lane.as_deref().map(|s| pid("lane", s)).transpose()?;
        let mut join = false;
        if let Some(lane) = &lane {
            if !tv.lanes.iter().any(|l| &l.entry == lane) {
                return Err(WsError::invalid("lane is not in this view"));
            }
            m::check_timeline_lane(lane, entries, templates)?;
            // A lane holds what is hung on it: placing an entry on a lane
            // hangs it there, wherever it lives (DV, 2026-11-16).
            m::check_membership(lane, &e.id, entries, templates)?;
            if !ms.iter().any(|m| &m.host == lane && m.member == e.id) {
                ms.push(m::Membership {
                    host: lane.clone(),
                    member: e.id.clone(),
                    pos: None,
                    created_at: Some(now()),
                });
                join = true;
            }
        }
        let transfer = if let Some(from) = input.from_host.as_deref() {
            if !matches!(cx.actor(), crate::Actor::User) {
                return Err(WsError::invalid("membership transfer is a workspace UI operation"));
            }
            let to = lane.as_ref().ok_or_else(|| WsError::invalid("a membership transfer needs a target lane"))?;
            let transfer = membership::Transfer::plan(&v, from, to, &e.id)?;
            transfer.remove_from(&mut ms);
            Some(transfer)
        } else {
            None
        };
        m::check_timeline_placement_in_lane(&tv, &e.id, &ms, entries, templates)?;
        let after = BookGraphV3 {
            memberships: ms,
            ..before.clone()
        };
        changes_ok(&before, &after)?;
        let mut other_views = Vec::new();
        if let Some(lane) = lane.as_ref().filter(|_| join) {
            for other_tv in membership::live_views_with_lane(&v, lane) {
                if other_tv.id != tv.id
                    && v.timeline_placement_snapshot(&other_tv.id, &e.id)?.is_none()
                {
                    let end = m::timeline_scale_end(&m::effective_timeline_placements(
                        &other_tv,
                        &before.memberships,
                        entries,
                        templates,
                    ));
                    other_views.push((other_tv.id, end));
                }
            }
        }
        let mut keys = vec![key("timeline_views", &tv.id)];
        if let Some(lane) = lane.as_ref().filter(|_| join) {
            keys.push(key("memberships", m::Membership::key(lane, &e.id)));
        }
        for (vid, _) in &other_views {
            keys.push(key("timeline_views", vid));
        }
        let id = e.id.clone();
        // The entry's position in this view. A membership it joins is new.
        let placed = rec(CollectionV3::TimelineViews, &tv.id).at(["placements", id.as_str()]);
        let replaced = std::iter::once(placed).chain(transfer.iter().flat_map(|plan| plan.replaced()));
        keys.extend(transfer.iter().flat_map(|plan| plan.undo_keys()));
        let (_, at) = cx.write_book_v3(&s, Replaces::records(replaced), move |t| {
            if let Some(lane) = lane.filter(|_| join) {
                t.put_membership(&lane, &e.id, None, Some(now()))?;
            }
            t.timeline_view(&tv.id)?
                .put_placement(&e.id, input.at, input.span)?;
            for (vid, end) in &other_views {
                t.timeline_view(vid)?.put_placement(&e.id, *end, None)?;
            }
            if let Some(transfer) = transfer {
                transfer.apply(t)?;
            }
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
    PinPut="timeline_view.put_pin",Write,Book,"Add or edit a time pin, optionally bound to any live entry.",fn(cx,input:PinIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let tv = view(&v, &input.view)?;
        let p: m::TimelinePin = convert(input.pin)?;
        pin_ok(&v, &p)?;
        let id = p.id.clone();
        let vid = tv.id.clone();
        let replaced = rec(CollectionV3::TimelineViews, &vid).at(["pins", id.as_str()]);
        let (_, at) = cx.write_book_v3(&s, Replaces::records([replaced]), move |t| {
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
    PinRemove="timeline_view.remove_pin",Write,Book,"Remove a time pin from a timeline view.",fn(cx,input:PinRemoveIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let tv = view(&s.reader_v3.view(), &input.view)?;
        let pin: TimePinId = pid("pin", &input.pin)?;
        let vid = tv.id.clone();
        let removed = rec(CollectionV3::TimelineViews, &vid).at(["pins", pin.as_str()]);
        let (_, at) = cx.write_book_v3(&s, Replaces::records([removed]), move |t| {
            t.timeline_view(&tv.id)?.remove_pin(&pin)?;
            Ok(())
        })?;
        undo(cx, &s, &at, vec![key("timeline_views", &vid)]);
        cx.effect(EffectAction::Purged, "time_pin", &input.pin, None);
        Ok(Done { id: input.pin })
    }
}
