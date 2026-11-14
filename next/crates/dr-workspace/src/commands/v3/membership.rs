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

/// Gives every entry of `lane` (living under it when its level is on,
/// attached to it when it takes entries from elsewhere) a position at the
/// end of the scale of each live view `lane` is in, where it has none yet
/// (`VIEW-LANE-MEMBERS-PLACED`), in the lane's own manual order. Reads the
/// document as it is inside the write `t`. Returns the views written.
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
    if entry.is_level() {
        items.extend(
            v.entries_raw()
                .into_iter()
                .filter(|c| c.parent.as_ref() == Some(lane) && !c.is_trashed())
                .map(|c| c.id),
        );
    }
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
    let member_parent = entries.get(member).and_then(|e| e.parent.clone());
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
                && !member_parent
                    .as_ref()
                    .is_some_and(|par| tv.lanes.iter().any(|l| &l.entry == par))
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
