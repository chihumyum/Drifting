//! The settings file: `settings.json` in the app's data folder.
//!
//! ```json
//! { "version": 1,
//!   "device":  { "appearance.interface_text_size": "large", ...,
//!                "modules": { "shelf.cover_style": "topo", ... } },
//!   "account": { "appearance.theme": "dark", "keys.bindings": { ... }, ... },
//!   "books":   { "<book id>": { "settings": { ... }, "layout": { ... },
//!                               "export": { ... } } },
//!   "last_book": "<book id>" }
//! ```
//!
//! - Values are checked against the registry when read: a value of the wrong
//!   type or out of range reads as the default and is left for the next write
//!   to replace, so a file from a newer build is not destroyed.
//! - Keys the registry does not know are kept as they are (a newer build's).
//! - A book's local layout (its tabs, sidebars, view modes; loro-schema.md
//!   「不进书目文档的：本机布局」) is kept under its book id, opaque here.
//! - What the export dialog remembers (M41; the 0.1 client's
//!   `drifting.manuscriptExport.v1`) is not a setting with a row: the
//!   author's name is the account value `export.author`, each book's
//!   choices its `export` entry. Not checked here either (dr-view-export
//!   reads them).
//! - What a module keeps on this device that is no setting (no row in the
//!   panel, nothing the registry checks: the shelf's cover style, the
//!   guides seen, the Markdown folder) sits in the device entry's `modules`
//!   object ([`SettingsFile::device_memory`]). Never synced.
//! - Writes replace the file atomically (write a sibling, flush, rename), so
//!   a crash leaves the old file or the new one. A file that cannot be read
//!   is moved aside, never overwritten.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::registry::{self, Initial, Scope, SettingDef};

pub const FILE_NAME: &str = "settings.json";
const VERSION: u64 = 1;
/// The account value that holds rebound shortcuts (action id → keystrokes).
pub const KEY_BINDINGS: &str = "keys.bindings";
/// The top-level entry naming the book opened last.
const LAST_BOOK: &str = "last_book";
/// The account value: the author's name the export dialog last used.
pub const EXPORT_AUTHOR: &str = "export.author";
/// A book's entry: its export choices (format, title switches, title).
const BOOK_EXPORT: &str = "export";
/// The device entry's object of module values.
const DEVICE_MODULES: &str = "modules";

#[derive(Debug)]
pub struct SettingsFile {
    path: Option<PathBuf>,
    data: Map<String, Value>,
    dirty: bool,
}

impl SettingsFile {
    /// Only in memory (tests, and when there is no data folder).
    pub fn in_memory() -> SettingsFile {
        SettingsFile {
            path: None,
            data: fresh(),
            dirty: false,
        }
    }

