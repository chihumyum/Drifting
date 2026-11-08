//! Numbers as the 0.1 client wrote them in the interface language:
//! `toLocaleString` for whole counts and `Intl.NumberFormat` with
//! `notation: 'compact'` (at most one decimal) for word totals
//! (`shared/locale-format.ts`). Only the nine interface languages, so the
//! rules are written out here instead of pulling in CLDR's number data.
//!
//! ```
//! use dr_i18n::{Locale, number};
//! assert_eq!(number::grouped(12_345, Locale::De), "12.345");
//! assert_eq!(number::compact(123_456, Locale::ZhCn), "12.3万");
//! ```

use crate::Locale;

/// The decimal and grouping separators of `locale`.
fn separators(locale: Locale) -> (char, Option<char>) {
    match locale {
        Locale::De | Locale::Es | Locale::PtBr => (',', Some('.')),
        // French groups with a narrow no-break space.
        Locale::Fr => (',', Some('\u{202f}')),
        _ => ('.', Some(',')),
    }
}

/// `n` with the language's thousands grouping (`toLocaleString`). Spanish
/// groups only from five digits on, as CLDR says.
pub fn grouped(n: u64, locale: Locale) -> String {
    let digits = n.to_string();
    let (_, group) = separators(locale);
    let Some(group) = group else {
        return digits;
    };
    if locale == Locale::Es && digits.len() <= 4 {
        return digits;
    }
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(group);
        }
        out.push(c);
    }
    out
}

/// One decimal at most, trailing zero dropped, the language's decimal mark.
fn one_decimal(value: f64, locale: Locale) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    let text = if rounded.fract() == 0.0 {
        format!("{rounded:.0}")
    } else {
        format!("{rounded:.1}")
    };
    let (decimal, _) = separators(locale);
    text.replace('.', &decimal.to_string())
}

/// `n` in the compact notation (`12.3万`, `12.3K`, `1,2 mil`).
pub fn compact(n: u64, locale: Locale) -> String {
    let v = n as f64;
    // East Asian languages count in ten thousands.
    let east = |wan: &str, yi: &str, thousand: Option<&str>| {
        if n >= 100_000_000 {
            format!("{}{yi}", one_decimal(v / 1e8, locale))
        } else if n >= 10_000 {
            format!("{}{wan}", one_decimal(v / 1e4, locale))
        } else if let (Some(k), true) = (thousand, n >= 1_000) {
            format!("{}{k}", one_decimal(v / 1e3, locale))
        } else {
            n.to_string()
        }
    };
    // (thousand, million, billion) suffixes, with or without a space.
    let west = |k: &str, m: &str, b: &str, space: &str, compact_thousands: bool| {
        if n >= 1_000_000_000 {
            format!("{}{space}{b}", one_decimal(v / 1e9, locale))
        } else if n >= 1_000_000 {
            format!("{}{space}{m}", one_decimal(v / 1e6, locale))
        } else if n >= 1_000 && compact_thousands {
            format!("{}{space}{k}", one_decimal(v / 1e3, locale))
        } else {
            grouped(n, locale)
        }
    };
    match locale {
        Locale::ZhCn => east("万", "亿", None),
        Locale::ZhTw => east("萬", "億", None),
        Locale::Ja => east("万", "億", None),
        Locale::Ko => east("만", "억", Some("천")),
        Locale::En => west("K", "M", "B", "", true),
        Locale::Es => west("mil", "M", "mil M", "\u{a0}", true),
        Locale::PtBr => west("mil", "mi", "bi", "\u{a0}", true),
        Locale::Fr => west("k", "M", "Md", "\u{a0}", true),
        // German writes thousands out (CLDR has no short form for them).
        Locale::De => west("", "Mio.", "Mrd.", "\u{a0}", false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_counts_follow_intl() {
        // What `Intl.NumberFormat(…, { notation: 'compact',
        // maximumFractionDigits: 1 })` gives in each language.
        assert_eq!(compact(980, Locale::ZhCn), "980");
        assert_eq!(compact(9_876, Locale::ZhCn), "9876");
        assert_eq!(compact(123_456, Locale::ZhCn), "12.3万");
        assert_eq!(compact(120_000, Locale::ZhCn), "12万");
        assert_eq!(compact(150_000_000, Locale::ZhCn), "1.5亿");
        assert_eq!(compact(123_456, Locale::ZhTw), "12.3萬");
        assert_eq!(compact(123_456, Locale::Ja), "12.3万");
        assert_eq!(compact(1_234, Locale::Ko), "1.2천");
        assert_eq!(compact(123_456, Locale::Ko), "12.3만");
        assert_eq!(compact(12_345, Locale::En), "12.3K");
        assert_eq!(compact(123_456, Locale::En), "123.5K");
        assert_eq!(compact(1_500_000, Locale::En), "1.5M");
        assert_eq!(compact(999, Locale::En), "999");
        assert_eq!(compact(123_456, Locale::Es), "123,5\u{a0}mil");
        assert_eq!(compact(123_456, Locale::PtBr), "123,5\u{a0}mil");
        assert_eq!(compact(123_456, Locale::Fr), "123,5\u{a0}k");
        assert_eq!(compact(123_456, Locale::De), "123.456");
        assert_eq!(compact(1_500_000, Locale::De), "1,5\u{a0}Mio.");
    }

    #[test]
    fn grouping_follows_to_locale_string() {
        assert_eq!(grouped(1_234_567, Locale::ZhCn), "1,234,567");
        assert_eq!(grouped(1_234_567, Locale::De), "1.234.567");
        assert_eq!(grouped(1_234, Locale::Es), "1234");
        assert_eq!(grouped(12_345, Locale::Es), "12.345");
        assert_eq!(grouped(12_345, Locale::Fr), "12\u{202f}345");
        assert_eq!(grouped(999, Locale::En), "999");
    }
}
