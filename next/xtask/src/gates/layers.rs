//! Dependency direction (rule 4), from `cargo metadata`:
//!
//! ```text
//! interface (gpui-prose, dr-editor, dr-ui, dr-shell, dr-view-*)
//!     → application services (dr-workspace, dr-agent, dr-mcp, dr-sync,
//!       dr-export, dr-mirror, dr-import-v1, dr-samples)
//!         → data (dr-model, dr-doc, dr-store, dr-text, dr-corpus)
//! platform (dr-platform, dr-i18n) and tools (dr-testkit, dr-cli, xtask) on the side
//! ```
//!
//! - A crate's normal and build dependencies stay in its layer or below it.
//! - Data, services, platform and tools never build GPUI, directly or
//!   through another crate: the command line, MCP and tests run without a
//!   window.
//! - No product crate depends on a tool or a spike (dev-dependencies on the
//!   test kit are fine).
//! - Every member is classified; a new crate is added to [`LAYERS`].

use super::Outcome;
use super::metadata::Metadata;
use crate::repo::Repo;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layer {
    Data,
    Platform,
    Services,
    Interface,
    App,
    Tools,
    Spike,
}

/// Members by name (`docs/rust-rewrite/README.md` "目标架构"). `dr-view-*`
/// crates are interface crates.
pub const LAYERS: &[(&str, Layer)] = &[
    ("dr-model", Layer::Data),
    ("dr-doc", Layer::Data),
    ("dr-store", Layer::Data),
    ("dr-text", Layer::Data),
    ("dr-index", Layer::Data),
    // The one RNG, the samples' and the seed's paragraphs, the synthetic
    // corpus and the fingerprint, without a store (dr-samples, dr-testkit
    // and dr-store's tests use it).
    ("dr-corpus", Layer::Data),
    ("prose-metrics", Layer::Data),
    // Line breaking: the editor uses it now, dr-text and the PDF export later.
    ("prose-linebreak", Layer::Data),
    ("dr-platform", Layer::Platform),
    ("dr-i18n", Layer::Platform),
    // F8: the debug bridge's protocol and client, no GPUI (dr-cli, xtask).
    ("dr-debug-protocol", Layer::Platform),
    ("dr-workspace", Layer::Services),
    ("dr-agent", Layer::Services),
    ("dr-agent-providers", Layer::Services),
    ("dr-agent-tools", Layer::Services),
    ("dr-mcp", Layer::Services),
    ("dr-sync", Layer::Services),
    ("dr-export", Layer::Services),
    ("dr-mirror", Layer::Services),
    ("dr-import-v1", Layer::Services),
    // The built-in sample books (and the book writer dr-testkit's seed shares).
    ("dr-samples", Layer::Services),
    ("gpui-prose", Layer::Interface),
    ("gpui-ime", Layer::Interface),
    ("dr-editor", Layer::Interface),
    ("dr-ui", Layer::Interface),
    ("dr-shell", Layer::Interface),
    // F8: the debug bridge's server, linked into development builds only.
    ("dr-debug-bridge", Layer::Interface),
    // Feature views (`dr-view-*` are interface crates by name too).
    ("dr-view-review", Layer::Interface),
    ("dr-view-search", Layer::Interface),
    ("dr-view-stats", Layer::Interface),
    ("dr-view-shelf", Layer::Interface),
    ("dr-view-home", Layer::Interface),
    ("dr-view-elements", Layer::Interface),
    ("drifting", Layer::App),
    ("dr-testkit", Layer::Tools),
    ("dr-cli", Layer::Tools),
    ("xtask", Layer::Tools),
];

/// GPUI's own crates, which only the interface and the app may build.
pub const GPUI: &[&str] = &["gpui", "gpui_platform"];

pub fn layer_of(name: &str, dir: Option<&str>) -> Option<Layer> {
    if dir.is_some_and(|d| d.starts_with("spikes/")) {
        return Some(Layer::Spike);
    }
    if name.starts_with("dr-view-") {
        return Some(Layer::Interface);
    }
    LAYERS.iter().find(|(n, _)| *n == name).map(|(_, l)| *l)
}

/// Whether a `from` crate may have a normal or build dependency on `to`.
pub fn allowed(from: Layer, to: Layer) -> bool {
    use Layer::*;
    match from {
        Data => to == Data,
        Platform => to == Platform,
        Services => matches!(to, Data | Platform | Services),
        Interface => matches!(to, Data | Platform | Services | Interface),
        App => !matches!(to, Tools | Spike),
        Tools => matches!(to, Data | Platform | Services | Tools),
        Spike => true,
    }
}

fn may_build_gpui(l: Layer) -> bool {
    matches!(l, Layer::Interface | Layer::App | Layer::Spike)
}

pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let meta = Metadata::load(repo)?;
    let mut o = Outcome::default();
    check(&meta, &mut o);
    o.summary = format!("{} members classified", meta.members().count());
    Ok(o)
}

pub fn check(meta: &Metadata, o: &mut Outcome) {
    let members: Vec<_> = meta.members().collect();
    for m in &members {
        let Some(from) = layer_of(&m.name, m.dir.as_deref()) else {
            o.fail(format!(
                "{}: not classified; add it to LAYERS in xtask/src/gates/layers.rs",
                m.name
            ));
            continue;
        };
        for e in meta.edges.get(&m.id).into_iter().flatten() {
            let Some(dep) = meta.packages.get(&e.to).filter(|p| p.member) else {
                continue;
            };
            let Some(to) = layer_of(&dep.name, dep.dir.as_deref()) else {
                continue;
            };
            if (e.normal || e.build) && !allowed(from, to) {
                o.fail(format!(
                    "{} ({from:?}) depends on {} ({to:?}): dependencies point from the interface to services to data",
                    m.name, dep.name
                ));
            }
            if to == Layer::Spike && from != Layer::Spike {
                o.fail(format!("{} depends on the spike {}", m.name, dep.name));
            }
        }
        if !may_build_gpui(from) {
            let closure = meta.closure(&m.id);
            for g in GPUI {
                if let Some(id) = closure.iter().find(|id| meta.name(id) == *g) {
                    o.fail(format!(
                        "{} ({from:?}) builds GPUI: {}",
                        m.name,
                        meta.path(&m.id, id).join(" → ")
                    ));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::metadata::Metadata;
    use super::*;

    fn meta(edges: &[(&str, &str, &str)]) -> Metadata {
        let mut names: Vec<&str> = edges.iter().flat_map(|(a, b, _)| [*a, *b]).collect();
        names.sort();
        names.dedup();
        let packages: Vec<serde_json::Value> = names
            .iter()
            .map(|n| {
                let dir = if n.ends_with("-spike") {
                    format!("spikes/{n}")
                } else {
                    format!("crates/{n}")
                };
                serde_json::json!({
                    "id": n, "name": n, "version": "0.0.0", "license": "AGPL-3.0-or-later",
                    "manifest_path": format!("/w/next/{dir}/Cargo.toml"),
                })
            })
            .collect();
        let members: Vec<&str> = names
            .iter()
            .copied()
            .filter(|n| !GPUI.contains(n))
            .collect();
        let nodes: Vec<serde_json::Value> = names
            .iter()
            .map(|n| {
                let deps: Vec<serde_json::Value> = edges
                    .iter()
                    .filter(|(a, _, _)| a == n)
                    .map(|(_, b, k)| {
                        let kind = if *k == "normal" {
                            serde_json::Value::Null
                        } else {
                            serde_json::json!(k)
                        };
                        serde_json::json!({ "pkg": b, "dep_kinds": [{ "kind": kind }] })
                    })
                    .collect();
                serde_json::json!({ "id": n, "deps": deps })
            })
            .collect();
        Metadata::parse(
            &serde_json::json!({ "packages": packages, "workspace_members": members, "resolve": { "nodes": nodes } }),
            "/w/next",
        )
    }

    fn failures(edges: &[(&str, &str, &str)]) -> Vec<String> {
        let mut o = Outcome::default();
        check(&meta(edges), &mut o);
        o.failures
    }

    #[test]
    fn dependencies_point_down() {
        assert!(
            failures(&[
                ("dr-ui", "dr-doc", "normal"),
                ("dr-workspace", "dr-store", "normal")
            ])
            .is_empty()
        );
        assert_eq!(failures(&[("dr-doc", "dr-ui", "normal")]).len(), 1);
        assert_eq!(failures(&[("dr-workspace", "dr-shell", "normal")]).len(), 1);
        // Tests may use the test kit.
        assert!(failures(&[("dr-store", "dr-testkit", "dev")]).is_empty());
        assert_eq!(failures(&[("dr-store", "dr-testkit", "normal")]).len(), 1);
        assert_eq!(
            failures(&[("dr-new-thing", "dr-doc", "normal")]).len(),
            1,
            "unclassified"
        );
    }

    #[test]
    fn only_the_interface_builds_gpui() {
        assert!(failures(&[("dr-ui", "gpui", "normal")]).is_empty());
        let f = failures(&[
            ("dr-cli", "dr-shell", "normal"),
            ("dr-shell", "gpui", "normal"),
        ]);
        assert!(
            f.iter()
                .any(|m| m.contains("builds GPUI: dr-cli → dr-shell → gpui")),
            "{f:?}"
        );
        assert!(
            failures(&[("dr-store", "gpui", "dev")]).is_empty(),
            "dev-dependencies do not build into the crate"
        );
    }
}
