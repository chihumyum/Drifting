//! The release identity is the release workflow's alone (F7's hand-over;
//! `docs/rust-rewrite/foundations/f7-platform.md`).
//!
//! dr-platform's `release-identity` feature makes `Identity::current()` the
//! 0.1 client's identity: its bundle id, keychain items, `drifting:` links
//! and data folder. A development build or a test run with it would touch an
//! installed Drifting's data, so:
//!
//! - **Manifests** (`cargo metadata`): no member's `default` feature turns it
//!   on; no member asks dr-platform for it in any dependency, dev-dependencies
//!   included (`cargo test --workspace` unifies their features into every
//!   test); only the app (`drifting`) has a feature that forwards it, and that
//!   feature turns on neither the debug bridge nor hot reload, nor they it.
//!   (A build that has both does not compile either: dr-debug-bridge and the
//!   app assert `!RELEASE_BUILD`.)
//! - **CI and `cargo xtask dev`**: no workflow but a release one
//!   (`.github/workflows/release*.yml`) and not the dev launcher mention it.
//! - **Binaries**: `cargo xtask check-binary <file>…` fails on an executable
//!   with the release identity's marker; with `--release-identity` it
//!   requires that marker and refuses the development one. With
//!   `--precompiled-shaders` it also requires GPUI's precompiled Metal
//!   shaders (macOS executables: the release build is built without the
//!   app's `runtime-shaders` default feature).

use std::path::Path;

use super::Outcome;
use super::debug_bridge::default_closure;
use super::metadata::{Metadata, Package};
use crate::repo::Repo;

pub const PLATFORM: &str = "dr-platform";
pub const FEATURE: &str = "release-identity";
/// The one member that may forward the feature: the app.
pub const APP: &str = "drifting";
/// What a development build's executable carries
/// (`dr_platform::identity::DEVELOPMENT_MARKER`).
pub const DEVELOPMENT_MARKER: &str = "drifting-build-identity:development";
/// What only a release-identity build's executable carries
/// (`dr_platform::identity::RELEASE_MARKER`).
pub const RELEASE_MARKER: &str = "drifting-build-identity:release";
/// GPUI's error context when it compiles the Metal shaders at run time
/// (`gpui_apple`'s `metal_renderer.rs`, `runtime_shaders`).
pub const RUNTIME_SHADERS_MARKER: &str = "building Metal library";
/// Its context when it loads the precompiled library instead.
pub const PRECOMPILED_SHADERS_MARKER: &str = "loading Metal library";
/// The workflows that may build the release identity.
const RELEASE_WORKFLOW_PREFIX: &str = "release";

pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let meta = Metadata::load(repo)?;
    let mut o = Outcome::default();
    check_manifests(&meta, &mut o);
    let workflows = check_workflows(&repo.root.join(".github/workflows"), &mut o)?;
    check_text(
        &repo.next.join("xtask/src/dev.rs"),
        "cargo xtask dev runs the development identity",
        &mut o,
    )?;
    o.summary = format!(
        "{} members never turn the release identity on by default or in a dependency; {workflows} CI workflows never ask for it",
        meta.members().count()
    );
    Ok(o)
}

/// Whether a feature-table entry turns dr-platform's release identity on:
/// `dr-platform/release-identity` or `dr-platform?/release-identity`.
fn enables_platform(entry: &str) -> bool {
    entry
        .split_once('/')
        .is_some_and(|(dep, f)| dep.trim_end_matches('?') == PLATFORM && f == FEATURE)
}

/// The features `feature` turns on in `p`, transitively (itself included).
fn closure(p: &Package, feature: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut stack = vec![feature.to_string()];
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
    let mut platform_has_it = false;
    for m in meta.members() {
        if m.name == PLATFORM {
            platform_has_it = m.features.contains_key(FEATURE);
            if default_closure(m).iter().any(|f| f == FEATURE) {
                o.fail(format!(
                    "{PLATFORM}'s default features turn on {FEATURE}; it must stay opt-in"
                ));
            }
            continue;
        }
        for d in &m.dependencies {
            if d.name == PLATFORM && d.features.iter().any(|f| f == FEATURE) {
                o.fail(format!(
                    "{} asks {PLATFORM} for {FEATURE} in a {} dependency; only the app's own `{FEATURE}` feature may",
                    m.name,
                    d.kind.as_deref().unwrap_or("normal")
                ));
            }
        }
        let forwarding: Vec<&String> = m
            .features
            .iter()
            .filter(|(_, entries)| entries.iter().any(|e| enables_platform(e)))
            .map(|(name, _)| name)
            .collect();
        if m.name != APP && !forwarding.is_empty() {
            o.fail(format!(
                "{}'s feature {} turns on {PLATFORM}/{FEATURE}; only the app forwards it",
                m.name, forwarding[0]
            ));
        }
        if let Some(on) = default_closure(m)
            .iter()
            .find(|f| enables_platform(f) || (m.name == APP && *f == FEATURE))
        {
            o.fail(format!(
                "{}'s default features turn on the release identity ({on}); it must stay opt-in",
                m.name
            ));
        }
        if m.name == APP {
            for (a, b) in [
                (FEATURE, "debug-bridge"),
                (FEATURE, "hot-reload"),
                ("debug-bridge", FEATURE),
                ("hot-reload", FEATURE),
            ] {
                if m.features.contains_key(a) && closure(m, a).iter().any(|f| f == b) {
                    o.fail(format!(
                        "{APP}'s `{a}` feature turns on `{b}`: the release identity never comes with the debug bridge or hot reload"
                    ));
                }
            }
        }
    }
    if !platform_has_it {
        o.fail(format!(
            "{PLATFORM} has no `{FEATURE}` feature: the release workflow builds with it"
        ));
    }
}

