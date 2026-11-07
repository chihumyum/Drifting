//! The sentences the 0.1 client never had, as placeholders.
//!
//! The interface strings so far are the 0.1 client's nine languages (dr-i18n
//! copies them). A sentence it never had has no translation, and none is
//! made up here: until the new client has strings of its own (F6), each
//! shows its key, in index type and secondary ink, so nobody takes it for
//! settled copy. The one exception is the button the author named when the
//! gate was decided (「仍然导入」, D5), in Simplified Chinese.
//!
//! The gate's keys are `dr_import_v1::gate::messages`; the summary's are
//! here. m10-import.md 「待协调」 lists them all with what each should say.

use dr_i18n::Locale;

pub use dr_import_v1::gate::messages::{
    ACTION_DOWNLOAD, ACTION_IMPORT_ANYWAY, BLOCKED_TITLE, CHANGED_AFTER_HANDOFF, GET_LAST_RELEASE,
    NO_HANDOFF, STALE, SYNC, UNPROVEN,
};

/// A book this device imported before: not imported again.
pub const ALREADY_IMPORTED: &str = "import.v1.summary.already_imported";
/// A book already in the library without this device's receipt (synced in,
/// or made here): left alone.
pub const ALREADY_IN_LIBRARY: &str = "import.v1.summary.already_in_library";
/// `{count}` bodies were imported from their caches (「仍然导入」) and may
/// lack their last seconds of typing.
pub const FROM_CACHES: &str = "import.v1.summary.from_caches";
/// `{count}` account libraries in the chosen folder were left alone; they
/// are imported with accounts (M35).
pub const ACCOUNT_LIBRARIES_LEFT: &str = "import.v1.summary.account_libraries_left";

/// Every placeholder the dialogs show.
pub const ALL: [&str; 13] = [
    BLOCKED_TITLE,
    NO_HANDOFF,
    UNPROVEN,
    STALE,
    CHANGED_AFTER_HANDOFF,
    SYNC,
    GET_LAST_RELEASE,
    ACTION_DOWNLOAD,
    ACTION_IMPORT_ANYWAY,
    ALREADY_IMPORTED,
    ALREADY_IN_LIBRARY,
    FROM_CACHES,
    ACCOUNT_LIBRARIES_LEFT,
];

/// The text the author settled for a placeholder in `locale`, if any.
pub fn settled(key: &str, locale: Locale) -> Option<&'static str> {
    match (key, locale) {
        (ACTION_IMPORT_ANYWAY, Locale::ZhCn) => Some("仍然导入"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_placeholder_is_an_import_key_and_listed_once() {
        let mut seen = std::collections::BTreeSet::new();
        for key in ALL {
            assert!(key.starts_with("import.v1."), "{key}");
            assert!(seen.insert(key), "{key} twice");
        }
        assert_eq!(
            settled(ACTION_IMPORT_ANYWAY, Locale::ZhCn),
            Some("仍然导入")
        );
        assert_eq!(settled(ACTION_IMPORT_ANYWAY, Locale::En), None);
        assert_eq!(settled(BLOCKED_TITLE, Locale::ZhCn), None);
    }
}
