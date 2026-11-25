//! Prose font resolution and custom font file import (`.ttf`, `.otf`,
//! `.woff`, `.woff2`) for M08 Editor Settings.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use dr_i18n::{Key, keys};
use dr_ui::fonts::Role;
use gpui::App;

use super::Settings;
use super::registry;

/// Maximum custom font file size (0.1: 64 MiB).
pub const MAX_FONT_BYTES: usize = 64 * 1024 * 1024;
/// Device memory key holding the filename of the imported custom font inside
/// `<app_data_dir>/custom-fonts/`.
pub const CUSTOM_FONT_FILE_KEY: &str = "editor.custom_font_file";
/// Device memory key holding the resolved family name of the imported custom font.
pub const CUSTOM_FONT_FAMILY_KEY: &str = "editor.custom_font_family";

/// Allowed font file extensions.
pub const FONT_EXTENSIONS: &[&str] = &["ttf", "otf", "woff", "woff2"];

/// Resolves the active prose font family name according to `editor.font_source`
/// and `editor.font_family`. `None` uses the theme's default `Role::Prose`
/// (`Drifting Serif`).
pub fn resolved_prose_family(cx: &App) -> Option<String> {
    let file = Settings::read(cx);
    match file.str(registry::FONT_SOURCE).as_deref() {
        Some("system-sans") => Some(Role::Ui.family().to_owned()),
        Some("system-mono") => Some(Role::Index.family().to_owned()),
        Some("system") => file
            .str(registry::FONT_FAMILY)
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty()),
        Some("custom") => Settings::device_memory(cx, CUSTOM_FONT_FAMILY_KEY)
            .and_then(|v| v.as_str().map(str::to_owned))
            .filter(|s| !s.is_empty())
            .or_else(|| {
                file.str(registry::FONT_FAMILY)
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
            }),
        _ => None,
    }
}

/// Directory storing imported custom font copies, next to `settings.json`.
pub fn custom_fonts_dir(cx: &App) -> Option<PathBuf> {
    Settings::read(cx)
        .path()
        .and_then(Path::parent)
        .map(|dir| dir.join("custom-fonts"))
}

/// Currently imported custom font `(file_name, family_name)`, if any.
pub fn imported_custom_font(cx: &App) -> Option<(String, String)> {
    let file = Settings::device_memory(cx, CUSTOM_FONT_FILE_KEY)?
        .as_str()?
        .to_owned();
    let family = Settings::device_memory(cx, CUSTOM_FONT_FAMILY_KEY)
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| file.clone());
    (!file.is_empty()).then_some((file, family))
}

/// Loads any previously imported custom font from disk into GPUI's text system.
pub fn load_persisted_custom_font(cx: &App) {
    let Some((file_name, _)) = imported_custom_font(cx) else {
        return;
    };
    let Some(dir) = custom_fonts_dir(cx) else {
        return;
    };
    let path = dir.join(&file_name);
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    if let Err(err) = cx.text_system().add_fonts(vec![Cow::Owned(bytes)]) {
        log::warn!(
            "could not reload imported custom font {}: {err:#}",
            path.display()
        );
    }
}

/// Returns sorted unique system font family names known to GPUI's text system.
pub fn system_font_families(cx: &App) -> Vec<String> {
    let mut names: Vec<String> = cx
        .text_system()
        .all_font_names()
        .into_iter()
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}

/// Imports a `.ttf` / `.otf` / `.woff` / `.woff2` file from `source`, persists
/// a copy in `<app_data_dir>/custom-fonts/`, registers it with GPUI's text
/// system, and switches `editor.font_source` to `"custom"`.
pub fn import_font_file(source: &Path, cx: &mut App) -> Result<String, Key> {
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !FONT_EXTENSIONS.contains(&ext.as_str()) {
        return Err(keys::settings::editor::FONT_ERROR_FORMAT);
    }
    let meta = std::fs::metadata(source).map_err(|_| keys::settings::editor::FONT_ERROR_INVALID)?;
    if meta.len() == 0 {
        return Err(keys::settings::editor::FONT_ERROR_EMPTY);
    }
    if meta.len() as usize > MAX_FONT_BYTES {
        return Err(keys::settings::editor::FONT_ERROR_SIZE);
    }
    let bytes = std::fs::read(source).map_err(|_| keys::settings::editor::FONT_ERROR_INVALID)?;
    if bytes.is_empty() {
        return Err(keys::settings::editor::FONT_ERROR_EMPTY);
    }
    if bytes.len() > MAX_FONT_BYTES {
        return Err(keys::settings::editor::FONT_ERROR_SIZE);
    }

    let fallback_stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Custom Font")
        .trim()
        .to_owned();
    let family = parse_sfnt_family(&bytes).unwrap_or(fallback_stem);

    // Register with GPUI text system first to confirm the font bytes are valid.
    cx.text_system()
        .add_fonts(vec![Cow::Owned(bytes.clone())])
        .map_err(|_| keys::settings::editor::FONT_ERROR_INVALID)?;

    let file_name = format!("custom.{ext}");
    if let Some(dir) = custom_fonts_dir(cx) {
        let _ = std::fs::create_dir_all(&dir);
        // Clean previous custom font files so only the active copy stays on disk.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        if let Err(err) = std::fs::write(dir.join(&file_name), &bytes) {
            log::warn!("could not persist custom font copy: {err}");
        }
    }

    Settings::set_device_memory(cx, CUSTOM_FONT_FILE_KEY, Some(file_name.into()));
    Settings::set_device_memory(cx, CUSTOM_FONT_FAMILY_KEY, Some(family.clone().into()));
    Settings::update(cx, |file| {
        let _ = file.set(registry::FONT_SOURCE, "custom".into(), None);
        let _ = file.set(registry::FONT_FAMILY, family.clone().into(), None);
    });
    Ok(family)
}

