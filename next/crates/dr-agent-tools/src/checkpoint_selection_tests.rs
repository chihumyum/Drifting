//! Which entries a write takes a checkpoint of: exactly as before, now that
//! only a call naming a relation, membership or patch by its own id loads the
//! book. `reference` is the selection as it was, loading a copy every time.
use std::collections::BTreeSet;

use dr_doc::v3::BorrowedBookV3;
use dr_model::{DocId, id::BookId, id::RelationId, kind::EntityKind};
use dr_store::{OpenDoc, Origin};
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use serde_json::{Value, json};

use super::super::{TurnKey, turn_key};
use super::{Named, entries};
use crate::{Error, Result, catalog::Catalog, resolve::ResolvedCall};

/// The selection before only lookups loaded the book.
fn reference(ws: &Workspace, key: &TurnKey, call: &ResolvedCall) -> Result<Vec<String>> {
    if call.name.starts_with("layout.") {
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
        "relation_row.create_pair" => &["left", "right"],
        "relation_row.add_entry" | "relation_row.remove_entry" => &["entry"],
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
    let headers = view.entry_headers_with(&std::collections::BTreeMap::new());
    if call.name == "entry.set_level"
        && args["level"] == false
        && let Some(id) = args["id"].as_str()
        && let Ok(parent_id) = dr_model::id::EntryId::parse(id)
        && let Some(parent) = view.entry_raw(&parent_id)
        && !parent.is_trashed()
        && parent.is_level()
    {
        let mut descendants = BTreeSet::new();
        let mut frontier = vec![parent_id];
        while let Some(cur) = frontier.pop() {
            for child in headers.values() {
                if child.parent.as_ref() == Some(&cur)
                    && !child.is_trashed()
                    && descendants.insert(child.id.clone())
                {
                    frontier.push(child.id.clone());
                }
            }
        }
        ids.extend(descendants.into_iter().map(|eid| eid.to_string()));
    }
    let mut endpoints = Vec::new();
    let mut comments = Vec::new();
    let mut assets = Vec::new();
    let mut folders = Vec::new();
    if call.name == "comment.create"
        && let (Some(kind), Some(id)) = (
            args["target"]["kind"].as_str(),
            args["target"]["id"].as_str(),
        )
    {
        endpoints.push((EntityKind::from(kind), id.to_owned()));
    }
    if matches!(call.name.as_str(), "comment.update" | "comment.reanchor")
        && let Some(id) = args["id"].as_str()
    {
        comments.push(id.to_owned());
    }
    if matches!(
        call.name.as_str(),
        "asset.rename" | "asset.move" | "asset.trash" | "asset.restore"
    ) && let Some(id) = args["id"].as_str()
    {
        assets.push(id.to_owned());
    }
    if matches!(
        call.name.as_str(),
        "asset_folder.rename" | "asset_folder.move" | "asset_folder.trash" | "asset_folder.restore"
    ) && let Some(id) = args["id"].as_str()
    {
        folders.push(id.to_owned());
    }
    if call.name == "asset_folder.create"
        && let Some(parent) = args["parent"].as_str()
    {
        folders.push(parent.to_owned());
    }
    let rows = view.relations_raw();
    for row in &rows {
        let selected = if matches!(
            call.name.as_str(),
            "relation_row.add_entry" | "relation_row.remove_entry" | "relation_row.delete"
        ) {
            Some(row.id.as_str()) == args["id"].as_str()
        } else if matches!(
            call.name.as_str(),
            "relation_type.set_direction" | "relation_type.delete"
        ) {
            Some(row.relation_type.as_str()) == args["id"].as_str()
        } else {
            false
        };
        if selected {
            ids.extend(row.left.union(&row.right).map(ToString::to_string));
        }
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
                Some("relations") | Some("relation_types") => {
                    let relation_type = target["collection"] == "relation_types";
                    for row in rows.iter().filter(|r| {
                        if relation_type {
                            r.relation_type.as_str() == id
                        } else {
                            r.id.as_str() == id
                        }
                    }) {
                        ids.extend(row.left.union(&row.right).map(ToString::to_string));
                    }
                }
                Some("comments") => comments.push(id.to_owned()),
                Some("assets") => assets.push(id.to_owned()),
                Some("asset_folders") => folders.push(id.to_owned()),
                _ => {}
            }
        }
    }
    for fid_str in folders {
        if let Ok(fid) = dr_model::id::AssetFolderId::parse(&fid_str) {
            let (_, files) = crate::resolve::asset_folder_subtree(&view, &fid);
            assets.extend(files.into_iter().map(|a| a.id.to_string()));
        }
    }
    let mut patches = Vec::new();
    for (kind, id) in endpoints {
        match kind {
            EntityKind::Entry => {
                ids.insert(id);
            }
            EntityKind::Patch => patches.push(id),
            EntityKind::Comment => comments.push(id),
            EntityKind::Asset => assets.push(id),
            _ => {}
        }
    }
    if !comments.is_empty() {
        let stored_comments = view.comments();
        for cid in comments {
            if let Some(c) = stored_comments.iter().find(|c| c.id.as_str() == cid)
                && let Some(t) = &c.target
            {
                match t.kind {
                    EntityKind::Entry => {
                        ids.insert(t.id.clone());
                    }
                    EntityKind::Patch => patches.push(t.id.clone()),
                    EntityKind::Asset => assets.push(t.id.clone()),
                    _ => {}
                }
            }
        }
    }
    if !assets.is_empty() {
        let asset_set: BTreeSet<String> = assets.into_iter().collect();
        ids.extend(super::entries_referencing_assets(
            ws, &book, &view, &headers, &asset_set,
        )?);
    }
    let stored_patches = view.patches();
    for pid in patches {
        if let Some(patch) = stored_patches.iter().find(|p| p.id.as_str() == pid) {
            ids.insert(patch.entry.to_string());
        }
    }
    Ok(ids.into_iter().collect())
}

