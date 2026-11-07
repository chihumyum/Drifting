//! `--capture <dir>` and `--bench <file>`: the prototype drawn offscreen.
//!
//! Both run GPUI headless: its test platform, the real macOS text system and
//! the Metal renderer drawing into a texture. So they need no
//! screen-recording permission, open no window over the author's work, and
//! keep measuring while the display sleeps or another app is in front (a
//! macOS window that is covered gets no frames).

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use anyhow::Result;

use crate::{StartTimes, assets::Assets};

#[cfg(feature = "capture")]
mod headless {
    use std::time::{Duration, Instant};

    use super::*;
    use gpui::{AnyWindowHandle, App, AppContext as _, Entity, HeadlessAppContext, px, size};

    use crate::{
        Page, Spike, WINDOW_H, WINDOW_W,
        assets::SvgAssets,
        covers,
        glass::{self, DENSE, Kind, Look, Plan},
        make_spike,
        sea::{Rand, SeaFrame},
        theme::Rgb,
    };

    pub struct Headless {
        pub cx: HeadlessAppContext,
        pub window: AnyWindowHandle,
        pub view: Entity<Spike>,
    }

    impl Headless {
        pub fn new(
            assets: Arc<Assets>,
            start: StartTimes,
            svgs: HashMap<String, Vec<u8>>,
        ) -> Result<Headless> {
            let text_system = gpui_platform::current_platform(true).text_system();
            let mut cx = HeadlessAppContext::with_platform(
                text_system,
                Arc::new(SvgAssets::new(svgs)),
                gpui_platform::current_headless_renderer,
            );
            let window = cx.open_window(size(px(WINDOW_W), px(WINDOW_H)), |_, cx| {
                cx.new(|_| make_spike(assets.clone(), start.clone()))
            })?;
            let view = window.entity(&cx)?;
            Ok(Headless {
                cx,
                window: window.into(),
                view,
            })
        }

        pub fn set(&mut self, f: impl FnOnce(&mut Spike, &mut gpui::Context<Spike>)) {
            let view = self.view.clone();
            self.cx.update(|cx| view.update(cx, f));
        }

        /// One frame: re-render, lay out and paint. Returns its CPU time in ms.
        /// The view is notified and drawn inside one window update, so the
        /// effect flush after it finds nothing left to draw.
        pub fn draw(&mut self) -> Result<f32> {
            let view = self.view.clone();
            self.cx.update_window(self.window, |_, window, cx| {
                view.update(cx, |_, cx| cx.notify());
                let started = Instant::now();
                window.draw(cx).clear(cx);
                started.elapsed().as_secs_f32() * 1000.0
            })
        }

        /// Draws frames at 60 a second of real time for `seconds`.
        pub fn frames(
            &mut self,
            seconds: f32,
            mut each: impl FnMut(&mut Headless, f32),
        ) -> Result<()> {
            let started = Instant::now();
            let mut next = started;
            while started.elapsed().as_secs_f32() < seconds {
                let ms = self.draw()?;
                each(self, ms);
                next += Duration::from_micros(16_667);
                if let Some(wait) = next.checked_duration_since(Instant::now()) {
                    std::thread::sleep(wait);
                }
            }
            Ok(())
        }

        /// The last frame rendered by the GPU into a texture and read back, in ms.
        pub fn gpu_ms(&mut self) -> Result<f32> {
            let started = Instant::now();
            let _ = self.cx.capture_screenshot(self.window)?;
            Ok(started.elapsed().as_secs_f32() * 1000.0)
        }
    }

