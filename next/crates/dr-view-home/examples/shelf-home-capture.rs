//! The bookshelf (M01) and Project Home (M02) drawn offscreen: screenshots
//! (`--capture <docs/rust-rewrite/modules>`, into `m01/` and `m02/`) and
//! timings (`--bench <dir>`, a measured evidence file).
//!
//! GPUI runs headless (its test platform with the real macOS text system
//! and Metal drawing into a texture): nothing opens on screen and no
//! screen-recording permission is needed. The library is dr-testkit's
//! showcase (《慢钟》, 《阿Q正传》 and six synthetic shelf books), seeded into
//! a temporary folder and read through F3 like the app reads it.
//!
//! ```text
//! cargo run -p dr-view-home --features capture --example shelf-home-capture -- --capture ../docs/rust-rewrite/modules
//! cargo run --release -p dr-view-home --features capture --example shelf-home-capture -- --bench ../docs/rust-rewrite/acceptance
//! ```

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use dr_shell::nav::{Open, Target};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_ui::{Appearance, theme};
use dr_view_home::{Home, HomeView};
use dr_view_shelf::Shelf;
use gpui::{AnyWindowHandle, AppContext as _, Context, Entity, HeadlessAppContext, px, size};

const W: f32 = 1280.0;
const H: f32 = 800.0;
const VERSION: &str = "0.2.0-dev";

struct Headless {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    view: Entity<Workspace>,
    /// Making the window until its first frame, and until the cards drew.
    first_frame_ms: f64,
    cards_ms: f64,
    _library: tempfile::TempDir,
}

