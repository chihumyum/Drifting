//! `entry.purge`: an entry in Recently Deleted deleted for good, with what
//! went into Recently Deleted with it (`kernel-v5.md` §16 「从最近删除里清除一个条目」).
//!
//! What the rest of the book reads afterwards follows the written rules:
//! a Tab mounted on it keeps its name (§5), its relation rows lose it and a
//! row left with an empty side goes while the relation stays (§19), its
//! canvas coordinates are collected in this step and in no other (§18),
//! its placements and the places that were there only because of it go,
//! a time pin bound to it is unbound (`V3-TIMELINE-TARGETS-LIVE`), what is
//! hung on it or what it was hung on is no longer hung, a checklist item's
//! comment goes with the line (`TASK-COMMENT-ONE`), and every other comment
//! on it stays and reads unlocated (`CMT-TARGET`). Links to it from other
//! prose are left as they are and read as a link whose target is gone, as
//! they did while it was in Recently Deleted. It cannot be undone: like
//! `asset.purge`, it is irreversible and the steps that could bring its
//! records back are retired.
use super::*;
use dr_model::DocId;
use dr_model::kind::{CommentStatus, EntityKind, ProjectionKind};

pub(crate) fn register(r: &mut Registry) {
    r.add::<EntryPurge>();
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct EntryPurged {
    pub id: String,
    /// Every entry deleted for good: `id` and what went into Recently
    /// Deleted with it, in the order the book had them.
    pub purged: Vec<String>,
    /// Their stored body documents deleted.
    pub docs: usize,
}

/// One timeline view's part of a purge.
#[derive(Clone)]
struct ViewRelease {
    view: TimelineViewId,
    lanes: Vec<EntryId>,
    placements: Vec<EntryId>,
    pins: Vec<m::TimelinePin>,
}

op! {
    EntryPurge = "entry.purge", Write, Book,
    "Delete an entry in Recently Deleted for good, with the entries that went in with it: their bodies, checkpoints, memberships, placements, relation memberships and canvas coordinates. An entry below it that went in on its own moves up to where it lived. Refused for an entry not in Recently Deleted. Cannot be undone.",
    fn(cx, input: EntityIn) -> EntryPurged {
        purge(cx, input)
    }
}

fn purge(cx: &Cx<'_>, input: EntityIn) -> Result<EntryPurged> {
    let slot = cx.book_v3(&input.book)?;
    let v = slot.reader_v3.view();
    let id: EntryId = pid("entry", &input.id)?;
    let raw = v.entries_raw();
    let entries: BTreeMap<EntryId, m::Entry> =
        raw.iter().map(|e| (e.id.clone(), e.clone())).collect();
    let e = entries
        .get(&id)
        .ok_or_else(|| WsError::not_found("entry", &input.id))?;
    if !e.is_trashed() {
        return Err(WsError::invalid(
            "entry must be in Recently Deleted before purge",
        ));
    }
    // What goes: it and what went in with it (`ENTRY-TRASH-TOGETHER`).
    let gone = m::trashed_with(&entries, &id);
    let order: Vec<EntryId> = raw
        .iter()
        .map(|e| e.id.clone())
        .filter(|x| gone.contains(x))
        .collect();
    // An entry living under one of them that went in on its own, or (after
    // a merge) is live, moves up to where `id` lived: restoring it later
    // then lands where it would have landed before (`restored_residence`
    // walks past what is gone the same way).
    let home = e.parent.clone().filter(|p| entries.contains_key(p));
    let survivors: Vec<EntryId> = raw
        .iter()
        .filter(|x| !gone.contains(&x.id) && x.parent.as_ref().is_some_and(|p| gone.contains(p)))
        .map(|x| x.id.clone())
        .collect();

    // A Tab mounted on one of them keeps its name (`TAB-KEEPS-GONE-NAME`).
    let tabs: Vec<(TabId, String)> = v
        .stored_tabs()
        .into_iter()
        .filter_map(|t| match &t.mount {
            m::TabMount::Entry { entry } if gone.contains(entry) => {
                Some((t.id.clone(), entries[entry].title.clone()))
            }
            _ => None,
        })
        .collect();
    // Their own records: patches, plot grids, memberships either way.
    let mut owned: BTreeSet<(CollectionV3, String)> = BTreeSet::new();
    for g in &gone {
        for (collection, rows) in v.entry_owned_records(g) {
            owned.extend(rows.into_keys().map(|k| (collection, k)));
        }
    }
    let memberships: Vec<(EntryId, EntryId)> = v
        .memberships_raw()
        .into_iter()
        .filter(|ms| gone.contains(&ms.host) || gone.contains(&ms.member))
        .map(|ms| (ms.host, ms.member))
        .collect();
    let raw_memberships = v.memberships_raw();
    let hung_on = |member: &EntryId, host: &EntryId| {
        raw_memberships
            .iter()
            .any(|ms| &ms.member == member && &ms.host == host)
    };
    // A primary host that is gone is no longer one.
    let primaries: Vec<EntryId> = raw
        .iter()
        .filter(|x| !gone.contains(&x.id) && x.primary.as_ref().is_some_and(|p| gone.contains(p)))
        .map(|x| x.id.clone())
        .collect();
    // Views: its lanes and places go; a place that was there only because
    // its entry was hung on a lane that goes goes too
    // (`V3-TIMELINE-PLACEMENT-IN-LANE`); a pin bound to it is unbound.
    let views: Vec<ViewRelease> = v
        .timeline_views_raw()
        .into_iter()
        .filter_map(|tv| {
            let (lanes_gone, lanes_left): (Vec<_>, Vec<_>) = tv
                .lanes
                .iter()
                .map(|l| l.entry.clone())
                .partition(|l| gone.contains(l));
            let placements: Vec<EntryId> = tv
                .placements
                .iter()
                .map(|p| p.entry.clone())
                .filter(|x| {
                    gone.contains(x)
                        || (lanes_gone.iter().any(|l| hung_on(x, l))
                            && !lanes_left.iter().any(|l| hung_on(x, l)))
                })
                .collect();
            let pins: Vec<m::TimelinePin> = tv
                .pins
                .iter()
                .filter(|p| p.entry.as_ref().is_some_and(|e| gone.contains(e)))
                .cloned()
                .map(|mut p| {
                    p.entry = None;
                    p
                })
                .collect();
            (!lanes_gone.is_empty() || !placements.is_empty() || !pins.is_empty()).then_some(
                ViewRelease {
                    view: tv.id.clone(),
                    lanes: lanes_gone,
                    placements,
                    pins,
                },
            )
        })
        .collect();
    // A comment projected from their prose follows its line, which is gone:
    // a checklist item's always, a marker's while it is open (as
    // `comment.project` does when a line goes). Every other comment on them
    // stays and reads unlocated.
    let comments: Vec<CommentId> = v
        .comments()
        .into_iter()
        .filter(|c| {
            c.target.as_ref().is_some_and(|t| {
                t.kind == EntityKind::Entry
                    && EntryId::parse(&t.id).is_ok_and(|t| gone.contains(&t))
            }) && c.projection.as_ref().is_some_and(|p| {
                p.kind == ProjectionKind::NoteTask || c.status == CommentStatus::Open
            })
        })
        .map(|c| c.id)
        .collect();
    // Their bodies: every body document of theirs the library has.
    let lib = cx.workspace().library();
    let bodies: Vec<DocId> = lib
        .docs(Some(slot.book.as_str()), Some("body"))?
        .into_iter()
        .filter_map(|d| match DocId::parse(&d.doc_id) {
            Ok(DocId::Body(b)) if gone.contains(b.entry()) => Some(DocId::Body(b)),
            _ => None,
        })
        .collect();
    // Nothing is written while one of them is open in an editor.
    cx.workspace().release_prose_docs(&bodies)?;

    let mut replaced: Vec<_> = order
        .iter()
        .map(|g| rec(CollectionV3::Entries, g))
        .collect();
    replaced.extend(survivors.iter().map(|s| rec(CollectionV3::Entries, s)));
    replaced.extend(primaries.iter().map(|p| rec(CollectionV3::Entries, p)));
    replaced.extend(
        tabs.iter()
            .map(|(t, _)| rec(CollectionV3::Project, "tabs").at([t.as_str()])),
    );
    let w = (
        gone.clone(),
        home.clone(),
        survivors.clone(),
        tabs.clone(),
        owned.clone(),
        memberships.clone(),
        primaries.clone(),
        views.clone(),
        comments.clone(),
    );
    cx.write_book_v3(&slot, Replaces::records(replaced), move |t| {
        let (gone, home, survivors, tabs, owned, memberships, primaries, views, comments) = w;
        for (tab, title) in &tabs {
            t.project().tab_gone_title(tab, title)?;
        }
        for s in &survivors {
            t.entries().move_to(s, home.as_ref())?;
        }
        for (host, member) in &memberships {
            t.remove_membership(host, member)?;
        }
        for p in &primaries {
            t.entries().entry(p)?.primary(None)?;
        }
        for r in &views {
            let view = t.timeline_view(&r.view)?;
            for lane in &r.lanes {
                view.remove_lane(lane)?;
            }
            for entry in &r.placements {
                view.remove_placement(entry)?;
            }
            for pin in &r.pins {
                view.put_pin(pin)?;
            }
        }
        for (collection, key) in &owned {
            if *collection != CollectionV3::Memberships {
                t.purge(*collection, key)?;
            }
        }
        for c in &comments {
            t.purge(CollectionV3::Comments, c.as_str())?;
        }
        t.entries().purge_entries(&gone, home.as_ref())?;
        Ok(())
    })?;

    // Then what lives outside the book document: their bodies (recorded
    // as purged, so sync takes the deletion to the other devices and an old
    // copy arriving later stays out), their coordinates and checkpoints.
    let mut docs = 0;
    for doc in &bodies {
        match lib.purge_doc(&doc.to_string()) {
            Ok(()) => docs += 1,
            Err(dr_store::StoreError::NotFound(_)) => {}
            // The book no longer has the entry: a body left behind is read
            // as owned by nothing (`PROSE-OWNER`).
            Err(e) => log::warn!("entry.purge: {doc} stays: {e}"),
        }
    }
    cx.release_purged_entries(&slot.book, &gone)?;
    // Steps whose undo or redo would bring their records back now have
    // nothing to bring back: Undo passes over them.
    let journal = &cx.workspace().inner.journal;
    for g in &order {
        journal.forget_record(slot.book.as_str(), "entries", g.as_str())?;
    }
    for (host, member) in &memberships {
        journal.forget_record(
            slot.book.as_str(),
            "memberships",
            &m::Membership::key(host, member),
        )?;
    }
    for s in &survivors {
        cx.effect(EffectAction::Moved, "entry", s.as_str(), None);
    }
    for p in &primaries {
        cx.effect(EffectAction::Updated, "entry", p.as_str(), None);
    }
    for g in &order {
        cx.effect(
            EffectAction::Purged,
            "entry",
            g.as_str(),
            Some(entries[g].title.as_str()),
        );
    }
    cx.irreversible();
    Ok(EntryPurged {
        id: input.id,
        purged: order.iter().map(ToString::to_string).collect(),
        docs,
    })
}
