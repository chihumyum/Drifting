//! The sentences the 0.1 client never had: the new client's own strings
//! (dr-i18n's `own/`, in all nine languages), looked up by the keys the gate
//! and the summary use. The gate's keys are `dr_import_v1::gate::messages`;
//! the summary's are here.

use dr_i18n::keys::import::v1 as k;
use dr_shell::strings::{t, tp};
use gpui::{App, SharedString};

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
/// A book the import stopped in the middle of (the app quit): importing the
/// same library again carries it on.
pub const CARRIES_ON: &str = "import.v1.summary.carries_on";

/// Every sentence the dialogs show from the new client's strings.
pub const ALL: [&str; 14] = [
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
    CARRIES_ON,
];

/// The sentence for `key`, with `count` filled in where it has one.
pub fn text(key: &str, count: Option<usize>, cx: &App) -> SharedString {
    let n = count.unwrap_or(0) as u64;
    match key {
        BLOCKED_TITLE => t(cx, k::blocked::TITLE),
        NO_HANDOFF => t(cx, k::blocked::NO_HANDOFF),
        UNPROVEN => tp(cx, k::blocked::UNPROVEN, n, &[]),
        STALE => tp(cx, k::blocked::STALE, n, &[]),
        CHANGED_AFTER_HANDOFF => tp(cx, k::blocked::CHANGED_AFTER_HANDOFF, n, &[]),
        SYNC => t(cx, k::blocked::SYNC),
        GET_LAST_RELEASE => t(cx, k::blocked::GET_LAST_RELEASE),
        ACTION_DOWNLOAD => t(cx, k::action::DOWNLOAD_LAST_RELEASE),
        ACTION_IMPORT_ANYWAY => t(cx, k::action::IMPORT_ANYWAY),
        ALREADY_IMPORTED => t(cx, k::summary::ALREADY_IMPORTED),
        ALREADY_IN_LIBRARY => t(cx, k::summary::ALREADY_IN_LIBRARY),
        FROM_CACHES => tp(cx, k::summary::FROM_CACHES, n, &[]),
        ACCOUNT_LIBRARIES_LEFT => tp(cx, k::summary::ACCOUNT_LIBRARIES_LEFT, n, &[]),
        CARRIES_ON => t(cx, k::summary::CARRIES_ON),
        other => other.to_owned().into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_sentence_is_an_import_key_listed_once_with_its_words() {
        let mut seen = std::collections::BTreeSet::new();
        for key in ALL {
            assert!(key.starts_with("import.v1."), "{key}");
            assert!(seen.insert(key), "{key} twice");
        }
        let zh = dr_i18n::I18n::new(dr_i18n::Locale::ZhCn, dr_i18n::Platform::Mac);
        assert_eq!(zh.t(k::action::IMPORT_ANYWAY), "仍然导入");
        let en = dr_i18n::I18n::new(dr_i18n::Locale::En, dr_i18n::Platform::Mac);
        assert_eq!(
            en.plural(k::blocked::STALE, 1, &[]),
            "1 chapter is older than what you wrote"
        );
        assert_eq!(
            en.plural(k::blocked::STALE, 3, &[]),
            "3 chapters are older than what you wrote"
        );
    }
}
