//! Published migrations are immutable (rule 10): every migration of the new
//! workspace is listed here, and a published one is pinned by its SHA-256.
//! A migration starts out unpublished; when the first build that carries it
//! is released, put its hash here (`cargo xtask check` prints it).

use super::Outcome;
use crate::repo::Repo;

/// Directories that hold ordered SQL migrations.
const DIRS: &[&str] = &["next/crates/dr-store/migrations"];

/// Every migration, in order, and its published hash (`None`: not yet
/// published, still free to change).
const PINNED: &[(&str, Option<&str>)] = &[
    // F2's baseline; frozen when the first 0.2 build ships.
    ("next/crates/dr-store/migrations/0000_baseline.sql", None),
    (
        "next/crates/dr-store/migrations/0001_import_receipts.sql",
        None,
    ),
    (
        "next/crates/dr-store/migrations/0002_history_label_keep.sql",
        None,
    ),
    ("next/crates/dr-store/migrations/0003_ws_journal.sql", None),
    ("next/crates/dr-store/migrations/0004_local_state.sql", None),
    ("next/crates/dr-store/migrations/0005_purged_doc.sql", None),
    (
        "next/crates/dr-store/migrations/0006_reference_by_book.sql",
        None,
    ),
    (
        "next/crates/dr-store/migrations/0007_agent_runtime.sql",
        None,
    ),
];

fn sha256(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn check(found: &[(String, Vec<u8>)], pinned: &[(&str, Option<&str>)], o: &mut Outcome) {
    for (path, want) in pinned {
        match found.iter().find(|(p, _)| p == path) {
            None => o.fail(format!(
                "{path}: a listed migration is gone; published migrations are never deleted"
            )),
            Some((_, bytes)) => {
                let got = sha256(bytes);
                match want {
                    Some(w) if *w != got => o.fail(format!(
                        "{path}: a published migration changed ({got}); add a new migration instead"
                    )),
                    Some(_) => {}
                    None => o.note(format!("{path}: not published yet (sha256 {got})")),
                }
            }
        }
    }
    for (path, _) in found {
        if !pinned.iter().any(|(p, _)| p == path) {
            o.fail(format!(
                "{path}: not listed in xtask/src/gates/migrations.rs; add it (unpublished: None)"
            ));
        }
    }
    let mut by_dir: std::collections::BTreeMap<&str, Vec<&str>> = Default::default();
    for (path, _) in pinned {
        let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
        by_dir.entry(dir).or_default().push(name);
    }
    for (dir, names) in by_dir {
        for (i, name) in names.iter().enumerate() {
            let want = format!("{i:04}_");
            if !name.starts_with(&want) || !name.ends_with(".sql") {
                o.fail(format!(
                    "{dir}/{name}: migrations are numbered {want}<name>.sql, in order"
                ));
            }
        }
    }
}

pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let mut o = Outcome::default();
    let mut found = Vec::new();
    for dir in DIRS {
        for f in repo.files(&[dir])? {
            if f.path.ends_with(".sql") {
                let bytes = std::fs::read(repo.path(&f.path)).map_err(|e| e.to_string())?;
                found.push((f.path, bytes));
            }
        }
    }
    check(&found, PINNED, &mut o);
    let frozen = PINNED.iter().filter(|(_, h)| h.is_some()).count();
    o.summary = format!("{} migrations, {frozen} published", PINNED.len());
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_published_migration_cannot_change_or_go() {
        let a = ("d/0000_a.sql".to_string(), b"one".to_vec());
        let b = ("d/0001_b.sql".to_string(), b"two".to_vec());
        let one = sha256(b"one");
        let mut o = Outcome::default();
        check(
            &[a.clone(), b.clone()],
            &[("d/0000_a.sql", Some(&one)), ("d/0001_b.sql", None)],
            &mut o,
        );
        assert!(o.failures.is_empty(), "{:?}", o.failures);
        let changed = ("d/0000_a.sql".to_string(), b"one!".to_vec());
        let mut o = Outcome::default();
        check(
            &[changed, b.clone()],
            &[("d/0000_a.sql", Some(&one)), ("d/0001_b.sql", None)],
            &mut o,
        );
        assert_eq!(o.failures.len(), 1);
        let mut o = Outcome::default();
        check(
            std::slice::from_ref(&b),
            &[("d/0000_a.sql", Some(&one)), ("d/0001_b.sql", None)],
            &mut o,
        );
        assert_eq!(o.failures.len(), 1, "deleted");
        let mut o = Outcome::default();
        check(&[a, b], &[("d/0000_a.sql", Some(&one))], &mut o);
        assert_eq!(o.failures.len(), 1, "unlisted");
    }
}