/// Every workflow but the release ones: none mentions the release identity
/// (`release-identity`, `-ReleaseIdentity`). How many were read.
fn check_workflows(dir: &Path, o: &mut Outcome) -> Result<usize, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    };
    let mut n = 0;
    for e in entries {
        let path = e.map_err(|e| e.to_string())?.path();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if path.is_dir() || name.starts_with(RELEASE_WORKFLOW_PREFIX) {
            continue;
        }
        check_text(&path, "CI builds the development identity", o)?;
        n += 1;
    }
    Ok(n)
}

fn check_text(path: &Path, why: &str, o: &mut Outcome) -> Result<(), String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    for needle in [FEATURE, "ReleaseIdentity"] {
        if text.contains(needle) {
            o.fail(format!("{} mentions {needle}: {why}", path.display()));
        }
    }
    Ok(())
}

/// What `check-binary` expects of the files besides the bridge and hot
/// reload.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Expect {
    /// The release identity's marker, and not the development one. Without
    /// it, the release identity's marker fails the file.
    pub release_identity: bool,
    /// GPUI's precompiled Metal shaders, not the run-time compiled ones.
    pub precompiled_shaders: bool,
}

fn contains(bytes: &[u8], needle: &str) -> bool {
    let needle = needle.as_bytes();
    bytes.windows(needle.len()).any(|w| w == needle)
}

