use super::*;
pub(crate) fn register(r: &mut Registry) {
    r.add::<MembershipList>()
        .add::<MembershipAdd>()
        .add::<MembershipRemove>()
        .add::<MembershipPrimary>();
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
// Removing a membership also removes placements from every view that no longer
// has a lane for that member. One lane may be shared by several independent views.
pub(super) fn removals(
    v: &BookViewV3<'_>,
    host: &EntryId,
    member: &EntryId,
) -> Vec<TimelineViewId> {
    let ms = v
        .memberships()
        .into_iter()
        .filter(|m| &m.host != host || &m.member != member)
        .collect::<Vec<_>>();
    let entries = v.entries_map();
    let templates = v.templates_map();
    v.timeline_views_raw()
        .into_iter()
        .filter(|tv| {
            tv.placements.iter().any(|p| &p.entry == member)
                && m::check_timeline_placement_in_lane(tv, member, &ms, &entries, &templates)
                    .is_err()
        })
        .map(|tv| tv.id)
        .collect()
}
op! {
    MembershipRemove="membership.remove",Write,Book,"Remove a v3 membership and any timeline placements left without a lane.",fn(cx,input:In)->Done {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let host: EntryId = pid("host", &input.host)?;
        let member = live(&v, &input.member)?;
        let views = removals(&v, &host, &member.id);
        let k = m::Membership::key(&host, &member.id);
        let mut keys = vec![key("memberships", &k)];
        if member.primary.as_ref() == Some(&host) { keys.push(key("entries", &member.id)); }
        keys.extend(views.iter().map(|v| key("timeline_views", v)));
        let (_, at) = cx.write_book_v3(&s, move |t| {
            t.remove_membership(&host, &member.id)?;
            if member.primary.as_ref() == Some(&host) {
                t.entries().entry(&member.id)?.primary(None)?;
            }
            for view in views {
                t.timeline_view(&view)?.remove_placement(&member.id)?;
            }
            Ok(())
        })?;
        undo(cx, &s, &at, keys);
        cx.effect(EffectAction::Detached, "membership", &k, None);
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