/// The calls whose checkpoint has to find a record in the book (with the
/// arguments below, which name every kind of record).
const LOOKUPS: &[&str] = &[
    "asset.move",
    "asset.rename",
    "asset.restore",
    "asset.trash",
    "asset_folder.move",
    "asset_folder.rename",
    "asset_folder.restore",
    "asset_folder.trash",
    "comment.reanchor",
    "comment.update",
    "entry.set_level",
    "entry_history.restore",
    "relation_row.add_entry",
    "relation_row.remove_entry",
    "relation_row.delete",
    "relation_type.set_direction",
    "relation_type.delete",
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

    // Records to name: entries, a patch, relation rows, and memberships.
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
    let second_row = RelationId::new_v7();
    {
        use dr_model::v3::{EntryId, RelationSide};
        let h = ws.library().open_doc(&doc, OpenDoc::Existing).unwrap();
        let (book, id, ty) = (
            book.clone(),
            second_row.clone(),
            relation.relation_type.clone(),
        );
        let (left, right) = (
            EntryId::parse(&character).unwrap(),
            EntryId::parse(&chapter).unwrap(),
        );
        h.write(Origin::User, move |d| {
            let b = BorrowedBookV3::new(d, &book).unwrap();
            b.txn()
                .relation_row(&id)
                .unwrap()
                .relation_type(&ty)
                .unwrap()
                .member(RelationSide::Left, &left)
                .unwrap()
                .member(RelationSide::Right, &right)
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
            "book": book, "id": id, "template": template, "level": false,
            "host": membership.host.to_string(), "member": membership.member.to_string(),
            "lane": chapter, "entry": character, "owner": chapter,
            "left": chapter, "right": character,
            "other": {"kind": "material", "id": "synthetic-material"},
            "targets": [
                {"collection": "entries", "id": character},
                {"collection": "memberships", "id": membership_key},
                {"collection": "patches", "id": patch},
                {"collection": "plot_grids", "id": format!("{chapter}/synthetic-grid")},
                {"collection": "relations", "id": relation.id.to_string()},
                {"collection": "relations", "id": second_row.to_string()},
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
            everything(json!(second_row.to_string()), true),
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
    assert!(names.len() >= 48, "{names:?}");
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
            if n == 1 && !name.starts_with("layout.") {
                assert_eq!(looks_up, LOOKUPS.contains(&name.as_str()), "{name}");
            }
            if n == 0 {
                assert!(!looks_up, "{name}, arguments {n}");
            }
            if n == 6 {
                assert_eq!(
                    looks_up,
                    matches!(
                        name.as_str(),
                        "relation_row.add_entry"
                            | "relation_row.remove_entry"
                            | "relation_row.delete"
                            | "relation_type.set_direction"
                            | "relation_type.delete"
                            | "comment.update"
                            | "comment.reanchor"
                            | "asset.rename"
                            | "asset.move"
                            | "asset.trash"
                            | "asset.restore"
                            | "asset_folder.rename"
                            | "asset_folder.move"
                            | "asset_folder.trash"
                            | "asset_folder.restore"
                    ),
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
            &call("relation_row.delete", json!({"id": second_row.to_string()}))
        )
        .unwrap(),
        both,
        "a relation row write checkpoints its member entries"
    );
    let ends: Vec<_> = relation
        .left
        .union(&relation.right)
        .map(ToString::to_string)
        .collect();
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

    // Turning off an entry's level switch checkpoints the entry and every live
    // descendant (including grandchildren), excluding already-trashed children;
    // turning it on neither loads the book nor checkpoints children.
    let parent_level = out(
        "entry.create",
        json!({"book": book, "title": "Synthetic container", "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let live_child = out(
        "entry.create",
        json!({"book": book, "parent": parent_level, "title": "Synthetic live child", "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let trashed_child = out(
        "entry.create",
        json!({"book": book, "parent": parent_level, "title": "Synthetic trashed child"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let grandchild = out(
        "entry.create",
        json!({"book": book, "parent": live_child, "title": "Synthetic grandchild"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out("entry.trash", json!({"book": book, "id": trashed_child}));
    let on_call = call(
        "entry.set_level",
        json!({"id": parent_level, "level": true}),
    );
    assert!(Named::of(&on_call).lookups.is_empty());
    assert_eq!(
        entries(&ws, &key, &on_call).unwrap(),
        vec![parent_level.clone()]
    );
    let off_call = call(
        "entry.set_level",
        json!({"id": parent_level, "level": false}),
    );
    assert!(!Named::of(&off_call).lookups.is_empty());
    let mut expected_off = vec![parent_level.clone(), live_child.clone(), grandchild.clone()];
    expected_off.sort();
    let actual_off = entries(&ws, &key, &off_call).unwrap();
    assert_eq!(actual_off, expected_off);
    assert!(!actual_off.contains(&trashed_child));

    // Comment creation on an entry selects that entry directly without loading
    // the book; updating that comment looks up and selects the entry.
    let c_create = call(
        "comment.create",
        json!({"target": {"kind": "entry", "id": character}, "body": "Synthetic comment"}),
    );
    assert!(Named::of(&c_create).lookups.is_empty());
    assert_eq!(
        entries(&ws, &key, &c_create).unwrap(),
        vec![character.clone()]
    );
    let cid = out(
        "comment.create",
        json!({"book": book, "target": {"kind": "entry", "id": character}, "body": "Synthetic comment"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let c_update = call("comment.update", json!({"id": cid, "status": "resolved"}));
    assert!(!Named::of(&c_update).lookups.is_empty());
    assert_eq!(
        entries(&ws, &key, &c_update).unwrap(),
        vec![character.clone()]
    );
    ws.close();
}
