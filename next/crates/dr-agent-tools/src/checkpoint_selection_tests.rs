//! Which entries a write takes a checkpoint of: exactly as before, now that
//! only a call naming a relation, membership or patch by its own id loads the
//! book. `reference` is the selection as it was, loading a copy every time.
use std::collections::BTreeSet;

use dr_doc::v3::BorrowedBookV3;
use dr_model::{DocId, id::BookId, id::RelationId, kind::EntityKind, shared::EntityRef};
use dr_store::{OpenDoc, Origin};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

use super::super::{TurnKey, turn_key};
use super::{Named, entries};
use crate::{Error, Result, catalog::Catalog, resolve::ResolvedCall};

/// The selection before only lookups loaded the book.
fn reference(ws: &Workspace, key: &TurnKey, call: &ResolvedCall) -> Result<Vec<String>> {
    if call.name.starts_with("comment.") {
        return Ok(Vec::new());
    }
    let book = BookId::parse(&key.book).map_err(|e| Error::Invalid(e.to_string()))?;
    if !crate::catalog::is_v3_book(ws, &book)? {
        return Ok(Vec::new());
    }
    let mut ids = BTreeSet::new();
    for target in &call.targets {
        if let Ok(DocId::Body(body)) = DocId::parse(target) {
            ids.insert(body.entry().to_string());
        }
    }
    let args = &call.arguments;
    let keys: &[&str] = match call.name.as_str() {
        "entry.update" | "entry.move" | "entry.trash" | "entry.restore" | "entry.set_level" => {
            &["id"]
        }
        "membership.add" | "membership.remove" => &["host", "member"],
        "membership.primary" => &["member"],
        "timeline_view.place" | "timeline_view.remove" => &["lane", "entry"],
        name if name.starts_with("module.") && args["template"] != true => &["entry", "owner"],
        _ => &[],
    };
    for key in keys {
        if let Some(id) = args[*key].as_str() {
            ids.insert(id.to_owned());
        }
    }
    let copy = ws.library().load_copy(&format!("book:{book}"))?;
    let borrowed = BorrowedBookV3::new(&copy, &book).map_err(|e| Error::Invalid(e.to_string()))?;
    let view = borrowed.view();
    let mut endpoints = Vec::new();
    if matches!(
        call.name.as_str(),
        "relation.create" | "module.put_relation"
    ) {
        for key in ["from", "to", "other"] {
            if let (Some(kind), Some(id)) = (args[key]["kind"].as_str(), args[key]["id"].as_str()) {
                endpoints.push((EntityKind::from(kind), id.to_owned()));
            }
        }
    }
    if matches!(
        call.name.as_str(),
        "relation.delete" | "module.remove_relation"
    ) && let Some(relation) = view
        .relations_raw()
        .into_iter()
        .find(|r| Some(r.id.as_str()) == args["id"].as_str())
    {
        endpoints.extend([
            (relation.from.kind, relation.from.id),
            (relation.to.kind, relation.to.id),
        ]);
    }
    if call.name == "entry_history.restore" {
        for target in args["targets"].as_array().into_iter().flatten() {
            let Some(id) = target["id"].as_str() else {
                continue;
            };
            match target["collection"].as_str() {
                Some("entries") => {
                    ids.insert(id.to_owned());
                }
                Some("memberships") => {
                    for membership in view
                        .memberships_raw()
                        .iter()
                        .filter(|m| dr_model::v3::Membership::key(&m.host, &m.member) == id)
                    {
                        ids.extend([membership.host.to_string(), membership.member.to_string()]);
                    }
                }
                Some("patches") => endpoints.push((EntityKind::Patch, id.to_owned())),
                Some("plot_grids") => {
                    if let Some((entry, _)) = id.split_once('/') {
                        ids.insert(entry.to_owned());
                    }
                }
                Some("relations") => {
                    if let Some(r) = view
                        .relations_raw()
                        .into_iter()
                        .find(|r| r.id.as_str() == id)
                    {
                        endpoints.extend([(r.from.kind, r.from.id), (r.to.kind, r.to.id)]);
                    }
                }
                _ => {}
            }
        }
    }
    for (kind, id) in endpoints {
        if kind == EntityKind::Entry {
            ids.insert(id);
        } else if kind == EntityKind::Patch
            && let Some(patch) = view.patches().iter().find(|p| p.id.as_str() == id)
        {
            ids.insert(patch.entry.to_string());
        }
    }
    Ok(ids.into_iter().collect())
}

