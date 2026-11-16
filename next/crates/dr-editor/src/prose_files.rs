//! Putting files into prose, the same way in the chapter editor
//! ([`crate::ChapterEditor`]) and the whole-book view ([`crate::BookEditor`])
//! (`v5-tracks.md` §T5 「往正文里放文件」, §T5b): the drop line between
//! paragraphs, library files and the computer's files dropped in, ⌘V of an
//! image, an image or PDF file, or a table, and copying or cutting a
//! selection that holds embeds.
//!
//! Everything works on one chapter of the view's [`ProseEditor`] (a chapter
//! editor has one, chapter 0) through that chapter's own [`NoteEmbeds`]:
//! the embed goes into that chapter's document as a step of its own, which
//! ⌘Z in that chapter takes back. An import that finishes in the background
//! finds the chapter again by its document ([`FileView::doc_embeds`]), so a
//! whole-book view rebuilt meanwhile still gets it right.

use std::path::PathBuf;
use std::rc::Rc;

use dr_workspace::Workspace;
use gpui::{
    App, AppContext as _, Bounds, ClipboardEntry, ClipboardItem, Context, Entity, Focusable,
    InteractiveElement as _, IntoElement, Pixels, Point, Styled as _, Window, div, px,
};
use gpui_prose::ProseEditor;

use crate::embeds::NoteEmbeds;

/// Where a dragged file would land: before paragraph `line` of chapter
/// `chapter` (`line` may be the chapter's paragraph count: after its last),
/// and the drop line drawn there, relative to the drop zone.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DropGap {
    pub chapter: usize,
    pub line: usize,
    pub y: Pixels,
    pub left: Pixels,
    pub width: Pixels,
}

/// Where imported files are embedded: before paragraph `Gap` of the chapter
/// (a drop), or at caret offset `Caret` (a paste, the file picker).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Place {
    Gap(usize),
    Caret(usize),
}

/// A view whose prose takes files.
pub(crate) trait FileView: Sized + 'static {
    fn file_ws(&self) -> &Workspace;
    fn file_book(&self) -> &str;
    /// The editor the files go into.
    fn file_prose(&self) -> &Entity<ProseEditor>;
    /// Chapter `chapter`'s embeds.
    fn chapter_embeds(&self, chapter: usize) -> Option<Rc<NoteEmbeds>>;
    /// Document `doc`'s embeds, while the view still shows it.
    fn doc_embeds(&self, doc: &str) -> Option<Rc<NoteEmbeds>>;
    /// Dropped files went into `embeds`' chapter; paragraph `next` follows
    /// them.
    fn files_dropped(&mut self, _embeds: &NoteEmbeds, _next: usize, _cx: &mut Context<Self>) {}
}

// ----- the drop line ------------------------------------------------------------

/// The box of paragraph `ix` of `chapter` as last drawn: its text, or the
/// file block an embed's paragraph shows. `(top, bottom, left, width)`.
fn line_box(
    e: &ProseEditor,
    chapter: usize,
    ix: usize,
    embeds: Option<&NoteEmbeds>,
    cx: &App,
) -> Option<(Pixels, Pixels, Pixels, Pixels)> {
    let doc = &e.book().chapters.get(chapter)?.doc;
    if ix >= doc.visible_lines() {
        return None;
    }
    let start = doc.line_start(ix);
    let end = start + doc.line(ix).chars;
    let wrap = e.style().max_width;
    e.range_bounds(chapter, start..end)
        .map(|b| (b.top(), b.bottom(), b.left(), wrap))
        .or_else(|| {
            let embed_id = doc.line(ix).embed()?;
            let b = embeds?.material_block(embed_id)?.read(cx).last_bounds()?;
            Some((b.top(), b.bottom(), b.left(), b.size.width))
        })
}

