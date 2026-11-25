//! Host bridge for v5 file embeds, file pickers, paste/drop imports, and
//! sand-frame highlights inside `dr-editor`.
//!
//! `dr-editor` sits below `dr-i18n`, `dr-shell`, and `dr-view-material` in the
//! workspace layer graph. When `dr_view_page::init` runs in the application,
//! it installs [`EditorFileHost`] with localized strings, full image/PDF
//! variant derivation, PDF page counting, library reveal, and `UsageFlash`
//! integration. Standalone `dr-editor` tests fall back to Chinese defaults and
//! direct `dr-store` + `dr-workspace` asset imports.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use dr_store::asset::{MAX_COPY_BYTES, MAX_WRITE_BYTES, SourceImport, Variant, VariantBytes};
use dr_workspace::commands::asset::{AssetMove, AssetMoveIn, AssetPut, AssetPutIn};
use dr_workspace::{Actor, Workspace};
use gpui::{App, Global, SharedString, Window};

/// One file imported into the asset library.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedFile {
    pub id: String,
    pub reused: bool,
}

/// Localized labels used by `dr-editor`'s v5 file UI.
#[derive(Clone, Debug)]
pub struct EditorFileStrings {
    pub slash_image_or_pdf: SharedString,
    pub find_file: SharedString,
    pub all_folders: SharedString,
    pub pick_from_computer: SharedString,
    pub empty: SharedString,
    pub prose_caption_placeholder: SharedString,
    pub size_heading: SharedString,
    pub size_small: SharedString,
    pub size_medium: SharedString,
    pub size_full: SharedString,
    pub align_heading: SharedString,
    pub align_left: SharedString,
    pub align_center: SharedString,
    pub align_right: SharedString,
    pub open: SharedString,
    pub locate_in_library: SharedString,
    pub remove_from_prose: SharedString,
    pub restore: SharedString,
    pub kind_image: SharedString,
    pub kind_pdf: SharedString,
    pub write_comment: SharedString,
    pub draw_region_comment: SharedString,
    // Editor slash menu, selection bar, @-create, and table toolbar strings.
    pub fmt_bold: SharedString,
    pub fmt_italic: SharedString,
    pub fmt_underline: SharedString,
    pub fmt_strike: SharedString,
    pub fmt_inline_code: SharedString,
    pub fmt_highlight: SharedString,
    pub bar_add_comment: SharedString,
    pub slash_entry_link: SharedString,
    pub slash_todo: SharedString,
    pub slash_comment: SharedString,
    pub slash_position_link: SharedString,
    pub slash_bullet_list: SharedString,
    pub slash_ordered_list: SharedString,
    pub slash_task_list: SharedString,
    pub slash_table: SharedString,
    pub slash_code_block: SharedString,
    pub slash_callout: SharedString,
    pub mention_create_entry_prefix: SharedString,
    pub mention_create_entry_suffix: SharedString,
    pub table_add_row: SharedString,
    pub table_add_col: SharedString,
    pub table_delete_row: SharedString,
    pub table_delete_col: SharedString,
    pub table_delete: SharedString,
}

impl Default for EditorFileStrings {
    fn default() -> Self {
        Self {
            slash_image_or_pdf: "图片或 PDF…".into(),
            find_file: "找文件".into(),
            all_folders: "全部".into(),
            pick_from_computer: "从电脑选…".into(),
            empty: "还没有文件".into(),
            prose_caption_placeholder: "图注".into(),
            size_heading: "大小".into(),
            size_small: "小".into(),
            size_medium: "中".into(),
            size_full: "正文宽".into(),
            align_heading: "对齐".into(),
            align_left: "靠左".into(),
            align_center: "居中".into(),
            align_right: "靠右".into(),
            open: "打开".into(),
            locate_in_library: "在素材库里找到".into(),
            remove_from_prose: "从正文拿走".into(),
            restore: "恢复".into(),
            kind_image: "图片".into(),
            kind_pdf: "PDF".into(),
            write_comment: "写批注".into(),
            draw_region_comment: "框一块写批注".into(),
            fmt_bold: "粗体".into(),
            fmt_italic: "斜体".into(),
            fmt_underline: "下划线".into(),
            fmt_strike: "删除线".into(),
            fmt_inline_code: "行内代码".into(),
            fmt_highlight: "高亮".into(),
            bar_add_comment: "添加批注".into(),
            slash_entry_link: "条目链接".into(),
            slash_todo: "待办".into(),
            slash_comment: "批注".into(),
            slash_position_link: "位置链接".into(),
            slash_bullet_list: "无序列表".into(),
            slash_ordered_list: "有序列表".into(),
            slash_task_list: "待办清单".into(),
            slash_table: "表格".into(),
            slash_code_block: "代码块".into(),
            slash_callout: "提示块".into(),
            mention_create_entry_prefix: "创建条目「".into(),
            mention_create_entry_suffix: "」".into(),
            table_add_row: "加一行".into(),
            table_add_col: "加一列".into(),
            table_delete_row: "删除行".into(),
            table_delete_col: "删除列".into(),
            table_delete: "删除表格".into(),
        }
    }
}

