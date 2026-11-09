//! Versioned v3 location addresses. No title resolution or legacy URL behavior.
//! `drifting:entries/id-<entry>/modules/id-<module>/prose.md#L1-L3`
//! `<build-scheme>://open/<book>/entries/id-<entry>/modules/id-<module>/prose.md#L1`
use dr_model::id::{BookId, EntryId, MaterialId, ModuleId};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Endpoint {
    Entry {
        id: EntryId,
        module: Option<ModuleId>,
    },
    Material(MaterialId),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Address {
    pub book: Option<BookId>,
    pub endpoint: Endpoint,
    /// Canonical prose lines (one-based, including separator lines).
    pub lines: Option<(u32, u32)>,
}
impl Address {
    pub fn format(&self, os_scheme: &str) -> String {
        let mut s = match &self.book {
            Some(book) => format!("{os_scheme}://open/{}/", encode(book.as_str())),
            None => "drifting:".to_owned(),
        };
        match &self.endpoint {
            Endpoint::Entry { id, module } => {
                s += &format!("entries/id-{}", encode(id.as_str()));
                if let Some(module) = module {
                    s += &format!("/modules/id-{}/prose.md", encode(module.as_str()));
                }
            }
            Endpoint::Material(id) => {
                s += &format!("materials/id-{}/prose.md", encode(id.as_str()))
            }
        }
        if let Some((start, end)) = self.lines {
            s += &format!("#L{start}");
            if end != start {
                s += &format!("-L{end}");
            }
        }
        s
    }
}

pub fn parse(href: &str, os_scheme: &str) -> Option<Address> {
    let (scheme, rest) = href.trim().split_once(':')?;
    if !scheme.eq_ignore_ascii_case("drifting") && !scheme.eq_ignore_ascii_case(os_scheme) {
        return None;
    }
    let (path, fragment) = rest
        .split_once('#')
        .map_or((rest, None), |(p, f)| (p, Some(f)));
    if path.contains('?') {
        return None;
    }
    let (book, path) = if let Some(path) = path.strip_prefix("//open/") {
        let (book, path) = path.split_once('/')?;
        (Some(BookId::parse(&decode(book)?).ok()?), path)
    } else {
        if !scheme.eq_ignore_ascii_case("drifting") || path.starts_with('/') {
            return None;
        }
        (None, path)
    };
    let pieces: Vec<_> = path.split('/').collect();
    let id = |s: &str| decode(s.strip_prefix("id-")?);
    let endpoint = match pieces.as_slice() {
        ["entries", e] => Endpoint::Entry {
            id: EntryId::parse(&id(e)?).ok()?,
            module: None,
        },
        ["entries", e, "modules", m, "prose.md"] => Endpoint::Entry {
            id: EntryId::parse(&id(e)?).ok()?,
            module: Some(ModuleId::parse(&id(m)?).ok()?),
        },
        ["materials", m, "prose.md"] => Endpoint::Material(MaterialId::parse(&id(m)?).ok()?),
        _ => return None,
    };
    let lines = match fragment {
        None => None,
        Some(f) => {
            if matches!(endpoint, Endpoint::Entry { module: None, .. }) {
                return None;
            }
            let (a, b) = f.split_once('-').map_or((f, f), |(a, b)| (a, b));
            let start: u32 = a.strip_prefix('L')?.parse().ok()?;
            let end: u32 = b.strip_prefix('L')?.parse().ok()?;
            if start == 0 || end < start {
                return None;
            }
            Some((start, end))
        }
    };
    Some(Address {
        book,
        endpoint,
        lines,
    })
}
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn decode(s: &str) -> Option<String> {
    let mut out = Vec::new();
    let mut bytes = s.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let h = (bytes.next()? as char).to_digit(16)?;
            let l = (bytes.next()? as char).to_digit(16)?;
            out.push((h * 16 + l) as u8);
        } else {
            out.push(b);
        }
    }
    String::from_utf8(out).ok()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn module_ids_and_book_ids_roundtrip_without_title_resolution() {
        let mut a = Address {
            book: None,
            endpoint: Endpoint::Entry {
                id: EntryId::parse("人物 A#%?").unwrap(),
                module: Some(ModuleId::parse("正文 2").unwrap()),
            },
            lines: Some((1, 7)),
        };
        let document = a.format("drifting-next-dev");
        assert_eq!(parse(&document, "drifting-next-dev"), Some(a.clone()));
        a.book = Some(BookId::parse("book ?#").unwrap());
        assert_eq!(
            parse(&a.format("drifting-next-dev"), "drifting-next-dev"),
            Some(a)
        );
        for s in [
            "drifting:entries/id-x#L1",
            "drifting:entries/id-x/modules/id-y/prose.md#L0",
            "drifting:entries/id-x/modules/id-y/prose.md#L5-L1",
            "drifting:entries/id-%FF",
            "drifting:chapters/id-x/prose.md",
            "https://open/book/entries/id-x",
        ] {
            assert_eq!(parse(s, "drifting-next-dev"), None, "{s}");
        }
    }
}
