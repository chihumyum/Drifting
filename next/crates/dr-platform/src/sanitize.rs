//! Keeping manuscript text, secrets and personal paths out of crash reports
//! and feedback, with the 0.1 client's rules (`services/diagnostics/
//! crash-sanitize.ts`, `sanitized-summary.ts`), in the same order:
//!
//! 1. `Bearer <token>` → `Bearer [redacted]`; `sk-…` / `sk_…` keys and JWTs
//!    → `[credential]`; `api_key=`, `access_token:`, `password=`, … keep
//!    their name and lose their value;
//! 2. e-mail addresses → `[email]`; a URL keeps its path and loses its query
//!    and fragment;
//! 3. a home folder (the folder under `/Users` or `/home`, and this
//!    process's own, which covers Windows) → `~`;
//! 4. runs of 12 or more CJK characters (with CJK punctuation) → `[text]`;
//!    quoted spans of 40 or more characters → the quotes around `[text]`;
//!    runs of 13 or more words → `[text]`;
//! 5. whitespace collapsed, and the result cut to 300 characters with `…`.
//!
//! A Rust panic message can quote whole strings (slicing a `&str` off a char
//! boundary prints the string), so every panic message goes through this
//! before it is written or sent. It is defence in depth: code must still
//! never put prose or secrets in errors.

use std::sync::LazyLock;

use regex::Regex;

/// The longest message a report or a summary carries.
pub const MAX_MESSAGE_CHARS: usize = 300;

struct Rules {
    bearer: Regex,
    api_key: Regex,
    jwt: Regex,
    named_secret: Regex,
    email: Regex,
    url_query: Regex,
    home_path: Regex,
    cjk_run: Regex,
    long_quoted: Regex,
    long_sentence: Regex,
    whitespace: Regex,
    token_unsafe: Regex,
    safe_code: Regex,
}

