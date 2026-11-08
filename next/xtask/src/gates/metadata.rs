//! `cargo metadata` of the workspace: packages, members and the resolved
//! dependency graph with dependency kinds.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::repo::Repo;

#[derive(Clone, Debug)]
pub struct Package {
    pub id: String,
    pub name: String,
    pub version: String,
    pub license: Option<String>,
    pub member: bool,
    /// The member's directory relative to `next/` (`crates/dr-store`).
    pub dir: Option<String>,
    /// Its `[features]` table.
    pub features: BTreeMap<String, Vec<String>>,
    /// Its manifest's dependencies, as declared (not resolved).
    pub dependencies: Vec<Declared>,
}

/// A dependency as a manifest declares it.
#[derive(Clone, Debug)]
pub struct Declared {
    pub name: String,
    /// `None` (normal), `Some("dev")` or `Some("build")`.
    pub kind: Option<String>,
    pub optional: bool,
    /// The features it asks of the dependency (`features = […]`).
    pub features: Vec<String>,
}

/// A dependency edge and the kinds it is used as.
#[derive(Clone, Debug)]
pub struct Edge {
    pub to: String,
    pub normal: bool,
    pub build: bool,
    pub dev: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Metadata {
    pub packages: BTreeMap<String, Package>,
    pub edges: BTreeMap<String, Vec<Edge>>,
}

impl Metadata {
    pub fn load(repo: &Repo) -> Result<Self, String> {
        Self::load_with(repo, &[])
    }

    /// [`Self::load`] resolved with `features` on (`drifting/hot-reload`).
    pub fn load_with(repo: &Repo, features: &[&str]) -> Result<Self, String> {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let mut args = vec!["metadata", "--format-version", "1", "--locked"];
        let joined = features.join(",");
        if !features.is_empty() {
            args.extend(["--features", joined.as_str()]);
        }
        let out = std::process::Command::new(cargo)
            .current_dir(&repo.next)
            .args(&args)
            .output()
            .map_err(|e| format!("cargo metadata: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "cargo metadata failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        Ok(Self::parse(&v, &repo.next.to_string_lossy()))
    }

    pub fn parse(v: &Value, next_dir: &str) -> Self {
        let members: BTreeSet<&str> = v["workspace_members"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let mut m = Metadata::default();
        for p in v["packages"].as_array().into_iter().flatten() {
            let id = p["id"].as_str().unwrap_or_default().to_string();
            let member = members.contains(id.as_str());
            let dir = member.then(|| {
                let manifest = p["manifest_path"]
                    .as_str()
                    .unwrap_or_default()
                    .replace('\\', "/");
                let base = next_dir.replace('\\', "/");
                manifest
                    .strip_prefix(&format!("{base}/"))
                    .unwrap_or(&manifest)
                    .trim_end_matches("/Cargo.toml")
                    .to_string()
            });
            let strings = |v: &Value| -> Vec<String> {
                v.as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            };
            let features = p["features"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.clone(), strings(v)))
                .collect();
            let dependencies = p["dependencies"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|d| Declared {
                    name: d["name"].as_str().unwrap_or_default().to_string(),
                    kind: d["kind"].as_str().map(str::to_string),
                    optional: d["optional"].as_bool().unwrap_or(false),
                    features: d["features"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|f| f.as_str().map(str::to_string))
                        .collect(),
                })
                .collect();
            m.packages.insert(
                id.clone(),
                Package {
                    id,
                    name: p["name"].as_str().unwrap_or_default().to_string(),
                    version: p["version"].as_str().unwrap_or_default().to_string(),
                    license: p["license"].as_str().map(str::to_string),
                    member,
                    dir,
                    features,
                    dependencies,
                },
            );
        }
        for n in v["resolve"]["nodes"].as_array().into_iter().flatten() {
            let from = n["id"].as_str().unwrap_or_default().to_string();
            let mut edges = Vec::new();
            for d in n["deps"].as_array().into_iter().flatten() {
                let mut e = Edge {
                    to: d["pkg"].as_str().unwrap_or_default().to_string(),
                    normal: false,
                    build: false,
                    dev: false,
                };
                for k in d["dep_kinds"].as_array().into_iter().flatten() {
                    match k["kind"].as_str() {
                        None => e.normal = true,
                        Some("build") => e.build = true,
                        Some("dev") => e.dev = true,
                        Some(_) => {}
                    }
                }
                edges.push(e);
            }
            m.edges.insert(from, edges);
        }
        m
    }

    pub fn members(&self) -> impl Iterator<Item = &Package> {
        self.packages.values().filter(|p| p.member)
    }

    /// Packages in the resolved graph (not every package metadata lists).
    pub fn resolved(&self) -> impl Iterator<Item = &Package> {
        self.packages
            .values()
            .filter(|p| self.edges.contains_key(&p.id))
    }

    pub fn name<'a>(&'a self, id: &'a str) -> &'a str {
        self.packages.get(id).map_or(id, |p| p.name.as_str())
    }

    /// Everything `id` builds with: normal and build dependencies,
    /// transitively (dev-dependencies of dependencies never build).
    pub fn closure(&self, id: &str) -> BTreeSet<String> {
        let mut seen = BTreeSet::new();
        let mut stack = vec![id.to_string()];
        while let Some(x) = stack.pop() {
            for e in self.edges.get(&x).into_iter().flatten() {
                if (e.normal || e.build) && seen.insert(e.to.clone()) {
                    stack.push(e.to.clone());
                }
            }
        }
        seen
    }

    /// The chain from `from` to `to` over normal and build edges, by name.
    pub fn path(&self, from: &str, to: &str) -> Vec<String> {
        let mut prev: BTreeMap<String, String> = BTreeMap::new();
        let mut queue = std::collections::VecDeque::from([from.to_string()]);
        let mut seen = BTreeSet::from([from.to_string()]);
        while let Some(x) = queue.pop_front() {
            if x == to {
                let mut chain = vec![self.name(&x).to_string()];
                let mut cur = x;
                while let Some(p) = prev.get(&cur) {
                    chain.push(self.name(p).to_string());
                    cur = p.clone();
                }
                chain.reverse();
                return chain;
            }
            for e in self.edges.get(&x).into_iter().flatten() {
                if (e.normal || e.build) && seen.insert(e.to.clone()) {
                    prev.insert(e.to.clone(), x.clone());
                    queue.push_back(e.to.clone());
                }
            }
        }
        Vec::new()
    }
}
