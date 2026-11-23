//! The feedback dialog in the workspace, on GPUI's test platform, against a
//! stand-in for the Hosted service on 127.0.0.1 (dr-platform's
//! `fake_service`): nothing here reaches a real service, and the mail
//! client is GPUI's test platform recording the URL it was asked to open.
//!
//! - `SendFeedback` opens it; ⌘↩ sends the author's words with the summary
//!   over the versioned contract, with the session;
//! - a crash follow-up names the crash; a failed send offers mail, which
//!   carries the same message and retires the notice;
//! - Cancel and Esc keep the notice, 「忽略」 retires it;
//! - the ✕ always closes, even while sending (the message still arrives and
//!   still retires its notice); a click on the mist closes only while
//!   nothing is written;
//! - nothing is sent while the message is empty or the address is not one;
//! - feedback the service stores cannot go without a reply-to address (a
//!   crash follow-up can, and so can a message for the mail client); the
//!   field opens with the signed-in account's email;
//! - without the service, the message goes to the mail client at once;
//! - the summary's sync part is what the sync runtime's owner registered
//!   with the shell, and a library that does not sync without it.

use std::time::{Duration, UNIX_EPOCH};

use dr_platform::diagnostics::{self, Pending, SummaryInput, SyncSnapshot};
use dr_platform::feedback::fake_service::FakeService;
use dr_platform::feedback::{Delivery, Endpoint};
use dr_shell::actions::SendFeedback;
use dr_shell::dialogs::FollowUpNotice;
use dr_shell::notifications::{Notifications, Source};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_feedback::{FeedbackDialog, Phase, Service};
use gpui::{Entity, Modifiers, Pixels, Point, TestAppContext, VisualTestContext, point, px};

const CRASH_ID: &str = "3f2a9c0d1e2b4a5f8c7d6e5f4a3b2c1d";
const SEND_KEYS: &str = if cfg!(target_os = "macos") {
    "cmd-enter"
} else {
    "ctrl-enter"
};

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: "0.2.0-dev",
        url_scheme: "drifting-next-dev",
        forced_appearance: None,
    }
}

fn service(delivery: Delivery) -> Service {
    Service {
        delivery,
        app_version: "0.2.0-dev".into(),
        data: None,
        session: Some("session-token".into()),
        account_email: None,
    }
}

fn hosted(fake: &FakeService) -> Service {
    service(Delivery::Hosted(Endpoint::from_base(&fake.base).unwrap()))
}

