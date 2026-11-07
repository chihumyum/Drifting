//! `cargo xtask dev`: run the app with a development profile of its own
//! (simplifications.md item 17).
//!
//! In a linked Git worktree the profile is the worktree's name, so every
//! checkout's development build has its own data and log folders, keychain
//! service and single-instance lock (`DRIFTING_PROFILE`, F7), and two
//! worktrees never share a library or a lock. `--instance <name>` adds a
//! suffix for parallel runs in one checkout. In the main checkout there is
//! no profile unless `--instance` is given: that is the author's daily
//! development build.

use std::path::Path;
use std::process::Command;

use serde_json::json;

/// dr-platform's development identity (`identity::DEVELOPMENT`), checked
/// against it in the tests.
pub const DEV_BUNDLE_ID: &str = "cc.drifting.next.dev";
pub const DEV_KEYCHAIN_SERVICE: &str = "Drifting.cc.drifting.next.dev";
pub const PROFILE_ENV: &str = "DRIFTING_PROFILE";
const MAX_PROFILE: usize = 32;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Options {
    pub instance: Option<String>,
    pub print_config: bool,
    pub release: bool,
    pub app_args: Vec<String>,
}

pub fn parse(args: &[String]) -> Result<Options, String> {
    let mut o = Options::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--instance" => {
                let v = it.next().ok_or("--instance needs a name")?;
                if v.is_empty()
                    || v.len() > 20
                    || !v
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                {
                    return Err("--instance: 1–20 lowercase letters, digits or hyphens".into());
                }
                o.instance = Some(v.clone());
            }
            "--print-config" => o.print_config = true,
            "--release" => o.release = true,
            "--" => {
                o.app_args = it.cloned().collect();
                break;
            }
            other => return Err(format!("cargo xtask dev: unknown option {other}")),
        }
    }
    Ok(o)
}

/// `a-z`, `0-9`, `-`; at most 32 characters (dr-platform ignores anything
/// else). A long name keeps its start and gets a short hash, so two long
/// worktree names never collapse into one profile.
pub fn sanitize(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            s.push(c);
        } else if !s.ends_with('-') {
            s.push('-');
        }
    }
    let s = s.trim_matches('-').to_string();
    let s = if s.is_empty() {
        "worktree".to_string()
    } else {
        s
    };
    if s.len() <= MAX_PROFILE {
        return s;
    }
    let hash = format!(
        "{:06x}",
        dr_testkit::digest::fnv1a64(name.as_bytes()) & 0xFF_FFFF
    );
    let keep = MAX_PROFILE - hash.len() - 1;
    format!("{}-{hash}", s[..keep].trim_end_matches('-'))
}

