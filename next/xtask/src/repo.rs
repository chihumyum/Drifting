//! The checkout: where things are, which files count, reading them.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The `next/` workspace and the repository around it.
#[derive(Clone, Debug)]
pub struct Repo {
    /// The repository root.
    pub root: PathBuf,
    /// `<root>/next`.
    pub next: PathBuf,
}

/// One file the gates look at, by its `/`-separated path from the root.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct File {
    pub path: String,
    /// Not yet tracked by git (scanned anyway).
    pub untracked: bool,
}

impl Repo {
    pub fn locate() -> Self {
        let next = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("xtask lives in next/")
            .to_path_buf();
        let root = next
            .parent()
            .expect("next/ lives in the repository")
            .to_path_buf();
        Self { root, next }
    }

    /// Tracked and untracked (not ignored) files under `dirs`, as git sees
    /// them: a new file cannot slip past a gate by not being staged yet.
    pub fn files(&self, dirs: &[&str]) -> Result<Vec<File>, String> {
        let list = |extra: &[&str]| -> Result<Vec<String>, String> {
            let mut args = vec!["ls-files", "-z"];
            args.extend_from_slice(extra);
            args.push("--");
            args.extend_from_slice(dirs);
            let out = Command::new("git")
                .current_dir(&self.root)
                .args(&args)
                .output()
                .map_err(|e| format!("git ls-files: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "git ls-files failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                ));
            }
            Ok(String::from_utf8_lossy(&out.stdout)
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect())
        };
        let tracked: std::collections::BTreeSet<String> =
            list(&["--cached"])?.into_iter().collect();
        let mut files: Vec<File> = tracked
            .iter()
            .map(|p| File {
                path: p.clone(),
                untracked: false,
            })
            .collect();
        for p in list(&["--others", "--exclude-standard"])? {
            if !tracked.contains(&p) {
                files.push(File {
                    path: p,
                    untracked: true,
                });
            }
        }
        // A tracked file deleted in the working tree is not there to scan.
        files.retain(|f| self.root.join(&f.path).is_file());
        files.sort();
        Ok(files)
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    /// The file's text, or `None` for a binary file (a NUL byte in its first
    /// 8000 bytes, as git decides) or one that is not UTF-8.
    pub fn text(&self, rel: &str) -> Option<String> {
        let bytes = std::fs::read(self.path(rel)).ok()?;
        if is_binary(&bytes) {
            return None;
        }
        String::from_utf8(bytes).ok()
    }
}

pub fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8000)].contains(&0)
}

/// A string literal in Rust source and the line it starts on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Literal {
    pub line: usize,
    pub text: String,
}

/// The string literals of Rust source (plain, raw, byte), skipping comments
/// (doc comments included), char literals and lifetimes. Escapes are kept
/// as written, which is all a text gate needs.
pub fn rust_literals(src: &str) -> Vec<Literal> {
    let b: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    let mut line = 1;
    let n = b.len();
    let advance = |i: &mut usize, line: &mut usize, k: usize| {
        for c in &b[*i..(*i + k).min(n)] {
            if *c == '\n' {
                *line += 1;
            }
        }
        *i += k;
    };
    while i < n {
        let c = b[i];
        // Comments.
        if c == '/' && b.get(i + 1) == Some(&'/') {
            while i < n && b[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && b.get(i + 1) == Some(&'*') {
            let mut depth = 0;
            while i < n {
                if b[i] == '/' && b.get(i + 1) == Some(&'*') {
                    depth += 1;
                    advance(&mut i, &mut line, 2);
                } else if b[i] == '*' && b.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    advance(&mut i, &mut line, 2);
                    if depth == 0 {
                        break;
                    }
                } else {
                    advance(&mut i, &mut line, 1);
                }
            }
            continue;
        }
        // Raw strings: r"…", r#"…"#, br#"…"#.
        let ident_before = i > 0 && (b[i - 1].is_alphanumeric() || b[i - 1] == '_');
        if !ident_before && (c == 'r' || (c == 'b' && b.get(i + 1) == Some(&'r'))) {
            let mut j = i + if c == 'b' { 2 } else { 1 };
            let mut hashes = 0;
            while b.get(j) == Some(&'#') {
                hashes += 1;
                j += 1;
            }
            if b.get(j) == Some(&'"') {
                let start_line = line;
                let body_start = j + 1;
                let mut k = body_start;
                loop {
                    if k >= n {
                        break;
                    }
                    if b[k] == '"' && (0..hashes).all(|h| b.get(k + 1 + h) == Some(&'#')) {
                        break;
                    }
                    k += 1;
                }
                out.push(Literal {
                    line: start_line,
                    text: b[body_start..k.min(n)].iter().collect(),
                });
                let step = k + 1 + hashes - i;
                advance(&mut i, &mut line, step);
                continue;
            }
        }
        if c == '"' {
            let start_line = line;
            let mut k = i + 1;
            let mut s = String::new();
            while k < n && b[k] != '"' {
                if b[k] == '\\' && k + 1 < n {
                    s.push(b[k]);
                    s.push(b[k + 1]);
                    k += 2;
                    continue;
                }
                s.push(b[k]);
                k += 1;
            }
            out.push(Literal {
                line: start_line,
                text: s,
            });
            let step = k + 1 - i;
            advance(&mut i, &mut line, step);
            continue;
        }
        if c == '\'' {
            // A char literal ('x', '\n', '\u{..}') or a lifetime ('a).
            if b.get(i + 1) == Some(&'\\') {
                let mut k = i + 2;
                while k < n && b[k] != '\'' {
                    k += 1;
                }
                let step = k + 1 - i;
                advance(&mut i, &mut line, step);
                continue;
            }
            if b.get(i + 2) == Some(&'\'') {
                advance(&mut i, &mut line, 3);
                continue;
            }
        }
        advance(&mut i, &mut line, 1);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literals_skip_comments_chars_and_lifetimes() {
        let src = r####"
// "not this"
/// "nor this"
/* "nor /* nested */ this" */
fn f<'a>(x: &'a str) -> char {
    let s = "one \"two\"";
    let r = r#"raw "three""#;
    let c = '"';
    let b = b"four";
    'x'
}
"####;
        let got: Vec<(usize, String)> = rust_literals(src)
            .into_iter()
            .map(|l| (l.line, l.text))
            .collect();
        assert_eq!(
            got,
            vec![
                (6, r#"one \"two\""#.to_string()),
                (7, r#"raw "three""#.to_string()),
                (9, "four".to_string()),
            ]
        );
    }
}