/// The paragraph gap nearest to `mouse` among `lines` (`(chapter,
/// paragraph)`, the ones that may be on screen), or `None` once the pointer
/// left `container`. With no paragraph drawn, the top of chapter
/// `fallback`.
pub(crate) fn drop_gap(
    editor: &ProseEditor,
    lines: impl IntoIterator<Item = (usize, usize)>,
    embeds: impl Fn(usize) -> Option<Rc<NoteEmbeds>>,
    fallback: usize,
    mouse: Point<Pixels>,
    container: Bounds<Pixels>,
    cx: &App,
) -> Option<DropGap> {
    if !container.contains(&mouse) {
        return None;
    }
    let mut best: Option<(DropGap, f32)> = None;
    let mut chapter_embeds: Option<(usize, Option<Rc<NoteEmbeds>>)> = None;
    for (chapter, ix) in lines {
        if chapter_embeds.as_ref().is_none_or(|(c, _)| *c != chapter) {
            chapter_embeds = Some((chapter, embeds(chapter)));
        }
        let em = chapter_embeds.as_ref().and_then(|(_, e)| e.as_deref());
        let Some((top, bottom, left, width)) = line_box(editor, chapter, ix, em, cx) else {
            continue;
        };
        for (line, y) in [(ix, top), (ix + 1, bottom)] {
            let dist = (f32::from(mouse.y) - f32::from(y)).abs();
            if best.as_ref().is_none_or(|b| dist < b.1) {
                let gap = DropGap {
                    chapter,
                    line,
                    y: y - container.origin.y,
                    left: left - container.origin.x,
                    width,
                };
                best = Some((gap, dist));
            }
        }
    }
    Some(match best {
        Some((gap, _)) => gap,
        None => DropGap {
            chapter: fallback,
            line: 0,
            y: px(20.),
            left: px(24.),
            width: (container.size.width - px(48.)).max(px(80.)),
        },
    })
}

/// The accent line a file drop lands on.
pub(crate) fn dropline(gap: DropGap, window: &Window, cx: &App) -> impl IntoElement {
    let accent = dr_ui::theme::Theme::of(window, cx).palette.accent.solid();
    div()
        .id("dr-editor-dropline")
        .absolute()
        .left(gap.left)
        .top(gap.y - px(1.))
        .w(gap.width)
        .h(px(2.))
        .rounded_full()
        .bg(accent)
}

/// The caret's chapter and the paragraph gap after its paragraph (where a
/// drop without a drop line lands).
pub(crate) fn after_caret(editor: &ProseEditor) -> Option<(usize, usize)> {
    let sel = editor.selection();
    let doc = &editor.book().chapters.get(sel.chapter)?.doc;
    Some((sel.chapter, doc.line_of(sel.head) + 1))
}

// ----- embedding ------------------------------------------------------------------

/// Embeds `assets` into gap `line` of `embeds`' chapter, one after another.
/// Returns `(embed, asset)` of each embedded and the paragraph after them.
fn embed_at_gap(
    embeds: &NoteEmbeds,
    assets: impl IntoIterator<Item = String>,
    mut line: usize,
    cx: &mut App,
) -> (Vec<(String, String)>, usize) {
    let mut placed = Vec::new();
    for id in assets {
        if let Ok(aid) = dr_model::id::AssetId::parse(&id)
            && let Some(eid) = crate::embeds::insert_material_before_line(embeds, line, aid, cx)
        {
            line += 1;
            placed.push((eid.to_string(), id));
        }
    }
    (placed, line)
}

/// Embeds `assets` at caret offset `offset` of `embeds`' chapter. Returns
/// `(embed, asset)` of each embedded.
fn embed_at_caret(
    embeds: &NoteEmbeds,
    assets: impl IntoIterator<Item = String>,
    offset: usize,
    cx: &mut App,
) -> Vec<(String, String)> {
    let mut placed = Vec::new();
    for id in assets {
        if let Ok(aid) = dr_model::id::AssetId::parse(&id)
            && let Some(eid) = crate::embeds::insert_material(embeds, offset, aid, cx)
        {
            placed.push((eid.to_string(), id));
        }
    }
    placed
}

