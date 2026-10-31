//! Text helpers shared by the three writers.
use sha2::{Digest, Sha256};

use super::{Block, Manuscript, Run, Section};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Language {
    SimplifiedChinese,
    TraditionalChinese,
    Japanese,
    Korean,
    /// A Latin-script book; the tag comes from the interface locale.
    Latin(&'static str),
}

impl Language {
    /// BCP 47 tag for EPUB, DOCX and PDF metadata.
    pub(crate) fn tag(self) -> &'static str {
        match self {
            Self::SimplifiedChinese => "zh-CN",
            Self::TraditionalChinese => "zh-TW",
            Self::Japanese => "ja",
            Self::Korean => "ko",
            Self::Latin(tag) => tag,
        }
    }

    pub(crate) fn is_cjk(self) -> bool {
        !matches!(self, Self::Latin(_))
    }

    /// The contents heading in the book's own language.
    pub(crate) fn contents_label(self) -> &'static str {
        match self {
            Self::SimplifiedChinese => "目录",
            Self::TraditionalChinese => "目錄",
            Self::Japanese => "目次",
            Self::Korean => "목차",
            Self::Latin(_) => "Contents",
        }
    }

    pub(crate) fn cover_label(self) -> &'static str {
        match self {
            Self::SimplifiedChinese | Self::TraditionalChinese => "封面",
            Self::Japanese => "表紙",
            Self::Korean => "표지",
            Self::Latin(_) => "Cover",
        }
    }
}

const LATIN_LOCALES: &[&str] = &[
    "en", "fr", "de", "es", "it", "pt", "nl", "sv", "da", "nb", "fi", "pl", "cs", "tr", "id", "vi",
    "ro", "hu",
];

/// Characters that only appear in one of the two Chinese scripts.
const SIMPLIFIED_ONLY: &str = "们这说个来时会为国学门没见长问还过发书东开关头听觉对边让给岁请记";
const TRADITIONAL_ONLY: &str = "們這說個來時會為國學門沒見長問還過發書東開關頭聽覺對邊讓給歲請記";

fn sample_text(manuscript: &Manuscript, out: &mut String) {
    fn runs(runs: &[Run], out: &mut String) {
        for run in runs {
            out.push_str(&run.text);
        }
    }
    fn blocks(list: &[Block], out: &mut String) {
        for block in list {
            if out.len() > 400_000 {
                return;
            }
            match block {
                Block::Heading { runs: r, .. } | Block::Paragraph { runs: r, .. } => runs(r, out),
                Block::Quote { blocks: inner } => blocks(inner, out),
                Block::Break => {}
            }
        }
    }
    out.push_str(&manuscript.title);
    for section in &manuscript.sections {
        match section {
            Section::Act { title } => out.push_str(title),
            Section::Chapter {
                title, blocks: b, ..
            } => {
                out.push_str(title);
                blocks(b, out);
            }
        }
    }
}

/// The book's language from its own characters; the interface locale only
/// names a Latin-script book.
pub(crate) fn detect_language(manuscript: &Manuscript) -> Language {
    let mut text = String::new();
    sample_text(manuscript, &mut text);
    let (mut han, mut kana, mut hangul, mut latin, mut simplified, mut traditional) =
        (0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
    for c in text.chars() {
        match c {
            '\u{3040}'..='\u{30ff}' | '\u{31f0}'..='\u{31ff}' => kana += 1,
            '\u{ac00}'..='\u{d7af}' | '\u{1100}'..='\u{11ff}' => hangul += 1,
            c if is_han(c) => {
                han += 1;
                if SIMPLIFIED_ONLY.contains(c) {
                    simplified += 1;
                } else if TRADITIONAL_ONLY.contains(c) {
                    traditional += 1;
                }
            }
            c if c.is_alphabetic() => latin += 1,
            _ => {}
        }
    }
    let cjk = han + kana + hangul;
    if cjk > 0 && cjk * 4 >= latin {
        if hangul > han + kana {
            return Language::Korean;
        }
        if kana * 20 >= han + kana && kana > 0 {
            return Language::Japanese;
        }
        return if traditional > simplified {
            Language::TraditionalChinese
        } else {
            Language::SimplifiedChinese
        };
    }
    let locale = manuscript.locale.split(['-', '_']).next().unwrap_or("");
    let tag = LATIN_LOCALES
        .iter()
        .find(|candidate| candidate.eq_ignore_ascii_case(locale))
        .copied()
        .unwrap_or("en");
    Language::Latin(tag)
}

pub(crate) fn is_han(c: char) -> bool {
    matches!(c,
        '\u{3400}'..='\u{4dbf}'
        | '\u{4e00}'..='\u{9fff}'
        | '\u{f900}'..='\u{faff}'
        | '\u{20000}'..='\u{2ebef}'
        | '\u{30000}'..='\u{3134f}'
        | '\u{3005}'..='\u{3007}')
}

/// A UTC instant parsed from `YYYY-MM-DDThh:mm:ssZ`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Timestamp {
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
}

