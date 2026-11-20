//! Who this build says it is: dr-platform's [`Identity::current`], the
//! development identity unless the release workflow built it with the
//! `release-identity` feature. A development build runs beside the installed
//! Drifting, so it must never claim the release identity: a shared bundle id
//! would mix up Launch Services, the keychain, the updater and the app's
//! data folder.

use dr_platform::Identity;

/// The name in the menu bar, the Dock and the About window.
pub const APP_NAME: &str = Identity::current().product_name;

/// The bundle id; `script/bundle-mac` writes the same value.
pub const BUNDLE_ID: &str = Identity::current().bundle_id;

/// `0.2.0-dev`, plus the commit when `script/bundle-mac` built it.
pub fn version() -> String {
    let version = env!("CARGO_PKG_VERSION");
    match option_env!("DRIFTING_BUILD_COMMIT") {
        Some(commit) if !commit.is_empty() => format!("{version} ({commit})"),
        _ => version.to_owned(),
    }
}

// What must never ship comes with what a release must never have: a build
// with the release identity does not compile with either.
#[cfg(feature = "hot-reload")]
const _: () = assert!(
    !dr_platform::identity::RELEASE_BUILD,
    "GPUI's hot reload never ships: not with the release identity"
);
#[cfg(feature = "debug-bridge")]
const _: () = assert!(
    !dr_platform::identity::RELEASE_BUILD,
    "the debug bridge never ships: not with the release identity"
);

#[cfg(test)]
mod tests {
    use super::*;
    use dr_platform::identity::{DEVELOPMENT, RELEASE, RELEASE_BUILD};

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
        let (bundle_id, app_name) = if RELEASE_BUILD {
            ("RELEASE_BUNDLE_ID", "RELEASE_APP_NAME")
        } else {
            ("BUNDLE_ID", "APP_NAME")
        };
        assert_eq!(script_value(bundle_id), BUNDLE_ID);
        assert_eq!(script_value(app_name), APP_NAME);
    }

    #[test]
    fn the_app_runs_under_the_identity_of_its_build() {
        let expected = if RELEASE_BUILD {
            &RELEASE
        } else {
            &DEVELOPMENT
        };
        assert_eq!(BUNDLE_ID, expected.bundle_id);
        assert_eq!(APP_NAME, expected.product_name);
    }

    #[cfg(not(feature = "release-identity"))]
    #[test]
    fn the_development_build_never_claims_the_release_identity() {
        assert_ne!(BUNDLE_ID, RELEASE.bundle_id);
        assert_ne!(APP_NAME, RELEASE.product_name);
    }
}