/// Library files (and the files of dragged folders, in the library's order)
/// dropped into gap `line` of chapter `chapter`.
pub(crate) fn drop_library<V: FileView>(
    this: &mut V,
    drag: &dr_ui::AssetDrag,
    chapter: usize,
    line: usize,
    cx: &mut Context<V>,
) {
    if drag.book != this.file_book() {
        return;
    }
    let Some(embeds) = this.chapter_embeds(chapter) else {
        return;
    };
    if drag.folders.is_empty() {
        place_library(this, &embeds, drag.assets.clone(), line, cx);
        return;
    }
    let doc = embeds.host().doc_id.clone();
    let ws = this.file_ws().clone();
    let book = this.file_book().to_owned();
    let direct = drag.assets.clone();
    let folders = drag.folders.clone();
    cx.spawn(async move |this, cx| {
        let expanded = cx
            .background_spawn(async move { expand_folders(&ws, &book, direct, folders) })
            .await;
        this.update(cx, |this, cx| {
            if let Some(embeds) = this.doc_embeds(&doc) {
                place_library(this, &embeds, expanded, line, cx);
            }
        })
        .ok();
    })
    .detach();
}

fn place_library<V: FileView>(
    this: &mut V,
    embeds: &NoteEmbeds,
    assets: Vec<String>,
    line: usize,
    cx: &mut Context<V>,
) {
    let (placed, next) = embed_at_gap(embeds, assets, line, cx);
    crate::file_host::trigger_flash(placed.iter().map(|(e, _)| format!("embed_id:{e}")), cx);
    if !placed.is_empty() {
        this.files_dropped(embeds, next, cx);
    }
    cx.notify();
}

/// `direct`, then every file under `folders` (and their subfolders) that is
/// not already there, in the library's order.
fn expand_folders(
    ws: &Workspace,
    book: &str,
    direct: Vec<String>,
    folders: Vec<String>,
) -> Vec<String> {
    crate::v3::read(ws, book, move |v| {
        let all_folders: Vec<_> = v.asset_folders();
        let mut subtree = std::collections::HashSet::new();
        fn collect(
            all: &[dr_model::shared::AssetFolder],
            root: &str,
            out: &mut std::collections::HashSet<String>,
        ) {
            if !out.insert(root.to_owned()) {
                return;
            }
            for f in all {
                if f.parent.as_ref().is_some_and(|p| p.as_str() == root) {
                    collect(all, f.id.as_str(), out);
                }
            }
        }
        for fid in &folders {
            collect(&all_folders, fid, &mut subtree);
        }
        let mut assets = direct;
        let mut in_folders: Vec<_> = v
            .assets()
            .into_iter()
            .filter(|a| {
                a.folder
                    .as_ref()
                    .is_some_and(|f| subtree.contains(f.as_str()))
            })
            .collect();
        in_folders.sort_by(|a, b| {
            dr_model::pos::cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id))
        });
        for a in in_folders {
            let s = a.id.to_string();
            if !assets.contains(&s) {
                assets.push(s);
            }
        }
        assets
    })
    .unwrap_or_default()
}

