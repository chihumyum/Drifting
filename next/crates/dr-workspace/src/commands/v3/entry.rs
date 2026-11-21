pub use super::novel_book::ProjectCreate;
use super::*;

pub(crate) fn register(r: &mut Registry) {
    r.add::<ProjectCreate>()
        .add::<EntryList>()
        .add::<EntryGet>()
        .add::<EntryCreate>()
        .add::<EntryUpdate>()
        .add::<EntryMove>()
        .add::<EntryTrash>()
        .add::<EntryRestore>()
        .add::<EntrySetLevel>();
}

/// A new, empty entry: no fields or rows yet.
pub(super) fn new_entry(
    id: EntryId,
    parent: Option<EntryId>,
    title: String,
    template: Option<EntryTemplateId>,
    level: bool,
) -> m::Entry {
    m::Entry {
        id,
        parent,
        pos: String::new(),
        title,
        mark: None,
        template,
        level,
        overrides: None,
        fields: BTreeMap::new(),
        kv: BTreeMap::new(),
        media: BTreeMap::new(),
        arrangements: BTreeMap::new(),
        primary: None,
        created_at: Some(now()),
        updated_at: None,
        deleted_at: None,
        name_conflict: None,
    }
}

/// What readers need to show a file that is gone as a placeholder: the live
/// files of the book, and every template's image fields.
pub(super) struct Files {
    pub(super) live: BTreeSet<String>,
    images: BTreeMap<String, BTreeSet<(String, String)>>,
}

impl Files {
    pub(super) fn of(v: &BookViewV3<'_>) -> Self {
        Self {
            live: v.assets().into_iter().map(|a| a.id.to_string()).collect(),
            images: crate::commands::asset::image_fields(&v.templates_map()),
        }
    }

    /// Image fields of `module` on an entry of `template` whose file is gone.
    pub(super) fn missing_fields(
        &self,
        template: Option<&str>,
        module: &str,
        values: &BTreeMap<String, types::FieldValue>,
    ) -> Vec<String> {
        let Some(images) = template.and_then(|t| self.images.get(t)) else {
            return Vec::new();
        };
        values
            .iter()
            .filter(|(field, value)| {
                images.contains(&(module.to_owned(), (*field).clone()))
                    && matches!(value, types::FieldValue::Text(s) if !self.live.contains(s))
            })
            .map(|(field, _)| field.clone())
            .collect()
    }
}

pub(super) fn mark_missing_media(entry: &mut types::Entry, files: &Files) {
    for items in entry.media.values_mut() {
        for item in items {
            item.missing = !files.live.contains(&item.asset);
        }
    }
    entry.missing_files = entry
        .fields
        .iter()
        .map(|(module, values)| {
            (
                module.clone(),
                files.missing_fields(entry.template.as_deref(), module, values),
            )
        })
        .filter(|(_, fields)| !fields.is_empty())
        .collect();
    if let Some(b) = &mut entry.below {
        for child in b.children.iter_mut().flatten() {
            mark_missing_media(child, files);
        }
        for member in b.members.iter_mut().flatten() {
            mark_missing_media(member, files);
        }
    }
}

