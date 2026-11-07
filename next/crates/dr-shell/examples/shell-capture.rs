//! The shell drawn offscreen: screenshots (`--capture <dir>`) and frame
//! timings (`--bench <file.json>`).
//!
//! GPUI runs headless (its test platform with the real macOS text system and
//! Metal drawing into a texture), so nothing opens on screen and no
//! screen-recording permission is needed. Everything shown is the synthetic
//! stand-in book.
//!
//! ```text
//! cargo run -p dr-shell --features capture --example shell-capture -- --capture <dir>
//! cargo run --release -p dr-shell --features capture --example shell-capture -- --bench <file.json>
//! ```

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use dr_shell::nav::{Open, Side, Target};
use dr_shell::notifications::{Notifications, Source};
use dr_shell::panes::PaneId;
use dr_shell::workspace::{LeftTab, RightTab, SuperView};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_ui::{Appearance, anim, theme};
use gpui::{AnyWindowHandle, AppContext as _, Context, Entity, HeadlessAppContext, px, size};

const W: f32 = 1280.0;
const H: f32 = 800.0;

struct Headless {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    view: Entity<Workspace>,
    first_frame_ms: f32,
    init_ms: f32,
}

impl Headless {
    fn new() -> Result<Headless> {
        let text_system = gpui_platform::current_platform(true).text_system();
        let mut cx = HeadlessAppContext::with_platform(
            text_system,
            Arc::new(dr_ui::Assets::new()),
            gpui_platform::current_headless_renderer,
        );
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
            dr_shell::init(info, Services::default(), file, cx);
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
        };
        h.first_frame_ms = h.draw()?.0;
        Ok(h)
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

    /// Frames at 60 a second of real time for `seconds`.
    fn frames(&mut self, seconds: f32) -> Result<Vec<f32>> {
        let started = Instant::now();
        let mut next = started;
        let mut times = Vec::new();
        while started.elapsed().as_secs_f32() < seconds {
            times.push(self.draw()?.0);
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

fn chapter(n: u8) -> Target {
    Target::Chapter(format!("ch-{n}").parse().unwrap())
}

fn element(id: &str) -> Target {
    Target::Element(id.parse().unwrap())
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
    ws.open(chapter(1), Open::KEEP, cx);
    ws.open(chapter(3), Open::KEEP, cx);
    ws.open(element("el-linlan"), Open::PREVIEW, cx);
    ws.nav.activate(1);
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
            ws.open(chapter(1), Open::KEEP, cx);
            ws.open(chapter(2), Open::KEEP, cx);
            ws.open(Target::Book, Open::PREVIEW, cx);
            ws.nav.activate(0);
            ws.nav.split_with(1, Side::Right);
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
            ws.open(element("el-harbour"), Open::KEEP, cx);
        });
        still(&mut h)?;
        h.save(&dir, &format!("halves-{a}.png"))?;

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

fn bench(file: PathBuf) -> Result<()> {
    let mut h = Headless::new()?;
    let mut out = vec![format!(
        r#""start": {{"init_and_open_ms": {:.2}, "first_frame_ms": {:.2}}}"#,
        h.init_ms, h.first_frame_ms
    )];
    h.set(everyday);
    h.settle()?;
    std::thread::sleep(Duration::from_millis(700));
    h.settle()?;
    let rest = h.pending()?;
    let redraw = (0..60)
        .map(|_| h.draw().map(|d| d.0))
        .collect::<Result<Vec<_>>>()?;
    out.push(format!(
        r#""everyday_at_rest": {{"frame_requests": {rest}, "full_redraw_ms": {}}}"#,
        summary(&redraw)
    ));

    // Switching tabs: the page dissolves in 180 ms.
    let mut switch = Vec::new();
    for i in 0..10 {
        h.set(move |ws, _, cx| {
            ws.nav.activate(i % 2);
            cx.notify();
        });
        switch.extend(h.frames(0.25)?);
    }
    std::thread::sleep(Duration::from_millis(300));
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

    let load = std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.split_whitespace().nth(1).map(str::to_owned))
        .unwrap_or_else(|| "null".into());
    let json = format!(
        "{{\n  \"note\": \"CPU time of window.draw (layout + paint) per frame, release build, {W}x{H} at 2x, headless Metal, stand-in book\",\n  \"load_average_1m\": {load},\n  {}\n}}\n",
        out.join(",\n  ")
    );
    std::fs::write(&file, json)?;
    println!("wrote {}", file.display());
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag, dir] if flag == "--capture" => capture(PathBuf::from(dir)),
        [flag, file] if flag == "--bench" => bench(PathBuf::from(file)),
        _ => bail!("usage: shell-capture --capture <dir> | --bench <file.json>"),
    }
}
