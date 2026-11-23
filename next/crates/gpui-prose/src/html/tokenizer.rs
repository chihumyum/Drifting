//! A forgiving HTML tokenizer, enough of the HTML parsing rules to read what
//! programs put on the clipboard: start and end tags with their attributes
//! (quoted, unquoted or bare; names folded to lower case), text with its
//! character references read, and the raw text of `<script>`, `<style>` and
//! their kind. Comments, the doctype, processing instructions (Word's
//! `<?xml:namespace …>`) and `<![if …]>` / `<![endif]>` (Word's conditional
//! markup, a bogus comment to a browser) are skipped; what lies between
//! `<![if …]>` and `<![endif]>` is ordinary content, as in a browser.
//!
//! Never fails: whatever it cannot read is text, and a tag cut off by the end
//! of the input is dropped. One pass, no backtracking, no recursion.

use std::borrow::Cow;

use super::entities::decode;

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Token<'a> {
    Start {
        name: String,
        attrs: Vec<(String, String)>,
        self_closing: bool,
    },
    End {
        name: String,
    },
    Text(Cow<'a, str>),
}

/// Elements whose content is text up to their own end tag.
const RAW_TEXT: &[&str] = &[
    "script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "textarea", "title",
];

pub(super) struct Tokenizer<'a> {
    src: &'a str,
    pos: usize,
    /// The raw-text element just opened, whose content comes next.
    raw: Option<String>,
}

impl<'a> Tokenizer<'a> {
    pub(super) fn new(src: &'a str) -> Self {
        Tokenizer {
            src,
            pos: 0,
            raw: None,
        }
    }

    fn rest(&self) -> &'a str {
        &self.src[self.pos..]
    }

    /// Skips to just after the next `>` (or to the end).
    fn skip_to_gt(&mut self) {
        match self.rest().find('>') {
            Some(at) => self.pos += at + 1,
            None => self.pos = self.src.len(),
        }
    }

    fn skip_comment(&mut self) {
        // `<!--` is at `pos`.
        let body = &self.rest()[4..];
        if body.starts_with('>') {
            self.pos += 5;
        } else if body.starts_with("->") {
            self.pos += 6;
        } else {
            match body.find("-->") {
                Some(at) => self.pos += 4 + at + 3,
                None => match body.find("--!>") {
                    Some(at) => self.pos += 4 + at + 4,
                    None => self.pos = self.src.len(),
                },
            }
        }
    }

    /// The content of the raw-text element `name`, up to its end tag.
    fn raw_text(&mut self, name: &str) -> &'a str {
        let rest = self.rest();
        let bytes = rest.as_bytes();
        let mut from = 0;
        let end = loop {
            let Some(at) = rest[from..].find("</") else {
                break rest.len();
            };
            let at = from + at;
            let name_end = at + 2 + name.len();
            if bytes.len() >= name_end
                && bytes[at + 2..name_end].eq_ignore_ascii_case(name.as_bytes())
                && bytes
                    .get(name_end)
                    .is_none_or(|c| c.is_ascii_whitespace() || *c == b'/' || *c == b'>')
            {
                break at;
            }
            from = at + 2;
        };
        self.pos += end;
        &rest[..end]
    }

    /// A tag's name, from `pos`: up to white space, `/` or `>`.
    fn name(&mut self) -> String {
        let rest = self.rest();
        let len = rest
            .bytes()
            .take_while(|c| !c.is_ascii_whitespace() && *c != b'/' && *c != b'>')
            .count();
        self.pos += len;
        rest[..len].to_ascii_lowercase()
    }

    /// The attributes up to the tag's `>`: `None` when the input ends first.
    fn attributes(&mut self) -> Option<(Vec<(String, String)>, bool)> {
        let mut attrs: Vec<(String, String)> = Vec::new();
        loop {
            let rest = self.rest();
            let skip = rest.bytes().take_while(|c| c.is_ascii_whitespace()).count();
            self.pos += skip;
            let rest = self.rest();
            match rest.as_bytes().first() {
                None => return None,
                Some(b'>') => {
                    self.pos += 1;
                    return Some((attrs, false));
                }
                Some(b'/') => {
                    self.pos += 1;
                    if self.rest().starts_with('>') {
                        self.pos += 1;
                        return Some((attrs, true));
                    }
                    continue;
                }
                _ => {}
            }
            // The name: the first character may be `=`, the rest up to
            // white space, `/`, `>` or `=` (all ASCII, so the name ends on
            // a character boundary).
            let first = rest.chars().next().map_or(1, char::len_utf8);
            let len = first
                + rest[first..]
                    .bytes()
                    .take_while(|c| !c.is_ascii_whitespace() && !matches!(c, b'/' | b'>' | b'='))
                    .count();
            let name = rest[..len].to_ascii_lowercase();
            self.pos += len;
            let rest = self.rest();
            let ws = rest.bytes().take_while(|c| c.is_ascii_whitespace()).count();
            let mut value = String::new();
            if rest[ws..].starts_with('=') {
                self.pos += ws + 1;
                let rest = self.rest();
                let ws = rest.bytes().take_while(|c| c.is_ascii_whitespace()).count();
                self.pos += ws;
                let rest = self.rest();
                match rest.as_bytes().first() {
                    None => return None,
                    Some(q @ (b'"' | b'\'')) => {
                        let close = rest[1..].find(*q as char)?;
                        value = decode(&rest[1..1 + close], true).into_owned();
                        self.pos += close + 2;
                    }
                    Some(_) => {
                        let len = rest
                            .bytes()
                            .take_while(|c| !c.is_ascii_whitespace() && *c != b'>')
                            .count();
                        value = decode(&rest[..len], true).into_owned();
                        self.pos += len;
                    }
                }
            }
            // A repeated attribute is ignored, as in a browser.
            if !attrs.iter().any(|(n, _)| *n == name) {
                attrs.push((name, value));
            }
        }
    }
}

