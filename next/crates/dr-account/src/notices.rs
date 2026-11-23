//! Account notices v1 (`/api/account/v1/notices`): what the operator of the
//! Hosted service tells signed-in authors, the 0.1 client's contract
//! (`docs/hosted-sync/notices.md`, `src/renderer/features/notices/`).
//!
//! `GET /api/account/v1/notices` with the account's bearer session answers
//! the active notices addressed to the account, the account's read mark
//! (`readThrough`: notices at or below it were seen on one of the account's
//! devices) and how long a client in front waits before reading again.
//! `POST /api/account/v1/notices/read` with `{ "through": <seq> }` raises the
//! mark; the service never moves it back. A service without the routes
//! answers 404 ([`NoticesEndpoint::Unsupported`]).
//!
//! Nothing in a response is trusted: an entry without an id, a `seq` or any
//! text is dropped, never shown half; text is plain, cleaned of control
//! characters and cut to a bounded length; only an `https:` link without
//! credentials is kept; the refresh interval is clamped; a response larger
//! than [`MAX_RESPONSE_BYTES`] is refused whole. Errors never carry the
//! response's words, so logging one never logs a notice.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, SystemTime};

use serde_json::Value;

use crate::client::{AccountError, AccountService};
use crate::profile::AccountErrorCode;

pub const NOTICES_PATH: &str = "/api/account/v1/notices";
pub const NOTICES_READ_PATH: &str = "/api/account/v1/notices/read";

/// How long a client in front waits before reading again, when the service
/// does not say (0.1's `NOTICE_REFRESH_DEFAULT_SECONDS`).
pub const REFRESH_DEFAULT: Duration = Duration::from_secs(60);
pub const REFRESH_MIN: Duration = Duration::from_secs(15);
pub const REFRESH_MAX: Duration = Duration::from_secs(3600);

/// A response larger than this is refused whole.
pub const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
/// At most this many notices of one response are kept, the newest: they are
/// rows of a notification center that keeps 50 of every source.
pub const MAX_NOTICES: usize = 20;
/// A title is one line of at most this many characters; a longer one is cut
/// and ends in `…`.
pub const MAX_TITLE_CHARS: usize = 200;
/// A body is at most this many characters; a longer one is cut and ends in `…`.
pub const MAX_BODY_CHARS: usize = 2000;
/// Ids are the service's UUIDs; anything longer is not one.
const MAX_ID_CHARS: usize = 128;
/// The service writes `zh`, `en` or both.
const MAX_LANGUAGES: usize = 8;
/// `Number.MAX_SAFE_INTEGER`: the service's numbers are JavaScript numbers.
const MAX_SEQ: u64 = (1 << 53) - 1;

/// One language's words of a notice: plain text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoticeText {
    /// One line, never empty.
    pub title: String,
    /// Line breaks kept; may be empty.
    pub body: String,
}

/// One notice as the service offers it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountNotice {
    pub id: String,
    /// Grows with every notice the service publishes; the unit of the read mark.
    pub seq: u64,
    /// Addressed to this account alone.
    pub personal: bool,
    /// One entry per language the operator wrote (`zh`, `en`), never empty.
    pub content: BTreeMap<String, NoticeText>,
    /// An `https:` page the notice names, if any. The desktop client does
    /// not open it: its notification center has no link rows.
    pub link: Option<String>,
    pub published_at: Option<SystemTime>,
}

impl AccountNotice {
    /// The words for an interface language (`zh-CN`, `en`, …): Chinese for a
    /// Chinese interface, English for every other; a notice written in one
    /// language only is shown in that language (0.1's `noticeText`).
    #[must_use]
    pub fn text_for(&self, locale: &str) -> Option<&NoticeText> {
        let preferred = if locale.to_ascii_lowercase().starts_with("zh") {
            "zh"
        } else {
            "en"
        };
        self.content
            .get(preferred)
            .or_else(|| self.content.get("en"))
            .or_else(|| self.content.values().next())
    }
}

