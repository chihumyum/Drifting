//! File names to suggest and the write of a finished export.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::manuscript::Format;

/// A title as a file stem: characters a file system refuses become `-`,
/// leading and trailing dots and spaces go, at most 35 characters (well
/// under every file system's limit, even for CJK or emoji); `Drifting` when
/// nothing is left. 0.1's `manuscriptFilename` / `markdownShareFilename`.
pub fn readable_stem(title: &str) -> String {
    let safe: String = title
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = safe.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let stem = if trimmed.is_empty() {
        "Drifting"
    } else {
        trimmed
    };
    stem.chars().take(35).collect()
}

/// `<title>.<epub|docx|pdf>` for the save panel.
pub fn manuscript_filename(title: &str, format: Format) -> String {
    format!("{}.{}", readable_stem(title), format.extension())
}

/// Writes `bytes` to `path` whole or not at all: a temporary file next to
/// it, flushed to disk, then renamed over the target. A failed write leaves
/// an existing file as it was.
pub fn write_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    let temp = dir.join(format!(
        ".{}.{}-{}.part",
        name.to_string_lossy(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| {
        let mut file: File = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manuscript::valid_filename;

    #[test]
    fn suggested_names_are_valid_single_segments() {
        for title in [
            "雾港来信",
            "a/b\\c:d*e?f\"g<h>i|j",
            "  .隐藏.  ",
            "",
            "\u{1}控制",
            &"长".repeat(80),
            &"👩🏽‍🚀".repeat(20),
        ] {
            for format in Format::ALL {
                let name = manuscript_filename(title, format);
                assert!(valid_filename(&name, format), "{title:?} → {name:?}");
            }
        }
        assert_eq!(manuscript_filename("雾港来信", Format::Pdf), "雾港来信.pdf");
        assert_eq!(manuscript_filename("  ", Format::Epub), "Drifting.epub");
    }

    #[test]
    fn writes_whole_files_and_replaces_old_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("书稿.epub");
        write_file(&path, b"first").unwrap();
        write_file(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        let left: Vec<_> = fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(left.len(), 1, "no temporary file is left behind");
        assert!(write_file(&dir.path().join("missing/书稿.epub"), b"x").is_err());
    }
}
