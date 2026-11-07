//! Spike P0-D: Drifting's two materials on GPUI, without a backdrop blur.
//!
//! `cargo run -p visual-spike` opens one window. The top row switches the
//! page (稿纸 / 书架 / 图标 / 字海 / 封面), the glass plan (甲 / 乙 / 丙, see
//! `glass.rs`) and the appearance (浅 / 深). `--bench <file>` measures and
//! quits; with `--features capture`, `--capture <dir>` writes screenshots and
//! quits. See docs/rust-rewrite/spikes/p0-d-visual.md.

mod assets;
mod capture;
mod covers;
mod glass;
mod icons;
mod scenes;
mod sea;
mod theme;

use std::{cell::RefCell, collections::HashMap, path::PathBuf, rc::Rc, sync::Arc, time::Instant};

use anyhow::Result;
use gpui::{
    App, Bounds, Context, RenderImage, Window, WindowBounds, WindowOptions, prelude::*, px, size,
};
use gpui_platform::application;

use crate::{
    assets::{
        Assets, GLASS_RING_TILE_PATH, GLASS_TILE_PATH, Mask, SvgAssets, embed_svg, icon_embed_path,
        icon_vector_path, sand_embed_path,
    },
    covers::{Book, HeatMasks},
    glass::{Anim, BakeCache, Kind, Painter, Plan, SharedBakes},
    icons::{TintCache, VectorStats},
    sea::Sea,
    theme::Theme,
};

pub const WINDOW_W: f32 = 1280.0;
pub const WINDOW_H: f32 = 800.0;
pub const TOP_BAR: f32 = 36.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Page {
    Paper,
    Shelf,
    Icons,
    Sea,
    Covers,
}

impl Page {
    pub const ALL: [Page; 5] = [
        Page::Paper,
        Page::Shelf,
        Page::Icons,
        Page::Sea,
        Page::Covers,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Page::Paper => "稿纸",
            Page::Shelf => "书架",
            Page::Icons => "图标",
            Page::Sea => "字海",
            Page::Covers => "封面",
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Page::Paper => "paper",
            Page::Shelf => "shelf",
            Page::Icons => "icons",
            Page::Sea => "sea",
            Page::Covers => "covers",
        }
    }
}

/// How the icons page tints its masks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconWay {
    Embed,
    Vector,
    Tint,
}

/// Everything measured once at start, for `--bench`.
#[derive(Clone, Debug, Default)]
pub struct StartTimes {
    pub assets_ms: f64,
    pub embed_build_ms: f64,
    pub embed_bytes: usize,
    pub vector_ms: f64,
    pub vector: VectorStats,
    pub png_bytes: usize,
}

pub struct Covers {
    pub books: Vec<Book>,
    pub topo: Vec<Arc<RenderImage>>,
    pub sand_masks: Vec<Vec<Vec<f32>>>,
    pub sand: HashMap<bool, Vec<Arc<RenderImage>>>,
    pub heat: HeatMasks,
    pub heat_images: HashMap<bool, (Arc<RenderImage>, Arc<RenderImage>)>,
}

pub struct Spike {
    pub page: Page,
    pub plan: Plan,
    pub dark: bool,
    pub assets: Arc<Assets>,
    pub texture: Arc<Mask>,
    pub texture_mean: f32,
    pub bakes: SharedBakes,
    pub anims: HashMap<&'static str, Anim>,
    pub last: Option<Instant>,
    pub demo_flow: f32,
    pub sea: Rc<RefCell<Sea>>,
    pub shelf_sea: Rc<RefCell<Sea>>,
    pub covers: Covers,
    pub tints: Rc<RefCell<TintCache>>,
    pub icon_color: usize,
    pub icon_size: f32,
    pub menu_open: bool,
    pub loading: bool,
    pub pointer: Option<((f32, f32), Instant)>,
    pub start: StartTimes,
    pub ring_images: HashMap<bool, Arc<RenderImage>>,
}

impl Spike {
    pub fn theme(&self) -> Theme {
        Theme::get(self.dark)
    }

    pub fn painter(&self) -> Painter {
        Painter {
            plan: self.plan,
            texture: self.texture.clone(),
            texture_mean: self.texture_mean,
            bakes: self.bakes.clone(),
        }
    }

    pub fn anim(&self, id: &'static str, kind: Kind) -> Anim {
        self.anims
            .get(id)
            .copied()
            .unwrap_or_else(|| Anim::new(kind))
    }

    pub fn anim_mut(&mut self, id: &'static str, kind: Kind) -> &mut Anim {
        self.anims.entry(id).or_insert_with(|| Anim::new(kind))
    }

    pub fn set_page(&mut self, page: Page, cx: &mut Context<Self>) {
        self.page = page;
        self.last = None;
        cx.notify();
    }

    /// The renderer's menu rim texture, already tinted as the resting line.
    pub fn ring_image(&mut self) -> Arc<RenderImage> {
        let dark = self.dark;
        let assets = self.assets.clone();
        self.ring_images
            .entry(dark)
            .or_insert_with(|| {
                let mask = if dark {
                    &assets.glass_ring_dark
                } else {
                    &assets.glass_ring
                };
                let image = image::load_from_memory(&mask.png)
                    .map(|i| i.to_rgba8())
                    .unwrap_or_else(|_| image::RgbaImage::new(1, 1));
                let mut bgra = image;
                for p in bgra.pixels_mut() {
                    p.0.swap(0, 2);
                }
                glass::render_image(bgra)
            })
            .clone()
    }
}

