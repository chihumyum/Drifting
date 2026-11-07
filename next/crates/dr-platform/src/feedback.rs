//! Feedback the author writes and sends on purpose (M39), over the 0.1
//! client's versioned contract (`services/diagnostics/feedback.ts`, the
//! Hosted service's `docs/diagnostics-v1.md`):
//!
//! - `POST <API base>/api/diagnostics/v1/feedback`, JSON in the
//!   `drifting.feedback` format, version 1, with `Authorization: Bearer
//!   <session>` when signed in; any 2xx means it arrived;
//! - it carries the author's own words (at most [`MESSAGE_MAX`]
//!   characters), an optional reply-to address and, when they leave it
//!   attached, the sanitized diagnostic summary ([`crate::diagnostics`]);
//!   never manuscript text, the database or credentials;
//! - as a crash follow-up it names the crash it explains (`related`);
//! - builds without the Hosted service, development builds without
//!   `DRIFTING_CRASH_REPORTS_IN_DEV=1`, and a failed send hand the same
//!   message to the mail client instead ([`email_url`]).
//!
//! Feedback is sent on purpose, so it does not depend on the automatic
//! crash-report switch.

use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::diagnostics::iso_time;
use crate::identity::{Channel, Identity};
use crate::sanitize::report_token;

pub const FORMAT: &str = "drifting.feedback";
pub const FORMAT_VERSION: u32 = 1;
/// The longest message, in characters.
pub const MESSAGE_MAX: usize = 5000;
/// The contract's path under the API base.
pub const PATH: &str = "/api/diagnostics/v1/feedback";
/// Where feedback goes without the Hosted service (0.1's `SUPPORT_EMAIL`).
pub const SUPPORT_EMAIL: &str = "support@drifting.cc";
/// Build time: the Hosted service's API base (`https://…`). Unset, feedback
/// goes by mail; public source builds leave it unset.
pub const API_BASE_ENV: &str = "DRIFTING_API_BASE_URL";
/// Run time, development builds only: an API base for acceptance against a
/// local service (`http://127.0.0.1:<port>`), together with
/// `DRIFTING_CRASH_REPORTS_IN_DEV=1`.
pub const DEV_API_BASE_ENV: &str = "DRIFTING_DEV_API_BASE_URL";
/// How long one send may take.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(20);
/// Mail clients are reliable up to a few thousand characters of URL.
const MAX_MAIL_BODY: usize = 6000;
/// `related.kind`: the contract knows `render-failure` and `native-panic`;
/// every crash of the new client is native (a Rust panic or a native crash).
const CRASH_KIND: &str = "native-panic";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Problem {
    EmptyMessage,
    MessageTooLong,
    InvalidEmail,
}

/// What stops a draft from being sent, in 0.1's order.
pub fn problems(message: &str, contact_email: &str) -> Vec<Problem> {
    let mut problems = Vec::new();
    let message = message.trim();
    if message.is_empty() {
        problems.push(Problem::EmptyMessage);
    }
    if message.chars().count() > MESSAGE_MAX {
        problems.push(Problem::MessageTooLong);
    }
    let email = contact_email.trim();
    if !email.is_empty() && (email.len() > 254 || !valid_email(email)) {
        problems.push(Problem::InvalidEmail);
    }
    problems
}

/// One plain address: `local@domain.tld`, none of `<>()[]",;:\` or spaces
/// (so no header can be smuggled in), a top-level domain of 2+ letters.
fn valid_email(email: &str) -> bool {
    let forbidden = |c: char| c.is_whitespace() || "@<>()[]\",;:\\".contains(c);
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    let Some((host, tld)) = domain.rsplit_once('.') else {
        return false;
    };
    !local.is_empty()
        && !local.chars().any(forbidden)
        && !host.is_empty()
        && !host.chars().any(forbidden)
        && tld.len() >= 2
        && tld.chars().all(|c| c.is_ascii_alphabetic())
}

