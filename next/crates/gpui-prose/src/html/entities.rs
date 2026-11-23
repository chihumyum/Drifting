//! Character references (`&amp;`, `&#8212;`, `&#x4e2d;`): the HTML 4 named
//! set, which is what programs put on the clipboard (Word writes `&nbsp;`
//! and numbers, browsers `&amp;`, `&lt;`, `&gt;`, `&nbsp;` and `&quot;`), plus
//! `&apos;` and a few later names. An unknown name stays as it is written,
//! as in a browser.

use std::borrow::Cow;

/// The Latin-1 names, U+00A0 to U+00FF in order.
const LATIN1: [&str; 96] = [
    "nbsp", "iexcl", "cent", "pound", "curren", "yen", "brvbar", "sect", "uml", "copy", "ordf",
    "laquo", "not", "shy", "reg", "macr", "deg", "plusmn", "sup2", "sup3", "acute", "micro",
    "para", "middot", "cedil", "sup1", "ordm", "raquo", "frac14", "frac12", "frac34", "iquest",
    "Agrave", "Aacute", "Acirc", "Atilde", "Auml", "Aring", "AElig", "Ccedil", "Egrave", "Eacute",
    "Ecirc", "Euml", "Igrave", "Iacute", "Icirc", "Iuml", "ETH", "Ntilde", "Ograve", "Oacute",
    "Ocirc", "Otilde", "Ouml", "times", "Oslash", "Ugrave", "Uacute", "Ucirc", "Uuml", "Yacute",
    "THORN", "szlig", "agrave", "aacute", "acirc", "atilde", "auml", "aring", "aelig", "ccedil",
    "egrave", "eacute", "ecirc", "euml", "igrave", "iacute", "icirc", "iuml", "eth", "ntilde",
    "ograve", "oacute", "ocirc", "otilde", "ouml", "divide", "oslash", "ugrave", "uacute", "ucirc",
    "uuml", "yacute", "thorn", "yuml",
];

