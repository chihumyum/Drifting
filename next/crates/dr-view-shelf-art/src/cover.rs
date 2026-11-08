//! A book's cover on the shelf (the 0.1 client's `BookCover` and
//! `lib/shelf-cover/covers.ts`): 126 × 226, in the style the shelf's button
//! last turned to. Drawn off the main thread the first time a book is shown
//! in a style and kept for the session (the least recently shown let go
//! past 240); until it lands the cover keeps what it showed, or is a plain
//! slip of paper. Sand is coloured when shown, in the storylines' colours
//! as sand lies on the desk (a card is only a line of glass), so a theme
//! change only re-colours it.

use std::{
    collections::{HashMap, VecDeque},
    rc::Rc,
    sync::Arc,
};

use dr_i18n::keys;
use dr_shell::strings::{t, tf};
use dr_ui::{
    Theme, components::IconButton, fonts::Role, sand::Icon, style::DrStyled as _,
    tokens::color::Rgb as UiRgb,
};
use dr_workspace::{Actor, Workspace};
use gpui::{
    App, AppContext as _, ElementId, Entity, Global, IntoElement, ParentElement as _, RenderImage,
    RenderOnce, SharedString, Styled as _, WeakEntity, Window, div, img,
    prelude::FluentBuilder as _, px,
};
use serde_json::{Value, json};

use crate::art::{
    self, CoverRequest, CoverStyle, Drawn, StorylineCover,
    book::{MAX_STORYLINES, cover_seed, is_latin, relative_words},
};
use crate::images;

/// The cover's size on the shelf.
pub const COVER_W: f32 = 126.0;
pub const COVER_H: f32 = 226.0;
const CACHE_LIMIT: usize = 240;

/// What a cover depends on: the book, the style, its length, where each
/// storyline runs and how heavily (words to a tenth of the book's mean, so
/// typing does not redraw it). Colours are drawn in, except sand's.
pub fn cover_key(id: &str, style: CoverStyle, request: &CoverRequest) -> String {
    let weights: String = relative_words(request.chapters, &request.words)
        .iter()
        .map(|w| ((w * 10.0).round() as u32).to_string())
        .collect::<Vec<_>>()
        .join(".");
    let lines: Vec<String> = request
        .storylines
        .iter()
        .map(|l| {
            let chapters: Vec<String> = l.chapters.iter().map(usize::to_string).collect();
            let color = if style == CoverStyle::Sand {
                ""
            } else {
                l.color.as_str()
            };
            format!("{color}{}", chapters.join("."))
        })
        .collect();
    format!(
        "{}|{id}|{}|{}|{}|{weights}",
        style.slug(),
        request.chapters,
        if request.latin { "l" } else { "h" },
        lines.join("/")
    )
}

/// A book's cover request from F3 (`chapter.list`, `storyline.list`): its
/// live chapters in reading order with their words, its first six live
/// storylines in the author's order with the chapters each carries. Run it
/// off the main thread.
pub fn cover_request(ws: &Workspace, book: &str, title: &str) -> CoverRequest {
    let call = |name: &str| {
        ws.call(&Actor::User, name, json!({ "book": book }))
            .map(|v| v["output"].clone())
            .unwrap_or(Value::Null)
    };
    let mut chapters: Vec<(u64, String, u64, Vec<String>)> = call("chapter.list")
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| !c["trashed"].as_bool().unwrap_or(false))
        .filter_map(|c| {
            let number = c["number"].as_u64()?;
            let lines = c["storylines"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect();
            Some((
                number,
                c["id"].as_str()?.to_owned(),
                c["words"].as_u64().unwrap_or(0),
                lines,
            ))
        })
        .collect();
    chapters.sort_by_key(|c| c.0);
    let storylines = call("storyline.list")
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| !s["trashed"].as_bool().unwrap_or(false))
        .filter_map(|s| {
            Some((
                s["id"].as_str()?.to_owned(),
                s["color"].as_str()?.to_owned(),
            ))
        })
        .take(MAX_STORYLINES)
        .map(|(id, color)| StorylineCover {
            color,
            chapters: chapters
                .iter()
                .enumerate()
                .filter(|(_, c)| c.3.contains(&id))
                .map(|(i, _)| i)
                .collect(),
        })
        .collect();
    CoverRequest {
        seed: cover_seed(book),
        chapters: chapters.len(),
        storylines,
        words: chapters.iter().map(|c| c.2).collect(),
        latin: is_latin(title),
    }
}

