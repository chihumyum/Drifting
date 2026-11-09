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
    MembershipList="membership.list",Read,Shared,"List valid v3 memberships in a book.",fn(cx,input:BookIn)->Vec<types::Membership> {
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
    MembershipAdd="membership.add",Write,Book,"Add or order a v3 membership without moving its residence.",fn(cx,input:AddIn)->Done {
        add(cx, input)
    }
}
fn add(cx: &Cx<'_>, input: AddIn) -> Result<Done> {
    let s = cx.book_v3(&input.target.book)?;
    let v = s.reader_v3.view();
    let host = live(&v, &input.target.host)?.id;
    let member = live(&v, &input.target.member)?.id;
    let entries = v.entries_map();
    let templates = v.templates_map();
    m::check_membership(&host, &member, &entries, &templates)?;
    let mut ms = v.memberships_raw();
    let existing = ms
        .iter()
        .find(|m| m.host == host && m.member == member)
        .cloned();
    let k = m::Membership::key(&host, &member);
    if existing.is_some() && input.pos.is_none() {
        cx.undo_nothing();
        return Ok(Done { id: k });
    }
    let pos = input.pos.map(convert).transpose()?;
    let created = existing.and_then(|m| m.created_at).or_else(|| Some(now()));
    ms.retain(|m| m.host != host || m.member != member);
    ms.push(m::Membership {
        host: host.clone(),
        member: member.clone(),
        pos: pos.clone(),
        created_at: created,
    });
    graph_ok(&entries, &templates, &ms)?;
    let (_, at) = cx.write_book_v3(&s, move |t| {
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
    MembershipRemove="membership.remove",Write,Book,"Remove a v3 membership and any timeline placements left without a lane.",fn(cx,input:In)->Done {
        let s = cx.book_v3(&input.book)?;
        let host: EntryId = pid("host", &input.host)?;
        let k = m::Membership::key(&host, &pid("member", &input.member)?);
        let (receipt, at) = cx.write_book_v3(&s, move |t| {
            let v = t.view();
            let member = live(&v, &input.member)?;
            let views = removals(&v, &host, &member.id);
            let membership = v.map_snapshot(CollectionV3::Memberships, &m::Membership::key(&host, &member.id)).is_some();
            let primary = member.primary.as_ref() == Some(&host);
            if !membership && !primary { return Ok(None); }
            for view in &views { v.check_timeline_placement_write(view)?; }
            t.remove_membership(&host, &member.id)?;
            if primary {
                t.entries().entry(&member.id)?.primary(None)?;
            }
            for view in &views {
                t.timeline_view(view)?.restore_placement(&member.id, None)?;
            }
            Ok(Some(RestoreIn {
                book: input.book, host: host.to_string(), member: member.id.to_string(),
                at: String::new(), membership, primary,
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
    MembershipPrimary="membership.primary",Write,Book,"Choose an existing v3 membership as primary, or clear the primary membership.",fn(cx,input:PrimaryIn)->Done {
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
        let (_, at) = cx.write_book_v3(&s, move |t| {
            t.entries().entry(&member)?.primary(host.as_ref())?;
            Ok(())
        })?;
        undo(cx, &s, &at, vec![key("entries", &id)]);
        cx.effect(EffectAction::Updated, "entry", id.as_str(), None);
        Ok(Done { id: input.member })
    }
}