/// A temporary library holding the showcase, and with `heavy` also the
/// heavy seed's book (benchmarks.md: 「打开项目」 is measured on it).
fn showcase(heavy: bool) -> Result<(tempfile::TempDir, dr_workspace::Workspace)> {
    let dir = tempfile::tempdir()?;
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION))?;
    for book in dr_testkit::samples::showcase(dr_testkit::seed::DEFAULT_SEED)? {
        dr_testkit::seed::write_book(&lib, &book).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    if heavy {
        dr_testkit::seed::generate(
            dr_testkit::seed::Preset::Heavy,
            dr_testkit::seed::DEFAULT_SEED,
        )?
        .write_to(&lib)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    lib.close()?;
    // Open it once and let dr-index build every index, as an app that has
    // run before finds it.
    let ws = dr_workspace::Workspace::open_dir(&root, VERSION)?;
    ws.library().rebuild_stale_indexes()?;
    Ok((dir, ws))
}

/// The day the seeded writing days end on (dr-testkit's T0).
fn t0_day() -> chrono::NaiveDate {
    chrono::DateTime::from_timestamp(dr_testkit::seed::T0, 0)
        .expect("T0")
        .date_naive()
}

impl Headless {
    fn new(heavy: bool) -> Result<Headless> {
        let text_system = gpui_platform::current_platform(true).text_system();
        let mut cx = HeadlessAppContext::with_platform(
            text_system,
            Arc::new(dr_ui::Assets::new()),
            gpui_platform::current_headless_renderer,
        );
        // F3 reads and delivers events on its own threads.
        cx.allow_parking();
        let (dir, library) = showcase(heavy)?;
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
            let services = Services {
                library: Some(library),
                ..Services::default()
            };
            dr_shell::init(info, services, file, cx);
            dr_view_shelf::init(cx);
            dr_view_home::init(cx);
            dr_view_home::set_today(t0_day(), cx);
            dr_view_shelf::art::set_today(t0_day(), cx);
            Ok(())
        })?;
        let started = Instant::now();
        let window = cx.open_window(size(px(W), px(H)), |window, cx| {
            cx.new(|cx| Workspace::new(window, cx))
        })?;
        let view = window.entity(&cx)?;
        let mut h = Headless {
            cx,
            window: window.into(),
            view,
            first_frame_ms: 0.0,
            cards_ms: 0.0,
            _library: dir,
        };
        h.draw()?;
        h.first_frame_ms = ms(started);
        h.wait(|h| h.shelf_ready())?;
        h.draw()?;
        h.cards_ms = ms(started);
        Ok(h)
    }

    fn read<T>(&mut self, f: impl FnOnce(&Workspace, &gpui::App) -> T) -> T {
        let view = self.view.clone();
        self.cx.update(|cx| f(view.read(cx), cx))
    }

    fn shelf(&mut self) -> Entity<Shelf> {
        self.read(|ws, _| ws.shelf.clone())
            .expect("the bookshelf")
            .view
            .downcast::<Shelf>()
            .expect("dr-view-shelf")
    }

    fn home(&mut self) -> Option<Entity<Home>> {
        self.read(|ws, _| ws.home.clone())
            .and_then(|v| v.downcast::<Home>().ok())
    }

    fn shelf_ready(&mut self) -> bool {
        let shelf = self.shelf();
        self.cx.update(|cx| shelf.read(cx).data.is_some())
    }

    /// The covers, the heat map and the strips are read and every cover is
    /// drawn (M25).
    fn pictures_ready(&mut self) -> bool {
        let shelf = self.shelf();
        self.cx.update(|cx| {
            let style = dr_view_shelf::art::cover_style(cx);
            shelf
                .read(cx)
                .art
                .as_ref()
                .is_some_and(|a| a.drawn(style, cx))
        })
    }

    /// The book's lists arrived, Home has its numbers and nothing is read.
    fn book_ready(&mut self, id: &str) -> bool {
        let (book_ok, shelf_open) = self.read(|ws, _| (ws.book.id == id, ws.shelf_open));
        if !book_ok || shelf_open {
            return false;
        }
        let Some(home) = self.home() else {
            return false;
        };
        self.cx
            .update(|cx| home.read(cx).stats.as_ref().is_some_and(|s| s.book == id))
    }

    /// Runs until `done` holds (F3's threads answer in their own time).
    fn wait(&mut self, done: impl Fn(&mut Headless) -> bool) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            self.draw()?;
            self.cx.run_until_parked();
            if done(self) {
                return Ok(());
            }
            if Instant::now() > deadline {
                bail!("timed out");
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn set(&mut self, f: impl FnOnce(&mut Workspace, &mut gpui::Window, &mut Context<Workspace>)) {
        let view = self.view.clone();
        self.cx
            .update_window(self.window, |_, window, cx| {
                view.update(cx, |ws, cx| f(ws, window, cx))
            })
            .ok();
    }

    fn on_shelf(&mut self, f: impl FnOnce(&mut Shelf, &mut gpui::Window, &mut Context<Shelf>)) {
        let shelf = self.shelf();
        self.cx
            .update_window(self.window, |_, window, cx| {
                shelf.update(cx, |s, cx| f(s, window, cx))
            })
            .ok();
    }

    fn on_home(&mut self, f: impl FnOnce(&mut Home, &mut gpui::Window, &mut Context<Home>)) {
        let Some(home) = self.home() else {
            return;
        };
        self.cx
            .update_window(self.window, |_, window, cx| {
                home.update(cx, |h, cx| f(h, window, cx))
            })
            .ok();
    }

    /// One frame; its CPU time in ms.
    fn draw(&mut self) -> Result<f32> {
        let view = self.view.clone();
        self.cx.update_window(self.window, |_, window, cx| {
            window.simulate_next_frame(cx);
            view.update(cx, |_, cx| cx.notify());
            let started = Instant::now();
            window.draw(cx).clear(cx);
            started.elapsed().as_secs_f32() * 1000.0
        })
    }

    /// Draws for a little over the longest motion (420 ms), so nothing is
    /// caught halfway; reads F3 meanwhile.
    fn settle(&mut self) -> Result<()> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(600) {
            self.draw()?;
            self.cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(16));
        }
        Ok(())
    }

    fn book_id(&mut self, name: &str) -> Result<String> {
        let shelf = self.shelf();
        self.cx
            .update(|cx| {
                shelf.read(cx).data.as_ref().and_then(|d| {
                    d.books
                        .iter()
                        .find(|b| b.name == name)
                        .map(|b| b.id.clone())
                })
            })
            .with_context(|| format!("{name} is on the shelf"))
    }

    fn open_book(&mut self, id: &str) -> Result<f64> {
        let started = Instant::now();
        let id2 = id.to_owned();
        self.on_shelf(move |s, window, cx| s.open(&id2, window, cx));
        self.wait(|h| h.book_ready(id))?;
        self.draw()?;
        Ok(ms(started))
    }

    fn back_to_shelf(&mut self) -> Result<()> {
        self.set(|ws, window, cx| {
            ws.show_shelf(window, cx);
        });
        self.settle()
    }

    /// Writes the window as a 256-colour PNG (as dr-shell's capture does).
    fn save(&mut self, dir: &Path, name: &str) -> Result<()> {
        let image = self.cx.capture_screenshot(self.window)?;
        let (w, h) = image.dimensions();
        let rgba = image.into_raw();
        let quant = color_quant::NeuQuant::new(10, 256, &rgba);
        let indices: Vec<u8> = rgba
            .as_chunks::<4>()
            .0
            .iter()
            .map(|px| quant.index_of(px) as u8)
            .collect();
        let palette: Vec<u8> = quant
            .color_map_rgba()
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|c| [c[0], c[1], c[2]])
            .collect();
        std::fs::create_dir_all(dir)?;
        let file = std::io::BufWriter::new(std::fs::File::create(dir.join(name))?);
        let mut encoder = png::Encoder::new(file, w, h);
        encoder.set_color(png::ColorType::Indexed);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_palette(palette);
        encoder.set_compression(png::Compression::High);
        encoder.write_header()?.write_image_data(&indices)?;
        println!("wrote {}", dir.join(name).display());
        Ok(())
    }

    fn appearance(&mut self, appearance: Appearance) {
        self.cx
            .update(|cx| theme::force_appearance(Some(appearance), cx));
    }
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1e3
}

