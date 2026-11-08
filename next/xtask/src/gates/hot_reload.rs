//! GPUI's hot reload stays out of release builds, as the debug bridge does
//! (`debug_bridge`).
//!
//! GPUI patches code only in debug builds (its build script sets
//! `gpui_hot_reload` when the `hot-reload` feature is on and debug
//! assertions are), and only under `dx serve --hot-patch`. Still, the
//! feature pulls dx's patch transport into the build, so it is kept to
//! `cargo xtask dev --hot`:
//!
//! - **Manifests** (`cargo metadata`): no member asks for `gpui/hot-reload`
//!   in a normal or build dependency, and no member's `default` feature
//!   turns it on (the app's own `hot-reload` feature is the way in).
//! - **No cycle through dev-dependencies**: dx recompiles a changed crate
//!   and every workspace crate that depends on it, dev-dependencies
//!   included, in the order of that graph, and stops at a cycle ("Cycle in
//!   workspace dependency graph — cannot determine replay order"). Cargo
//!   allows a crate's tests to depend on a crate that depends on it; this
//!   gate does not.
//! - **Release scripts**: nothing under `next/script/` mentions
//!   `hot-reload` or `dx serve`.
//! - **Binaries**: `cargo xtask check-binary <file>…` also fails when a
//!   built executable carries GPUI's hot reload ([`MARKER`], a sentence of
//!   its log that only a patching build has).

use super::Outcome;
use super::debug_bridge::{RELEASE_SCRIPTS, default_closure, scan_scripts};
use super::metadata::Metadata;
use crate::repo::Repo;

pub const GPUI: &str = "gpui";
pub const FEATURE: &str = "hot-reload";
/// In every build GPUI patches (`crates/gpui/src/hot_reload.rs` logs it),
/// in no other.
pub const MARKER: &str = "GPUI hot reload";

pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let meta = Metadata::load(repo)?;
    let mut o = Outcome::default();
    check_manifests(&meta, &mut o);
    check_acyclic(&meta, &mut o);
    let scripts = scan_scripts(
        &repo.root.join(RELEASE_SCRIPTS),
        &[FEATURE, "dx serve"],
        "release builds never hot-reload",
        &mut o,
    )?;
    o.summary = format!(
        "{} members never build GPUI's hot reload by default, no dependency cycle; {scripts} release scripts never ask for it",
        meta.members().count()
    );
    Ok(o)
}

/// Whether a feature-table entry turns GPUI's hot reload on:
/// `gpui/hot-reload` or `gpui?/hot-reload`.
fn enables_hot_reload(entry: &str) -> bool {
    entry
        .split_once('/')
        .is_some_and(|(dep, f)| dep.trim_end_matches('?') == GPUI && f == FEATURE)
}

pub fn check_manifests(meta: &Metadata, o: &mut Outcome) {
    for m in meta.members() {
        for d in &m.dependencies {
            if d.name == GPUI
                && d.kind.as_deref() != Some("dev")
                && d.features.iter().any(|f| f == FEATURE)
            {
                o.fail(format!(
                    "{} asks gpui for {FEATURE} unconditionally; put it behind a `{FEATURE}` feature",
                    m.name
                ));
            }
        }
        let on = default_closure(m);
        if let Some(f) = on.iter().find(|f| enables_hot_reload(f)) {
            o.fail(format!(
                "{}'s default features turn on GPUI's hot reload ({f}); it must stay opt-in",
                m.name
            ));
        }
    }
}

/// The workspace's dependency graph, every kind of dependency counted, has
/// no cycle; one failure per cycle found, naming its members.
pub fn check_acyclic(meta: &Metadata, o: &mut Outcome) {
    use std::collections::{BTreeMap, BTreeSet};
    let members: BTreeSet<&str> = meta.members().map(|m| m.name.as_str()).collect();
    let edges: BTreeMap<&str, Vec<&str>> = meta
        .members()
        .map(|m| {
            let mut to: Vec<&str> = m
                .dependencies
                .iter()
                .map(|d| d.name.as_str())
                .filter(|d| members.contains(d))
                .collect();
            to.sort_unstable();
            to.dedup();
            (m.name.as_str(), to)
        })
        .collect();
    // Depth first; 1 = on the path, 2 = done.
    let mut state: BTreeMap<&str, u8> = BTreeMap::new();
    let mut path: Vec<&str> = Vec::new();
    fn visit<'a>(
        n: &'a str,
        edges: &BTreeMap<&'a str, Vec<&'a str>>,
        state: &mut BTreeMap<&'a str, u8>,
        path: &mut Vec<&'a str>,
        o: &mut Outcome,
    ) {
        state.insert(n, 1);
        path.push(n);
        for &next in edges.get(n).into_iter().flatten() {
            match state.get(next) {
                Some(1) => {
                    let from = path.iter().position(|p| *p == next).unwrap_or(0);
                    let mut cycle: Vec<&str> = path[from..].to_vec();
                    cycle.push(next);
                    o.fail(format!(
                        "dependency cycle (dev-dependencies count): {}; dx's hot patching cannot order it, move the test or example that needs it into the crate at the other end",
                        cycle.join(" → ")
                    ));
                }
                Some(_) => {}
                None => visit(next, edges, state, path, o),
            }
        }
        path.pop();
        state.insert(n, 2);
    }
    for &m in &members {
        if !state.contains_key(m) {
            visit(m, &edges, &mut state, &mut path, o);
        }
    }
}

