//! The plot planner (M15) drawn offscreen, light and dark, into
//! `<dir>/m15/`:
//!
//! ```text
//! cargo run -p dr-view-plot --features capture --example plot-capture -- ../docs/rust-rewrite/modules
//! ```
//!
//! GPUI runs headless (its test platform with the real macOS text system and
//! Metal drawing into a texture): nothing opens on screen. The library is
//! dr-testkit's 《阿Q正传》, seeded into a temporary folder and read through
//! F3; its fourth chapter has the 4 × 4 grid, the first none. The planner
//! fills a window the size of the panel under the paper (the shell does not
//! host it yet).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_ui::{Appearance, sand, theme};
use dr_view_plot::{ClearDialog, Field, PlannerHost, PlotPlanner};
use dr_workspace::Actor;
use dr_workspace::commands::plot_grid::Axis;
use gpui::{
    AnyWindowHandle, AppContext as _, Entity, Focusable as _, HeadlessAppContext, Render, point,
    px, size,
};

const W: f32 = 1100.0;
const H: f32 = 380.0;
const VERSION: &str = "0.2.0-dev";

struct Headless {
    cx: HeadlessAppContext,
    library: dr_workspace::Workspace,
    book: String,
    chapters: Vec<(String, String)>,
    _dir: tempfile::TempDir,
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
        let book = dr_testkit::samples::a_q()?;
        dr_testkit::seed::write_book(&lib, &book).map_err(|e| anyhow::anyhow!("{e}"))?;
        let book_id = book.book_id().to_string();
        lib.close()?;
        let library = dr_workspace::Workspace::open_dir(&root, VERSION)?;
        let list = library.call(
            &Actor::User,
            "chapter.list",
            serde_json::json!({ "book": book_id }),
        )?;
        let chapters = list["output"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|c| {
                        (
                            c["id"].as_str().unwrap_or_default().to_owned(),
                            c["title"].as_str().unwrap_or_default().to_owned(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let services_lib = library.clone();
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
                library: Some(services_lib),
                ..Services::default()
            };
            dr_shell::init(info, services, file, cx);
            Ok(())
        })?;
        Ok(Headless {
            cx,
            library,
            book: book_id,
            chapters,
            _dir: dir,
        })
    }

    fn host(&self, chapter: usize) -> PlannerHost {
        let (id, title) = self.chapters[chapter].clone();
        PlannerHost {
            library: self.library.clone(),
            book: self.book.clone(),
            node: id.clone(),
            title,
            mark: sand::Kind::Chapter(dr_shell::book::seal_of(&id)),
            color: None,
        }
    }

    fn open_planner(&mut self, chapter: usize) -> Result<(AnyWindowHandle, Entity<PlotPlanner>)> {
        let host = self.host(chapter);
        let window = self.cx.open_window(size(px(W), px(H)), move |window, cx| {
            cx.new(|cx| PlotPlanner::new(host, window, cx))
        })?;
        let view = window.entity(&self.cx)?;
        let any: AnyWindowHandle = window.into();
        self.cx
            .update_window(any, |_, window, _| window.activate_window())
            .ok();
        self.wait(any, |h| h.cx.update(|cx| view.read(cx).is_loaded()))?;
        Ok((any, view))
    }

    fn draw(&mut self, window: AnyWindowHandle) -> Result<()> {
        self.cx.update_window(window, |root, window, cx| {
            window.simulate_next_frame(cx);
            cx.notify(root.entity_id());
            window.draw(cx).clear(cx);
        })
    }

