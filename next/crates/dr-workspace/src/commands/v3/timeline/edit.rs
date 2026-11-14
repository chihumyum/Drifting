//! Field-scoped timeline edits. All planning reads run in the same holder job
//! as the guarded write, before the first mutation. Filtered DTOs are never
//! used as replacement documents, including when an edit is undone.
use super::*;
use crate::naming::{Place as Order, pos_for};
use dr_doc::v3::TimelineFieldV3;
use dr_model::pos::{PosKey, cmp_pos};

pub(super) fn register(r: &mut Registry) {
    r.add::<ViewRename>()
        .add::<LaneAdd>()
        .add::<LaneMove>()
        .add::<LaneSetActTrack>()
        .add::<LaneRemove>()
        .add::<RestoreFields>();
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "field", rename_all = "snake_case")]
pub enum Field {
    Name,
    Lane { lane: String },
    LanePosition { lane: String },
    LaneActTrack { lane: String },
    Placement { entry: String },
}
impl Field {
    fn key(&self) -> Result<TimelineFieldV3> {
        Ok(match self {
            Self::Name => TimelineFieldV3::Name,
            Self::Lane { lane } => TimelineFieldV3::Lane(pid("lane", lane)?),
            Self::LanePosition { lane } => TimelineFieldV3::LanePosition(pid("lane", lane)?),
            Self::LaneActTrack { lane } => TimelineFieldV3::LaneActTrack(pid("lane", lane)?),
            Self::Placement { entry } => TimelineFieldV3::Placement(pid("entry", entry)?),
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RenameIn {
    pub book: String,
    pub view: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LaneIn {
    pub book: String,
    pub view: String,
    pub lane: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LaneAddIn {
    #[serde(flatten)]
    pub target: LaneIn,
    /// Omit to append after all stored lanes, including hidden lanes.
    #[serde(default)]
    pub place: Option<Order>,
    #[serde(default)]
    pub act_track: Option<bool>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LaneActTrackIn {
    #[serde(flatten)]
    pub target: LaneIn,
    pub act_track: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LaneMoveIn {
    #[serde(flatten)]
    pub target: LaneIn,
    /// Only this lane's position changes. Neighbours may be hidden lanes.
    pub place: Order,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RestoreFieldsIn {
    pub book: String,
    pub view: String,
    /// Stored book frontier, used by the field-scoped undo/redo receipt.
    pub at: String,
    /// State after the recorded write; selected values must still match.
    pub expected: String,
    pub fields: Vec<Field>,
    /// `(host, member)` pairs whose `pos` was written back when `host` left its
    /// last live view (`VIEW-LANE-EXIT-RESTORES-ORDER`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub membership_pos: Vec<(String, String)>,
    /// Folder entry ID whose direct child order was written back when it left
    /// its last live view (`VIEW-FOLDER-ORDER-FROM-SCALE`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_order: Option<String>,
}

/// A lane of a view, or one of its fields, as the key of a write guard.
fn lane_key(view: &TimelineViewId, lane: &EntryId, field: Option<&str>) -> dr_doc::v3::RecordKeyV3 {
    rec(CollectionV3::TimelineViews, view)
        .at(["lanes", lane.as_str()])
        .at(field)
}

#[derive(Default)]
struct UndoExtra {
    membership_pos: Vec<(String, String)>,
    child_order: Option<String>,
}

fn finish(
    cx: &Cx<'_>,
    slot: &BookSlot,
    view: String,
    fields: Vec<Field>,
    extra: UndoExtra,
    before: loro::Frontiers,
    expected: String,
) -> Result<Done> {
    if fields.is_empty() && extra.membership_pos.is_empty() && extra.child_order.is_none() {
        cx.undo_nothing();
    } else {
        cx.undo_with(Invocation::new(
            "timeline_view.restore_fields",
            RestoreFieldsIn {
                book: slot.book.to_string(),
                view: view.clone(),
                at: frontiers_hex(&before),
                expected,
                fields,
                membership_pos: extra.membership_pos,
                child_order: extra.child_order,
            },
        ));
        cx.effect(EffectAction::Updated, "timeline_view", &view, None);
    }
    Ok(Done { id: view })
}

// Do not silently renumber other lanes when history has equal/absent keys.
// If a one-field move cannot express the requested order, refuse unchanged.
fn position(tv: &m::TimelineView, lane: &EntryId, place: &Order) -> Result<PosKey> {
    let rest: Vec<_> = tv.lanes.iter().filter(|l| &l.entry != lane).collect();
    let find = |id: &str| {
        rest.iter()
            .position(|l| l.entry.as_str() == id)
            .ok_or_else(|| WsError::not_found("timeline lane", id))
    };
    let index = match place {
        Order::First => 0,
        Order::Last => rest.len(),
        Order::Before(id) => find(id)?,
        Order::After(id) => find(id)? + 1,
    };
    let items: Vec<_> = rest
        .iter()
        .map(|l| (l.entry.to_string(), l.pos.clone()))
        .collect();
    let pos = pos_for(&items, place)?;
    let mut wanted: Vec<_> = rest.iter().map(|l| l.entry.clone()).collect();
    wanted.insert(index, lane.clone());
    let mut result: Vec<_> = rest.into_iter().cloned().collect();
    result.push(m::TimelineLane {
        entry: lane.clone(),
        pos: Some(pos.clone()),
        act_track: None,
    });
    result.sort_by(|a, b| cmp_pos((a.pos.as_ref(), &a.entry), (b.pos.as_ref(), &b.entry)));
    if !result.iter().map(|l| &l.entry).eq(wanted.iter()) {
        return Err(WsError::Conflict(
            "lane order cannot be changed without rewriting other positions".into(),
        ));
    }
    Ok(pos)
}

op! {
    ViewRename = "timeline_view.rename", Write, Book,
    "Rename a timeline view without changing its lanes, positions or pins.",
    fn(cx, input: RenameIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        name_ok(&input.name)?;
        let id: TimelineViewId = pid("timeline view", &input.view)?;
        let name = input.name.trim().to_owned();
        let replaced = rec(CollectionV3::TimelineViews, &id).at(["name"]);
        let ((fields, expected), before) = cx.write_book_v3(&slot, Replaces::records([replaced]), move |tx| {
            let tv = view(&tx.view(), id.as_str())?;
            tx.view().timeline_field_restore_state(&id, &TimelineFieldV3::Name)?;
            if tv.name == name { return Ok((vec![], frontiers_hex(&tx.view().state_frontiers()))); }
            tx.timeline_view(&id)?.name(&name)?;
            Ok((vec![Field::Name], frontiers_hex(&tx.view().state_frontiers())))
        })?;
        finish(cx, &slot, input.view, fields, UndoExtra::default(), before, expected)
    }
}
op! {
    LaneAdd = "timeline_view.add_lane", Write, Book,
    "Add one live lane to a view without replacing existing lane records or changing memberships.",
    fn(cx, input: LaneAddIn) -> Done {
        let slot = cx.book_v3(&input.target.book)?;
        let id: TimelineViewId = pid("timeline view", &input.target.view)?;
        let lane: EntryId = pid("lane", &input.target.lane)?;
        let place = input.place.unwrap_or(Order::Last);
        let replaced = lane_key(&id, &lane, None);
        let ((fields, expected), before) = cx.write_book_v3(&slot, Replaces::records([replaced]), move |tx| {
            let v = tx.view();
            let tv = view(&v, id.as_str())?;
            // Preflight retained native data before adding or restoring a lane.
            v.timeline_field_restore_state(&id, &TimelineFieldV3::Lane(lane.clone()))?;
            // Presence checks use the stored value, not the tolerant DTO.
            if v.timeline_field_snapshot(&id, &TimelineFieldV3::Lane(lane.clone()))?.is_some() {
                return Err(WsError::Conflict("lane already exists in this view".into()));
            }
            m::check_timeline_lane(&lane, &v.entries_map(), &v.templates_map())?;
            let pos = position(&tv, &lane, &place)?;
            let snapshot = v.structure_snapshot();
            let mut unplaced = Vec::new();
            for item in snapshot.lane_entries_order(&lane) {
                if v.timeline_field_snapshot(&id, &TimelineFieldV3::Placement(item.id.clone()))?
                    .is_none()
                {
                    unplaced.push(item.id.clone());
                }
            }
            let mut fields = vec![Field::Lane {
                lane: lane.to_string(),
            }];
            fields.extend(unplaced.iter().map(|m| Field::Placement {
                entry: m.to_string(),
            }));
            for field in &fields {
                v.timeline_field_restore_state(&id, &field.key()?)?;
            }
            let start_at = m::timeline_scale_end(&m::effective_timeline_placements(
                &tv,
                &v.memberships_raw(),
                &v.entries_map(),
                &v.templates_map(),
            ));
            let w = tx.timeline_view(&id)?;
            w.put_lane(&lane, Some(&pos))?
                .set_lane_act_track(&lane, input.act_track.filter(|b| *b))?;
            for (i, member) in unplaced.iter().enumerate() {
                w.put_placement(member, start_at + (i as f64), None)?;
            }
            Ok((fields, frontiers_hex(&tx.view().state_frontiers())))
        })?;
        finish(cx, &slot, input.target.view, fields, UndoExtra::default(), before, expected)
    }
}
op! {
    LaneSetActTrack = "timeline_view.set_lane_act_track", Write, Book,
    "Switch whether a stored lane in a view is displayed as a top act track.",
    fn(cx, input: LaneActTrackIn) -> Done {
        let slot = cx.book_v3(&input.target.book)?;
        let id: TimelineViewId = pid("timeline view", &input.target.view)?;
        let lane: EntryId = pid("lane", &input.target.lane)?;
        let replaced = lane_key(&id, &lane, Some("act_track"));
        let ((fields, expected), before) = cx.write_book_v3(&slot, Replaces::records([replaced]), move |tx| {
            let v = tx.view();
            let tv = view(&v, id.as_str())?;
            let old = tv.lanes.iter().find(|l| l.entry == lane)
                .ok_or_else(|| WsError::not_found("timeline lane", lane.as_str()))?;
            let key = TimelineFieldV3::LaneActTrack(lane.clone());
            v.timeline_field_restore_state(&id, &key)?;
            if old.is_act_track() == input.act_track {
                return Ok((vec![], frontiers_hex(&tx.view().state_frontiers())));
            }
            tx.timeline_view(&id)?.set_lane_act_track(&lane, input.act_track.then_some(true))?;
            Ok((vec![Field::LaneActTrack { lane: lane.to_string() }], frontiers_hex(&tx.view().state_frontiers())))
        })?;
        finish(cx, &slot, input.target.view, fields, UndoExtra::default(), before, expected)
    }
}
op! {
    LaneMove = "timeline_view.move_lane", Write, Book,
    "Change only one stored lane's order in a view, preserving hidden data and other lane positions.",
    fn(cx, input: LaneMoveIn) -> Done {
        let slot = cx.book_v3(&input.target.book)?;
        let id: TimelineViewId = pid("timeline view", &input.target.view)?;
        let lane: EntryId = pid("lane", &input.target.lane)?;
        let replaced = lane_key(&id, &lane, Some("pos"));
        let ((fields, expected), before) = cx.write_book_v3(&slot, Replaces::records([replaced]), move |tx| {
            let v = tx.view();
            let tv = view(&v, id.as_str())?;
            let old = tv.lanes.iter().find(|l| l.entry == lane)
                .ok_or_else(|| WsError::not_found("timeline lane", lane.as_str()))?;
            let key = TimelineFieldV3::LanePosition(lane.clone());
            v.timeline_field_restore_state(&id, &key)?;
            let pos = position(&tv, &lane, &input.place)?;
            if old.pos.as_ref() == Some(&pos) { return Ok((vec![], frontiers_hex(&tx.view().state_frontiers()))); }
            tx.timeline_view(&id)?.put_lane(&lane, Some(&pos))?;
            Ok((vec![Field::LanePosition { lane: lane.to_string() }], frontiers_hex(&tx.view().state_frontiers())))
        })?;
        finish(cx, &slot, input.target.view, fields, UndoExtra::default(), before, expected)
    }
}
op! {
    LaneRemove = "timeline_view.remove_lane", Write, Book,
    "Remove one view lane and newly orphaned visible positions, saving its scale order back to manual order when leaving its last live view.",
    fn(cx, input: LaneIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id: TimelineViewId = pid("timeline view", &input.view)?;
        let lane: EntryId = pid("lane", &input.lane)?;
        // The lane; positions it orphans and last-view order writeback are planned below.
        let removed = lane_key(&id, &lane, None);
        let ((fields, extra, expected), before) = cx.write_book_v3(&slot, Replaces::records([removed]), move |tx| {
            let v = tx.view();
            let tv = view(&v, id.as_str())?;
            if v.timeline_field_snapshot(&id, &TimelineFieldV3::Lane(lane.clone()))?.is_none() {
                return Err(WsError::not_found("timeline lane", lane.as_str()));
            }
            let ms = v.memberships_raw();
            let entries_map = v.entries_map();
            let templates_map = v.templates_map();
            let remaining: BTreeSet<_> = tv.lanes.iter().filter(|l| l.entry != lane).map(|l| &l.entry).collect();
            let prune: Vec<_> = m::effective_timeline_placements(&tv, &ms, &entries_map, &templates_map)
                .into_iter()
                .filter(|p| {
                    let was_in_lane = ms.iter().any(|m| m.host == lane && m.member == p.entry)
                        || entries_map
                            .get(&p.entry)
                            .is_some_and(|e| e.parent.as_ref() == Some(&lane));
                    let in_remaining = ms
                        .iter()
                        .any(|m| m.member == p.entry && remaining.contains(&m.host))
                        || entries_map
                            .get(&p.entry)
                            .and_then(|e| e.parent.as_ref())
                            .is_some_and(|par| remaining.contains(par));
                    was_in_lane && !in_remaining
                })
                .map(|p| p.entry)
                .collect();
            let mut fields = vec![Field::Lane { lane: lane.to_string() }];
            fields.extend(prune.iter().map(|entry| Field::Placement { entry: entry.to_string() }));
            for field in &fields { v.timeline_field_restore_state(&id, &field.key()?)?; }

            let was_effective_here = m::effective_timeline_lanes(&tv.lanes, &entries_map, &templates_map)
                .iter()
                .any(|l| l.entry == lane);
            let in_other_live_view = v
                .timeline_views_raw()
                .into_iter()
                .any(|other| {
                    other.id != id
                        && !other.is_trashed()
                        && m::effective_timeline_lanes(&other.lanes, &entries_map, &templates_map)
                            .iter()
                            .any(|l| l.entry == lane)
                });
            let wb = if was_effective_here && !in_other_live_view {
                let snapshot = v.structure_snapshot();
                super::plan_lane_exit_writeback(&v, &snapshot, &tv, &lane)?
            } else {
                super::LaneExitWriteback::default()
            };
            for (member_id, _) in &wb.member_pos {
                v.membership_pos_restore_state(&lane, member_id)?;
            }

            {
                let w = tx.timeline_view(&id)?;
                w.remove_lane(&lane)?;
                for entry in prune { w.remove_placement(&entry)?; }
            }
            for (member_id, pos) in &wb.member_pos {
                tx.restore_membership_pos(
                    &lane,
                    member_id,
                    Some(&loro::LoroValue::from(pos.as_str())),
                )?;
            }
            if let Some(children) = &wb.child_order {
                tx.entries().reorder_children(Some(&lane), children)?;
            }
            let extra = UndoExtra {
                membership_pos: wb
                    .member_pos
                    .into_iter()
                    .map(|(m, _)| (lane.to_string(), m.to_string()))
                    .collect(),
                child_order: wb.child_order.map(|_| lane.to_string()),
            };
            Ok((
                fields,
                extra,
                frontiers_hex(&tx.view().state_frontiers()),
            ))
        })?;
        finish(cx, &slot, input.view, fields, extra, before, expected)
    }
}
op! {
    RestoreFields = "timeline_view.restore_fields", Write, Book,
    "Restore selected stored timeline fields for undo or redo without replacing the rest of a view.",
    fn(cx, input: RestoreFieldsIn) -> Done {
        let slot = cx.book_v3(&input.book)?;
        let id: TimelineViewId = pid("timeline view", &input.view)?;
        if !input.at.bytes().all(|b| b.is_ascii_hexdigit()) || !input.expected.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(WsError::invalid("frontiers: not hex"));
        }
        let at = frontiers_from_hex(&input.at)?;
        let expected = frontiers_from_hex(&input.expected)?;
        let keys: Vec<_> = input.fields.iter().map(Field::key).collect::<Result<_>>()?;
        let unique: BTreeSet<_> = keys.iter().cloned().collect();
        if unique.len() != keys.len()
            || unique.iter().any(|k| {
                matches!(
                    k,
                    TimelineFieldV3::Lane(id)
                        if unique.contains(&TimelineFieldV3::LanePosition(id.clone()))
                            || unique.contains(&TimelineFieldV3::LaneActTrack(id.clone()))
                )
            })
        {
            return Err(WsError::invalid("duplicate or overlapping timeline fields"));
        }
        let copy = cx.workspace().library().load_copy_at(&format!("book:{}", slot.book), &at)?;
        let old = dr_doc::v3::BorrowedBookV3::new(&copy, &slot.book)?;
        let old = old.view();
        let expected_copy = cx.workspace().library().load_copy_at(&format!("book:{}", slot.book), &expected)?;
        let expected = dr_doc::v3::BorrowedBookV3::new(&expected_copy, &slot.book)?;
        let expected = expected.view();
        let mut pairs = Vec::new();
        for (field, key) in input.fields.into_iter().zip(keys) {
            old.timeline_field_restore_state(&id, &key)?;
            let value = old.timeline_field_snapshot(&id, &key)?;
            let want = expected.timeline_field_restore_state(&id, &key)?;
            pairs.push((field, key, value, want));
        }
        let mut mpos_pairs = Vec::new();
        for (host_s, member_s) in &input.membership_pos {
            let host_id: EntryId = pid("host", host_s)?;
            let member_id: EntryId = pid("member", member_s)?;
            let old_pos = old.membership_pos_restore_state(&host_id, &member_id)?;
            let exp_pos = expected.membership_pos_restore_state(&host_id, &member_id)?;
            mpos_pairs.push((host_id, member_id, old_pos, exp_pos));
        }
        let child_order_pair = if let Some(parent_s) = &input.child_order {
            let parent_id: EntryId = pid("entry", parent_s)?;
            let old_children = old.direct_child_ids(Some(&parent_id));
            let exp_children = expected.direct_child_ids(Some(&parent_id));
            Some((parent_id, old_children, exp_children))
        } else {
            None
        };
        let mpos_receipt = input.membership_pos;
        let corder_receipt = input.child_order;
        // An inverse compares every selected field itself, below.
        let ((fields, expected), before) = cx.write_book_v3(&slot, Replaces::nothing(), move |tx| {
            let v = tx.view();
            for (_, key, _, expected) in &pairs {
                if v.timeline_field_restore_state(&id, key)? != *expected {
                    return Err(WsError::Conflict("selected timeline fields changed after the recorded write".into()));
                }
            }
            for (host_id, member_id, _, exp_pos) in &mpos_pairs {
                if v.membership_pos_restore_state(host_id, member_id)? != *exp_pos {
                    return Err(WsError::Conflict("selected membership order changed after the recorded write".into()));
                }
            }
            if let Some((parent_id, _, exp_children)) = &child_order_pair
                && v.direct_child_ids(Some(parent_id)) != *exp_children
            {
                return Err(WsError::Conflict("selected folder child order changed after the recorded write".into()));
            }
            // All historical/current paths and retained state pass before
            // any write. Independent fields remain outside this inverse.
            {
                let w = tx.timeline_view(&id)?;
                for (_, key, value, _) in &pairs { w.restore_field(key, value.as_ref())?; }
            }
            for (host_id, member_id, old_pos, _) in &mpos_pairs {
                if old_pos.0 {
                    tx.restore_membership_pos(host_id, member_id, old_pos.1.as_ref())?;
                }
            }
            if let Some((parent_id, old_children, _)) = &child_order_pair {
                tx.entries().reorder_children(Some(parent_id), old_children)?;
            }
            Ok((pairs.into_iter().map(|(field, _, _, _)| field).collect(), frontiers_hex(&tx.view().state_frontiers())))
        })?;
        finish(
            cx,
            &slot,
            input.view,
            fields,
            UndoExtra {
                membership_pos: mpos_receipt,
                child_order: corder_receipt,
            },
            before,
            expected,
        )
    }
}
