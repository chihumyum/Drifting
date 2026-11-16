use super::*;
mod restore;
pub use restore::{MembershipRestore, RestoreIn};
pub(crate) fn register(r: &mut Registry) {
    r.add::<MembershipList>()
        .add::<MembershipAdd>()
        .add::<MembershipRemove>()
        .add::<MembershipPrimary>()
        .add::<MembershipRestore>();
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct In {
    pub book: String,
    pub host: String,
    pub member: String,
}
op! {
    MembershipList="membership.list",Read,Shared,"List valid memberships in a book.",fn(cx,input:BookIn)->Vec<types::Membership> {
        let s = cx.book_v3(&input.book)?;
        convert(s.reader_v3.view().memberships())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AddIn {
    #[serde(flatten)]
    pub target: In,
    #[serde(default)]
    pub pos: Option<String>,
    /// Move an existing membership from this host in the same commit.
    #[serde(default)]
    #[schemars(skip)]
    pub from_host: Option<String>,
    /// Reorder this existing membership beside another one on the same host.
    #[serde(default)]
    #[schemars(skip)]
    pub order: Option<MembershipOrder>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MembershipOrder {
    pub anchor: String,
    #[serde(default)]
    pub after: bool,
}
op! {
    MembershipAdd="membership.add",Write,Book,"Add or order a membership without moving its residence.",fn(cx,input:AddIn)->Done {
        add(cx, input)
    }
}
pub(super) fn live_views_with_lane(v: &BookViewV3<'_>, host: &EntryId) -> Vec<m::TimelineView> {
    let entries = v.entries_map();
    let templates = v.templates_map();
    v.timeline_views_raw()
        .into_iter()
        .filter(|tv| {
            !tv.is_trashed()
                && m::effective_timeline_lanes(&tv.lanes, &entries, &templates)
                    .iter()
                    .any(|l| &l.entry == host)
        })
        .collect()
}

/// Gives every entry hung on `lane` (while it takes entries from elsewhere)
/// a position at the end of the scale of each live view `lane` is in, where
/// it has none yet (`VIEW-LANE-MEMBERS-PLACED`), in the memberships' manual
/// order. What only lives under `lane` is not on it (DV, 2026-11-16). Reads
/// the document as it is inside the write `t`. Returns the views written.
pub(super) fn place_unplaced_lane_entries(
    t: &mut dr_doc::v3::BookTxnV3<'_>,
    lane: &EntryId,
) -> Result<Vec<TimelineViewId>> {
    let v = t.view();
    let graph = v.graph();
    let Some(entry) = graph
        .entries
        .get(lane)
        .filter(|_| m::is_entry_live(lane, &graph.entries))
    else {
        return Ok(Vec::new());
    };
    let mut items: Vec<EntryId> = Vec::new();
    if entry.accepts_members(&graph.templates) {
        let mut members: Vec<m::Membership> = graph
            .memberships
            .iter()
            .filter(|ms| &ms.host == lane && m::is_entry_live(&ms.member, &graph.entries))
            .cloned()
            .collect();
        m::sort_memberships_by_member(&mut members);
        items.extend(members.into_iter().map(|ms| ms.member));
    }
    let mut seen = BTreeSet::new();
    items.retain(|id| seen.insert(id.clone()));
    let mut written = Vec::new();
    for tv in live_views_with_lane(&v, lane) {
        let mut at = m::timeline_scale_end(&m::effective_timeline_placements(
            &tv,
            &graph.memberships,
            &graph.entries,
            &graph.templates,
        ));
        let mut wrote = false;
        for item in &items {
            if v.timeline_placement_snapshot(&tv.id, item)?.is_none() {
                t.timeline_view(&tv.id)?.put_placement(item, at, None)?;
                at += 1.0;
                wrote = true;
            }
        }
        if wrote {
            written.push(tv.id);
        }
    }
    Ok(written)
}

fn add(cx: &Cx<'_>, input: AddIn) -> Result<Done> {
    let s = cx.book_v3(&input.target.book)?;
    let v = s.reader_v3.view();
    let host = live(&v, &input.target.host)?.id;
    let member = live(&v, &input.target.member)?.id;
    let before = v.graph();
    m::check_membership(&host, &member, &before.entries, &before.templates)?;
    if (input.order.is_some() || input.from_host.is_some())
        && !matches!(cx.actor(), crate::Actor::User)
    {
        return Err(WsError::invalid(
            "drag order and transfer are workspace UI operations",
        ));
    }
    if let Some(order) = input.order {
        if input.pos.is_some() || input.from_host.is_some() {
            return Err(WsError::invalid(
                "ordering beside a membership cannot set a position or transfer it",
            ));
        }
        return reorder(cx, &s, &v, &host, &member, order);
    }
    if let Some(from) = input.from_host.as_deref() {
        return transfer(cx, &s, &v, &before, from, &host, &member);
    }
    let k = m::Membership::key(&host, &member);
    if !live_views_with_lane(&v, &host).is_empty() {
        // When `host` is in at least one live view, `pos` is neither read nor
        // written, and `member` is placed at scale end in every live view
        // containing `host` where it has no stored placement yet
        // (`VIEW-LANE-MEMBERS-PLACED`, `kernel-v5.md` §4).
        let book_id = input.target.book;
        let (receipt, at) = cx.write_book_v3(&s, Replaces::nothing(), move |t| {
            let v = t.view();
            let host = live(&v, &input.target.host)?.id;
            let member = live(&v, &input.target.member)?.id;
            let before = v.graph();
            m::check_membership(&host, &member, &before.entries, &before.templates)?;
            let key = m::Membership::key(&host, &member);
            let had_membership = v.map_snapshot(CollectionV3::Memberships, &key).is_some();
            let mut auto_views = Vec::new();
            for tv in live_views_with_lane(&v, &host) {
                if v.timeline_placement_snapshot(&tv.id, &member)?.is_none() {
                    let end = m::timeline_scale_end(&m::effective_timeline_placements(
                        &tv,
                        &before.memberships,
                        &before.entries,
                        &before.templates,
                    ));
                    auto_views.push((tv.id, end));
                }
            }
            if had_membership && auto_views.is_empty() {
                return Ok(None);
            }
            if !had_membership {
                v.check_membership_snapshot_restore(&host, &member)?;
                let mut ms = before.memberships.clone();
                ms.retain(|m| m.host != host || m.member != member);
                ms.push(m::Membership {
                    host: host.clone(),
                    member: member.clone(),
                    pos: None,
                    created_at: Some(now()),
                });
                changes_ok(
                    &before,
                    &BookGraphV3 {
                        memberships: ms,
                        ..before.clone()
                    },
                )?;
            }
            for (vid, _) in &auto_views {
                v.check_timeline_placement_restore(vid, &member)?;
            }
            if !had_membership {
                t.put_membership(&host, &member, None, Some(now()))?;
            }
            for (vid, end) in &auto_views {
                t.timeline_view(vid)?.put_placement(&member, *end, None)?;
            }
            Ok(Some(RestoreIn {
                book: book_id,
                host: host.to_string(),
                member: member.to_string(),
                at: String::new(),
                expected: frontiers_hex(&t.view().state_frontiers()),
                membership: !had_membership,
                primary: false,
                views: auto_views
                    .into_iter()
                    .map(|(vid, _)| vid.to_string())
                    .collect(),
            }))
        })?;
        if let Some(mut receipt) = receipt {
            receipt.at = frontiers_hex(&at);
            cx.undo_with(Invocation::new("membership.restore", receipt));
            cx.effect(EffectAction::Updated, "membership", &k, None);
        } else {
            cx.undo_nothing();
        }
        return Ok(Done { id: k });
    }
    let mut ms = before.memberships.clone();
    let existing = ms
        .iter()
        .find(|m| m.host == host && m.member == member)
        .cloned();
    if existing.is_some() && input.pos.is_none() {
        cx.undo_nothing();
        return Ok(Done { id: k });
    }
    let pos = input.pos.map(convert).transpose()?;
    // An existing membership has its order replaced; a new one replaces
    // nothing.
    let replaced = Replaces::records(existing.iter().map(|_| rec(CollectionV3::Memberships, &k)));
    let created = existing.and_then(|m| m.created_at).or_else(|| Some(now()));
    ms.retain(|m| m.host != host || m.member != member);
    ms.push(m::Membership {
        host: host.clone(),
        member: member.clone(),
        pos: pos.clone(),
        created_at: created,
    });
    let after = BookGraphV3 {
        memberships: ms,
        ..before.clone()
    };
    changes_ok(&before, &after)?;
    let (_, at) = cx.write_book_v3(&s, replaced, move |t| {
        t.put_membership(&host, &member, pos.as_ref(), created)?;
        Ok(())
    })?;
    undo(cx, &s, &at, vec![key("memberships", &k)]);
    cx.effect(EffectAction::Updated, "membership", &k, None);
    Ok(Done { id: k })
}
fn reorder(
    cx: &Cx<'_>,
    slot: &BookSlot,
    v: &BookViewV3<'_>,
    host: &EntryId,
    member: &EntryId,
    order: MembershipOrder,
) -> Result<Done> {
    use dr_model::pos::PosKey;

    let anchor: EntryId = pid("order.anchor", &order.anchor)?;
    let current = v.memberships_of_host(host);
    let member_key = m::Membership::key(host, member);
    if anchor == *member
        || !current.iter().any(|m| &m.member == member)
        || !current.iter().any(|m| m.member == anchor)
    {
        return Err(WsError::invalid(
            "two different existing memberships are needed to reorder",
        ));
    }
    if let Some(view) = live_views_with_lane(v, host).into_iter().next() {
        let mut positions: Vec<_> = current
            .iter()
            .filter_map(|entry| {
                let placement = view.placements.iter().find(|p| p.entry == entry.member)?;
                Some((entry.member.clone(), placement.at))
            })
            .collect();
        positions.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        let old = positions.iter().position(|(entry, _)| entry == member);
        positions.retain(|(entry, _)| entry != member);
        let at = positions
            .iter()
            .position(|(entry, _)| *entry == anchor)
            .ok_or_else(|| WsError::invalid("the anchor has no timeline placement"))?
            + usize::from(order.after);
        if old == Some(at) {
            cx.undo_nothing();
            return Ok(Done { id: member_key });
        }
        let left = at
            .checked_sub(1)
            .and_then(|i| positions.get(i))
            .map(|p| p.1);
        let right = positions.get(at).map(|p| p.1);
        let scale = match (left, right) {
            (Some(a), Some(b)) if a < b && a.midpoint(b) > a && a.midpoint(b) < b => a.midpoint(b),
            (Some(a), Some(_)) if order.after => a.next_up(),
            (Some(_), Some(b)) => b.next_down(),
            (Some(a), None) => (a + 1.0).max(a.next_up()),
            (None, Some(b)) => (b - 1.0).min(b.next_down()),
            (None, None) => unreachable!("there is an anchor"),
        };
        return <super::timeline::Place as crate::registry::Op>::run(
            cx,
            super::timeline::PlaceIn {
                book: slot.book.to_string(),
                view: view.id.to_string(),
                entry: member.to_string(),
                lane: None,
                from_host: None,
                at: scale,
                span: view
                    .placements
                    .iter()
                    .find(|p| &p.entry == member)
                    .and_then(|p| p.span),
            },
        );
    }

    let mut ordered = current;
    let from = ordered
        .iter()
        .position(|m| &m.member == member)
        .expect("checked");
    let moved = ordered.remove(from);
    let at = ordered
        .iter()
        .position(|m| m.member == anchor)
        .expect("checked")
        + usize::from(order.after);
    if from == at {
        cx.undo_nothing();
        return Ok(Done { id: member_key });
    }
    let left = at.checked_sub(1).map(|i| &ordered[i]);
    let right = ordered.get(at);
    let between = left
        .is_none_or(|m| m.pos.is_some())
        .then(|| {
            PosKey::between(
                left.and_then(|m| m.pos.as_ref()),
                right.and_then(|m| m.pos.as_ref()),
            )
            .ok()
        })
        .flatten();
    let edits = if let Some(pos) = between {
        vec![m::Membership {
            pos: Some(pos),
            ..moved
        }]
    } else {
        // Tied or missing keys leave no gap. Give the host's list explicit
        // positions while keeping the relative order of the other members.
        ordered.insert(at, moved);
        let mut pos = PosKey::first();
        ordered
            .into_iter()
            .filter_map(|mut membership| {
                let next = pos.clone();
                pos = pos.after();
                if membership.pos.as_ref() == Some(&next) {
                    return None;
                }
                membership.pos = Some(next);
                Some(membership)
            })
            .collect()
    };
    let affected: Vec<_> = edits
        .iter()
        .map(|m| m::Membership::key(&m.host, &m.member))
        .collect();
    let replaced = Replaces::records(affected.iter().map(|id| rec(CollectionV3::Memberships, id)));
    let (_, at) = cx.write_book_v3(slot, replaced, move |txn| {
        for m in edits {
            txn.put_membership(&m.host, &m.member, m.pos.as_ref(), m.created_at)?;
        }
        Ok(())
    })?;
    undo(
        cx,
        slot,
        &at,
        affected.iter().map(|id| key("memberships", id)).collect(),
    );
    cx.effect(EffectAction::Moved, "membership", &member_key, None);
    Ok(Done { id: member_key })
}

/// The part of a transfer that leaves its old host. The destination is
/// already validated by the command. Preserve a scale position in every
/// view where the resulting membership still has a lane.
pub(super) struct Transfer {
    from: EntryId,
    member: EntryId,
    views: Vec<TimelineViewId>,
    clear_primary: bool,
}

impl Transfer {
    pub fn plan(v: &BookViewV3<'_>, source: &str, to: &EntryId, member: &EntryId) -> Result<Self> {
        let from = live(v, source)?.id;
        if &from == to
            || !v
                .memberships()
                .iter()
                .any(|m| m.host == from && &m.member == member)
        {
            return Err(WsError::invalid(
                "the old membership is no longer available",
            ));
        }
        v.check_membership_snapshot_restore(&from, member)?;
        let target_views = live_views_with_lane(v, to);
        let mut views = removals(v, &from, member);
        views.retain(|id| !target_views.iter().any(|tv| &tv.id == id));
        for view in &views {
            v.check_timeline_placement_restore(view, member)?;
        }
        let clear_primary = v
            .entry(member)
            .is_some_and(|entry| entry.primary.as_ref() == Some(&from));
        if clear_primary {
            v.check_primary_restore(member)?;
        }
        Ok(Self {
            from,
            member: member.clone(),
            views,
            clear_primary,
        })
    }

    pub fn remove_from(&self, memberships: &mut Vec<m::Membership>) {
        memberships.retain(|m| m.host != self.from || m.member != self.member);
    }

    pub fn replaced(&self) -> Vec<dr_doc::v3::RecordKeyV3> {
        let mut records = vec![rec(
            CollectionV3::Memberships,
            m::Membership::key(&self.from, &self.member),
        )];
        records.extend(self.views.iter().map(|view| {
            rec(CollectionV3::TimelineViews, view).at(["placements", self.member.as_str()])
        }));
        if self.clear_primary {
            records.push(rec(CollectionV3::Entries, &self.member).at(["primary"]));
        }
        records
    }

    pub fn undo_keys(&self) -> Vec<history::Key> {
        let mut keys = vec![key(
            "memberships",
            m::Membership::key(&self.from, &self.member),
        )];
        keys.extend(self.views.iter().map(|view| key("timeline_views", view)));
        if self.clear_primary {
            keys.push(key("entries", &self.member));
        }
        keys
    }

    pub fn apply(self, t: &mut dr_doc::v3::BookTxnV3<'_>) -> Result<()> {
        t.remove_membership(&self.from, &self.member)?;
        if self.clear_primary {
            t.entries().entry(&self.member)?.primary(None)?;
        }
        for view in &self.views {
            t.timeline_view(view)?
                .restore_placement(&self.member, None)?;
        }
        Ok(())
    }
}

fn transfer(
    cx: &Cx<'_>,
    s: &BookSlot,
    v: &BookViewV3<'_>,
    before: &BookGraphV3,
    source: &str,
    host: &EntryId,
    member: &EntryId,
) -> Result<Done> {
    let transfer = Transfer::plan(v, source, host, member)?;
    let mut memberships = before.memberships.clone();
    transfer.remove_from(&mut memberships);
    let name = m::Membership::key(host, member);
    let join = !memberships
        .iter()
        .any(|m| &m.host == host && &m.member == member);
    if join {
        v.check_membership_snapshot_restore(host, member)?;
        memberships.push(m::Membership {
            host: host.clone(),
            member: member.clone(),
            pos: None,
            created_at: Some(now()),
        });
    }
    changes_ok(
        before,
        &BookGraphV3 {
            memberships,
            ..before.clone()
        },
    )?;
    let mut placed = Vec::new();
    for view in live_views_with_lane(v, host) {
        if v.timeline_placement_snapshot(&view.id, member)?.is_none() {
            v.check_timeline_placement_restore(&view.id, member)?;
            let at = m::timeline_scale_end(&m::effective_timeline_placements(
                &view,
                &before.memberships,
                &before.entries,
                &before.templates,
            ));
            placed.push((view.id, at));
        }
    }
    let mut keys = transfer.undo_keys();
    if join {
        keys.push(key("memberships", &name));
    }
    keys.extend(placed.iter().map(|(id, _)| key("timeline_views", id)));
    let replaced = Replaces::records(transfer.replaced());
    let host = host.clone();
    let member = member.clone();
    let (_, at) = cx.write_book_v3(s, replaced, move |t| {
        if join {
            t.put_membership(&host, &member, None, Some(now()))?;
        }
        for (view, at) in placed {
            t.timeline_view(&view)?.put_placement(&member, at, None)?;
        }
        transfer.apply(t)
    })?;
    undo(cx, s, &at, keys);
    cx.effect(EffectAction::Moved, "membership", &name, None);
    Ok(Done { id: name })
}

// Only remove a position this cancellation actually orphans. Read-side filters
// hide retained data; they must never become a global cleanup instruction.
pub(super) fn removals(
    v: &BookViewV3<'_>,
    host: &EntryId,
    member: &EntryId,
) -> Vec<TimelineViewId> {
    let ms = v.memberships_raw();
    if !ms.iter().any(|m| &m.host == host && &m.member == member) {
        return Vec::new();
    }
    let entries = v.entries_map();
    let templates = v.templates_map();
    // Living under a lane does not keep an entry on it (DV, 2026-11-16).
    v.timeline_views_raw()
        .into_iter()
        .filter(|tv| {
            !tv.is_trashed()
                && tv.lanes.iter().any(|l| &l.entry == host)
                && m::effective_timeline_placements(tv, &ms, &entries, &templates)
                    .iter()
                    .any(|p| &p.entry == member)
                && !ms.iter().any(|m| {
                    &m.member == member
                        && &m.host != host
                        && tv.lanes.iter().any(|l| l.entry == m.host)
                })
        })
        .map(|tv| tv.id)
        .collect()
}
op! {
    MembershipRemove="membership.remove",Write,Book,"Remove a membership and any timeline placements left without a lane.",fn(cx,input:In)->Done {
        let s = cx.book_v3(&input.book)?;
        let host: EntryId = pid("host", &input.host)?;
        let k = m::Membership::key(&host, &pid("member", &input.member)?);
        // The cancelled membership; what follows from it is planned below,
        // against the live document, in the same job.
        let removed = Replaces::record(CollectionV3::Memberships, &k);
        let (receipt, at) = cx.write_book_v3(&s, removed, move |t| {
            let v = t.view();
            let member = live(&v, &input.member)?;
            let views = removals(&v, &host, &member.id);
            // Inspect the actual root key before interpreting a filtered
            // snapshot as absent, including the primary-only/no-op cases.
            v.check_membership_snapshot_restore(&host, &member.id)?;
            let membership = v.map_snapshot(CollectionV3::Memberships, &m::Membership::key(&host, &member.id)).is_some();
            let primary = member.primary.as_ref() == Some(&host);
            if !membership && !primary { return Ok(None); }
            if primary { v.check_primary_restore(&member.id)?; }
            for view in &views { v.check_timeline_placement_restore(view, &member.id)?; }
            if membership { t.remove_membership(&host, &member.id)?; }
            if primary {
                t.entries().entry(&member.id)?.primary(None)?;
            }
            for view in &views {
                t.timeline_view(view)?.restore_placement(&member.id, None)?;
            }
            Ok(Some(RestoreIn {
                book: input.book, host: host.to_string(), member: member.id.to_string(),
                at: String::new(), expected: frontiers_hex(&t.view().state_frontiers()), membership, primary,
                views: views.into_iter().map(|v| v.to_string()).collect(),
            }))
        })?;
        if let Some(mut receipt) = receipt {
            receipt.at = frontiers_hex(&at);
            cx.undo_with(Invocation::new("membership.restore", receipt));
            cx.effect(EffectAction::Detached, "membership", &k, None);
        } else {
            cx.undo_nothing();
        }
        Ok(Done { id: k })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PrimaryIn {
    pub book: String,
    pub member: String,
    pub host: Option<String>,
}
op! {
    MembershipPrimary="membership.primary",Write,Book,"Choose an existing membership as primary, or clear the primary membership.",fn(cx,input:PrimaryIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let member = live(&v, &input.member)?.id;
        let host: Option<EntryId> = input.host.as_deref().map(|s| pid("host", s)).transpose()?;
        if let Some(h) = &host
            && !v
                .memberships()
                .iter()
                .any(|m| &m.host == h && m.member == member)
        {
            return Err(WsError::invalid(
                "primary must name an existing valid membership",
            ));
        }
        let id = member.clone();
        let primary = rec(CollectionV3::Entries, &id).at(["primary"]);
        let (_, at) = cx.write_book_v3(&s, Replaces::records([primary]), move |t| {
            t.entries().entry(&member)?.primary(host.as_ref())?;
            Ok(())
        })?;
        undo(cx, &s, &at, vec![key("entries", &id)]);
        cx.effect(EffectAction::Updated, "entry", id.as_str(), None);
        Ok(Done { id: input.member })
    }
}