type StringsFn = Rc<dyn Fn(&App) -> EditorFileStrings>;
type PageCountStrFn = Rc<dyn Fn(usize, &App) -> String>;
type PastedTitleFn = Rc<dyn Fn(&App) -> String>;
type ImportPathsFn = Box<dyn Fn(&Workspace, &str, &[PathBuf]) -> Vec<ImportedFile> + Send + Sync>;
type ImportBytesFn =
    Box<dyn Fn(&Workspace, &str, Vec<u8>, &str) -> Result<ImportedFile, String> + Send + Sync>;
type PdfPagesFn = Box<dyn Fn(&Workspace, &str) -> Option<usize> + Send + Sync>;
type LocateFn = Rc<dyn Fn(&str, &mut Window, &mut App)>;
type TriggerFlashFn = Rc<dyn Fn(Vec<String>, &mut App)>;
type FlashActiveFn = Rc<dyn Fn(&[String], &mut Window, &App) -> bool>;

pub struct EditorFileCallbacks {
    pub strings: StringsFn,
    pub format_page_count: PageCountStrFn,
    pub pasted_image_title: PastedTitleFn,
    pub import_paths: std::sync::Arc<ImportPathsFn>,
    pub import_bytes: std::sync::Arc<ImportBytesFn>,
    pub pdf_pages: std::sync::Arc<PdfPagesFn>,
    pub locate_in_library: LocateFn,
    pub trigger_flash: TriggerFlashFn,
    pub flash_active: FlashActiveFn,
}

struct EditorFileHost(EditorFileCallbacks);
impl Global for EditorFileHost {}

static HOST_PDF_PAGES: OnceLock<std::sync::Arc<PdfPagesFn>> = OnceLock::new();

pub fn set_host(cx: &mut App, callbacks: EditorFileCallbacks) {
    let _ = HOST_PDF_PAGES.set(callbacks.pdf_pages.clone());
    cx.set_global(EditorFileHost(callbacks));
}

pub fn strings(cx: &App) -> EditorFileStrings {
    match cx.try_global::<EditorFileHost>() {
        Some(host) => (host.0.strings)(cx),
        None => EditorFileStrings::default(),
    }
}

pub fn format_page_count(pages: usize, cx: &App) -> String {
    match cx.try_global::<EditorFileHost>() {
        Some(host) => (host.0.format_page_count)(pages, cx),
        None => format!("{pages} 页"),
    }
}

pub fn pasted_image_title(cx: &App) -> String {
    match cx.try_global::<EditorFileHost>() {
        Some(host) => (host.0.pasted_image_title)(cx),
        None => fallback_pasted_title(),
    }
}

pub fn import_paths_fn(cx: &App) -> Option<std::sync::Arc<ImportPathsFn>> {
    cx.try_global::<EditorFileHost>()
        .map(|h| h.0.import_paths.clone())
}

pub fn import_bytes_fn(cx: &App) -> Option<std::sync::Arc<ImportBytesFn>> {
    cx.try_global::<EditorFileHost>()
        .map(|h| h.0.import_bytes.clone())
}

pub fn import_paths_blocking(
    host_fn: Option<&std::sync::Arc<ImportPathsFn>>,
    ws: &Workspace,
    book: &str,
    paths: &[PathBuf],
) -> Vec<ImportedFile> {
    match host_fn {
        Some(f) => f(ws, book, paths),
        None => fallback_import_paths(ws, book, paths),
    }
}

