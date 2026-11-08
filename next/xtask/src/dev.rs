//! `cargo xtask dev`: run the app with a development profile of its own
//! (simplifications.md item 17).
//!
//! In a linked Git worktree the profile is the worktree's name, so every
//! checkout's development build has its own data and log folders, keychain
//! service and single-instance lock (`DRIFTING_PROFILE`, F7), and two
//! worktrees never share a library or a lock. `--instance <name>` adds a
//! suffix for parallel runs in one checkout. In the main checkout there is
//! no profile unless `--instance` is given: that is the author's daily
//! development build. `--debug-bridge` builds the app with F8's debug
//! bridge (`cargo drifting app …` drives it). `--hot` runs it under
//! `dx serve --hot-patch` with GPUI's hot reload (the app's `hot-reload`
//! feature): a view's render function and the code it calls are patched
//! into the running app when they change, without a restart.
//!
//! The profile rules live in `dr_debug_protocol::place`, which dr-cli uses
//! to find the same build.

use std::path::Path;
use std::process::Command;

use dr_debug_protocol::Paths;
pub use dr_debug_protocol::place::{profile, worktree_name};
use serde_json::json;

/// dr-platform's development identity (`identity::DEVELOPMENT`), checked
/// against it in the tests.
pub const DEV_BUNDLE_ID: &str = "cc.drifting.next.dev";
pub const DEV_KEYCHAIN_SERVICE: &str = "Drifting.cc.drifting.next.dev";
pub const PROFILE_ENV: &str = "DRIFTING_PROFILE";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Options {
    pub instance: Option<String>,
    pub print_config: bool,
    pub release: bool,
    pub debug_bridge: bool,
    pub hot: bool,
    pub app_args: Vec<String>,
}

/// The dx that GPUI's hot reload speaks to: GPUI v1.27.0 pins
/// `subsecond = "=0.7.10"`, and dx's patches must match it.
pub const DX_VERSION: &str = "0.7.10";

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
            "--debug-bridge" => o.debug_bridge = true,
            "--hot" => o.hot = true,
            "--" => {
                o.app_args = it.cloned().collect();
                break;
            }
            other => return Err(format!("cargo xtask dev: unknown option {other}")),
        }
    }
    if o.hot && o.release {
        return Err("--hot patches debug builds only; leave out --release".into());
    }
    Ok(o)
}

/// dx's name for this system's desktop platform.
fn dx_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "macos"
    }
}

/// The command that runs the app: `cargo run`, or `dx serve --hot-patch`.
pub fn command(o: &Options) -> Vec<String> {
    let mut c: Vec<String> = if o.hot {
        [
            "dx",
            "serve",
            "--hot-patch",
            "--package",
            "drifting",
            "--platform",
            dx_platform(),
            "--features",
            "hot-reload",
        ]
        .map(str::to_string)
        .to_vec()
    } else {
        ["cargo", "run", "-p", "drifting"]
            .map(str::to_string)
            .to_vec()
    };
    if o.release {
        c.push("--release".into());
    }
    if o.debug_bridge {
        c.extend(["--features".into(), "debug-bridge".into()]);
    }
    if !o.app_args.is_empty() {
        if o.hot {
            c.extend(["--args".into(), o.app_args.join(" ")]);
        } else {
            c.push("--".into());
            c.extend(o.app_args.iter().cloned());
        }
    }
    c
}

/// Where dx is: on `PATH`, else in cargo's bin folder.
fn find_dx() -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) { "dx.exe" } else { "dx" };
    std::env::var_os("PATH")
        .iter()
        .flat_map(std::env::split_paths)
        .chain(dirs::home_dir().map(|h| h.join(".cargo/bin")))
        .map(|d| d.join(name))
        .find(|p| p.is_file())
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
    let bridge = Paths::for_instance(&instance).ok();
    json!({
        "worktree": worktree,
        "profile": profile,
        "instanceName": instance,
        "dataDir": data,
        "logDir": logs,
        "keychainService": keychain,
        "env": { PROFILE_ENV: profile },
        "command": command(o),
        "hotReload": {
            "enabled": o.hot,
            "dx": DX_VERSION,
        },
        "debugBridge": bridge.map(|p| json!({
            "enabled": o.debug_bridge,
            "connectionFile": p.connection.to_string_lossy(),
            "socket": p.socket.to_string_lossy(),
        })),
    })
}