/// Removes the persisted custom font copy and switches back to the default serif.
pub fn remove_custom_font(cx: &mut App) {
    if let Some(dir) = custom_fonts_dir(cx)
        && let Ok(entries) = std::fs::read_dir(&dir)
    {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Settings::set_device_memory(cx, CUSTOM_FONT_FILE_KEY, None);
    Settings::set_device_memory(cx, CUSTOM_FONT_FAMILY_KEY, None);
    Settings::update(cx, |file| {
        if file.str(registry::FONT_SOURCE).as_deref() == Some("custom") {
            let _ = file.set(registry::FONT_SOURCE, "system-serif".into(), None);
        }
    });
}

/// Minimal OpenType / TrueType `name` table reader to extract the Typographic
/// Family (nameID 16) or Font Family (nameID 1) from `.ttf`/`.otf` bytes.
pub fn parse_sfnt_family(data: &[u8]) -> Option<String> {
    if data.len() < 12 {
        return None;
    }
    let tag = &data[0..4];
    let is_sfnt = tag == [0, 1, 0, 0] || tag == b"OTTO" || tag == b"true";
    if !is_sfnt {
        return None;
    }
    let u16_at = |at: usize| -> Option<u16> {
        Some(u16::from_be_bytes([*data.get(at)?, *data.get(at + 1)?]))
    };
    let u32_at = |at: usize| -> Option<u32> {
        Some(u32::from_be_bytes([
            *data.get(at)?,
            *data.get(at + 1)?,
            *data.get(at + 2)?,
            *data.get(at + 3)?,
        ]))
    };
    let num_tables = u16_at(4)? as usize;
    let mut name_table = None;
    for i in 0..num_tables {
        let rec = 12 + i * 16;
        if data.get(rec..rec + 4)? == b"name" {
            let offset = u32_at(rec + 8)? as usize;
            let length = u32_at(rec + 12)? as usize;
            name_table = data.get(offset..offset.checked_add(length)?);
            break;
        }
    }
    let tbl = name_table?;
    if tbl.len() < 6 {
        return None;
    }
    let count = u16::from_be_bytes([tbl[2], tbl[3]]) as usize;
    let string_offset = u16::from_be_bytes([tbl[4], tbl[5]]) as usize;
    let mut preferred: Option<String> = None;
    let mut fallback: Option<String> = None;
    for i in 0..count {
        let rec = 6 + i * 12;
        if rec + 12 > tbl.len() {
            break;
        }
        let platform_id = u16::from_be_bytes([tbl[rec], tbl[rec + 1]]);
        let name_id = u16::from_be_bytes([tbl[rec + 6], tbl[rec + 7]]);
        if name_id != 1 && name_id != 16 {
            continue;
        }
        let len = u16::from_be_bytes([tbl[rec + 8], tbl[rec + 9]]) as usize;
        let off = u16::from_be_bytes([tbl[rec + 10], tbl[rec + 11]]) as usize;
        let Some(slice) = tbl.get(string_offset + off..string_offset + off + len) else {
            continue;
        };
        let decoded = match platform_id {
            0 | 3 => {
                if !slice.len().is_multiple_of(2) {
                    continue;
                }
                let units: Vec<u16> = slice
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|c| u16::from_be_bytes([c[0], c[1]]))
                    .collect();
                String::from_utf16(&units).ok()
            }
            1 => std::str::from_utf8(slice).ok().map(str::to_owned),
            _ => None,
        };
        if let Some(name) = decoded
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
        {
            if name_id == 16 && preferred.is_none() {
                preferred = Some(name);
            } else if name_id == 1 && fallback.is_none() {
                fallback = Some(name);
            }
        }
    }
    preferred.or(fallback)
}