    fn wait(
        &mut self,
        window: AnyWindowHandle,
        done: impl Fn(&mut Headless) -> bool,
    ) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            self.draw(window)?;
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
    fn settle(&mut self, window: AnyWindowHandle) -> Result<()> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(600) {
            self.draw(window)?;
            self.cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(16));
        }
        Ok(())
    }

    /// Writes the window as a 256-colour PNG (as dr-shell's capture does).
    fn save(&mut self, window: AnyWindowHandle, dir: &Path, name: &str) -> Result<()> {
        let image = self.cx.capture_screenshot(window)?;
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

    fn close(&mut self, window: AnyWindowHandle) {
        self.cx
            .update_window(window, |_, window, _| window.remove_window())
            .ok();
        self.cx.run_until_parked();
    }
}

/// The clear question as a window of its own (the shell shows it over the
/// workspace).
struct Dialog(Entity<ClearDialog>);

impl Render for Dialog {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        self.0.clone()
    }
}

fn capture(dir: PathBuf) -> Result<()> {
    let mut h = Headless::new()?;
    let out = dir.join("m15");
    for (appearance, suffix) in [(Appearance::Light, "light"), (Appearance::Dark, "dark")] {
        h.cx.update(|cx| theme::force_appearance(Some(appearance), cx));

        // The sample's grid.
        let (window, view) = h.open_planner(3)?;
        h.settle(window)?;
        h.save(window, &out, &format!("plot-grid-{suffix}.png"))?;

        // The caret in an empty slip: its glass and 「写点什么…」.
        let (row, col) = h.cx.update(|cx| {
            let g = view.read(cx).grid();
            (g.rows[1].id.clone(), g.cols[3].id.clone())
        });
        let slip =
            h.cx.update(|cx| view.read(cx).field(&Field::Cell(row.clone(), col)));
        if let Some(slip) = slip {
            h.cx.update_window(window, |_, window, cx| {
                let handle = slip.read(cx).focus_handle(cx);
                window.focus(&handle, cx);
            })
            .ok();
            h.settle(window)?;
            h.save(window, &out, &format!("plot-slip-{suffix}.png"))?;
            h.cx.update_window(window, |_, window, cx| {
                let handle = view.read(cx).focus_handle(cx);
                window.focus(&handle, cx);
            })
            .ok();
        }

        // The header menu of 吴妈 (three slips of hers would go).
        h.cx.update(|cx| view.update(cx, |p, cx| p.toggle_menu(Axis::Row, &row, cx)));
        h.settle(window)?;
        h.save(window, &out, &format!("plot-menu-{suffix}.png"))?;
        h.cx.update(|cx| view.update(cx, |p, cx| p.toggle_menu(Axis::Row, &row, cx)));

        // The grip dragged: the size readout.
        h.cx.update(|cx| {
            view.update(cx, |p, cx| {
                p.start_drag(point(px(800.0), px(300.0)), cx);
                p.drag_to(point(px(880.0), px(340.0)), cx);
            })
        });
        h.settle(window)?;
        h.save(window, &out, &format!("plot-resize-{suffix}.png"))?;
        h.cx.update_window(window, |_, window, cx| {
            view.update(cx, |p, cx| {
                // Put back without storing: the next shots keep the
                // sample's size.
                p.drag_to(point(px(800.0), px(300.0)), cx);
                p.end_drag(window, cx);
            })
        })
        .ok();

        // 清空's question.
        let weak = view.downgrade();
        let dialog = h.cx.open_window(size(px(W), px(H)), move |_, cx| {
            let d = cx.new(|cx| ClearDialog::new(weak, cx));
            cx.new(|_| Dialog(d))
        })?;
        let dialog: AnyWindowHandle = dialog.into();
        h.settle(dialog)?;
        h.save(dialog, &out, &format!("plot-clear-{suffix}.png"))?;
        h.close(dialog);
        h.close(window);

        // A chapter without a grid: the empty 3 × 3 one.
        let (window, _) = h.open_planner(0)?;
        h.settle(window)?;
        h.save(window, &out, &format!("plot-empty-{suffix}.png"))?;
        h.close(window);
    }
    Ok(())
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        bail!("usage: plot-capture <docs/rust-rewrite/modules>");
    };
    capture(PathBuf::from(dir))
}
