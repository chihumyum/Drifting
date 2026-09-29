//! Portable text ZIP creation. Only caller-supplied text is archived; this
//! module cannot read files, follow symlinks or write an export destination.
use serde::Deserialize;
use std::collections::HashSet;
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;

pub const TEXT_ARCHIVE_LIMIT: usize = 256 * 1024 * 1024;

#[derive(Deserialize)]
pub struct TextArchiveEntry {
    pub path: String,
    pub text: String,
}

pub fn create_text_zip(entries: &[TextArchiveEntry]) -> Result<Vec<u8>, String> {
    let mut paths = HashSet::new();
    let mut total = 0usize;
    for entry in entries {
        if entry.path.is_empty()
            || entry.path.len() > u16::MAX as usize
            || entry.path.contains(['\\', '\0', ':'])
            || entry
                .path
                .split('/')
                .any(|part| matches!(part, "" | "." | ".."))
            || !paths.insert(&entry.path)
        {
            return Err("Archive entries require unique relative file paths".into());
        }
        total = total
            .checked_add(entry.text.len())
            .and_then(|size| size.checked_add(entry.path.len()))
            .ok_or("Archive size overflow")?;
        if total > TEXT_ARCHIVE_LIMIT {
            return Err("Archive text exceeds the 256 MiB export limit".into());
        }
    }
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(6));
    for entry in entries {
        zip.start_file(&entry.path, options)
            .map_err(|error| error.to_string())?;
        zip.write_all(entry.text.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    let bytes = zip
        .finish()
        .map_err(|error| error.to_string())?
        .into_inner();
    if bytes.len() > TEXT_ARCHIVE_LIMIT {
        return Err("Archive exceeds the 256 MiB export limit".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn archive_preserves_utf8_at_chunk_boundaries_and_empty_files() {
        let entries = [
            TextArchiveEntry {
                path: "合成/长章.md".into(),
                text: format!("{}👩🏽‍🚀e\u{301}尾", "a".repeat(16383)),
            },
            TextArchiveEntry {
                path: "empty.md".into(),
                text: String::new(),
            },
        ];
        let mut archive =
            zip::ZipArchive::new(Cursor::new(create_text_zip(&entries).unwrap())).unwrap();
        assert_eq!(archive.len(), 2);
        for entry in entries {
            let mut text = String::new();
            archive
                .by_name(&entry.path)
                .unwrap()
                .read_to_string(&mut text)
                .unwrap();
            assert_eq!(text, entry.text);
        }
    }

    #[test]
    fn invalid_paths_and_duplicates_are_rejected() {
        for path in [
            "",
            "/abs.md",
            "../outside.md",
            "a/../b",
            "a//b",
            "a\\b",
            "C:foo",
            "a\0b",
        ] {
            assert!(create_text_zip(&[TextArchiveEntry {
                path: path.into(),
                text: String::new()
            }])
            .is_err());
        }
        assert!(create_text_zip(&[
            TextArchiveEntry {
                path: "a".into(),
                text: String::new()
            },
            TextArchiveEntry {
                path: "a".into(),
                text: String::new()
            }
        ])
        .is_err());
    }
}