/// What lies below `id` in `v`, if it is a live entry with `level` or `accept` on
/// (`kernel-v5.md` §16: `children` only when `level` is on, `members` only when
/// `accept` is on, and an entry both residing in and attached to `id` is listed
/// once under `children`).
pub(super) fn below(v: &dr_doc::v3::BookStructureV3, id: &EntryId) -> Option<Box<types::Below>> {
    let entry = v.entry(id)?;
    let settings = v.level_settings(id)?;
    let children: Option<Vec<types::Entry>> = entry.is_level().then(|| {
        v.children_of(Some(id))
            .into_iter()
            .map(Into::into)
            .collect()
    });
    let child_ids: BTreeSet<&str> = children.iter().flatten().map(|c| c.id.as_str()).collect();
    let members: Option<Vec<types::Entry>> = entry.accepts_members(v.templates_map()).then(|| {
        v.members_of(id)
            .into_iter()
            .filter(|m| !child_ids.contains(m.id.as_str()))
            .map(Into::into)
            .collect()
    });
    Some(Box::new(types::Below {
        settings: (&settings.settings).into(),
        sources: settings
            .sources
            .iter()
            .map(|(k, s)| (k.clone(), s.into()))
            .collect(),
        children,
        members,
    }))
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ListIn {
    pub book: String,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub trashed: bool,
    #[serde(default)]
    pub query: Option<String>,
    /// Give every listed entry whose switch is on what lies below it
    /// (resolved settings and their sources, children, members), all from
    /// one consistent read of the book.
    #[serde(default)]
    pub below: bool,
}
op! {
    EntryList = "entry.list", Read, Shared, "Find entries, or list the entries living under one in manuscript order; with below, each listed entry whose switch is on carries its resolved settings, children and members.",
    fn(cx, input: ListIn) -> Vec<types::Entry> {
        let slot = cx.book_v3(&input.book)?;
        let view = slot.reader_v3.view();
        let files = Files::of(&view);
        let v = view.structure_snapshot();
        let p: Option<EntryId> = input
            .parent
            .as_deref()
            .map(|s| pid("parent", s))
            .transpose()?;
        let q = input.query.as_deref().unwrap_or("").to_lowercase();
        Ok(
            v.entries()
                .filter(|e| {
                    (input.all || v.effective_parent(&e.id) == p.as_ref())
                        && (input.trashed || !e.is_trashed())
                        && e.title.to_lowercase().contains(&q)
                })
                .map(|e| {
                    let mut out: types::Entry = e.into();
                    if input.below {
                        out.below = below(&v, &e.id);
                    }
                    mark_missing_media(&mut out, &files);
                    out
                })
                .collect(),
        )
    }
}
op! {
    EntryGet = "entry.get", Read, Shared, "Read an entry including retained module values; an entry whose switch is on also carries what lies below it (resolved settings and their sources, children, members).",
    fn(cx,input:EntityIn)->types::Entry {
        let slot = cx.book_v3(&input.book)?;
        let view = slot.reader_v3.view();
        let id = pid("entry", &input.id)?;
        let e = view
            .entry(&id)
            .ok_or_else(|| WsError::not_found("entry", &input.id))?;
        let files = Files::of(&view);
        let mut out: types::Entry = (&e).into();
        let snap = view.structure_snapshot();
        if e.has_below(snap.templates_map()) && !e.is_trashed() {
            out.below = below(&snap, &id);
        }
        mark_missing_media(&mut out, &files);
        Ok(out)
    }
}

/// Where a resolved setting comes from (kept here for callers that name it
/// through this module).
pub use super::types::SettingSource;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CreateIn {
    pub book: String,
    pub title: String,
    /// Residence (`住进`): the root (`None`) or a live entry with `level == true`.
    /// Mutually exclusive with `host`.
    #[serde(default)]
    pub parent: Option<String>,
    /// Membership host (`挂到`): a live entry with `accept == true`.
    /// Mutually exclusive with `parent`.
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub mark: Option<String>,
    #[serde(default)]
    pub template: Option<String>,
    /// The new entry's switch; the template's default when omitted.
    #[serde(default)]
    pub level: Option<bool>,
    /// Optional explicit initial text by prose module ID; omitted modules copy template prose.
    #[serde(default)]
    pub bodies: BTreeMap<String, String>,
}
op! {
    EntryCreate = "entry.create", Write, Book, "Create an entry either residing under `parent` (without membership) or attached to `host` (residing in `host`'s home, `host` itself when `level`, or the root).",
    fn(cx,input:CreateIn)->types::Entry {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let before = v.graph();
        if input.parent.is_some() && input.host.is_some() {
            return Err(WsError::invalid("parent and host cannot both be set"));
        }
        let (parent, host, default_source): (Option<EntryId>, Option<EntryId>, Option<EntryId>) =
            if let Some(host_str) = &input.host {
                let host_id = live(&v, host_str)?.id;
                if !before.entries[&host_id].accepts_members(&before.templates) {
                    return Err(WsError::invalid("host does not accept memberships"));
                }
                let res =
                    m::resolve_host_residence(&host_id, &before.entries, &before.templates);
                m::check_parent_is_level(res.as_ref(), &before.entries)?;
                (res, Some(host_id.clone()), Some(host_id))
            } else {
                let par = input
                    .parent
                    .as_deref()
                    .map(|s| pid("parent", s))
                    .transpose()?;
                m::check_parent_is_level(par.as_ref(), &before.entries)?;
                (par.clone(), None, par)
            };
        let template = input
            .template
            .as_deref()
            .map(|s| pid("template", s))
            .transpose()?
            .or_else(|| {
                m::resolve_level_settings(
                    default_source.as_ref(),
                    &before.entries,
                    &before.templates,
                )
                .default_template
            });
        m::check_entry_template(&before.templates, template.as_ref())?;
        let id = EntryId::new_v7();
        name_ok(&input.title)?;
        if let Some(mark) = &input.mark
            && !m::is_valid_mark(mark)
        {
            return Err(WsError::invalid(
                "mark must be a sand mark name or a single character",
            ));
        }
        let level = input.level.unwrap_or_else(|| {
            template
                .as_ref()
                .and_then(|t| before.templates.get(t))
                .is_some_and(|t| t.level)
        });
        let mut e = new_entry(
            id.clone(),
            parent.clone(),
            input.title.trim().into(),
            template.clone(),
            level,
        );
        e.mark = input.mark;
        if let Some(t) = e.effective_template(&before.templates) {
            for module in &t.modules {
                if module.kind == m::ModuleKind::Fields {
                    let mut defaults = BTreeMap::new();
                    for def in &module.config.defs {
                        if let Some(val) = def
                            .default_value
                            .as_ref()
                            .filter(|v| !matches!(v, m::FieldValue::Null))
                        {
                            defaults.insert(def.id.clone(), val.clone());
                        }
                    }
                    if !defaults.is_empty() {
                        e.fields.insert(module.id.clone(), defaults);
                    }
                } else if module.kind == m::ModuleKind::KeyValue {
                    let mut rows = module.config.initial_kv.clone();
                    for row in &mut rows {
                        row.id = KvEntryId::new_v7();
                    }
                    e.kv.insert(module.id.clone(), rows);
                }
            }
        }
        let mut after = before.clone();
        after.entries.insert(id.clone(), e.clone());
        if let Some(h) = &host {
            m::check_membership(h, &id, &after.entries, &after.templates)?;
            after.memberships.push(m::Membership {
                host: h.clone(),
                member: id.clone(),
                pos: None,
                created_at: Some(now()),
            });
            e.primary = Some(h.clone());
        }
        changes_ok(&before, &after)?;
        // An entry goes on a lane by being hung on it (`host`); living under
        // a lane (`parent`) puts nothing on the scale (DV, 2026-11-16).
        let mut auto_views: Vec<(TimelineViewId, f64)> = Vec::new();
        for lane in host.iter() {
            for tv in membership::live_views_with_lane(&v, lane) {
                let end = m::timeline_scale_end(&m::effective_timeline_placements(
                    &tv,
                    &before.memberships,
                    &before.entries,
                    &before.templates,
                ));
                auto_views.push((tv.id, end));
            }
        }
        module::initialize(cx, &slot, &e, &before.templates, &input.bodies)?;
        let saved = e.clone();
        let h = host.clone();
        let placed_views = auto_views.clone();
        let (_, at) = cx.write_book_v3(&slot, Replaces::nothing(), move |t| {
            let w = t.entries().create(
                &saved.id,
                saved.parent.as_ref(),
                &saved.title,
                saved.template.as_ref(),
                saved.level,
            )?;
            w.created_at(saved.created_at)?
                .mark(saved.mark.as_deref())?
                .primary(h.as_ref())?;
            for (module, fields) in &saved.fields {
                for (field_id, value) in fields {
                    w.set_field(module, field_id, Some(value))?;
                }
            }
            for (module, rows) in &saved.kv {
                for row in rows {
                    w.put_kv(module, row)?;
                }
            }
            if let Some(h) = &h {
                t.put_membership(h, &saved.id, None, Some(now()))?;
            }
            for (vid, end) in &placed_views {
                t.timeline_view(vid)?.put_placement(&saved.id, *end, None)?;
            }
            Ok(())
        })?;
        let mut keys = vec![key("entries", &id)];
        if let Some(h) = host {
            keys.push(key("memberships", m::Membership::key(&h, &id)));
        }
        for (vid, _) in &auto_views {
            keys.push(key("timeline_views", vid));
        }
        undo(cx, &slot, &at, keys);
        cx.effect(EffectAction::Created, "entry", id.as_str(), Some(&e.title));
        convert(slot.reader_v3.view().entry(&id).expect("created entry"))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct UpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub mark: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub template: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub overrides: Option<Option<types::LevelSettingsOverride>>,
}
op! {
    EntryUpdate = "entry.update", Write, Book, "Rename an entry, set its mark, switch its template or change the overrides of what lives below it, without deleting retained content or touching its switch.",
    fn(cx,input:UpdateIn)->Done {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let mut e = live(&v, &input.id)?;
        let templates = v.templates_map();
        let set = (
            input.title.is_some(),
            input.template.is_some(),
            input.overrides.is_some(),
            input.mark.is_some(),
        );
        if let Some(title) = input.title {
            name_ok(&title)?;
            e.title = title.trim().into();
        }
        if let Some(mark) = input.mark {
            if let Some(m_str) = &mark
                && !m::is_valid_mark(m_str)
            {
                return Err(WsError::invalid(
                    "mark must be a sand mark name or a single character",
                ));
            }
            e.mark = mark;
        }
        if let Some(template) = input.template {
            let template = template
                .as_deref()
                .map(|s| pid("template", s))
                .transpose()?;
            m::check_entry_template(&templates, template.as_ref())?;
            e.template = template;
        }
        if let Some(overrides) = input.overrides {
            let had_below = e.has_below(&templates);
            e.overrides = overrides.map(convert).transpose()?;
            let has_below = e.has_below(&templates);
            if let Some(s) = &e.overrides {
                let has_below_only_fields = s.default_template.is_some()
                    || s.display.is_some()
                    || s.auto_link.is_some()
                    || s.home.is_some()
                    || s.format_shortcuts.is_some();
                if has_below_only_fields && !had_below && !has_below {
                    return Err(WsError::invalid(
                        "only an entry with its level or accept switch on has below settings; turn one on first",
                    ));
                }
                settings_ok(s, &v)?;
            }
        }
        // A mark change alone touches nothing the structural checks read.
        if set.0 || set.1 || set.2 {
            let before = v.graph();
            let mut after = before.clone();
            if let Some(h) = after.entries.get_mut(&e.id) {
                h.title = e.title.clone();
                h.template = e.template.clone();
                h.overrides = e.overrides.clone();
            }
            changes_ok(&before, &after)?;
        }
        if set.1 {
            module::initialize(cx, &slot, &e, &templates, &BTreeMap::new())?;
        }
        let id = e.id.clone();
        let name = e.title.clone();
        // A new template or new overrides may turn 「收别处的条目」 back on
        // for a lane already in a view: what comes back into it is placed.
        let lane_may_change = set.1 || set.2;
        // Only the fields this call names are written, so a concurrent
        // change to another field of the same entry is neither a conflict
        // nor overwritten with the value this command read.
        let replaced = [
            ("title", set.0),
            ("template", set.1),
            ("overrides", set.2),
            ("mark", set.3),
        ]
        .into_iter()
        .filter(|(_, named)| *named)
        .map(|(field, _)| rec(CollectionV3::Entries, &e.id).at([field]));
        let (placed, at) = cx.write_book_v3(&slot, Replaces::records(replaced), move |t| {
            let w = t.entries().entry(&e.id)?;
            if set.0 {
                w.title(&e.title)?;
            }
            if set.1 {
                w.template(e.template.as_ref())?;
            }
            if set.2 {
                w.overrides(e.overrides.as_ref())?;
            }
            if set.3 {
                w.mark(e.mark.as_deref())?;
            }
            if lane_may_change {
                return membership::place_unplaced_lane_entries(t, &e.id);
            }
            Ok(Vec::new())
        })?;
        let mut keys = vec![key("entries", &id)];
        keys.extend(placed.iter().map(|vid| key("timeline_views", vid)));
        undo(cx, &slot, &at, keys);
        cx.effect(EffectAction::Updated, "entry", id.as_str(), Some(&name));
        Ok(Done { id: input.id })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MoveIn {
    pub book: String,
    pub id: String,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub index: Option<usize>,
}
op! {
    EntryMove = "entry.move", Write, Book, "Move an entry's residence and its position in the folder's manual order (`index` among the folder's stored children). Moving where an entry lives never hangs it on a lane or moves it on a timeline scale.",
    fn(cx,input:MoveIn)->Done {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let e = live(&v, &input.id)?;
        let before = v.graph();
        let parent: Option<EntryId> = input
            .parent
            .as_deref()
            .map(|s| pid("parent", s))
            .transpose()?;
        m::check_entry_move(&before.entries, &e.id, parent.as_ref())?;
        m::check_parent_is_level(parent.as_ref(), &before.entries)?;
        let mut after = before.clone();
        if let Some(h) = after.entries.get_mut(&e.id) {
            h.parent = parent.clone();
        }
        changes_ok(&before, &after)?;

        // A folder's order is its manual order, also while the folder is a
        // lane in a view: a lane holds what is hung on it, so moving where an
        // entry lives touches no place on a scale (DV, 2026-11-16).
        let id = e.id.clone();
        let moved = Replaces::record(CollectionV3::Entries, &e.id);
        let keys = vec![key("entries", &id)];
        let count = before
            .entries
            .values()
            .filter(|x| x.parent == parent && x.id != e.id)
            .count();
        let index = input.index.unwrap_or(count);
        if index > count {
            return Err(WsError::invalid("index exceeds sibling count"));
        }
        let (_, at) = cx.write_book_v3(&slot, moved, move |t| {
            t.entries().move_to_at(&e.id, parent.as_ref(), index)?;
            Ok(())
        })?;
        undo(cx, &slot, &at, keys);
        cx.effect(EffectAction::Moved, "entry", id.as_str(), None);
        Ok(Done { id: input.id })
    }
}
fn trash(cx: &Cx<'_>, input: EntityIn, trashed: bool) -> Result<Done> {
    let slot = cx.book_v3(&input.book)?;
    let v = slot.reader_v3.view();
    let id: EntryId = pid("entry", &input.id)?;
    let before = v.graph();
    let mut entries = before.entries.clone();
    if !entries.contains_key(&id) {
        return Err(WsError::not_found("entry", &input.id));
    }
    let previous = entries[&id].deleted_at;
    if trashed == previous.is_some() {
        cx.undo_nothing();
        return Ok(Done { id: input.id });
    }
    let stamp = trashed.then(now);
    // What goes in with it (its live subtree), or what comes back with it
    // (what went in with it, `ENTRY-TRASH-TOGETHER`).
    let ids = m::trashed_with(&entries, &id);
    for id in &ids {
        entries.get_mut(id).unwrap().deleted_at = stamp;
    }
    let mut relocated: Vec<(EntryId, Option<EntryId>)> = Vec::new();
    let mut auto_placements: Vec<(TimelineViewId, EntryId, f64)> = Vec::new();
    if !trashed {
        // If a restored entry's stored parent can no longer hold entries
        // (missing, trashed, or `level == false`), relocate it to the nearest
        // live ancestor with `level == true`, or the root (`kernel-v5.md` §16).
        // What came back with it counts as live by now.
        for rid in &ids {
            let lands = m::restored_residence(&entries, rid);
            if lands != entries[rid].parent {
                entries.get_mut(rid).unwrap().parent = lands.clone();
                relocated.push((rid.clone(), lands));
            }
        }
        let after = BookGraphV3 {
            entries: entries.clone(),
            ..before.clone()
        };
        changes_ok(&before, &after)?;
        // Every entry coming back that is hung on a lane of a live view gets a
        // position there if it has none (`VIEW-LANE-MEMBERS-PLACED`): the
        // lane may have entered the view while it was in Recently Deleted.
        // Each one gets its own position, at the scale's end, in tree order.
        // Where it lives does not put it on a lane (DV, 2026-11-16), so being
        // restored somewhere new takes no position away.
        let restored: Vec<EntryId> = v
            .entries_raw()
            .into_iter()
            .map(|e| e.id)
            .filter(|id| ids.contains(id))
            .collect();
        for tv in v
            .timeline_views_raw()
            .into_iter()
            .filter(|tv| !tv.is_trashed())
        {
            let mut next = None;
            for rid in &restored {
                let placed = v.timeline_placement_snapshot(&tv.id, rid)?.is_some();
                let in_lanes = m::is_entry_in_view_lanes(
                    &tv,
                    rid,
                    &after.memberships,
                    &after.entries,
                    &after.templates,
                );
                if in_lanes && !placed {
                    let at = next.get_or_insert_with(|| {
                        m::timeline_scale_end(&m::effective_timeline_placements(
                            &tv,
                            &after.memberships,
                            &after.entries,
                            &after.templates,
                        ))
                    });
                    auto_placements.push((tv.id.clone(), rid.clone(), *at));
                    *at += m::PLACEMENT_STEP;
                }
            }
        }
    }
    let changed = ids.clone();
    let reloc_writes = relocated;
    let place_writes = auto_placements.clone();
    // The named entry; the subtree that follows it is planned above.
    let named = rec(CollectionV3::Entries, &input.id).at(["deleted_at"]);
    let (_, at) = cx.write_book_v3(&slot, Replaces::records([named]), move |t| {
        for (rid, new_parent) in &reloc_writes {
            t.entries().move_to(rid, new_parent.as_ref())?;
        }
        for id in changed {
            t.entries().entry(&id)?.deleted_at(stamp)?;
        }
        for (vid, rid, end) in &place_writes {
            t.timeline_view(vid)?.put_placement(rid, *end, None)?;
        }
        Ok(())
    })?;
    let mut keys: Vec<_> = ids.iter().map(|id| key("entries", id)).collect();
    let placed_vids: BTreeSet<_> = auto_placements.into_iter().map(|(vid, _, _)| vid).collect();
    for vid in placed_vids {
        keys.push(key("timeline_views", vid));
    }
    undo(cx, &slot, &at, keys);
    for id in ids {
        cx.effect(
            if trashed {
                EffectAction::Trashed
            } else {
                EffectAction::Restored
            },
            "entry",
            id.as_str(),
            None,
        );
    }
    Ok(Done { id: input.id })
}
op! {
    EntryTrash="entry.trash",Write,Book,"Trash an entry with what lives under it, keeping entries that only belong to it.",fn(cx,input:EntityIn)->Done {
        trash(cx, input, true)
    }
}
op! {
    EntryRestore="entry.restore",Write,Book,"Restore an entry and what lives under it from trash; if its stored residence can no longer hold entries, relocate it to the nearest live level ancestor or the root.",fn(cx,input:EntityIn)->Done {
        trash(cx, input, false)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SetLevelIn {
    pub book: String,
    pub id: String,
    /// The switch (`层级`): whether entries can live under this one.
    pub level: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SetLevelOut {
    pub id: String,
    pub level: bool,
    /// Live descendants moved to the trash in place when the switch went off,
    /// in pre-order (already-trashed entries excluded).
    pub trashed: Vec<String>,
}
op! {
    EntrySetLevel = "entry.set_level", Write, Book, "Turn an entry's level switch on or off. Turning it off moves all live descendants below it to the trash in place (leaving already-trashed entries, overrides, memberships and swimlanes untouched) in one commit that one undo reverts.",
    fn(cx, input: SetLevelIn) -> SetLevelOut {
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let e = live(&v, &input.id)?;
        if e.level == input.level {
            cx.undo_nothing();
            return Ok(SetLevelOut {
                id: input.id,
                level: input.level,
                trashed: Vec::new(),
            });
        }
        let before = v.graph();
        let has_children = before
            .entries
            .values()
            .any(|c| c.parent.as_ref() == Some(&e.id));
        let stamp = now();
        let mut after = before.clone();
        if !input.level {
            let mut to_trash = BTreeSet::new();
            let mut frontier = vec![e.id.clone()];
            while let Some(cur) = frontier.pop() {
                for c in before.entries.values() {
                    if c.parent.as_ref() == Some(&cur)
                        && !c.is_trashed()
                        && to_trash.insert(c.id.clone())
                    {
                        frontier.push(c.id.clone());
                    }
                }
            }
            for tid in &to_trash {
                if let Some(h) = after.entries.get_mut(tid) {
                    h.deleted_at = Some(stamp);
                }
            }
        }
        if let Some(h) = after.entries.get_mut(&e.id) {
            h.level = input.level;
        }
        changes_ok(&before, &after)?;
        // The switch, and when it goes off with entries below, the order of
        // those entries: a caller that read them is held to what it read.
        let mut replaced = vec![rec(CollectionV3::Entries, &e.id).at(["level"])];
        if !input.level && has_children {
            replaced.push(dr_doc::v3::RecordKeyV3::children(
                CollectionV3::Entries,
                Some(e.id.as_str()),
            ));
        }
        let id = e.id.clone();
        let level = input.level;
        let (trashed, at) = cx.write_book_v3(&slot, Replaces::records(replaced), move |t| {
            if level {
                t.entries().entry(&id)?.level(true)?;
                Ok(Vec::new())
            } else {
                Ok(t.entries().switch_level_off(&id, stamp)?)
            }
        })?;
        let mut keys = vec![key("entries", &e.id)];
        keys.extend(trashed.iter().map(|c| key("entries", c)));
        undo(cx, &slot, &at, keys);
        cx.effect(EffectAction::Updated, "entry", e.id.as_str(), Some(&e.title));
        for c in &trashed {
            cx.effect(EffectAction::Trashed, "entry", c.as_str(), None);
        }
        Ok(SetLevelOut {
            id: input.id,
            level: input.level,
            trashed: trashed.iter().map(ToString::to_string).collect(),
        })
    }
}
