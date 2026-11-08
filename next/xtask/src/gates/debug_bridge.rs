//! The debug bridge stays out of release builds (simplifications.md §6,
//! rule 9).
//!
//! - **Manifests** (`cargo metadata`): no member has a normal or build
//!   dependency on `dr-debug-bridge` that is not optional, and no member's
//!   `default` feature turns one on. The app reaches it only through its
//!   `debug-bridge` feature, which `cargo xtask dev --debug-bridge` asks
//!   for.
//! - **Release scripts**: nothing under `next/script/` (the bundles and the
//!   release workflow draft) mentions the feature.
//! - **Binaries**: `cargo xtask check-binary <file>…` fails when a built
//!   executable contains the bridge's protocol name
//!   ([`dr_debug_protocol::PROTOCOL`]); CI runs it on the bundle it builds.

use std::path::Path;

use super::Outcome;
use super::metadata::{Metadata, Package};
use crate::repo::Repo;

pub const BRIDGE: &str = "dr-debug-bridge";
pub const FEATURE: &str = "debug-bridge";
/// Where the release builds are made from.
pub const RELEASE_SCRIPTS: &str = "next/script";

pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let meta = Metadata::load(repo)?;
    let mut o = Outcome::default();
    check_manifests(&meta, &mut o);
    let scripts = check_scripts(&repo.root.join(RELEASE_SCRIPTS), &mut o)?;
    o.summary = format!(
        "{} members never build the bridge by default; {scripts} release scripts never ask for it",
        meta.members().count()
    );
    Ok(o)
}

/// Whether a feature-table entry turns the bridge on: `dep:dr-debug-bridge`,
/// `dr-debug-bridge`, `dr-debug-bridge/…` or `dr-debug-bridge?/…`.
fn enables_bridge(entry: &str) -> bool {
    let name = entry.strip_prefix("dep:").unwrap_or(entry);
    let name = name.split('/').next().unwrap_or(name);
    name.trim_end_matches('?') == BRIDGE
}

/// The features `default` turns on in `p`, transitively.
pub(crate) fn default_closure(p: &Package) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut stack = vec!["default".to_string()];
    while let Some(f) = stack.pop() {
        if seen.contains(&f) {
            continue;
        }
        if let Some(entries) = p.features.get(&f) {
            stack.extend(entries.iter().cloned());
        }
        seen.push(f);
    }
    seen
}

pub fn check_manifests(meta: &Metadata, o: &mut Outcome) {
    for m in meta.members() {
        if m.name == BRIDGE {
            continue;
        }
        for d in &m.dependencies {
            if d.name == BRIDGE && d.kind.as_deref() != Some("dev") && !d.optional {
                o.fail(format!(
                    "{} depends on {BRIDGE} unconditionally; make it optional behind a `{FEATURE}` feature",
                    m.name
                ));
            }
        }
        if let Some(on) = default_closure(m).iter().find(|f| enables_bridge(f)) {
            o.fail(format!(
                "{}'s default features turn on {BRIDGE} ({on}); it must stay opt-in",
                m.name
            ));
        }
    }
}

fn check_scripts(dir: &Path, o: &mut Outcome) -> Result<usize, String> {
    scan_scripts(
        dir,
        &[FEATURE],
        "release builds never carry the debug bridge",
        o,
    )
}

/// Every file under `dir` (the release scripts), failing on any that
/// mentions one of `needles`; how many files were read.
pub(crate) fn scan_scripts(
    dir: &Path,
    needles: &[&str],
    why: &str,
    o: &mut Outcome,
) -> Result<usize, String> {
    let mut n = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = match std::fs::read_dir(&d) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("{}: {e}", d.display())),
        };
        for e in entries {
            let path = e.map_err(|e| e.to_string())?.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            n += 1;
            for needle in needles.iter().filter(|n| text.contains(**n)) {
                o.fail(format!("{} mentions {needle}: {why}", path.display()));
            }
        }
    }
    Ok(n)
}