/// `cargo xtask check-binary [--release-identity] [--precompiled-shaders]
/// <file>…`: the identity and shader checks. Returns the failures.
pub fn check_binaries(files: &[String], expect: Expect) -> Result<Vec<String>, String> {
    let mut failures = Vec::new();
    for f in files {
        let bytes = std::fs::read(f).map_err(|e| format!("{f}: {e}"))?;
        let release = contains(&bytes, RELEASE_MARKER);
        let development = contains(&bytes, DEVELOPMENT_MARKER);
        if expect.release_identity {
            if !release {
                failures.push(format!(
                    "{f} has no {RELEASE_MARKER}: not built with the release identity"
                ));
            }
            if development {
                failures.push(format!(
                    "{f} contains {DEVELOPMENT_MARKER}: built with the development identity"
                ));
            }
        } else if release {
            failures.push(format!(
                "{f} contains {RELEASE_MARKER}: the release identity is built in (pass --release-identity for the release build)"
            ));
        }
        if expect.precompiled_shaders {
            if contains(&bytes, RUNTIME_SHADERS_MARKER) {
                failures.push(format!(
                    "{f} compiles GPUI's Metal shaders at run time (\"{RUNTIME_SHADERS_MARKER}\"): build without the app's default features"
                ));
            }
            if !contains(&bytes, PRECOMPILED_SHADERS_MARKER) {
                failures.push(format!(
                    "{f} has no precompiled Metal shaders (\"{PRECOMPILED_SHADERS_MARKER}\"); a macOS executable is expected"
                ));
            }
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

    fn platform() -> serde_json::Value {
        package(
            PLATFORM,
            json!({ "default": ["network"], "network": [], FEATURE: [] }),
            json!([]),
        )
    }

    fn uses_platform(features: &[&str], kind: Option<&str>) -> serde_json::Value {
        json!([{ "name": PLATFORM, "kind": kind, "optional": false, "features": features }])
    }

    fn failures(packages: serde_json::Value) -> Vec<String> {
        let mut o = Outcome::default();
        check_manifests(&meta(packages), &mut o);
        o.failures
    }

    #[test]
    fn the_markers_are_dr_platforms() {
        assert_eq!(
            DEVELOPMENT_MARKER,
            dr_platform::identity::DEVELOPMENT_MARKER
        );
        assert_eq!(RELEASE_MARKER, dr_platform::identity::RELEASE_MARKER);
        // xtask's tests are a development build.
        assert_eq!(dr_platform::identity::BUILD_MARKER, DEVELOPMENT_MARKER);
    }

    #[test]
    fn only_the_apps_own_feature_turns_the_release_identity_on() {
        let app = package(
            APP,
            json!({
                "default": ["runtime-shaders"],
                "runtime-shaders": [],
                FEATURE: ["dr-platform/release-identity"],
                "debug-bridge": [],
                "hot-reload": ["gpui/hot-reload"],
            }),
            uses_platform(&[], None),
        );
        let shell = package("dr-shell", json!({}), uses_platform(&[], Some("dev")));
        assert!(failures(json!([platform(), app.clone(), shell])).is_empty());

        // On by default, in the app or in dr-platform.
        let on = package(
            APP,
            json!({ "default": ["release"], "release": [FEATURE], FEATURE: ["dr-platform/release-identity"] }),
            uses_platform(&[], None),
        );
        let f = failures(json!([platform(), on]));
        assert_eq!(f.len(), 1, "{f:?}");
        assert!(f[0].contains("default features"));
        let platform_on = package(
            PLATFORM,
            json!({ "default": [FEATURE], FEATURE: [] }),
            json!([]),
        );
        assert_eq!(failures(json!([platform_on, app.clone()])).len(), 1);

        // Asked for in a dependency, dev-dependencies too.
        for kind in [None, Some("dev"), Some("build")] {
            let asks = package("dr-shell", json!({}), uses_platform(&[FEATURE], kind));
            assert_eq!(
                failures(json!([platform(), app.clone(), asks])).len(),
                1,
                "{kind:?}"
            );
        }

        // Forwarded by another crate.
        let forwards = package(
            "dr-shell",
            json!({ "release": ["dr-platform?/release-identity"] }),
            uses_platform(&[], None),
        );
        assert_eq!(
            failures(json!([platform(), app.clone(), forwards])).len(),
            1
        );

        // dr-platform without the feature.
        let bare = package(PLATFORM, json!({ "default": [] }), json!([]));
        assert_eq!(failures(json!([bare, app])).len(), 1);
    }

    #[test]
    fn the_release_identity_never_comes_with_the_bridge_or_hot_reload() {
        for (feature, entries) in [
            (
                FEATURE,
                json!(["dr-platform/release-identity", "debug-bridge"]),
            ),
            (
                FEATURE,
                json!(["dr-platform/release-identity", "hot-reload"]),
            ),
        ] {
            let app = package(
                APP,
                json!({ feature: entries, "debug-bridge": [], "hot-reload": [] }),
                uses_platform(&[], None),
            );
            assert_eq!(failures(json!([platform(), app])).len(), 1);
        }
        let app = package(
            APP,
            json!({ FEATURE: ["dr-platform/release-identity"], "debug-bridge": [FEATURE] }),
            uses_platform(&[], None),
        );
        assert_eq!(failures(json!([platform(), app])).len(), 1);
    }

    #[test]
    fn ci_and_the_dev_launcher_never_ask_for_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("next.yml"), "cargo build -p drifting\n").unwrap();
        std::fs::write(
            dir.path().join("release-next.yml"),
            "script/bundle-mac --dist --release-identity\n",
        )
        .unwrap();
        let mut o = Outcome::default();
        assert_eq!(check_workflows(dir.path(), &mut o).unwrap(), 1);
        assert!(o.failures.is_empty(), "{:?}", o.failures);
        std::fs::write(
            dir.path().join("ci.yml"),
            "script/bundle-windows.ps1 -ReleaseIdentity\n",
        )
        .unwrap();
        check_workflows(dir.path(), &mut o).unwrap();
        assert_eq!(o.failures.len(), 1, "{:?}", o.failures);
        let dev = dir.path().join("dev.rs");
        std::fs::write(&dev, "\"--features\", \"release-identity\"").unwrap();
        check_text(&dev, "dev", &mut o).unwrap();
        assert_eq!(o.failures.len(), 2);
    }

    #[test]
    fn binaries_say_which_identity_and_shaders_they_carry() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, parts: &[&str]| {
            let path = dir.path().join(name);
            let mut bytes = b"\x7fELF\x00".to_vec();
            for p in parts {
                bytes.extend_from_slice(p.as_bytes());
                bytes.push(0);
            }
            std::fs::write(&path, bytes).unwrap();
            path.to_string_lossy().into_owned()
        };
        let dev = write("dev", &[DEVELOPMENT_MARKER, RUNTIME_SHADERS_MARKER]);
        let release = write("release", &[RELEASE_MARKER, PRECOMPILED_SHADERS_MARKER]);
        let release_runtime = write("release-runtime", &[RELEASE_MARKER, RUNTIME_SHADERS_MARKER]);
        let none = write("none", &[]);
        let plain = Expect::default();
        let shipped = Expect {
            release_identity: true,
            precompiled_shaders: true,
        };
        assert!(
            check_binaries(&[dev.clone(), none.clone()], plain)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            check_binaries(std::slice::from_ref(&release), plain)
                .unwrap()
                .len(),
            1
        );
        assert!(
            check_binaries(std::slice::from_ref(&release), shipped)
                .unwrap()
                .is_empty()
        );
        // The development build, a file with no marker, run-time shaders.
        assert_eq!(check_binaries(&[dev], shipped).unwrap().len(), 4);
        assert_eq!(check_binaries(&[none], shipped).unwrap().len(), 2);
        assert_eq!(
            check_binaries(&[release_runtime], shipped).unwrap().len(),
            2
        );
        assert!(
            check_binaries(
                &[dir.path().join("missing").to_string_lossy().into_owned()],
                plain
            )
            .is_err()
        );
    }
}
