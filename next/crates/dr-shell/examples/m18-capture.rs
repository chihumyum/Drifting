//! Screenshots of M18 (Review) and of the paint layers in the shell, drawn
//! offscreen like `m06-m07-capture` (GPUI's headless platform, real text
//! and Metal, nothing on screen). The book is 《慢钟》 from dr-testkit (its
//! comments and TODOs are synthetic); before the pictures an Agent rewrites
//! a word and adds a few in chapter 1, so its inks show.
//!
//! ```text
//! cargo run -p dr-shell --features capture --example m18-capture -- <docs/rust-rewrite/modules>
//! ```
//!
//! Writes `m18/*.png` under the folder given, as 256-colour PNGs, and
//! prints how long the paint layers took to come up.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use dr_editor::decor::ReviewFocus;
use dr_shell::nav::{Open, Target};
use dr_shell::workspace::{LeftTab, RightTab};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_ui::{Appearance, anim, theme};
use gpui::{
    AnyWindowHandle, AppContext as _, Context, Entity, Focusable, HeadlessAppContext, px, size,
};
use serde_json::{Value, json};

const W: f32 = 1280.0;
const H: f32 = 800.0;
const VERSION: &str = "0.2.0-dev";

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
    // Count every document now.
    for d in ws.library().docs(None, None)? {
        ws.library().reindex_doc(&d.doc_id)?;
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
            // Transitions run on the executor's clock.
            self.cx.advance_clock(Duration::from_millis(50));
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

/// Chapters on the left, Review on the right, the first chapter open.
fn layout(ws: &mut Workspace, window: &mut gpui::Window, cx: &mut Context<Workspace>) {
    ws.search = None;
    if !ws.left.open {
        ws.toggle_left(window, cx);
    }
    if !ws.right.open {
        ws.toggle_right(window, cx);
    }
    ws.left.width = 240.0;
    ws.right.width = 340.0;
    ws.left.reveal.set(1.0);
    ws.right.reveal.set(1.0);
    ws.left.panes = dr_shell::panes::Panes::single(LeftTab::Chapters);
    ws.right.panes = dr_shell::panes::Panes::single(RightTab::Review);
    ws.dock_locked = true;
}

/// The Agent rewrites a word and adds a few in chapter 1 (two writes, so
/// both inks show): a synthetic turn on synthetic text.
fn agent_writes(ws: &dr_workspace::Workspace, doc: &str) -> Result<()> {
    let read = ws.call(
        &dr_workspace::Actor::User,
        "prose.read",
        json!({"doc": doc}),
    )?;
    let paragraphs: Vec<String> = read["output"]["paragraphs"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p["text"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let agent = dr_workspace::Actor::agent("capture", 1, "c");
    let long: Vec<&String> = paragraphs
        .iter()
        .filter(|p| p.chars().count() > 30)
        .collect();
    if let Some(p) = long.first() {
        let word: String = p.chars().skip(4).take(2).collect();
        ws.call(
            &agent,
            "prose.replace",
            json!({"doc": doc, "find": word, "replace": "钟楼底下"}),
        )?;
    }
    if let Some(p) = long.get(1) {
        let tail: String = p.chars().skip(8).take(4).collect();
        let more = format!("{tail}，一下一下地");
        ws.call(
            &agent,
            "prose.replace",
            json!({"doc": doc, "find": tail, "replace": more}),
        )?;
    }
    Ok(())
}

fn run(out: PathBuf) -> Result<()> {
    let dir = out.join("m18");
    std::fs::create_dir_all(&dir)?;
    let mut h = Headless::new()?;
    let lib =
        h.cx.update(|cx| h.view.read(cx).library.clone())
            .expect("a library");
    let first = h.cx.update(|cx| chapter(h.view.read(cx), 1));
    let doc = format!(
        "node:{}",
        h.cx.update(|cx| h.view.read(cx).book.chapters[0].id.clone())
    );

    let comment_id = first_comment(&lib, &mut h)?.expect("《慢钟》 has comments on chapter 1");
    // How long the layers take to come up when the chapter opens (its
    // comments read and placed).
    let opened = Instant::now();
    h.set(|ws, window, cx| {
        layout(ws, window, cx);
        ws.open(first.clone(), Open::KEEP, cx);
    });
    let (target, comment) = (first.clone(), comment_id.clone());
    h.wait(move |ws, cx| {
        ws.editor_of(&target).is_some_and(|e| {
            let prose = e.read(cx).editor().clone();
            prose
                .read(cx)
                .decoration_range(0, "comments", &comment)
                .is_some()
        })
    })?;
    let first_paint_ms = opened.elapsed().as_secs_f64() * 1e3;
    let editor =
        h.cx.update(|cx| h.view.read(cx).editor_of(&first).cloned())
            .expect("an editor");
    // The Agent writes while the chapter is open (the ledger was made with
    // it; earlier turns are history and are not coloured).
    let written = Instant::now();
    agent_writes(&lib, &doc)?;
    let probe = editor.clone();
    h.wait(move |_, cx| {
        let prose = probe.read(cx).editor().clone();
        let p = prose.read(cx);
        (1..10).any(|n| p.decoration_range(0, "agent", &format!("m{n}")).is_some())
    })?;
    let agent_ms = written.elapsed().as_secs_f64() * 1e3;
    let looks_ms = h.cx.update(|cx| {
        let looks = dr_editor::decor::DecorLooks::new(
            &dr_ui::tokens::Palette::LIGHT,
            gpui::hsla(0.58, 0.7, 0.42, 1.0),
            false,
        );
        let t = Instant::now();
        editor.update(cx, |e, cx| e.set_decor_looks(looks, cx));
        t.elapsed().as_secs_f64() * 1e3
    });
    let chars =
        h.cx.update(|cx| editor.read(cx).plain_text(cx).chars().count());

    for appearance in [Appearance::Light, Appearance::Dark] {
        let a = appearance.slug();
        h.cx.update(|cx| theme::force_appearance(Some(appearance), cx));

        // The Review tab beside chapter 1: comment sand, the Agent's inks,
        // links and suggestions, ticks; the first card pointed at.
        h.set(|ws, window, cx| {
            layout(ws, window, cx);
            ws.open(first.clone(), Open::KEEP, cx);
        });
        h.still()?;
        {
            let id = &comment_id;
            // The caret at its start brings it into view.
            let (probe, find) = (editor.clone(), id.clone());
            h.set(move |_, window, cx| {
                let prose = probe.read(cx).editor().clone();
                let at = prose
                    .read(cx)
                    .decoration_range(0, "comments", &find)
                    .map(|r| r.start);
                if let Some(at) = at {
                    prose.update(cx, |p, cx| {
                        p.select(0, at.saturating_sub(40)..at.saturating_sub(40), window, cx)
                    });
                }
            });
            let id = id.clone();
            h.cx.update(|cx| ReviewFocus::point_cards(vec![id], cx));
        }
        h.still()?;
        h.save(&dir, &format!("review-{a}.png"))?;
        h.cx.update(|cx| ReviewFocus::point_cards(Vec::new(), cx));

        // TODOs only, over the whole project.
        h.cx.update(|cx| {
            if let Some(v) = any_view(cx) {
                v.update(cx, |v, cx| v.set_filter(dr_view_review::Filter::Todos, cx));
            }
        });
        h.still()?;
        h.save(&dir, &format!("review-todo-{a}.png"))?;
        h.cx.update(|cx| {
            if let Some(v) = any_view(cx) {
                v.update(cx, |v, cx| v.set_filter(dr_view_review::Filter::All, cx));
            }
        });

        // The composer beside a selection in chapter 1: a few words of a
        // paragraph in view.
        let editor = editor.clone();
        h.set(move |_, window, cx| {
            let prose = editor.read(cx).editor().clone();
            let words = "没人来取的表";
            let at = {
                let doc = &prose.read(cx).book().chapters[0].doc;
                let text = doc.slice(0..doc.len_chars());
                text.find(words).map_or(30, |b| text[..b].chars().count())
            };
            prose.update(cx, |p, cx| {
                p.select(0, at..at + words.chars().count(), window, cx)
            });
            let focus = prose.read(cx).focus_handle(cx);
            window.focus(&focus, cx);
            window.dispatch_action(Box::new(dr_view_review::NewComment), cx);
        });
        h.still()?;
        h.save(&dir, &format!("composer-{a}.png"))?;
        h.set(|ws, _, cx| {
            ws.composer = None;
            cx.notify();
        });
    }
    println!(
        "chapter 1 ({chars} chars): opened to first decorated frame {first_paint_ms:.1} ms (comments placed); \
         Agent write to inked {agent_ms:.1} ms; \
         looks applied (links, suggestions, TODO keywords, comments resubmitted) {looks_ms:.2} ms; \
         load average {}",
        load_average()
    );
    Ok(())
}

fn any_view(cx: &gpui::App) -> Option<Entity<dr_view_review::ReviewView>> {
    ["review-primary", "review-secondary"]
        .iter()
        .find_map(|id| dr_view_review::view(id, cx))
}

fn first_comment(lib: &dr_workspace::Workspace, h: &mut Headless) -> Result<Option<String>> {
    let book = h.cx.update(|cx| h.view.read(cx).book_id.clone());
    let list: Value = lib.call(
        &dr_workspace::Actor::User,
        "comment.list",
        json!({"book": book}),
    )?;
    Ok(list["output"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|c| c["status"] == "open" && c["anchored"] == true)
        })
        .and_then(|c| c["id"].as_str().map(str::to_owned)))
}

fn load_average() -> String {
    std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn main() -> Result<()> {
    let out = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../docs/rust-rewrite/modules"));
    run(out)
}