/// The character a name (without `&` and `;`) stands for.
pub(super) fn named(name: &str) -> Option<char> {
    if let Some(ix) = LATIN1.iter().position(|n| *n == name) {
        return char::from_u32(0xA0 + ix as u32);
    }
    let code: u32 = match name {
        "quot" | "QUOT" => 0x22,
        "amp" | "AMP" => 0x26,
        "apos" => 0x27,
        "lt" | "LT" => 0x3C,
        "gt" | "GT" => 0x3E,
        "COPY" => 0xA9,
        "REG" => 0xAE,
        "OElig" => 0x152,
        "oelig" => 0x153,
        "Scaron" => 0x160,
        "scaron" => 0x161,
        "Yuml" => 0x178,
        "fnof" => 0x192,
        "circ" => 0x2C6,
        "tilde" => 0x2DC,
        "Alpha" => 0x391,
        "Beta" => 0x392,
        "Gamma" => 0x393,
        "Delta" => 0x394,
        "Epsilon" => 0x395,
        "Zeta" => 0x396,
        "Eta" => 0x397,
        "Theta" => 0x398,
        "Iota" => 0x399,
        "Kappa" => 0x39A,
        "Lambda" => 0x39B,
        "Mu" => 0x39C,
        "Nu" => 0x39D,
        "Xi" => 0x39E,
        "Omicron" => 0x39F,
        "Pi" => 0x3A0,
        "Rho" => 0x3A1,
        "Sigma" => 0x3A3,
        "Tau" => 0x3A4,
        "Upsilon" => 0x3A5,
        "Phi" => 0x3A6,
        "Chi" => 0x3A7,
        "Psi" => 0x3A8,
        "Omega" => 0x3A9,
        "alpha" => 0x3B1,
        "beta" => 0x3B2,
        "gamma" => 0x3B3,
        "delta" => 0x3B4,
        "epsilon" => 0x3B5,
        "zeta" => 0x3B6,
        "eta" => 0x3B7,
        "theta" => 0x3B8,
        "iota" => 0x3B9,
        "kappa" => 0x3BA,
        "lambda" => 0x3BB,
        "mu" => 0x3BC,
        "nu" => 0x3BD,
        "xi" => 0x3BE,
        "omicron" => 0x3BF,
        "pi" => 0x3C0,
        "rho" => 0x3C1,
        "sigmaf" => 0x3C2,
        "sigma" => 0x3C3,
        "tau" => 0x3C4,
        "upsilon" => 0x3C5,
        "phi" => 0x3C6,
        "chi" => 0x3C7,
        "psi" => 0x3C8,
        "omega" => 0x3C9,
        "thetasym" => 0x3D1,
        "upsih" => 0x3D2,
        "piv" => 0x3D6,
        "ensp" => 0x2002,
        "emsp" => 0x2003,
        "thinsp" => 0x2009,
        "hairsp" => 0x200A,
        "ZeroWidthSpace" => 0x200B,
        "zwnj" => 0x200C,
        "zwj" => 0x200D,
        "lrm" => 0x200E,
        "rlm" => 0x200F,
        "hyphen" | "dash" => 0x2010,
        "ndash" => 0x2013,
        "mdash" => 0x2014,
        "horbar" => 0x2015,
        "lsquo" => 0x2018,
        "rsquo" => 0x2019,
        "sbquo" => 0x201A,
        "ldquo" => 0x201C,
        "rdquo" => 0x201D,
        "bdquo" => 0x201E,
        "dagger" => 0x2020,
        "Dagger" => 0x2021,
        "bull" | "bullet" => 0x2022,
        "hellip" => 0x2026,
        "permil" => 0x2030,
        "prime" => 0x2032,
        "Prime" => 0x2033,
        "lsaquo" => 0x2039,
        "rsaquo" => 0x203A,
        "oline" => 0x203E,
        "frasl" => 0x2044,
        "euro" => 0x20AC,
        "image" => 0x2111,
        "weierp" => 0x2118,
        "real" => 0x211C,
        "trade" => 0x2122,
        "alefsym" => 0x2135,
        "larr" => 0x2190,
        "uarr" => 0x2191,
        "rarr" => 0x2192,
        "darr" => 0x2193,
        "harr" => 0x2194,
        "crarr" => 0x21B5,
        "lArr" => 0x21D0,
        "uArr" => 0x21D1,
        "rArr" => 0x21D2,
        "dArr" => 0x21D3,
        "hArr" => 0x21D4,
        "forall" => 0x2200,
        "part" => 0x2202,
        "exist" => 0x2203,
        "empty" => 0x2205,
        "nabla" => 0x2207,
        "isin" => 0x2208,
        "notin" => 0x2209,
        "ni" => 0x220B,
        "prod" => 0x220F,
        "sum" => 0x2211,
        "minus" => 0x2212,
        "lowast" => 0x2217,
        "radic" => 0x221A,
        "prop" => 0x221D,
        "infin" => 0x221E,
        "ang" => 0x2220,
        "and" => 0x2227,
        "or" => 0x2228,
        "cap" => 0x2229,
        "cup" => 0x222A,
        "int" => 0x222B,
        "there4" => 0x2234,
        "sim" => 0x223C,
        "cong" => 0x2245,
        "asymp" => 0x2248,
        "ne" => 0x2260,
        "equiv" => 0x2261,
        "le" => 0x2264,
        "ge" => 0x2265,
        "sub" => 0x2282,
        "sup" => 0x2283,
        "nsub" => 0x2284,
        "sube" => 0x2286,
        "supe" => 0x2287,
        "oplus" => 0x2295,
        "otimes" => 0x2297,
        "perp" => 0x22A5,
        "sdot" => 0x22C5,
        "lceil" => 0x2308,
        "rceil" => 0x2309,
        "lfloor" => 0x230A,
        "rfloor" => 0x230B,
        "loz" => 0x25CA,
        "spades" => 0x2660,
        "clubs" => 0x2663,
        "hearts" => 0x2665,
        "diams" => 0x2666,
        // HTML 5's angle brackets (HTML 4 had U+2329 / U+232A).
        "lang" => 0x27E8,
        "rang" => 0x27E9,
        _ => return None,
    };
    char::from_u32(code)
}

/// Whether a name may be written without its `;` (the HTML 4 Latin-1 set
/// and the four markup characters, as browsers still read them).
fn legacy(name: &str) -> bool {
    matches!(named(name), Some(c) if (c as u32) <= 0xFF)
}