    /// Drives the paper page with synthetic mouse events, as a smoke test of
    /// the hover, press and click wiring the screenshots cannot show.
    pub fn check_input(h: &mut Headless) -> Result<()> {
        use gpui::{
            Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput,
            point,
        };
        let page_x = (WINDOW_W - 720.0) / 2.0;
        let pill_x = page_x + (720.0 - (5.0 * 28.0 + 4.0 * 2.0 + 8.0)) / 2.0;
        let y = crate::TOP_BAR + 16.0 + 12.0 + 4.0 + 14.0;
        let at = |i: f32| point(px(pill_x + 4.0 + i * 30.0 + 14.0), px(y));
        let send = |h: &mut Headless, event: PlatformInput| -> Result<()> {
            h.cx.update_window(h.window, |_, window, cx| {
                window.dispatch_event(event, cx);
            })?;
            h.draw()?;
            Ok(())
        };
        h.draw()?;
        send(
            h,
            PlatformInput::MouseMove(MouseMoveEvent {
                position: at(1.0),
                pressed_button: None,
                modifiers: Modifiers::default(),
            }),
        )?;
        let hovered = h.view.read_with(&h.cx, |this, _| {
            this.anim("bar-comment", Kind::Hidden).hover
        });
        send(
            h,
            PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position: at(1.0),
                modifiers: Modifiers::default(),
                click_count: 1,
                first_mouse: false,
            }),
        )?;
        let pressed = h.view.read_with(&h.cx, |this, _| {
            this.anim("bar-comment", Kind::Hidden).pressed
        });
        send(
            h,
            PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
                position: at(1.0),
                modifiers: Modifiers::default(),
                click_count: 1,
            }),
        )?;
        let released = h.view.read_with(&h.cx, |this, _| {
            !this.anim("bar-comment", Kind::Hidden).pressed
        });
        let menu_before = h.view.read_with(&h.cx, |this, _| this.menu_open);
        send(
            h,
            PlatformInput::MouseMove(MouseMoveEvent {
                position: at(3.0),
                pressed_button: None,
                modifiers: Modifiers::default(),
            }),
        )?;
        send(
            h,
            PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position: at(3.0),
                modifiers: Modifiers::default(),
                click_count: 1,
                first_mouse: false,
            }),
        )?;
        send(
            h,
            PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
                position: at(3.0),
                modifiers: Modifiers::default(),
                click_count: 1,
            }),
        )?;
        let menu_after = h.view.read_with(&h.cx, |this, _| this.menu_open);
        // Put it back as it was.
        send(
            h,
            PlatformInput::MouseDown(MouseDownEvent {
                button: MouseButton::Left,
                position: at(3.0),
                modifiers: Modifiers::default(),
                click_count: 1,
                first_mouse: false,
            }),
        )?;
        send(
            h,
            PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
                position: at(3.0),
                modifiers: Modifiers::default(),
                click_count: 1,
            }),
        )?;
        send(
            h,
            PlatformInput::MouseMove(MouseMoveEvent {
                position: point(px(4.0), px(400.0)),
                pressed_button: None,
                modifiers: Modifiers::default(),
            }),
        )?;
        anyhow::ensure!(
            hovered && pressed && released,
            "hover {hovered}, press {pressed}, release {released}"
        );
        anyhow::ensure!(
            menu_before != menu_after,
            "the toolbar's ⋯ did not toggle the menu"
        );
        println!("input ok: hover, press, release and click reach the glass controls");
        Ok(())
    }

    pub fn capture(
        dir: PathBuf,
        assets: Arc<Assets>,
        start: StartTimes,
        svgs: HashMap<String, Vec<u8>>,
    ) -> Result<()> {
        std::fs::create_dir_all(&dir)?;
        let mut h = Headless::new(assets, start, svgs)?;
        check_input(&mut h)?;
        let mut shots: Vec<(Page, Plan, bool)> = Vec::new();
        for page in [Page::Paper, Page::Shelf] {
            for plan in Plan::ALL {
                for dark in [false, true] {
                    shots.push((page, plan, dark));
                }
            }
        }
        for page in [Page::Icons, Page::Sea, Page::Covers] {
            for dark in [false, true] {
                shots.push((page, Plan::Bake, dark));
            }
        }
        // The icons once more at 48px, where the three ways part.
        shots.push((Page::Icons, Plan::Cover, false));
        for (page, plan, dark) in shots {
            let big = page == Page::Icons && plan == Plan::Cover;
            let name = match page {
                Page::Icons if big => "icons-48-light.png".to_string(),
                Page::Paper | Page::Shelf => format!(
                    "{}-{}-{}.png",
                    page.slug(),
                    plan.slug(),
                    if dark { "dark" } else { "light" }
                ),
                _ => format!(
                    "{}-{}.png",
                    page.slug(),
                    if dark { "dark" } else { "light" }
                ),
            };
            h.set(|this, cx| {
                this.page = page;
                this.plan = plan;
                this.dark = dark;
                this.icon_size = if big { 48.0 } else { 16.0 };
                this.last = None;
                if page == Page::Shelf {
                    this.anim_mut("card-1", Kind::Rest).hover = true;
                }
                if page == Page::Sea {
                    this.loading = true;
                    this.sea.borrow_mut().loading(true, cx);
                }
            });
            h.frames(if page == Page::Sea { 1.6 } else { 0.5 }, |_, _| {})?;
            let image = h.cx.capture_screenshot(h.window)?;
            image.save(dir.join(&name))?;
            println!("wrote {name}");
            h.set(|this, cx| {
                this.anim_mut("card-1", Kind::Rest).hover = false;
                if page == Page::Sea {
                    this.loading = false;
                    this.sea.borrow_mut().loading(false, cx);
                }
            });
        }
        Ok(())
    }

    fn percentile(values: &mut [f32], p: f32) -> f32 {
        if values.is_empty() {
            return 0.0;
        }
        values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let at = ((values.len() - 1) as f32 * p).round() as usize;
        values[at]
    }

    fn summary(values: &[f32]) -> String {
        let mut v = values.to_vec();
        let max = v.iter().copied().fold(0.0f32, f32::max);
        format!(
            r#"{{"n": {}, "p50": {:.3}, "p95": {:.3}, "max": {:.3}}}"#,
            v.len(),
            percentile(&mut v, 0.5),
            percentile(&mut v, 0.95),
            max
        )
    }

    /// Times of the static work: baking rims, tinting and rasterizing icons.
    fn static_report(this: &Spike, cx: &App) -> String {
        let mut out = Vec::new();
        let s = &this.start;
        out.push(format!(r#""assets_load_ms": {:.2}"#, s.assets_ms));
        out.push(format!(
            r#""glass_texture_mean_alpha": {:.3}"#,
            this.texture_mean
        ));
        out.push(format!(
            r#""icons": {{"count": {}, "png_bytes": {}, "embed_svg_bytes": {}, "embed_build_ms": {:.2}, "vector_build_ms": {:.2}, "vector_svg_bytes": {}, "vector_loops": {}, "vector_points": {}}}"#,
            this.assets.icon_names.len(),
            s.png_bytes,
            s.embed_bytes,
            s.embed_build_ms,
            s.vector_ms,
            s.vector.bytes,
            s.vector.loops,
            s.vector.points
        ));
        // First rasterization of each icon at 16px on a 2x display, as paint_svg asks for it.
        let renderer = cx.svg_renderer();
        for (label, vector) in [("embed", false), ("vector", true)] {
            let mut times = Vec::new();
            for name in &this.assets.icon_names {
                let mask = this.assets.icon(name);
                let bytes = if vector {
                    crate::icons::vectorize(mask).0
                } else {
                    crate::assets::embed_svg(mask, 96.0, 96.0)
                };
                let svg = String::from_utf8_lossy(&bytes)
                    .replacen(r#"width="96" height="96""#, r#"width="16" height="16""#, 1)
                    .into_bytes();
                let started = std::time::Instant::now();
                let _ = renderer.render_single_frame(&svg, 2.0);
                times.push(started.elapsed().as_secs_f32() * 1000.0);
            }
            let total: f32 = times.iter().sum();
            out.push(format!(
                r#""raster_16px_{label}_ms": {{"total": {:.2}, "per_icon": {}}}"#,
                total,
                summary(&times)
            ));
        }
        // Pre-tinting every icon in one new colour.
        let started = std::time::Instant::now();
        for name in &this.assets.icon_names {
            let _ = crate::icons::tint(this.assets.icon(name), Rgb::hex(0x336699), 1.0);
        }
        out.push(format!(
            r#""tint_all_icons_one_colour_ms": {:.3}"#,
            started.elapsed().as_secs_f64() * 1000.0
        ));
        // Baking 甲's rims at 2x.
        let texture = &this.texture;
        let mut bakes = Vec::new();
        for (label, w, h, r, rim) in [
            ("round_28", 28.0, 28.0, 14.0, 9.0),
            ("toolbar_156x36", 156.0, 36.0, 18.0, 12.0),
            ("card_146x300", 146.0, 300.0, 3.0, 9.0),
            ("menu_240x200", 240.0, 200.0, 16.0, 9.0),
        ] {
            let look = Look::new(Rgb::hex(0xb4b6ae), DENSE);
            let look = Look { rim, ..look };
            let mut times = Vec::new();
            for k in 0..40 {
                let started = std::time::Instant::now();
                let _ = glass::bake_rim(
                    w,
                    h,
                    r,
                    2.0,
                    &Look {
                        flow: k as f32 * 0.25,
                        ..look
                    },
                    0.0,
                    texture,
                );
                times.push(started.elapsed().as_secs_f32() * 1000.0);
            }
            bakes.push(format!(
                r#""{label}": {{"bytes": {}, "ms": {}}}"#,
                (w * 2.0) as usize * (h * 2.0) as usize * 4,
                summary(&times)
            ));
        }
        out.push(format!(r#""bake_2x": {{{}}}"#, bakes.join(", ")));
        let theme = this.theme();
        let mut topo = Vec::new();
        let mut sand = Vec::new();
        let mut tint = Vec::new();
        for book in &this.covers.books {
            topo.push(covers::time(|| covers::topo(book)).1 as f32);
            let (masks, ms) = covers::time(|| covers::sand_cover(book));
            sand.push(ms as f32);
            tint.push(
                covers::time(|| {
                    covers::sand_cover_pixmap(
                        book,
                        &masks,
                        |c| theme.sand_on(c, theme.paper_deep),
                        0.85,
                    )
                })
                .1 as f32,
            );
        }
        let levels = covers::synthetic_year(5);
        let heat: Vec<f32> = (0..10)
            .map(|_| covers::time(|| covers::heatmap(&levels, 2.0)).1 as f32)
            .collect();
        out.push(format!(
            r#""covers": {{"size": "252x452", "topo_ms": {}, "sand_ms": {}, "sand_tint_ms": {}, "heatmap_53w_2x_ms": {}}}"#,
            summary(&topo),
            summary(&sand),
            summary(&tint),
            summary(&heat)
        ));
        out.join(",\n  ")
    }

    fn sea_report(frames: &[SeaFrame]) -> String {
        let pick = |f: fn(&SeaFrame) -> f32| frames.iter().map(f).collect::<Vec<_>>();
        format!(
            r#"{{"sim_ms": {}, "paint_ms": {}, "cells": {}, "steps": {}}}"#,
            summary(&pick(|f| f.sim_ms)),
            summary(&pick(|f| f.paint_ms)),
            summary(&pick(|f| f.cells as f32)),
            summary(&pick(|f| f.steps as f32)),
        )
    }

    /// Draws `seconds` of frames, timing every frame's CPU and every tenth
    /// frame's GPU render (plus read-back).
    fn timed(
        h: &mut Headless,
        seconds: f32,
        mut each: impl FnMut(&mut Headless, f32),
    ) -> Result<(Vec<f32>, Vec<f32>)> {
        let mut cpu = Vec::new();
        let mut gpu = Vec::new();
        let mut n = 0;
        h.frames(seconds, |h, ms| {
            cpu.push(ms);
            n += 1;
            if n % 10 == 0
                && let Ok(g) = h.gpu_ms()
            {
                gpu.push(g);
            }
            each(h, ms);
        })?;
        Ok((cpu, gpu))
    }

    pub fn bench(
        path: PathBuf,
        assets: Arc<Assets>,
        start: StartTimes,
        svgs: HashMap<String, Vec<u8>>,
    ) -> Result<()> {
        let mut h = Headless::new(assets, start, svgs)?;
        h.frames(0.5, |_, _| {})?;
        let mut parts = Vec::new();
        let view = h.view.clone();
        parts.push(h.cx.update(|cx| static_report(view.read(cx), cx)));

        // Glass on the paper: the toolbar and one of its buttons under the pointer.
        for plan in Plan::ALL {
            for dark in [false, true] {
                h.set(|this, _| {
                    this.plan = plan;
                    this.dark = dark;
                    this.page = Page::Paper;
                    this.anim_mut("bar-pill", Kind::Surface).hover = false;
                    this.anim_mut("bar-comment", Kind::Hidden).hover = false;
                });
                let (rest_cpu, rest_gpu) = timed(&mut h, 1.0, |_, _| {})?;
                h.set(|this, _| {
                    this.anim_mut("bar-pill", Kind::Surface).hover = true;
                    this.anim_mut("bar-comment", Kind::Hidden).hover = true;
                });
                let bakes_before = h
                    .view
                    .read_with(&h.cx, |this, _| this.bakes.borrow().stats.clone());
                let (cpu, gpu) = timed(&mut h, 3.0, |_, _| {})?;
                let bakes = h
                    .view
                    .read_with(&h.cx, |this, _| this.bakes.borrow().stats.clone());
                let frames = cpu.len().max(1) as f64;
                parts.push(format!(
                    r#""paper_{}_{}": {{"rest_cpu_ms": {}, "rest_gpu_ms": {}, "hover_cpu_ms": {}, "hover_gpu_ms": {}, "bakes_per_frame": {:.2}, "bake_ms_per_frame": {:.3}, "bake_max_ms": {:.3}, "baked_bytes_alive": {}}}"#,
                    plan.slug(),
                    if dark { "dark" } else { "light" },
                    summary(&rest_cpu),
                    summary(&rest_gpu),
                    summary(&cpu),
                    summary(&gpu),
                    (bakes.bakes - bakes_before.bakes) as f64 / frames,
                    (bakes.total_ms - bakes_before.total_ms) / frames,
                    bakes.max_ms,
                    bakes.live_bytes,
                ));
            }
        }
        h.set(|this, _| {
            this.anim_mut("bar-pill", Kind::Surface).hover = false;
            this.anim_mut("bar-comment", Kind::Hidden).hover = false;
            this.plan = Plan::Bake;
            this.dark = false;
        });

        // The sea: still, loading for 5s, let go for 3s, then a drop every 250ms for 5s.
        h.set(|this, _| this.page = Page::Sea);
        let (still_cpu, still_gpu) = timed(&mut h, 1.0, |_, _| {})?;
        parts.push(format!(
            r#""sea_still": {{"cpu_ms": {}, "gpu_ms": {}}}"#,
            summary(&still_cpu),
            summary(&still_gpu)
        ));
        h.set(|this, cx| {
            this.sea.borrow_mut().frames.clear();
            this.loading = true;
            this.sea.borrow_mut().loading(true, cx);
        });
        let mut runs = Vec::new();
        let (cpu, gpu) = timed(&mut h, 5.0, |_, _| {})?;
        let frames = h.view.read_with(&h.cx, |this, _| {
            std::mem::take(&mut this.sea.borrow_mut().frames)
        });
        runs.push(("loading", cpu, gpu, frames));
        h.set(|this, cx| {
            this.loading = false;
            this.sea.borrow_mut().loading(false, cx);
        });
        let (cpu, gpu) = timed(&mut h, 3.0, |_, _| {})?;
        let frames = h.view.read_with(&h.cx, |this, _| {
            std::mem::take(&mut this.sea.borrow_mut().frames)
        });
        runs.push(("release", cpu, gpu, frames));
        let mut rand = Rand::new(3);
        let mut since = Instant::now();
        let (cpu, gpu) = timed(&mut h, 5.0, |h, _| {
            if since.elapsed().as_millis() >= 250 {
                since = Instant::now();
                let (x, y) = (rand.next() * WINDOW_W, rand.next() * 700.0);
                h.set(|this, _| this.sea.borrow_mut().drop_at(x, y, 1.2));
            }
        })?;
        let frames = h.view.read_with(&h.cx, |this, _| {
            std::mem::take(&mut this.sea.borrow_mut().frames)
        });
        runs.push(("drops", cpu, gpu, frames));
        for (label, cpu, gpu, frames) in runs {
            parts.push(format!(
                r#""sea_{label}": {{"cpu_ms": {}, "gpu_ms": {}, "sea": {}}}"#,
                summary(&cpu),
                summary(&gpu),
                sea_report(&frames)
            ));
        }
        let grid = h.view.read_with(&h.cx, |this, _| {
            let sea = this.sea.borrow();
            format!(
                r#""sea_grid": {{"cells": "{}x{}", "water": "{}x{}"}}"#,
                sea.cols, sea.rows, sea.water.cols, sea.water.rows
            )
        });
        parts.push(grid);
        let scale =
            h.cx.update_window(h.window, |_, window, _| window.scale_factor())
                .unwrap_or(0.0);
        parts.push(format!(r#""scale_factor": {scale}"#));
        let json = format!("{{\n  {}\n}}\n", parts.join(",\n  "));
        std::fs::write(&path, &json)?;
        println!("{json}");
        Ok(())
    }
}

#[cfg(feature = "capture")]
pub use headless::{bench, capture as run};

#[cfg(not(feature = "capture"))]
pub fn run(
    _dir: PathBuf,
    _assets: Arc<Assets>,
    _start: StartTimes,
    _svgs: HashMap<String, Vec<u8>>,
) -> Result<()> {
    anyhow::bail!("--capture needs `cargo run -p visual-spike --features capture`")
}

#[cfg(not(feature = "capture"))]
pub fn bench(
    _path: PathBuf,
    _assets: Arc<Assets>,
    _start: StartTimes,
    _svgs: HashMap<String, Vec<u8>>,
) -> Result<()> {
    anyhow::bail!("--bench needs `cargo run --release -p visual-spike --features capture`")
}