/// Which workspace crates dx can hot-patch in the app `tip` builds: a
/// changed crate is recompiled together with every workspace crate that
/// depends on it (dev-dependencies too), each with the arguments the first
/// build recorded, so all of those must be built into the app. Returns the
/// crates that can be patched, and for the others the crates outside the
/// app that stand in the way.
pub fn patchable(meta: &Metadata, tip: &str) -> (Vec<String>, Vec<(String, Vec<String>)>) {
    use std::collections::{BTreeMap, BTreeSet};
    let id_of: BTreeMap<&str, &str> = meta
        .members()
        .map(|m| (m.name.as_str(), m.id.as_str()))
        .collect();
    let members: BTreeSet<&str> = id_of.keys().copied().collect();
    // What the app builds: normal and build dependencies from the tip.
    let mut app: BTreeSet<&str> = BTreeSet::new();
    let mut stack: Vec<&str> = id_of.get(tip).copied().into_iter().collect();
    while let Some(id) = stack.pop() {
        for e in meta.edges.get(id).into_iter().flatten() {
            if (e.normal || e.build) && !app.contains(e.to.as_str()) {
                app.insert(e.to.as_str());
                stack.push(e.to.as_str());
            }
        }
    }
    let in_app = |name: &str| id_of.get(name).is_some_and(|id| app.contains(id));
    // Who depends on whom among the members, every kind counted.
    let mut dependents: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for m in meta.members() {
        for d in m
            .dependencies
            .iter()
            .filter(|d| members.contains(d.name.as_str()))
        {
            dependents
                .entry(d.name.as_str())
                .or_default()
                .insert(m.name.as_str());
        }
    }
    let (mut ok, mut blocked) = (Vec::new(), Vec::new());
    for &c in members.iter().filter(|c| **c != tip && in_app(c)) {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        let mut stack = vec![c];
        while let Some(x) = stack.pop() {
            for &y in dependents.get(x).into_iter().flatten() {
                if y != tip && seen.insert(y) {
                    stack.push(y);
                }
            }
        }
        let outside: Vec<String> = seen
            .into_iter()
            .filter(|y| !in_app(y))
            .map(str::to_string)
            .collect();
        if outside.is_empty() {
            ok.push(c.to_string());
        } else {
            blocked.push((c.to_string(), outside));
        }
    }
    (ok, blocked)
}