/// The crash a follow-up explains: the id F7's crash reporting tagged the
/// Sentry event with (`drifting.crash_id`), and when it happened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FollowUp {
    pub crash_id: String,
    pub occurred_at: SystemTime,
}

impl FollowUp {
    /// The grouping key the maintainer looks the crash up by.
    pub fn fingerprint(&self) -> String {
        report_token(&format!("{CRASH_KIND}:crash:{}", self.crash_id), 128)
    }
}

/// What the author wrote in the dialog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    pub message: String,
    pub contact_email: String,
    /// The summary text ([`crate::diagnostics::summary`]), or `None` when
    /// the author detached it.
    pub diagnostics: Option<String>,
    pub follow_up: Option<FollowUp>,
    /// The interface language (`zh-CN`, `en`, …).
    pub locale: String,
}

/// Which app sends it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sender {
    pub app_version: String,
    pub platform: String,
    /// [`crate::diagnostics::installation_id`].
    pub installation_id: String,
}

impl Sender {
    pub fn new(app_version: &str, installation_id: &str) -> Sender {
        Sender {
            app_version: report_token(app_version, 64),
            platform: report_token(std::env::consts::OS, 32),
            installation_id: installation_id.to_owned(),
        }
    }
}

/// The request body, field for field as 0.1 sent it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub format: &'static str,
    pub format_version: u32,
    /// `feedback` or `crash-follow-up`.
    pub kind: &'static str,
    pub message: String,
    pub contact_email: Option<String>,
    pub diagnostics: Option<serde_json::Value>,
    pub related: Option<Related>,
    pub app_version: String,
    pub platform: String,
    pub installation_id: String,
    pub locale: String,
    pub submitted_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Related {
    /// The service's id for the report; `None` because Sentry delivered it.
    pub report_id: Option<String>,
    pub kind: &'static str,
    pub fingerprint: String,
    pub occurred_at: String,
}

/// The summary, only when it is one (a JSON object in the summary format).
fn parsed_diagnostics(text: Option<&str>) -> Option<serde_json::Value> {
    let value: serde_json::Value = serde_json::from_str(text?).ok()?;
    (value.get("format").and_then(|f| f.as_str()) == Some(crate::diagnostics::FORMAT))
        .then_some(value)
}

pub fn payload(draft: &Draft, sender: &Sender, now: SystemTime) -> Payload {
    let email = draft.contact_email.trim();
    Payload {
        format: FORMAT,
        format_version: FORMAT_VERSION,
        kind: if draft.follow_up.is_some() {
            "crash-follow-up"
        } else {
            "feedback"
        },
        message: draft.message.trim().chars().take(MESSAGE_MAX).collect(),
        contact_email: (!email.is_empty()).then(|| email.to_owned()),
        diagnostics: parsed_diagnostics(draft.diagnostics.as_deref()),
        related: draft.follow_up.as_ref().map(|f| Related {
            report_id: None,
            kind: CRASH_KIND,
            fingerprint: f.fingerprint(),
            occurred_at: iso_time(f.occurred_at),
        }),
        app_version: sender.app_version.clone(),
        platform: sender.platform.clone(),
        installation_id: sender.installation_id.clone(),
        locale: report_token(&draft.locale, 16),
        submitted_at: iso_time(now),
    }
}

/// Where the contract's endpoint is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    url: String,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("the API base must be https:// (or http:// on this machine)")]
pub struct EndpointError;