/// The covers drawn this session, and those being drawn with who waits.
#[derive(Default)]
struct Covers {
    drawn: HashMap<String, Arc<Drawn>>,
    order: VecDeque<String>,
    waiting: HashMap<String, Vec<WeakEntity<Shown>>>,
    /// Covers that could not be drawn: not tried again this session.
    failed: std::collections::HashSet<String>,
}

impl Global for Covers {}

impl Covers {
    fn get(&mut self, key: &str) -> Option<Arc<Drawn>> {
        let drawn = self.drawn.get(key)?.clone();
        // Shown again, so the last to be let go.
        if let Some(at) = self.order.iter().position(|k| k == key) {
            self.order.remove(at);
        }
        self.order.push_back(key.to_owned());
        Some(drawn)
    }

    fn put(&mut self, key: String, drawn: Arc<Drawn>) {
        self.order.push_back(key.clone());
        self.drawn.insert(key, drawn);
        while self.order.len() > CACHE_LIMIT {
            if let Some(oldest) = self.order.pop_front() {
                self.drawn.remove(&oldest);
            }
        }
    }
}

/// Whether the cover drawn for `key` is dark under the title (`None` until
/// it is drawn).
pub fn cover_is_dark(key: &str, cx: &App) -> Option<bool> {
    let drawn = cx.try_global::<Covers>()?.drawn.get(key)?;
    Some(matches!(**drawn, Drawn::Art { dark: true, .. }))
}

/// What one cover on screen shows.
#[derive(Default)]
pub struct Shown {
    /// The picture, for the cover it was made from and the theme.
    image: Option<(String, Arc<RenderImage>)>,
    dark: bool,
    art: bool,
}

/// Starts drawing `key` unless it is drawn or being drawn; `shown` hears
/// when it lands.
fn request(key: &str, style: CoverStyle, req: &CoverRequest, shown: &Entity<Shown>, cx: &mut App) {
    let covers = cx.default_global::<Covers>();
    if covers.drawn.contains_key(key) || covers.failed.contains(key) {
        return;
    }
    if let Some(list) = covers.waiting.get_mut(key) {
        if !list.iter().any(|w| w.entity_id() == shown.entity_id()) {
            list.push(shown.downgrade());
        }
        return;
    }
    covers
        .waiting
        .insert(key.to_owned(), vec![shown.downgrade()]);
    let (key, req) = (key.to_owned(), req.clone());
    // A cover that cannot be drawn leaves the book a plain slip of paper
    // (as in the 0.1 client), not the app down.
    let task = cx.background_spawn(async move {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| art::draw(style, &req)))
    });
    cx.spawn(async move |cx| {
        let drawn = task.await;
        cx.update(|cx| {
            let covers = cx.default_global::<Covers>();
            let listeners = covers.waiting.remove(&key).unwrap_or_default();
            match drawn {
                Ok(drawn) => covers.put(key, Arc::new(drawn)),
                Err(_) => {
                    log::warn!("the cover {key} could not be drawn");
                    covers.failed.insert(key);
                    return;
                }
            }
            for shown in listeners.into_iter().filter_map(|w| w.upgrade()) {
                shown.update(cx, |_, cx| cx.notify());
            }
        });
    })
    .detach();
}

/// The picture for `drawn` in this theme: an art cover as it is, sand in
/// the storylines' colours (or the neutral ink) as sand lies on the desk.
fn picture(drawn: &Drawn, window: &Window, cx: &App) -> Arc<RenderImage> {
    let (w, h) = art::SIZE;
    match drawn {
        Drawn::Art { rgba, .. } => images::rgba(rgba, w, h),
        Drawn::Sand { masks, colors } => {
            let p = Theme::of(window, cx).palette;
            let layers: Vec<(&[f32], UiRgb)> = masks
                .iter()
                .zip(colors)
                .map(|(mask, color)| {
                    let c = match color {
                        Some([r, g, b]) => UiRgb::new(
                            f32::from(*r) / 255.0,
                            f32::from(*g) / 255.0,
                            f32::from(*b) / 255.0,
                        ),
                        // `.sand`'s own ink, as the 0.1 client left it.
                        None => p.ink(3),
                    };
                    (mask.as_slice(), p.sand_on(c, p.desk))
                })
                .collect();
            images::layered(&layers, w, h, p.pigment)
        }
    }
}

/// A book's cover in `style`.
#[derive(IntoElement)]
pub struct ShelfCover {
    id: ElementId,
    book: SharedString,
    style: CoverStyle,
    request: Rc<CoverRequest>,
    label: Option<SharedString>,
}

