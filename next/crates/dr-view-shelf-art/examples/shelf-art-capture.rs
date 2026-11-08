//! The shelf's pictures (M25) drawn offscreen: screenshots into
//! `<dir>/m25/`, light and dark.
//!
//! GPUI runs headless (its test platform with the real macOS text system
//! and Metal drawing into a texture): nothing opens on screen. The books
//! are dr-testkit's showcase in a temporary library, their covers read
//! through F3 as the shelf will read them; a synthetic year of writing days
//! is recorded for them through F3 and read back.
//!
//! ```text
//! cargo run -p dr-view-shelf-art --features capture --example shelf-art-capture -- ../docs/rust-rewrite/modules
//! ```

use std::{path::PathBuf, rc::Rc, sync::Arc, time::Duration};

use anyhow::{Context as _, Result};
use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_ui::{Appearance, Theme, fonts::Role, style::DrStyled as _, theme, tokens::color::Rgb};
use dr_view_shelf_art::{
    CoverRequest, CoverStyle, CoverTurn, HeatmapBook, SandStrip, ShelfCover, WritingHeatmap,
    WritingYear, art::paint::Rand, cover_is_dark, cover_key, cover_request, cover_seed, style_name,
};
use dr_workspace::Actor;
use gpui::{
    AppContext as _, Context, HeadlessAppContext, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Window, div, px, size,
};
use serde_json::{Value, json};

const W: f32 = 1280.0;
const H: f32 = 900.0;
const VERSION: &str = "0.2.0-dev";
const TODAY: &str = "2026-11-08";
const DEVICE: &str = "device-0123456789abcdef01234567";

fn call(ws: &dr_workspace::Workspace, name: &str, input: Value) -> Result<Value> {
    Ok(ws.call(&Actor::User, name, input)?["output"].clone())
}

struct Book {
    id: String,
    name: String,
    color: Rgb,
    request: Rc<CoverRequest>,
}

/// The showcase's first books, a synthetic year written in three of them.
fn library() -> Result<(tempfile::TempDir, Vec<Book>, WritingYear)> {
    let dir = tempfile::tempdir()?;
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION))?;
    for book in dr_testkit::samples::showcase(dr_testkit::seed::DEFAULT_SEED)? {
        dr_testkit::seed::write_book(&lib, &book).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    lib.close()?;
    let ws = dr_workspace::Workspace::open_dir(&root, VERSION)?;
    ws.library().rebuild_stale_indexes()?;
    let listed = call(&ws, "book.list", json!({}))?;
    let story = [0xb5654a, 0x4f7cac, 0x8a9a5b, 0x9c6b98, 0xc4943d, 0x5b8c85];
    let books: Vec<Book> = listed
        .as_array()
        .context("books")?
        .iter()
        .take(6)
        .enumerate()
        .filter_map(|(i, b)| {
            let id = b["id"].as_str()?.to_owned();
            let name = b["name"].as_str()?.to_owned();
            let request = Rc::new(cover_request(&ws, &id, &name));
            Some(Book {
                id,
                name,
                color: Rgb::hex(story[i % story.len()]),
                request,
            })
        })
        .collect();
    // A year of writing: most days in the first book, fewer in two others,
    // busier toward today.
    let start = dr_view_shelf_art::year::year_start(TODAY);
    let first = dr_view_shelf_art::format::day_number(&start);
    let last = dr_view_shelf_art::format::day_number(TODAY);
    let mut rand = Rand::new(20_261_108);
    for (k, book) in books.iter().take(3).enumerate() {
        let chance = [0.62, 0.28, 0.16][k];
        for n in first..=last {
            let late = (n - first) as f32 / (last - first) as f32;
            if rand.next() > chance * (0.5 + late) {
                continue;
            }
            let words = (200.0 + 2600.0 * rand.next().powi(2) * (0.6 + late)) as i64;
            call(
                &ws,
                "writing_day.record",
                json!({
                    "book": book.id,
                    "device": DEVICE,
                    "day": dr_view_shelf_art::format::day_of_number(n),
                    "words": words,
                }),
            )?;
        }
    }
    let ids: Vec<String> = books.iter().map(|b| b.id.clone()).collect();
    let year = WritingYear::load(&ws, &ids, TODAY);
    Ok((dir, books, year))
}

/// What a screenshot shows.
#[derive(Clone, Copy, PartialEq)]
enum Scene {
    /// The year, every style on one book, a strip and the turn button.
    Styles,
    /// One book focused with a day's card open; every book's cover and strip
    /// in one style.
    Books(CoverStyle),
}

struct Board {
    books: Vec<Book>,
    year: Rc<WritingYear>,
    heat_books: Rc<Vec<HeatmapBook>>,
    scene: Scene,
}

impl Board {
    fn keys(&self) -> Vec<String> {
        match self.scene {
            Scene::Styles => CoverStyle::ALL
                .iter()
                .map(|&s| cover_key(&self.books[0].id, s, &self.books[0].request))
                .collect(),
            Scene::Books(style) => self
                .books
                .iter()
                .map(|b| cover_key(&b.id, style, &b.request))
                .collect(),
        }
    }
}

