//! Who this build says it is. Until the switch-over (F7) the rewrite runs
//! beside the installed Drifting, so it must never claim the release identity:
//! a shared bundle id would mix up Launch Services, the keychain, the updater
//! and the app's data folder.

/// The name in the menu bar, the Dock and the About window.
pub const APP_NAME: &str = "Drifting Next";

/// The development bundle id. `script/bundle-mac` writes the same value.
pub const BUNDLE_ID: &str = "cc.drifting.next.dev";

/// The release client's bundle id, which only F7's hand-over may adopt.
#[cfg(test)]
const RELEASE_BUNDLE_ID: &str = "cc.drifting.client";

/// `0.2.0-dev`, plus the commit when `script/bundle-mac` built it.
pub fn version() -> String {
    let version = env!("CARGO_PKG_VERSION");
    match option_env!("DRIFTING_BUILD_COMMIT") {
        Some(commit) if !commit.is_empty() => format!("{version} ({commit})"),
        _ => version.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLE_SCRIPT: &str = include_str!("../../../script/bundle-mac");

    fn script_value(name: &str) -> &'static str {
        let prefix = format!("{name}=");
        BUNDLE_SCRIPT
            .lines()
            .find_map(|line| line.trim().strip_prefix(prefix.as_str()))
            .unwrap_or_else(|| panic!("script/bundle-mac sets {name}"))
            .trim_matches('"')
    }

    #[test]
    fn the_bundle_script_and_the_app_agree_on_the_identity() {
        assert_eq!(script_value("BUNDLE_ID"), BUNDLE_ID);
        assert_eq!(script_value("APP_NAME"), APP_NAME);
    }

    #[test]
    fn the_development_build_never_claims_the_release_identity() {
        assert_ne!(BUNDLE_ID, RELEASE_BUNDLE_ID);
        assert!(!BUNDLE_SCRIPT.contains(RELEASE_BUNDLE_ID));
    }
}