impl ShelfCover {
    /// `book`'s cover (its id: the seed and the cache) from `request`
    /// ([`cover_request`]).
    pub fn new(
        id: impl Into<ElementId>,
        book: impl Into<SharedString>,
        style: CoverStyle,
        request: Rc<CoverRequest>,
    ) -> ShelfCover {
        ShelfCover {
            id: id.into(),
            book: book.into(),
            style,
            request,
            label: None,
        }
    }

    /// Words at the cover's foot (the book's genre), in an ink that reads
    /// on the picture.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }
}

impl RenderOnce for ShelfCover {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let key = cover_key(&self.book, self.style, &self.request);
        let shown = window.use_keyed_state(self.id.clone(), cx, |_, _| Shown::default());
        let drawn = cx.default_global::<Covers>().get(&key);
        match drawn {
            Some(drawn) => {
                let picture_key = format!("{key}|{}", if p.dark { "dark" } else { "light" });
                let fresh = shown
                    .read(cx)
                    .image
                    .as_ref()
                    .is_none_or(|(k, _)| *k != picture_key);
                if fresh {
                    let image = picture(&drawn, window, cx);
                    let (dark, art) = match *drawn {
                        Drawn::Art { dark, .. } => (dark, true),
                        Drawn::Sand { .. } => (false, false),
                    };
                    let old = shown.update(cx, |s, _| {
                        s.dark = dark;
                        s.art = art;
                        s.image.replace((picture_key, image))
                    });
                    if let Some((_, old)) = old {
                        let _ = window.drop_image(old);
                    }
                }
            }
            None => request(&key, self.style, &self.request, &shown, cx),
        }
        let s = shown.read(cx);
        let image = s.image.as_ref().map(|(_, i)| i.clone());
        let label_ink = match (s.art, s.dark) {
            (true, true) => gpui::hsla(40.0 / 360.0, 0.12, 0.92, 0.66),
            (true, false) => gpui::hsla(30.0 / 360.0, 0.03, 0.44, 1.0),
            _ => p.ink(3).solid(),
        };
        div()
            .relative()
            .flex_none()
            .w(px(COVER_W))
            .h(px(COVER_H))
            .overflow_hidden()
            .rounded(px(2.0))
            .when_some(image, |el, image| {
                el.child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .child(img(image).size_full()),
                )
            })
            .when_some(self.label, |el, label| {
                el.child(
                    div()
                        .absolute()
                        .left(px(14.0))
                        .right(px(10.0))
                        .bottom(px(11.0))
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .font_role(Role::Index)
                        .type_px(11.0, 13.2)
                        .text_color(label_ink)
                        .child(label),
                )
            })
    }
}

/// A style's name as the turn button says it.
pub fn style_name(style: CoverStyle, cx: &App) -> SharedString {
    use keys::project_picker::desk::cover_style::names as n;
    t(
        cx,
        match style {
            CoverStyle::Sand => n::SAND,
            CoverStyle::Ridge => n::RIDGE,
            CoverStyle::Quipu => n::QUIPU,
            CoverStyle::Weave => n::WEAVE,
            CoverStyle::Topo => n::TOPO,
            CoverStyle::Cyanotype => n::CYANOTYPE,
            CoverStyle::Rings => n::RINGS,
            CoverStyle::Field => n::FIELD,
            CoverStyle::Cutout => n::CUTOUT,
            CoverStyle::Riso => n::RISO,
            CoverStyle::Stars => n::STARS,
            CoverStyle::Strata => n::STRATA,
            CoverStyle::Bauhaus => n::BAUHAUS,
            CoverStyle::Chars => n::CHARS,
        },
    )
}

type OnTurn = Rc<dyn Fn(CoverStyle, &mut Window, &mut App)>;

/// The round button at the shelf's foot that turns every cover to the next
/// style.
#[derive(IntoElement)]
pub struct CoverTurn {
    style: CoverStyle,
    on_turn: OnTurn,
}

impl CoverTurn {
    /// Showing `style`; `on_turn` gets the next one.
    pub fn new(
        style: CoverStyle,
        on_turn: impl Fn(CoverStyle, &mut Window, &mut App) + 'static,
    ) -> CoverTurn {
        CoverTurn {
            style,
            on_turn: Rc::new(on_turn),
        }
    }
}

impl RenderOnce for CoverTurn {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let name = style_name(self.style, cx);
        let label = tf(
            cx,
            keys::project_picker::desk::cover_style::TURN,
            &[("name", &name)],
        );
        let (style, on_turn) = (self.style, self.on_turn);
        IconButton::new("shelf-cover-turn", Icon::Rotate)
            .label(label)
            .on_click(move |_, window, cx| on_turn(style.next(), window, cx))
    }
}
