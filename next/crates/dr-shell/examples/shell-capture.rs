//! The shell drawn offscreen: screenshots (`--capture <dir>`) and frame
//! timings (`--bench <file.json>`).
//!
//! GPUI runs headless (its test platform with the real macOS text system and
//! Metal drawing into a texture), so nothing opens on screen and no
//! screen-recording permission is needed. The book is 《慢钟》, the
//! showcase's novel written for Drifting (dr-testkit), seeded into a
//! temporary library and read through F3 like the app reads it.
//!
//! ```text
//! cargo run -p dr-shell --features capture --example shell-capture -- --capture <dir>
//! cargo run --release -p dr-shell --features capture --example shell-capture -- --bench ../docs/rust-rewrite/acceptance
//! ```

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use dr_shell::nav::{Open, Side, Target};
use dr_shell::notifications::{Notifications, Source};
use dr_shell::panes::PaneId;
use dr_shell::workspace::{LeftTab, RightTab, SuperView};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_ui::{Appearance, anim, theme};
use gpui::{
    AnyWindowHandle, AppContext as _, Context, Entity, EntityInputHandler as _, HeadlessAppContext,
    px, size,
};

const W: f32 = 1280.0;
const H: f32 = 800.0;

struct Headless {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    view: Entity<Workspace>,
    first_frame_ms: f32,
    init_ms: f32,
    /// Opening the window until the book's lists arrived from F3.
    book_ms: f32,
    _library: tempfile::TempDir,
}

const VERSION: &str = "0.2.0-dev";

/// A temporary library holding 《慢钟》.
fn slow_clock() -> Result<(tempfile::TempDir, dr_workspace::Workspace)> {
    let dir = tempfile::tempdir()?;
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION))?;
    let book = dr_testkit::samples::slow_clock()?;
    dr_testkit::seed::write_book(&lib, &book).map_err(|e| anyhow::anyhow!("{e}"))?;
    lib.close()?;
    let ws = dr_workspace::Workspace::open_dir(&root, VERSION)?;
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
        // F3 reads and delivers events on its own threads.
        cx.allow_parking();
        let (dir, library) = slow_clock()?;
        let started = Instant::now();
        cx.update(|cx| -> Result<()> {
            dr_ui::init(cx)?;
            let info = ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
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
        let init_ms = started.elapsed().as_secs_f32() * 1000.0;
        let view = window.entity(&cx)?;
        let mut h = Headless {
            cx,
            window: window.into(),
            view,
            first_frame_ms: 0.0,
            init_ms,
            book_ms: 0.0,
            _library: dir,
        };
        h.first_frame_ms = h.draw()?.0;
        h.wait(|ws| !ws.book.is_empty())?;
        h.book_ms = started.elapsed().as_secs_f32() * 1000.0;
        Ok(h)
    }

    fn read<T>(&mut self, f: impl FnOnce(&Workspace) -> T) -> T {
        let view = self.view.clone();
        self.cx.update(|cx| f(view.read(cx)))
    }

    /// Runs until `done` holds (F3's threads answer in their own time).
    fn wait(&mut self, done: impl Fn(&Workspace) -> bool) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            self.draw()?;
            self.cx.run_until_parked();
            if self.read(&done) {
                return Ok(());
            }
            if Instant::now() > deadline {
                bail!("timed out waiting for the library");
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Runs until every page on screen is open: its editor, or the whole
    /// book read.
    fn pages_ready(&mut self) -> Result<()> {
        self.draw()?;
        self.wait(|ws| {
            ws.nav
                .active_tab()
                .map(|t| {
                    t.leaves().all(|l| {
                        ws.editors
                            .get(&l.target.key())
                            .is_some_and(|p| p.view.is_some() || p.failed)
                    })
                })
                .unwrap_or(true)
        })?;
        // The editor takes the keyboard on the frame after it opened.
        self.draw()?;
        Ok(())
    }

    fn set(&mut self, f: impl FnOnce(&mut Workspace, &mut gpui::Window, &mut Context<Workspace>)) {
        let view = self.view.clone();
        self.cx
            .update_window(self.window, |_, window, cx| {
                view.update(cx, |ws, cx| f(ws, window, cx))
            })
            .ok();
    }

    /// One frame; its CPU time in ms and the frame requests it left.
    fn draw(&mut self) -> Result<(f32, usize)> {
        let view = self.view.clone();
        self.cx.update_window(self.window, |_, window, cx| {
            let pending = window.simulate_next_frame(cx);
            view.update(cx, |_, cx| cx.notify());
            let started = Instant::now();
            window.draw(cx).clear(cx);
            (started.elapsed().as_secs_f32() * 1000.0, pending)
        })
    }

    /// The pointer at (`x`, `y`) in the window, held there for `ms` (a
    /// hover card waits 220 ms before it shows).
    fn hover(&mut self, x: f32, y: f32, ms: u64) -> Result<()> {
        self.cx.update_window(self.window, |_, window, cx| {
            window.dispatch_event(
                gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                    position: gpui::point(px(x), px(y)),
                    pressed_button: None,
                    modifiers: gpui::Modifiers::default(),
                }),
                cx,
            );
        })?;
        // The headless dispatcher's timers run on its own clock.
        for _ in 0..10 {
            self.draw()?;
            self.cx.advance_clock(Duration::from_millis(ms / 10));
            self.cx.run_until_parked();
        }
        self.settle()
    }

    fn pending(&mut self) -> Result<usize> {
        self.cx
            .update_window(self.window, |_, window, cx| window.simulate_next_frame(cx))
    }

    fn settle(&mut self) -> Result<()> {
        for _ in 0..5 {
            self.draw()?;
            self.cx.run_until_parked();
        }
        Ok(())
    }

    /// Writes the window as a 256-colour PNG: a UI of flat colours and thin
    /// glass keeps its look, at about a third of the size (what dr-ui's
    /// `shrink-pngs.py` does, without needing Pillow).
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
        println!("wrote {name}");
        Ok(())
    }

    /// Frames at 60 a second of real time for `seconds`. Between frames the
    /// app's tasks run (reading a page, F3's events), as they do on screen;
    /// the headless executor runs them only when asked.
    fn frames(&mut self, seconds: f32) -> Result<Vec<f32>> {
        let started = Instant::now();
        let mut next = started;
        let mut times = Vec::new();
        while started.elapsed().as_secs_f32() < seconds {
            times.push(self.draw()?.0);
            self.cx.run_until_parked();
            next += Duration::from_micros(16_667);
            if let Some(wait) = next.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
        }
        Ok(times)
    }

    fn appearance(&mut self, appearance: Appearance) {
        self.cx
            .update(|cx| theme::force_appearance(Some(appearance), cx));
    }
}

