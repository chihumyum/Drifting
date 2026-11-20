//! Account notices in the notification center (M35 「运营公告」, the 0.1
//! client's `docs/hosted-sync/notices.md`), against the fake service.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dr_account::fake_server::FakeAuthServer;
use dr_account::notices::{NOTICES_PATH, NOTICES_READ_PATH};
use dr_account::{AccountService, HostedConfig, SessionStatus};
use dr_platform::SecretStore;
use dr_shell::notifications::{Notifications, Source};
use dr_shell::settings::registry::UI_LOCALE;
use dr_shell::{Services, Settings, SettingsFile, ShellInfo};
use dr_view_account::notices::{self, BACKGROUND_MAX, DISMISSED_MEMORY_KEY, RETRY_MAX};
use dr_view_account::{Service, sign_out};
use gpui::TestAppContext;
use serde_json::{Value, json};
use tempfile::TempDir;

const EMAIL: &str = "notices@example.test";
const PASSWORD: &str = "notices-password-1";
/// The fake service's 60 s, five times less often in the background (the
/// test windows are never in front).
const BACKGROUND_READ: Duration = Duration::from_secs(5 * 60);

fn hosted(
    server: &FakeAuthServer,
    dir: &TempDir,
    secrets: Arc<SecretStore>,
) -> Arc<AccountService> {
    Arc::new(
        AccountService::new(server.config(), dir.path(), "cc.drifting.next.dev", secrets)
            .expect("hosted service"),
    )
}

fn signed_in(
    server: &FakeAuthServer,
    dir: &TempDir,
    secrets: Arc<SecretStore>,
) -> Arc<AccountService> {
    server.set_require_signup_verification(false);
    let svc = hosted(server, dir, secrets);
    svc.sign_up_email("林昭", EMAIL, PASSWORD).expect("sign up");
    assert_eq!(svc.state().status, SessionStatus::Connected);
    svc
}

fn chinese(mut file: SettingsFile) -> SettingsFile {
    file.set(UI_LOCALE, Value::from("zh-CN"), None).unwrap();
    file
}

fn start(cx: &mut TestAppContext, svc: Arc<AccountService>, settings: SettingsFile) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        let _ = dr_ui::fonts::register(cx);
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services::default(),
            settings,
            cx,
        );
        dr_view_account::init(Service::with_service(svc), cx);
    });
}