/// What `GET /api/account/v1/notices` answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountNotices {
    /// The active notices addressed to the account, oldest first.
    pub notices: Vec<AccountNotice>,
    /// Notices up to this `seq` were seen on one of the account's devices.
    pub read_through: u64,
    /// How long a client in front waits before reading again.
    pub refresh_after: Duration,
}

/// A notices route's answer, or that the service has no such route (404).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NoticesEndpoint<T> {
    Supported(T),
    Unsupported,
}

fn malformed() -> AccountError {
    AccountError::new(
        AccountErrorCode::Unknown,
        "account notices response is not well formed",
    )
}

/// Reads a notices response, keeping only what is well formed.
///
/// # Errors
///
/// When the response is not JSON, not an object or has no `notices` list.
pub fn parse_account_notices(bytes: &[u8]) -> Result<AccountNotices, AccountError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| malformed())?;
    let Some(entries) = value.get("notices").and_then(Value::as_array) else {
        return Err(malformed());
    };
    let mut notices: Vec<AccountNotice> = entries.iter().filter_map(parse_notice).collect();
    notices.sort_by_key(|n| n.seq);
    let mut ids = BTreeSet::new();
    notices.retain(|n| ids.insert(n.id.clone()));
    if notices.len() > MAX_NOTICES {
        notices.drain(..notices.len() - MAX_NOTICES);
    }
    let refresh = value
        .get("refreshAfterSeconds")
        .and_then(Value::as_f64)
        .filter(|s| s.is_finite())
        .map_or(REFRESH_DEFAULT, |s| {
            Duration::from_secs_f64(s.clamp(REFRESH_MIN.as_secs_f64(), REFRESH_MAX.as_secs_f64()))
        });
    Ok(AccountNotices {
        notices,
        read_through: value.get("readThrough").and_then(seq).unwrap_or(0),
        refresh_after: refresh,
    })
}

/// Reads `POST /api/account/v1/notices/read`'s answer: the account's mark.
///
/// # Errors
///
/// When the answer has no well-formed `readThrough`.
pub fn parse_read_mark(bytes: &[u8]) -> Result<u64, AccountError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| malformed())?;
    value.get("readThrough").and_then(seq).ok_or_else(malformed)
}

fn seq(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n <= MAX_SEQ)
}

fn parse_notice(entry: &Value) -> Option<AccountNotice> {
    let id = entry.get("id")?.as_str()?;
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS || id.chars().any(char::is_control) {
        return None;
    }
    let seq = seq(entry.get("seq")?)?;
    let content = parse_content(entry.get("content")?);
    if content.is_empty() {
        return None;
    }
    Some(AccountNotice {
        id: id.to_owned(),
        seq,
        personal: entry.get("personal").and_then(Value::as_bool) == Some(true),
        content,
        link: entry
            .get("link")
            .and_then(Value::as_str)
            .and_then(notice_link),
        published_at: entry
            .get("publishedAt")
            .and_then(Value::as_str)
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .map(SystemTime::from),
    })
}

fn parse_content(value: &Value) -> BTreeMap<String, NoticeText> {
    let mut content = BTreeMap::new();
    let Some(languages) = value.as_object() else {
        return content;
    };
    for (language, text) in languages {
        if content.len() == MAX_LANGUAGES {
            break;
        }
        let (Some(title), Some(body)) = (
            text.get("title").and_then(Value::as_str),
            text.get("body").and_then(Value::as_str),
        ) else {
            continue;
        };
        if language.is_empty() || language.len() > 16 {
            continue;
        }
        let title = clean(&title.replace(['\r', '\n'], " "), MAX_TITLE_CHARS);
        if title.is_empty() {
            continue;
        }
        content.insert(
            language.clone(),
            NoticeText {
                title,
                body: clean(body, MAX_BODY_CHARS),
            },
        );
    }
    content
}