/// What a numeric reference stands for: the Windows-1252 reading of
/// U+0080–U+009F (which Word and old pages write for curly quotes and
/// dashes), U+FFFD for nothing, a surrogate or out of range.
pub(super) fn numeric(code: u32) -> char {
    let code = match code {
        0x80 => 0x20AC,
        0x82 => 0x201A,
        0x83 => 0x0192,
        0x84 => 0x201E,
        0x85 => 0x2026,
        0x86 => 0x2020,
        0x87 => 0x2021,
        0x88 => 0x02C6,
        0x89 => 0x2030,
        0x8A => 0x0160,
        0x8B => 0x2039,
        0x8C => 0x0152,
        0x8E => 0x017D,
        0x91 => 0x2018,
        0x92 => 0x2019,
        0x93 => 0x201C,
        0x94 => 0x201D,
        0x95 => 0x2022,
        0x96 => 0x2013,
        0x97 => 0x2014,
        0x98 => 0x02DC,
        0x99 => 0x2122,
        0x9A => 0x0161,
        0x9B => 0x203A,
        0x9C => 0x0153,
        0x9E => 0x017E,
        0x9F => 0x0178,
        0 => 0xFFFD,
        c => c,
    };
    char::from_u32(code).unwrap_or('\u{FFFD}')
}

/// `text` with its character references read. In an attribute value a
/// name without its `;` followed by a letter, a digit or `=` is left alone
/// (`?a=1&copy=2` in a link stays a link).
pub(super) fn decode(text: &str, in_attribute: bool) -> Cow<'_, str> {
    if !text.contains('&') {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        match reference(rest, in_attribute) {
            Some((c, used)) => {
                out.push(c);
                rest = &rest[used..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

/// The reference at the start of `s` (which starts with `&`): its character
/// and how many bytes it takes.
fn reference(s: &str, in_attribute: bool) -> Option<(char, usize)> {
    let b = s.as_bytes();
    if b.get(1) == Some(&b'#') {
        let (hex, digits_at) = match b.get(2) {
            Some(b'x' | b'X') => (true, 3),
            _ => (false, 2),
        };
        let digits = b[digits_at..]
            .iter()
            .take_while(|c| {
                if hex {
                    c.is_ascii_hexdigit()
                } else {
                    c.is_ascii_digit()
                }
            })
            .count();
        if digits == 0 {
            return None;
        }
        let end = digits_at + digits;
        let code =
            u32::from_str_radix(&s[digits_at..end], if hex { 16 } else { 10 }).unwrap_or(u32::MAX);
        let used = if b.get(end) == Some(&b';') {
            end + 1
        } else {
            end
        };
        return Some((numeric(code), used));
    }
    let name_len = b[1..]
        .iter()
        .take(32)
        .take_while(|c| c.is_ascii_alphanumeric())
        .count();
    if name_len == 0 {
        return None;
    }
    let name = &s[1..1 + name_len];
    if b.get(1 + name_len) == Some(&b';')
        && let Some(c) = named(name)
    {
        return Some((c, name_len + 2));
    }
    // Without the `;`: the longest legacy name the text starts with.
    for len in (2..=name_len.min(6)).rev() {
        let prefix = &name[..len];
        if !legacy(prefix) {
            continue;
        }
        let next = b.get(1 + len).copied();
        if in_attribute && next.is_some_and(|c| c.is_ascii_alphanumeric() || c == b'=') {
            return None;
        }
        let used = if next == Some(b';') { len + 2 } else { len + 1 };
        return named(prefix).map(|c| (c, used));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_numbers_and_what_stays() {
        assert_eq!(decode("a &amp; b", false), "a & b");
        assert_eq!(decode("&nbsp;&lt;&gt;&quot;&apos;", false), "\u{a0}<>\"'");
        assert_eq!(decode("&mdash;&hellip;&ldquo;&rdquo;", false), "—…“”");
        assert_eq!(decode("&#20013;&#x6587;&#X6587", false), "中文文");
        assert_eq!(
            decode("&#150;&#147;&#0;&#xD800;&#99999999;", false),
            "–“\u{fffd}\u{fffd}\u{fffd}"
        );
        assert_eq!(decode("&yuml;&Yuml;&eacute;", false), "ÿŸé");
        assert_eq!(decode("&unknown; & &#; &", false), "&unknown; & &#; &");
        // Legacy names without `;`.
        assert_eq!(
            decode("&nbsp x &copy2026 &ampx", false),
            "\u{a0} x ©2026 &x"
        );
        assert_eq!(decode("?a=1&copy=2&amp;b", true), "?a=1&copy=2&b");
        assert!(matches!(decode("plain", false), Cow::Borrowed(_)));
    }

    #[test]
    fn the_latin1_table_lines_up() {
        assert_eq!(named("nbsp"), Some('\u{a0}'));
        assert_eq!(named("times"), Some('×'));
        assert_eq!(named("szlig"), Some('ß'));
        assert_eq!(named("yuml"), Some('ÿ'));
        assert_eq!(named("lang"), Some('\u{27e8}'));
    }
}
