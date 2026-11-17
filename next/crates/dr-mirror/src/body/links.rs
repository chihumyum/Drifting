use dr_model::id::AssetId;

use crate::layout::{AssetFile, markdown_destination, name_key};

/// Asset links are resolved against this project's plan, never by reading a
/// path provided by a Markdown file.
#[derive(Default)]
pub struct FileLinks<'a> {
    source: &'a str,
    assets: &'a [AssetFile],
}

impl<'a> FileLinks<'a> {
    pub fn new(source: &'a str, assets: &'a [AssetFile]) -> Self {
        Self { source, assets }
    }

    pub fn asset(&self, id: &AssetId) -> Option<&'a AssetFile> {
        self.assets.iter().find(|asset| &asset.id == id)
    }

    pub fn destination(&self, id: &AssetId) -> Option<String> {
        let file = self.asset(id)?;
        let mut from = self.source.split('/').collect::<Vec<_>>();
        from.pop();
        let to = file.path.split('/').collect::<Vec<_>>();
        let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
        let relative = format!(
            "{}{}",
            "../".repeat(from.len() - common),
            to[common..].join("/")
        );
        Some(markdown_destination(&relative))
    }

    pub(super) fn resolve(&self, link: &str, wiki: bool) -> Option<&'a AssetFile> {
        let dest = if wiki {
            link.to_owned()
        } else {
            percent_decode(link)?
        };
        let dir = self.source.rsplit_once('/').map_or("", |(dir, _)| dir);
        let rel = resolve_relative(dir, &dest);
        let direct = if wiki {
            resolve_relative("", &dest)
        } else {
            None
        };
        for path in rel.into_iter().chain(direct) {
            let key = name_key(&path);
            if let Some(asset) = self
                .assets
                .iter()
                .find(|asset| name_key(&asset.path) == key)
            {
                return Some(asset);
            }
        }
        if wiki && !dest.contains('/') {
            let key = name_key(&dest);
            let mut same_name = self.assets.iter().filter(|asset| {
                asset.present
                    && name_key(asset.path.rsplit('/').next().unwrap_or(&asset.path)) == key
            });
            let asset = same_name.next()?;
            return same_name.next().is_none().then_some(asset);
        }
        None
    }
}

fn resolve_relative(dir: &str, relative: &str) -> Option<String> {
    if relative.is_empty() || relative.starts_with('/') || relative.contains(['\\', ':', '\0']) {
        return None;
    }
    let mut parts: Vec<_> = dir.split('/').filter(|part| !part.is_empty()).collect();
    for part in relative.split('/') {
        match part {
            ".." => {
                parts.pop()?;
            }
            "" | "." => {}
            value => parts.push(value),
        }
    }
    Some(parts.join("/"))
}

fn percent_decode(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut src = value.bytes();
    while let Some(b) = src.next() {
        if b == b'%' {
            let a = char::from(src.next()?).to_digit(16)?;
            let b = char::from(src.next()?).to_digit(16)?;
            bytes.push((a * 16 + b) as u8);
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes).ok()
}
