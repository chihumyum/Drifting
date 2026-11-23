//! The little CSS that decides formatting in clipboard HTML: declarations in
//! `style="…"`, and in a document's `<style>`, rules for a class
//! (`.s1`, `span.s1`, `p.MsoNormal`; Cocoa's HTML for RTF puts underline,
//! strike-through and alignment there) and Word's list definitions
//! (`@list l0:level1 { mso-level-number-format: bullet }`).
//!
//! Only the properties formatting is read from are kept ([`KEPT`]); any
//! other selector (by tag alone, descendant, id, attribute, pseudo-class)
//! is ignored, as are `@media` and the like: a browser puts the styles that
//! matter on the elements themselves.

use std::collections::HashMap;

/// The properties read.
const KEPT: &[&str] = &[
    "display",
    "font-style",
    "font-weight",
    "mso-hide",
    "mso-level-number-format",
    "mso-level-text",
    "mso-list",
    "mso-tab-count",
    "text-align",
    "text-decoration",
    "text-decoration-line",
    "visibility",
    "white-space",
];

/// Declarations, in order (a later one wins).
pub(super) type Decls = Vec<(String, String)>;

/// The value of `property` in `decls`: the last one.
pub(super) fn get<'d>(decls: &'d Decls, property: &str) -> Option<&'d str> {
    decls
        .iter()
        .rev()
        .find(|(p, _)| p == property)
        .map(|(_, v)| v.as_str())
}

/// The kept declarations of a declaration block (`a: b; c: d`), values in
/// lower case without `!important`.
pub(super) fn declarations(block: &str) -> Decls {
    let mut out = Decls::new();
    for decl in split_top(block, b';') {
        let Some((property, value)) = decl.split_once(':') else {
            continue;
        };
        let property = property.trim().to_ascii_lowercase();
        if !KEPT.contains(&property.as_str()) {
            continue;
        }
        let mut value = value.trim().to_ascii_lowercase();
        if let Some(v) = value.strip_suffix("!important") {
            value = v.trim_end().to_owned();
        }
        out.push((property, value));
    }
    out
}

/// `s` split at `sep` outside quotes and parentheses.
fn split_top(s: &str, sep: u8) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut depth, mut quote, mut from) = (0usize, None::<u8>, 0);
    for (ix, c) in s.bytes().enumerate() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, b'"' | b'\'') => quote = Some(c),
            (None, b'(') => depth += 1,
            (None, b')') => depth = depth.saturating_sub(1),
            (None, c) if c == sep && depth == 0 => {
                parts.push(&s[from..ix]);
                from = ix + 1;
            }
            _ => {}
        }
    }
    parts.push(&s[from..]);
    parts
}

/// What a document's `<style>` elements say.
#[derive(Debug, Default)]
pub(super) struct Sheet {
    /// By `(tag, class)`, both in lower case; `""` for a rule on the class
    /// alone.
    classes: HashMap<(String, String), Decls>,
    /// Word's list definitions, by `l0:level1` (lower case).
    lists: HashMap<String, Decls>,
}

impl Sheet {
    /// Reads one `<style>`'s text into the sheet.
    pub(super) fn add(&mut self, css: &str) {
        let css = strip_comments(css);
        let bytes = css.as_bytes();
        let mut at = 0;
        while at < bytes.len() {
            // The prelude: up to `{`, or `;` for a statement (`@import …;`).
            let Some(open) = css[at..].find(['{', ';']).map(|o| at + o) else {
                break;
            };
            let prelude = css[at..open].trim();
            if bytes[open] == b';' {
                at = open + 1;
                continue;
            }
            let close = block_end(bytes, open);
            let block = &css[open + 1..close.min(css.len())];
            if let Some(at_rule) = prelude.strip_prefix('@') {
                let mut words = at_rule.split_whitespace();
                if words.next().is_some_and(|w| w.eq_ignore_ascii_case("list"))
                    && let Some(name) = words.next()
                {
                    // Defined, even with nothing kept: a numbered list.
                    self.lists
                        .entry(name.to_ascii_lowercase())
                        .or_default()
                        .extend(declarations(block));
                }
            } else {
                let decls = declarations(block);
                if !decls.is_empty() {
                    for selector in prelude.split(',') {
                        if let Some(key) = class_selector(selector.trim()) {
                            self.classes.entry(key).or_default().extend(decls.clone());
                        }
                    }
                }
            }
            at = close + 1;
        }
    }

    /// The declarations the sheet gives an element `tag` (lower case) with
    /// `classes` (its `class` attribute): rules on a class alone first,
    /// then those on the tag and class.
    pub(super) fn for_element(&self, tag: &str, classes: &str) -> Decls {
        let mut out = Decls::new();
        if self.classes.is_empty() {
            return out;
        }
        for class in classes.split_ascii_whitespace() {
            let class = class.to_ascii_lowercase();
            for t in ["", tag] {
                if let Some(decls) = self.classes.get(&(t.to_owned(), class.clone())) {
                    out.extend(decls.iter().cloned());
                }
            }
        }
        out
    }

