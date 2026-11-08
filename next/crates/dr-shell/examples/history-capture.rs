//! Screenshots of M09 (snapshot history) in the shell, drawn offscreen like
//! dr-shell's `m06-m07-capture` (GPUI's headless platform, real text and
//! Metal, nothing on screen). The book is 《慢钟》 from dr-testkit; its first
//! chapter gets a few synthetic history points: the author added a line,
//! then another, then renamed the chapter, over three days.
//!
//! ```text
//! cargo run -p dr-shell --features capture --example history-capture -- <docs/rust-rewrite/modules>
//! ```
//!
//! Writes `m09/history-*.png` under the folder given, as 256-colour PNGs.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use dr_shell::nav::{Open, Target};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_store::history::LabelRetention;
use dr_ui::{Appearance, anim, theme};
use dr_workspace::Actor;
use gpui::{AnyWindowHandle, AppContext as _, Context, Entity, HeadlessAppContext, px, size};
use serde_json::json;

const W: f32 = 1280.0;
const H: f32 = 800.0;
const VERSION: &str = "0.2.0-dev";
const HOUR_MS: i64 = 3_600_000;

struct Headless {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    view: Entity<Workspace>,
    /// The chapter whose history is shown, and its title now.
    doc: String,
    title: String,
    _library: tempfile::TempDir,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 《慢钟》 with a history on its first chapter.
fn library() -> Result<(tempfile::TempDir, dr_workspace::Workspace, String, String)> {
    let dir = tempfile::tempdir()?;
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION))?;
    let book = dr_testkit::samples::slow_clock()?;
    dr_testkit::seed::write_book(&lib, &book).map_err(|e| anyhow::anyhow!("{e}"))?;
    lib.close()?;
    let ws = dr_workspace::Workspace::open_dir(&root, VERSION)?;
    for d in ws.library().docs(None, None)? {
        ws.library().reindex_doc(&d.doc_id)?;
    }
    let me = &Actor::User;
    let books = ws.call(me, "book.list", json!({}))?;
    let book = books["output"][0]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let chapters = ws.call(me, "chapter.list", json!({"book": book}))?;
    let chapter = chapters["output"][0]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let first = chapters["output"][0]["title"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let doc = format!("node:{chapter}");
    let id = dr_model::DocId::parse(&doc).map_err(|e| anyhow::anyhow!("{e}"))?;
    // The earlier versions are written as an import would write them: the
    // author's own commits would make storage take a point "now" at once.
    let handle = ws.library().open_doc(&doc, dr_store::OpenDoc::Existing)?;
    let write = |text: &'static str| -> Result<()> {
        let id = id.clone();
        handle
            .write(dr_store::Origin::Import, move |d| {
                let b = dr_doc::prose::BorrowedProse::new(d, &id)?;
                b.txn().insert_paragraphs(0, text).map(|_| ())
            })?
            .0?;
        Ok(())
    };
    let point = |ago_ms: i64| -> Result<()> {
        let head = ws
            .library()
            .head(&doc)?
            .ok_or_else(|| anyhow::anyhow!("no head"))?;
        ws.library().label_at(
            &doc,
            &head.frontiers,
            "periodic",
            now_ms() - ago_ms,
            LabelRetention::Thinned,
        )?;
        Ok(())
    };
    point(72 * HOUR_MS)?;
    write("钟楼上的钟慢了七分钟，镇上没有人去拨它。\n")?;
    point(26 * HOUR_MS)?;
    write("那年秋天，雨下得比往年都早。\n")?;
    point(5 * HOUR_MS)?;
    let title = format!("{first}（改）");
    ws.call(
        me,
        "chapter.update",
        json!({"book": book, "id": chapter, "title": title}),
    )?;
    write("她把信折好，放回抽屉。\n")?;
    point(40 * 60_000)?;
    drop(handle);
    for d in ws.library().docs(None, None)? {
        ws.library().reindex_doc(&d.doc_id)?;
    }
    Ok((dir, ws, doc, title))
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
        let (dir, library, doc, title) = library()?;
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
            doc,
            title,
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

    /// The dialog's points once read.
    fn points(&mut self) -> Result<Vec<i64>> {
        self.wait(|ws, cx| {
            ws.history
                .as_ref()
                .is_some_and(|d| d.read(cx).points().is_some())
        })?;
        let view = self.view.clone();
        Ok(self.cx.update(|cx| {
            view.read(cx)
                .history
                .as_ref()
                .and_then(|d| {
                    d.read(cx)
                        .points()
                        .map(|p| p.iter().map(|p| p.id).collect())
                })
                .unwrap_or_default()
        }))
    }
}

fn run(out: PathBuf) -> Result<()> {
    let m09 = out.join("m09");
    std::fs::create_dir_all(&m09)?;
    let mut h = Headless::new()?;
    for appearance in [Appearance::Light, Appearance::Dark] {
        let a = appearance.slug();
        h.cx.update(|cx| theme::force_appearance(Some(appearance), cx));
        let (doc, title) = (h.doc.clone(), h.title.clone());
        h.set(move |ws, window, cx| {
            ws.history = None;
            let chapter = Target::Chapter(doc["node:".len()..].parse().unwrap());
            ws.open(chapter, Open::KEEP, cx);
            ws.open_history(doc.clone(), &title, window, cx);
        });
        let points = h.points()?;
        // Yesterday's point, its preview open.
        let pick = points
            .get(points.len().saturating_sub(2))
            .copied()
            .unwrap_or_default();
        h.set(move |ws, _, cx| {
            if let Some(d) = ws.history.clone() {
                d.update(cx, |d, cx| d.select(pick, cx));
            }
        });
        h.still()?;
        h.save(&m09, &format!("history-{a}.png"))?;
        // 「恢复…」 asks once more.
        h.set(move |ws, _, cx| {
            if let Some(d) = ws.history.clone() {
                d.update(cx, |d, cx| d.ask_restore(pick, cx));
            }
        });
        h.still()?;
        h.save(&m09, &format!("history-confirm-{a}.png"))?;
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
