//! Undo/redo of a membership cancellation: just its original record, primary
//! field (if cleared), and positions actually removed. Never whole entries/views.
//! A re-hang or a drag order (T9) names the further records it changed.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RestoreIn {
    pub book: String,
    pub host: String,
    pub member: String,
    pub at: String,
    /// Post-write history point whose selected values must still be present.
    /// Independent fields may change; selected fields may not be taken over.
    pub expected: String,
    /// Restore this membership's stored record only when cancellation changed it.
    pub membership: bool,
    /// Restore only the member's primary field, not its other metadata or home.
    pub primary: bool,
    /// In each named view restore only this member's placement record.
    pub views: Vec<String>,
    /// Further `(host, member)` membership records the same write changed
    /// (a re-hang adds the new one; an order that renumbers a host's list
    /// writes its other members): each record alone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memberships: Vec<(String, String)>,
    /// Further `(view, entry)` placements the same write changed (an order
    /// beside a tie on the scale moves what is tied after it): each alone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub placements: Vec<(String, String)>,
}

op! {
    MembershipRestore="membership.restore",Write,Book,
    "Restore the selected effects of a membership cancellation without replacing entries or timeline views.",
    fn(cx,input:RestoreIn)->Done {
        let slot = cx.book_v3(&input.book)?;
        let host: EntryId = pid("host", &input.host)?;
        let member: EntryId = pid("member", &input.member)?;
        let key = m::Membership::key(&host, &member);
        if !input.at.bytes().all(|b| b.is_ascii_hexdigit()) || !input.expected.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(WsError::invalid("frontiers: not hex"));
        }
        let at = frontiers_from_hex(&input.at)?;
        let expected = frontiers_from_hex(&input.expected)?;
        let views: Vec<TimelineViewId> = input.views.iter().map(|v| pid("timeline view", v)).collect::<Result<_>>()?;
        if views.iter().collect::<BTreeSet<_>>().len() != views.len() {
            return Err(WsError::invalid("duplicate timeline view"));
        }
        // Every selected membership record and placement, the member's own
        // first.
        let mut pairs: Vec<(EntryId, EntryId)> = Vec::new();
        if input.membership {
            pairs.push((host.clone(), member.clone()));
        }
        for (h, e) in &input.memberships {
            pairs.push((pid("host", h)?, pid("member", e)?));
        }
        if pairs.iter().collect::<BTreeSet<_>>().len() != pairs.len() {
            return Err(WsError::invalid("duplicate membership"));
        }
        let mut spots: Vec<(TimelineViewId, EntryId)> =
            views.iter().map(|v| (v.clone(), member.clone())).collect();
        for (v, e) in &input.placements {
            spots.push((pid("timeline view", v)?, pid("entry", e)?));
        }
        if spots.iter().collect::<BTreeSet<_>>().len() != spots.len() {
            return Err(WsError::invalid("duplicate placement"));
        }
        if pairs.is_empty() && !input.primary && spots.is_empty() {
            cx.undo_nothing();
            return Ok(Done {id:key});
        }
        let copy = cx.workspace().library().load_copy_at(&format!("book:{}",slot.book), &at)?;
        let old = dr_doc::v3::BorrowedBookV3::new(&copy, &slot.book)?;
        let old = old.view();
        let expected_copy = cx.workspace().library().load_copy_at(&format!("book:{}",slot.book), &expected)?;
        let expected = dr_doc::v3::BorrowedBookV3::new(&expected_copy, &slot.book)?;
        let expected = expected.view();
        // Validate actual historical container kinds too: deep JSON equality
        // cannot prove a text's formatting or a movable list's identity.
        for view in [&old, &expected] {
            for (h, e) in &pairs { view.check_membership_snapshot_restore(h, e)?; }
            if input.primary { view.check_primary_restore(&member)?; }
            for (v, e) in &spots { view.check_timeline_placement_restore(v, e)?; }
        }
        let expected_memberships = pairs.iter().map(|(h, e)| expected.membership_restore_state(h, e)).collect::<std::result::Result<Vec<_>,_>>()?;
        let expected_primary = input.primary.then(|| expected.entry_snapshot(&member).and_then(|e| e.field("primary").cloned()));
        let expected_placements = spots.iter().map(|(v, e)| expected.timeline_placement_restore_state(v, e)).collect::<std::result::Result<Vec<_>,_>>()?;
        let old_memberships: Vec<_> = pairs.iter().map(|(h, e)| old.map_snapshot(CollectionV3::Memberships, &m::Membership::key(h, e))).collect();
        let old_primary = if input.primary {
            Some(old.entry_snapshot(&member).ok_or_else(|| WsError::not_found("historical entry",member.as_str()))?
                .field("primary").cloned())
        } else { None };
        let placements = spots.iter().map(|(v, e)| old.timeline_placement_snapshot(v, e)).collect::<std::result::Result<Vec<_>,_>>()?;
        let restored_memberships: Vec<_> = old.memberships_raw().into_iter()
            .filter(|m| pairs.iter().any(|(h, e)| &m.host == h && &m.member == e)).collect();
        let inverse = input.clone();
        // An inverse compares every selected value itself, below.
        let (after, before) = cx.write_book_v3(&slot, Replaces::nothing(), move |tx| {
            let v = tx.view();
            // Preflight every selected path and the final graph before the
            // first mutation, including a concurrently hidden/trash view.
            if old_primary.is_some() && v.entry_snapshot(&member).is_none() {
                return Err(WsError::not_found("entry",member.as_str()));
            }
            for (h, e) in &pairs { v.check_membership_snapshot_restore(h, e)?; }
            if old_primary.is_some() { v.check_primary_restore(&member)?; }
            for (view, e) in &spots { v.check_timeline_placement_restore(view, e)?; }
            let current_memberships = pairs.iter().map(|(h, e)| v.membership_restore_state(h, e)).collect::<std::result::Result<Vec<_>, _>>()?;
            let current_placements = spots.iter().map(|(view, e)| v.timeline_placement_restore_state(view, e)).collect::<std::result::Result<Vec<_>, _>>()?;
            if current_memberships != expected_memberships
                || expected_primary.as_ref().is_some_and(|want| v.entry_snapshot(&member).and_then(|e| e.field("primary").cloned()) != *want)
                || current_placements != expected_placements {
                return Err(WsError::Conflict("membership cancellation fields changed after the recorded write".into()));
            }
            if !pairs.is_empty() {
                let before = v.graph();
                let mut memberships = before.memberships.clone();
                memberships.retain(|m| !pairs.iter().any(|(h, e)| &m.host == h && &m.member == e));
                memberships.extend(restored_memberships);
                changes_ok(&before, &BookGraphV3 { memberships, ..before.clone() })?;
            }
            for ((h, e), old) in pairs.iter().zip(&old_memberships) {
                tx.restore_membership_snapshot(h, e, old.as_ref())?;
            }
            if let Some(primary) = &old_primary {
                tx.entries().entry(&member)?.restore_primary(primary.as_ref())?;
            }
            for ((view, e), value) in spots.iter().zip(&placements) {
                tx.timeline_view(view)?.restore_placement(e, value.as_ref())?;
            }
            Ok(frontiers_hex(&tx.view().state_frontiers()))
        })?;
        cx.undo_with(Invocation::new("membership.restore", RestoreIn {at:frontiers_hex(&before), expected:after, ..inverse}));
        cx.effect(EffectAction::Restored,"membership",&key,None);
        Ok(Done {id:key})
    }
}