/// Imports the computer's files `paths` into the library (the same bytes
/// give back the file already there) and embeds them in chapter `chapter`
/// at `place`.
pub(crate) fn import_files<V: FileView>(
    this: &V,
    chapter: usize,
    paths: Vec<PathBuf>,
    place: Place,
    cx: &mut Context<V>,
) {
    if paths.is_empty() {
        return;
    }
    let Some(embeds) = this.chapter_embeds(chapter) else {
        return;
    };
    let doc = embeds.host().doc_id.clone();
    let ws = this.file_ws().clone();
    let book = this.file_book().to_owned();
    let host_fn = crate::file_host::import_paths_fn(cx);
    cx.spawn(async move |this, cx| {
        let imported = cx
            .background_spawn(async move {
                crate::file_host::import_paths_blocking(host_fn.as_ref(), &ws, &book, &paths)
            })
            .await;
        if imported.is_empty() {
            return;
        }
        this.update(cx, |this, cx| {
            let Some(embeds) = this.doc_embeds(&doc) else {
                return;
            };
            let ids = imported.into_iter().map(|f| f.id);
            let placed = match place {
                Place::Gap(line) => {
                    let (placed, next) = embed_at_gap(&embeds, ids, line, cx);
                    if !placed.is_empty() {
                        this.files_dropped(&embeds, next, cx);
                    }
                    placed
                }
                Place::Caret(offset) => embed_at_caret(&embeds, ids, offset, cx),
            };
            crate::file_host::trigger_flash(
                placed
                    .into_iter()
                    .flat_map(|(e, a)| [format!("embed_id:{e}"), format!("library-asset:{a}"), a]),
                cx,
            );
            cx.notify();
        })
        .ok();
    })
    .detach();
}

/// A pasted image: into the library at the top (the same bytes give back the
/// file already there), embedded at caret offset `offset` of chapter
/// `chapter`.
fn paste_image<V: FileView>(
    this: &V,
    chapter: usize,
    bytes: Vec<u8>,
    offset: usize,
    cx: &mut Context<V>,
) {
    let Some(embeds) = this.chapter_embeds(chapter) else {
        return;
    };
    let doc = embeds.host().doc_id.clone();
    let title = crate::file_host::pasted_image_title(cx);
    let ws = this.file_ws().clone();
    let book = this.file_book().to_owned();
    let host_fn = crate::file_host::import_bytes_fn(cx);
    cx.spawn(async move |this, cx| {
        let res = cx
            .background_spawn(async move {
                crate::file_host::import_pasted_bytes_blocking(
                    host_fn.as_ref(),
                    &ws,
                    &book,
                    bytes,
                    &title,
                )
            })
            .await;
        let Ok(file) = res else {
            return;
        };
        this.update(cx, |this, cx| {
            if let Some(embeds) = this.doc_embeds(&doc)
                && let [(eid, _)] =
                    embed_at_caret(&embeds, [file.id.clone()], offset, cx).as_slice()
            {
                crate::file_host::trigger_flash(
                    [
                        format!("embed_id:{eid}"),
                        format!("library-asset:{}", file.id),
                        file.id,
                    ],
                    cx,
                );
            }
        })
        .ok();
    })
    .detach();
}

// ----- the clipboard --------------------------------------------------------------

/// Whether the body (not a table's cell) has the keyboard.
pub(crate) fn body_focused(prose: &Entity<ProseEditor>, window: &Window, cx: &App) -> bool {
    prose.read(cx).focus_handle(cx).is_focused(window)
}