pub fn import_pasted_bytes_blocking(
    host_fn: Option<&std::sync::Arc<ImportBytesFn>>,
    ws: &Workspace,
    book: &str,
    bytes: Vec<u8>,
    title: &str,
) -> Result<ImportedFile, String> {
    let imported = match host_fn {
        Some(f) => f(ws, book, bytes, title)?,
        None => fallback_import_bytes(ws, book, bytes, title)?,
    };
    if !imported.reused {
        let _ = ws.run::<AssetMove>(
            &Actor::User,
            AssetMoveIn {
                book: book.to_owned(),
                id: imported.id.clone(),
                folder: None,
                index: Some(0),
            },
        );
    }
    Ok(imported)
}

pub fn pdf_pages(ws: &Workspace, asset_id: &str, cx: &App) -> Option<usize> {
    pdf_pages_with(
        ws,
        asset_id,
        cx.try_global::<EditorFileHost>()
            .map(|h| &h.0.pdf_pages)
            .or_else(|| HOST_PDF_PAGES.get()),
    )
}

pub fn pdf_pages_cached(ws: &Workspace, asset_id: &str) -> Option<usize> {
    pdf_pages_with(ws, asset_id, HOST_PDF_PAGES.get())
}

fn pdf_pages_with(
    ws: &Workspace,
    asset_id: &str,
    host_fn: Option<&std::sync::Arc<PdfPagesFn>>,
) -> Option<usize> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<usize>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(&cached) = cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(asset_id)
    {
        return cached;
    }
    let pages = match host_fn {
        Some(f) => f(ws, asset_id),
        None => fallback_pdf_pages(ws, asset_id),
    };
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if guard.len() >= 256 {
        guard.clear();
    }
    guard.insert(asset_id.to_owned(), pages);
    pages
}

pub fn locate_in_library(asset_id: &str, window: &mut Window, cx: &mut App) {
    if let Some(f) = cx
        .try_global::<EditorFileHost>()
        .map(|h| h.0.locate_in_library.clone())
    {
        f(asset_id, window, cx);
    }
}

#[derive(Clone, Debug)]
struct FallbackFlash {
    keys: Vec<String>,
    at: Instant,
}
impl Global for FallbackFlash {}

pub fn trigger_flash(keys: impl IntoIterator<Item = impl Into<String>>, cx: &mut App) {
    let keys: Vec<String> = keys
        .into_iter()
        .map(Into::into)
        .filter(|k| !k.is_empty())
        .collect();
    if keys.is_empty() {
        return;
    }
    if let Some(f) = cx
        .try_global::<EditorFileHost>()
        .map(|h| h.0.trigger_flash.clone())
    {
        f(keys, cx);
        return;
    }
    cx.set_global(FallbackFlash {
        keys,
        at: Instant::now(),
    });
    cx.refresh_windows();
}

pub fn flash_active(keys: &[String], window: &mut Window, cx: &App) -> bool {
    if let Some(host) = cx.try_global::<EditorFileHost>() {
        return (host.0.flash_active)(keys, window, cx);
    }
    let Some(f) = cx.try_global::<FallbackFlash>() else {
        return false;
    };
    if f.at.elapsed().as_millis() >= 1400 {
        return false;
    }
    let hit = keys.iter().any(|k| f.keys.contains(k));
    if hit {
        window.request_animation_frame();
    }
    hit
}

fn fallback_pasted_title() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mins = (secs / 60) % (24 * 60);
    format!("粘贴的图片 {:02}.{:02}", mins / 60, mins % 60)
}

fn kind_of_ext(ext: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "pdf" => ("pdf", "application/pdf", "pdf"),
        "png" => ("image", "image/png", "png"),
        "jpg" | "jpeg" => ("image", "image/jpeg", "jpg"),
        "gif" => ("image", "image/gif", "gif"),
        "webp" => ("image", "image/webp", "webp"),
        "bmp" => ("image", "image/bmp", "bmp"),
        "tif" | "tiff" => ("image", "image/tiff", "tiff"),
        _ => return None,
    })
}

