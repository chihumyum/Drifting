//! No binary file over 1 MiB (fonts and other large assets are build
//! products, not commits).

use super::Outcome;
use crate::repo::{Repo, is_binary};

pub const LIMIT: u64 = 1024 * 1024;

pub fn run(repo: &Repo) -> Result<Outcome, String> {
    let mut o = Outcome::default();
    let files = repo.files(super::privacy::SCOPE)?;
    let mut binaries = 0;
    for f in &files {
        let path = repo.path(&f.path);
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let head = {
            use std::io::Read;
            let mut buf = vec![0u8; 8000];
            let n = std::fs::File::open(&path)
                .and_then(|mut file| file.read(&mut buf))
                .unwrap_or(0);
            buf.truncate(n);
            buf
        };
        if !is_binary(&head) {
            continue;
        }
        binaries += 1;
        if size > LIMIT {
            o.fail(format!(
                "{}: binary file of {:.1} MiB (limit 1 MiB): build it instead of committing it",
                f.path,
                size as f64 / LIMIT as f64
            ));
        }
    }
    o.summary = format!("{binaries} binary files of {}", files.len());
    Ok(o)
}