/// Copy or cut in the body over a selection (in one chapter) holding
/// embeds: a table alone goes as a table (tab-separated, its cells in the
/// metadata); otherwise each embed as text (a table's rows, a file's name).
/// Returns whether it handled the key.
pub(crate) fn copy<V: FileView>(
    this: &mut V,
    cut: bool,
    window: &mut Window,
    cx: &mut Context<V>,
) -> bool {
    let prose = this.file_prose().clone();
    if !body_focused(&prose, window, cx) {
        return false;
    }
    let e = prose.read(cx);
    let sel = e.selection();
    if sel.is_empty() || sel.spans_chapters() {
        return false;
    }
    let Some(embeds) = this.chapter_embeds(sel.chapter) else {
        return false;
    };
    let range = sel.range();
    let doc = &e.book().chapters[sel.chapter].doc;
    let (first, _) = doc.locate(range.start);
    let (last, _) = doc.locate(range.end);
    let mut parts: Vec<(Option<String>, String)> = Vec::new();
    for line in first..=last.min(doc.visible_lines().saturating_sub(1)) {
        let start = doc.line_start(line);
        let l = doc.line(line);
        let from = range.start.max(start) - start;
        let to = range.end.min(start + l.chars).saturating_sub(start);
        match l.embed() {
            Some(id) if range.start <= start && range.end > start => {
                parts.push((Some(id.to_owned()), String::new()))
            }
            _ => parts.push((
                None,
                l.text
                    .chars()
                    .skip(from)
                    .take(to.saturating_sub(from))
                    .collect(),
            )),
        }
    }
    if !parts.iter().any(|(id, _)| id.is_some()) {
        return false;
    }
    let item = match parts.as_slice() {
        [(Some(id), _)] => embeds
            .table_grid(id)
            .map(|(cells, marks)| crate::table::clip::table_item(&cells, &marks))
            .unwrap_or_else(|| Ok(ClipboardItem::new_string(embeds.embed_text(id)))),
        _ => Ok(ClipboardItem::new_string(
            parts
                .iter()
                .map(|(id, text)| match id {
                    Some(id) => embeds.embed_text(id),
                    None => text.clone(),
                })
                .collect::<Vec<_>>()
                .join("\n"),
        )),
    };
    let item = match item {
        Ok(item) => item,
        Err(e) => {
            crate::links::clipboard_refused(cx, e);
            return true;
        }
    };
    cx.write_to_clipboard(item);
    if cut {
        prose.update(cx, |e, cx| e.press_backspace(window, cx));
    }
    true
}

/// Paste in the body: a copied table, or a tab-separated grid of at least
/// 2 × 2, becomes a table at the caret; an image, or the computer's image
/// and PDF files, go into the library (a new pasted image at the top; the
/// same bytes give back the file already there) and are embedded at the
/// caret. Returns whether it handled the key.
pub(crate) fn paste<V: FileView>(this: &mut V, window: &mut Window, cx: &mut Context<V>) -> bool {
    let prose = this.file_prose().clone();
    if !body_focused(&prose, window, cx) {
        return false;
    }
    let chapter = prose.read(cx).selection().chapter;
    let Some(embeds) = this.chapter_embeds(chapter) else {
        return false;
    };
    let Some(item) = cx.read_from_clipboard() else {
        return false;
    };
    // The selection goes first, as typing over it does.
    let clear = |cx: &mut Context<V>, window: &mut Window| {
        if !prose.read(cx).selection().is_empty() {
            prose.update(cx, |e, cx| e.press_backspace(window, cx));
        }
        prose.read(cx).selection().head
    };
    let cells = crate::table::clip::table_from_clipboard(&item).or_else(|| {
        item.text()
            .and_then(|t| crate::table::clip::parse_grid(&t))
            .filter(|g| crate::table::clip::is_table(g))
    });
    if let Some(cells) = cells {
        let marks = match crate::table::clip::marks_from_clipboard(&item) {
            Ok(m) => m,
            Err(e) => {
                crate::links::clipboard_refused(cx, e);
                return true;
            }
        };
        let offset = clear(cx, window);
        crate::embeds::insert_table(&embeds, offset, cells, marks, window, cx);
        return true;
    }
    for entry in item.entries() {
        match entry {
            ClipboardEntry::Image(image) => {
                let bytes = image.bytes().to_vec();
                let offset = clear(cx, window);
                paste_image(this, chapter, bytes, offset, cx);
                return true;
            }
            ClipboardEntry::ExternalPaths(paths) => {
                let paths = paths.paths().to_vec();
                if !paths.iter().any(|p| is_embeddable(p)) {
                    continue;
                }
                let offset = clear(cx, window);
                import_files(this, chapter, paths, Place::Caret(offset), cx);
                return true;
            }
            _ => {}
        }
    }
    false
}

/// An image or a PDF, by its extension.
fn is_embeddable(path: &std::path::Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
        matches!(
            e.to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "pdf"
        )
    })
}