/// `cargo xtask check-binary <file>…`: none of the files contains the
/// bridge's protocol name. Returns the failures.
pub fn check_binaries(files: &[String]) -> Result<Vec<String>, String> {
    let needle = dr_debug_protocol::PROTOCOL.as_bytes();
    let mut failures = Vec::new();
    for f in files {
        let bytes = std::fs::read(f).map_err(|e| format!("{f}: {e}"))?;
        if bytes.windows(needle.len()).any(|w| w == needle) {
            failures.push(format!(
                "{f} contains {}: the debug bridge is built in",
                dr_debug_protocol::PROTOCOL
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

    fn package(
        name: &str,
        features: serde_json::Value,
        deps: serde_json::Value,
    ) -> serde_json::Value {
        json!({
            "id": name, "name": name, "version": "0.0.0", "license": "AGPL-3.0-or-later",
            "manifest_path": format!("/w/next/crates/{name}/Cargo.toml"),
            "features": features, "dependencies": deps,
        })
    }

    fn failures(packages: serde_json::Value) -> Vec<String> {
        let mut o = Outcome::default();
        check_manifests(&meta(packages), &mut o);
        o.failures
    }

    #[test]
    fn the_bridge_is_opt_in_only() {
        let bridge = package(BRIDGE, json!({ "screenshot": [] }), json!([]));
        let optional = json!([{ "name": BRIDGE, "kind": null, "optional": true, "uses_default_features": true, "features": ["screenshot"] }]);
        let app = package(
            "drifting",
            json!({ "debug-bridge": ["dep:dr-debug-bridge", "dr-debug-bridge/screenshot"] }),
            optional.clone(),
        );
        let client = package(
            "dr-cli",
            json!({}),
            json!([{ "name": "dr-debug-protocol", "kind": null, "optional": false }]),
        );
        assert!(failures(json!([bridge.clone(), app, client])).is_empty());

        // On by default, directly or through another feature.
        let on = package(
            "drifting",
            json!({ "default": ["dev"], "dev": ["debug-bridge"], "debug-bridge": ["dep:dr-debug-bridge"] }),
            optional,
        );
        let f = failures(json!([bridge.clone(), on]));
        assert_eq!(f.len(), 1, "{f:?}");
        assert!(f[0].contains("default features"));

        // A plain dependency.
        let plain = package(
            "dr-shell",
            json!({}),
            json!([{ "name": BRIDGE, "kind": null, "optional": false }]),
        );
        assert_eq!(failures(json!([bridge.clone(), plain])).len(), 1);

        // Tests may use it.
        let dev = package(
            "dr-shell",
            json!({}),
            json!([{ "name": BRIDGE, "kind": "dev", "optional": false }]),
        );
        assert!(failures(json!([bridge, dev])).is_empty());
        assert!(
            enables_bridge("dr-debug-bridge?/screenshot") && !enables_bridge("dr-debug-protocol")
        );
    }

    #[test]
    fn release_scripts_and_binaries_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("bundle-mac"), "cargo build -p drifting\n").unwrap();
        let mut o = Outcome::default();
        assert_eq!(check_scripts(dir.path(), &mut o).unwrap(), 1);
        assert!(o.failures.is_empty());
        std::fs::write(
            dir.path().join("bundle-x"),
            "cargo build --features debug-bridge\n",
        )
        .unwrap();
        check_scripts(dir.path(), &mut o).unwrap();
        assert_eq!(o.failures.len(), 1);

        let clean = dir.path().join("clean.bin");
        let built = dir.path().join("built.bin");
        std::fs::write(&clean, b"\x7fELF nothing here").unwrap();
        let mut bytes = b"\x00\x01".to_vec();
        bytes.extend_from_slice(dr_debug_protocol::PROTOCOL.as_bytes());
        std::fs::write(&built, bytes).unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        assert!(check_binaries(&[s(&clean)]).unwrap().is_empty());
        assert_eq!(check_binaries(&[s(&clean), s(&built)]).unwrap().len(), 1);
        assert!(check_binaries(&[s(&dir.path().join("none"))]).is_err());
    }
}
