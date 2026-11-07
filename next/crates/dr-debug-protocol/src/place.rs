//! Where a running development build can be found.
//!
//! - **Profile**: `DRIFTING_PROFILE` gives a development build its own data
//!   folder, lock and keychain service (dr-platform). In a linked Git
//!   worktree `cargo xtask dev` sets it to the worktree's name; [`profile`]
//!   and [`checkout_profile`] are that rule, shared by xtask and dr-cli.
//! - **Instance**: `<bundle id>` or `<bundle id>.<profile>`
//!   (`dr_platform::Identity::instance_name`).
//! - **Connection file**: `<data folder>/debug-bridge.json`, written by the
//!   bridge when it starts (owner read and write only) and removed when the
//!   app quits. The data folder is dr-platform's (`AppDirs`), so a client
//!   finds it from the instance alone, whatever its `TMPDIR`.
//! - **Socket** (Unix): `$TMPDIR/drifting-<hash of the instance>.sock`. A
//!   socket path may be at most 104 bytes on macOS; the data folder's path
//!   can be longer, the temporary folder's is short. Windows listens on the
//!   loopback interface instead (see `transport`).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::PROTOCOL;
use crate::wire::{BridgeError, codes};

/// The connection file's name inside the data folder.
pub const CONNECTION_FILE: &str = "debug-bridge.json";
/// macOS's limit on a Unix socket path, in bytes (`sun_path`).
pub const MAX_SOCKET_PATH: usize = 104;
const MAX_PROFILE: usize = 32;

/// FNV-1a, 64 bits: short stable names from long ones.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// `<bundle id>` or `<bundle id>.<profile>`.
pub fn instance_name(bundle_id: &str, profile: Option<&str>) -> String {
    match profile {
        Some(p) => format!("{bundle_id}.{p}"),
        None => bundle_id.to_owned(),
    }
}

/// The data folder dr-platform gives an instance (`AppDirs::for_identity`).
pub fn data_dir(instance: &str) -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(instance))
}

/// The log folder dr-platform gives an instance (`AppDirs`).
pub fn logs_dir(instance: &str) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        dirs::home_dir().map(|h| h.join("Library/Logs").join(instance))
    } else {
        data_dir(instance).map(|d| d.join("logs"))
    }
}

/// Where one instance's bridge lives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paths {
    pub connection: PathBuf,
    /// Unix only; Windows listens on loopback TCP.
    pub socket: PathBuf,
}

impl Paths {
    /// The paths of a running instance.
    pub fn for_instance(instance: &str) -> Result<Paths, BridgeError> {
        let data = data_dir(instance).ok_or_else(|| {
            BridgeError::new(
                codes::IO,
                "this system has no local application data folder",
            )
        })?;
        Ok(Paths::in_dirs(&data, &std::env::temp_dir(), instance))
    }

    /// The connection file in `data`, the socket in `temp`.
    pub fn in_dirs(data: &Path, temp: &Path, instance: &str) -> Paths {
        Paths {
            connection: data.join(CONNECTION_FILE),
            socket: temp.join(format!(
                "drifting-{:016x}.sock",
                fnv1a64(instance.as_bytes())
            )),
        }
    }

    /// Everything in one folder (tests).
    pub fn under(dir: &Path) -> Paths {
        Paths {
            connection: dir.join(CONNECTION_FILE),
            socket: dir.join("bridge.sock"),
        }
    }
}

/// What the connection file says.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Connection {
    /// [`PROTOCOL`].
    pub protocol: String,
    pub instance: String,
    pub pid: u32,
    /// The app's version.
    pub version: String,
    /// A Unix socket's path, or `127.0.0.1:<port>` on Windows.
    pub address: String,
    /// Sent in the first message; anything else is turned away.
    pub token: String,
}

impl Connection {
    /// Writes it, readable by its owner only, replacing the file at once
    /// (never half-written).
    pub fn write(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        {
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            use std::io::Write;
            let mut f = opts.open(&tmp)?;
            f.write_all(&text)?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, path)
    }

    pub fn read(path: &Path) -> Result<Connection, BridgeError> {
        let text = std::fs::read(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                BridgeError::new(
                    codes::NOT_RUNNING,
                    format!(
                        "no debug bridge: {} does not exist (is the app running with --debug-bridge, under this profile?)",
                        path.display()
                    ),
                )
            } else {
                BridgeError::new(codes::IO, format!("{}: {e}", path.display()))
            }
        })?;
        let c: Connection = serde_json::from_slice(&text).map_err(|e| {
            BridgeError::new(codes::BAD_REQUEST, format!("{}: {e}", path.display()))
        })?;
        if c.protocol != PROTOCOL {
            return Err(BridgeError::new(
                codes::BAD_REQUEST,
                format!(
                    "{} speaks {}, this client {PROTOCOL}",
                    path.display(),
                    c.protocol
                ),
            ));
        }
        Ok(c)
    }
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
    let hash = format!("{:06x}", fnv1a64(name.as_bytes()) & 0xFF_FFFF);
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

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The linked worktree's name, or `None` in the main checkout (or outside
/// Git).
pub fn worktree_name(dir: &Path) -> Option<String> {
    let git_dir = git(dir, &["rev-parse", "--absolute-git-dir"])?;
    let common = git(
        dir,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    if Path::new(&git_dir) == Path::new(&common) {
        return None;
    }
    let top = git(dir, &["rev-parse", "--show-toplevel"])?;
    Path::new(&top)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
}

/// The profile `cargo xtask dev [--instance <name>]` gives builds run from
/// the checkout around `dir`.
pub fn checkout_profile(dir: &Path, instance: Option<&str>) -> Option<String> {
    profile(worktree_name(dir).as_deref(), instance)
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
    fn sockets_fit_the_path_limit_and_differ_per_instance() {
        let a =
            Paths::for_instance("cc.drifting.next.dev.a-very-long-profile-name-123456").unwrap();
        let b = Paths::for_instance("cc.drifting.next.dev").unwrap();
        assert_ne!(a.socket, b.socket);
        assert_ne!(a.connection, b.connection);
        assert!(a.connection.ends_with(CONNECTION_FILE));
        assert!(
            a.socket.as_os_str().len() < MAX_SOCKET_PATH,
            "{}",
            a.socket.display()
        );
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
    }

    #[test]
    fn connection_files_are_private_and_checked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join(CONNECTION_FILE);
        let c = Connection {
            protocol: PROTOCOL.into(),
            instance: "cc.drifting.next.dev.t".into(),
            pid: 7,
            version: "0.2.0-dev".into(),
            address: "/tmp/x.sock".into(),
            token: "secret".into(),
        };
        c.write(&path).unwrap();
        assert_eq!(Connection::read(&path).unwrap(), c);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let other = Connection {
            protocol: "drifting-debug-bridge/0".into(),
            ..c
        };
        other.write(&path).unwrap();
        assert_eq!(
            Connection::read(&path).unwrap_err().code,
            codes::BAD_REQUEST
        );
        assert_eq!(
            Connection::read(&dir.path().join("none.json"))
                .unwrap_err()
                .code,
            codes::NOT_RUNNING
        );
    }
}
