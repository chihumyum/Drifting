//! Measured evidence (simplifications.md §5): every file in
//! `docs/rust-rewrite/acceptance/` is either valid `dr-testkit` evidence
//! (fresh, or stale and reported) or a legacy file its owner still checks
//! with its own program. Invalid evidence fails.

use dr_testkit::evidence::{Status, check_dir};

use super::Outcome;
use crate::repo::Repo;

pub const DIR: &str = "docs/rust-rewrite/acceptance";

pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let mut o = Outcome::default();
    let checked = check_dir(&repo.next, &repo.path(DIR)).map_err(|e| e.to_string())?;
    let (mut fresh, mut stale, mut legacy) = (0, 0, Vec::new());
    for c in &checked {
        match &c.status {
            Status::Fresh => fresh += 1,
            Status::Stale(inputs) => {
                stale += 1;
                o.note(format!(
                    "{DIR}/{}: stale (taken before changes to {}); rerun its bench at the next milestone",
                    c.file,
                    inputs.join(", ")
                ));
            }
            Status::Legacy => legacy.push(c.file.as_str()),
            Status::Invalid(why) => o.fail(format!("{DIR}/{}: {why}", c.file)),
        }
    }
    if !legacy.is_empty() {
        o.note(format!(
            "{} legacy files, checked by their own programs until moved to dr-testkit: {}",
            legacy.len(),
            legacy.join(", ")
        ));
    }
    o.summary = format!(
        "{fresh} fresh, {stale} stale, {} legacy, {} files",
        legacy.len(),
        checked.len()
    );
    Ok(o)
}