fn capture(dir: PathBuf) -> Result<()> {
    let mut h = Headless::new(false)?;
    let m01 = dir.join("m01");
    let m02 = dir.join("m02");
    let slow_clock = h.book_id("慢钟")?;
    let night_train = h.book_id("夜车").or_else(|_| h.book_id("Night Train"))?;
    let trashed = h
        .book_id("A Map of Small Rivers")
        .or_else(|_| h.book_id("小河地图"));
    for (appearance, suffix) in [(Appearance::Light, "light"), (Appearance::Dark, "dark")] {
        h.appearance(appearance);
        h.back_to_shelf()?;
        h.wait(|h| h.pictures_ready())?;
        h.settle()?;
        h.save(&m01, &format!("shelf-{suffix}.png"))?;

        // The pointer on 《夜车》: the heat map shows it alone; the covers
        // turned to sand.
        let id = night_train.clone();
        h.on_shelf(move |s, _, cx| {
            s.turn_covers(dr_view_shelf_art::CoverStyle::Sand, cx);
            s.point_at(&id, true, cx);
        });
        h.wait(|h| h.pictures_ready())?;
        h.settle()?;
        h.save(&m01, &format!("shelf-pointed-{suffix}.png"))?;
        let id = night_train.clone();
        h.on_shelf(move |s, _, cx| {
            s.turn_covers(dr_view_shelf_art::CoverStyle::DEFAULT, cx);
            s.point_at(&id, false, cx);
        });

        h.on_shelf(|s, window, cx| s.start_create(window, cx));
        h.on_shelf(|s, _, cx| {
            if let Some((name, summary)) = s.form_fields() {
                name.update(cx, |f, cx| f.set_text("雾港", cx));
                summary.update(cx, |f, cx| f.set_text("守塔人的女儿回到旧港。", cx));
            }
        });
        h.settle()?;
        h.save(&m01, &format!("shelf-new-{suffix}.png"))?;
        h.on_shelf(|s, window, cx| s.close_dialog(window, cx));

        let book = h.cx.update(|cx| {
            let shelf = h.view.read(cx).shelf.clone().unwrap().view;
            shelf
                .downcast::<Shelf>()
                .ok()
                .and_then(|s| s.read(cx).data.as_ref().map(|d| d.books[0].clone()))
        });
        if let Some(book) = book {
            h.on_shelf(move |s, window, cx| s.ask_trash(book, window, cx));
            h.settle()?;
            h.save(&m01, &format!("shelf-trash-{suffix}.png"))?;
            h.on_shelf(|s, window, cx| s.close_dialog(window, cx));
        }

        // Recently Deleted with one book in it, then back.
        if let Ok(id) = &trashed {
            let id = id.clone();
            let book = h.cx.update(|cx| {
                let shelf = h.view.read(cx).shelf.clone().unwrap().view;
                shelf.downcast::<Shelf>().ok().and_then(|s| {
                    s.read(cx)
                        .data
                        .as_ref()
                        .and_then(|d| d.books.iter().find(|b| b.id == id).cloned())
                })
            });
            if let Some(book) = book {
                h.on_shelf(move |s, window, cx| s.ask_trash(book, window, cx));
                h.on_shelf(|s, window, cx| s.confirm_trash(window, cx));
                h.wait(|h| {
                    let shelf = h.shelf();
                    h.cx.update(|cx| {
                        shelf
                            .read(cx)
                            .data
                            .as_ref()
                            .is_some_and(|d| d.trashed.len() == 1)
                    })
                })?;
                h.on_shelf(|s, window, cx| s.open_deleted(window, cx));
                h.settle()?;
                h.save(&m01, &format!("shelf-deleted-{suffix}.png"))?;
                // 「立即删除」 asks first.
                let gone = {
                    let shelf = h.shelf();
                    h.cx.update(|cx| {
                        shelf
                            .read(cx)
                            .data
                            .as_ref()
                            .and_then(|d| d.trashed.first().cloned())
                    })
                };
                if let Some(gone) = gone {
                    h.on_shelf(move |s, window, cx| s.ask_purge(gone, window, cx));
                    h.settle()?;
                    h.save(&m01, &format!("shelf-purge-{suffix}.png"))?;
                    h.on_shelf(|s, window, cx| s.close_dialog(window, cx));
                }
                let id = id.clone();
                h.on_shelf(move |s, window, cx| s.restore(&id, window, cx));
                h.wait(|h| {
                    let shelf = h.shelf();
                    h.cx.update(|cx| {
                        shelf
                            .read(cx)
                            .data
                            .as_ref()
                            .is_some_and(|d| d.trashed.is_empty())
                    })
                })?;
                h.on_shelf(|s, window, cx| s.close_dialog(window, cx));
            }
        }

        h.on_shelf(|s, window, cx| {
            if !s.menu_open() {
                s.toggle_menu(window, cx);
            }
        });
        h.settle()?;
        h.save(&m01, &format!("shelf-menu-{suffix}.png"))?;
        h.on_shelf(|s, window, cx| s.toggle_menu(window, cx));

        // Project Home of 《慢钟》, after opening two chapters and an element
        // (继续写 leads with the chapter opened last).
        h.open_book(&slow_clock)?;
        let pages: Vec<Target> = h.read(|ws, _| {
            let b = &ws.book;
            [
                b.chapters
                    .get(5)
                    .and_then(|c| c.id.parse().ok().map(Target::Chapter)),
                b.elements
                    .first()
                    .and_then(|e| e.id.parse().ok().map(Target::Element)),
                b.chapters
                    .get(2)
                    .and_then(|c| c.id.parse().ok().map(Target::Chapter)),
            ]
            .into_iter()
            .flatten()
            .collect()
        });
        let opened = pages.len();
        for page in pages {
            h.set(move |ws, _, cx| ws.open(page, Open::KEEP, cx));
            h.settle()?;
        }
        h.set(|ws, _, cx| {
            ws.nav.go_home();
            cx.notify();
        });
        h.wait(|h| {
            let Some(home) = h.home() else {
                return false;
            };
            h.cx.update(|cx| {
                home.read(cx)
                    .stats
                    .as_ref()
                    .is_some_and(|s| s.opened.len() >= opened)
            })
        })?;
        h.on_home(|home, window, cx| home.set_view(HomeView::Overview, window, cx));
        h.settle()?;
        h.save(&m02, &format!("home-{suffix}.png"))?;
        h.on_home(|home, window, cx| home.set_view(HomeView::Settings, window, cx));
        h.settle()?;
        h.save(&m02, &format!("home-settings-{suffix}.png"))?;
        h.on_home(|home, window, cx| home.set_view(HomeView::Overview, window, cx));
        h.on_home(|home, window, cx| home.start_rename(window, cx));
        h.settle()?;
        h.save(&m02, &format!("home-rename-{suffix}.png"))?;
        h.on_home(|home, window, cx| home.finish_rename(None, window, cx));
        // With both sidebars out, as most writing days look.
        h.set(|ws, window, cx| {
            ws.toggle_left(window, cx);
            ws.toggle_right(window, cx);
        });
        h.settle()?;
        h.save(&m02, &format!("home-sidebars-{suffix}.png"))?;
        h.set(|ws, window, cx| {
            ws.toggle_left(window, cx);
            ws.toggle_right(window, cx);
        });
        h.settle()?;
    }
    // The shelf on the sea of characters (M24): a window drawing the sea
    // under the workspace, as the shell's backdrop will; the sea held on as
    // the shell will hold it while the shelf shows.
    let (main_window, main_view) = (h.window, h.view.clone());
    for (round, (appearance, suffix)) in [(Appearance::Light, "light"), (Appearance::Dark, "dark")]
        .into_iter()
        .enumerate()
    {
        h.appearance(appearance);
        let window = h.cx.open_window(size(px(W), px(H)), |window, cx| {
            let ws = cx.new(|cx| Workspace::new(window, cx));
            cx.new(|_| SeaRoot { ws })
        })?;
        let root = window.entity(&h.cx)?;
        h.view = h.cx.update(|cx| root.read(cx).ws.clone());
        h.window = window.into();
        h.cx.update_window(h.window, |_, window, _| window.activate_window())?;
        let hold = h.cx.update_window(h.window, |_, window, cx| {
            dr_view_sea::Sea::of(window, cx).hold(dr_view_sea::HoldKind::Surface, window)
        })?;
        h.wait(|h| h.shelf_ready())?;
        h.wait(|h| h.pictures_ready())?;
        h.settle()?;
        h.save(&m01, &format!("shelf-sea-{suffix}.png"))?;
        // 《慢钟》 is a sample this launch wrote: in light its card lands on
        // a ring of its own; in dark (landed already) a press on the bare
        // desk rings through the cards. Either way its rim flows, waiting.
        if round == 0 {
            let slow = slow_clock.clone();
            h.cx.update(|cx| dr_view_sea::first_run::note_samples_created(vec![slow], cx));
        } else {
            h.cx.update_window(h.window, |_, window, cx| {
                dr_view_sea::Sea::of(window, cx).press(
                    gpui::point(px(W * 0.7), px(H * 0.62)),
                    1.2,
                    window,
                )
            })?;
        }
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(if round == 0 { 900 } else { 650 }) {
            h.draw()?;
            h.cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(16));
        }
        h.save(&m01, &format!("shelf-sea-ring-{suffix}.png"))?;
        drop(hold);
        h.cx.update_window(h.window, |_, window, _| window.remove_window())?;
    }
    h.window = main_window;
    h.view = main_view;
    Ok(())
}

