//! Small previews of materials, made once and shared by every view that
//! lists materials (the 素材库 panel, M23's cards): an image's or a PDF's
//! thumbnail, a note's first words.
//!
//! - Asked for and not there yet, a preview is made off the main thread
//!   and the windows are drawn again when it is ready; until then the
//!   caller shows its stand-in (a glyph, the kind's name).
//! - A thumbnail comes from the asset's thumbnail (made at import), else
//!   from its display copy or source, decoded small; a PDF without a
//!   thumbnail has its first page rendered small.
//! - A note's first words are read from its prose document and read again
//!   when it changes (F3's bus).
//!
//! Without a library (tests, captures without one) there are no previews.

use std::collections::HashMap;

use dr_workspace::{Actor, Workspace as Library, WsEvent};
use gpui::{App, Global};
use serde_json::json;

use crate::media::{self, PdfDoc, Picture};
use crate::page::MediaKind;

/// The longest side a thumbnail is decoded at (a 2× tile of 64 px).
pub const SIDE: u32 = 128;
/// How many characters of a note's beginning are kept.
pub const WORDS: usize = 80;

enum Slot<T> {
    Loading,
    Ready(T),
    Missing,
}

#[derive(Default)]
struct Previews {
    lib: Option<Library>,
    thumbs: HashMap<String, Slot<Picture>>,
    words: HashMap<String, Slot<String>>,
    _sub: Option<dr_workspace::events::Subscription>,
}

impl Global for Previews {}

/// The cache, over the app's library (the shell's `Services`).
fn previews(cx: &mut App) -> &mut Previews {
    if !cx.has_global::<Previews>() {
        let lib = cx
            .try_global::<dr_shell::Services>()
            .and_then(|s| s.library.clone());
        let sub = lib.as_ref().map(|lib| watch(lib, cx));
        cx.set_global(Previews {
            lib,
            _sub: sub,
            ..Default::default()
        });
    }
    cx.global_mut::<Previews>()
}

/// A note's words are read again when its prose changes.
fn watch(lib: &Library, cx: &mut App) -> dr_workspace::events::Subscription {
    let (tx, mut rx) = futures::channel::mpsc::unbounded::<String>();
    let sub = lib.subscribe(move |e| {
        if let WsEvent::Prose(p) = e {
            let doc = p.doc.to_string();
            if let Some(id) = doc.strip_prefix("material:") {
                let _ = tx.unbounded_send(id.to_owned());
            }
        }
    });
    cx.spawn(async move |cx| {
        use futures::StreamExt as _;
        while let Some(first) = rx.next().await {
            let mut ids = vec![first];
            while let Ok(more) = rx.try_recv() {
                ids.push(more);
            }
            cx.update(|cx| {
                if cx.has_global::<Previews>() {
                    let p = cx.global_mut::<Previews>();
                    for id in &ids {
                        p.words.remove(id);
                    }
                }
                cx.refresh_windows();
            });
        }
    })
    .detach();
    sub
}

/// Forgets every preview (a library swapped under the app).
pub fn forget(cx: &mut App) {
    if cx.has_global::<Previews>() {
        cx.remove_global::<Previews>();
    }
}

/// `asset`'s thumbnail, if it is made; asks for it if not.
pub fn thumbnail(asset: &str, kind: MediaKind, cx: &mut App) -> Option<Picture> {
    let p = previews(cx);
    match p.thumbs.get(asset) {
        Some(Slot::Ready(pic)) => return Some(pic.clone()),
        Some(_) => return None,
        None => {}
    }
    let lib = p.lib.clone()?;
    p.thumbs.insert(asset.to_owned(), Slot::Loading);
    let id = asset.to_owned();
    let task = cx
        .background_executor()
        .spawn(async move { make_thumbnail(&lib, &id, kind) });
    let asset = asset.to_owned();
    cx.spawn(async move |cx| {
        let made = task.await;
        cx.update(|cx| {
            if cx.has_global::<Previews>() {
                let p = cx.global_mut::<Previews>();
                p.thumbs.insert(
                    asset,
                    match made {
                        Some(pic) => Slot::Ready(pic),
                        None => Slot::Missing,
                    },
                );
            }
            cx.refresh_windows();
        });
    })
    .detach();
    None
}

fn make_thumbnail(lib: &Library, asset: &str, kind: MediaKind) -> Option<Picture> {
    let store = lib.library();
    let thumb = store
        .asset(asset, dr_store::asset::Variant::Thumbnail)
        .ok()
        .flatten();
    if let Some(record) = thumb {
        let bytes = std::fs::read(&record.path).ok()?;
        return media::decode_thumbnail(&bytes, SIDE).ok();
    }
    match kind {
        MediaKind::Image => {
            let path = media::thumbnail_source(store, asset)?;
            let bytes = std::fs::read(path).ok()?;
            media::decode_thumbnail(&bytes, SIDE).ok()
        }
        MediaKind::Pdf => {
            let bytes = media::read_pdf(store, asset).ok()?;
            let doc = PdfDoc::open(bytes).ok()?;
            let (w, h) = doc.pages[0];
            doc.render(0, SIDE as f32 / w.max(h).max(1.0)).ok()
        }
    }
}

/// A note's first words (`None` while they are read, or without a
/// library); empty for an empty note.
pub fn first_words(material: &str, cx: &mut App) -> Option<String> {
    let p = previews(cx);
    match p.words.get(material) {
        Some(Slot::Ready(w)) => return Some(w.clone()),
        Some(_) => return None,
        None => {}
    }
    let lib = p.lib.clone()?;
    p.words.insert(material.to_owned(), Slot::Loading);
    let id = material.to_owned();
    let task = cx
        .background_executor()
        .spawn(async move { read_words(&lib, &id) });
    let material = material.to_owned();
    cx.spawn(async move |cx| {
        let words = task.await;
        cx.update(|cx| {
            if cx.has_global::<Previews>() {
                let p = cx.global_mut::<Previews>();
                p.words.insert(
                    material,
                    match words {
                        Some(w) => Slot::Ready(w),
                        None => Slot::Missing,
                    },
                );
            }
            cx.refresh_windows();
        });
    })
    .detach();
    None
}

fn read_words(lib: &Library, material: &str) -> Option<String> {
    let read = lib
        .call(
            &Actor::User,
            "prose.read",
            json!({ "doc": format!("material:{material}") }),
        )
        .ok()?;
    let mut words = String::new();
    for p in read["output"]["paragraphs"].as_array()? {
        let text = p["text"].as_str().unwrap_or_default().trim();
        if text.is_empty() {
            continue;
        }
        if !words.is_empty() {
            words.push(' ');
        }
        words.push_str(text);
        if words.chars().count() >= WORDS {
            break;
        }
    }
    Some(clip(&words, WORDS))
}

/// At most `n` characters, whitespace runs as one space.
pub fn clip(text: &str, n: usize) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(n).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_clipped_and_spaced() {
        assert_eq!(clip("  潮水\n\n退了   以后 ", 80), "潮水 退了 以后");
        assert_eq!(clip("一二三四五", 3), "一二三");
    }
}