impl Endpoint {
    /// `<base>/api/diagnostics/v1/feedback`. Only `https://`, or `http://`
    /// to this machine (a local service in development and tests).
    pub fn from_base(base: &str) -> Result<Endpoint, EndpointError> {
        let base = base.trim().trim_end_matches('/');
        let rest = if let Some(rest) = base.strip_prefix("https://") {
            rest
        } else if let Some(rest) = base.strip_prefix("http://") {
            let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
            let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
            let name = match host.strip_prefix('[') {
                Some(v6) => v6.split(']').next().unwrap_or_default(),
                None => host.split(':').next().unwrap_or_default(),
            };
            if !matches!(name, "127.0.0.1" | "localhost" | "::1") {
                return Err(EndpointError);
            }
            rest
        } else {
            return Err(EndpointError);
        };
        if rest.is_empty() || rest.contains(['?', '#', ' ']) {
            return Err(EndpointError);
        }
        Ok(Endpoint {
            url: format!("{base}{PATH}"),
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }
}

/// Where a submission goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Delivery {
    Hosted(Endpoint),
    /// The mail client, through [`email_url`].
    Email,
}

impl Delivery {
    /// This build: the Hosted service when it was built with one (release
    /// builds; development builds only with `DRIFTING_CRASH_REPORTS_IN_DEV=1`,
    /// and they may name a local service with `DRIFTING_DEV_API_BASE_URL`),
    /// otherwise mail.
    pub fn for_build(identity: &Identity) -> Delivery {
        let dev_opt_in =
            std::env::var(crate::crash::DEV_OPT_IN_ENV).is_ok_and(|value| value == "1");
        let dev_base = (identity.channel == Channel::Development)
            .then(|| std::env::var(DEV_API_BASE_ENV).ok())
            .flatten();
        Delivery::decide(
            dev_base.as_deref().or(option_env!("DRIFTING_API_BASE_URL")),
            identity.channel,
            dev_opt_in,
        )
    }

    pub fn decide(base: Option<&str>, channel: Channel, dev_opt_in: bool) -> Delivery {
        if channel == Channel::Development && !dev_opt_in {
            return Delivery::Email;
        }
        match base
            .filter(|b| !b.trim().is_empty())
            .map(Endpoint::from_base)
        {
            Some(Ok(endpoint)) => Delivery::Hosted(endpoint),
            Some(Err(error)) => {
                tracing::warn!("feedback goes by mail: {error}");
                Delivery::Email
            }
            None => Delivery::Email,
        }
    }
}

/// `encodeURIComponent`.
fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A `mailto:` URL to [`SUPPORT_EMAIL`] carrying the same message, the
/// version and, when attached and short enough, the summary.
pub fn email_url(draft: &Draft, sender: &Sender, subject: &str) -> String {
    let mut footer = format!("Drifting {} · {}", sender.app_version, sender.platform);
    if let Some(follow_up) = &draft.follow_up {
        footer.push_str(&format!(
            "\n{} · {}",
            follow_up.fingerprint(),
            iso_time(follow_up.occurred_at)
        ));
    }
    let head = format!("{}\n\n—\n{footer}", draft.message.trim());
    let body = match &draft.diagnostics {
        Some(summary) => format!("{head}\n\n{}", summary.trim()),
        None => head.clone(),
    };
    let body = if body.chars().count() <= MAX_MAIL_BODY {
        body
    } else {
        head.chars().take(MAX_MAIL_BODY).collect()
    };
    format!(
        "mailto:{SUPPORT_EMAIL}?subject={}&body={}",
        encode_component(subject),
        encode_component(&body)
    )
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum SendError {
    /// The service answered, but not with success.
    #[error("the service answered {0}")]
    Status(u16),
    /// No answer: no network, a timeout, a refused connection. Only the
    /// kind, never the error text (it can carry the URL).
    #[error("no answer from the service ({0})")]
    Network(&'static str),
}

/// Without the `network` feature (the Windows cross-check) there is no
/// HTTP client: every send fails and the dialog offers mail.
#[cfg(not(feature = "network"))]
pub fn send(_: &Endpoint, _: Option<&str>, _: &Payload) -> Result<(), SendError> {
    Err(SendError::Network("unavailable"))
}

/// Posts `payload` to `endpoint`, with the Hosted session when signed in.
/// Blocking; run it off the main thread.
#[cfg(feature = "network")]
pub fn send(
    endpoint: &Endpoint,
    session: Option<&str>,
    payload: &Payload,
) -> Result<(), SendError> {
    crate::install_tls_provider();
    let classify = |error: &reqwest::Error| {
        if error.is_timeout() {
            "timeout"
        } else if error.is_connect() {
            "connect"
        } else if error.is_builder() {
            "request"
        } else {
            "transport"
        }
    };
    let client = reqwest::blocking::Client::builder()
        .timeout(SEND_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("Drifting/{}", payload.app_version))
        .build()
        .map_err(|e| SendError::Network(classify(&e)))?;
    let body = serde_json::to_vec(payload).map_err(|_| SendError::Network("request"))?;
    let mut request = client
        .post(endpoint.url())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(session) = session.filter(|s| !s.is_empty()) {
        request = request.bearer_auth(session);
    }
    let response = request
        .send()
        .map_err(|e| SendError::Network(classify(&e)))?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(SendError::Status(status.as_u16()))
    }
}

/// A stand-in for the Hosted service on this machine, for tests: it listens
/// on `127.0.0.1`, answers each request with the next status it was given,
/// and hands back what it received. Nothing here ever reaches a real
/// service.
#[cfg(any(test, feature = "test-support"))]
pub mod fake_service {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// One request as the service saw it.
    #[derive(Clone, Debug)]
    pub struct Received {
        /// `POST /api/diagnostics/v1/feedback HTTP/1.1`.
        pub request_line: String,
        /// Header names in lower case.
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
    }

    impl Received {
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.as_str())
        }

        pub fn json(&self) -> serde_json::Value {
            serde_json::from_slice(&self.body).expect("a JSON body")
        }
    }