/// The `n`th chapter of the book, 1-based.
fn chapter(ws: &Workspace, n: usize) -> Target {
    Target::Chapter(ws.book.chapters[n - 1].id.parse().unwrap())
}

fn element(ws: &Workspace, name: &str) -> Target {
    let e = ws
        .book
        .elements
        .iter()
        .find(|e| e.name == name)
        .expect("in 慢钟");
    Target::Element(e.id.parse().unwrap())
}

fn material(ws: &Workspace, title: &str) -> Target {
    let m = ws
        .book
        .materials
        .iter()
        .find(|m| m.title == title)
        .expect("in 慢钟");
    Target::Material(m.id.parse().unwrap())
}

/// The everyday layout: chapters on the left, the library on the right,
/// three tabs in the locked dock.
fn everyday(ws: &mut Workspace, window: &mut gpui::Window, cx: &mut Context<Workspace>) {
    reset(ws, window, cx);
    ws.left.width = 300.0;
    ws.right.width = 300.0;
    ws.toggle_left(window, cx);
    ws.toggle_right(window, cx);
    ws.left.reveal.set(1.0);
    ws.right.reveal.set(1.0);
    ws.right.panes.click(PaneId::Primary, RightTab::Library);
    let (first, third, zhiwei) = (chapter(ws, 1), chapter(ws, 3), element(ws, "沈知微"));
    ws.open(first, Open::KEEP, cx);
    ws.open(third, Open::KEEP, cx);
    ws.open(zhiwei, Open::PREVIEW, cx);
    ws.nav.activate(0);
    ws.dock_locked = true;
}

fn reset(ws: &mut Workspace, window: &mut gpui::Window, cx: &mut Context<Workspace>) {
    if ws.left.open {
        ws.toggle_left(window, cx);
    }
    if ws.right.open {
        ws.toggle_right(window, cx);
    }
    // A still picture: no slide in flight from the picture before.
    ws.left.reveal.set(0.0);
    ws.right.reveal.set(0.0);
    while ws.nav.close(0) {}
    ws.super_view = None;
    ws.settings = None;
    ws.notifications_open = false;
    ws.immersive = false;
    ws.corner_menu = None;
    ws.account_open = false;
    ws.find = None;
    ws.chapters_by_book = false;
    ws.chapter_sort = Default::default();
    ws.chapter_sort_open = None;
    ws.folded.clear();
    ws.outline_hidden = false;
    ws.dock_locked = false;
    ws.left.panes = dr_shell::panes::Panes::single(LeftTab::Chapters);
    ws.right.panes = dr_shell::panes::Panes::single(RightTab::Review);
}

