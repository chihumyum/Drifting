//! Screenshots of M06 (search) and M07 (the Stats tab) in the shell, drawn
//! offscreen like `shell-capture` (GPUI's headless platform, real text and
//! Metal, nothing on screen). The book is 《慢钟》 from dr-testkit with a
//! week of synthetic writing days.
//!
//! ```text
//! cargo run -p dr-shell --features capture --example m06-m07-capture -- <docs/rust-rewrite/modules>
//! ```
//!
//! Writes `m06/*.png` and `m07/*.png` under the folder given, as 256-colour
//! PNGs.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use dr_shell::nav::{Open, Target};
use dr_shell::workspace::{LeftTab, RightTab};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_ui::{Appearance, anim, theme};
use gpui::{AnyWindowHandle, AppContext as _, Context, Entity, HeadlessAppContext, px, size};
use serde_json::json;

const W: f32 = 1280.0;
const H: f32 = 800.0;
const VERSION: &str = "0.2.0-dev";
/// A synthetic device, for the writing days of the pictures.
const DEVICE: &str = "device-0123456789abcdef01234567";

struct Headless {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    view: Entity<Workspace>,
    _library: tempfile::TempDir,
}

fn slow_clock() -> Result<(tempfile::TempDir, dr_workspace::Workspace)> {
    let dir = tempfile::tempdir()?;
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION))?;
    let book = dr_testkit::samples::slow_clock()?;
    dr_testkit::seed::write_book(&lib, &book).map_err(|e| anyhow::anyhow!("{e}"))?;
    lib.close()?;
    let ws = dr_workspace::Workspace::open_dir(&root, VERSION)?;
    // Count every document now, and give the book a week of writing.
    for d in ws.library().docs(None, None)? {
        ws.library().reindex_doc(&d.doc_id)?;
    }
    let books = ws.call(&dr_workspace::Actor::User, "book.list", json!({}))?;
    let book = books["output"][0]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let today = dr_view_stats::clock::today();
    let n = dr_workspace::commands::stats::day_number(&today);
    for (back, words) in [
        (6, 820),
        (5, 1460),
        (4, 0),
        (3, 1210),
        (2, 1890),
        (1, 640),
        (0, 930),
    ] {
        let day = dr_workspace::commands::stats::day_of_number(n - back);
        ws.call(
            &dr_workspace::Actor::User,
            "writing_day.record",
            json!({"book": book, "device": DEVICE, "day": day.to_string(), "words": words}),
        )?;
    }
    Ok((dir, ws))
}

impl Headless {
    fn new() -> Result<Headless> {
        let text_system = gpui_platform::current_platform(true).text_system();
        let mut cx = HeadlessAppContext::with_platform(
            text_system,
            Arc::new(dr_ui::Assets::new()),
            gpui_platform::current_headless_renderer,
        );
        cx.allow_parking();
        let (dir, library) = slow_clock()?;
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
            Ok(())
        })?;
        let window = cx.open_window(size(px(W), px(H)), |window, cx| {
            cx.new(|cx| Workspace::new(window, cx))
        })?;
        let view = window.entity(&cx)?;
        let mut h = Headless {
            cx,
            window: window.into(),
            view,
            _library: dir,
        };
        h.wait(|ws, _| !ws.book.is_empty())?;
        Ok(h)
    }

    fn wait(&mut self, done: impl Fn(&Workspace, &gpui::App) -> bool) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            self.draw()?;
            self.cx.run_until_parked();
            let view = self.view.clone();
            if self.cx.update(|cx| done(view.read(cx), cx)) {
                return Ok(());
            }
            if Instant::now() > deadline {
                bail!("timed out");
            }
            std::thread::sleep(Duration::from_millis(5));
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

    fn draw(&mut self) -> Result<()> {
        let view = self.view.clone();
        self.cx.update_window(self.window, |_, window, cx| {
            window.simulate_next_frame(cx);
            view.update(cx, |_, cx| cx.notify());
            window.draw(cx).clear(cx);
        })
    }

    /// Lets every read finish and every animation land.
    fn still(&mut self) -> Result<()> {
        for _ in 0..40 {
            self.draw()?;
            self.cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(10));
        }
        let t0 = Instant::now();
        anim::freeze(Some(t0));
        for _ in 0..5 {
            self.draw()?;
            self.cx.run_until_parked();
        }
        anim::freeze(Some(t0 + Duration::from_secs(3)));
        for _ in 0..5 {
            self.draw()?;
            self.cx.run_until_parked();
        }
        anim::freeze(None);
        Ok(())
    }

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
}

