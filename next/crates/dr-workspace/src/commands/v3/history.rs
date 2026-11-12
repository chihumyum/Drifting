use super::*;
pub(crate) fn register(r: &mut Registry) {
    r.add::<Restore>().add::<Version>();
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Key {
    /// entries, templates, memberships, timeline_views, patches, plot_grids, relations, relation_types, materials, comments, facts, memory or material_folders.
    pub collection: String,
    pub id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RestoreIn {
    pub book: String,
    pub at: String,
    pub targets: Vec<Key>,
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct VersionInfo {
    pub version: String,
}
op! {
    Version="entry_history.version",Read,Shared,"Read the current book version for per-entry snapshot restoration.",fn(cx,input:BookIn)->VersionInfo {
        let s = cx.book_v3(&input.book)?;
        let version = s.handle.read(|d| frontiers_hex(&d.oplog_frontiers()))?;
        Ok(VersionInfo { version })
    }
}
enum Plan {
    Entry(
        EntryId,
        Option<EntryId>,
        Vec<EntryId>,
        dr_doc::v3::EntrySnapshotV3,
    ),
    Trash(EntryId),
    Map(CollectionV3, String, Option<dr_doc::v3::EntrySnapshotV3>),
    SharedMap(CollectionV3, String),
}
op! {
    Restore="entry_history.restore",Write,Book,"Restore selected entry metadata (switch included) or structural records from a snapshot as a new undoable commit.",fn(cx,input:RestoreIn)->Vec<Done> {
        restore(cx, input)
    }
}
fn restore(cx: &Cx<'_>, input: RestoreIn) -> Result<Vec<Done>> {
    let s = cx.book_v3(&input.book)?;
    if input.targets.is_empty() {
        cx.undo_nothing();
        return Ok(Vec::new());
    }
    let at = frontiers_from_hex(&input.at)?;
    let old_doc = cx
        .workspace()
        .library()
        .load_copy_at(&format!("book:{}", s.book), &at)?;
    let old = dr_doc::v3::BorrowedBookV3::new(&old_doc, &s.book)?;
    let old = old.view();
    let current = s.reader_v3.view();
    let folders = super::history_folders::plan(&old, &current, &input.targets)?;
    let before = current.graph();
    let mut entries = current.entries_map();
    let mut templates = current.templates_map();
    let mut ms = current.memberships_raw();
    let mut plans = Vec::new();
    let mut seen = BTreeSet::new();
    for target in &input.targets {
        if !seen.insert((&target.collection, &target.id)) {
            return Err(WsError::invalid("duplicate restore target"));
        }
        match target.collection.as_str() {
            "entries" => {
                let id: EntryId = pid("entry", &target.id)?;
                if let Some(mut e) = old.entry(&id) {
                    let parent = e.parent.clone().filter(|p| {
                        entries.contains_key(p)
                            || input.targets.iter().any(|k| {
                                k.collection == "entries"
                                    && k.id == p.as_str()
                                    && old.entry(p).is_some()
                            })
                    });
                    e.parent = parent.clone();
                    let siblings = old
                        .entries_raw()
                        .into_iter()
                        .filter(|x| x.parent == parent)
                        .map(|x| x.id)
                        .collect();
                    plans.push(Plan::Entry(
                        id.clone(),
                        parent,
                        siblings,
                        old.entry_snapshot(&id).expect("entry metadata"),
                    ));
                    entries.insert(id, e);
                } else if let Some(e) = entries.get_mut(&id) {
                    e.deleted_at = Some(now());
                    plans.push(Plan::Trash(id));
                }
            }
            "material_folders" => {}
            "templates" | "memberships" | "timeline_views" | "patches" | "plot_grids"
            | "relations" | "relation_types" | "materials" | "comments" | "facts" | "memory" => {
                let c = CollectionV3::from_root(&target.collection).unwrap();
                if c == CollectionV3::RelationTypes {
                    let id = pid("relation type", &target.id)?;
                    if current
                        .relation_type(&id)
                        .is_some_and(|t| t.locked || t.system_key.is_some())
                    {
                        return Err(WsError::invalid("locked relation type cannot be restored"));
                    }
                    if old.relation_type(&id).is_none()
                        && current
                            .relations_raw()
                            .iter()
                            .any(|r| r.relation_type == id)
                    {
                        return Err(WsError::invalid("relation type is in use"));
                    }
                }
                if matches!(
                    c,
                    CollectionV3::Facts | CollectionV3::Memory | CollectionV3::Relations
                ) {
                    plans.push(Plan::SharedMap(c, target.id.clone()));
                } else {
                    plans.push(Plan::Map(
                        c,
                        target.id.clone(),
                        old.map_snapshot(c, &target.id),
                    ));
                }
                if c == CollectionV3::Templates {
                    let id: EntryTemplateId = pid("template", &target.id)?;
                    if let Some(t) = old.template(&id) {
                        templates.insert(id, t);
                    } else {
                        templates.remove(&id);
                    }
                }
                if c == CollectionV3::Memberships {
                    let (host, member) = m::Membership::parse_key(&target.id)
                        .ok_or_else(|| WsError::invalid("invalid membership key"))?;
                    ms.retain(|m| m.host != host || m.member != member);
                    ms.extend(
                        old.memberships_raw()
                            .into_iter()
                            .filter(|m| m.host == host && m.member == member),
                    );
                }
            }
            _ => return Err(WsError::invalid("unsupported v3 history collection")),
        }
    }
    for p in &plans {
        if let Plan::Entry(id, parent, _, _) = p {
            m::check_entry_move(&entries, id, parent.as_ref())?;
            m::check_parent_is_level(parent.as_ref(), &entries)?;
            // An entry restored with its switch off may not keep live
            // entries under it that this restore does not move elsewhere.
            if entries
                .get(id)
                .is_some_and(|e| !e.is_trashed() && !e.is_level())
                && entries
                    .values()
                    .any(|c| !c.is_trashed() && c.parent.as_ref() == Some(id))
            {
                return Err(WsError::invalid(
                    "restoration would leave entries under an entry whose switch is off",
                ));
            }
        }
        if let Plan::Map(CollectionV3::Templates, id, _) = p {
            let id = pid("template", id)?;
            if templates.get(&id).is_none_or(|t| t.is_trashed()) {
                m::check_template_delete(&id, &entries)?;
            }
        }
    }
    changes_ok(
        &before,
        &BookGraphV3 {
            entries: entries.clone(),
            templates: templates.clone(),
            memberships: ms.clone(),
        },
    )?;
    // The desired final graph is acyclic. Order its ancestors before their children.
    let depth = |id: &EntryId| {
        let mut n = 0;
        let mut parent = entries.get(id).and_then(|e| e.parent.as_ref());
        let mut seen = BTreeSet::new();
        while let Some(p) = parent {
            if !seen.insert(p) {
                break;
            }
            n += 1;
            parent = entries.get(p).and_then(|e| e.parent.as_ref());
        }
        n
    };
    plans.sort_by_key(|p| match p {
        Plan::Entry(id, _, siblings, _) => (
            1,
            depth(id),
            siblings.iter().position(|s| s == id).unwrap_or(0),
        ),
        _ => (0, 0, 0),
    });
    let book = s.book.clone();
    let restored = Replaces::records(input.targets.iter().filter_map(|target| {
        Some(rec(
            CollectionV3::from_root(&target.collection)?,
            &target.id,
        ))
    }));
    let (_, before) = cx.write_book_v3(&s, restored, move |t| {
        let shared = plans
            .iter()
            .filter_map(|p| match p {
                Plan::SharedMap(c, id) => Some((*c, id.clone())),
                _ => None,
            })
            .collect::<Vec<_>>();
        if !shared.is_empty() {
            let old = dr_doc::v3::BorrowedBookV3::new(&old_doc, &book)?;
            t.restore_shared_records_at(&shared, &old.view())?;
        }
        super::history_folders::apply(t, &folders)?;
        // Detach selected nodes first: a valid final graph can otherwise have a
        // transient cycle (restoring A above B while A currently lives below B).
        for p in &plans {
            if let Plan::Entry(id, _, _, snapshot) = p {
                t.restore_entry_with_parent(id, None, snapshot)?;
            }
        }
        for p in plans {
            match p {
                Plan::Entry(id, parent, historical, _) => {
                    let siblings = t
                        .view()
                        .entries_raw()
                        .into_iter()
                        .filter(|e| e.parent == parent && e.id != id)
                        .map(|e| e.id)
                        .collect::<Vec<_>>();
                    let old_index = historical.iter().position(|e| e == &id).unwrap_or(0);
                    let preceding = historical[..old_index]
                        .iter()
                        .rev()
                        .find_map(|e| siblings.iter().position(|s| s == e).map(|i| i + 1));
                    let following = historical
                        .iter()
                        .skip(old_index + 1)
                        .find_map(|e| siblings.iter().position(|s| s == e));
                    let index = preceding
                        .or(following)
                        .unwrap_or(old_index.min(siblings.len()));
                    t.entries().move_to_at(&id, parent.as_ref(), index)?;
                }
                Plan::Trash(id) => {
                    t.entries().entry(&id)?.deleted_at(Some(now()))?;
                }
                Plan::Map(c, id, snapshot) => {
                    t.restore_map_snapshot(c, &id, snapshot.as_ref())?;
                }
                Plan::SharedMap(_, _) => {}
            }
        }
        Ok(())
    })?;
    let out = input
        .targets
        .iter()
        .map(|k| {
            cx.effect(EffectAction::Restored, &k.collection, &k.id, None);
            Done { id: k.id.clone() }
        })
        .collect();
    undo(cx, &s, &before, input.targets);
    Ok(out)
}
