//! An image or PDF material's page (the 0.1 client's `MaterialMediaPage`,
//! in its shell mode): on the desk, no sheet; the picture is the one raised
//! paper.
//!
//! - The head: the title and the description, edited in place (Enter or
//!   leaving saves the title; leaving saves the description).
//! - The stage: the picture fitted, zoomed with ⌘ + wheel, a pinch, the
//!   toolbar's − and + or ⌘= / ⌘-, back to fitted with the percentage, a
//!   double click or ⌘0; panned by dragging or the wheel once zoomed in.
//!   A PDF shows one page at a time, turned with the pager at the foot or
//!   ← / →, rendered again at the size it is shown at once the zoom settles.
//! - Region comments: 框选批注 in the toolbar, then a drag over the picture
//!   marks a rectangle and the comment composer comes up where the drag
//!   ended; saved, the comment marks that rectangle (on that PDF page). The
//!   rectangles are drawn as dry sand frames, faint at rest, stronger under
//!   the pointer, drawn round again when chosen, with the comment's number
//!   on a seal at the corner. Esc ends drawing.
//! - The column of the material's comments on the right (when there are
//!   any, or while drawing), in reading order, numbered like the seals:
//!   pointing at one lights its rectangle and the other way round;
//!   choosing one turns to its page.

use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

#[cfg(test)]
#[path = "page_v3_tests.rs"]
mod v3_tests;

use dr_doc::v3::CollectionV3 as Collection;
use dr_i18n::keys;
use dr_shell::book::Book;
use dr_shell::nav::{Open, Target as NavTarget};
use dr_shell::pages::{PageViewHost, UsageFlash};
use dr_shell::strings::{Strings, tf};
use dr_shell::{Workspace, t};
use dr_ui::Theme;
use dr_ui::components::IconButton;
use dr_ui::fonts::{Role, weight};
use dr_ui::glass::{self, Kind as GlassKind, Mode, Spec, Tone};
use dr_ui::input::{FieldEvent, TextArea};
use dr_ui::sand::{self, Icon, KindMark, SandFrame, SandMask};
use dr_ui::style::DrStyled;
use dr_ui::tokens::color::Rgb;
use dr_ui::tokens::{Story, glass as g, radius};
use dr_view_review::{CommentComposer, ComposerEvent};
use dr_workspace::commands::asset::{AssetRename, AssetRenameIn};
use dr_workspace::commands::comment::{CommentUpdate, CommentUpdateIn};
use dr_workspace::commands::v3::module::{In as ModuleIn, MediaPut, MediaPutIn};
use dr_workspace::commands::v3::types;
use dr_workspace::dto::Target;
use dr_workspace::{Actor, Workspace as Library, WsEvent};
use gpui::{
    AnyElement, App, AppContext, Bounds, BoxShadow, ClickEvent, Context, CursorStyle,
    DispatchPhase, ElementId, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement,
    PinchEvent, Pixels, Point, Render, ScrollEvent, SharedString, StatefulInteractiveElement,
    Styled, Subscription, Task, WeakEntity, Window, anchored, canvas, deferred, div, img, point,
    prelude::FluentBuilder, px,
};

use crate::library_data::{self, ResolvedUsage};
use crate::media::{self, PdfDoc, Picture, Trouble};
use crate::regions::{self, Listed, UnitRect};
use crate::viewport::{self, Frame, STEP, Viewport, WHEEL_ZOOM};

/// The column of comments.
pub const COLUMN_WIDTH: f32 = 300.0;

/// Which picture a material holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Pdf,
}

impl MediaKind {
    pub fn parse(kind: &str) -> Option<MediaKind> {
        match kind {
            "image" => Some(MediaKind::Image),
            "pdf" => Some(MediaKind::Pdf),
            _ => None,
        }
    }
}

/// The picture, as far as it has come.
enum Media {
    Loading,
    Image(Picture),
    Pdf {
        doc: Arc<PdfDoc>,
        /// The page shown, from 0.
        page: usize,
        /// The last rendering: its page, its scale and the bitmap.
        shown: Option<(usize, f32, Picture)>,
    },
    Trouble(Trouble),
}

/// A drag on the stage.
#[derive(Clone, Copy, Debug)]
enum Gesture {
    /// Moving the zoomed picture: where the drag began and the pan then.
    Pan {
        from: Point<Pixels>,
        pan: (f32, f32),
    },
    /// Marking a rectangle, in fractions of the picture.
    Draw { from: (f32, f32), to: (f32, f32) },
}

pub struct MediaPage {
    id: String,
    kind: MediaKind,
    lib: Library,
    book_id: String,
    book: Rc<Book>,
    workspace: WeakEntity<Workspace>,
    focus: FocusHandle,
    media: Media,
    viewport: Viewport,
    /// The stage as laid out last (window coordinates).
    stage: Option<Bounds<Pixels>>,
    gesture: Option<Gesture>,
    drawing: bool,
    frame_scope: Option<dr_shell::FrameScope>,
    selected: Option<String>,
    /// The comment whose rectangle or card the pointer is on.
    pointed: Option<String>,
    comments: Vec<Listed>,
    composer: Option<(Entity<CommentComposer>, Point<Pixels>, Subscription)>,
    /// The rectangle being written about, drawn while the composer is up
    /// (its page: `None` on an image).
    pending: Option<(UnitRect, Option<u32>)>,
    title: Entity<TextArea>,
    description: Entity<TextArea>,
    /// What the fields were last given from the book (never the author's
    /// unsaved typing is replaced).
    shown_title: Option<String>,
    shown_description: Option<String>,
    dirty_title: bool,
    dirty_description: bool,
    saving_title: bool,
    saving_description: bool,
    title_error: Option<String>,
    description_error: Option<String>,
    /// The asset the picture was read from.
    asset: Option<String>,
    usages: Vec<ResolvedUsage>,
    usages_task: Option<Task<()>>,
    loading: Option<Task<()>>,
    rendering: Option<(usize, f32, Task<()>)>,
    reloading: Option<Task<()>>,
    _library: Option<dr_workspace::events::Subscription>,
    _subs: Vec<Subscription>,
}