/// The crates dx can hot-patch in the app `--hot` builds, and those it
/// cannot (with the crates outside the app that depend on them).
fn hot_patchable(next: &Path, o: &Options) -> Result<serde_json::Value, String> {
    use crate::gates::{hot_reload, metadata::Metadata};
    let mut features = vec!["drifting/hot-reload"];
    if o.debug_bridge {
        features.push("drifting/debug-bridge");
    }
    let repo = crate::repo::Repo {
        root: next.parent().unwrap_or(next).to_path_buf(),
        next: next.to_path_buf(),
    };
    let meta = Metadata::load_with(&repo, &features)?;
    let (ok, blocked) = hot_reload::patchable(&meta, "drifting");
    Ok(json!({
        "patchable": ok,
        "notPatchable": blocked.into_iter().map(|(c, by)| json!({ "crate": c, "dependedOnBy": by })).collect::<Vec<_>>(),
    }))
}

pub fn run(root: &Path, next: &Path, args: &[String]) -> Result<i32, String> {
    let o = parse(args)?;
    let mut cfg = config(root, &o);
    let patchable = if o.hot {
        let p = hot_patchable(next, &o)?;
        cfg["hotReload"]["crates"] = p.clone();
        Some(p)
    } else {
        None
    };
    if o.print_config {
        println!(
            "{}",
            serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?
        );
        return Ok(0);
    }
    let argv = command(&o);
    let program = if o.hot {
        let dx = find_dx().ok_or_else(|| {
            format!(
                "cargo xtask dev --hot needs dx {DX_VERSION} (the version GPUI's hot reload speaks to): cargo install dioxus-cli --version {DX_VERSION} --locked"
            )
        })?;
        let version = Command::new(&dx)
            .arg("--version")
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
            .unwrap_or_default();
        if !version.contains(DX_VERSION) {
            eprintln!(
                "cargo xtask dev: {} says {:?}; GPUI's hot reload expects dx {DX_VERSION}",
                dx.display(),
                version.trim()
            );
        }
        if let Some(p) = &patchable {
            let names = |v: &serde_json::Value| -> String {
                v.as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|x| x.as_str().or_else(|| x["crate"].as_str()))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            eprintln!(
                "cargo xtask dev --hot: changes patch in for {}; a change to {} needs a full rebuild (press r in dx)",
                names(&p["patchable"]),
                names(&p["notPatchable"])
            );
        }
        dx.into_os_string()
    } else {
        std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into())
    };
    let mut cmd = Command::new(program);
    cmd.current_dir(next).args(&argv[1..]);
    match cfg["profile"].as_str() {
        Some(p) => {
            eprintln!("cargo xtask dev: profile {p} ({})", cfg["instanceName"]);
            cmd.env(PROFILE_ENV, p);
        }
        None => eprintln!("cargo xtask dev: main checkout, no profile"),
    }
    let status = cmd.status().map_err(|e| format!("{}: {e}", argv[0]))?;
    Ok(status.code().unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_debug_protocol::place::sanitize;

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
        let o = parse(&a(&["--instance", "two", "--debug-bridge", "--", "--mcp"])).unwrap();
        assert_eq!(o.instance.as_deref(), Some("two"));
        assert!(o.debug_bridge);
        assert_eq!(o.app_args, vec!["--mcp"]);
        assert!(parse(&a(&["--instance", "Bad Name"])).is_err());
        assert!(parse(&a(&["--what"])).is_err());
        assert_eq!(
            command(&o).join(" "),
            "cargo run -p drifting --features debug-bridge -- --mcp"
        );
    }

    #[test]
    fn hot_runs_under_dx_serve() {
        let a = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let o = parse(&a(&["--hot", "--debug-bridge", "--", "--a", "b"])).unwrap();
        let c = command(&o).join(" ");
        assert!(
            c.starts_with("dx serve --hot-patch --package drifting --platform "),
            "{c}"
        );
        assert!(
            c.ends_with("--features hot-reload --features debug-bridge --args --a b"),
            "{c}"
        );
        assert!(
            parse(&a(&["--hot", "--release"])).is_err(),
            "debug builds only"
        );
        let cfg = config(Path::new("/nowhere"), &o);
        assert_eq!(cfg["hotReload"]["enabled"], true);
        assert_eq!(cfg["command"][0], "dx");
    }
}