    /// One of Word's list levels (`l0`, level 1 is the outermost): its
    /// number format (`bullet`, `decimal` when unset, `chinese-counting` …)
    /// and its number text (`%1.`), if the sheet defines that list.
    pub(super) fn word_level(&self, list: &str, level: i64) -> Option<(String, Option<String>)> {
        let decls = self.lists.get(&format!("{list}:level{level}"))?;
        let format = get(decls, "mso-level-number-format")
            .unwrap_or("decimal")
            .to_owned();
        // Written as CSS: `"%1\."` is `%1.`.
        let text =
            get(decls, "mso-level-text").map(|t| t.trim_matches(['"', '\'']).replace('\\', ""));
        Some((format, text))
    }
}

/// `(tag, class)` of a selector that is a class with or without a tag.
fn class_selector(selector: &str) -> Option<(String, String)> {
    let (tag, class) = selector.split_once('.')?;
    let ok_tag = tag
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b':' || c == b'-');
    let ok_class = !class.is_empty()
        && class
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
    (ok_tag && ok_class).then(|| (tag.to_ascii_lowercase(), class.to_ascii_lowercase()))
}

/// The byte index of the `}` that closes the block opened at `open`
/// (nested blocks skipped), or the end.
fn block_end(bytes: &[u8], open: usize) -> usize {
    let mut depth = 0usize;
    for (ix, c) in bytes.iter().enumerate().skip(open) {
        match c {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return ix;
                }
            }
            _ => {}
        }
    }
    bytes.len()
}

/// The text without `/* … */` comments and the `<!--` / `-->` that wrap a
/// `<style>`'s content in older HTML.
fn strip_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(at) = rest.find("/*") {
        out.push_str(&rest[..at]);
        match rest[at + 2..].find("*/") {
            Some(end) => rest = &rest[at + 2 + end + 2..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.replace("<!--", " ").replace("-->", " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_declarations() {
        let d = declarations(
            "font-weight:700; COLOR: red ; text-decoration: underline !important; font-family:\"a;b\"",
        );
        assert_eq!(get(&d, "font-weight"), Some("700"));
        assert_eq!(get(&d, "text-decoration"), Some("underline"));
        assert_eq!(get(&d, "color"), None, "not kept");
        let d = declarations("white-space:pre;white-space:pre-wrap");
        assert_eq!(
            get(&d, "white-space"),
            Some("pre-wrap"),
            "the last one wins"
        );
    }

    #[test]
    fn class_rules_and_word_lists() {
        let mut sheet = Sheet::default();
        sheet.add(
            "<!--
            /* Font Definitions */
            @font-face {font-family:\"Cambria Math\"; panose-1:2 4 5 3 5 4 6 3 2 4;}
            p.MsoNormal, li.MsoNormal, div.MsoNormal {margin:0in; font-size:12.0pt;}
            h1 {font-weight:bold;}
            span.s1 {text-decoration: underline}
            .Center {text-align:center}
            p > span.x, a:link {text-decoration:underline}
            @media print { p.p {font-weight:bold} }
            @list l0:level1 {mso-level-number-format:bullet; mso-level-text:\"\"; text-indent:-.25in;}
            @list l1:level1 {mso-level-tab-stop:none; mso-level-text:\"%1\\.\";}
            -->",
        );
        assert!(
            sheet.for_element("p", "MsoNormal").is_empty(),
            "nothing kept"
        );
        assert!(
            sheet.for_element("h1", "").is_empty(),
            "a tag alone is ignored"
        );
        assert_eq!(
            get(&sheet.for_element("span", "s1"), "text-decoration"),
            Some("underline")
        );
        assert_eq!(
            get(&sheet.for_element("p", "x center"), "text-align"),
            Some("center")
        );
        assert!(sheet.for_element("p", "p").is_empty(), "@media is skipped");
        assert_eq!(sheet.word_level("l0", 1).unwrap().0, "bullet");
        assert_eq!(sheet.word_level("l1", 1).unwrap().0, "decimal");
        assert_eq!(sheet.word_level("l2", 1), None);
    }

    #[test]
    fn broken_css_never_fails() {
        let mut sheet = Sheet::default();
        for css in [
            "p.a {",
            "}}}",
            "/* open",
            "@list",
            "@list l0:level1 {",
            ".a{text-align:center",
            "{;}",
        ] {
            sheet.add(css);
        }
        assert_eq!(
            get(&sheet.for_element("p", "a"), "text-align"),
            Some("center")
        );
    }
}
