//! Undo/redo of a membership cancellation: just its original record, primary
//! field (if cleared), and positions actually removed. Never whole entries/views.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RestoreIn {
    pub book: String,
    pub host: String,
    pub member: String,
    pub at: String,
    /// Restore this membership's stored record only when cancellation changed it.
    pub membership: bool,
    /// Restore only the member's primary field, not its other metadata or home.
    pub primary: bool,
    /// In each named view restore only this member's placement record.
    pub views: Vec<String>,
}

op! {
    MembershipRestore="membership.restore",Write,Book,
    "Restore the selected effects of a v3 membership cancellation without replacing entries or timeline views.",
    fn(cx,input:RestoreIn)->Done {
        let slot = cx.book_v3(&input.book)?;
        let host: EntryId = pid("host", &input.host)?;
        let member: EntryId = pid("member", &input.member)?;
        let key = m::Membership::key(&host, &member);
        if !input.at.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(WsError::invalid("frontiers: not hex"));
        }
        let at = frontiers_from_hex(&input.at)?;
        let views: Vec<TimelineViewId> = input.views.iter().map(|v| pid("timeline view", v)).collect::<Result<_>>()?;
        if views.iter().collect::<BTreeSet<_>>().len() != views.len() {
            return Err(WsError::invalid("duplicate timeline view"));
        }
        if !input.membership && !input.primary && views.is_empty() {
            cx.undo_nothing();
            return Ok(Done {id:key});
        }
        let copy = cx.workspace().library().load_copy_at(&format!("book:{}",slot.book), &at)?;
        let old = dr_doc::v3::BorrowedBookV3::new(&copy, &slot.book)?;
        let old = old.view();
        let old_membership = input.membership.then(|| old.map_snapshot(CollectionV3::Memberships, &key));
        let old_primary = if input.primary {
            Some(old.entry_snapshot(&member).ok_or_else(|| WsError::not_found("historical entry",member.as_str()))?
                .field("primary").cloned())
        } else { None };
        let placements = views.iter().map(|v| old.timeline_placement_snapshot(v,&member)).collect::<std::result::Result<Vec<_>,_>>()?;
        let restored_memberships: Vec<_> = old.memberships_raw().into_iter()
            .filter(|m| m.host == host && m.member == member).collect();
        let inverse = input.clone();
        let (_, before) = cx.write_book_v3(&slot, move |tx| {
            let v = tx.view();
            // Preflight every selected path and the final graph before the
            // first mutation, including a concurrently hidden/trash view.
            if old_primary.is_some() && v.entry_snapshot(&member).is_none() {
                return Err(WsError::not_found("entry",member.as_str()));
            }
            for view in &views { v.check_timeline_placement_write(view)?; }
            if old_membership.is_some() {
                let mut memberships = v.memberships_raw();
                memberships.retain(|m| m.host != host || m.member != member);
                memberships.extend(restored_memberships);
                graph_ok(&v.entries_map(), &v.templates_map(), &memberships)?;
            }
            if let Some(old) = &old_membership {
                tx.restore_membership_snapshot(&host, &member, old.as_ref())?;
            }
            if let Some(primary) = &old_primary {
                tx.entries().entry(&member)?.restore_primary(primary.as_ref())?;
            }
            for (view, value) in views.iter().zip(&placements) {
                tx.timeline_view(view)?.restore_placement(&member, value.as_ref())?;
            }
            Ok(())
        })?;
        cx.undo_with(Invocation::new("membership.restore", RestoreIn {at:frontiers_hex(&before),..inverse}));
        cx.effect(EffectAction::Restored,"membership",&key,None);
        Ok(Done {id:key})
    }
}
