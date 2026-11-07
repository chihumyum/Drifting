//! Who a build says it is to the operating system: bundle id, product name,
//! URL scheme, keychain service and Windows publisher.
//!
//! Until the hand-over (docs/rust-rewrite/foundations/f7-platform.md) every
//! `next/` build is [`DEVELOPMENT`], so it runs beside an installed Drifting
//! without sharing its Launch Services entry, `drifting:` links, keychain
//! items, data folder or installer registry keys. [`RELEASE`] records the
//! identity the 0.1 Tauri client already owns, which the hand-over adopts
//! unchanged.

/// Development builds and the release build behave differently in a few
/// places: crash reports are off in development unless asked for, and only a
/// release build may take over the 0.1 client's identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Development,
    Release,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub channel: Channel,
    /// macOS `CFBundleIdentifier`; also the data, log and crash folder name
    /// on both platforms, and the Windows AppUserModelID.
    pub bundle_id: &'static str,
    /// The name in the menu bar, the Dock, the Start menu and the Windows
    /// install folder (`%LOCALAPPDATA%\<product_name>`).
    pub product_name: &'static str,
    /// `Contents/MacOS/<executable>` and `<executable>.exe`.
    pub executable: &'static str,
    /// The URL scheme the bundle and the installer register.
    pub url_scheme: &'static str,
    /// The keychain service (macOS) and target suffix (Windows) of secrets.
    pub keychain_service: &'static str,
    /// The Windows registry vendor key, `HKCU\Software\<publisher>`. Tauri
    /// derived it from the identifier's second segment.
    pub publisher: &'static str,
}

/// Every `next/` build until the hand-over.
pub const DEVELOPMENT: Identity = Identity {
    channel: Channel::Development,
    bundle_id: "cc.drifting.next.dev",
    product_name: "Drifting Next",
    executable: "drifting",
    url_scheme: "drifting-next-dev",
    // The 0.1 client's rule for any identifier other than its own two:
    // `Drifting.<identifier>`, so a development build never reads or
    // overwrites the author's real keys.
    keychain_service: "Drifting.cc.drifting.next.dev",
    publisher: "drifting",
};

/// The identity of the published 0.1 Tauri client (`src-tauri/tauri.conf.json`,
/// `secure_storage.rs`, Tauri's NSIS template). The hand-over keeps every
/// field, so updates, keychain items, `drifting:` links and the Windows
/// install location carry over.
pub const RELEASE: Identity = Identity {
    channel: Channel::Release,
    bundle_id: "cc.drifting.client",
    product_name: "Drifting",
    executable: "drifting",
    url_scheme: "drifting",
    keychain_service: "Drifting",
    publisher: "drifting",
};

impl Identity {
    /// The identity this build runs under. Changing it to [`RELEASE`] is the
    /// hand-over's job and nothing else's.
    pub const fn current() -> &'static Identity {
        &DEVELOPMENT
    }

    pub fn is_release(&self) -> bool {
        self.channel == Channel::Release
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLE_SCRIPT: &str = include_str!("../../../script/bundle-mac");
    const INSTALLER_SCRIPT: &str = include_str!("../../../script/windows/drifting.nsi");

    fn shell_value(name: &str) -> &'static str {
        let prefix = format!("{name}=");
        BUNDLE_SCRIPT
            .lines()
            .find_map(|line| line.trim().strip_prefix(prefix.as_str()))
            .unwrap_or_else(|| panic!("script/bundle-mac sets {name}"))
            .trim_matches('"')
    }

    fn nsis_default(name: &str) -> &'static str {
        let prefix = format!("!define {name} ");
        INSTALLER_SCRIPT
            .lines()
            .find_map(|line| line.trim().strip_prefix(prefix.as_str()))
            .unwrap_or_else(|| panic!("drifting.nsi defaults {name}"))
            .trim_matches('"')
    }

    #[test]
    fn every_build_is_the_development_identity_until_the_hand_over() {
        assert_eq!(Identity::current(), &DEVELOPMENT);
        assert!(!Identity::current().is_release());
    }

    #[test]
    fn development_shares_nothing_the_release_client_owns() {
        assert_ne!(DEVELOPMENT.bundle_id, RELEASE.bundle_id);
        assert_ne!(DEVELOPMENT.url_scheme, RELEASE.url_scheme);
        assert_ne!(DEVELOPMENT.keychain_service, RELEASE.keychain_service);
        assert_ne!(DEVELOPMENT.product_name, RELEASE.product_name);
        assert_eq!(
            DEVELOPMENT.keychain_service,
            format!("Drifting.{}", DEVELOPMENT.bundle_id)
        );
    }

    #[test]
    fn the_release_identity_is_the_tauri_clients() {
        let tauri: serde_json::Value =
            serde_json::from_str(include_str!("../../../../src-tauri/tauri.conf.json")).unwrap();
        assert_eq!(tauri["identifier"], RELEASE.bundle_id);
        assert_eq!(tauri["productName"], RELEASE.product_name);
        assert_eq!(
            tauri["plugins"]["deep-link"]["desktop"]["schemes"][0],
            RELEASE.url_scheme
        );
        let cargo = include_str!("../../../../src-tauri/Cargo.toml");
        assert!(cargo.contains(&format!("name = \"{}\"", RELEASE.executable)));
        // Tauri's NSIS publisher defaults to the identifier's second segment.
        assert_eq!(RELEASE.bundle_id.split('.').nth(1), Some(RELEASE.publisher));
    }

    #[test]
    fn the_packaging_scripts_carry_the_development_identity() {
        assert_eq!(shell_value("BUNDLE_ID"), DEVELOPMENT.bundle_id);
        assert_eq!(shell_value("APP_NAME"), DEVELOPMENT.product_name);
        assert_eq!(shell_value("EXECUTABLE"), DEVELOPMENT.executable);
        assert_eq!(shell_value("URL_SCHEME"), DEVELOPMENT.url_scheme);
        assert_eq!(nsis_default("PRODUCT_NAME"), DEVELOPMENT.product_name);
        assert_eq!(nsis_default("BUNDLE_ID"), DEVELOPMENT.bundle_id);
        assert_eq!(nsis_default("EXECUTABLE"), DEVELOPMENT.executable);
        assert_eq!(nsis_default("URL_SCHEME"), DEVELOPMENT.url_scheme);
        assert_eq!(nsis_default("PUBLISHER"), DEVELOPMENT.publisher);
        for script in [BUNDLE_SCRIPT, INSTALLER_SCRIPT] {
            assert!(!script.contains(&format!("\"{}\"", RELEASE.bundle_id)));
        }
    }
}