/// Median and maximum of `v`.
fn summary(v: &[f64]) -> String {
    let mut s = v.to_vec();
    s.sort_by(f64::total_cmp);
    let median = s[s.len() / 2];
    let max = s[s.len() - 1];
    format!(
        "{{\"n\": {}, \"median\": {median:.2}, \"max\": {max:.2}}}",
        s.len()
    )
}

fn frames(h: &mut Headless, n: usize) -> Result<Vec<f64>> {
    let mut v = Vec::new();
    for _ in 0..n {
        v.push(h.draw()? as f64);
        h.cx.run_until_parked();
    }
    Ok(v)
}

fn bench(dir: PathBuf) -> Result<()> {
    let load = load_average();
    let mut h = Headless::new(true)?;
    let shelf = h.shelf();
    let shelf_cards_ms = h.cx.update(|cx| shelf.read(cx).cards_ms.unwrap_or(0.0));
    let mut out = vec![format!(
        r#""shelf_first": {{"first_frame_ms": {:.2}, "cards_ms": {:.2}, "shelf_cards_ms": {:.2}}}"#,
        h.first_frame_ms, h.cards_ms, shelf_cards_ms
    )];
    let books_on_shelf = {
        let shelf = h.shelf();
        h.cx.update(|cx| shelf.read(cx).data.as_ref().map_or(0, |d| d.books.len()))
    };
    out.push(format!(r#""books_on_shelf": {books_on_shelf}"#));
    let shelf_frames = frames(&mut h, 60)?;
    out.push(format!(r#""shelf_redraw_ms": {}"#, summary(&shelf_frames)));

    // Opening a book: the first time (F3 opens its documents) and again.
    let books = ["慢钟", "阿Q正传（示例）"];
    let mut cold = Vec::new();
    for name in books {
        let id = h.book_id(name)?;
        cold.push(format!("\"{name}\": {:.2}", h.open_book(&id)?));
        h.back_to_shelf()?;
    }
    // The heavy seed's book, the first time.
    let heavy_name = dr_testkit::seed::Preset::Heavy
        .spec()
        .map(|s| s.book_name)
        .unwrap_or_default();
    let heavy = h.book_id(heavy_name)?;
    cold.push(format!("\"heavy\": {:.2}", h.open_book(&heavy)?));
    h.back_to_shelf()?;
    out.push(format!(r#""open_book_first_ms": {{{}}}"#, cold.join(", ")));
    let mut warm = Vec::new();
    for _ in 0..5 {
        for name in books {
            let id = h.book_id(name)?;
            warm.push(h.open_book(&id)?);
            h.back_to_shelf()?;
        }
    }
    out.push(format!(r#""open_book_again_ms": {}"#, summary(&warm)));
    // Back to the shelf: the cards are there in the next frame.
    let mut back = Vec::new();
    for _ in 0..5 {
        let id = h.book_id("慢钟")?;
        h.open_book(&id)?;
        let started = Instant::now();
        h.set(|ws, window, cx| {
            ws.show_shelf(window, cx);
        });
        h.wait(|h| h.read(|ws, _| ws.shelf_open) && h.shelf_ready())?;
        back.push(ms(started));
    }
    out.push(format!(r#""back_to_shelf_ms": {}"#, summary(&back)));
    let id = h.book_id("慢钟")?;
    h.open_book(&id)?;
    h.settle()?;
    let home_frames = frames(&mut h, 60)?;
    out.push(format!(r#""home_redraw_ms": {}"#, summary(&home_frames)));

    let results: serde_json::Value = serde_json::from_str(&format!(
        "{{\"note\": \"Headless (GPUI test platform, Metal into a texture), {W}x{H} at 2x, the showcase library (8 books) plus the heavy seed's book, read through F3. shelf_first: making the window until its first frame and until the cards drew (the shelf read off the main thread). open_book: from a card's click until the book's lists and Project Home's numbers arrived and a frame drew; the shelf has read every book's lists by then (as in the app), so 'first' means the first time the book's lists, chapter documents' numbers and Project Home are read for it, not a cold F3. Frames are the CPU time of window.draw. One-minute load average when it started: {load:.1}.\", {}}}",
        out.join(", ")
    ))?;
    let mut evidence = dr_testkit::evidence::Evidence::new(
        "shelf-home-bench",
        "m01-m02",
        "cargo run --release -p dr-view-home --features capture --example shelf-home-capture -- --bench ../docs/rust-rewrite/acceptance",
    )
    .inputs(
        &dr_testkit::evidence::workspace_root(),
        &[
            "crates/dr-view-shelf",
            "crates/dr-view-home",
            "crates/dr-shell/src/pages.rs",
            "crates/dr-workspace",
            "crates/dr-testkit/src/samples.rs",
            "crates/dr-testkit/fixtures/shelf.json",
            "crates/dr-testkit/src/seed",
        ],
    )?;
    evidence.corpus = serde_json::json!({ "sample": "showcase", "seed": "heavy" });
    evidence.results = results;
    let path = evidence.write(&dir)?;
    println!("wrote {}", path.display());
    println!("{}", serde_json::to_string_pretty(&evidence.results)?);
    Ok(())
}

/// The one-minute load average (`sysctl vm.loadavg`), 0 when unknown.
fn load_average() -> f64 {
    std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            s.trim_matches(|c: char| c == '{' || c == '}' || c.is_whitespace())
                .split_whitespace()
                .next()
                .and_then(|n| n.parse().ok())
        })
        .unwrap_or(0.0)
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag, dir] if flag == "--capture" => capture(PathBuf::from(dir)),
        [flag, dir] if flag == "--bench" => bench(PathBuf::from(dir)),
        _ => bail!("usage: shelf-home-capture --capture <modules dir> | --bench <acceptance dir>"),
    }
}

/// The sea under the whole window and the bookshelf over it (what the
/// shell's backdrop will do, M24; the workspace's own root, which still
/// lays the desk colour, is left out until the shell clears it).
struct SeaRoot {
    ws: Entity<Workspace>,
}

impl gpui::Render for SeaRoot {
    fn render(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{ParentElement as _, Styled as _};
        let sea = dr_view_sea::Sea::of(window, cx);
        let p = dr_ui::Theme::of(window, cx).palette;
        gpui::div()
            .size_full()
            .relative()
            .bg(p.desk.solid())
            .child(dr_view_sea::char_sea(&sea))
            .children(self.ws.read(cx).shelf.as_ref().map(|shelf| {
                gpui::div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .child(shelf.view.clone())
            }))
    }
}