/// The calls whose checkpoint has to find a record in the book (with the
/// arguments below, which name every kind of record).
const LOOKUPS: &[&str] = &[
    "entry_history.restore",
    "module.put_relation",
    "module.remove_relation",
    "relation.create",
    "relation.delete",
];

#[test]
fn every_write_selects_the_same_entries_and_only_lookups_need_the_book() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "checkpoint-selection").unwrap();
    ws.set_auto_links(false);
    let made = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let book = made.books[0].book_id().clone();
    made.write_to(ws.library()).unwrap();
    let doc = format!("book:{book}");
    let key = turn_key(&book, &Actor::agent("checkpoint-selection", 1, "write"));
    let out =
        |name: &str, input: Value| ws.call(&Actor::User, name, input).unwrap()["output"].clone();

    // Records to name: entries, a patch, relations between entries and from
    // the patch, memberships.
    let rows = out("entry.list", json!({"book":book,"all":true}));
    let of = |tpl: &str| {
        rows.as_array()
            .unwrap()
            .iter()
            .find(|e| e["template"] == tpl)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let chapter = of("tpl-chapter");
    let character = of("tpl-character");
    let patch = out(
        "module.put_patch",
        json!({"book":book,"entry":character,"module":"mod-patches","title":"Synthetic patch","body":"Synthetic body"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (relation, membership) = {
        let copy = ws.library().load_copy(&doc).unwrap();
        let b = BorrowedBookV3::new(&copy, &book).unwrap();
        let v = b.view();
        (
            v.relations_raw()
                .into_iter()
                .next()
                .expect("the seed has relations"),
            v.memberships_raw()
                .into_iter()
                .next()
                .expect("the seed has memberships"),
        )
    };
    let from_patch = RelationId::new_v7();
    {
        let h = ws.library().open_doc(&doc, OpenDoc::Existing).unwrap();
        let (book, id, ty) = (
            book.clone(),
            from_patch.clone(),
            relation.relation_type.clone(),
        );
        let ends = (
            EntityRef {
                kind: EntityKind::Patch,
                id: patch.clone(),
            },
            EntityRef {
                kind: EntityKind::Entry,
                id: chapter.clone(),
            },
        );
        h.write(Origin::User, move |d| {
            let b = BorrowedBookV3::new(d, &book).unwrap();
            let mut t = b.txn();
            t.relation(&id)
                .unwrap()
                .ends(&ends.0, &ends.1)
                .unwrap()
                .relation_type(&ty)
                .unwrap();
        })
        .unwrap();
    }
    let membership_key = dr_model::v3::Membership::key(&membership.host, &membership.member);

    // Argument sets: none; every key any call reads, naming entries and
    // existing records; the same with unknown or missing records; only
    // records named directly.
    let body = format!("body:{chapter}/mod-prose");
    let everything = |id: Value, template: bool| {
        json!({
            "book": book, "id": id, "template": template,
            "host": membership.host.to_string(), "member": membership.member.to_string(),
            "lane": chapter, "entry": character, "owner": chapter,
            "from": {"kind": "entry", "id": chapter},
            "to": {"kind": "patch", "id": patch},
            "other": {"kind": "material", "id": "synthetic-material"},
            "targets": [
                {"collection": "entries", "id": character},
                {"collection": "memberships", "id": membership_key},
                {"collection": "patches", "id": patch},
                {"collection": "plot_grids", "id": format!("{chapter}/synthetic-grid")},
                {"collection": "relations", "id": relation.id.to_string()},
                {"collection": "relations", "id": from_patch.to_string()},
                {"collection": "templates", "id": "tpl-character"},
                {"collection": "entries"},
            ],
        })
    };
    let variants: Vec<(Value, Vec<String>)> = vec![
        (json!({}), Vec::new()),
        (
            everything(json!(chapter), false),
            vec![doc.clone(), body.clone()],
        ),
        (
            everything(json!(relation.id.to_string()), false),
            vec![doc.clone()],
        ),
        (
            everything(json!(from_patch.to_string()), true),
            vec![doc.clone(), body.clone()],
        ),
        (
            everything(json!("019a3f62-0000-7000-8000-000000000000"), false),
            vec![doc.clone()],
        ),
        (everything(json!(7), true), vec![doc.clone()]),
        (
            json!({
                "book": book, "id": chapter, "entry": character,
                "from": {"kind": "entry", "id": chapter},
                "to": {"kind": "entry", "id": character},
                "targets": [
                    {"collection": "entries", "id": character},
                    {"collection": "plot_grids", "id": format!("{chapter}/synthetic-grid")},
                ],
            }),
            vec![doc.clone(), body.clone()],
        ),
    ];

    let catalog = Catalog::for_book(&ws, &book).unwrap();
    let mut names: Vec<String> = catalog
        .entries()
        .iter()
        .filter(|e| e.access == dr_agent::ToolAccess::Write)
        // A template action is resolved to the entry.create it stands for.
        .map(|e| {
            if e.action.is_some() {
                "entry.create".to_owned()
            } else {
                e.name.clone()
            }
        })
        .collect();
    names.sort();
    names.dedup();
    assert!(names.len() >= 50, "{names:?}");
    for name in LOOKUPS {
        assert!(names.iter().any(|n| n == name), "{name} is a write tool");
    }

    let mut selected = 0;
    for name in &names {
        for (n, (arguments, targets)) in variants.iter().enumerate() {
            let call = ResolvedCall {
                name: name.clone(),
                arguments: arguments.clone(),
                targets: targets.clone(),
                subjects: Vec::new(),
            };
            let now = entries(&ws, &key, &call).unwrap();
            assert_eq!(
                now,
                reference(&ws, &key, &call).unwrap(),
                "{name}, arguments {n}"
            );
            selected += usize::from(!now.is_empty());
            // Only a lookup loads the book; the full argument set makes
            // every lookup a call can do.
            let looks_up = !Named::of(&call).lookups.is_empty();
            if n == 1 && !name.starts_with("comment.") {
                assert_eq!(looks_up, LOOKUPS.contains(&name.as_str()), "{name}");
            }
            if n == 0 {
                assert!(!looks_up, "{name}, arguments {n}");
            }
            if n == 6 {
                // Only an `id` that may be a relation's is looked up.
                assert_eq!(
                    looks_up,
                    matches!(name.as_str(), "relation.delete" | "module.remove_relation"),
                    "{name}, arguments {n}"
                );
            }
        }
    }
    assert!(selected > names.len(), "most calls select something");

    // What the lookups find.
    let call = |name: &str, arguments: Value| ResolvedCall {
        name: name.into(),
        arguments,
        targets: vec![doc.clone()],
        subjects: Vec::new(),
    };
    let mut both = vec![character.clone(), chapter.clone()];
    both.sort();
    assert_eq!(
        entries(
            &ws,
            &key,
            &call("relation.delete", json!({"id": from_patch.to_string()}))
        )
        .unwrap(),
        both,
        "a relation from a patch checkpoints the patch's entry and the other end"
    );
    assert_eq!(
        (&relation.from.kind, &relation.to.kind),
        (&EntityKind::Entry, &EntityKind::Entry)
    );
    let mut ends = vec![relation.from.id.clone(), relation.to.id.clone()];
    ends.sort();
    ends.dedup();
    assert_eq!(
        entries(
            &ws,
            &key,
            &call(
                "entry_history.restore",
                json!({"targets": [{"collection": "relations", "id": relation.id.to_string()}]})
            )
        )
        .unwrap(),
        ends
    );
    let mut members = vec![membership.host.to_string(), membership.member.to_string()];
    members.sort();
    members.dedup();
    assert_eq!(
        entries(
            &ws,
            &key,
            &call(
                "entry_history.restore",
                json!({"targets": [{"collection": "memberships", "id": membership_key}]})
            )
        )
        .unwrap(),
        members
    );
    ws.close();
}
