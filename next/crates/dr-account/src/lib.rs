//! Hosted account authentication, OAuth PKCE state, profile management, and per-account
//! library isolation for Drifting `next/`.
//!
//! Public builds without `DRIFTING_API_BASE_URL` run in local-only mode and make zero
//! network requests.

pub mod client;
pub mod endpoint;
#[cfg(any(test, feature = "test-support"))]
pub mod fake_server;
pub mod library_registry;
pub mod oauth;
pub mod preferences;
pub mod profile;
pub mod session;

pub use client::{
    AccountError, AccountService, AccountState, AuthProviders, HostedClient, OtpPurpose,
    SignUpOutcome,
};
pub use endpoint::{HostedConfig, HostedOrigin};
pub use library_registry::{
    DEFAULT_LOCAL_ID, DEFAULT_LOCAL_REL_PATH, LIBRARIES_FILE, LibraryEntry, LibraryOwner,
    LibraryRegistry, account_library_id, account_library_rel_path,
};
pub use oauth::{
    NATIVE_OAUTH_STATE_FILE, OAUTH_STATE_TTL_MS, ParsedOAuthCallback, PendingNativeOAuth,
    build_oauth_redirect_url, clear_pending_oauth, consume_pending_oauth, parse_oauth_callback_url,
    pkce_s256_challenge, read_pending_oauth, save_pending_oauth,
};
pub use preferences::{
    PreferenceEndpointStatus, PreferenceLedger, PreferenceLedgerEntry, PreferenceSyncOutcome,
    PreferenceWrite, RemotePreference, UNCHANGED_AT, clamp_to_server_clock, compare_iso_timestamps,
    now_iso8601, sync_preferences_with_client,
};
pub use profile::{
    AVATAR_CANVAS_SIZE, AccountErrorCode, HostedUser, MAX_AVATAR_DATA_URL_BYTES,
    MAX_AVATAR_UPLOAD_BYTES, MAX_PASSWORD_LENGTH, MAX_PROFILE_NAME_UTF16_UNITS, MIN_PASSWORD_BYTES,
    crop_and_encode_avatar, decode_avatar_rgba, is_allowed_avatar_data_url, normalize_avatar,
    validate_password_change, validate_profile_name,
};
pub use session::{HOSTED_PROFILE_FILE, ProfileCache, SessionStatus, SessionTokenStore};

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use dr_platform::SecretStore;
    use dr_store::{Library, LibraryOptions};
    use image::{ImageFormat, Rgba, RgbaImage};
    use tempfile::TempDir;

    use super::*;
    use crate::fake_server::FakeAuthServer;

    #[test]
    fn local_only_mode_makes_zero_network_requests() {
        let server = FakeAuthServer::start();
        let tmp = TempDir::new().expect("tempdir");
        let secrets = Arc::new(SecretStore::in_memory());

        let svc = AccountService::new(
            HostedConfig::local_only(),
            tmp.path(),
            "cc.drifting.next.dev",
            secrets,
        )
        .expect("new service");

        let state = svc.bootstrap();
        assert!(!state.hosted_configured);
        assert_eq!(state.status, SessionStatus::SignedOut);
        assert!(state.user.is_none());
        assert!(!state.is_account_library);
        assert_eq!(state.active_library_dir, tmp.path().join("library"));
        assert_eq!(server.request_count(), 0);
    }

    #[test]
    fn email_sign_up_verification_and_password_sign_in_round_trip() {
        let server = FakeAuthServer::start();
        let tmp = TempDir::new().expect("tempdir");
        let secrets = Arc::new(SecretStore::in_memory());

        let svc = AccountService::new(
            server.config(),
            tmp.path(),
            "cc.drifting.next.dev",
            secrets.clone(),
        )
        .expect("new service");

        let outcome = svc
            .sign_up_email("Lin", "lin@example.test", "correct-horse-battery")
            .expect("sign up");
        assert_eq!(
            outcome,
            SignUpOutcome::VerificationRequired {
                email: "lin@example.test".to_string()
            }
        );

        // Unverified password sign-in returns EmailNotVerified and triggers OTP.
        let unverified_err = svc
            .sign_in_email("lin@example.test", "correct-horse-battery")
            .expect_err("must require email verification");
        assert_eq!(unverified_err.code, AccountErrorCode::EmailNotVerified);

        let otp = server
            .last_otp_for("lin@example.test")
            .expect("otp issued for lin");
        let state = svc
            .verify_email_otp("lin@example.test", &otp, Some("correct-horse-battery"))
            .expect("verify email otp");

        assert_eq!(state.status, SessionStatus::Connected);
        let user = state.user.expect("signed in user");
        assert_eq!(user.email, "lin@example.test");
        assert_eq!(user.name, "Lin");
        assert!(state.is_account_library);
        assert_eq!(
            state.active_library_dir,
            tmp.path().join(account_library_rel_path(&user.id))
        );

        // Verify token is in SecretStore under hosted_session(origin).
        let stored_token = svc.current_token().expect("token stored");
        assert!(!stored_token.is_empty());
    }

    #[test]
    fn email_otp_sign_in_and_password_reset_round_trip() {
        let server = FakeAuthServer::start();
        server.set_require_signup_verification(false);
        let tmp = TempDir::new().expect("tempdir");
        let secrets = Arc::new(SecretStore::in_memory());

        let svc = AccountService::new(server.config(), tmp.path(), "cc.drifting.next.dev", secrets)
            .expect("new service");

        svc.send_verification_otp("otp-user@example.test", OtpPurpose::SignIn)
            .expect("send sign-in otp");
        let otp = server
            .last_otp_for("otp-user@example.test")
            .expect("otp issued");
        let state = svc
            .sign_in_email_otp("otp-user@example.test", &otp)
            .expect("sign in with otp");
        assert_eq!(state.status, SessionStatus::Connected);
        assert_eq!(
            state.user.as_ref().map(|u| u.email.as_str()),
            Some("otp-user@example.test")
        );

        // Sign out, then reset password via OTP and sign in with the new password.
        svc.sign_out().expect("sign out");
        svc.request_password_reset("otp-user@example.test")
            .expect("request reset");
        let reset_otp = server
            .last_otp_for("otp-user@example.test")
            .expect("reset otp");
        svc.reset_password(
            "otp-user@example.test",
            &reset_otp,
            "new-secret-password-99",
        )
        .expect("reset password");

        let state2 = svc
            .sign_in_email("otp-user@example.test", "new-secret-password-99")
            .expect("sign in with new password");
        assert_eq!(state2.status, SessionStatus::Connected);
    }

    #[test]
    fn google_oauth_pkce_live_and_cold_start_and_replay_protection() {
        let server = FakeAuthServer::start();
        let tmp = TempDir::new().expect("tempdir");
        let secrets = Arc::new(SecretStore::in_memory());

        let svc = AccountService::new(
            server.config(),
            tmp.path(),
            "cc.drifting.next.dev",
            secrets.clone(),
        )
        .expect("new service");

        let start_url = svc.start_google_oauth().expect("start google oauth");
        assert!(start_url.contains("/api/auth/native-start?"));
        assert!(start_url.contains("provider=google"));
        assert!(tmp.path().join(NATIVE_OAUTH_STATE_FILE).is_file());

        // Simulate browser callback arriving after cold restart (new AccountService instance).
        let callback_url =
            server.simulate_google_oauth_redirect(&start_url, "google@example.test", "Google User");

        // Wrong state must be rejected without consuming the valid state.
        let tampered_url = format!("{callback_url}00");
        let err = svc
            .complete_oauth_callback_url(&tampered_url)
            .expect_err("tampered state must fail");
        assert_eq!(err.code, AccountErrorCode::OAuthStateMismatch);

        // Cold-start instance reads `<data>/native-oauth-state.json` and completes sign-in.
        let cold_svc =
            AccountService::new(server.config(), tmp.path(), "cc.drifting.next.dev", secrets)
                .expect("cold service");
        let state = cold_svc
            .complete_oauth_callback_url(&callback_url)
            .expect("complete oauth on cold start");
        assert_eq!(state.status, SessionStatus::Connected);
        assert_eq!(
            state.user.as_ref().map(|u| u.email.as_str()),
            Some("google@example.test")
        );
        assert!(!tmp.path().join(NATIVE_OAUTH_STATE_FILE).exists());

        // Replaying the same callback URL a second time must fail because the state was consumed.
        let replay_err = cold_svc
            .complete_oauth_callback_url(&callback_url)
            .expect_err("replayed callback must fail");
        assert_eq!(replay_err.code, AccountErrorCode::OAuthStateMismatch);
    }

    #[test]
    fn account_library_isolation_preserves_local_and_each_account_separately() {
        let server = FakeAuthServer::start();
        server.set_require_signup_verification(false);
        let tmp = TempDir::new().expect("tempdir");
        let secrets = Arc::new(SecretStore::in_memory());

        let svc = AccountService::new(server.config(), tmp.path(), "cc.drifting.next.dev", secrets)
            .expect("new service");

        // 1. Create a book in the local library.
        let local_dir = svc.state().active_library_dir;
        let local_book = "book-local-1";
        {
            let lib =
                Library::open(&local_dir, LibraryOptions::new("0.2.0-test")).expect("open local");
            lib.register("book:book-local-1", "book", Some(local_book))
                .expect("create local book");
            assert_eq!(lib.docs(None, None).expect("list").len(), 1);
        }

        // 2. Sign up as Account A -> switches to Account A's empty library.
        let SignUpOutcome::SignedIn(state_a) = svc
            .sign_up_email("Alice", "alice@example.test", "alice-password-123")
            .expect("sign up alice")
        else {
            panic!("expected immediate sign in");
        };
        assert!(state_a.is_account_library);
        assert_ne!(state_a.active_library_dir, local_dir);

        let book_a = "book-alice-1";
        {
            let lib_a = Library::open(
                &state_a.active_library_dir,
                LibraryOptions::new("0.2.0-test"),
            )
            .expect("open account A library");
            // Local book is NOT in Account A's library.
            assert!(lib_a.docs(None, None).expect("list A").is_empty());
            lib_a
                .register("book:book-alice-1", "book", Some(book_a))
                .expect("create book A");
            assert_eq!(lib_a.docs(None, None).expect("list A").len(), 1);
        }

        // 3. Sign out -> returns to local library; local book is intact and Account A dir stays on disk.
        let signed_out = svc.sign_out().expect("sign out alice");
        assert!(!signed_out.is_account_library);
        assert_eq!(signed_out.active_library_dir, local_dir);
        assert!(state_a.active_library_dir.is_dir());
        {
            let lib =
                Library::open(&local_dir, LibraryOptions::new("0.2.0-test")).expect("reopen local");
            let docs = lib.docs(None, None).expect("list local");
            assert_eq!(docs.len(), 1);
            assert_eq!(docs[0].book_id.as_deref(), Some(local_book));
        }

        // 4. Sign up as Account B -> switches to Account B's separate empty library.
        let SignUpOutcome::SignedIn(state_b) = svc
            .sign_up_email("Bob", "bob@example.test", "bob-password-123")
            .expect("sign up bob")
        else {
            panic!("expected immediate sign in");
        };
        assert!(state_b.is_account_library);
        assert_ne!(state_b.active_library_dir, local_dir);
        assert_ne!(state_b.active_library_dir, state_a.active_library_dir);
        {
            let lib_b = Library::open(
                &state_b.active_library_dir,
                LibraryOptions::new("0.2.0-test"),
            )
            .expect("open account B library");
            assert!(lib_b.docs(None, None).expect("list B").is_empty());
        }

        // 5. Sign out of B and sign back into A -> Alice's book is still there!
        svc.sign_out().expect("sign out bob");
        let relogin_a = svc
            .sign_in_email("alice@example.test", "alice-password-123")
            .expect("sign in alice again");
        assert_eq!(relogin_a.active_library_dir, state_a.active_library_dir);
        {
            let lib_a = Library::open(
                &relogin_a.active_library_dir,
                LibraryOptions::new("0.2.0-test"),
            )
            .expect("reopen account A library");
            let docs = lib_a.docs(None, None).expect("list A");
            assert_eq!(docs.len(), 1);
            assert_eq!(docs[0].book_id.as_deref(), Some(book_a));
        }
    }

    #[test]
    fn session_expiry_and_offline_startup_keep_account_library_open() {
        let server = FakeAuthServer::start();
        server.set_require_signup_verification(false);
        let tmp = TempDir::new().expect("tempdir");
        let secrets = Arc::new(SecretStore::in_memory());

        let svc = AccountService::new(
            server.config(),
            tmp.path(),
            "cc.drifting.next.dev",
            secrets.clone(),
        )
        .expect("new service");
        let SignUpOutcome::SignedIn(connected) = svc
            .sign_up_email("Clara", "clara@example.test", "clara-password-123")
            .expect("sign up clara")
        else {
            panic!("expected signed in");
        };
        let account_dir = connected.active_library_dir.clone();
        let token = svc.current_token().expect("token");

        // Simulate offline startup: server drops connections, but cached profile and account library stay active.
        server.set_offline(true);
        let offline_svc = AccountService::new(
            server.config(),
            tmp.path(),
            "cc.drifting.next.dev",
            secrets.clone(),
        )
        .expect("offline service");
        let offline_state = offline_svc.bootstrap();
        assert_eq!(offline_state.status, SessionStatus::Offline);
        assert_eq!(offline_state.active_library_dir, account_dir);
        assert!(offline_state.is_account_library);
        assert_eq!(
            offline_state.user.as_ref().map(|u| u.name.as_str()),
            Some("Clara")
        );

        // Bring server back online, expire the token -> bootstrap transitions to NeedsReauth without switching libraries.
        server.set_offline(false);
        server.expire_token(&token);
        let expired_state = offline_svc.bootstrap();
        assert_eq!(expired_state.status, SessionStatus::NeedsReauth);
        assert_eq!(expired_state.active_library_dir, account_dir);
        assert!(expired_state.is_account_library);
    }

    #[test]
    fn profile_update_avatar_crop_and_password_change_rotate_token() {
        let server = FakeAuthServer::start();
        server.set_require_signup_verification(false);
        let tmp = TempDir::new().expect("tempdir");
        let secrets = Arc::new(SecretStore::in_memory());

        let svc = AccountService::new(server.config(), tmp.path(), "cc.drifting.next.dev", secrets)
            .expect("new service");
        svc.sign_up_email("Author", "author@example.test", "initial-password-1")
            .expect("sign up");
        let old_token = svc.current_token().expect("initial token");

        // Create a synthetic 400x200 PNG in memory and crop/encode it as a 256x256 JPEG data URL.
        let img = RgbaImage::from_pixel(400, 200, Rgba([180, 120, 90, 255]));
        let mut png_bytes = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png_bytes), ImageFormat::Png)
            .expect("encode png");
        let data_url = crop_and_encode_avatar(&png_bytes).expect("crop and encode avatar");
        assert!(is_allowed_avatar_data_url(&data_url));
        let (w, h, rgba) = decode_avatar_rgba(&data_url).expect("decode avatar");
        assert_eq!((w, h), (AVATAR_CANVAS_SIZE, AVATAR_CANVAS_SIZE));
        assert_eq!(
            rgba.len(),
            (AVATAR_CANVAS_SIZE * AVATAR_CANVAS_SIZE * 4) as usize
        );

        // Update profile name and avatar.
        let updated = svc
            .update_profile(Some("Updated Author"), Some(Some(&data_url)))
            .expect("update profile");
        let u = updated.user.expect("user");
        assert_eq!(u.name, "Updated Author");
        assert_eq!(u.image.as_deref(), Some(data_url.as_str()));

        // Reject invalid avatar data URL.
        let bad_avatar = svc
            .update_profile(None, Some(Some("data:image/png;base64,iVBORw0KGgo=")))
            .expect_err("png data url must be rejected");
        assert_eq!(bad_avatar.code, AccountErrorCode::InvalidAvatar);

        // Change password -> rotates session token.
        svc.change_password("initial-password-1", "rotated-password-2")
            .expect("change password");
        let new_token = svc.current_token().expect("rotated token");
        assert_ne!(old_token, new_token);

        let rechecked = svc.bootstrap();
        assert_eq!(rechecked.status, SessionStatus::Connected);
    }

    #[test]
    fn preference_sync_lww_future_clock_clamping_and_404_unsupported() {
        use serde_json::json;
        use std::collections::BTreeMap;

        let server = FakeAuthServer::start();
        server.set_require_signup_verification(false);
        server.set_server_clock(Some("2026-11-02T12:00:00.000Z"));

        let tmp_a = TempDir::new().expect("tempdir a");
        let tmp_b = TempDir::new().expect("tempdir b");

        let svc_a = AccountService::new(
            server.config(),
            tmp_a.path(),
            "cc.drifting.next.dev",
            Arc::new(SecretStore::in_memory()),
        )
        .expect("svc a");
        let svc_b = AccountService::new(
            server.config(),
            tmp_b.path(),
            "cc.drifting.next.dev",
            Arc::new(SecretStore::in_memory()),
        )
        .expect("svc b");

        svc_a
            .sign_up_email("Writer", "writer@example.test", "writer-password-123")
            .expect("sign up on device a");
        svc_b
            .sign_in_email("writer@example.test", "writer-password-123")
            .expect("sign in on device b");

        let synced_keys = ["appearance.theme", "editor.font_size", "language.ui_locale"];

        // Device A edits `appearance.theme` with a skewed future client clock (2099),
        // and leaves `editor.font_size` at its untouched default (`UNCHANGED_AT`).
        let mut local_a = BTreeMap::from([
            ("appearance.theme".to_string(), json!("dark")),
            ("editor.font_size".to_string(), json!(17.0)),
            ("language.ui_locale".to_string(), json!("zh-CN")),
        ]);
        let mut ledger_a = PreferenceLedger::default();
        ledger_a.entries.insert(
            "appearance.theme".to_string(),
            PreferenceLedgerEntry {
                changed_at: "2099-01-01T00:00:00.000Z".to_string(),
                pending: true,
            },
        );
        ledger_a.entries.insert(
            "language.ui_locale".to_string(),
            PreferenceLedgerEntry {
                changed_at: "2026-11-02T11:50:00.000Z".to_string(),
                pending: true,
            },
        );

        let out_a = svc_a
            .sync_preferences(&synced_keys, &local_a, &ledger_a)
            .expect("sync device a");
        assert!(out_a.supported);
        // Server clamped Device A's 2099 timestamp to server clock 2026-11-02T12:00:00.000Z.
        assert_eq!(
            out_a.ledger.entries["appearance.theme"].changed_at,
            "2026-11-02T12:00:00.000Z"
        );
        assert!(!out_a.ledger.entries["appearance.theme"].pending);
        ledger_a = out_a.ledger;

        // Advance server clock to 12:05. Device B modifies `appearance.theme` to `"light"` at 12:04
        // and `editor.font_size` to `20.0` at 12:04, while leaving `language.ui_locale` untouched.
        server.set_server_clock(Some("2026-11-02T12:05:00.000Z"));
        let local_b = BTreeMap::from([
            ("appearance.theme".to_string(), json!("light")),
            ("editor.font_size".to_string(), json!(20.0)),
            ("language.ui_locale".to_string(), json!(null)),
        ]);
        let mut ledger_b = PreferenceLedger::default();
        ledger_b.entries.insert(
            "appearance.theme".to_string(),
            PreferenceLedgerEntry {
                changed_at: "2026-11-02T12:04:00.000Z".to_string(),
                pending: true,
            },
        );
        ledger_b.entries.insert(
            "editor.font_size".to_string(),
            PreferenceLedgerEntry {
                changed_at: "2026-11-02T12:04:00.000Z".to_string(),
                pending: true,
            },
        );

        let out_b = svc_b
            .sync_preferences(&synced_keys, &local_b, &ledger_b)
            .expect("sync device b");
        assert!(out_b.supported);
        // Device B receives Device A's `language.ui_locale = "zh-CN"`, and pushes its newer `appearance.theme = "light"` and `editor.font_size = 20.0`.
        assert_eq!(
            out_b.applied.get("language.ui_locale"),
            Some(&json!("zh-CN"))
        );
        assert!(out_b.pushed_keys.contains(&"appearance.theme".to_string()));
        assert!(out_b.pushed_keys.contains(&"editor.font_size".to_string()));

        // Device A syncs again and receives Device B's `"light"` theme and `20.0` font size.
        let out_a2 = svc_a
            .sync_preferences(&synced_keys, &local_a, &ledger_a)
            .expect("sync device a second round");
        for (k, v) in &out_a2.applied {
            local_a.insert(k.clone(), v.clone());
        }
        assert_eq!(local_a["appearance.theme"], json!("light"));
        assert_eq!(local_a["editor.font_size"], json!(20.0));
        assert_eq!(local_a["language.ui_locale"], json!("zh-CN"));

        // When the server returns 404 Not Found on `/api/account/v1/preferences`, sync succeeds
        // with `supported == false` and does not error.
        server.set_preferences_supported(false);
        let out_unsupported = svc_a
            .sync_preferences(&synced_keys, &local_a, &out_a2.ledger)
            .expect("404 must not error");
        assert!(!out_unsupported.supported);
        assert!(out_unsupported.applied.is_empty());
    }
}