fn capture(dir: PathBuf) -> Result<()> {
    std::fs::create_dir_all(&dir)?;
    let mut h = Headless::new()?;
    for appearance in [Appearance::Light, Appearance::Dark] {
        let a = appearance.slug();
        h.appearance(appearance);
        let still = |h: &mut Headless| -> Result<()> {
            h.pages_ready()?;
            let t0 = Instant::now();
            anim::freeze(Some(t0));
            h.settle()?;
            anim::freeze(Some(t0 + Duration::from_secs(3)));
            h.settle()?;
            anim::freeze(None);
            Ok(())
        };

        h.set(everyday);
        still(&mut h)?;
        h.save(&dir, &format!("workspace-{a}.png"))?;

        // Both sidebars closed, the dock at rest (marks), a split page.
        h.set(|ws, window, cx| {
            reset(ws, window, cx);
            let (first, second) = (chapter(ws, 1), chapter(ws, 2));
            ws.open(first, Open::KEEP, cx);
            ws.open(second, Open::KEEP, cx);
            ws.open(Target::Book, Open::PREVIEW, cx);
            ws.nav.activate(0);
            ws.nav.split_with(2, Side::Right);
        });
        still(&mut h)?;
        h.save(&dir, &format!("split-{a}.png"))?;

        // A wide left sidebar in two halves; the right one in two as well.
        h.set(|ws, window, cx| {
            reset(ws, window, cx);
            ws.left.width = 600.0;
            ws.right.width = 0.0;
            ws.toggle_left(window, cx);
            ws.left.reveal.set(1.0);
            let zhiwei = element(ws, "沈知微");
            ws.open(zhiwei, Open::KEEP, cx);
        });
        still(&mut h)?;
        h.save(&dir, &format!("halves-{a}.png"))?;

        // A material note with H2 headings: the editor's sizes.
        h.set(|ws, window, cx| {
            reset(ws, window, cx);
            ws.toggle_right(window, cx);
            ws.right.reveal.set(1.0);
            ws.right.panes.click(PaneId::Primary, RightTab::Library);
            let note = material(ws, "机械钟怎么走");
            ws.open(note, Open::KEEP, cx);
        });
        still(&mut h)?;
        h.save(&dir, &format!("headings-{a}.png"))?;

        // The paper's corner: a chapter's ⋯ menu, its writing status ticked.
        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
            ws.corner_menu = Some(chapter(ws, 1).key());
        });
        still(&mut h)?;
        h.save(&dir, &format!("corner-menu-{a}.png"))?;

        // The chapter panel's whole-book view: the three volumes as acts.
        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
            ws.chapters_by_book = true;
        });
        still(&mut h)?;
        h.save(&dir, &format!("chapters-by-act-{a}.png"))?;

        // The outline rail in the margin of a wide page: the note's two H2s.
        h.set(|ws, window, cx| {
            reset(ws, window, cx);
            let note = material(ws, "机械钟怎么走");
            ws.open(note, Open::KEEP, cx);
        });
        still(&mut h)?;
        h.save(&dir, &format!("outline-{a}.png"))?;

        // The find bar over the first chapter: 「钟」, the first match
        // selected.
        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
        });
        still(&mut h)?;
        h.set(|ws, window, cx| {
            ws.open_find(window, cx);
            if let Some(bar) = ws.find.clone() {
                bar.update(cx, |b, cx| b.set_query("钟", window, cx));
            }
        });
        still(&mut h)?;
        h.save(&dir, &format!("find-{a}.png"))?;

        // The find bar with its replace row: 「钟」 → 「铃」.
        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
        });
        still(&mut h)?;
        h.set(|ws, window, cx| {
            ws.open_replace(window, cx);
            if let Some(bar) = ws.find.clone() {
                bar.update(cx, |b, cx| {
                    b.set_query("钟", window, cx);
                    b.set_replacement("铃", cx);
                });
            }
        });
        still(&mut h)?;
        h.save(&dir, &format!("find-replace-{a}.png"))?;

        // The chapter panel's sort menu (by storyline), the cells showing
        // their word count and date.
        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
            ws.chapter_sort.meta = dr_shell::workspace::chapter_sort::CellMeta::Both;
            ws.chapter_sort_open = Some("primary".into());
        });
        still(&mut h)?;
        h.save(&dir, &format!("chapter-sort-{a}.png"))?;

        // The whole book's sort menu, sorted by when chapters last changed.
        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
            ws.chapters_by_book = true;
            ws.chapter_sort.book = dr_shell::workspace::chapter_sort::BookSort::UpdatedAt;
            ws.chapter_sort_open = Some("primary".into());
        });
        still(&mut h)?;
        h.save(&dir, &format!("chapter-sort-book-{a}.png"))?;

        // The chapter panel with its first storyline folded: each group's
        // count and chevron, the folding fan open.
        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
            let first = ws.book.storylines[0].id.clone();
            ws.toggle_fold(PaneId::Primary, &first, cx);
        });
        still(&mut h)?;
        h.save(&dir, &format!("chapter-fold-{a}.png"))?;

        // A chapter's hover card: words, storylines, summary, then what its
        // ⋯ menu offers (the pointer resting on 第二章).
        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
        });
        still(&mut h)?;
        h.hover(120.0, 179.0, 400)?;
        h.save(&dir, &format!("chapter-card-{a}.png"))?;
        h.hover(700.0, 400.0, 400)?;

        // An element's page has a ⋯ menu too: its snapshot history.
        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
            let zhiwei = element(ws, "沈知微");
            ws.nav.activate(2);
            ws.corner_menu = Some(zhiwei.key());
        });
        still(&mut h)?;
        h.save(&dir, &format!("corner-menu-element-{a}.png"))?;

        // The whole book in one editor (M05), its acts and chapters in the
        // outline rail.
        h.set(|ws, window, cx| {
            reset(ws, window, cx);
            ws.open(Target::Book, Open::KEEP, cx);
        });
        still(&mut h)?;
        h.save(&dir, &format!("whole-book-{a}.png"))?;

        // The left sidebar's account menu (the bookshelf's, shared).
        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
            ws.account_open = true;
        });
        still(&mut h)?;
        h.save(&dir, &format!("account-menu-{a}.png"))?;

        // Settings: 本地数据 and 关于 Drifting (M08).
        for (query, name) in [
            ("本地数据", "settings-local"),
            ("关于", "settings-about"),
            ("输入", "settings-input"),
        ] {
            h.set(move |ws, window, cx| {
                everyday(ws, window, cx);
                ws.open_settings(window, cx);
                if let Some(panel) = ws.settings.clone() {
                    panel.update(cx, |p, cx| p.set_query(query, cx));
                }
            });
            still(&mut h)?;
            h.save(&dir, &format!("{name}-{a}.png"))?;
        }

        // Immersive writing: only the paper.
        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
            ws.set_immersive(true, cx);
        });
        still(&mut h)?;
        h.save(&dir, &format!("immersive-{a}.png"))?;

        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
            ws.toggle_super_view(SuperView::Elements, cx);
        });
        still(&mut h)?;
        h.save(&dir, &format!("super-view-{a}.png"))?;

        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
            ws.open_settings(window, cx);
        });
        still(&mut h)?;
        h.save(&dir, &format!("settings-{a}.png"))?;

        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
            ws.open_settings(window, cx);
            if let Some(panel) = ws.settings.clone() {
                panel.update(cx, |p, cx| p.set_query("字号", cx));
            }
        });
        still(&mut h)?;
        h.save(&dir, &format!("settings-search-{a}.png"))?;

        h.set(|ws, window, cx| {
            everyday(ws, window, cx);
            Notifications::clear(cx);
            let ago = |s: u64| std::time::SystemTime::now() - Duration::from_secs(s);
            Notifications::post_at(Source::Update, "Drifting 0.2.1", ago(7200), None, cx);
            let preserved = dr_shell::strings::tp(
                cx,
                dr_i18n::keys::notifications::markdown_folder::PRESERVED,
                2,
                &[],
            );
            Notifications::post_at(Source::MarkdownFolder, preserved, ago(600), None, cx);
            let crash = dr_shell::t(cx, dr_i18n::keys::feedback::crash::TITLE);
            Notifications::post_at(Source::CrashFollowUp, crash, ago(5), None, cx);
            ws.notifications_open = true;
        });
        still(&mut h)?;
        h.save(&dir, &format!("notifications-{a}.png"))?;

        // Mid-way: the right half's panel being pushed (140 ms into 265),
        // the left sidebar sliding out (200 ms into 420), the page turning.
        h.set(everyday);
        let t0 = Instant::now();
        anim::freeze(Some(t0));
        h.settle()?;
        h.set(|ws, window, cx| {
            ws.toggle_left(window, cx);
        });
        anim::freeze(Some(t0 + Duration::from_secs(1)));
        h.settle()?;
        let t1 = t0 + Duration::from_secs(2);
        anim::freeze(Some(t1));
        h.set(|ws, window, cx| {
            ws.toggle_left(window, cx);
            ws.right.panes.click(PaneId::Primary, RightTab::Stats);
            ws.nav.activate(0);
            cx.notify();
        });
        h.draw()?;
        anim::freeze(Some(t1 + Duration::from_millis(140)));
        h.settle()?;
        h.save(&dir, &format!("motion-midway-{a}.png"))?;
        anim::freeze(None);
    }
    Ok(())
}

