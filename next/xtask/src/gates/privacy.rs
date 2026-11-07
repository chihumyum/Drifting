//! Credentials and privacy (rule 1): no personal absolute paths, no private
//! sibling repository paths, no attribution trailers, no credential or
//! signing files. Tracked and untracked files alike, in `next/` and
//! `docs/rust-rewrite/`.

use regex::Regex;

use super::Outcome;
use crate::repo::Repo;

pub const SCOPE: &[&str] = &["next", "docs/rust-rewrite"];

/// This file names what it looks for; the patterns are assembled from
/// pieces so no other scanner (the 0.1 client's public-boundary check
/// included) mistakes them for the real thing.
const SELF: &str = "next/xtask/src/gates/privacy.rs";

pub fn patterns() -> Vec<(&'static str, Regex)> {
    let users = ["", "Users", ""].join("/");
    let home = ["", "home", ""].join("/");
    let win = ["C:", "Users", ""].join(r"\\");
    let trailer = format!(
        "{}:[^\\n]*{}",
        ["co", "authored", "by"].join("-"),
        ["clau", "de"].join("")
    );
    let generated = format!("generated with \\[?{} {}", ["Clau", "de"].join(""), "Code");
    vec![
        (
            "personal absolute path",
            Regex::new(&format!(
                r"(?:{}|{})[A-Za-z0-9._-]+|{}[A-Za-z0-9._-]+",
                regex::escape(&users),
                regex::escape(&home),
                win,
            ))
            .expect("regex"),
        ),
        (
            "private sibling repository path",
            Regex::new(&format!(
                "{}/|{}/",
                ["Drifting", "Server"].join("-"),
                ["Drifting", "Core"].join("-")
            ))
            .expect("regex"),
        ),
        (
            "attribution trailer",
            Regex::new(&format!("(?i){trailer}|{generated}")).expect("regex"),
        ),
    ]
}

/// Placeholder home folders documentation may show.
fn is_placeholder(m: &str) -> bool {
    let name = m
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    matches!(
        name,
        "example" | "me" | "runner" | "user" | "you" | "USER" | "name"
    )
}

/// Credential and signing files by name.
pub fn is_credential_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    if name == ".env" || (name.starts_with(".env.") && name != ".env.example") {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    [
        ".pem",
        ".p12",
        ".p8",
        ".mobileprovision",
        ".jks",
        ".keystore",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext))
}

pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let mut o = Outcome::default();
    let files = repo.files(SCOPE)?;
    let patterns = patterns();
    let mut scanned = 0;
    for f in &files {
        let tag = if f.untracked { " (untracked)" } else { "" };
        if is_credential_file(&f.path) {
            o.fail(format!("{}{tag}: credential or signing file", f.path));
        }
        if f.path == SELF {
            continue;
        }
        let Some(text) = repo.text(&f.path) else {
            continue;
        };
        scanned += 1;
        for (label, re) in &patterns {
            for m in re.find_iter(&text) {
                if *label == "personal absolute path" && is_placeholder(m.as_str()) {
                    continue;
                }
                let line = text[..m.start()].matches('\n').count() + 1;
                o.fail(format!("{}:{line}{tag}: {label}", f.path));
                break;
            }
        }
    }
    o.summary = format!("{scanned} text files of {} scanned", files.len());
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hits(s: &str) -> Vec<&'static str> {
        patterns()
            .into_iter()
            .filter(|(label, re)| {
                re.find_iter(s)
                    .any(|m| *label != "personal absolute path" || !is_placeholder(m.as_str()))
            })
            .map(|(l, _)| l)
            .collect()
    }

    #[test]
    fn finds_what_it_should() {
        let users = ["", "Users", "alice", "x"].join("/");
        assert_eq!(hits(&users), vec!["personal absolute path"]);
        assert!(hits(&["", "Users", "example", "x"].join("/")).is_empty());
        assert!(hits(&["", "home", "runner", "work"].join("/")).is_empty());
        let win = ["C:", "Users", "bob", "AppData"].join("\\");
        assert_eq!(hits(&win), vec!["personal absolute path"]);
        let trailer = format!(
            "{}: {} <x>",
            ["Co", "Authored", "By"].join("-"),
            ["Clau", "de"].join("")
        );
        assert_eq!(hits(&trailer), vec!["attribution trailer"]);
        assert!(hits("the users/ folder and /usr/lib").is_empty());
    }

    #[test]
    fn credential_files() {
        for bad in [
            "a/.env",
            "a/.env.local",
            "k.pem",
            "Cert.P12",
            "x.mobileprovision",
            "a.jks",
            "AuthKey.p8",
        ] {
            assert!(is_credential_file(bad), "{bad}");
        }
        for ok in [".env.example", "env.rs", "pem.md"] {
            assert!(!is_credential_file(ok), "{ok}");
        }
    }
}
