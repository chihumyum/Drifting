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

use dr_doc::book::Collection;
use dr_i18n::keys;
use dr_shell::book::Book;
use dr_shell::pages::PageViewHost;
use dr_shell::strings::{Strings, tf};
use dr_shell::{Workspace, t};
use dr_ui::Theme;
use dr_ui::components::{Button, IconButton};
use dr_ui::fonts::{Role, weight};
use dr_ui::glass::{self, Kind as GlassKind, Mode, Spec, Tone};
use dr_ui::input::{FieldEvent, TextArea};
use dr_ui::sand::{Icon, SandFrame, SandMask};
use dr_ui::style::DrStyled;
use dr_ui::tokens::color::Rgb;
use dr_ui::tokens::{Story, glass as g, radius};
use dr_view_review::{CommentComposer, ComposerEvent};
use dr_workspace::commands::comment::{CommentList, CommentListIn, CommentUpdate, CommentUpdateIn};
use dr_workspace::commands::material::{MaterialUpdate, MaterialUpdateIn};
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
    /// The asset the picture was read from.
    asset: Option<String>,
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
            selected: None,
            pointed: None,
            comments: Vec::new(),
            composer: None,
            pending: None,
            title,
            description,
            shown_title: None,
            shown_description: None,
            asset: None,
            loading: None,
            rendering: None,
            reloading: None,
            _library: None,
            _subs: Vec::new(),
        };
        page.subscribe(window, cx);
        page.sync_fields(window, cx);
        page.load(cx);
        page.reload_comments(cx);
        page
    }

    /// The material's id.
    pub fn material(&self) -> &str {
        &self.id
    }

    pub fn kind(&self) -> MediaKind {
        self.kind
    }

    fn info(&self) -> Option<&dr_workspace::dto::MaterialInfo> {
        self.book.materials.iter().find(|m| m.id == self.id)
    }

    fn subscribe(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let title = cx.subscribe_in(&self.title, window, |page, field, e, window, cx| match e {
            FieldEvent::Submitted(_) => window.focus(&page.focus, cx),
            FieldEvent::Cancelled => {
                let stored = page.info().map(|m| m.title.clone()).unwrap_or_default();
                field.update(cx, |f, cx| f.set_text(stored, cx));
                window.focus(&page.focus, cx);
            }
            FieldEvent::Blurred => {
                let text = field.read(cx).text();
                page.save_title(text, cx);
            }
            FieldEvent::Changed(_) => {}
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
                    window.focus(&page.focus, cx);
                }
                FieldEvent::Blurred => {
                    let text = field.read(cx).text();
                    page.save_description(text, cx);
                }
                FieldEvent::Changed(_) => {}
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
                        cx.notify();
                    }
                }));
        }
        // Comments change on F3's bus.
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        let book = self.book_id.clone();
        self._library = Some(self.lib.subscribe(move |e| {
            if let WsEvent::Book(b) = e
                && b.book.as_str() == book
                && b.changes
                    .iter()
                    .any(|c| c.collection == Collection::Comments)
            {
                let _ = tx.unbounded_send(());
            }
        }));
        cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                while rx.try_recv().is_ok() {}
                if this
                    .update(cx, |page, cx| page.reload_comments(cx))
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
        if self.shown_title.as_deref() != Some(m.title.as_str()) && !typing(&self.title, window, cx)
        {
            self.title
                .update(cx, |f, cx| f.set_text(m.title.clone(), cx));
            self.shown_title = Some(m.title.clone());
        }
        if self.shown_description.as_deref() != Some(m.description.as_str())
            && !typing(&self.description, window, cx)
        {
            self.description
                .update(cx, |f, cx| f.set_text(m.description.clone(), cx));
            self.shown_description = Some(m.description.clone());
        }
    }

    fn update_material(&mut self, input: MaterialUpdateIn, cx: &mut Context<Self>) {
        let lib = self.lib.clone();
        cx.background_executor()
            .spawn(async move {
                if let Err(e) = lib.run::<MaterialUpdate>(&Actor::User, input) {
                    log::warn!("material: material.update: {e}");
                }
            })
            .detach();
    }

    fn save_title(&mut self, text: String, cx: &mut Context<Self>) {
        let title = text.trim().to_owned();
        let stored = self.info().map(|m| m.title.clone()).unwrap_or_default();
        if title.is_empty() || title == stored {
            return;
        }
        self.shown_title = Some(title.clone());
        let input = MaterialUpdateIn {
            book: self.book_id.clone(),
            id: self.id.clone(),
            title: Some(title),
            ..Default::default()
        };
        self.update_material(input, cx);
    }

    fn save_description(&mut self, text: String, cx: &mut Context<Self>) {
        let stored = self
            .info()
            .map(|m| m.description.clone())
            .unwrap_or_default();
        if text.trim() == stored.trim() {
            return;
        }
        self.shown_description = Some(text.clone());
        let input = MaterialUpdateIn {
            book: self.book_id.clone(),
            id: self.id.clone(),
            description: Some(text),
            ..Default::default()
        };
        self.update_material(input, cx);
    }

    // The picture.

    /// Reads and decodes the picture (an image) or opens the PDF, off the
    /// main thread.
    fn load(&mut self, cx: &mut Context<Self>) {
        self.asset = self.info().and_then(|m| m.asset.clone());
        let Some(asset) = self.asset.clone() else {
            self.media = Media::Trouble(Trouble::Missing);
            return;
        };
        self.media = Media::Loading;
        self.rendering = None;
        let (lib, kind) = (self.lib.clone(), self.kind);
        let task = cx.background_executor().spawn(async move {
            let store = lib.library();
            match kind {
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
            }
        });
        self.loading = Some(cx.spawn(async move |this, cx| {
            let media = task.await;
            this.update(cx, |page, cx| {
                page.media = media.unwrap_or_else(Media::Trouble);
                page.viewport = Viewport::FIT;
                page.loading = None;
                cx.notify();
            })
            .ok();
        }));
    }

    /// Whether the picture is there to draw on.
    pub fn ready(&self) -> bool {
        match &self.media {
            Media::Image(_) => true,
            Media::Pdf { shown, page, .. } => shown.as_ref().is_some_and(|s| s.0 == *page),
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
        // A new page renders at once; a new zoom after the gesture rests.
        let wait = if shown.as_ref().is_some_and(|(p, _, _)| *p == page) {
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
            if !on && matches!(self.gesture, Some(Gesture::Draw { .. })) {
                self.gesture = None;
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
        let target = Target {
            kind: "material".into(),
            id: self.id.clone(),
        };
        let (lib, book) = (self.lib.clone(), self.book_id.clone());
        let at = point(at.x + px(8.0), at.y + px(8.0));
        let view = cx.new(|cx| {
            CommentComposer::for_region(lib, book, target, region, at, locale, window, cx)
        });
        let sub = cx.subscribe_in(&view, window, |page, _, e: &ComposerEvent, window, cx| {
            match e {
                ComposerEvent::Saved(id) => {
                    page.selected = Some(id.clone());
                    page.drawing = false;
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

    fn reload_comments(&mut self, cx: &mut Context<Self>) {
        let (lib, book, id) = (self.lib.clone(), self.book_id.clone(), self.id.clone());
        let task = cx.background_executor().spawn(async move {
            let input = CommentListIn {
                book,
                target: Some(Target {
                    kind: "material".into(),
                    id: id.clone(),
                }),
                ..Default::default()
            };
            lib.run::<CommentList>(&Actor::User, input)
                .map(|o| regions::listed(&o.output, &id))
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
        div()
            .flex_none()
            .px(px(28.0))
            .pt(px(20.0))
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
            .child(
                div()
                    .max_w(px(560.0))
                    .font_role(Role::Prose)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(2).solid())
                    .child(self.description.clone()),
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
        let gesture = self.gesture.is_some();
        let (moves, ups) = (this.clone(), this.clone());
        // The stage is measured as it is laid out; its size fits the
        // picture on the next frame.
        let probe = canvas(
            move |bounds, _, cx| {
                measure.update(cx, |page, cx| {
                    if page.stage != Some(bounds) {
                        page.stage = Some(bounds);
                        cx.notify();
                    }
                });
            },
            move |_, _, window, _| {
                if !gesture {
                    return;
                }
                // A drag goes on outside the stage.
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
        }
        for l in &self.comments {
            list = list.child(self.card(l, window, cx));
        }
        list
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
        let place: SharedString = match l.page() {
            Some(page) => tf(cx, keys::material_editor::regions::PAGE, &[("page", &page)]),
            None if l.region().is_none() => t(cx, keys::material_editor::regions::WHOLE),
            None => SharedString::default(),
        };
        let word = if todo {
            t(cx, keys::review_panel::filters::TODO)
        } else {
            t(cx, keys::review_panel::filters::COMMENT)
        };
        let this = cx.entity();
        let (toggle, choose, hover) = (this.clone(), this.clone(), this);
        let (c1, c2, c3) = (id.clone(), id.clone(), id.clone());
        let status = if done {
            keys::comment_rail::actions::REOPEN
        } else {
            keys::comment_rail::actions::RESOLVE
        };
        let body: SharedString = if l.item.body.trim().is_empty() {
            t(cx, keys::comment_rail::card::EMPTY_COMMENT)
        } else {
            l.item.body.clone().into()
        };
        let head = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .child(seal(l.number, color, done, p.page))
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(4).solid())
                    .child(place),
            )
            .child(div().flex_1())
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(color.solid())
                    .child(word),
            )
            .child(
                Button::new(eid("status"), t(cx, status))
                    .text()
                    .small()
                    .on_click(move |_, _, cx| {
                        toggle.update(cx, |p, cx| p.set_done(&c1, !done, cx))
                    }),
            );
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

impl Render for MediaPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
