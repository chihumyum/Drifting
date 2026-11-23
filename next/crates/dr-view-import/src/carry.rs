//! Once a 0.1 import is the open library (`m10-import.md`, 「0.1 的设置、
//! 快捷键和工作记忆（2026-11-21）」): the settings and shortcuts 0.1 kept on
//! this device come into this client's, once per device, into the keys the
//! author has not set here (nor this client's preference sync changed).
//! What became of each 0.1 value is recorded beside the import's receipt.
//! Each book's working memory came over before, in the import's worker
//! (`dr_import_v1::carry::carry_working_memory`).

use std::collections::BTreeSet;
use std::path::Path;

use dr_import_v1::carry::{self, Row};
use dr_shell::Settings;
use dr_shell::settings::v1;
use gpui::App;

/// Device value: this device took over the 0.1 settings and shortcuts.
pub const ADOPTED: &str = "import.v1_settings_adopted";

fn row(r: v1::Carried) -> Row {
    let json = |v: Option<serde_json::Value>| v.map(|v| v.to_string());
    Row {
        kind: r.kind.into(),
        old_key: r.old_key,
        new_key: r.new_key,
        outcome: r.outcome.as_str().into(),
        old_value: json(r.old_value),
        new_value: json(r.new_value),
        detail: r.detail,
        label: None,
    }
}

/// Takes over the 0.1 settings and shortcuts the import of the library at
/// `root` kept, unless this device has done so already. A library whose
/// 0.1 hand-over captured none leaves it for a later import.
pub fn adopt_settings(root: &Path, cx: &mut App) {
    if !cx.has_global::<Settings>() || Settings::device_memory(cx, ADOPTED).is_some() {
        return;
    }
    let entries = match carry::captured_settings(root) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!("the 0.1 settings the import kept cannot be read: {error}");
            return;
        }
    };
    if !v1::has_captured(&entries) {
        return;
    }
    let os = cx.platform_info().os;
    let system = dr_i18n::Locale::from_system().code();
    let carried = Settings::update(cx, |file| {
        let read: &dr_shell::SettingsFile = file;
        let stamped: BTreeSet<&str> = dr_view_account::synced_preference_keys()
            .into_iter()
            .filter(|key| dr_view_account::has_synced_change(read, key))
            .collect();
        let here = v1::Here {
            os,
            system_locale: system,
            stamped: &|key: &str| stamped.contains(key),
        };
        let carried = v1::adopt(file, &entries, &here);
        file.set_device_memory(ADOPTED, Some(serde_json::Value::Bool(true)));
        carried
    });
    let bindings = Settings::read(cx).key_bindings();
    dr_shell::keymap::apply(&bindings, cx);
    let adopted = carried
        .iter()
        .filter(|r| matches!(r.outcome, v1::Outcome::Adopted | v1::Outcome::Clamped))
        .count();
    log::info!(
        "took over {adopted} of the 0.1 settings and shortcuts ({} looked at)",
        carried.len()
    );
    let rows: Vec<Row> = carried.into_iter().map(row).collect();
    if let Err(error) = carry::record(root, &rows) {
        log::warn!("what the 0.1 settings became is not recorded: {error}");
    }
}