fn chapter(ws: &Workspace, n: usize) -> Target {
    Target::Chapter(ws.book.chapters[n - 1].id.parse().unwrap())
}

/// Chapters on the left, `right` on the right, the first chapters open.
fn layout(
    ws: &mut Workspace,
    right: RightTab,
    window: &mut gpui::Window,
    cx: &mut Context<Workspace>,
) {
    ws.search = None;
    if !ws.left.open {
        ws.toggle_left(window, cx);
    }
    if !ws.right.open {
        ws.toggle_right(window, cx);
    }
    ws.left.width = 280.0;
    ws.right.width = 320.0;
    ws.left.reveal.set(1.0);
    ws.right.reveal.set(1.0);
    ws.left.panes = dr_shell::panes::Panes::single(LeftTab::Chapters);
    ws.right.panes = dr_shell::panes::Panes::single(right);
    while ws.nav.close(0) {}
    ws.dock_locked = true;
}

fn run(out: PathBuf) -> Result<()> {
    let (m06, m07) = (out.join("m06"), out.join("m07"));
    std::fs::create_dir_all(&m06)?;
    std::fs::create_dir_all(&m07)?;
    let mut h = Headless::new()?;
    for appearance in [Appearance::Light, Appearance::Dark] {
        let a = appearance.slug();
        h.cx.update(|cx| theme::force_appearance(Some(appearance), cx));

        // M07: a chapter, a storyline, the whole book.
        h.set(|ws, window, cx| {
            layout(ws, RightTab::Stats, window, cx);
            let c = chapter(ws, 3);
            ws.open(c, Open::KEEP, cx);
        });
        h.still()?;
        h.save(&m07, &format!("stats-chapter-{a}.png"))?;

        h.set(|ws, window, cx| {
            layout(ws, RightTab::Stats, window, cx);
            let sl = Target::Storyline(ws.book.storylines[0].id.parse().unwrap());
            ws.open(sl, Open::KEEP, cx);
        });
        h.still()?;
        h.save(&m07, &format!("stats-storyline-{a}.png"))?;

        h.set(|ws, window, cx| {
            layout(ws, RightTab::Stats, window, cx);
            ws.open(Target::Book, Open::KEEP, cx);
        });
        h.still()?;
        h.save(&m07, &format!("stats-book-{a}.png"))?;

        // M06: the panel over the workspace with a query, then a jump.
        h.set(|ws, window, cx| {
            layout(ws, RightTab::Library, window, cx);
            let c = chapter(ws, 1);
            ws.open(c, Open::KEEP, cx);
            ws.toggle_search(window, cx);
            if let Some(panel) = ws.search.clone() {
                panel.update(cx, |p, cx| p.set_query("钟", cx));
            }
        });
        h.wait(|ws, cx| {
            ws.search
                .as_ref()
                .is_some_and(|p| !p.read(cx).is_searching() && !p.read(cx).groups().is_empty())
        })?;
        h.still()?;
        h.save(&m06, &format!("search-{a}.png"))?;

        h.set(|ws, _, cx| {
            if let Some(panel) = ws.search.clone() {
                panel.update(cx, |p, cx| p.set_query("沈知微", cx));
            }
        });
        h.wait(|ws, cx| {
            ws.search
                .as_ref()
                .is_some_and(|p| !p.read(cx).is_searching() && !p.read(cx).groups().is_empty())
        })?;
        h.still()?;
        h.save(&m06, &format!("search-name-{a}.png"))?;
    }
    Ok(())
}

fn main() -> Result<()> {
    let out = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../docs/rust-rewrite/modules"));
    run(out)
}