impl Timestamp {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        let bytes = value.as_bytes();
        if bytes.len() != 20
            || bytes[4] != b'-'
            || bytes[7] != b'-'
            || bytes[10] != b'T'
            || bytes[13] != b':'
            || bytes[16] != b':'
            || bytes[19] != b'Z'
        {
            return None;
        }
        let number = |range: std::ops::Range<usize>| -> Option<u16> {
            let part = value.get(range)?;
            part.bytes()
                .all(|byte| byte.is_ascii_digit())
                .then(|| part.parse().ok())
                .flatten()
        };
        let stamp = Self {
            year: number(0..4)?,
            month: number(5..7)? as u8,
            day: number(8..10)? as u8,
            hour: number(11..13)? as u8,
            minute: number(14..16)? as u8,
            second: number(17..19)? as u8,
        };
        let valid = (1980..=2107).contains(&stamp.year)
            && (1..=12).contains(&stamp.month)
            && (1..=31).contains(&stamp.day)
            && stamp.hour < 24
            && stamp.minute < 60
            && stamp.second < 60;
        valid.then_some(stamp)
    }

    pub(crate) fn iso(&self) -> String {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }

    pub(crate) fn zip_time(&self) -> zip::DateTime {
        zip::DateTime::from_date_and_time(
            self.year,
            self.month,
            self.day,
            self.hour,
            self.minute,
            self.second,
        )
        .unwrap_or_default()
    }
}

/// A stable UUID-shaped package identifier derived from the project.
pub(crate) fn book_uuid(identifier: &str) -> String {
    let digest = Sha256::digest(format!("drifting-manuscript:{identifier}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Characters XML 1.0 can carry; everything else is dropped.
fn is_xml_char(c: char) -> bool {
    matches!(c,
        '\u{9}' | '\u{a}' | '\u{d}'
        | '\u{20}'..='\u{d7ff}'
        | '\u{e000}'..='\u{fffd}'
        | '\u{10000}'..='\u{10ffff}')
}

/// Escape text for an XML element or attribute value.
pub(crate) fn xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if is_xml_char(c) => out.push(c),
            _ => {}
        }
    }
    out
}

pub(crate) fn is_exported_link(href: &str) -> bool {
    let lower = href.trim().to_ascii_lowercase();
    href.len() <= 2048
        && !href.chars().any(char::is_control)
        && (lower.starts_with("https://")
            || lower.starts_with("http://")
            || lower.starts_with("mailto:"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book(text: &str, locale: &str) -> Manuscript {
        Manuscript {
            title: "T".into(),
            author: String::new(),
            identifier: "id".into(),
            modified: "2026-10-31T00:00:00Z".into(),
            locale: locale.into(),
            preferred_font: None,
            cover: None,
            sections: vec![Section::Chapter {
                title: "C".into(),
                show_title: true,
                blocks: vec![Block::Paragraph {
                    runs: vec![Run {
                        text: text.into(),
                        ..Run::default()
                    }],
                    align: Default::default(),
                    indent: 0,
                }],
            }],
        }
    }

    #[test]
    fn detects_the_book_language_from_its_prose() {
        assert_eq!(
            detect_language(&book("他们说这个时候会下雨。", "en")),
            Language::SimplifiedChinese
        );
        assert_eq!(
            detect_language(&book("他們說這個時候會下雨。", "en")),
            Language::TraditionalChinese
        );
        assert_eq!(
            detect_language(&book("雨が降っていると彼は言った。", "zh-CN")),
            Language::Japanese
        );
        assert_eq!(
            detect_language(&book("비가 온다고 그가 말했다.", "en")),
            Language::Korean
        );
        assert_eq!(
            detect_language(&book("It was raining.", "fr")),
            Language::Latin("fr")
        );
        assert_eq!(
            detect_language(&book("It was raining.", "zh-CN")),
            Language::Latin("en")
        );
    }

    #[test]
    fn escapes_xml_and_drops_characters_xml_cannot_carry() {
        assert_eq!(
            xml("a<b>&\"'\u{1}\u{fffe}c"),
            "a&lt;b&gt;&amp;&quot;&apos;c"
        );
        assert_eq!(xml("中文 👩🏽‍🚀"), "中文 👩🏽‍🚀");
    }

    #[test]
    fn parses_only_canonical_utc_timestamps_and_hashes_a_stable_uuid() {
        assert_eq!(
            Timestamp::parse("2026-10-31T08:09:10Z").unwrap().iso(),
            "2026-10-31T08:09:10Z"
        );
        for bad in [
            "2026-10-31T08:09:10.000Z",
            "2026-13-01T00:00:00Z",
            "2026-10-31 08:09:10Z",
        ] {
            assert!(Timestamp::parse(bad).is_none(), "{bad}");
        }
        let id = book_uuid("project-a");
        assert_eq!(id, book_uuid("project-a"));
        assert_ne!(id, book_uuid("project-b"));
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "5");
    }

    #[test]
    fn exports_only_web_and_mail_links() {
        assert!(is_exported_link("https://example.com/a?b=c"));
        assert!(is_exported_link("mailto:author@example.com"));
        for bad in [
            "javascript:alert(1)",
            "drifting://node/1",
            "file:///etc/passwd",
            "https://a\nb",
        ] {
            assert!(!is_exported_link(bad), "{bad}");
        }
    }
}