/// Plain text: line breaks become `\n`, tabs spaces; other control
/// characters and the bidirectional overrides go; trimmed; cut to `max`
/// characters, the last one `…`.
fn clean(text: &str, max: usize) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let kept: String = text
        .chars()
        .filter_map(|c| match c {
            '\n' => Some('\n'),
            '\t' => Some(' '),
            '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' => None,
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect();
    let trimmed = kept.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_owned();
    }
    let mut cut: String = trimmed.chars().take(max.saturating_sub(1)).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
}

/// Only an `https:` URL without credentials is ever kept (0.1's `noticeLink`).
#[must_use]
pub fn notice_link(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    (url.scheme() == "https" && url.username().is_empty() && url.password().is_none())
        .then(|| url.to_string())
}

impl AccountService {
    /// Reads the signed-in account's notices. Makes no request in a
    /// local-only build or without a stored session.
    ///
    /// # Errors
    ///
    /// `HostedNotConfigured` in a local-only build; `Unauthorized` without a
    /// session or when the service refuses it (with its status); `Network`;
    /// otherwise `Unknown` (a failing service, a malformed or oversized
    /// response).
    pub fn read_notices(&self) -> Result<NoticesEndpoint<AccountNotices>, AccountError> {
        let (origin, token) = self.notices_session()?;
        self.client().get_notices(origin, &token)
    }

    /// Raises the account's read mark to `through`; answers the mark the
    /// service keeps.
    ///
    /// # Errors
    ///
    /// As [`AccountService::read_notices`].
    pub fn mark_notices_read(&self, through: u64) -> Result<NoticesEndpoint<u64>, AccountError> {
        let (origin, token) = self.notices_session()?;
        self.client().mark_notices_read(origin, &token, through)
    }

    fn notices_session(&self) -> Result<(&crate::HostedOrigin, String), AccountError> {
        let origin = self.config().origin().ok_or_else(|| {
            AccountError::new(
                AccountErrorCode::HostedNotConfigured,
                "Hosted service is not configured in local-only mode",
            )
        })?;
        let token = self.current_token().ok_or_else(|| {
            AccountError::new(AccountErrorCode::Unauthorized, "Not signed in to Hosted")
        })?;
        Ok((origin, token))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: Value) -> AccountNotices {
        parse_account_notices(value.to_string().as_bytes()).expect("well formed")
    }

    #[test]
    fn a_response_keeps_only_well_formed_notices_oldest_first() {
        let got = parse(json!({
            "notices": [
                { "id": "b", "seq": 12, "content": { "en": { "title": "Later", "body": "" } } },
                { "id": "a", "seq": 3, "personal": true,
                  "content": { "zh": { "title": " 维护 ", "body": "第一行\r\n第二行\t完" } },
                  "link": "https://drifting.example/status", "publishedAt": "2026-11-20T08:00:00.000Z" },
                // Dropped: no id, an empty id, no seq, a negative or unsafe seq,
                // no text, an empty title, text that is not text.
                { "seq": 4, "content": { "en": { "title": "x", "body": "" } } },
                { "id": "", "seq": 5, "content": { "en": { "title": "x", "body": "" } } },
                { "id": "c", "content": { "en": { "title": "x", "body": "" } } },
                { "id": "d", "seq": -1, "content": { "en": { "title": "x", "body": "" } } },
                { "id": "e", "seq": 9007199254740992u64, "content": { "en": { "title": "x", "body": "" } } },
                { "id": "f", "seq": 6, "content": {} },
                { "id": "g", "seq": 7, "content": { "en": { "title": "   ", "body": "x" } } },
                { "id": "h", "seq": 8, "content": { "en": { "title": 1, "body": "x" } } },
                "not a notice",
                // The same id twice is one notice.
                { "id": "b", "seq": 13, "content": { "en": { "title": "Again", "body": "" } } }
            ],
            "readThrough": 3,
            "refreshAfterSeconds": 1
        }));
        let ids: Vec<_> = got.notices.iter().map(|n| (n.id.as_str(), n.seq)).collect();
        assert_eq!(ids, [("a", 3), ("b", 12)]);
        let a = &got.notices[0];
        assert!(a.personal && !got.notices[1].personal);
        assert_eq!(
            a.content["zh"],
            NoticeText {
                title: "维护".into(),
                body: "第一行\n第二行 完".into()
            }
        );
        assert_eq!(a.link.as_deref(), Some("https://drifting.example/status"));
        assert!(a.published_at.is_some());
        assert_eq!(got.read_through, 3);
        // Clamped to 15 s … 1 h.
        assert_eq!(got.refresh_after, REFRESH_MIN);
        assert_eq!(
            parse(json!({ "notices": [], "refreshAfterSeconds": 1e9 })).refresh_after,
            REFRESH_MAX
        );
        let bare = parse(json!({ "notices": [], "readThrough": "7" }));
        assert_eq!(
            (bare.read_through, bare.refresh_after),
            (0, REFRESH_DEFAULT)
        );
    }