    pub struct FakeService {
        /// `http://127.0.0.1:<port>`: give it to `Endpoint::from_base`.
        pub base: String,
        received: mpsc::Receiver<Received>,
    }

    impl FakeService {
        /// Answers the requests, in order, with `statuses`, then stops.
        pub fn start(statuses: &[u16]) -> FakeService {
            let listener = TcpListener::bind("127.0.0.1:0").expect("a local port");
            let base = format!("http://{}", listener.local_addr().unwrap());
            let (sender, received) = mpsc::channel();
            let statuses = statuses.to_vec();
            std::thread::spawn(move || {
                for status in statuses {
                    let Ok((stream, _)) = listener.accept() else {
                        return;
                    };
                    let mut reader = BufReader::new(stream);
                    let mut request_line = String::new();
                    if reader.read_line(&mut request_line).is_err() {
                        return;
                    }
                    let mut headers: Vec<(String, String)> = Vec::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                            break;
                        }
                        if let Some((name, value)) = line.split_once(':') {
                            headers.push((name.trim().to_ascii_lowercase(), value.trim().into()));
                        }
                    }
                    let length = headers
                        .iter()
                        .find(|(n, _)| n == "content-length")
                        .and_then(|(_, v)| v.parse::<usize>().ok())
                        .unwrap_or(0);
                    let mut body = vec![0; length];
                    let _ = reader.read_exact(&mut body);
                    let mut stream = reader.into_inner();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} X\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}"
                    );
                    let _ = sender.send(Received {
                        request_line: request_line.trim().into(),
                        headers,
                        body,
                    });
                }
            });
            FakeService { base, received }
        }

        /// The next request it answered, waiting up to five seconds.
        pub fn next(&self) -> Option<Received> {
            self.received
                .recv_timeout(std::time::Duration::from_secs(5))
                .ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::UNIX_EPOCH;

    use super::*;
    use crate::diagnostics::{SummaryInput, summary};

    // Synthetic prose that must never leave with feedback the author did not type.
    const MANUSCRIPT: &str = "他推开门的时候，雨已经停了，街上只剩下潮湿的灯光。";

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn sender() -> Sender {
        Sender {
            app_version: "0.2.0-dev".into(),
            platform: "macos".into(),
            installation_id: format!("diag-{}", "0".repeat(36)),
        }
    }

    pub(super) fn draft() -> Draft {
        let mut input = SummaryInput::current("0.2.0-dev");
        input.sync.error_codes = vec![MANUSCRIPT.into()];
        Draft {
            message: "  The outline froze after I renamed an act.  ".into(),
            contact_email: "author@example.com".into(),
            diagnostics: Some(summary(&input)),
            follow_up: None,
            locale: "zh-CN".into(),
        }
    }

    #[test]
    fn asks_for_a_message_and_an_address_that_can_be_answered() {
        use Problem::*;
        assert_eq!(problems("   ", ""), [EmptyMessage]);
        assert_eq!(problems(&"x".repeat(5001), ""), [MessageTooLong]);
        assert_eq!(problems(&"字".repeat(5000), ""), Vec::<Problem>::new());
        assert_eq!(problems("Hi", "not an address"), [InvalidEmail]);
        assert_eq!(problems("Hi", "a@b.c\nBcc: x@y.zz"), [InvalidEmail]);
        assert_eq!(problems("Hi", "a@b.c"), [InvalidEmail]);
        assert_eq!(problems("Hi", "a<b@c.de"), [InvalidEmail]);
        assert_eq!(problems("Hi", ""), Vec::<Problem>::new());
        assert_eq!(
            problems("Hi", " author@example.com "),
            Vec::<Problem>::new()
        );
    }

    #[test]
    fn builds_0_1s_payload_with_the_authors_words_and_only_the_summary() {
        // 2026-10-31T08:01:00Z
        let payload = payload(&draft(), &sender(), at(1_793_433_660));
        let value = serde_json::to_value(&payload).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "appVersion",
                "contactEmail",
                "diagnostics",
                "format",
                "formatVersion",
                "installationId",
                "kind",
                "locale",
                "message",
                "platform",
                "related",
                "submittedAt"
            ]
        );
        assert_eq!(value["format"], "drifting.feedback");
        assert_eq!(value["formatVersion"], 1);
        assert_eq!(value["kind"], "feedback");
        assert_eq!(
            value["message"],
            "The outline froze after I renamed an act."
        );
        assert_eq!(value["contactEmail"], "author@example.com");
        assert_eq!(value["related"], serde_json::Value::Null);
        assert_eq!(value["locale"], "zh-CN");
        assert_eq!(value["submittedAt"], "2026-10-31T08:01:00.000Z");
        assert_eq!(
            value["diagnostics"]["format"],
            "drifting.sanitized-diagnostics"
        );
        assert_eq!(value["diagnostics"]["privacy"]["manuscriptIncluded"], false);
        assert!(!value.to_string().contains("雨已经停了"));
    }

    #[test]
    fn detached_summary_and_empty_address_are_left_out() {
        let mut d = draft();
        d.diagnostics = None;
        d.contact_email = "  ".into();
        let p = payload(&d, &sender(), at(0));
        assert_eq!(p.diagnostics, None);
        assert_eq!(p.contact_email, None);
        // Only a summary is attached, never other text.
        d.diagnostics = Some(MANUSCRIPT.into());
        assert_eq!(payload(&d, &sender(), at(0)).diagnostics, None);
        d.message = "x".repeat(MESSAGE_MAX + 10);
        assert_eq!(
            payload(&d, &sender(), at(0)).message.chars().count(),
            MESSAGE_MAX
        );
    }

    #[test]
    fn a_follow_up_names_the_crash_it_explains() {
        let mut d = draft();
        d.follow_up = Some(FollowUp {
            crash_id: "3f2a9c0d1e2b4a5f8c7d6e5f4a3b2c1d".into(),
            // 2026-10-31T07:59:00Z
            occurred_at: at(1_793_433_540),
        });
        let value = serde_json::to_value(payload(&d, &sender(), at(0))).unwrap();
        assert_eq!(value["kind"], "crash-follow-up");
        assert_eq!(
            value["related"],
            serde_json::json!({
                "reportId": null,
                "kind": "native-panic",
                "fingerprint": "native-panic:crash:3f2a9c0d1e2b4a5f8c7d6e5f4a3b2c1d",
                "occurredAt": "2026-10-31T07:59:00.000Z",
            })
        );
    }

    #[test]
    fn delivery_is_mail_without_a_service_and_in_development() {
        let base = Some("https://sync.example.test/");
        assert_eq!(
            Delivery::decide(base, Channel::Release, false),
            Delivery::Hosted(Endpoint {
                url: "https://sync.example.test/api/diagnostics/v1/feedback".into()
            })
        );
        assert_eq!(
            Delivery::decide(None, Channel::Release, false),
            Delivery::Email
        );
        assert_eq!(
            Delivery::decide(base, Channel::Development, false),
            Delivery::Email
        );
        assert!(matches!(
            Delivery::decide(base, Channel::Development, true),
            Delivery::Hosted(_)
        ));
        // Plain http only to this machine.
        assert_eq!(
            Delivery::decide(Some("http://sync.example.test"), Channel::Release, false),
            Delivery::Email
        );
        assert!(Endpoint::from_base("http://127.0.0.1:4100").is_ok());
        assert!(Endpoint::from_base("http://localhost:3000/").is_ok());
        assert!(Endpoint::from_base("http://[::1]:3000").is_ok());
        assert!(Endpoint::from_base("http://127.0.0.1.example.test").is_err());
        assert!(Endpoint::from_base("http://user@evil.test").is_err());
        assert!(Endpoint::from_base("ftp://x.test").is_err());
        assert!(Endpoint::from_base("https://x.test/?q").is_err());
    }

    #[test]
    fn mail_carries_the_same_message() {
        let url = email_url(&draft(), &sender(), "Drifting 反馈");
        assert!(
            url.starts_with(
                "mailto:support@drifting.cc?subject=Drifting%20%E5%8F%8D%E9%A6%88&body="
            ),
            "{url}"
        );
        let body = percent_decode(&url[url.find("&body=").unwrap() + 6..]);
        assert!(body.contains("The outline froze after I renamed an act."));
        assert!(body.contains("Drifting 0.2.0-dev · macos"));
        assert!(body.contains("\"format\": \"drifting.sanitized-diagnostics\""));
        assert!(!body.contains("雨已经停了"));
        let mut detached = draft();
        detached.diagnostics = None;
        assert!(
            !percent_decode(&email_url(&detached, &sender(), "x"))
                .contains("sanitized-diagnostics")
        );
        // Too long for a mail URL: the summary is dropped, the message stays.
        let mut long = draft();
        long.message = "y".repeat(MAX_MAIL_BODY - 10);
        let body = percent_decode(&email_url(&long, &sender(), "x"));
        assert!(!body.contains("sanitized-diagnostics"));
        assert!(body.contains("yyyy"));
    }

    #[cfg(feature = "network")]
    #[test]
    fn posts_the_contract_to_a_local_service_with_the_session() {
        let service = fake_service::FakeService::start(&[202, 503]);
        let endpoint = Endpoint::from_base(&service.base).unwrap();
        let body = payload(&draft(), &sender(), at(0));

        assert_eq!(send(&endpoint, Some("session-token"), &body), Ok(()));
        let got = service.next().expect("the service saw the request");
        assert_eq!(
            got.request_line,
            "POST /api/diagnostics/v1/feedback HTTP/1.1"
        );
        assert_eq!(got.header("authorization"), Some("Bearer session-token"));
        assert_eq!(got.header("content-type"), Some("application/json"));
        assert_eq!(got.json()["format"], "drifting.feedback");
        assert_eq!(got.json()["kind"], "feedback");

        assert_eq!(send(&endpoint, None, &body), Err(SendError::Status(503)));
        assert_eq!(service.next().unwrap().header("authorization"), None);
    }

    #[cfg(feature = "network")]
    #[test]
    fn no_service_is_a_network_error_for_the_mail_fallback() {
        // A port that was free a moment ago: nothing listens there.
        let base = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        };
        let endpoint = Endpoint::from_base(&base).unwrap();
        assert!(matches!(
            send(&endpoint, None, &payload(&draft(), &sender(), at(0))),
            Err(SendError::Network(_))
        ));
    }

    fn percent_decode(text: &str) -> String {
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
}
