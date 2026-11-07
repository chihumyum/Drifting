//! The element and category pages (M11) drawn offscreen, light and dark,
//! into `<dir>/m11/`:
//!
//! ```text
//! cargo run -p dr-view-elements --features capture --example elements-capture -- ../docs/rust-rewrite/modules
//! ```
//!
//! GPUI runs headless (its test platform with the real macOS text system and
//! Metal drawing into a texture): nothing opens on screen. The library is
//! dr-testkit's 《慢钟》, seeded into a temporary folder and read through F3.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use dr_shell::nav::{Open, Target};
use dr_shell::workspace::LeftTab;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_ui::{Appearance, theme};
use gpui::{
    AnyWindowHandle, AppContext as _, Context, Entity, Focusable as _, HeadlessAppContext, px, size,
};

const W: f32 = 1280.0;
const H: f32 = 800.0;
const VERSION: &str = "0.2.0-dev";

struct Headless {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    view: Entity<Workspace>,
    _library: tempfile::TempDir,
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
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("library");
        let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION))?;
        let book = dr_testkit::samples::slow_clock()?;
        dr_testkit::seed::write_book(&lib, &book).map_err(|e| anyhow::anyhow!("{e}"))?;
        lib.close()?;
        let library = dr_workspace::Workspace::open_dir(&root, VERSION)?;
        library.library().rebuild_stale_indexes()?;
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
            dr_view_elements::init(cx);
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
        // Focus listeners (a field reporting it was left) need an active
        // window.
        h.in_window(|window, _| window.activate_window());
        h.wait(|h| h.read(|ws, _| !ws.book.is_empty()))?;
        Ok(h)
    }

    fn read<T>(&mut self, f: impl FnOnce(&Workspace, &gpui::App) -> T) -> T {
        let view = self.view.clone();
        self.cx.update(|cx| f(view.read(cx), cx))
    }

    fn set(&mut self, f: impl FnOnce(&mut Workspace, &mut gpui::Window, &mut Context<Workspace>)) {
        let view = self.view.clone();
        self.cx
            .update_window(self.window, |_, window, cx| {
                view.update(cx, |ws, cx| f(ws, window, cx))
            })
            .ok();
    }

    fn in_window(&mut self, f: impl FnOnce(&mut gpui::Window, &mut gpui::App)) {
        self.cx
            .update_window(self.window, |_, window, cx| f(window, cx))
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

    /// Draws for a little over the longest motion (420 ms).
    fn settle(&mut self) -> Result<()> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(600) {
            self.draw()?;
            self.cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(16));
        }
        Ok(())
    }

    fn open(&mut self, target: Target) -> Result<()> {
        self.set(move |ws, _, cx| ws.open(target, Open::KEEP, cx));
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
}

fn capture(dir: PathBuf) -> Result<()> {
    let mut h = Headless::new()?;
    let out = dir.join("m11");
    let (zhiwei, people) = h.read(|ws, _| {
        let e = ws
            .book
            .elements
            .iter()
            .find(|e| e.name == "沈知微")
            .cloned();
        let c = ws
            .book
            .categories
            .iter()
            .find(|c| c.name == "人物")
            .cloned();
        (e, c)
    });
    let zhiwei = zhiwei.context("沈知微 in 《慢钟》")?;
    let people = people.context("人物 in 《慢钟》")?;
    let element = Target::Element(zhiwei.id.parse()?);
    let category = Target::Category(people.id.parse()?);
    // The elements panel out on the left, as when working on them.
    h.set(|ws, window, cx| {
        ws.left.panes.reveal(LeftTab::Elements);
        if !ws.left.open {
            ws.toggle_left(window, cx);
        }
    });
    for (appearance, suffix) in [(Appearance::Light, "light"), (Appearance::Dark, "dark")] {
        h.cx.update(|cx| theme::force_appearance(Some(appearance), cx));
        h.open(element.clone())?;
        h.wait(|h| {
            h.cx.update(|cx| dr_view_elements::element_page(&zhiwei.id, cx).is_some())
        })?;
        h.settle()?;
        h.save(&out, &format!("element-{suffix}.png"))?;

        // The caret in a field: the slip is the still selected glass.
        let pages =
            h.cx.update(|cx| dr_view_elements::element_page(&zhiwei.id, cx));
        let (head, fields) = pages.context("the element page")?;
        let rows = h.cx.update(|cx| fields.read(cx).rows());
        if let Some((_, _, value)) = rows.first().cloned() {
            h.in_window(|window, cx| value.focus_handle(cx).focus(window, cx));
            h.settle()?;
            h.save(&out, &format!("element-field-{suffix}.png"))?;
            h.set(|ws, window, cx| ws.focus_handle().clone().focus(window, cx));
        }

        // An alias another element has: the 0.1 alert.
        let alias = h.cx.update(|cx| head.read(cx).fields().1);
        h.in_window(|window, cx| alias.focus_handle(cx).focus(window, cx));
        h.settle()?;
        h.cx.update(|cx| alias.update(cx, |f, cx| f.set_text("远舟", cx)));
        h.set(|ws, window, cx| ws.focus_handle().clone().focus(window, cx));
        h.wait(|h| h.cx.update(|cx| head.read(cx).alert.is_some()))?;
        h.settle()?;
        h.save(&out, &format!("element-alert-{suffix}.png"))?;
        h.cx.update(|cx| {
            head.update(cx, |head, cx| {
                head.alert = None;
                cx.notify();
            })
        });

        h.open(category.clone())?;
        h.wait(|h| {
            h.cx.update(|cx| {
                dr_view_elements::category_page(&people.id, cx)
                    .is_some_and(|(_, end)| end.read(cx).words_read())
            })
        })?;
        h.settle()?;
        h.save(&out, &format!("category-{suffix}.png"))?;
    }
    Ok(())
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        bail!("usage: elements-capture <docs/rust-rewrite/modules>");
    };
    capture(PathBuf::from(dir))
}