/// `cargo xtask check-binary`: the files that carry GPUI's hot reload.
pub fn check_binaries(files: &[String]) -> Result<Vec<String>, String> {
    let needle = MARKER.as_bytes();
    let mut failures = Vec::new();
    for f in files {
        let bytes = std::fs::read(f).map_err(|e| format!("{f}: {e}"))?;
        if bytes.windows(needle.len()).any(|w| w == needle) {
            failures.push(format!(
                "{f} contains {MARKER:?}: GPUI's hot reload is built in (a debug build with the {FEATURE} feature)"
            ));
        }
    }
    Ok(failures)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(packages: serde_json::Value) -> Metadata {
        let members: Vec<serde_json::Value> = packages
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].clone())
            .collect();
        Metadata::parse(
            &json!({ "packages": packages, "workspace_members": members, "resolve": { "nodes": [] } }),
            "/w/next",
        )
    }

    fn app(features: serde_json::Value, gpui_features: serde_json::Value) -> serde_json::Value {
        json!({
            "id": "drifting", "name": "drifting", "version": "0.0.0", "license": "AGPL-3.0-or-later",
            "manifest_path": "/w/next/app/drifting/Cargo.toml",
            "features": features,
            "dependencies": [{ "name": "gpui", "kind": null, "optional": false, "features": gpui_features }],
        })
    }

    fn failures(packages: serde_json::Value) -> Vec<String> {
        let mut o = Outcome::default();
        check_manifests(&meta(packages), &mut o);
        o.failures
    }

    #[test]
    fn hot_reload_is_opt_in_only() {
        // The app's own feature, off by default.
        let ok = app(json!({ "hot-reload": ["gpui/hot-reload"] }), json!([]));
        assert!(failures(json!([ok])).is_empty());
        // On by default, through another feature.
        let on = app(
            json!({ "default": ["dev"], "dev": ["hot-reload"], "hot-reload": ["gpui?/hot-reload"] }),
            json!([]),
        );
        let f = failures(json!([on]));
        assert_eq!(f.len(), 1, "{f:?}");
        assert!(f[0].contains("default features"));
        // Asked of gpui directly.
        let direct = app(json!({}), json!(["hot-reload"]));
        assert_eq!(failures(json!([direct])).len(), 1);
        assert!(!enables_hot_reload("dr-ui/hot-reload") && !enables_hot_reload("hot-reload"));
    }

    #[test]
    fn a_cycle_through_a_dev_dependency_fails() {
        let crate_ = |name: &str, deps: serde_json::Value| {
            json!({
                "id": name, "name": name, "version": "0.0.0", "license": "AGPL-3.0-or-later",
                "manifest_path": format!("/w/next/crates/{name}/Cargo.toml"),
                "features": {}, "dependencies": deps,
            })
        };
        let dep = |name: &str, kind: Option<&str>| json!({ "name": name, "kind": kind, "optional": false, "features": [] });
        let store = |dev: serde_json::Value| crate_("dr-store", dev);
        let testkit = crate_("dr-testkit", json!([dep("dr-store", None)]));
        let corpus = crate_("dr-corpus", json!([]));
        let mut o = Outcome::default();
        check_acyclic(
            &meta(json!([
                store(json!([dep("dr-corpus", Some("dev"))])),
                testkit.clone(),
                corpus.clone()
            ])),
            &mut o,
        );
        assert!(o.failures.is_empty(), "{:?}", o.failures);
        let mut o = Outcome::default();
        check_acyclic(
            &meta(json!([
                store(json!([dep("dr-testkit", Some("dev"))])),
                testkit,
                corpus
            ])),
            &mut o,
        );
        assert_eq!(o.failures.len(), 1, "{:?}", o.failures);
        assert!(
            o.failures[0].contains("dr-store → dr-testkit → dr-store"),
            "{}",
            o.failures[0]
        );
    }

    #[test]
    fn only_crates_whose_dependents_are_all_in_the_app_are_patchable() {
        let dep = |name: &str, kind: Option<&str>| json!({ "name": name, "kind": kind, "optional": false, "features": [] });
        let krate = |name: &str, deps: serde_json::Value| {
            json!({
                "id": name, "name": name, "version": "0.0.0", "license": "AGPL-3.0-or-later",
                "manifest_path": format!("/w/next/crates/{name}/Cargo.toml"),
                "features": {}, "dependencies": deps,
            })
        };
        let node = |id: &str, to: &[&str]| json!({ "id": id, "deps": to.iter().map(|t| json!({ "pkg": t, "dep_kinds": [{ "kind": null }] })).collect::<Vec<_>>() });
        let packages = json!([
            krate("app", json!([dep("view", None)])),
            krate("view", json!([dep("store", None)])),
            krate("store", json!([])),
            krate("tool", json!([dep("store", None)])),
        ]);
        let members: Vec<serde_json::Value> = ["app", "view", "store", "tool"]
            .iter()
            .map(|n| json!(n))
            .collect();
        let meta = Metadata::parse(
            &json!({
                "packages": packages, "workspace_members": members,
                "resolve": { "nodes": [node("app", &["view"]), node("view", &["store"]), node("store", &[]), node("tool", &["store"])] },
            }),
            "/w/next",
        );
        let (ok, blocked) = patchable(&meta, "app");
        assert_eq!(ok, vec!["view".to_string()]);
        assert_eq!(
            blocked,
            vec![("store".to_string(), vec!["tool".to_string()])]
        );
    }

    #[test]
    fn binaries_with_the_patch_transport_fail() {
        let dir = tempfile::tempdir().unwrap();
        let clean = dir.path().join("clean.bin");
        let built = dir.path().join("built.bin");
        std::fs::write(&clean, b"\x7fELF nothing here").unwrap();
        let mut bytes = b"\x00\x01".to_vec();
        bytes.extend_from_slice(b"GPUI hot reload applied");
        std::fs::write(&built, bytes).unwrap();
        let s = |p: &std::path::Path| p.to_string_lossy().into_owned();
        assert!(check_binaries(&[s(&clean)]).unwrap().is_empty());
        assert_eq!(check_binaries(&[s(&clean), s(&built)]).unwrap().len(), 1);
    }
}