fn percentile(values: &[f32], p: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    v[((v.len() - 1) as f32 * p).round() as usize]
}

fn summary(values: &[f32]) -> String {
    format!(
        r#"{{"n": {}, "p50": {:.3}, "p95": {:.3}, "max": {:.3}}}"#,
        values.len(),
        percentile(values, 0.5),
        percentile(values, 0.95),
        values.iter().copied().fold(0.0, f32::max)
    )
}

fn bench(dir: PathBuf) -> Result<()> {
    let mut h = Headless::new()?;
    let mut out = vec![format!(
        r#""start": {{"init_and_open_ms": {:.2}, "first_frame_ms": {:.2}, "book_lists_ms": {:.2}}}"#,
        h.init_ms, h.first_frame_ms, h.book_ms
    )];
    h.set(everyday);
    let read = Instant::now();
    h.pages_ready()?;
    let first_page_ms = read.elapsed().as_secs_f32() * 1000.0;
    h.settle()?;
    std::thread::sleep(Duration::from_millis(2000));
    h.settle()?;
    let rest = h.pending()?;
    let redraw = (0..60)
        .map(|_| h.draw().map(|d| d.0))
        .collect::<Result<Vec<_>>>()?;
    out.push(format!(
        r#""everyday_at_rest": {{"frame_requests": {rest}, "full_redraw_ms": {}, "first_page_open_ms": {first_page_ms:.2}}}"#,
        summary(&redraw)
    ));

    // Typing into the open chapter: each character through the editor's
    // input handler (where the system's input method hands it over; the
    // session writes and persists it), then the frame that shows it.
    let first = h.read(|ws| chapter(ws, 1));
    let editor = h
        .read(|ws| ws.editor_of(&first).cloned())
        .context("the first chapter's editor")?;
    let mut input = Vec::new();
    let mut typed = Vec::new();
    for c in "钟楼上的钟停在三点一刻，没有人去拨它。"
        .chars()
        .cycle()
        .take(80)
    {
        let s = c.to_string();
        let editor = editor.clone();
        let took = h.cx.update_window(h.window, move |_, window, cx| {
            let prose = editor.read(cx).editor().clone();
            let started = Instant::now();
            prose.update(cx, |p, cx| p.replace_text_in_range(None, &s, window, cx));
            started.elapsed().as_secs_f32() * 1000.0
        })?;
        input.push(took);
        typed.push(h.draw()?.0);
        h.cx.run_until_parked();
    }
    out.push(format!(
        r#""typing": {{"input_ms": {}, "frame_ms": {}}}"#,
        summary(&input),
        summary(&typed)
    ));

    // The whole book in one editor (M05): 24 chapters opened together,
    // only the rows on screen laid out.
    h.set(|ws, _, cx| ws.open(Target::Book, Open::KEEP, cx));
    let read = Instant::now();
    h.pages_ready()?;
    let book_page_ms = read.elapsed().as_secs_f32() * 1000.0;
    std::thread::sleep(Duration::from_millis(300));
    h.settle()?;
    let rows = {
        let view = h.view.clone();
        h.cx.update(|cx| {
            view.read(cx)
                .book_editor()
                .map_or(0, |b| b.read(cx).chapter_docs().count())
        })
    };
    let book_redraw = (0..60)
        .map(|_| h.draw().map(|d| d.0))
        .collect::<Result<Vec<_>>>()?;
    out.push(format!(
        r#""whole_book_page": {{"chapters": {rows}, "open_ms": {book_page_ms:.2}, "full_redraw_ms": {}}}"#,
        summary(&book_redraw)
    ));
    h.set(|ws, _, cx| {
        if let Some(i) = ws.nav.tabs().iter().position(|t| t.key() == "book") {
            ws.nav.close(i);
        }
        ws.nav.activate(0);
        cx.notify();
    });
    h.pages_ready()?;
    h.settle()?;

    // Switching tabs: the page dissolves in 180 ms.
    let mut switch = Vec::new();
    for i in 0..10 {
        h.set(move |ws, _, cx| {
            ws.nav.activate(i % 2);
            cx.notify();
        });
        switch.extend(h.frames(0.25)?);
    }
    // The dock's wave: 300 ms across, 300 ms to settle; frames keep coming
    // until everything is still, as on screen.
    h.frames(1.0)?;
    h.settle()?;
    let after_switch = h.pending()?;
    out.push(format!(
        r#""tab_switch": {{"frame_ms": {}, "frame_requests_after": {after_switch}}}"#,
        summary(&switch)
    ));

    // A sidebar sliding out and back (420 ms each way).
    let mut slide = Vec::new();
    for _ in 0..5 {
        h.set(|ws, window, cx| ws.toggle_left(window, cx));
        slide.extend(h.frames(0.5)?);
    }
    std::thread::sleep(Duration::from_millis(300));
    h.settle()?;
    let after_slide = h.pending()?;
    out.push(format!(
        r#""sidebar_slide": {{"frame_ms": {}, "frame_requests_after": {after_slide}}}"#,
        summary(&slide)
    ));

    // A sidebar half's panel pushed to another tab (265 ms).
    let mut push = Vec::new();
    for i in 0..8 {
        let tab = RightTab::ORDER[i % 4];
        h.set(move |ws, _, cx| {
            ws.right.panes.click(PaneId::Primary, tab);
            cx.notify();
        });
        push.extend(h.frames(0.35)?);
    }
    out.push(format!(
        r#""panel_push": {{"frame_ms": {}}}"#,
        summary(&push)
    ));

    // A Super View opened over the workspace (budget: worst frame ≤ 100 ms).
    h.set(|ws, _, cx| ws.toggle_super_view(SuperView::Elements, cx));
    let super_view = h.frames(0.5)?;
    out.push(format!(
        r#""super_view_open": {{"frame_ms": {}}}"#,
        summary(&super_view)
    ));
    h.set(|ws, _, cx| ws.toggle_super_view(SuperView::Elements, cx));
    h.settle()?;

    // Settings opened over everything.
    h.set(|ws, window, cx| ws.open_settings(window, cx));
    let settings = h.frames(0.5)?;
    out.push(format!(
        r#""settings_open": {{"frame_ms": {}}}"#,
        summary(&settings)
    ));

    // Measured evidence (dr-testkit's convention): the machine and load go
    // with the numbers; the inputs say when they go stale.
    let results: serde_json::Value = serde_json::from_str(&format!(
        "{{\"note\": \"CPU time of window.draw (layout + paint) per frame, {W}x{H} at 2x, headless Metal, 《慢钟》 read through F3\", {}}}",
        out.join(", ")
    ))?;
    let mut evidence = dr_testkit::evidence::Evidence::new(
        "shell-bench",
        "f6-m3",
        "cargo run --release -p dr-shell --features capture --example shell-capture -- --bench ../docs/rust-rewrite/acceptance",
    )
    .inputs(
        &dr_testkit::evidence::workspace_root(),
        &[
            "crates/dr-shell",
            "crates/dr-ui",
            "crates/dr-workspace",
            "crates/dr-editor",
            "crates/gpui-prose",
            "crates/dr-testkit/src/samples.rs",
            "crates/dr-testkit/fixtures/slow-clock.json",
        ],
    )?;
    evidence.corpus = serde_json::json!({ "sample": "slow-clock" });
    evidence.results = results;
    let path = evidence.write(&dir)?;
    println!("wrote {}", path.display());
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag, dir] if flag == "--capture" => capture(PathBuf::from(dir)),
        [flag, dir] if flag == "--bench" => bench(PathBuf::from(dir)),
        _ => bail!("usage: shell-capture --capture <dir> | --bench <dir>"),
    }
}