fn kind_of_bytes(bytes: &[u8]) -> Option<(&'static str, &'static str, &'static str)> {
    if bytes.starts_with(b"%PDF-") {
        return Some(("pdf", "application/pdf", "pdf"));
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(("image", "image/png", "png"));
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some(("image", "image/jpeg", "jpg"));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(("image", "image/gif", "gif"));
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(("image", "image/webp", "webp"));
    }
    if bytes.starts_with(b"BM") {
        return Some(("image", "image/bmp", "bmp"));
    }
    None
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") && &bytes[12..16] == b"IHDR" {
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        if w > 0 && h > 0 {
            return Some((w, h));
        }
    }
    None
}

fn fallback_import_path(ws: &Workspace, book: &str, path: &Path) -> Result<ImportedFile, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .ok_or("unsupported extension")?;
    let (kind, mime, canonical_ext) = kind_of_ext(ext).ok_or("not an image or PDF")?;
    let dims = (kind == "image")
        .then(|| std::fs::read(path).ok().and_then(|b| png_dimensions(&b)))
        .flatten();
    let asset = dr_model::id::new_uuid_v7();
    let source = ws
        .library()
        .import_asset(&SourceImport {
            book_id: book,
            asset_id: &asset,
            source: path,
            mime,
            ext: canonical_ext,
            dimensions: dims,
            limit: MAX_COPY_BYTES,
        })
        .map_err(|e| e.to_string())?;
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .trim()
        .to_owned();
    let put = ws
        .run::<AssetPut>(
            &Actor::User,
            AssetPutIn {
                book: book.to_owned(),
                id: asset.clone(),
                name: title,
                kind: kind.to_owned(),
                mime: source.mime,
                size: source.size as i64,
                sha256: source.sha256,
                width: dims.map(|(w, _)| i64::from(w)),
                height: dims.map(|(_, h)| i64::from(h)),
                folder: None,
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(ImportedFile {
        reused: put.output.id != asset,
        id: put.output.id,
    })
}

fn fallback_import_paths(ws: &Workspace, book: &str, paths: &[PathBuf]) -> Vec<ImportedFile> {
    paths
        .iter()
        .filter_map(|p| fallback_import_path(ws, book, p).ok())
        .collect()
}

fn fallback_import_bytes(
    ws: &Workspace,
    book: &str,
    bytes: Vec<u8>,
    title: &str,
) -> Result<ImportedFile, String> {
    let (kind, mime, ext) = kind_of_bytes(&bytes).ok_or("not an image or PDF")?;
    if bytes.len() > MAX_WRITE_BYTES {
        return Err("too large".into());
    }
    let (w, h) = png_dimensions(&bytes).unwrap_or((1, 1));
    let asset = dr_model::id::new_uuid_v7();
    let mut import = ws
        .library()
        .begin_asset_import(book, &asset)
        .map_err(|e| e.to_string())?;
    if let Err(e) = import.write_variant(
        Variant::Source,
        &VariantBytes {
            bytes,
            mime: mime.into(),
            ext: ext.into(),
            width: w,
            height: h,
        },
    ) {
        let _ = import.abandon();
        return Err(e.to_string());
    }
    import.commit().map_err(|e| e.to_string())?;
    let source = ws
        .library()
        .asset(&asset, Variant::Source)
        .map_err(|e| e.to_string())?
        .ok_or("missing committed source")?;
    let put = ws
        .run::<AssetPut>(
            &Actor::User,
            AssetPutIn {
                book: book.to_owned(),
                id: asset.clone(),
                name: title.trim().to_owned(),
                kind: kind.to_owned(),
                mime: source.mime,
                size: source.size as i64,
                sha256: source.sha256,
                width: (kind == "image" && w > 1).then_some(i64::from(w)),
                height: (kind == "image" && h > 1).then_some(i64::from(h)),
                folder: None,
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(ImportedFile {
        reused: put.output.id != asset,
        id: put.output.id,
    })
}

fn fallback_pdf_pages(ws: &Workspace, asset_id: &str) -> Option<usize> {
    let record = ws.library().asset(asset_id, Variant::Source).ok()??;
    let bytes = std::fs::read(&record.path).ok()?;
    let mut count = 0usize;
    let needle = b"/Type /Page";
    for i in 0..bytes.len().saturating_sub(needle.len()) {
        if &bytes[i..i + needle.len()] == needle {
            let next = bytes.get(i + needle.len()).copied().unwrap_or(b' ');
            if next != b's' && !next.is_ascii_alphabetic() {
                count += 1;
            }
        }
    }
    (count > 0).then_some(count)
}