impl Focusable for MediaPage {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// The sand of a comment (`--comment`) or a TODO (the fourth story colour
/// a little toward ink), as the Review cards have them.
fn kind_color(theme: &Theme, todo: bool) -> Rgb {
    let p = theme.palette;
    if todo {
        p.story(Story::S4).mix(p.ink(1), 0.16)
    } else {
        p.comment
    }
}

/// A stroke seed from the comment's id: a region keeps its stroke.
fn seed_of(id: &str) -> u32 {
    let mut hash: u32 = 2_166_136_261;
    for b in id.bytes() {
        hash = (hash ^ u32::from(b)).wrapping_mul(16_777_619);
    }
    hash
}

impl MediaPage {
    pub fn new(
        id: String,
        kind: MediaKind,
        host: PageViewHost,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> MediaPage {
        let untitled = t(cx, keys::top_timeline::untitled::LIBRARY_ITEM);
        let title = cx.new(|cx| {
            TextArea::new(
                ElementId::Name(format!("material-title-{id}").into()),
                window,
                cx,
            )
            .submit_on_enter()
            .placeholder(untitled)
        });
        let hint = t(cx, keys::material_editor::DESCRIPTION_PLACEHOLDER);
        let description = cx.new(|cx| {
            TextArea::new(
                ElementId::Name(format!("material-description-{id}").into()),
                window,
                cx,
            )
            .placeholder(hint)
        });
        let mut page = MediaPage {
            id,
            kind,
            lib: host.library,
            book_id: host.book_id,
            book: host.book,
            workspace: host.workspace,
            focus: cx.focus_handle(),
            media: Media::Loading,
            viewport: Viewport::FIT,
            stage: None,
            gesture: None,
            drawing: false,
            frame_scope: None,
            selected: None,
            pointed: None,
            comments: Vec::new(),
            composer: None,
            pending: None,
            title,
            description,
            shown_title: None,
            shown_description: None,
            dirty_title: false,
            dirty_description: false,
            saving_title: false,
            saving_description: false,
            title_error: None,
            description_error: None,
            asset: None,
            usages: Vec::new(),
            usages_task: None,
            loading: None,
            rendering: None,
            reloading: None,
            _library: None,
            _subs: Vec::new(),
        };
        page.subscribe(window, cx);
        page.sync_fields(window, cx);
        page.consume_frame_intent(cx);
        page.load(cx);
        page.reload_comments(cx);
        page
    }

    fn consume_frame_intent(&mut self, cx: &mut Context<Self>) {
        let asset_key = self
            .info()
            .and_then(|m| m.asset.clone())
            .unwrap_or_else(|| self.id.clone());
        if let Some(scope) = dr_shell::take_frame_intent(&asset_key, cx) {
            self.frame_scope = Some(scope);
            self.drawing = true;
        }
    }

    /// The material's id.
    pub fn material(&self) -> &str {
        &self.id
    }

    pub fn kind(&self) -> MediaKind {
        self.kind
    }

    /// Places in the book using this file (`用在` chips in the viewer header).
    pub fn usages(&self) -> &[ResolvedUsage] {
        &self.usages
    }

    fn info(&self) -> Option<&dr_shell::book::MaterialInfo> {
        self.book.material_info(&self.id)
    }

    fn subscribe(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let title = cx.subscribe_in(&self.title, window, |page, field, e, window, cx| match e {
            FieldEvent::Submitted(_) => window.focus(&page.focus, cx),
            FieldEvent::Cancelled => {
                let stored = page.info().map(|m| m.title.clone()).unwrap_or_default();
                field.update(cx, |f, cx| f.set_text(stored, cx));
                page.dirty_title = false;
                page.title_error = None;
                window.focus(&page.focus, cx);
            }
            FieldEvent::Blurred => {
                let text = field.read(cx).text();
                page.save_title(text, cx);
            }
            FieldEvent::Changed(_) => page.dirty_title = page.book.v3().is_some(),
        });
        let description = cx.subscribe_in(
            &self.description,
            window,
            |page, field, e, window, cx| match e {
                FieldEvent::Submitted(_) => window.focus(&page.focus, cx),
                FieldEvent::Cancelled => {
                    let stored = page
                        .info()
                        .map(|m| m.description.clone())
                        .unwrap_or_default();
                    field.update(cx, |f, cx| f.set_text(stored, cx));
                    page.dirty_description = false;
                    page.description_error = None;
                    window.focus(&page.focus, cx);
                }
                FieldEvent::Blurred => {
                    let text = field.read(cx).text();
                    page.save_description(text, cx);
                }
                FieldEvent::Changed(_) => page.dirty_description = page.book.v3().is_some(),
            },
        );
        self._subs.push(title);
        self._subs.push(description);
        // The shell reads the book again after every change: titles,
        // descriptions and assets come from there.
        if let Some(ws) = self.workspace.upgrade() {
            self._subs
                .push(cx.observe_in(&ws, window, |page, ws, window, cx| {
                    let book = ws.read(cx).book.clone();
                    if !Rc::ptr_eq(&book, &page.book) {
                        page.book = book;
                        page.sync_fields(window, cx);
                        if page.info().and_then(|m| m.asset.clone()) != page.asset {
                            page.load(cx);
                        }
                        page.reload_usages(cx);
                        cx.notify();
                    }
                }));
        }
        // Comments and usages change on F3's bus.
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<bool>();
        let book = self.book_id.clone();
        self._library = Some(self.lib.subscribe(move |e| match e {
            WsEvent::Book(b) if b.book.as_str() == book => {
                let comments = b
                    .changes
                    .iter()
                    .any(|c| c.collection == Collection::Comments);
                let _ = tx.unbounded_send(comments);
            }
            WsEvent::Prose(p) if p.book.as_ref().is_some_and(|b| b.as_str() == book.as_str()) => {
                let _ = tx.unbounded_send(false);
            }
            _ => {}
        }));
        cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while let Some(mut comments) = rx.next().await {
                while let Ok(more) = rx.try_recv() {
                    comments |= more;
                }
                if this
                    .update(cx, |page, cx| {
                        page.reload_usages(cx);
                        if comments {
                            page.reload_comments(cx);
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    /// Puts the stored title and description in fields the author is not
    /// typing in.
    fn sync_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(m) = self.info().cloned() else {
            return;
        };
        let typing = |f: &Entity<TextArea>, window: &Window, cx: &App| {
            f.read(cx).focus_handle(cx).is_focused(window)
        };
        if self.shown_title.as_deref() != Some(m.title.as_str())
            && !typing(&self.title, window, cx)
            && !self.dirty_title
            && !self.saving_title
        {
            self.title
                .update(cx, |f, cx| f.set_text(m.title.clone(), cx));
            self.shown_title = Some(m.title.clone());
        }
        if self.shown_description.as_deref() != Some(m.description.as_str())
            && !typing(&self.description, window, cx)
            && !self.dirty_description
            && !self.saving_description
        {
            self.description
                .update(cx, |f, cx| f.set_text(m.description.clone(), cx));
            self.shown_description = Some(m.description.clone());
        }
    }

    fn update_media(
        &mut self,
        title: Option<String>,
        description: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let Some(current) = self.info().cloned() else {
            return;
        };
        let Some(asset) = current.asset.clone() else {
            return;
        };
        // A media item's name is its entry's title and its description the
        // item's caption; a file only in the asset library has its own name
        // and no description.
        let place = current.entry.clone().zip(current.module.clone());
        let description = description.filter(|_| place.is_some());
        if title.is_none() && description.is_none() {
            return;
        }
        let lib = self.lib.clone();
        let book = self.book_id.clone();
        let item_id = self.id.clone();
        let pos = current.pos.clone();
        if title.is_some() {
            self.saving_title = true;
            self.dirty_title = true;
            self.title_error = None;
            self.title.update(cx, |f, cx| f.set_disabled(true, cx));
        }
        if description.is_some() {
            self.saving_description = true;
            self.dirty_description = true;
            self.description_error = None;
            self.description
                .update(cx, |f, cx| f.set_disabled(true, cx));
        }
        let title_to_save = title.clone();
        let desc_to_save = description.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    if let Some(t) = title_to_save {
                        lib.run::<AssetRename>(
                            &Actor::User,
                            AssetRenameIn {
                                book: book.clone(),
                                id: asset.clone(),
                                name: t,
                            },
                        )?;
                    }
                    if let (Some(c), Some((entry, module))) = (desc_to_save, place) {
                        lib.run::<MediaPut>(
                            &Actor::User,
                            MediaPutIn {
                                target: ModuleIn {
                                    book,
                                    entry,
                                    module,
                                },
                                item: types::MediaItem {
                                    id: item_id,
                                    asset,
                                    caption: c,
                                    pos,
                                    missing: false,
                                },
                            },
                        )?;
                    }
                    Ok::<(), dr_workspace::WsError>(())
                })
                .await;
            this.update(cx, |page, cx| {
                if let Some(title) = title {
                    page.saving_title = false;
                    page.title.update(cx, |f, cx| f.set_disabled(false, cx));
                    match &result {
                        Ok(_) => {
                            page.shown_title = Some(title.clone());
                            page.dirty_title = page.title.read(cx).text().trim() != title;
                        }
                        Err(e) => page.title_error = Some(e.to_string()),
                    }
                }
                if let Some(description) = description {
                    page.saving_description = false;
                    page.description
                        .update(cx, |f, cx| f.set_disabled(false, cx));
                    match &result {
                        Ok(_) => {
                            page.shown_description = Some(description.clone());
                            page.dirty_description =
                                page.description.read(cx).text() != description;
                        }
                        Err(e) => page.description_error = Some(e.to_string()),
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn save_title(&mut self, text: String, cx: &mut Context<Self>) {
        if self.saving_title {
            return;
        }
        let title = text.trim().to_owned();
        let stored = self.info().map(|m| m.title.clone()).unwrap_or_default();
        if title.is_empty() || title == stored {
            if title == stored {
                self.dirty_title = false;
                self.title_error = None;
            }
            return;
        }
        self.update_media(Some(title), None, cx);
    }

    fn save_description(&mut self, text: String, cx: &mut Context<Self>) {
        if self.saving_description {
            return;
        }
        let stored = self
            .info()
            .map(|m| m.description.clone())
            .unwrap_or_default();
        if text.trim() == stored.trim() {
            self.dirty_description = false;
            self.description_error = None;
            return;
        }
        self.update_media(None, Some(text), cx);
    }

    // The picture.

    /// Reads and decodes the picture (an image) or opens the PDF, off the
    /// main thread.
    fn load(&mut self, cx: &mut Context<Self>) {
        self.asset = self.info().and_then(|m| m.asset.clone());
        let Some(asset) = self.asset.clone() else {
            self.media = Media::Trouble(Trouble::Missing);
            self.reload_usages(cx);
            return;
        };
        self.media = Media::Loading;
        self.rendering = None;
        let (lib, book, kind) = (self.lib.clone(), self.book_id.clone(), self.kind);
        let untitled_label = t(cx, keys::common::UNTITLED).to_string();
        let task = cx.background_executor().spawn(async move {
            let store = lib.library();
            let media = match kind {
                MediaKind::Image => media::read_image(store, &asset)
                    .and_then(|bytes| media::decode_image(&bytes))
                    .map(Media::Image),
                MediaKind::Pdf => {
                    media::read_pdf(store, &asset)
                        .and_then(PdfDoc::open)
                        .map(|doc| Media::Pdf {
                            doc: Arc::new(doc),
                            page: 0,
                            shown: None,
                        })
                }
            };
            let usages = library_data::load_asset_usages(
                &lib,
                &book,
                &asset,
                &untitled_label,
            );
            (media, usages)
        });
        self.loading = Some(cx.spawn(async move |this, cx| {
            let (media, usages) = task.await;
            this.update(cx, |page, cx| {
                if page.usages.is_empty() != usages.is_empty() || page.usages.len() != usages.len()
                {
                    page.stage = None;
                }
                page.media = media.unwrap_or_else(Media::Trouble);
                page.usages = usages;
                page.viewport = Viewport::FIT;
                page.loading = None;
                cx.notify();
            })
            .ok();
        }));
    }

    /// Whether the picture is there to draw on.
    pub fn ready(&self) -> bool {
        if self.stage.is_none() || self.usages_task.is_some() || self.rendering.is_some() {
            return false;
        }
        match &self.media {
            Media::Image(_) => true,
            Media::Pdf { shown, page, .. } => shown
                .as_ref()
                .is_some_and(|(p, s, _)| *p == *page && *s > 0.0),
            _ => false,
        }
    }

    /// The PDF's pages (1 for an image, 0 while loading).
    pub fn page_count(&self) -> usize {
        match &self.media {
            Media::Image(_) => 1,
            Media::Pdf { doc, .. } => doc.pages.len(),
            _ => 0,
        }
    }

    /// The page shown, from 1 (`None` on an image).
    pub fn page(&self) -> Option<u32> {
        match &self.media {
            Media::Pdf { page, .. } => Some(*page as u32 + 1),
            _ => None,
        }
    }

    pub fn viewport(&self) -> Viewport {
        self.viewport
    }

    pub fn drawing(&self) -> bool {
        self.drawing
    }

    pub fn selected(&self) -> Option<&str> {
        self.selected.as_deref()
    }

    pub fn comments(&self) -> &[Listed] {
        &self.comments
    }

    pub fn composer(&self) -> Option<&Entity<CommentComposer>> {
        self.composer.as_ref().map(|c| &c.0)
    }

    /// The comment whose rectangle or card the pointer is on.
    pub fn pointed(&self) -> Option<&str> {
        self.pointed.as_deref()
    }

    /// Why there is no picture, if there is not.
    pub fn trouble(&self) -> Option<&Trouble> {
        match &self.media {
            Media::Trouble(t) => Some(t),
            _ => None,
        }
    }

    /// The stage's top left corner in the window, as laid out last.
    pub fn stage_origin(&self) -> Option<(f32, f32)> {
        self.stage
            .map(|b| (f32::from(b.origin.x), f32::from(b.origin.y)))
    }

    /// The pixels of the PDF page shown, as rendered (`None` on an image
    /// or before the page is rendered).
    pub fn rendered_size(&self) -> Option<(u32, u32)> {
        match &self.media {
            Media::Pdf {
                page,
                shown: Some((p, _, picture)),
                ..
            } if p == page => Some((picture.width, picture.height)),
            _ => None,
        }
    }

    /// The picture's size before fitting (pixels; points for a page).
    fn natural(&self) -> Option<(f32, f32)> {
        match &self.media {
            Media::Image(p) => Some((p.width as f32, p.height as f32)),
            Media::Pdf { doc, page, .. } => doc.pages.get(*page).copied(),
            _ => None,
        }
    }

    fn stage_size(&self) -> Option<(f32, f32)> {
        self.stage
            .map(|b| (f32::from(b.size.width), f32::from(b.size.height)))
    }

    /// Where the picture is fitted and centred: the stage less the
    /// toolbar's band (and the pager's, with pages to turn).
    fn area(&self) -> Option<Frame> {
        Some(viewport::area(self.stage_size()?, self.page_count() > 1))
    }

    fn fitted(&self) -> Option<(f32, f32)> {
        let (natural, area) = (self.natural()?, self.area()?);
        let room = (area.w, area.h);
        Some(match self.kind {
            MediaKind::Image => viewport::fit_image(natural, room),
            MediaKind::Pdf => viewport::fit_page(natural, room),
        })
    }

    /// Where the picture lies on the stage (stage coordinates).
    pub fn frame(&self) -> Option<Frame> {
        let (fitted, area) = (self.fitted()?, self.area()?);
        Some(self.viewport.frame(fitted, area))
    }

    fn local(&self, at: Point<Pixels>) -> Option<(f32, f32)> {
        let stage = self.stage?;
        Some((
            f32::from(at.x - stage.origin.x),
            f32::from(at.y - stage.origin.y),
        ))
    }

    fn set_viewport(&mut self, v: Viewport, cx: &mut Context<Self>) {
        let v = match (self.fitted(), self.area()) {
            (Some(f), Some(a)) => v.kept(f, a),
            _ => v,
        };
        if v != self.viewport {
            self.viewport = v;
            cx.notify();
        }
    }

    /// Zooms by `factor` about a window point (the picture's centre when
    /// `None`).
    pub fn zoom_by(&mut self, factor: f32, at: Option<Point<Pixels>>, cx: &mut Context<Self>) {
        let anchor = match (at.and_then(|a| self.local(a)), self.area()) {
            (Some((x, y)), Some(area)) => {
                let (cx_, cy_) = area.centre();
                (x - cx_, y - cy_)
            }
            _ => (0.0, 0.0),
        };
        let v = self.viewport.zoom_by(factor, anchor);
        self.set_viewport(v, cx);
    }

    pub fn reset_zoom(&mut self, cx: &mut Context<Self>) {
        self.set_viewport(Viewport::FIT, cx);
    }

    pub fn pan_by(&mut self, dx: f32, dy: f32, cx: &mut Context<Self>) {
        let v = self.viewport.pan_by(dx, dy);
        self.set_viewport(v, cx);
    }

    /// Turns to page `page` (from 1) of a PDF.
    pub fn turn_to(&mut self, page: u32, cx: &mut Context<Self>) {
        let count = self.page_count();
        if let Media::Pdf { page: shown, .. } = &mut self.media {
            let to = (page.max(1) as usize - 1).min(count.saturating_sub(1));
            if to != *shown {
                *shown = to;
                self.viewport = Viewport::FIT;
                self.gesture = None;
                cx.notify();
            }
        }
    }

    fn turn_by(&mut self, step: i32, cx: &mut Context<Self>) {
        if let Some(page) = self.page() {
            let to = (page as i32 + step).max(1) as u32;
            self.turn_to(to, cx);
        }
    }

    /// Renders the PDF page shown at the size it is shown at, when the
    /// last rendering is another page or too far off; after a short wait,
    /// so a zoom gesture renders once it settles.
    fn keep_rendered(&mut self, window: &Window, cx: &mut Context<Self>) {
        let Some(frame) = self.frame() else {
            return;
        };
        let Media::Pdf { doc, page, shown } = &self.media else {
            return;
        };
        let (doc, page) = (doc.clone(), *page);
        let Some(size) = doc.pages.get(page).copied() else {
            return;
        };
        let want = viewport::render_scale(size, (frame.w, frame.h), window.scale_factor());
        let current = shown
            .as_ref()
            .is_some_and(|(p, s, _)| *p == page && !viewport::needs_rerender(*s, want));
        if current {
            return;
        }
        if let Some((p, s, _)) = &self.rendering
            && *p == page
            && !viewport::needs_rerender(*s, want)
        {
            return;
        }
        // A new page or resized stage renders at once; a new zoom after the gesture rests.
        let wait = if shown
            .as_ref()
            .is_some_and(|(p, s, _)| *p == page && *s > 0.0)
        {
            Duration::from_millis(120)
        } else {
            Duration::ZERO
        };
        let task = cx.spawn(async move |this, cx| {
            if !wait.is_zero() {
                cx.background_executor().timer(wait).await;
            }
            let rendered = cx
                .background_executor()
                .spawn(async move { doc.render(page, want) })
                .await;
            this.update(cx, |p, cx| {
                p.rendering = None;
                match rendered {
                    Ok(picture) => {
                        if let Media::Pdf { shown, .. } = &mut p.media {
                            *shown = Some((page, want, picture));
                        }
                    }
                    Err(trouble) => {
                        log::warn!("material: page {}: {trouble:?}", page + 1);
                        p.media = Media::Trouble(trouble);
                    }
                }
                cx.notify();
            })
            .ok();
        });
        self.rendering = Some((page, want, task));
    }

    // Drawing and pointing.

    pub fn set_drawing(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.drawing != on {
            self.drawing = on;
            if !on {
                self.frame_scope = None;
                if matches!(self.gesture, Some(Gesture::Draw { .. })) {
                    self.gesture = None;
                }
            }
            cx.notify();
        }
    }

    /// A point of the picture (fractions) under a window point.
    fn unit_at(&self, at: Point<Pixels>) -> Option<(f32, f32)> {
        let (local, frame) = (self.local(at)?, self.frame()?);
        Some(viewport::to_unit(local, frame))
    }

    fn region_at(&self, at: Point<Pixels>) -> Option<&Listed> {
        let unit = self.unit_at(at)?;
        regions::hit(&self.comments, self.page(), unit)
    }

    fn stage_down(&mut self, e: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let Some(frame) = self.frame() else {
            return;
        };
        if self.drawing {
            if let Some(local) = self.local(e.position)
                && frame.contains(local)
            {
                let at = viewport::to_unit(local, frame);
                self.gesture = Some(Gesture::Draw { from: at, to: at });
                cx.notify();
            }
            return;
        }
        if e.click_count >= 2 {
            self.reset_zoom(cx);
            return;
        }
        if let Some(id) = self.region_at(e.position).map(|l| l.item.id.clone()) {
            self.select(&id, cx);
            return;
        }
        if self.viewport.zoomed() {
            self.gesture = Some(Gesture::Pan {
                from: e.position,
                pan: (self.viewport.pan_x, self.viewport.pan_y),
            });
            cx.notify();
        }
    }

    fn gesture_move(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        match self.gesture {
            Some(Gesture::Pan { from, pan }) => {
                let v = Viewport {
                    pan_x: pan.0 + f32::from(at.x - from.x),
                    pan_y: pan.1 + f32::from(at.y - from.y),
                    ..self.viewport
                };
                self.set_viewport(v, cx);
            }
            Some(Gesture::Draw { from, .. }) => {
                if let Some(to) = self.unit_at(at) {
                    self.gesture = Some(Gesture::Draw { from, to });
                    cx.notify();
                }
            }
            None => {}
        }
    }

    fn gesture_end(&mut self, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(gesture) = self.gesture.take() else {
            return;
        };
        cx.notify();
        if let Gesture::Draw { from, .. } = gesture {
            let to = self.unit_at(at).unwrap_or(from);
            let rect = UnitRect::between(from, to);
            if let Some(region) = rect.region(self.page()) {
                self.compose(region, at, window, cx);
            }
        }
    }

    /// The composer for a rectangle just drawn, its corner where the drag
    /// ended.
    pub fn compose(
        &mut self,
        region: dr_workspace::dto::Region,
        at: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let locale = Strings::get(cx).locale();
        let (entry_id, module_id) = self
            .info()
            .map(|m| (m.entry.clone(), m.module.clone()))
            .unwrap_or((None, None));
        let asset = self
            .info()
            .and_then(|m| m.asset.clone())
            .unwrap_or_else(|| self.id.clone());
        // An item of an entry's media module: on that entry's module. A file
        // only in the asset library: straight on the file (a region, no
        // module).
        let (target, module_id) = match (entry_id, module_id) {
            (Some(entry), Some(module)) => (
                Target {
                    kind: "entry".into(),
                    id: entry,
                },
                Some(module),
            ),
            _ => (
                Target {
                    kind: "asset".into(),
                    id: asset.clone(),
                },
                None,
            ),
        };
        let (lib, book) = (self.lib.clone(), self.book_id.clone());
        let at = point(at.x + px(8.0), at.y + px(8.0));
        let scope = self.frame_scope.clone();
        let region_for_composer = region;
        let view = cx.new(|cx| match scope {
            Some(dr_shell::FrameScope::Embed {
                entry,
                module,
                embed,
                ..
            }) => CommentComposer::for_part(
                lib,
                book,
                entry,
                module,
                dr_workspace::dto::CommentPartDto::Embed {
                    embed,
                    region: Some(region_for_composer),
                },
                at,
                locale,
                window,
                cx,
            ),
            Some(dr_shell::FrameScope::Media {
                entry,
                module,
                asset,
            }) => CommentComposer::for_region(
                lib,
                book,
                Target {
                    kind: "entry".into(),
                    id: entry,
                },
                Some(module),
                asset,
                region_for_composer,
                at,
                locale,
                window,
                cx,
            ),
            Some(dr_shell::FrameScope::Asset { asset }) => CommentComposer::for_asset(
                lib,
                book,
                asset,
                Some(region_for_composer),
                at,
                locale,
                window,
                cx,
            ),
            None => CommentComposer::for_region(
                lib,
                book,
                target,
                module_id,
                asset,
                region_for_composer,
                at,
                locale,
                window,
                cx,
            ),
        });
        let sub = cx.subscribe_in(&view, window, |page, _, e: &ComposerEvent, window, cx| {
            match e {
                ComposerEvent::Saved(id) => {
                    page.selected = Some(id.clone());
                    page.drawing = false;
                    page.frame_scope = None;
                }
                ComposerEvent::Done => {
                    page.composer = None;
                    page.pending = None;
                    window.focus(&page.focus, cx);
                }
            }
            cx.notify();
        });
        self.composer = Some((view, at, sub));
        self.pending = Some((UnitRect::of(&region), region.page));
        cx.notify();
    }

    /// Drops the composer without writing.
    pub fn close_composer(&mut self, cx: &mut Context<Self>) {
        self.pending = None;
        if self.composer.take().is_some() {
            cx.notify();
        }
    }

    fn point_at(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        let id = self.region_at(at).map(|l| l.item.id.clone());
        self.point(id, cx);
    }

    fn point(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        if self.pointed != id {
            self.pointed = id;
            cx.notify();
        }
    }

    /// Chooses a comment: its rectangle is drawn round again and its page
    /// turned to.
    pub fn select(&mut self, id: &str, cx: &mut Context<Self>) {
        let page = self
            .comments
            .iter()
            .find(|l| l.item.id == id)
            .and_then(Listed::page);
        if let Some(page) = page {
            self.turn_to(page, cx);
        }
        self.selected = Some(id.to_owned());
        cx.notify();
    }

    fn wheel(&mut self, e: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        let delta = e.delta.pixel_delta(px(16.0));
        let (dx, dy) = (f32::from(delta.x), f32::from(delta.y));
        if e.modifiers.platform || e.modifiers.control {
            self.zoom_by((dy * WHEEL_ZOOM).exp(), Some(e.position), cx);
            cx.stop_propagation();
        } else if self.viewport.zoomed() {
            self.pan_by(dx, dy, cx);
            cx.stop_propagation();
        }
    }

    fn pinch(&mut self, e: &PinchEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.zoom_by(1.0 + e.delta, Some(e.position), cx);
        cx.stop_propagation();
    }

    fn key_down(&mut self, e: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let k = &e.keystroke;
        let command = k.modifiers.platform || k.modifiers.control;
        match (k.key.as_str(), command) {
            ("left", false) if self.kind == MediaKind::Pdf => self.turn_by(-1, cx),
            ("right", false) if self.kind == MediaKind::Pdf => self.turn_by(1, cx),
            ("escape", false) if self.drawing => self.set_drawing(false, cx),
            ("=" | "+", true) => self.zoom_by(STEP, None, cx),
            ("-", true) => self.zoom_by(1.0 / STEP, None, cx),
            ("0", true) => self.reset_zoom(cx),
            _ => return,
        }
        cx.stop_propagation();
    }

    // Comments.

    fn reload_usages(&mut self, cx: &mut Context<Self>) {
        let asset = self
            .info()
            .and_then(|m| m.asset.clone())
            .unwrap_or_else(|| self.id.clone());
        let (lib, book) = (self.lib.clone(), self.book_id.clone());
        let untitled_label = t(cx, keys::common::UNTITLED).to_string();
        let task = cx.background_executor().spawn(async move {
            library_data::load_asset_usages(&lib, &book, &asset, &untitled_label)
        });
        self.usages_task = Some(cx.spawn(async move |this, cx| {
            let usages = task.await;
            this.update(cx, |page, cx| {
                page.usages = usages;
                page.usages_task = None;
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn jump_to_usage(&mut self, usage: &ResolvedUsage, cx: &mut Context<Self>) {
        let Ok(id) = usage.entry_id.parse() else {
            return;
        };
        let module = usage.module_id.as_deref().and_then(|m| m.parse().ok());
        UsageFlash::trigger(usage.flash_keys.clone(), cx);
        if let Some(ws) = self.workspace.upgrade() {
            ws.update(cx, |ws, cx| {
                ws.super_view = None;
                ws.open(NavTarget::Entry { id, module }, Open::KEEP, cx);
            });
        }
    }

    fn reload_comments(&mut self, cx: &mut Context<Self>) {
        let id = self
            .info()
            .and_then(|m| m.asset.clone())
            .unwrap_or_else(|| self.id.clone());
        let place = self
            .info()
            .and_then(|m| m.entry.clone().zip(m.module.clone()));
        let (lib, book) = (self.lib.clone(), self.book_id.clone());
        let task = cx.background_executor().spawn(async move {
            dr_view_review::v3::load(&lib, &book)
                .map(|snapshot| {
                    let cards: Vec<_> = snapshot.items.iter().map(|i| i.card()).collect();
                    if let Some((e, m)) = &place {
                        regions::listed(&cards, &id, Some((e.as_str(), m.as_str())))
                    } else {
                        let embed_assets = matching_embed_assets(&lib, &cards, &id);
                        regions::listed_for_asset_library(&cards, &id, &embed_assets)
                    }
                })
                .unwrap_or_default()
        });
        self.reloading = Some(cx.spawn(async move |this, cx| {
            let comments = task.await;
            this.update(cx, |page, cx| {
                page.comments = comments;
                page.reloading = None;
                cx.notify();
            })
            .ok();
        }));
    }

    fn set_done(&mut self, id: &str, done: bool, cx: &mut Context<Self>) {
        let input = CommentUpdateIn {
            book: self.book_id.clone(),
            id: id.to_owned(),
            status: Some(if done { "resolved" } else { "open" }.into()),
            ..Default::default()
        };
        let lib = self.lib.clone();
        cx.background_executor()
            .spawn(async move {
                if let Err(e) = lib.run::<CommentUpdate>(&Actor::User, input) {
                    log::warn!("material: comment.update: {e}");
                }
            })
            .detach();
    }

    // Drawing the page.

    fn head(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let has_description = self
            .info()
            .is_some_and(|m| m.entry.is_some() && m.module.is_some());
        let this = cx.entity();
        let usages_row = (!self.usages.is_empty()).then(|| {
            let mut row = div()
                .id("material-page-usages")
                .pt(px(4.0))
                .flex()
                .flex_row()
                .flex_wrap()
                .items_center()
                .gap(px(6.0))
                .child(
                    div()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.ink(4).solid())
                        .child(t(cx, keys::v5_files::USED_IN)),
                );
            for (i, u) in self.usages.iter().cloned().enumerate() {
                let jump = this.clone();
                let (mark_kind, mark_color) = u
                    .entry_id
                    .parse()
                    .ok()
                    .map(|eid| {
                        self.book.mark(&NavTarget::Entry {
                            id: eid,
                            module: None,
                        })
                    })
                    .unwrap_or_else(|| {
                        let k = if u.is_chapter {
                            sand::Kind::Chapter(dr_shell::book::seal_of(&u.entry_id))
                        } else {
                            sand::Kind::Element
                        };
                        (
                            k,
                            u.entry_color.as_deref().and_then(dr_shell::book::color_of),
                        )
                    });
                let mark = match mark_color {
                    Some(c) => KindMark::new(("material-usage-mark", i), mark_kind).color(c),
                    None => KindMark::new(("material-usage-mark", i), mark_kind),
                };
                let module_name = u.module_name.clone();
                let entry_title = u.entry_title.clone();
                row = row.child(
                    div()
                        .id(("material-page-usage", i))
                        .h(px(24.0))
                        .px(px(8.0))
                        .rounded(px(999.0))
                        .border_1()
                        .border_color(p.hairline())
                        .bg(p.page.alpha(0.65))
                        .hover(move |st| st.bg(p.page.solid()).border_color(p.ink(3).alpha(0.35)))
                        .cursor_pointer()
                        .role(gpui::Role::Button)
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(5.0))
                        .child(mark)
                        .child(
                            div()
                                .font_role(Role::Ui)
                                .type_px(s.caption, s.line_caption)
                                .text_color(p.ink(2).solid())
                                .child(entry_title),
                        )
                        .when(!module_name.is_empty(), |d| {
                            d.child(
                                div()
                                    .font_role(Role::Index)
                                    .type_px(s.caption - 0.5, s.line_caption)
                                    .text_color(p.ink(4).solid())
                                    .child(format!("· {module_name}")),
                            )
                        })
                        .on_click(move |_, _, cx| {
                            let u = u.clone();
                            jump.update(cx, |p, cx| p.jump_to_usage(&u, cx));
                        }),
                );
            }
            row
        });
        div()
            .flex_none()
            .px(px(28.0))
            .pt(px(dr_shell::workspace::TITLEBAR_HEIGHT + 12.0))
            .pb(px(6.0))
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(
                div()
                    .font_role(Role::Prose)
                    .type_px(26.0, 34.0)
                    .weight(weight::MEDIUM)
                    .text_color(p.ink(1).solid())
                    .child(self.title.clone()),
            )
            .when(has_description, |d| {
                d.child(
                    div()
                        .max_w(px(560.0))
                        .font_role(Role::Prose)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.ink(2).solid())
                        .child(self.description.clone()),
                )
            })
            .children(usages_row)
            .children(
                (self.title_error.is_some() || self.description_error.is_some()).then(|| {
                    div()
                        .text_color(p.danger.solid())
                        .child(t(cx, keys::common::SAVE_FAILED))
                }),
            )
    }

    fn toolbar(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let this = cx.entity();
        let (draw, out, reset, zin) = (this.clone(), this.clone(), this.clone(), this.clone());
        let drawing = self.drawing;
        let label = if drawing {
            keys::material_editor::regions::STOP_DRAWING
        } else {
            keys::material_editor::regions::DRAW
        };
        let percent = format!("{}%", (self.viewport.scale * 100.0).round());
        let pill = glass::glass_box(
            "material-toolbar",
            GlassKind::Surface,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, (g::PILL_HEIGHT + 2.0 * g::TRAY_PADDING) / 2.0).filled(p.page),
            window,
            cx,
        )
        .occlude()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(2.0))
        .p(px(g::TRAY_PADDING))
        .rounded(px((g::PILL_HEIGHT + 2.0 * g::TRAY_PADDING) / 2.0))
        .bg(p.page.solid())
        .child(
            IconButton::new("material-draw", Icon::CommentPlus)
                .in_tray()
                .selected(drawing)
                .label(t(cx, label))
                .on_click(move |_, _, cx| draw.update(cx, |p, cx| p.set_drawing(!p.drawing, cx))),
        )
        .child(
            IconButton::new("material-zoom-out", Icon::Minus)
                .in_tray()
                .label(t(cx, keys::material_editor::ZOOM_OUT))
                .on_click(move |_, _, cx| out.update(cx, |p, cx| p.zoom_by(1.0 / STEP, None, cx))),
        )
        .child(
            div()
                .id("material-zoom-reset")
                .min_w(px(46.0))
                .h(px(g::ROUND))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.ink(2).solid())
                .role(gpui::Role::Button)
                .aria_label(t(cx, keys::material_editor::ZOOM_RESET))
                .child(percent)
                .on_click(move |_: &ClickEvent, _, cx| reset.update(cx, |p, cx| p.reset_zoom(cx))),
        )
        .child(
            IconButton::new("material-zoom-in", Icon::Plus)
                .in_tray()
                .label(t(cx, keys::material_editor::ZOOM_IN))
                .on_click(move |_, _, cx| zin.update(cx, |p, cx| p.zoom_by(STEP, None, cx))),
        );
        div()
            .absolute()
            .top(px(12.0))
            .right(px(14.0))
            .flex()
            .flex_col()
            .items_end()
            .gap(px(6.0))
            .child(pill)
            .when(drawing, |d| {
                d.child(
                    div()
                        .pr(px(6.0))
                        .font_role(Role::Ui)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.muted().solid())
                        .child(t(cx, keys::material_editor::regions::DRAW_HINT)),
                )
            })
    }

    fn pager(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (page, count) = (self.page()?, self.page_count());
        if count <= 1 {
            return None;
        }
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let this = cx.entity();
        let (back, on) = (this.clone(), this);
        let pill = glass::glass_box(
            "material-pager",
            GlassKind::Surface,
            Mode::default(),
            false,
            Spec::new(Tone::Clear, (g::PILL_HEIGHT + 2.0 * g::TRAY_PADDING) / 2.0).filled(p.page),
            window,
            cx,
        )
        .occlude()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(2.0))
        .p(px(g::TRAY_PADDING))
        .rounded(px((g::PILL_HEIGHT + 2.0 * g::TRAY_PADDING) / 2.0))
        .bg(p.page.solid())
        .child(
            IconButton::new("material-page-back", Icon::ChevronLeft)
                .in_tray()
                .disabled(page <= 1)
                .label(t(cx, keys::memo_material::preview::PREVIOUS_PAGE))
                .on_click(move |_, _, cx| back.update(cx, |p, cx| p.turn_by(-1, cx))),
        )
        .child(
            div()
                .min_w(px(44.0))
                .flex()
                .justify_center()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.ink(2).solid())
                .child(format!("{page} / {count}")),
        )
        .child(
            IconButton::new("material-page-on", Icon::ChevronRight)
                .in_tray()
                .disabled(page as usize >= count)
                .label(t(cx, keys::memo_material::preview::NEXT_PAGE))
                .on_click(move |_, _, cx| on.update(cx, |p, cx| p.turn_by(1, cx))),
        );
        Some(
            div()
                .absolute()
                .bottom(px(16.0))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(pill)
                .into_any_element(),
        )
    }

    /// The line on the stage while there is no picture.
    fn message(&self, cx: &App) -> Option<SharedString> {
        use keys::memo_material::preview as k;
        let pdf = self.kind == MediaKind::Pdf;
        Some(match &self.media {
            Media::Loading if pdf => t(cx, k::LOADING_PDF),
            Media::Loading => t(cx, k::LOADING),
            Media::Trouble(Trouble::OpenPdf(_)) => t(cx, k::OPEN_PDF_FAILED),
            Media::Trouble(Trouble::RenderPdf(_)) => t(cx, k::RENDER_PDF_FAILED),
            Media::Trouble(_) if pdf => t(cx, k::NO_PDF),
            Media::Trouble(_) => t(cx, k::NO_IMAGE),
            _ => return None,
        })
    }

    /// The picture as it is drawn now: the bitmap, if any (a PDF page not
    /// rendered yet shows white paper).
    fn bitmap(&self) -> Option<Picture> {
        match &self.media {
            Media::Image(p) => Some(p.clone()),
            Media::Pdf {
                page,
                shown: Some((p, _, picture)),
                ..
            } if p == page => Some(picture.clone()),
            _ => None,
        }
    }

    fn stage(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let this = cx.entity();
        let measure = this.clone();
        let (moves, ups) = (this.clone(), this.clone());
        // The stage is measured as it is laid out; its size fits the
        // picture on the next frame.
        let probe = canvas(
            move |bounds, _, cx| {
                measure.update(cx, |page, cx| {
                    let resized = page.stage.is_some_and(|old| old.size != bounds.size);
                    if page.stage != Some(bounds) {
                        page.stage = Some(bounds);
                        if resized {
                            page.rendering = None;
                            if let Media::Pdf {
                                shown: Some((_, scale, _)),
                                ..
                            } = &mut page.media
                            {
                                *scale = 0.0;
                            }
                        }
                        cx.notify();
                    }
                });
            },
            move |_, _, window, _| {
                // Install before mouse-down: a full drag can arrive in one
                // frame. Inactive gestures are no-ops; active ones continue
                // outside the stage.
                let moves = moves.clone();
                window.on_mouse_event(move |e: &MouseMoveEvent, phase, _, cx| {
                    if phase == DispatchPhase::Bubble {
                        moves.update(cx, |page, cx| page.gesture_move(e.position, cx));
                    }
                });
                let ups = ups.clone();
                window.on_mouse_event(move |e: &MouseUpEvent, phase, window, cx| {
                    if phase == DispatchPhase::Bubble && e.button == MouseButton::Left {
                        ups.update(cx, |page, cx| page.gesture_end(e.position, window, cx));
                    }
                });
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();

        let cursor = match self.gesture {
            _ if self.drawing => CursorStyle::Crosshair,
            Some(Gesture::Pan { .. }) => CursorStyle::ClosedHand,
            _ if self.pointed.is_some() => CursorStyle::PointingHand,
            _ if self.viewport.zoomed() => CursorStyle::OpenHand,
            _ => CursorStyle::Arrow,
        };
        let mut stage = div()
            .id("material-stage")
            .relative()
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_hidden()
            .cursor(cursor)
            .on_mouse_down(MouseButton::Left, cx.listener(Self::stage_down))
            .on_mouse_move(cx.listener(|page, e: &MouseMoveEvent, _, cx| {
                if page.gesture.is_none() {
                    page.point_at(e.position, cx);
                }
            }))
            .on_hover(cx.listener(|page, hovered: &bool, _, cx| {
                if !hovered && page.gesture.is_none() {
                    page.point(None, cx);
                }
            }))
            .on_scroll(cx.listener(Self::wheel))
            .on_pinch(cx.listener(Self::pinch))
            .child(probe);

        if let Some(frame) = self.frame() {
            let (edge, fall) = p.page_shadow;
            let shadow = vec![
                BoxShadow {
                    color: p.shadow_ink.alpha(edge),
                    offset: point(px(0.0), px(0.0)),
                    blur_radius: px(0.0),
                    spread_radius: px(1.0),
                    inset: false,
                },
                BoxShadow {
                    color: p.shadow_ink.alpha(fall),
                    offset: point(px(0.0), px(2.0)),
                    blur_radius: px(14.0),
                    spread_radius: px(0.0),
                    inset: false,
                },
            ];
            let mut sheet = div()
                .absolute()
                .left(px(frame.x))
                .top(px(frame.y))
                .w(px(frame.w))
                .h(px(frame.h))
                .rounded(px(radius::SM))
                .shadow(shadow)
                .when(self.kind == MediaKind::Pdf, |d| d.bg(gpui::white()));
            if let Some(picture) = self.bitmap() {
                sheet = sheet.child(img(picture.image).size_full().rounded(px(radius::SM)));
            }
            stage = stage.child(sheet);
            stage = stage.children(self.marks(frame, window, cx));
            // The rectangle being dragged out, or being written about.
            let draft = match (self.gesture, &self.pending) {
                (Some(Gesture::Draw { from, to }), _) => Some(UnitRect::between(from, to)),
                (_, Some((r, page))) if *page == self.page() => Some(*r),
                _ => None,
            };
            if let Some(r) = draft {
                let c = kind_color(&theme, false);
                stage = stage.child(
                    div()
                        .absolute()
                        .left(px(frame.x + r.x * frame.w))
                        .top(px(frame.y + r.y * frame.h))
                        .w(px(r.w * frame.w))
                        .h(px(r.h * frame.h))
                        .border_1()
                        .border_dashed()
                        .border_color(c.alpha(0.7))
                        .bg(c.alpha(0.08)),
                );
            }
        }
        if let Some(line) = self.message(cx) {
            stage = stage.child(
                div()
                    .absolute()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .font_role(Role::Ui)
                    .type_px(s.body, s.line_body)
                    .text_color(p.ink(3).solid())
                    .child(line),
            );
        }
        stage
            .child(self.toolbar(window, cx))
            .children(self.pager(window, cx))
    }

    /// The rectangles of the comments on the picture shown, each a dry
    /// frame with its number on a seal.
    fn marks(&self, frame: Frame, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let page = self.page();
        self.comments
            .iter()
            .filter(|l| l.region().is_some_and(|r| r.page == page))
            .map(|l| {
                let r = UnitRect::of(l.region().expect("filtered"));
                let id = &l.item.id;
                let selected = self.selected.as_deref() == Some(id);
                let pointed = self.pointed.as_deref() == Some(id);
                let rest = match (l.resolved(), pointed) {
                    (false, false) => 0.5,
                    (false, true) => 0.8,
                    (true, false) => 0.28,
                    (true, true) => 0.5,
                };
                let color = kind_color(&theme, l.todo());
                div()
                    .absolute()
                    .left(px(frame.x + r.x * frame.w))
                    .top(px(frame.y + r.y * frame.h))
                    .w(px(r.w * frame.w))
                    .h(px(r.h * frame.h))
                    .child(
                        SandFrame::new(
                            ElementId::Name(format!("material-region-{id}").into()),
                            selected,
                        )
                        .color(color)
                        .rest(rest)
                        .seed(seed_of(id)),
                    )
                    .child(div().absolute().top(px(-9.0)).left(px(-9.0)).child(seal(
                        l.number,
                        color,
                        l.resolved(),
                        p.page,
                    )))
                    .into_any_element()
            })
            .collect()
    }

    fn column(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let mut list = div()
            .id("material-comments")
            .role(gpui::Role::List)
            .aria_label(t(cx, keys::material_editor::regions::LIST_LABEL))
            .w(px(COLUMN_WIDTH))
            .flex_none()
            .h_full()
            .overflow_y_scroll()
            .p(px(10.0))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .border_l_1()
            .border_color(p.local_hairline());
        if self.comments.is_empty() {
            list = list.child(
                div()
                    .px(px(4.0))
                    .py(px(12.0))
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, keys::material_editor::regions::EMPTY)),
            );
            return list;
        }
        let is_asset_library = self.info().and_then(|m| m.entry.as_ref()).is_none();
        if !is_asset_library {
            for l in &self.comments {
                list = list.child(self.card(l, window, cx));
            }
            return list;
        }
        let mut direct_items = Vec::new();
        let mut entry_groups: Vec<(String, Vec<&Listed>)> = Vec::new();
        for l in &self.comments {
            match l.asset_place() {
                regions::AssetPlace::Direct => direct_items.push(l),
                regions::AssetPlace::Media { entry, .. }
                | regions::AssetPlace::Embed { entry, .. } => {
                    if let Some((_, bucket)) = entry_groups.iter_mut().find(|(e, _)| e == &entry) {
                        bucket.push(l);
                    } else {
                        entry_groups.push((entry, vec![l]));
                    }
                }
            }
        }
        if !direct_items.is_empty() {
            list = list.child(self.file_header(window, cx));
            for l in direct_items {
                list = list.child(self.card(l, window, cx));
            }
        }
        for (entry, bucket) in entry_groups {
            list = list.child(self.entry_header(&entry, window, cx));
            for l in bucket {
                list = list.child(self.card(l, window, cx));
            }
        }
        list
    }

    fn file_title(&self, cx: &App) -> String {
        self.info()
            .map(|m| m.title.trim().to_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| t(cx, keys::common::UNTITLED).to_string())
    }

    fn file_header(&self, window: &Window, cx: &App) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let icon = match self.kind {
            MediaKind::Pdf => Icon::FileText,
            MediaKind::Image => Icon::Image,
        };
        div()
            .px(px(4.0))
            .pt(px(2.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .child(dr_ui::sand::icon(icon, 13.0, p.ink(3).solid()))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .font_role(Role::Structure)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(2).solid())
                    .child(self.file_title(cx)),
            )
            .into_any_element()
    }

    fn entry_header(&self, entry: &str, window: &Window, cx: &App) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let nav_target = dr_shell::nav::Target::from_key(&format!("entry:{entry}"));
        let (mark, color) = nav_target
            .as_ref()
            .map(|t| self.book.mark(t))
            .unwrap_or((dr_ui::sand::Kind::Element, None));
        let mut kind_mark = dr_ui::sand::KindMark::new(
            ElementId::Name(format!("material-place-mark-{entry}").into()),
            mark,
        );
        if let Some(c) = color {
            kind_mark = kind_mark.color(c);
        }
        let entry_title = self
            .book
            .v3()
            .and_then(|b| b.entry(entry))
            .map(|e| e.title.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| t(cx, keys::common::UNTITLED).to_string());
        div()
            .px(px(4.0))
            .pt(px(4.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .child(kind_mark)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .font_role(Role::Structure)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(2).solid())
                    .child(entry_title),
            )
            .into_any_element()
    }

    /// Formats the sub-place label shown on comment card `l` (`整个文件`, `第 2 页`,
    /// or `模块 · 文件名`).
    pub fn comment_where(&self, l: &Listed, cx: &App) -> SharedString {
        let region_label = match l.page() {
            Some(page) => {
                Some(tf(cx, keys::v3_review::REGION_PLACE_PAGED, &[("page", &page)]).to_string())
            }
            None if l.region().is_some() => Some(t(cx, keys::v3_review::REGION_PLACE).to_string()),
            None => None,
        };
        match l.asset_place() {
            regions::AssetPlace::Direct => match region_label {
                Some(r) => r.into(),
                None => t(cx, keys::v3_review::WHOLE_FILE),
            },
            regions::AssetPlace::Media { entry, module }
            | regions::AssetPlace::Embed { entry, module, .. } => {
                let mod_name = self
                    .book
                    .v3()
                    .and_then(|b| b.template_of(&entry))
                    .and_then(|tpl| tpl.modules.iter().find(|m| m.id == module))
                    .map(|m| m.name.trim().to_owned())
                    .filter(|s| !s.is_empty());
                let file_name = self
                    .info()
                    .map(|m| m.title.trim().to_owned())
                    .filter(|s| !s.is_empty());
                let mut parts = Vec::new();
                if let Some(m) = mod_name {
                    parts.push(m);
                }
                if let Some(f) = file_name {
                    parts.push(f);
                }
                if let Some(r) = region_label {
                    parts.push(r);
                }
                parts.join(" · ").into()
            }
        }
    }

    /// Navigation target when jumping from comment `l`'s `→` arrow (`None` for
    /// comments directly on this standalone file).
    pub fn jump_target(&self, l: &Listed) -> Option<dr_shell::nav::Target> {
        match l.asset_place() {
            regions::AssetPlace::Direct => None,
            regions::AssetPlace::Media { entry, module }
            | regions::AssetPlace::Embed { entry, module, .. } => {
                dr_shell::nav::Target::from_key(&format!("entry:{entry}/{module}"))
            }
        }
    }

    /// Navigates to comment `id`'s entry/module place and triggers its sand
    /// highlight, leaving the Review sidebar untouched (`v5-tracks.md:457`).
    pub fn jump_comment(
        &mut self,
        id: &str,
        cx: &mut Context<Self>,
    ) -> Option<dr_shell::nav::Target> {
        let l = self.comments.iter().find(|c| c.item.id == id)?;
        let target = self.jump_target(l)?;
        dr_view_review::ReviewFocus::jump(id, cx);
        if let Some(ws) = self.workspace.upgrade() {
            let nav_target = target.clone();
            ws.update(cx, |ws, cx| {
                ws.super_view = None;
                ws.open(nav_target, dr_shell::nav::Open::KEEP, cx);
            });
        }
        Some(target)
    }

    fn card(&self, l: &Listed, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let id = l.item.id.clone();
        let eid = |part: &str| ElementId::Name(format!("material-card-{part}-{id}").into());
        let todo = l.todo();
        let done = l.resolved();
        let color = kind_color(&theme, todo);
        let lit = self.selected.as_deref() == Some(id.as_str())
            || self.pointed.as_deref() == Some(id.as_str());
        let place = self.comment_where(l, cx);
        let origin_word: Option<SharedString> = match l.item.origin.as_str() {
            "marker" => Some(t(cx, keys::v3_review::ORIGIN_MARKER)),
            "task" => Some(t(cx, keys::v3_review::ORIGIN_TASK)),
            "agent" => Some(t(cx, keys::v3_review::ORIGIN_AGENT)),
            "reader" => match l
                .item
                .author_name
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty())
            {
                Some(name) => {
                    Some(format!("{} · {name}", t(cx, keys::v3_review::ORIGIN_READER)).into())
                }
                None => Some(t(cx, keys::v3_review::ORIGIN_READER)),
            },
            _ => None,
        };
        let this = cx.entity();
        let (toggle, choose, hover, jump_this) = (this.clone(), this.clone(), this.clone(), this);
        let (c1, c2, c3, c_jump) = (id.clone(), id.clone(), id.clone(), id.clone());
        let status = if done {
            keys::comment_rail::actions::REOPEN
        } else {
            keys::comment_rail::actions::RESOLVE
        };
        let body: SharedString = if l.item.body.text.trim().is_empty() {
            t(cx, keys::comment_rail::card::EMPTY_COMMENT)
        } else {
            l.item.body.text.clone().into()
        };
        let jump_btn = self.jump_target(l).map(|_| {
            let label = t(cx, keys::v3_review::JUMP_TO_PLACE);
            div()
                .id(eid("jump"))
                .size(px(20.0))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(3.0))
                .cursor_pointer()
                .role(gpui::Role::Button)
                .aria_label(label)
                .hover(|st| st.bg(p.ink(1).alpha(0.05)))
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    let _ = jump_this.update(cx, |pg, cx| pg.jump_comment(&c_jump, cx));
                })
                .child(dr_ui::sand::icon(
                    Icon::ArrowForward,
                    12.0,
                    p.ink(3).solid(),
                ))
        });
        let ring_group: SharedString = format!("media-ring-{}", id).into();
        let status_label = t(cx, status);
        let ring = glass::glass_box(
            eid("status"),
            GlassKind::Surface,
            Mode::default(),
            done,
            Spec::new(Tone::Clear, 10.0),
            window,
            cx,
        )
        .group(ring_group.clone())
        .size(px(20.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .cursor_pointer()
        .role(gpui::Role::Button)
        .aria_label(status_label)
        .on_click(move |_, _, cx| {
            cx.stop_propagation();
            toggle.update(cx, |p, cx| p.set_done(&c1, !done, cx));
        })
        .child(
            div()
                .flex()
                .items_center()
                .justify_center()
                .when(!done, |d| {
                    d.opacity(0.0).group_hover(ring_group, |st| st.opacity(1.0))
                })
                .child(dr_ui::sand::icon(
                    Icon::Check,
                    11.0,
                    if done { p.ink(1) } else { p.ink(3) }.solid(),
                )),
        );
        let head = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .children(
                l.region()
                    .is_some()
                    .then(|| seal(l.number, color, done, p.page)),
            )
            .children(origin_word.map(|w| {
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(3).solid())
                    .child(w)
            }))
            .child(div().flex_1())
            .children(jump_btn)
            .child(ring);
        let where_row = (!place.is_empty()).then(|| {
            div()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.ink(3).solid())
                .child(place)
        });
        div()
            .id(eid("wrap"))
            .w_full()
            .on_hover(move |hovered: &bool, _, cx| {
                let id = hovered.then(|| c3.clone());
                hover.update(cx, |p, cx| p.point(id, cx));
            })
            .on_click(move |_: &ClickEvent, _, cx| {
                choose.update(cx, |p, cx| p.select(&c2, cx));
            })
            .child(
                glass::glass_box(
                    eid("card"),
                    GlassKind::Surface,
                    Mode::default(),
                    lit,
                    Spec::new(Tone::Clear, radius::MD),
                    window,
                    cx,
                )
                .w_full()
                .p(px(10.0))
                .flex()
                .flex_col()
                .gap(px(4.0))
                .when(done, |d| d.opacity(0.55))
                .child(head)
                .children(where_row)
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.ink(1).solid())
                        .child(body),
                ),
            )
            .into_any_element()
    }
}