fn setup(cx: &mut TestAppContext, service: Service) -> (Entity<Workspace>, &mut VisualTestContext) {
    // The stand-in service answers on a thread of its own.
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(info(), Services::default(), SettingsFile::in_memory(), cx);
        dr_view_feedback::init(service, cx);
    });
    let (ws, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    (ws, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

fn click(at: Point<Pixels>, cx: &mut VisualTestContext) {
    draw(cx);
    cx.simulate_mouse_move(at, None, Modifiers::default());
    cx.simulate_click(at, Modifiers::default());
    cx.run_until_parked();
}

/// A point on the mist, away from the card.
fn mist() -> Point<Pixels> {
    point(px(10.0), px(10.0))
}

/// Clicks the dialog's ✕: the card is centred and its ✕ is the last 24 px
/// of its first row, 20 px in from the right edge. The card's height
/// depends on its content, so this walks down that column from the top of
/// the window; above the ✕ there is only mist and the card's padding, and
/// the message must be written so the mist does not close it first.
fn click_close_button(ws: &Entity<Workspace>, cx: &mut VisualTestContext) {
    let size = cx.update(|window, _| window.viewport_size());
    let x = (size.width + px(dr_view_feedback::WIDTH)) / 2.0 - px(32.0);
    let mut y = px(0.0);
    while y < size.height {
        click(point(x, y), cx);
        if dialog(ws, cx).is_none() {
            return;
        }
        y += px(6.0);
    }
    panic!("no ✕ in the dialog");
}

fn dialog(ws: &Entity<Workspace>, cx: &mut VisualTestContext) -> Option<Entity<FeedbackDialog>> {
    cx.read(|cx| ws.read(cx).dialog.clone())
        .and_then(|view| view.downcast::<FeedbackDialog>().ok())
}

fn write(
    dialog: &Entity<FeedbackDialog>,
    message: &str,
    contact: &str,
    cx: &mut VisualTestContext,
) {
    cx.update(|_, cx| {
        let (m, c) = {
            let d = dialog.read(cx);
            (d.message_field().clone(), d.contact_field().clone())
        };
        m.update(cx, |f, cx| f.set_text(message, cx));
        c.update(cx, |f, cx| f.set_text(contact, cx));
    });
}

fn post_follow_up(cx: &mut VisualTestContext) -> FollowUpNotice {
    // 2026-10-31T07:59:00Z
    let at = UNIX_EPOCH + Duration::from_secs(1_793_433_540);
    let notice = cx.update(|_, cx| {
        Notifications::post_at(
            Source::CrashFollowUp,
            "上次出了故障",
            at,
            Some(CRASH_ID.into()),
            cx,
        )
    });
    FollowUpNotice {
        notice,
        crash_id: CRASH_ID.into(),
        at,
    }
}

fn open_follow_up(ws: &Entity<Workspace>, follow_up: FollowUpNotice, cx: &mut VisualTestContext) {
    ws.update_in(cx, |ws, window, cx| {
        ws.open_feedback(Some(follow_up), window, cx)
    });
    cx.run_until_parked();
}

fn notices(cx: &mut VisualTestContext) -> usize {
    cx.read(|cx| Notifications::items(cx).len())
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}

#[gpui::test]
fn feedback_reaches_the_service_with_the_summary_and_the_session(cx: &mut TestAppContext) {
    let fake = FakeService::start(&[202]);
    let (ws, cx) = setup(cx, hosted(&fake));
    cx.dispatch_action(SendFeedback);
    cx.run_until_parked();
    let d = dialog(&ws, cx).expect("SendFeedback opens the dialog");
    assert!(
        cx.read(|cx| d.read(cx).attaches_summary()),
        "attached by default"
    );
    // It draws, with the summary's many lines in the preview card.
    draw(cx);
    d.update(cx, |d, cx| d.toggle_preview(cx));
    draw(cx);

    write(
        &d,
        "  改了幕的名字以后\n大纲卡住了  ",
        " author@example.com ",
        cx,
    );
    cx.simulate_keystrokes(SEND_KEYS);
    cx.run_until_parked();

    let got = fake.next().expect("the service received the feedback");
    assert_eq!(
        got.request_line,
        "POST /api/diagnostics/v1/feedback HTTP/1.1"
    );
    assert_eq!(got.header("authorization"), Some("Bearer session-token"));
    let body = got.json();
    assert_eq!(body["format"], "drifting.feedback");
    assert_eq!(body["formatVersion"], 1);
    assert_eq!(body["kind"], "feedback");
    assert_eq!(body["message"], "改了幕的名字以后\n大纲卡住了");
    assert_eq!(body["contactEmail"], "author@example.com");
    assert_eq!(body["related"], serde_json::Value::Null);
    assert_eq!(body["appVersion"], "0.2.0-dev");
    assert_eq!(body["installationId"], "diag-unavailable");
    assert_eq!(
        body["diagnostics"]["format"],
        "drifting.sanitized-diagnostics"
    );
    // What was attached is exactly what the preview shows.
    let shown: serde_json::Value =
        serde_json::from_str(cx.read(|cx| d.read(cx).summary().to_owned()).as_str()).unwrap();
    assert_eq!(body["diagnostics"], shown);
    assert!(!String::from_utf8_lossy(&got.body).contains("雨已经停了"));

    assert_eq!(cx.read(|cx| d.read(cx).phase()), Phase::Sent);
    assert_eq!(cx.opened_url(), None, "nothing went to the mail client");
    // Sent, the words are still there: the mist keeps it, the ✕ closes it.
    click(mist(), cx);
    assert!(dialog(&ws, cx).is_some());
    click_close_button(&ws, cx);
    assert!(dialog(&ws, cx).is_none());
}

#[gpui::test]
fn a_failed_follow_up_goes_by_mail_and_retires_its_notice(cx: &mut TestAppContext) {
    let fake = FakeService::start(&[503]);
    let (ws, cx) = setup(cx, hosted(&fake));
    let follow_up = post_follow_up(cx);
    open_follow_up(&ws, follow_up.clone(), cx);
    let d = dialog(&ws, cx).expect("the follow-up opens the dialog");
    assert_eq!(
        cx.read(|cx| d.read(cx).follow_up().cloned()),
        Some(follow_up)
    );

    write(&d, "正在导出 PDF", "", cx);
    d.update(cx, |d, cx| d.set_attach(false, cx));
    d.update_in(cx, |d, window, cx| d.submit(window, cx));
    cx.run_until_parked();

    let body = fake.next().expect("the service was asked").json();
    assert_eq!(body["kind"], "crash-follow-up");
    assert_eq!(body["diagnostics"], serde_json::Value::Null);
    assert_eq!(body["contactEmail"], serde_json::Value::Null);
    assert_eq!(
        body["related"]["fingerprint"],
        format!("native-panic:crash:{CRASH_ID}")
    );
    assert_eq!(body["related"]["occurredAt"], "2026-10-31T07:59:00.000Z");
    // 503: the dialog stays, says so, and offers mail; the notice stays.
    assert_eq!(cx.read(|cx| d.read(cx).phase()), Phase::Failed);
    assert!(cx.read(|cx| d.read(cx).by_email(cx)));
    draw(cx);
    assert_eq!(notices(cx), 1);

    d.update_in(cx, |d, window, cx| d.submit(window, cx));
    cx.run_until_parked();
    let url = cx.opened_url().expect("the mail client was asked");
    assert!(
        url.starts_with("mailto:support@drifting.cc?subject="),
        "{url}"
    );
    let body = decode(&url);
    assert!(body.contains("正在导出 PDF"));
    assert!(body.contains(&format!("native-panic:crash:{CRASH_ID}")));
    assert!(!body.contains("sanitized-diagnostics"));
    assert_eq!(notices(cx), 0, "sent by mail: the notice is retired");
    assert!(dialog(&ws, cx).is_none());
}

#[gpui::test]
fn cancel_and_esc_keep_the_notice_ignore_retires_it(cx: &mut TestAppContext) {
    let (ws, cx) = setup(cx, service(Delivery::Email));
    let follow_up = post_follow_up(cx);

    open_follow_up(&ws, follow_up.clone(), cx);
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert!(dialog(&ws, cx).is_none(), "Esc closes it");
    assert_eq!(notices(cx), 1, "closing keeps the notice");

    open_follow_up(&ws, follow_up, cx);
    let d = dialog(&ws, cx).unwrap();
    d.update_in(cx, |d, window, cx| d.ignore(window, cx));
    cx.run_until_parked();
    assert!(dialog(&ws, cx).is_none());
    assert_eq!(notices(cx), 0, "「忽略」 retires it");
    assert_eq!(cx.opened_url(), None);
}

#[gpui::test]
fn the_mist_closes_only_while_nothing_is_written(cx: &mut TestAppContext) {
    let (ws, cx) = setup(cx, service(Delivery::Email));
    cx.dispatch_action(SendFeedback);
    cx.run_until_parked();
    let d = dialog(&ws, cx).unwrap();

    write(&d, "导出的时候", "", cx);
    click(mist(), cx);
    assert!(dialog(&ws, cx).is_some(), "written words keep it open");

    // Spaces are nothing.
    write(&d, "  \n ", "", cx);
    click(mist(), cx);
    assert!(dialog(&ws, cx).is_none());
    assert_eq!(cx.opened_url(), None);
}

#[gpui::test]
fn the_close_button_lets_a_message_on_its_way_arrive(cx: &mut TestAppContext) {
    let fake = FakeService::start(&[202, 503]);
    let (ws, cx) = setup(cx, hosted(&fake));
    let follow_up = post_follow_up(cx);
    open_follow_up(&ws, follow_up, cx);
    let d = dialog(&ws, cx).unwrap();
    write(&d, "正在拖动章节", "", cx);

    // The ✕ while sending: the dialog goes at once, the send goes on.
    d.update_in(cx, |d, window, cx| {
        d.submit(window, cx);
        assert_eq!(d.phase(), Phase::Sending);
        d.close_button(window, cx);
    });
    assert!(dialog(&ws, cx).is_none());
    cx.run_until_parked();
    assert_eq!(
        fake.next().expect("it still arrived").json()["kind"],
        "crash-follow-up"
    );
    assert_eq!(notices(cx), 0, "and still retired its notice");

    // Esc and the mist do not close it while sending; the ✕ does.
    let follow_up = post_follow_up(cx);
    open_follow_up(&ws, follow_up, cx);
    let d = dialog(&ws, cx).unwrap();
    write(&d, "又一次", "", cx);
    d.update_in(cx, |d, window, cx| {
        d.submit(window, cx);
        d.dismiss(window, cx);
        d.mist(window, cx);
    });
    assert!(dialog(&ws, cx).is_some());
    cx.run_until_parked();
    assert!(fake.next().is_some());
    // (The stand-in answers 503 this time: the dialog offers mail.)
    assert_eq!(cx.read(|cx| d.read(cx).phase()), Phase::Failed);
    assert_eq!(notices(cx), 1);
    click_close_button(&ws, cx);
    assert!(dialog(&ws, cx).is_none());
    assert_eq!(notices(cx), 1, "closing keeps the notice");
}

#[gpui::test]
fn nothing_goes_until_the_draft_can_be_answered(cx: &mut TestAppContext) {
    let (ws, cx) = setup(cx, service(Delivery::Email));
    cx.dispatch_action(SendFeedback);
    cx.run_until_parked();
    let d = dialog(&ws, cx).unwrap();

    for (message, contact) in [
        ("   ", ""),
        (" \n\n ", ""),
        ("Hi", "not an address"),
        ("Hi", "a@b.c"),
    ] {
        write(&d, message, contact, cx);
        cx.simulate_keystrokes(SEND_KEYS);
        cx.run_until_parked();
        assert_eq!(cx.opened_url(), None, "{message:?} / {contact:?}");
        assert_eq!(cx.read(|cx| d.read(cx).phase()), Phase::Editing);
    }

    // Without the service the message goes to the mail client at once,
    // with the summary attached.
    write(&d, "导出的封面颜色不对", "", cx);
    cx.simulate_keystrokes(SEND_KEYS);
    cx.run_until_parked();
    let body = decode(&cx.opened_url().expect("mail"));
    assert!(body.contains("导出的封面颜色不对"));
    assert!(body.contains("\"format\": \"drifting.sanitized-diagnostics\""));
    assert!(dialog(&ws, cx).is_none());
}

/// Feedback the Hosted service stores must be answerable: without a
/// reply-to address nothing goes, to the service or to the mail client.
#[gpui::test]
fn feedback_for_the_service_waits_for_a_reply_to_address(cx: &mut TestAppContext) {
    let fake = FakeService::start(&[202]);
    let (ws, cx) = setup(cx, hosted(&fake));
    cx.dispatch_action(SendFeedback);
    cx.run_until_parked();
    let d = dialog(&ws, cx).unwrap();
    assert!(cx.read(|cx| d.read(cx).contact_required(cx)));
    // Signed out: the field opens empty and says it is required.
    let (text, placeholder) = cx.read(|cx| {
        let field = d.read(cx).contact_field().read(cx);
        (field.text(), field.placeholder_text().clone())
    });
    assert_eq!(text, "");
    let required = cx.read(|cx| dr_shell::t(cx, dr_i18n::keys::feedback::CONTACT_REQUIRED));
    let optional = cx.read(|cx| dr_shell::t(cx, dr_i18n::keys::feedback::CONTACT_PLACEHOLDER));
    assert_eq!(placeholder, required);
    assert_ne!(required, optional);
    draw(cx);

    for contact in ["", "   "] {
        write(&d, "导出的封面颜色不对", contact, cx);
        cx.simulate_keystrokes(SEND_KEYS);
        cx.run_until_parked();
        assert_eq!(
            cx.read(|cx| d.read(cx).phase()),
            Phase::Editing,
            "{contact:?}"
        );
        assert_eq!(cx.opened_url(), None);
    }

    write(&d, "导出的封面颜色不对", "author@example.com", cx);
    cx.simulate_keystrokes(SEND_KEYS);
    cx.run_until_parked();
    // The first thing the service hears is the one with the address.
    let body = fake.next().expect("it goes once it can be answered").json();
    assert_eq!(body["contactEmail"], "author@example.com");
    assert_eq!(cx.read(|cx| d.read(cx).phase()), Phase::Sent);
}

/// Signed in, the reply-to field opens with the account's email (0.1), so
/// requiring it asks nothing more of a signed-in author. A crash follow-up
/// and a message for the mail client say 「选填」 and go without one.
#[gpui::test]
fn the_reply_to_field_opens_with_the_accounts_email(cx: &mut TestAppContext) {
    let fake = FakeService::start(&[202]);
    let (ws, cx) = setup(cx, hosted(&fake));
    cx.update(|_, cx| Service::set_account_email(Some("author@example.com".into()), cx));
    cx.dispatch_action(SendFeedback);
    cx.run_until_parked();
    let d = dialog(&ws, cx).unwrap();
    let contact = cx.read(|cx| d.read(cx).contact_field().read(cx).text());
    assert_eq!(contact, "author@example.com");
    d.update(cx, |d, cx| {
        d.message_field()
            .clone()
            .update(cx, |f, cx| f.set_text("同步好像停了", cx))
    });
    cx.simulate_keystrokes(SEND_KEYS);
    cx.run_until_parked();
    let body = fake.next().expect("the service received it").json();
    assert_eq!(body["contactEmail"], "author@example.com");
    click_close_button(&ws, cx);

    // A crash follow-up: optional, though the service stores it.
    let optional = cx.read(|cx| dr_shell::t(cx, dr_i18n::keys::feedback::CONTACT_PLACEHOLDER));
    let follow_up = post_follow_up(cx);
    open_follow_up(&ws, follow_up, cx);
    let d = dialog(&ws, cx).unwrap();
    let (required, placeholder) = cx.read(|cx| {
        let dialog = d.read(cx);
        (
            dialog.contact_required(cx),
            dialog.contact_field().read(cx).placeholder_text().clone(),
        )
    });
    assert!(!required);
    assert_eq!(placeholder, optional);
    d.update_in(cx, |d, window, cx| d.dismiss(window, cx));
    cx.run_until_parked();

    // Signed out again: the next dialog opens empty.
    cx.update(|_, cx| Service::set_account_email(None, cx));
    cx.dispatch_action(SendFeedback);
    cx.run_until_parked();
    let d = dialog(&ws, cx).unwrap();
    assert_eq!(cx.read(|cx| d.read(cx).contact_field().read(cx).text()), "");
}

#[gpui::test]
fn the_summary_carries_the_sync_state_the_runtime_registered(cx: &mut TestAppContext) {
    let (ws, cx) = setup(cx, service(Delivery::Email));
    let summary_of = |ws: &Entity<Workspace>, cx: &mut VisualTestContext| {
        cx.dispatch_action(SendFeedback);
        cx.run_until_parked();
        let d = dialog(ws, cx).expect("SendFeedback opens the dialog");
        let text = cx.read(|cx| d.read(cx).summary().to_owned());
        (d, serde_json::from_str::<serde_json::Value>(&text).unwrap())
    };

    // Nothing registered: a library that does not sync, as before.
    let (d, value) = summary_of(&ws, cx);
    let local: serde_json::Value =
        serde_json::from_str(&diagnostics::summary(&SummaryInput::current("0.2.0-dev"))).unwrap();
    assert_eq!(value["sync"], local["sync"]);
    assert_eq!(value["sync"]["authorityStatus"], "local");
    d.update_in(cx, |d, window, cx| d.dismiss(window, cx));
    cx.run_until_parked();

    // The sync runtime's owner registers its state (signed in, the session
    // expired, a failed cycle, two changes and an image waiting).
    cx.update(|_, cx| {
        dr_shell::sync::set_diagnostics_hook(cx, |_| SyncSnapshot {
            authority_status: "cloud-attention".into(),
            provider_mode: "hosted".into(),
            runtime_mounted: true,
            online: Some(true),
            suspended: Some(false),
            pending: Pending {
                change_sets: 2,
                transfers: 1,
                failed: 1,
                ..Pending::default()
            },
            error_codes: vec![
                "sync.reauth-required".into(),
                "他推开门的时候，雨已经停了".into(),
            ],
            ..SyncSnapshot::local()
        })
    });
    let (d, value) = summary_of(&ws, cx);
    assert_eq!(
        value["sync"],
        serde_json::json!({
            "authorityStatus": "cloud-attention",
            "providerMode": "hosted",
            "activeProjects": 0,
            "readyProjects": 0,
            "provisioningProjects": 0,
            "pausedProjects": 0,
            "attentionProjects": 0,
            "runtimeMounted": true,
            "online": true,
            "suspended": false,
            "pending": {
                "changeSets": 2, "segments": 0, "transfers": 1, "gaps": 0,
                "conflicts": 0, "quarantined": 0, "failed": 1,
            },
            // Still sanitized: only plain identifiers.
            "errorCodes": ["redacted-error", "sync.reauth-required"],
        })
    );
    // What it would send is that summary.
    write(&d, "同步好像停了", "", cx);
    cx.simulate_keystrokes(SEND_KEYS);
    cx.run_until_parked();
    let body = decode(&cx.opened_url().expect("mail"));
    assert!(
        body.contains("\"authorityStatus\": \"cloud-attention\""),
        "{body}"
    );
    assert!(body.contains("\"providerMode\": \"hosted\""), "{body}");
    assert!(!body.contains("雨已经停了"));
}

#[gpui::test]
fn without_a_registered_dialog_nothing_opens(cx: &mut TestAppContext) {
    cx.update(|cx| {
        dr_shell::init(info(), Services::default(), SettingsFile::in_memory(), cx);
    });
    let (ws, cx) = cx.add_window_view(Workspace::new);
    cx.dispatch_action(SendFeedback);
    cx.run_until_parked();
    assert!(cx.read(|cx| ws.read(cx).dialog.is_none()));
}

/// The page the shell shows when the library could not be opened: its
/// 「提交反馈」 opens this dialog with no library, the first line and the
/// code already written; the rest is as always, and it sends.
#[gpui::test]
fn the_library_failure_page_opens_it_with_its_first_line_and_code(cx: &mut TestAppContext) {
    use dr_shell::library_failure::{Cause, LibraryFailure, PageButton};

    cx.executor().allow_parking();
    cx.update(|cx| {
        let _ = dr_ui::init(cx);
        dr_shell::init(
            info(),
            Services {
                library_failure: Some(LibraryFailure {
                    cause: Cause::Newer,
                    code: "schema-newer".into(),
                    folder: None,
                }),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx);
        dr_view_feedback::init(service(Delivery::Email), cx);
    });
    let (ws, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    assert!(cx.read(|cx| ws.read(cx).library_failure(cx).is_some()));
    assert!(cx.read(|cx| cx.global::<Services>().library.is_none()));
    draw(cx);
    let at = cx
        .debug_bounds(PageButton::Feedback.id())
        .expect("the page's 提交反馈")
        .center();
    click(at, cx);
    let d = dialog(&ws, cx).expect("提交反馈 opens the dialog");
    let message = cx.read(|cx| d.read(cx).message_field().read(cx).text());
    assert_eq!(message, "没能打开资料库（schema-newer）");
    assert!(cx.read(|cx| d.read(cx).attaches_summary()));
    assert_eq!(cx.read(|cx| d.read(cx).phase()), Phase::Editing);
    // Written already, so the mist keeps it.
    click(mist(), cx);
    assert!(dialog(&ws, cx).is_some());
    // It sends as it is.
    cx.simulate_keystrokes(SEND_KEYS);
    cx.run_until_parked();
    let mail = decode(&cx.opened_url().expect("mail"));
    assert!(mail.contains("没能打开资料库（schema-newer）"), "{mail}");
    assert!(dialog(&ws, cx).is_none());
}