impl<'a> Iterator for Tokenizer<'a> {
    type Item = Token<'a>;

    fn next(&mut self) -> Option<Token<'a>> {
        loop {
            if let Some(name) = self.raw.take() {
                let text = self.raw_text(&name);
                if !text.is_empty() {
                    return Some(Token::Text(Cow::Borrowed(text)));
                }
                continue;
            }
            let rest = self.rest();
            if rest.is_empty() {
                return None;
            }
            if !rest.starts_with('<') {
                let len = rest.find('<').unwrap_or(rest.len());
                self.pos += len;
                return Some(Token::Text(decode(&rest[..len], false)));
            }
            let bytes = rest.as_bytes();
            match bytes.get(1) {
                Some(b'!') => {
                    if rest.starts_with("<!--") {
                        self.skip_comment();
                    } else {
                        self.skip_to_gt();
                    }
                }
                Some(b'?') => self.skip_to_gt(),
                Some(b'/') => match bytes.get(2) {
                    Some(c) if c.is_ascii_alphabetic() => {
                        self.pos += 2;
                        let name = self.name();
                        // Attributes on an end tag are read and dropped.
                        if self.attributes().is_none() {
                            self.pos = self.src.len();
                            return None;
                        }
                        return Some(Token::End { name });
                    }
                    Some(b'>') => self.pos += 3,
                    None => {
                        self.pos = self.src.len();
                        return Some(Token::Text(Cow::Borrowed("</")));
                    }
                    Some(_) => self.skip_to_gt(),
                },
                Some(c) if c.is_ascii_alphabetic() => {
                    self.pos += 1;
                    let name = self.name();
                    let Some((attrs, self_closing)) = self.attributes() else {
                        self.pos = self.src.len();
                        return None;
                    };
                    if RAW_TEXT.contains(&name.as_str()) {
                        self.raw = Some(name.clone());
                    } else if name == "plaintext" {
                        // No end tag ends it: the rest is text.
                        self.raw = Some(String::from("\u{0}"));
                    }
                    return Some(Token::Start {
                        name,
                        attrs,
                        self_closing,
                    });
                }
                _ => {
                    self.pos += 1;
                    return Some(Token::Text(Cow::Borrowed("<")));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(html: &str) -> Vec<Token<'_>> {
        Tokenizer::new(html).collect()
    }

    fn start(name: &str, attrs: &[(&str, &str)]) -> Token<'static> {
        Token::Start {
            name: name.into(),
            attrs: attrs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            self_closing: false,
        }
    }

    fn end(name: &str) -> Token<'static> {
        Token::End { name: name.into() }
    }

    fn text(s: &str) -> Token<'_> {
        Token::Text(Cow::Borrowed(s))
    }

    #[test]
    fn tags_attributes_and_text() {
        assert_eq!(
            tokens(r#"<P CLASS=MsoNormal style='a:b' hidden data-x="1 &amp; 2">x&lt;y</p>"#),
            vec![
                start(
                    "p",
                    &[
                        ("class", "MsoNormal"),
                        ("style", "a:b"),
                        ("hidden", ""),
                        ("data-x", "1 & 2")
                    ]
                ),
                Token::Text(Cow::Owned("x<y".into())),
                end("p"),
            ]
        );
        assert_eq!(
            tokens("<br/><o:p></o:p>"),
            vec![
                Token::Start {
                    name: "br".into(),
                    attrs: vec![],
                    self_closing: true
                },
                start("o:p", &[]),
                end("o:p"),
            ]
        );
    }

    #[test]
    fn comments_and_word_conditionals_are_skipped() {
        assert_eq!(
            tokens(
                "<!--[if gte mso 9]><xml><w:x/></xml><![endif]--><![if !supportLists]>·<![endif]>a<!---->b<!-->c<?xml:namespace prefix = o ?>d<!DOCTYPE html>"
            ),
            vec![text("·"), text("a"), text("b"), text("c"), text("d")]
        );
    }

    #[test]
    fn raw_text_ends_at_its_own_end_tag() {
        assert_eq!(
            tokens("<style><!-- p.a {x:1} </p> --></STYLE >x<script>if (a<b) {}</script>"),
            vec![
                start("style", &[]),
                text("<!-- p.a {x:1} </p> -->"),
                end("style"),
                text("x"),
                start("script", &[]),
                text("if (a<b) {}"),
                end("script"),
            ]
        );
    }

    #[test]
    fn broken_input_never_fails() {
        assert_eq!(
            tokens("a < b <3 </>"),
            vec![text("a "), text("<"), text(" b "), text("<"), text("3 ")]
        );
        assert_eq!(tokens("x<p class='unclosed"), vec![text("x")]);
        assert_eq!(tokens("x<!-- never closed"), vec![text("x")]);
        assert_eq!(
            tokens("<b>中</"),
            vec![start("b", &[]), text("中"), text("</")]
        );
        assert_eq!(
            tokens("<script>never closed"),
            vec![start("script", &[]), text("never closed")]
        );
        // Multibyte text right after a tag name or in a bare attribute.
        assert_eq!(tokens("<a 名=值>"), vec![start("a", &[("名", "值")])]);
    }
}