/// A comment's number on a sand seal (`.material-seal`): the paper's colour
/// on a blob of its sand.
fn seal(number: usize, color: Rgb, faded: bool, paper: Rgb) -> impl IntoElement {
    // Its own colour, not lifted for the dark desk: a seal sits on the
    // picture as often as on the desk.
    div()
        .relative()
        .min_w(px(18.0))
        .h(px(18.0))
        .px(px(4.0))
        .flex()
        .items_center()
        .justify_center()
        .when(faded, |d| d.opacity(0.5))
        .child(
            gpui::svg()
                .absolute()
                .top(px(-2.0))
                .left(px(-1.0))
                .right(px(-1.0))
                .bottom(px(-2.0))
                .path(SandMask::Blob2.shared_path())
                .text_color(color.alpha(0.9)),
        )
        .child(
            div()
                .relative()
                .font_role(Role::Index)
                .type_px(10.5, 18.0)
                .weight(weight::SEMIBOLD)
                .text_color(paper.solid())
                .child(number.to_string()),
        )
}

fn matching_embed_assets(
    lib: &Library,
    cards: &[dr_workspace::dto::CommentInfo],
    want_asset: &str,
) -> std::collections::HashSet<(String, String, String)> {
    let mut pairs = std::collections::HashSet::new();
    for c in cards {
        if let (Some(t), Some(module), Some(dr_workspace::dto::CommentPartDto::Embed { .. })) =
            (&c.target, &c.module, &c.part)
            && t.kind == "entry"
        {
            pairs.insert((t.id.clone(), module.clone()));
        }
    }
    let mut out = std::collections::HashSet::new();
    for (entry, module) in pairs {
        let Ok(eid) = dr_model::id::EntryId::parse(&entry) else {
            continue;
        };
        let Ok(mid) = dr_model::id::ModuleId::parse(&module) else {
            continue;
        };
        let doc_id = dr_model::DocId::Body(dr_model::id::BodyDocId::new(eid, mid));
        let name = doc_id.to_string();
        if lib.library().doc_info(&name).ok().flatten().is_none() {
            continue;
        }
        let Ok(handle) = lib.library().open_doc(&name, dr_store::OpenDoc::Existing) else {
            continue;
        };
        let want = want_asset.to_owned();
        if let Ok(found) = handle.read(move |doc| {
            let mut hits = Vec::new();
            if let Ok(prose) = dr_doc::prose::BorrowedProse::new(doc, &doc_id) {
                let pv = prose.view();
                for (_, em_id) in pv.embed_refs() {
                    if let Some(dr_doc::prose::EmbedView::Asset {
                        asset: Some(aid), ..
                    }) = pv.embed(&em_id)
                        && aid.as_str() == want
                    {
                        hits.push((entry.clone(), module.clone(), em_id.to_string()));
                    }
                }
            }
            hits
        }) {
            out.extend(found);
        }
    }
    out
}

impl Render for MediaPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.consume_frame_intent(cx);
        self.keep_rendered(window, cx);
        let column = !self.comments.is_empty() || self.drawing;
        let composer = self.composer.as_ref().map(|(view, at, _)| {
            deferred(
                anchored()
                    .position(*at)
                    .snap_to_window_with_margin(px(12.0))
                    .child(view.clone()),
            )
        });
        div()
            .id(ElementId::Name(format!("material-page-{}", self.id).into()))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::key_down))
            .size_full()
            .flex()
            .flex_col()
            .child(self.head(window, cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_row()
                    .child(self.stage(window, cx))
                    .when(column, |d| d.child(self.column(window, cx))),
            )
            .children(composer)
    }
}
