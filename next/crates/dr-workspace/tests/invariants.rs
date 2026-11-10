//! Canonical command sequences, faults, reopen and independent-device convergence.
mod common;
use common::*;
use dr_workspace::{Actor, Workspace};
use loro::ExportMode;
use proptest::prelude::*;
use serde_json::{Value, json};
fn snapshot(e: &Env, b: &str) -> Value {
    e.out("entry.list", json!({"book":b,"all":true,"trashed":true}))
}
fn check(e: &Env, b: &str) {
    let rows = snapshot(e, b);
    let rows = rows.as_array().unwrap();
    let ids: std::collections::BTreeSet<_> =
        rows.iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), rows.len());
    for e1 in rows.iter().filter(|e| e["template"] == "tpl-chapter") {
        let id = e1["id"].as_str().unwrap();
        let doc = e
            .ws()
            .library()
            .doc_info(&format!("body:{id}/mod-prose"))
            .unwrap()
            .expect("entry body is registered before book commit");
        assert_eq!(doc.book_id.as_deref(), Some(b));
    }
    // No damaged template/module/structure read may panic after a merge.
    e.out("entry_template.list", json!({"book":b}));
    e.out("level.list", json!({"book":b}));
    e.out("comment.list", json!({"book":b}));
}
fn run(e: &mut Env, b: &str, op: (u8, u8)) {
    let (kind, n) = op;
    let rows = snapshot(e, b);
    let leaves: Vec<_> = rows
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["template"] == "tpl-chapter")
        .collect();
    let id = (!leaves.is_empty()).then(|| leaves[n as usize % leaves.len()]["id"].clone());
    match kind % 10 {
        0 | 1 => {
            acceptance::novel_entry(
                e.ws(),
                b,
                "tpl-chapter",
                &format!("Entry {n}"),
                Some("Synthetic text"),
            );
        }
        2 => {
            if let Some(id) = id {
                let _ = e.try_call(
                    "entry.update",
                    json!({"book":b,"id":id,"title":format!("Rename {n}")}),
                );
            }
        }
        3 => {
            if let Some(id) = id {
                let _ = e.try_call("entry.trash", json!({"book":b,"id":id}));
            }
        }
        4 => {
            if let Some(id) = id {
                let _ = e.try_call("entry.restore", json!({"book":b,"id":id}));
            }
        }
        5 => {
            if let Some(id) = id {
                let _=e.try_call("module.set_field",json!({"book":b,"entry":id,"module":"mod-fields","field":"summary","value":format!("Value {n}")}));
            }
        }
        6 => {
            let _ = e.ws().undo(&Actor::User);
        }
        7 => {
            let _ = e.ws().redo(&Actor::User);
        }
        8 => {
            let before = snapshot(e, b);
            e.reopen();
            assert_eq!(snapshot(e, b), before);
        }
        _ => {
            let before = snapshot(e, b);
            e.faults.arm("after_prose");
            assert!(e.try_call("entry.create",json!({"book":b,"parent":acceptance::novel_root(e.ws(),&b,"tpl-manuscript"),"template":"tpl-chapter","title":"Fault","bodies":{"mod-prose":"Synthetic text"}})).is_err());
            e.faults.disarm();
            assert_eq!(snapshot(e, b), before);
        }
    }
    check(e, b);
}
fn sync(from: &Workspace, to: &Workspace) {
    let mut docs = from.library().docs(None, None).unwrap();
    docs.sort_by_key(|d| (d.kind != "book", d.doc_id.clone()));
    for d in docs {
        if from.library().head(&d.doc_id).unwrap().is_none() {
            continue;
        }
        let bytes = from
            .library()
            .load_copy(&d.doc_id)
            .unwrap()
            .export(ExportMode::all_updates())
            .unwrap();
        to.import_remote(
            &d.doc_id,
            Some((&d.kind, d.book_id.as_deref().unwrap_or(""))),
            bytes,
            &Actor::Sync,
        )
        .unwrap();
    }
}
fn cases() -> u32 {
    std::env::var("DR_PROP_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(16)
}
proptest! {
    #![proptest_config(ProptestConfig {cases:cases(),..ProptestConfig::default()})]
    #[test]
    fn random_commands_keep_the_invariants(ops in prop::collection::vec((0u8..10,any::<u8>()),1..36)) {
        let mut e=env();let b=e.book();
        for op in ops {run(&mut e,&b,op);}
        let before=snapshot(&e,&b);e.reopen();prop_assert_eq!(snapshot(&e,&b),before);check(&e,&b);
    }
    #[test]
    fn two_devices_merge_into_one_readable_book(a_ops in prop::collection::vec((0u8..5,any::<u8>()),1..24),b_ops in prop::collection::vec((0u8..5,any::<u8>()),1..24)) {
        let mut a=env();let mut z=env();let b=a.book();acceptance::novel_entry(a.ws(),&b,"tpl-chapter","Shared",Some("Synthetic text"));sync(a.ws(),z.ws());
        for op in a_ops {run(&mut a,&b,op);}for op in b_ops {run(&mut z,&b,op);}
        sync(a.ws(),z.ws());sync(z.ws(),a.ws());sync(a.ws(),z.ws());
        prop_assert_eq!(snapshot(&a,&b),snapshot(&z,&b));check(&a,&b);check(&z,&b);
    }
}
#[test]
fn concurrent_creates_of_one_name_are_flagged_not_lost() {
    let a = env();
    let z = env();
    let b = a.book();
    sync(a.ws(), z.ws());
    let one = acceptance::novel_entry(a.ws(), &b, "tpl-character", "Twin", None)["id"].clone();
    let two = acceptance::novel_entry(z.ws(), &b, "tpl-character", "Twin", None)["id"].clone();
    sync(a.ws(), z.ws());
    sync(z.ws(), a.ws());
    let rows = snapshot(&a, &b);
    let twins: Vec<_> = rows
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["id"] == one || e["id"] == two)
        .collect();
    assert_eq!(twins.len(), 2);
    assert!(twins.iter().any(|e| !e["name_conflict"].is_null()));
    assert_eq!(snapshot(&a, &b), snapshot(&z, &b));
}
#[test]
fn regression_shutdown_during_the_index_rebuild() {
    for _ in 0..20 {
        let mut e = env();
        let b = e.book();
        acceptance::novel_entry(e.ws(), &b, "tpl-chapter", "Close", Some("Synthetic text"));
        e.ws().undo(&Actor::User).unwrap();
        e.reopen();
        check(&e, &b);
    }
}