static RULES: LazyLock<Rules> = LazyLock::new(|| {
    let re = |pattern: &str| Regex::new(pattern).expect("a valid sanitizing rule");
    Rules {
        bearer: re(r"(?i)\bBearer\s+[^\s,;]+"),
        api_key: re(r"\b(?:sk-|sk_)[A-Za-z0-9_-]{8,}"),
        jwt: re(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"),
        named_secret: re(
            r"(?i)\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+",
        ),
        email: re(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
        url_query: re(r"(?i)(https?://[^\s?#]+)[?#][^\s)]+"),
        home_path: re(r"/(?:Users|home)/[^/\s:)]+"),
        cjk_run: re(
            r"[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。！？、；：“”‘’（）《》]{12,}",
        ),
        long_quoted: re(r#"(["'`“‘「『])[^"'`”’」』\n]{40,}(["'`”’」』])"#),
        long_sentence: re(r"(?:\b[\p{L}'’-]+\b[ ,;:]+){12,}\b[\p{L}'’-]+\b"),
        whitespace: re(r"\s+"),
        token_unsafe: re(r"[^A-Za-z0-9:._-]+"),
        safe_code: re(r"^[A-Za-z0-9._-]{1,128}$"),
    }
});

/// The home folder, as this process sees it.
fn home() -> Option<String> {
    dirs::home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .filter(|home| home.len() > 1)
}

/// The home folder replaced by `~`: this process's own, and any folder
/// directly under `/Users` or `/home`.
pub fn redact_home(text: &str) -> String {
    let text = match home() {
        Some(home) => text.replace(&home, "~"),
        None => text.to_owned(),
    };
    RULES.home_path.replace_all(&text, "~").into_owned()
}

/// Free text bound for a report (a panic message, an error, an exception
/// value), at most [`MAX_MESSAGE_CHARS`].
pub fn message(text: &str) -> String {
    report_text(text, MAX_MESSAGE_CHARS)
}

/// `sanitizeReportText`: every rule above, cut to `max` characters.
pub fn report_text(text: &str, max: usize) -> String {
    let r = &*RULES;
    let text = r.bearer.replace_all(text, "Bearer [redacted]");
    let text = r.api_key.replace_all(&text, "[credential]");
    let text = r.jwt.replace_all(&text, "[credential]");
    let text = r.named_secret.replace_all(&text, "${1}[redacted]");
    let text = r.email.replace_all(&text, "[email]");
    let text = r.url_query.replace_all(&text, "${1}[redacted]");
    let text = redact_home(&text);
    let text = r.cjk_run.replace_all(&text, "[text]");
    let text = r.long_quoted.replace_all(&text, "${1}[text]${2}");
    let text = r.long_sentence.replace_all(&text, "[text]");
    let text = r.whitespace.replace_all(&text, " ");
    truncate(text.trim(), max)
}

/// `reportToken`: a value that may only hold `A-Z a-z 0-9 : . _ -` (an app
/// version, a platform, a locale, a fingerprint), at most `max` characters;
/// `unknown` when nothing is left.
pub fn report_token(value: &str, max: usize) -> String {
    let token = RULES.token_unsafe.replace_all(value, "-");
    let token = token.trim_matches('-');
    let token = if token.is_empty() { "unknown" } else { token };
    token.chars().take(max).collect()
}

/// `sanitizedCode` of the diagnostic summary: an error code that is a plain
/// identifier is kept, anything else becomes `redacted-error`.
pub fn error_code(value: &str) -> String {
    if RULES.safe_code.is_match(value) {
        value.to_owned()
    } else {
        "redacted-error".to_owned()
    }
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(limit.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    // Synthetic prose, never a real manuscript.
    const PROSE: &str = "他推开门的时候，雨已经停了，街上只剩下潮湿的灯光";

    #[test]
    fn prose_in_a_slicing_panic_is_removed() {
        let prose = "他推开门，看见雨还在下，远处的灯一盏一盏地灭了。";
        let panic = format!(
            "byte index 5 is not a char boundary; it is inside '推' (bytes 3..6) of `{prose}`"
        );
        let cleaned = message(&panic);
        assert!(!cleaned.contains("远处的灯"));
        assert!(cleaned.starts_with("byte index 5 is not a char boundary"));
    }

    /// The cases of the 0.1 client's `crash-sanitize.test.ts`.
    #[test]
    fn the_0_1_cases_give_the_0_1_results() {
        assert_eq!(
            message("Cannot restore node:0193-abc; the typed SQLite row does not exist"),
            "Cannot restore node:0193-abc; the typed SQLite row does not exist"
        );
        assert_eq!(message(&format!("无法保存：{PROSE}")), "[text]");
        assert_eq!(
            message(
                "Unexpected token in \"the quick brown fox jumps over the lazy dog again and again\""
            ),
            "Unexpected token in \"[text]\""
        );
        // Built at run time so the source holds no personal absolute path.
        let home = ["", "Users", "someone"].join("/");
        assert_eq!(
            message(&format!("open {home}/Library/App/drifting.db failed")),
            "open ~/Library/App/drifting.db failed"
        );
        assert_eq!(message(&"x".repeat(400)).chars().count(), 300);
    }

    #[test]
    fn long_quotes_and_word_runs_become_placeholders() {
        let quoted = format!("failed on \"{}\"", "x".repeat(41));
        assert_eq!(message(&quoted), "failed on \"[text]\"");
        assert_eq!(message("short \"quote\" stays"), "short \"quote\" stays");
        let words = "the rain kept falling on the old roof while she read the letter again slowly";
        assert_eq!(
            message(&format!("panic at 3: {words}")),
            "panic at 3: [text]"
        );
        assert_eq!(
            message("called `Option::unwrap()` on a `None` value"),
            "called `Option::unwrap()` on a `None` value"
        );
    }

    #[test]
    fn short_cjk_and_identifiers_survive() {
        assert_eq!(message("章节「第一章」打不开"), "章节「第一章」打不开");
        assert_eq!(message(&"字".repeat(12)), "[text]");
    }

    #[test]
    fn secrets_addresses_and_queries_are_redacted() {
        assert_eq!(
            message("401 for Bearer abc.def-123"),
            "401 for Bearer [redacted]"
        );
        // As in 0.1, the named-secret rule then takes the word after it too.
        assert_eq!(
            message("Authorization: Bearer abc.def-123"),
            "Authorization: [redacted] [redacted]"
        );
        assert_eq!(
            message("key sk-proj_ABCDEFGH12345 rejected"),
            "key [credential] rejected"
        );
        assert_eq!(
            message("token eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl expired"),
            "token [credential] expired"
        );
        assert_eq!(
            message("api_key=12345 password: hunter2, ok"),
            "api_key=[redacted] password: [redacted], ok"
        );
        assert_eq!(
            message("mail author@example.com bounced"),
            "mail [email] bounced"
        );
        assert_eq!(
            message("GET https://api.example.test/v1/sync?token=x#frag failed"),
            "GET https://api.example.test/v1/sync[redacted] failed"
        );
        assert_eq!(message("  a \n\t b  "), "a b");
    }

    #[test]
    fn messages_are_bounded_and_home_is_redacted() {
        assert!(message(&"a1 ".repeat(400)).chars().count() <= MAX_MESSAGE_CHARS);
        if let Some(home) = home() {
            assert_eq!(
                message(&format!("could not open {home}/Library/x.sqlite")),
                "could not open ~/Library/x.sqlite"
            );
        }
    }

    #[test]
    fn tokens_and_codes_keep_only_safe_characters() {
        assert_eq!(report_token("0.2.0-dev (abc123)", 64), "0.2.0-dev-abc123");
        assert_eq!(report_token("zh-CN", 16), "zh-CN");
        assert_eq!(report_token("  ", 16), "unknown");
        assert_eq!(report_token(&"a".repeat(80), 64).len(), 64);
        assert_eq!(error_code("sync.http-503"), "sync.http-503");
        assert_eq!(error_code(PROSE), "redacted-error");
        assert_eq!(error_code(""), "redacted-error");
    }
}