/// Runs what is due until `done`; the fake service answers on its own thread.
fn settle(cx: &mut TestAppContext, what: &str, mut done: impl FnMut(&mut TestAppContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn later(cx: &mut TestAppContext, by: Duration) {
    cx.executor().advance_clock(by);
    cx.run_until_parked();
}

/// The notice rows, newest first: source and words.
fn rows(cx: &mut TestAppContext) -> Vec<(Source, String)> {
    cx.read(|cx| {
        Notifications::items(cx)
            .iter()
            .filter(|n| matches!(n.source, Source::Notice | Source::PersonalNotice))
            .map(|n| (n.source, n.text.to_string()))
            .collect()
    })
}

fn row_id(cx: &mut TestAppContext, text: &str) -> u64 {
    cx.read(|cx| {
        Notifications::items(cx)
            .iter()
            .find(|n| n.text.as_ref() == text)
            .map(|n| n.id)
            .expect("the row")
    })
}

fn reads(server: &FakeAuthServer) -> usize {
    server.requests_to("GET", NOTICES_PATH)
}

fn marks(server: &FakeAuthServer) -> usize {
    server.requests_to("POST", NOTICES_READ_PATH)
}

fn maintenance() -> Value {
    json!({
        "zh": { "title": "今晚维护", "body": "十点到十一点\n同步暂停" },
        "en": { "title": "Maintenance tonight", "body": "Ten to eleven\nSync pauses" }
    })
}

#[gpui::test]
fn a_local_only_build_asks_nothing(cx: &mut TestAppContext) {
    let server = FakeAuthServer::start();
    server.publish_notice(None, maintenance(), None);
    let dir = TempDir::new().unwrap();
    let local = Arc::new(
        AccountService::new(
            HostedConfig::local_only(),
            dir.path(),
            "cc.drifting.next.dev",
            Arc::new(SecretStore::in_memory()),
        )
        .unwrap(),
    );
    start(cx, local, SettingsFile::in_memory());
    cx.update(notices::request);
    later(cx, BACKGROUND_MAX * 3);
    assert_eq!(server.request_count(), 0);
    assert!(rows(cx).is_empty());
}

#[gpui::test]
fn signed_out_nothing_is_asked(cx: &mut TestAppContext) {
    let server = FakeAuthServer::start();
    server.publish_notice(None, maintenance(), None);
    let dir = TempDir::new().unwrap();
    let svc = hosted(&server, &dir, Arc::new(SecretStore::in_memory()));
    start(cx, svc, SettingsFile::in_memory());
    // The session check at start finds no session.
    settle(cx, "the session check", |cx| {
        cx.read(|cx| cx.global::<Service>().state.status) == SessionStatus::SignedOut
            && server.requests_to("GET", "/api/auth/providers") > 0
    });
    cx.update(notices::request);
    for _ in 0..3 {
        later(cx, BACKGROUND_MAX);
    }
    assert_eq!(reads(&server), 0);
    assert!(rows(cx).is_empty());
}

/// Signed in: each notice is listed once however often it is read, in the
/// interface language, the one to this account alone as 消息; opening the
/// center raises the account's mark; a notice the operator withdraws
/// leaves; signing out takes the rest away and stops the reads.
#[gpui::test]
fn a_signed_in_author_sees_each_notice_once_and_opening_the_center_reads_them(
    cx: &mut TestAppContext,
) {
    let server = FakeAuthServer::start();
    let dir = TempDir::new().unwrap();
    let svc = signed_in(&server, &dir, Arc::new(SecretStore::in_memory()));
    let to_all =
        server.publish_notice(None, maintenance(), Some("https://drifting.example/status"));
    server.publish_notice(
        Some(EMAIL),
        json!({ "en": { "title": "About your feedback", "body": "" } }),
        None,
    );
    start(cx, svc, chinese(SettingsFile::in_memory()));
    settle(cx, "both notices", |cx| rows(cx).len() == 2);
    assert_eq!(
        rows(cx),
        [
            (Source::PersonalNotice, "About your feedback".to_owned()),
            (
                Source::Notice,
                "今晚维护\n十点到十一点\n同步暂停".to_owned()
            ),
        ],
        "newest first; Chinese where written, else what was written"
    );
    assert_eq!(
        cx.read(|cx| dr_shell::t(cx, Source::PersonalNotice.label())),
        "消息"
    );
    assert_eq!(
        cx.read(|cx| dr_shell::t(cx, Source::Notice.label())),
        "公告"
    );
    assert!(cx.read(Notifications::unread));

    // Read again in the background every five minutes: the same two rows.
    let first = reads(&server);
    for _ in 0..3 {
        later(cx, BACKGROUND_READ);
    }
    settle(cx, "three more reads", |_| reads(&server) >= first + 3);
    assert_eq!(rows(cx).len(), 2);
    assert_eq!(marks(&server), 0, "nothing read yet");
    assert_eq!(server.notice_read_through(EMAIL), 0);

    // Opening the center reads both for the whole account.
    cx.update(Notifications::mark_read);
    settle(cx, "the read mark", |_| {
        server.notice_read_through(EMAIL) == 2
    });
    assert_eq!(marks(&server), 1);

    // A new one comes in unread and waits; the mark stays.
    server.publish_notice(
        None,
        json!({ "zh": { "title": "新版本", "body": "" } }),
        None,
    );
    later(cx, BACKGROUND_READ);
    settle(cx, "the third notice", |cx| rows(cx).len() == 3);
    assert!(cx.read(Notifications::unread));
    assert_eq!(server.notice_read_through(EMAIL), 2);
    assert_eq!(marks(&server), 1);

    // Withdrawn: it leaves at the next read, and is not taken for removed.
    server.withdraw_notice(&to_all);
    later(cx, BACKGROUND_READ);
    settle(cx, "the withdrawal", |cx| rows(cx).len() == 2);
    assert!(
        !rows(cx)
            .iter()
            .any(|(_, text)| text.starts_with("今晚维护"))
    );
    assert_eq!(
        cx.read(|cx| Settings::device_memory(cx, DISMISSED_MEMORY_KEY)),
        None
    );

    // Signing out takes the account's notices away; nothing more is asked.
    cx.update(sign_out);
    settle(cx, "signing out", |cx| {
        cx.read(|cx| cx.global::<Service>().state.status) == SessionStatus::SignedOut
    });
    assert!(rows(cx).is_empty());
    let asked = reads(&server);
    later(cx, BACKGROUND_MAX);
    later(cx, BACKGROUND_MAX);
    assert_eq!(reads(&server), asked);
}

/// A notice that arrives while the center is open is read once it closes:
/// the shell reads every row then (`dr-shell/tests/notifications.rs`), and
/// that is what raises the mark.
#[gpui::test]
fn a_notice_read_after_it_arrived_raises_the_mark_to_it(cx: &mut TestAppContext) {
    let server = FakeAuthServer::start();
    let dir = TempDir::new().unwrap();
    let svc = signed_in(&server, &dir, Arc::new(SecretStore::in_memory()));
    server.publish_notice(None, maintenance(), None);
    start(cx, svc, SettingsFile::in_memory());
    settle(cx, "the first notice", |cx| rows(cx).len() == 1);
    // The center opens.
    cx.update(Notifications::mark_read);
    settle(cx, "its mark", |_| server.notice_read_through(EMAIL) == 1);
    // A second arrives while it is open …
    server.publish_notice(
        None,
        json!({ "en": { "title": "Second", "body": "" } }),
        None,
    );
    cx.update(notices::request);
    settle(cx, "the second notice", |cx| rows(cx).len() == 2);
    cx.run_until_parked();
    assert_eq!(server.notice_read_through(EMAIL), 1);
    // … and is read when it closes.
    cx.update(Notifications::mark_read);
    settle(cx, "the second mark", |_| {
        server.notice_read_through(EMAIL) == 2
    });
    assert_eq!(marks(&server), 2);
}

/// After a restart the notices still offered are listed again, already read
/// where the account has read them, each once; one the author removed
/// stays away on this device, and removing it counts as having seen it.
#[gpui::test]
fn across_a_restart_notices_come_back_read_and_removed_ones_stay_away(
    cx_a: &mut TestAppContext,
    cx_b: &mut TestAppContext,
) {
    let server = FakeAuthServer::start();
    let dir = TempDir::new().unwrap();
    let settings_dir = TempDir::new().unwrap();
    let secrets = Arc::new(SecretStore::in_memory());
    let svc = signed_in(&server, &dir, secrets.clone());
    server.publish_notice(None, maintenance(), None);
    server.publish_notice(
        None,
        json!({ "zh": { "title": "第二条", "body": "" } }),
        None,
    );

    // First run.
    start(cx_a, svc, chinese(SettingsFile::open(settings_dir.path())));
    settle(cx_a, "two notices", |cx| rows(cx).len() == 2);
    cx_a.update(Notifications::mark_read);
    settle(cx_a, "the mark", |_| server.notice_read_through(EMAIL) == 2);
    // The author removes the first; a third arrives and is removed unread.
    let first = row_id(cx_a, "今晚维护\n十点到十一点\n同步暂停");
    cx_a.update(|cx| Notifications::remove(first, cx));
    server.publish_notice(
        None,
        json!({ "zh": { "title": "第三条", "body": "" } }),
        None,
    );
    cx_a.update(notices::request);
    settle(cx_a, "the third notice", |cx| {
        rows(cx).len() == 2 && rows(cx)[0].1 == "第三条"
    });
    let third = row_id(cx_a, "第三条");
    cx_a.update(|cx| Notifications::remove(third, cx));
    settle(cx_a, "removing counts as seen", |_| {
        server.notice_read_through(EMAIL) == 3
    });
    let remembered = cx_a.read(|cx| Settings::device_memory(cx, DISMISSED_MEMORY_KEY));
    let remembered = remembered.expect("the removals are kept on the device");
    assert_eq!(
        remembered
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    cx_a.update(Settings::flush);
    let (reads_before, marks_before) = (reads(&server), marks(&server));

    // Second run: the same device, account and settings file.
    let again = hosted(&server, &dir, secrets);
    assert_eq!(again.state().status, SessionStatus::Checking);
    start(
        cx_b,
        again,
        chinese(SettingsFile::open(settings_dir.path())),
    );
    settle(cx_b, "the notices again", |cx| {
        reads(&server) > reads_before && !rows(cx).is_empty()
    });
    cx_b.run_until_parked();
    assert_eq!(
        rows(cx_b),
        [(Source::Notice, "第二条".to_owned())],
        "listed once; the removed ones stay away"
    );
    assert!(!cx_b.read(Notifications::unread), "already read");
    assert_eq!(
        marks(&server),
        marks_before,
        "nothing more to tell the service"
    );
}

/// A malformed, oversized or failing answer is ignored: what is listed stays,
/// the session stays connected, and a later good answer is shown.
#[gpui::test]
fn bad_answers_change_nothing(cx: &mut TestAppContext) {
    let server = FakeAuthServer::start();
    let dir = TempDir::new().unwrap();
    let svc = signed_in(&server, &dir, Arc::new(SecretStore::in_memory()));
    server.publish_notice(None, maintenance(), None);
    start(cx, svc.clone(), chinese(SettingsFile::in_memory()));
    settle(cx, "the notice", |cx| rows(cx).len() == 1);
    let listed = rows(cx);

    let oversized = format!(
        "{{\"notices\": [], \"pad\": \"{}\"}}",
        "x".repeat(dr_account::notices::MAX_RESPONSE_BYTES as usize)
    );
    let bad: [(Option<String>, Option<u16>); 4] = [
        (Some("not json".to_owned()), None),
        (Some(json!({ "notices": { "id": "x" } }).to_string()), None),
        (Some(oversized), None),
        (None, Some(500)),
    ];
    for (body, failure) in bad {
        server.set_notices_body(body);
        server.set_notices_failure(failure);
        let asked = reads(&server);
        cx.update(notices::request);
        settle(cx, "the bad answer", |_| reads(&server) > asked);
        cx.run_until_parked();
        assert_eq!(rows(cx), listed);
        let status = cx.read(|cx| cx.global::<Service>().state.status);
        assert_eq!(status, SessionStatus::Connected);
        assert!(svc.current_token().is_some());
    }
    // The failed read is tried again on its own, with the service back.
    server.set_notices_body(None);
    server.set_notices_failure(None);
    server.publish_notice(
        None,
        json!({ "zh": { "title": "恢复了", "body": "" } }),
        None,
    );
    let asked = reads(&server);
    later(cx, RETRY_MAX);
    settle(cx, "the retry", |cx| {
        reads(&server) > asked && rows(cx).len() == 2
    });
    assert_eq!(rows(cx)[0], (Source::Notice, "恢复了".to_owned()));
    assert_eq!(marks(&server), 0);
}

/// A service without notices is asked again after an hour; a refused
/// session after five minutes.
#[gpui::test]
fn an_older_service_and_a_refused_session_are_asked_again_later(cx: &mut TestAppContext) {
    let server = FakeAuthServer::start();
    let dir = TempDir::new().unwrap();
    let svc = signed_in(&server, &dir, Arc::new(SecretStore::in_memory()));
    server.set_notices_supported(false);
    start(cx, svc.clone(), SettingsFile::in_memory());
    settle(cx, "the first read", |_| reads(&server) == 1);
    for _ in 0..3 {
        later(cx, BACKGROUND_READ);
    }
    cx.update(notices::request);
    cx.run_until_parked();
    assert_eq!(reads(&server), 1, "an hour before asking again");
    server.set_notices_supported(true);
    server.publish_notice(None, maintenance(), None);
    later(cx, BACKGROUND_MAX);
    settle(cx, "the notice after an hour", |cx| rows(cx).len() == 1);

    server.expire_token(&svc.current_token().unwrap());
    let asked = reads(&server);
    cx.update(notices::request);
    settle(cx, "the refused read", |_| reads(&server) == asked + 1);
    later(cx, Duration::from_secs(60));
    cx.update(notices::request);
    cx.run_until_parked();
    assert_eq!(
        reads(&server),
        asked + 1,
        "five minutes before asking again"
    );
    assert_eq!(rows(cx).len(), 1, "what was listed stays");
}