impl Render for Board {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Theme::of(window, cx).palette;
        let s = Theme::of(window, cx).scale;
        let caption = |text: SharedString| {
            div()
                .pt(px(8.0))
                .font_role(Role::Ui)
                .type_px(s.caption, s.line_caption)
                .text_color(p.ink(3).solid())
                .child(text)
        };
        let (heat, grid) = match self.scene {
            Scene::Styles => {
                let book = &self.books[0];
                let grid = div().flex().flex_row().flex_wrap().gap(px(18.0)).children(
                    CoverStyle::ALL.iter().map(|&style| {
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .child(ShelfCover::new(
                                SharedString::from(format!("cover-{}", style.slug())),
                                book.id.clone(),
                                style,
                                book.request.clone(),
                            ))
                            .child(caption(style_name(style, cx)))
                    }),
                );
                (
                    WritingHeatmap::new("heat", self.year.clone(), self.heat_books.clone(), None),
                    grid,
                )
            }
            Scene::Books(style) => {
                let grid = div().flex().flex_row().flex_wrap().gap(px(18.0)).children(
                    self.books.iter().map(|book| {
                        div()
                            .w(px(150.0))
                            .flex()
                            .flex_col()
                            .items_center()
                            .child(ShelfCover::new(
                                SharedString::from(format!("book-{}", book.id)),
                                book.id.clone(),
                                style,
                                book.request.clone(),
                            ))
                            .child(caption(book.name.clone().into()))
                            .child(div().w_full().pt(px(8.0)).child(SandStrip::new(
                                SharedString::from(format!("strip-{}", book.id)),
                                Rc::new(self.year.recent(&book.id, 30)),
                                cover_seed(&book.id),
                                "",
                            )))
                    }),
                );
                let day = self.year.days.len() - 3;
                (
                    WritingHeatmap::new(
                        "heat",
                        self.year.clone(),
                        self.heat_books.clone(),
                        Some(self.books[0].id.clone().into()),
                    )
                    .hold_day(day),
                    grid,
                )
            }
        };
        let turn_style = match self.scene {
            Scene::Styles => CoverStyle::DEFAULT,
            Scene::Books(style) => style,
        };
        div()
            .size_full()
            .bg(p.desk.solid())
            .p(px(32.0))
            .flex()
            .flex_col()
            .gap(px(28.0))
            .child(div().w(px(1180.0)).child(heat))
            .child(grid)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_center()
                    .child(CoverTurn::new(turn_style, |_, _, _| {})),
            )
    }
}

fn main() -> Result<()> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .unwrap_or_else(|| "../docs/rust-rewrite/modules".into()),
    );
    let dir = root.join("m25");
    std::fs::create_dir_all(&dir)?;
    let (_lib_dir, books, year) = library()?;
    let text_system = gpui_platform::current_platform(true).text_system();
    let mut cx = HeadlessAppContext::with_platform(
        text_system,
        Arc::new(dr_ui::Assets::new()),
        gpui_platform::current_headless_renderer,
    );
    cx.allow_parking();
    cx.update(|cx| -> Result<()> {
        dr_ui::init(cx)?;
        let info = ShellInfo {
            app_name: "Drifting Next",
            bundle_id: "cc.drifting.next.dev",
            version: VERSION,
            url_scheme: "drifting-next-dev",
            forced_appearance: Some(Appearance::Light),
        };
        let mut file = SettingsFile::in_memory();
        file.set(
            dr_shell::settings::registry::UI_LOCALE,
            "zh-CN".into(),
            None,
        )
        .ok();
        dr_shell::init(info, Services::default(), file, cx);
        Ok(())
    })?;
    let heat_books = Rc::new(
        books
            .iter()
            .map(|b| HeatmapBook {
                id: b.id.clone().into(),
                name: b.name.clone().into(),
                color: b.color,
            })
            .collect(),
    );
    let year = Rc::new(year);
    let window = cx.open_window(size(px(W), px(H)), move |_, cx| {
        cx.new(|_| Board {
            books,
            year,
            heat_books,
            scene: Scene::Styles,
        })
    })?;
    let view = window.entity(&cx)?;
    let handle: gpui::AnyWindowHandle = window.into();
    for appearance in [Appearance::Light, Appearance::Dark] {
        cx.update(|cx| theme::force_appearance(Some(appearance), cx));
        for (scene, name) in [
            (Scene::Styles, "styles"),
            (Scene::Books(CoverStyle::Topo), "books"),
        ] {
            cx.update(|cx| {
                view.update(cx, |b, cx| {
                    b.scene = scene;
                    cx.notify();
                })
            });
            // Until every cover on the board has landed.
            let deadline = std::time::Instant::now() + Duration::from_secs(120);
            loop {
                cx.update_window(handle, |_, window, cx| {
                    window.simulate_next_frame(cx);
                    view.update(cx, |_, cx| cx.notify());
                    window.draw(cx).clear(cx);
                })?;
                cx.run_until_parked();
                let keys = cx.update(|cx| view.read(cx).keys());
                let ready = cx.update(|cx| keys.iter().all(|k| cover_is_dark(k, cx).is_some()));
                if ready || std::time::Instant::now() > deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            for _ in 0..4 {
                cx.update_window(handle, |_, window, cx| {
                    window.simulate_next_frame(cx);
                    view.update(cx, |_, cx| cx.notify());
                    window.draw(cx).clear(cx);
                })?;
                cx.run_until_parked();
            }
            let image = cx.capture_screenshot(handle)?;
            let file = format!("shelf-{name}-{}.png", appearance.slug());
            image.save(dir.join(&file))?;
            println!("wrote {file}");
        }
    }
    Ok(())
}