impl Render for Spike {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        let dt = self
            .last
            .map_or(1.0 / 60.0, |last| (now - last).as_secs_f32())
            .min(0.1);
        let mut animating = false;
        for anim in self.anims.values_mut() {
            animating |= anim.step(dt);
        }
        match self.page {
            Page::Paper => {
                self.demo_flow += dt * glass::FLOW_PX_PER_S;
                animating = true;
            }
            Page::Sea => animating |= self.sea.borrow_mut().advance(),
            Page::Shelf => animating |= self.shelf_sea.borrow_mut().advance(),
            _ => {}
        }
        if animating {
            self.last = Some(now);
            window.request_animation_frame();
        } else {
            self.last = None;
        }
        scenes::root(self, window, cx)
    }
}

fn build_svgs(assets: &Assets, start: &mut StartTimes) -> HashMap<String, Vec<u8>> {
    let mut files = HashMap::new();
    let started = Instant::now();
    for name in &assets.icon_names {
        let mask = assets.icon(name);
        let svg = embed_svg(mask, 96.0, 96.0);
        start.embed_bytes += svg.len();
        start.png_bytes += mask.png.len();
        files.insert(icon_embed_path(name).to_string(), svg);
    }
    for (name, mask) in &assets.sand {
        files.insert(
            sand_embed_path(name).to_string(),
            embed_svg(mask, mask.width as f32, mask.height as f32),
        );
    }
    files.insert(
        GLASS_TILE_PATH.to_string(),
        embed_svg(&assets.glass_thick, glass::TILE, glass::TILE),
    );
    files.insert(
        GLASS_RING_TILE_PATH.to_string(),
        embed_svg(&assets.glass_ring, glass::TILE, glass::TILE),
    );
    start.embed_build_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    for name in &assets.icon_names {
        let (svg, stats) = icons::vectorize(assets.icon(name));
        start.vector.loops += stats.loops;
        start.vector.points += stats.points;
        start.vector.bytes += stats.bytes;
        files.insert(icon_vector_path(name).to_string(), svg);
    }
    start.vector_ms = started.elapsed().as_secs_f64() * 1000.0;
    files
}

fn build_covers(theme: &Theme) -> Covers {
    let titles = ["雾港", "第七圈", "旧码头", "北"];
    let shapes = [(24, 3), (40, 2), (16, 1), (61, 4)];
    let books: Vec<Book> = titles
        .iter()
        .zip(shapes)
        .enumerate()
        .map(|(i, (title, (chapters, lines)))| {
            Book::synthetic(101 + i as u32 * 37, title, chapters, lines, &theme.story)
        })
        .collect();
    let topo = books
        .iter()
        .map(|book| glass::render_image(covers::pixmap_to_image(&covers::topo(book))))
        .collect();
    let sand_masks = books.iter().map(covers::sand_cover).collect();
    let heat = covers::heatmap(&covers::synthetic_year(5), 2.0);
    Covers {
        books,
        topo,
        sand_masks,
        sand: HashMap::new(),
        heat,
        heat_images: HashMap::new(),
    }
}

enum Mode {
    Interactive,
    Bench(PathBuf),
    Capture(PathBuf),
}

fn mode() -> Mode {
    let args: Vec<String> = std::env::args().collect();
    let value = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .map(PathBuf::from)
    };
    if let Some(path) = value("--bench") {
        return Mode::Bench(path);
    }
    if let Some(dir) = value("--capture") {
        return Mode::Capture(dir);
    }
    Mode::Interactive
}

pub fn make_spike(assets: Arc<Assets>, start: StartTimes) -> Spike {
    let theme = Theme::light();
    let texture = Arc::new(assets.glass_thick.clone());
    let texture_mean = texture.mean();
    let content_h = WINDOW_H - TOP_BAR;
    Spike {
        page: Page::Paper,
        // The plan chosen for F5 (decision D2); the others stay for comparison.
        plan: Plan::Cover,
        dark: false,
        assets,
        texture,
        texture_mean,
        bakes: Rc::new(RefCell::new(BakeCache::default())),
        anims: HashMap::new(),
        last: None,
        demo_flow: 37.0,
        sea: Rc::new(RefCell::new(Sea::new(WINDOW_W, content_h))),
        shelf_sea: Rc::new(RefCell::new(Sea::new(WINDOW_W, content_h))),
        covers: build_covers(&theme),
        tints: Rc::new(RefCell::new(TintCache::default())),
        icon_color: 0,
        icon_size: 16.0,
        menu_open: true,
        loading: false,
        pointer: None,
        start,
        ring_images: HashMap::new(),
    }
}

fn main() -> Result<()> {
    let assets = Arc::new(Assets::load()?);
    let mut start = StartTimes {
        assets_ms: assets.load_ms,
        ..StartTimes::default()
    };
    let svgs = build_svgs(&assets, &mut start);
    let mode = mode();
    match &mode {
        Mode::Capture(dir) => return capture::run(dir.clone(), assets, start, svgs),
        Mode::Bench(path) => return capture::bench(path.clone(), assets, start, svgs),
        Mode::Interactive => {}
    }
    application()
        .with_assets(SvgAssets::new(svgs))
        .run(move |cx: &mut App| {
            let bounds = Bounds::centered(None, size(px(WINDOW_W), px(WINDOW_H)), cx);
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    ..Default::default()
                },
                |_, cx| cx.new(|_| make_spike(assets.clone(), start.clone())),
            )
            .expect("open the prototype window");
            cx.activate(true);
        });
    Ok(())
}
