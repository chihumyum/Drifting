//! Screenshots of M41's moving dialogs over the shell, drawn offscreen
//! (GPUI's headless platform, real text and Metal, nothing on screen): a
//! `.driftingbook` importing and refused, 「导入文件」 with files read, a
//! finished backup and the question before a restore. The book behind is
//! 《慢钟》 from dr-testkit; the files are synthetic.
//!
//! ```text
//! cargo run -p dr-view-transfer --features capture --example transfer-capture -- <docs/rust-rewrite/modules>
//! ```
//!
//! Writes `m41/transfer-*.png`, light and dark, as 256-colour PNGs.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_ui::{Appearance, theme};
use dr_view_transfer::{State, TransferDialog, backup, documents};
use gpui::{AnyWindowHandle, AppContext as _, Entity, HeadlessAppContext, px, size};

const W: f32 = 1280.0;
const H: f32 = 800.0;
const VERSION: &str = "0.2.0-dev";

struct Headless {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    view: Entity<Workspace>,
    library: dr_workspace::Workspace,
    dir: tempfile::TempDir,
}

impl Headless {
    fn new(appearance: Appearance) -> Result<Headless> {
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
        let shell_lib = library.clone();
        cx.update(|cx| -> Result<()> {
            dr_ui::init(cx)?;
            let info = ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(appearance),
            };
            let mut file = SettingsFile::in_memory();
            file.set(
                dr_shell::settings::registry::UI_LOCALE,
                "zh-CN".into(),
                None,
            )
            .ok();
            let services = Services {
                library: Some(shell_lib),
                ..Services::default()
            };
            dr_shell::init(info, services, file, cx);
            dr_view_transfer::init(cx);
            theme::force_appearance(Some(appearance), cx);
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
            library,
            dir,
        };
        h.wait(|h| {
            let view = h.view.clone();
            h.cx.update(|cx| !view.read(cx).book.is_empty())
        })?;
        h.settle()?;
        Ok(h)
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
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            self.draw()?;
            self.cx.run_until_parked();
            if done(self) {
                return Ok(());
            }
            if Instant::now() > deadline {
                bail!("timed out");
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn settle(&mut self) -> Result<()> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(600) {
            self.draw()?;
            self.cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(16));
        }
        Ok(())
    }

    fn close_dialog(&mut self) -> Result<()> {
        let view = self.view.clone();
        self.cx.update(|cx| {
            view.update(cx, |ws, cx| {
                ws.dialog = None;
                cx.notify();
            })
        });
        self.settle()
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

fn run(out: PathBuf) -> Result<()> {
    let m41 = out.join("m41");
    for appearance in [Appearance::Light, Appearance::Dark] {
        let a = appearance.slug();
        let mut h = Headless::new(appearance)?;

        // A .driftingbook importing, part way.
        h.cx.update(|cx| {
            TransferDialog::show(
                State::Working {
                    title: dr_i18n::keys::project_picker::desk::IMPORTING,
                    name: "慢钟.driftingbook".into(),
                    progress: Some(0.42),
                },
                cx,
            );
        });
        h.settle()?;
        h.save(&m41, &format!("transfer-book-importing-{a}.png"))?;
        h.close_dialog()?;

        // A 0.1 book file: refused, and why.
        let legacy = h.dir.path().join("旧书.driftingbook");
        let mut cbor = vec![0xa7, 0x66];
        cbor.extend_from_slice(b"format\x6ddrifting.book");
        std::fs::write(&legacy, &cbor)?;
        let lib = h.library.clone();
        let d =
            h.cx.update(|cx| dr_view_transfer::book::import_path(lib, legacy, cx));
        h.wait(|h| !h.cx.update(|cx| d.read(cx).is_working()))?;
        h.settle()?;
        h.save(&m41, &format!("transfer-book-refused-{a}.png"))?;
        h.close_dialog()?;

        // 「导入文件」 with three files read.
        let drafts = h.dir.path().join("drafts");
        std::fs::create_dir_all(&drafts)?;
        std::fs::write(
            drafts.join("01 钟楼.md"),
            "# 钟楼\n\n钟楼在镇口的石桥边上。\n\n> 「四点十七分。」\n",
        )?;
        std::fs::write(
            drafts.join("02 修理单.txt"),
            "修理单\n\n第三张单子上写着日期。",
        )?;
        std::fs::write(drafts.join("03 雨夜.markdown"), "雨夜。**她没回头。**")?;
        let lib = h.library.clone();
        let book = {
            let view = h.view.clone();
            h.cx.update(|cx| view.read(cx).book_id.clone())
        };
        let d = h.cx.update(|cx| documents::show(lib, book, cx));
        let files: Vec<PathBuf> = std::fs::read_dir(&drafts)?
            .map(|e| e.map(|e| e.path()))
            .collect::<Result<_, _>>()?;
        let dd = d.clone();
        h.cx.update_window(h.window, |_, window, cx| {
            dd.update(cx, |d, cx| d.add(files, window, cx))
        })?;
        h.wait(|h| h.cx.update(|cx| d.read(cx).ready() == 3))?;
        h.settle()?;
        h.save(&m41, &format!("transfer-documents-{a}.png"))?;
        h.close_dialog()?;

        // A backup written, then the question before restoring it.
        let file = h.dir.path().join("Drifting-2026-11-08.drifting");
        let lib = h.library.clone();
        let d = h.cx.update(|cx| backup::backup_path(lib, file.clone(), cx));
        h.wait(|h| !h.cx.update(|cx| d.read(cx).is_working()))?;
        h.settle()?;
        h.save(&m41, &format!("transfer-backup-{a}.png"))?;
        h.close_dialog()?;
        let lib = h.library.clone();
        let replace: backup::Replace = std::rc::Rc::new(|_, _, cx| {
            cx.background_executor()
                .spawn(async { Err("not in a picture".to_owned()) })
        });
        let d =
            h.cx.update(|cx| backup::restore_path(lib, file, replace, cx));
        h.wait(|h| !h.cx.update(|cx| d.read(cx).is_working()))?;
        h.settle()?;
        h.save(&m41, &format!("transfer-restore-{a}.png"))?;
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