/// The profile for a checkout: its worktree name (linked worktrees), plus
/// the instance.
pub fn profile(worktree: Option<&str>, instance: Option<&str>) -> Option<String> {
    match (worktree, instance) {
        (None, None) => None,
        (None, Some(i)) => Some(sanitize(i)),
        (Some(w), None) => Some(sanitize(w)),
        (Some(w), Some(i)) => {
            let suffix = format!("-{}", sanitize(i));
            let base = sanitize(w);
            let room = MAX_PROFILE.saturating_sub(suffix.len());
            Some(format!(
                "{}{suffix}",
                base[..base.len().min(room)].trim_end_matches('-')
            ))
        }
    }
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The linked worktree's name, or `None` in the main checkout.
pub fn worktree_name(root: &Path) -> Option<String> {
    let dir = git(root, &["rev-parse", "--absolute-git-dir"])?;
    let common = git(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    if Path::new(&dir) == Path::new(&common) {
        return None;
    }
    let top = git(root, &["rev-parse", "--show-toplevel"])?;
    Path::new(&top)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
}

/// The folders dr-platform gives `instance` (`paths::AppDirs`).
pub fn folders(instance: &str) -> (Option<String>, Option<String>) {
    let data = dirs::data_local_dir().map(|d| d.join(instance));
    let logs = if cfg!(target_os = "macos") {
        dirs::home_dir().map(|h| h.join("Library/Logs").join(instance))
    } else {
        data.as_ref().map(|d| d.join("logs"))
    };
    let s = |p: Option<std::path::PathBuf>| p.map(|p| p.to_string_lossy().into_owned());
    (s(data), s(logs))
}

pub fn config(root: &Path, o: &Options) -> serde_json::Value {
    let worktree = worktree_name(root);
    let profile = profile(worktree.as_deref(), o.instance.as_deref());
    let instance = match &profile {
        Some(p) => format!("{DEV_BUNDLE_ID}.{p}"),
        None => DEV_BUNDLE_ID.to_string(),
    };
    let keychain = match &profile {
        Some(p) => format!("{DEV_KEYCHAIN_SERVICE}.{p}"),
        None => DEV_KEYCHAIN_SERVICE.to_string(),
    };
    let (data, logs) = folders(&instance);
    json!({
        "worktree": worktree,
        "profile": profile,
        "instanceName": instance,
        "dataDir": data,
        "logDir": logs,
        "keychainService": keychain,
        "env": { PROFILE_ENV: profile },
        "command": ["cargo", "run", "-p", "drifting"],
    })
}

pub fn run(root: &Path, next: &Path, args: &[String]) -> Result<i32, String> {
    let o = parse(args)?;
    let cfg = config(root, &o);
    if o.print_config {
        println!(
            "{}",
            serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?
        );
        return Ok(0);
    }
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let mut cmd = Command::new(cargo);
    cmd.current_dir(next).args(["run", "-p", "drifting"]);
    if o.release {
        cmd.arg("--release");
    }
    if !o.app_args.is_empty() {
        cmd.arg("--").args(&o.app_args);
    }
    match cfg["profile"].as_str() {
        Some(p) => {
            eprintln!("cargo xtask dev: profile {p} ({})", cfg["instanceName"]);
            cmd.env(PROFILE_ENV, p);
        }
        None => eprintln!("cargo xtask dev: main checkout, no profile"),
    }
    let status = cmd.status().map_err(|e| format!("cargo run: {e}"))?;
    Ok(status.code().unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_fit_what_dr_platform_accepts() {
        assert_eq!(sanitize("f8-testkit-ca9ad6"), "f8-testkit-ca9ad6");
        assert_eq!(sanitize("Claude/Feature_X"), "claude-feature-x");
        let long = "a-very-long-worktree-name-that-goes-on-and-on";
        let p = sanitize(long);
        assert!(p.len() <= 32 && p.starts_with("a-very-long"), "{p}");
        assert_ne!(
            p,
            sanitize("a-very-long-worktree-name-that-goes-on-and-off")
        );
        assert_eq!(profile(None, None), None);
        assert_eq!(profile(Some("wt"), None).as_deref(), Some("wt"));
        assert_eq!(profile(Some("wt"), Some("b")).as_deref(), Some("wt-b"));
        assert_eq!(profile(None, Some("b")).as_deref(), Some("b"));
        let both = profile(Some(long), Some("second")).unwrap();
        assert!(both.len() <= 32 && both.ends_with("-second"), "{both}");
        for p in [p, both] {
            assert!(
                p.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            );
        }
    }

    #[test]
    fn the_identity_matches_dr_platform() {
        let id = dr_platform::Identity::current();
        assert_eq!(id.bundle_id, DEV_BUNDLE_ID);
        assert_eq!(id.keychain_service, DEV_KEYCHAIN_SERVICE);
        assert_eq!(dr_platform::identity::PROFILE_ENV, PROFILE_ENV);
        // With no profile in the environment, the folders are dr-platform's.
        if std::env::var_os(PROFILE_ENV).is_none() {
            let dirs = dr_platform::AppDirs::for_identity(id).unwrap();
            let (data, logs) = folders(DEV_BUNDLE_ID);
            assert_eq!(data.as_deref(), Some(&*dirs.data.to_string_lossy()));
            assert_eq!(logs.as_deref(), Some(&*dirs.logs.to_string_lossy()));
        }
    }

    #[test]
    fn options() {
        let a = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let o = parse(&a(&["--instance", "two", "--", "--mcp"])).unwrap();
        assert_eq!(o.instance.as_deref(), Some("two"));
        assert_eq!(o.app_args, vec!["--mcp"]);
        assert!(parse(&a(&["--instance", "Bad Name"])).is_err());
        assert!(parse(&a(&["--what"])).is_err());
    }
}