    #[test]
    fn a_response_without_a_notices_list_is_refused_and_says_nothing_of_it() {
        for raw in [
            "not json".to_owned(),
            "[]".to_owned(),
            json!({ "notices": "x" }).to_string(),
            json!({ "readThrough": 1 }).to_string(),
        ] {
            let err = parse_account_notices(raw.as_bytes()).expect_err(&raw);
            assert_eq!(err.code, AccountErrorCode::Unknown);
            assert_eq!(err.message, malformed().message, "{raw}");
        }
        assert!(parse_read_mark(br#"{"readThrough":4}"#).is_ok_and(|m| m == 4));
        assert!(parse_read_mark(br#"{"readThrough":-4}"#).is_err());
    }

    #[test]
    fn text_is_plain_bounded_and_picked_for_the_interface_language() {
        let long = "长".repeat(MAX_BODY_CHARS + 50);
        let got = parse(json!({ "notices": [{
            "id": "n", "seq": 1,
            "content": {
                "zh": { "title": "第一\n第二", "body": long },
                "en": { "title": format!("A\u{202E}B\u{0007}C{}", "x".repeat(MAX_TITLE_CHARS)), "body": "<b>not bold</b>" }
            }
        }]}));
        let n = &got.notices[0];
        let zh = n.text_for("zh-TW").unwrap();
        assert_eq!(zh.title, "第一 第二");
        assert_eq!(zh.body.chars().count(), MAX_BODY_CHARS);
        assert!(zh.body.ends_with('…'));
        let en = n.text_for("ja").unwrap();
        assert!(en.title.starts_with("ABC"));
        assert_eq!(en.title.chars().count(), MAX_TITLE_CHARS);
        // Markup is text like any other.
        assert_eq!(en.body, "<b>not bold</b>");

        let zh_only = parse(json!({ "notices": [{
            "id": "z", "seq": 2, "content": { "zh": { "title": "只有中文", "body": "" } }
        }]}));
        assert_eq!(zh_only.notices[0].text_for("en").unwrap().title, "只有中文");
    }

    #[test]
    fn only_https_links_without_credentials_are_kept() {
        assert_eq!(
            notice_link("https://drifting.example/a?b=1").as_deref(),
            Some("https://drifting.example/a?b=1")
        );
        for bad in [
            "http://drifting.example/",
            "https://user:pw@drifting.example/",
            "https://user@drifting.example/",
            "javascript:alert(1)",
            "file:///etc/hosts",
            "drifting://open/x",
            "not a url",
        ] {
            assert_eq!(notice_link(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_response_keeps_the_newest_notices_only() {
        let entries: Vec<Value> = (1..=MAX_NOTICES as u64 + 5)
            .map(|seq| json!({ "id": format!("n{seq}"), "seq": seq, "content": { "en": { "title": "t", "body": "" } } }))
            .collect();
        let got = parse(json!({ "notices": entries }));
        assert_eq!(got.notices.len(), MAX_NOTICES);
        assert_eq!(got.notices[0].seq, 6);
        assert_eq!(got.notices.last().unwrap().seq, MAX_NOTICES as u64 + 5);
    }
}