    /// Reads `dir/settings.json`. A missing file is an empty one; a file that
    /// is not ours is moved to `settings.json.unreadable-<unix time>`.
    pub fn open(dir: &Path) -> SettingsFile {
        let path = dir.join(FILE_NAME);
        let data = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(Value::Object(map)) => map,
                _ => {
                    let stamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let aside = dir.join(format!("{FILE_NAME}.unreadable-{stamp}"));
                    match std::fs::rename(&path, &aside) {
                        Ok(()) => log::warn!("settings file unreadable; moved it aside"),
                        Err(error) => log::error!("settings file unreadable and stuck: {error}"),
                    }
                    fresh()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => fresh(),
            Err(error) => {
                log::error!("cannot read the settings file: {error}");
                fresh()
            }
        };
        SettingsFile {
            path: Some(path),
            data,
            dirty: false,
        }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    fn scope_map(&self, scope: Scope, book: Option<&str>) -> Option<&Map<String, Value>> {
        match scope {
            Scope::Device => self.data.get("device")?.as_object(),
            Scope::Account => self.data.get("account")?.as_object(),
            Scope::Book => self
                .data
                .get("books")?
                .get(book?)?
                .get("settings")?
                .as_object(),
        }
    }

    fn scope_map_mut(
        &mut self,
        scope: Scope,
        book: Option<&str>,
    ) -> Option<&mut Map<String, Value>> {
        let node = match scope {
            Scope::Device => object_at(&mut self.data, "device"),
            Scope::Account => object_at(&mut self.data, "account"),
            Scope::Book => {
                let books = object_at(&mut self.data, "books");
                let entry = object_at(books, book?);
                object_at(entry, "settings")
            }
        };
        Some(node)
    }

    /// The stored value of `def`, if any and valid.
    pub fn stored(&self, def: &SettingDef, book: Option<&str>) -> Option<Value> {
        let raw = self.scope_map(def.scope, book)?.get(def.key)?;
        def.validate(raw)
    }

    /// The value of `def`: stored, else its default (`Null` when computed).
    pub fn value(&self, def: &SettingDef, book: Option<&str>) -> Value {
        self.stored(def, book)
            .unwrap_or_else(|| def.default_value())
    }

    pub fn get(&self, key: &str) -> Value {
        match registry::find(key) {
            Some(def) => self.value(def, None),
            None => Value::Null,
        }
    }

    pub fn bool(&self, key: &str) -> bool {
        self.get(key).as_bool().unwrap_or(false)
    }

    pub fn str(&self, key: &str) -> Option<String> {
        self.get(key).as_str().map(str::to_owned)
    }

    pub fn number(&self, key: &str) -> f64 {
        self.get(key).as_f64().unwrap_or(0.0)
    }

    /// Sets `key`. Returns whether it changed; an invalid value is refused.
    pub fn set(&mut self, key: &str, value: Value, book: Option<&str>) -> Result<bool, SetError> {
        let def = registry::find(key).ok_or(SetError::Unknown)?;
        let value = def.validate(&value).ok_or(SetError::Invalid)?;
        if self.stored(def, book).as_ref() == Some(&value) {
            return Ok(false);
        }
        let map = self
            .scope_map_mut(def.scope, book)
            .ok_or(SetError::NoBook)?;
        map.insert(def.key.to_owned(), value);
        self.dirty = true;
        Ok(true)
    }

    /// Back to the default.
    pub fn reset(&mut self, key: &str, book: Option<&str>) -> bool {
        let Some(def) = registry::find(key) else {
            return false;
        };
        let removed = self
            .scope_map_mut(def.scope, book)
            .and_then(|map| map.remove(def.key))
            .is_some();
        self.dirty |= removed;
        removed
    }

    /// Whether `def` differs from its default.
    pub fn is_changed(&self, def: &SettingDef, book: Option<&str>) -> bool {
        self.stored(def, book)
            .is_some_and(|v| def.default == Initial::Computed || v != def.default_value())
    }

    /// Rebound shortcuts: action id → keystrokes ("" unbinds).
    pub fn key_bindings(&self) -> Map<String, Value> {
        self.scope_map(Scope::Account, None)
            .and_then(|m| m.get(KEY_BINDINGS))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    }

    pub fn set_key_binding(&mut self, id: &str, keystrokes: Option<&str>) -> bool {
        let account = object_at(&mut self.data, "account");
        let bindings = object_at(account, KEY_BINDINGS);
        let changed = match keystrokes {
            Some(k) => bindings.insert(id.to_owned(), Value::from(k)) != Some(Value::from(k)),
            None => bindings.remove(id).is_some(),
        };
        self.dirty |= changed;
        changed
    }

    pub fn reset_key_bindings(&mut self) -> bool {
        let account = object_at(&mut self.data, "account");
        let changed = account.remove(KEY_BINDINGS).is_some();
        self.dirty |= changed;
        changed
    }

    /// A book's saved local layout.
    pub fn layout(&self, book: &str) -> Option<&Value> {
        self.data.get("books")?.get(book)?.get("layout")
    }

    pub fn set_layout(&mut self, book: &str, layout: Value) {
        let books = object_at(&mut self.data, "books");
        let entry = object_at(books, book);
        if entry.get("layout") != Some(&layout) {
            entry.insert("layout".into(), layout);
            self.dirty = true;
        }
    }

    /// The author's name the export dialog last used.
    pub fn export_author(&self) -> Option<&str> {
        self.scope_map(Scope::Account, None)?
            .get(EXPORT_AUTHOR)?
            .as_str()
    }

    /// Remembers the export's author name (empty forgets it).
    pub fn set_export_author(&mut self, name: &str) -> bool {
        if self.export_author().unwrap_or("") == name {
            return false;
        }
        let account = object_at(&mut self.data, "account");
        if name.is_empty() {
            account.remove(EXPORT_AUTHOR);
        } else {
            account.insert(EXPORT_AUTHOR.into(), Value::from(name));
        }
        self.dirty = true;
        true
    }

    /// What a module keeps on this device under `key` (not a setting).
    pub fn device_memory(&self, key: &str) -> Option<&Value> {
        self.data.get("device")?.get(DEVICE_MODULES)?.get(key)
    }

    /// Keeps `value` on this device under `key` (`None` forgets it).
    /// Returns whether anything changed.
    pub fn set_device_memory(&mut self, key: &str, value: Option<Value>) -> bool {
        if self.device_memory(key) == value.as_ref() {
            return false;
        }
        let device = object_at(&mut self.data, "device");
        let modules = object_at(device, DEVICE_MODULES);
        match value {
            Some(value) => {
                modules.insert(key.to_owned(), value);
            }
            None => {
                modules.remove(key);
            }
        }
        self.dirty = true;
        true
    }

    /// Every book's remembered export choices (book id, as stored).
    pub fn book_exports(&self) -> Vec<(String, Value)> {
        let Some(books) = self.data.get("books").and_then(Value::as_object) else {
            return Vec::new();
        };
        books
            .iter()
            .filter_map(|(id, entry)| Some((id.clone(), entry.get(BOOK_EXPORT)?.clone())))
            .collect()
    }

    /// Remembers a book's export choices.
    pub fn set_book_export(&mut self, book: &str, choices: Value) -> bool {
        let books = object_at(&mut self.data, "books");
        let entry = object_at(books, book);
        if entry.get(BOOK_EXPORT) == Some(&choices) {
            return false;
        }
        entry.insert(BOOK_EXPORT.into(), choices);
        self.dirty = true;
        true
    }

    /// The book this device opened last (the workspace opens it again).
    pub fn last_book(&self) -> Option<&str> {
        self.data.get(LAST_BOOK)?.as_str()
    }

    pub fn set_last_book(&mut self, book: &str) {
        if self.last_book() != Some(book) {
            self.data.insert(LAST_BOOK.into(), Value::from(book));
            self.dirty = true;
        }
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Writes the file if anything changed. Atomic: a sibling file is written
    /// and flushed, then renamed over the old one.
    pub fn save(&mut self) -> std::io::Result<()> {
        if !self.dirty {
            return Ok(());
        }
        let Some(path) = &self.path else {
            self.dirty = false;
            return Ok(());
        };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        self.data.insert("version".into(), Value::from(VERSION));
        let mut bytes = serde_json::to_vec_pretty(&Value::Object(self.data.clone()))?;
        bytes.push(b'\n');
        let tmp = path.with_extension("json.tmp");
        {
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, path)?;
        self.dirty = false;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetError {
    Unknown,
    Invalid,
    NoBook,
}

fn fresh() -> Map<String, Value> {
    match json!({ "version": VERSION }) {
        Value::Object(map) => map,
        _ => unreachable!(),
    }
}

/// `map[key]` as an object, made one if it is missing or not an object.
fn object_at<'a>(map: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let slot = map
        .entry(key.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !slot.is_object() {
        *slot = Value::Object(Map::new());
    }
    slot.as_object_mut().expect("just made an object")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::registry::{CRASH_REPORTS, FONT_SIZE, TEXT_SIZE, THEME};

    #[test]
    fn values_round_trip_through_the_file_by_scope() {
        let dir = tempfile::tempdir().unwrap();
        let mut file = SettingsFile::open(dir.path());
        assert_eq!(file.get(THEME), Value::from("system"));
        assert!(file.set(THEME, Value::from("dark"), None).unwrap());
        assert!(!file.set(THEME, Value::from("dark"), None).unwrap());
        assert!(file.set(TEXT_SIZE, Value::from("large"), None).unwrap());
        assert!(file.set(FONT_SIZE, Value::from(40), None).unwrap());
        file.set_layout("book-1", json!({ "left": { "open": true } }));
        file.save().unwrap();
        assert!(!file.is_dirty());

        let again = SettingsFile::open(dir.path());
        assert_eq!(again.get(THEME), Value::from("dark"));
        assert_eq!(again.number(FONT_SIZE), 28.0, "clamped to the range");
        assert_eq!(again.layout("book-1").unwrap()["left"]["open"], true);
        let raw: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(raw["account"][THEME], "dark");
        assert_eq!(raw["device"][TEXT_SIZE], "large");
        assert_eq!(raw["version"], 1);
    }

    #[test]
    fn invalid_values_are_refused_and_bad_stored_ones_read_as_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(FILE_NAME),
            r#"{"version":1,"account":{"appearance.theme":"sepia","future.key":3}}"#,
        )
        .unwrap();
        let mut file = SettingsFile::open(dir.path());
        assert_eq!(file.get(THEME), Value::from("system"));
        assert_eq!(
            file.set(THEME, Value::from(1), None),
            Err(SetError::Invalid)
        );
        assert_eq!(
            file.set("nope", Value::from(1), None),
            Err(SetError::Unknown)
        );
        file.set(CRASH_REPORTS, Value::from(false), None).unwrap();
        file.save().unwrap();
        let raw: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(
            raw["account"]["future.key"], 3,
            "a newer build's key is kept"
        );
    }

    #[test]
    fn an_unreadable_file_is_moved_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE_NAME), b"{ not json").unwrap();
        let mut file = SettingsFile::open(dir.path());
        assert_eq!(file.get(THEME), Value::from("system"));
        let aside: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("unreadable"))
            .collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(std::fs::read(aside[0].path()).unwrap(), b"{ not json");
        file.set(THEME, Value::from("light"), None).unwrap();
        file.save().unwrap();
        assert!(SettingsFile::open(dir.path()).get(THEME) == "light");
    }

    #[test]
    fn shortcuts_rebind_and_reset() {
        let mut file = SettingsFile::in_memory();
        assert!(file.set_key_binding("goBack", Some("cmd-alt-left")));
        assert!(!file.set_key_binding("goBack", Some("cmd-alt-left")));
        assert_eq!(file.key_bindings()["goBack"], "cmd-alt-left");
        assert!(file.set_key_binding("goBack", None));
        file.set_key_binding("nextTab", Some(""));
        assert!(file.reset_key_bindings());
        assert!(file.key_bindings().is_empty());
    }

    #[test]
    fn reset_returns_to_the_default() {
        let mut file = SettingsFile::in_memory();
        let theme = registry::find(THEME).unwrap();
        file.set(THEME, Value::from("dark"), None).unwrap();
        assert!(file.is_changed(theme, None));
        assert!(file.reset(THEME, None));
        assert!(!file.is_changed(theme, None));
        assert_eq!(file.get(THEME), "system");
    }

    #[test]
    fn the_export_choices_are_kept_beside_the_settings() {
        let mut file = SettingsFile::in_memory();
        assert_eq!(file.export_author(), None);
        assert!(file.set_export_author("沈知微"));
        assert!(!file.set_export_author("沈知微"), "unchanged");
        let choices =
            serde_json::json!({"format": "pdf", "actTitles": true, "chapterTitles": false});
        assert!(file.set_book_export("book-1", choices.clone()));
        assert!(!file.set_book_export("book-1", choices.clone()));
        assert_eq!(file.book_exports(), vec![("book-1".to_owned(), choices)]);
        // The book's layout and settings live beside it, untouched.
        file.set_layout("book-1", serde_json::json!({"x": 1}));
        assert_eq!(file.book_exports().len(), 1);
        assert!(file.set_export_author(""));
        assert_eq!(file.export_author(), None);
    }
}
