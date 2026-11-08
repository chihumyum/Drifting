//! Screenshots of M19's image and PDF viewer in the shell, drawn offscreen
//! like `m18-capture` (GPUI's headless platform, real text and Metal,
//! nothing on screen). The book is 《慢钟》 from dr-testkit; the picture and
//! the PDF are dr-testkit's synthetic media, the comments on them made up
//! here.
//!
//! ```text
//! cargo run -p dr-view-material --features capture --example m19-capture -- <docs/rust-rewrite/modules>
//! ```
//!
//! Writes `m19/*.png` under the folder given, as 256-colour PNGs, and
//! prints how long the pictures took to come up.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use dr_shell::nav::{Open, Target};
use dr_shell::workspace::LeftTab;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_store::asset::{SourceImport, Variant};
use dr_ui::{Appearance, anim, theme};
use dr_view_material::MediaPage;
use gpui::{
    AnyWindowHandle, AppContext as _, Context, Entity, HeadlessAppContext, Modifiers, MouseButton,
    PlatformInput, point, px, size,
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

fn out(ws: &dr_workspace::Workspace, name: &str, input: Value) -> Result<Value> {
    Ok(ws.call(&dr_workspace::Actor::User, name, input)?["output"].clone())
}

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap_or_default().to_owned()
}

/// A material of `kind` whose source is `bytes`.
fn material(
    ws: &dr_workspace::Workspace,
    book: &str,
    kind: &str,
    title: &str,
    description: &str,
    bytes: Vec<u8>,
    dims: (u32, u32),
) -> Result<String> {
    let (mime, ext) = if kind == "image" {
        ("image/png", "png")
    } else {
        ("application/pdf", "pdf")
    };
    let asset = dr_model::id::new_uuid_v7();
    let lib = ws.library();
    let file = std::env::temp_dir().join(format!("m19-capture-{asset}.{ext}"));
    std::fs::write(&file, &bytes)?;
    let imported = lib.import_asset(&SourceImport {
        book_id: book,
        asset_id: &asset,
        source: &file,
        mime,
        ext,
        dimensions: (kind == "image").then_some(dims),
        limit: 64 << 20,
    });
    let _ = std::fs::remove_file(&file);
    imported?;
    let sha = lib
        .asset(&asset, Variant::Source)?
        .ok_or_else(|| anyhow!("no asset"))?
        .sha256;
    let mut put = json!({"book": book, "id": asset, "kind": kind, "mime": mime,
                         "size": bytes.len(), "sha256": sha});
    if kind == "image" {
        put["width"] = json!(dims.0);
        put["height"] = json!(dims.1);
    }
    out(ws, "asset.put", put)?;
    Ok(id(&out(
        ws,
        "material.create",
        json!({"book": book, "kind": kind, "title": title, "asset": asset,
               "description": description}),
    )?))
}

fn region(
    ws: &dr_workspace::Workspace,
    book: &str,
    on: &str,
    kind: &str,
    region: Value,
    body: &str,
) -> Result<String> {
    Ok(id(&out(
        ws,
        "comment.create",
        json!({"book": book, "kind": kind, "target": {"kind": "material", "id": on},
               "region": region, "body": body}),
    )?))
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
        dr_testkit::seed::write_book(&lib, &book).map_err(|e| anyhow!("{e}"))?;
        lib.close()?;
        let library = dr_workspace::Workspace::open_dir(&root, VERSION)?;
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
            dr_view_material::init(cx);
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
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            self.cx.advance_clock(Duration::from_millis(40));
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

    fn page(&mut self, target: &Target) -> Option<Entity<MediaPage>> {
        let target = target.clone();
        self.cx.update(|cx| {
            self.view
                .read(cx)
                .module_page(&target)
                .cloned()
                .and_then(|v| v.downcast::<MediaPage>().ok())
        })
    }

    fn on_page(
        &mut self,
        page: &Entity<MediaPage>,
        f: impl FnOnce(&mut MediaPage, &mut gpui::Window, &mut Context<MediaPage>),
    ) {
        let page = page.clone();
        self.cx
            .update_window(self.window, |_, window, cx| {
                page.update(cx, |p, cx| f(p, window, cx))
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

    fn input(&mut self, event: PlatformInput) {
        self.cx
            .update_window(self.window, |_, window, cx| {
                window.dispatch_event(event, cx);
            })
            .ok();
    }

    fn pointer(&mut self, x: f32, y: f32, pressed: Option<MouseButton>) {
        self.input(PlatformInput::MouseMove(gpui::MouseMoveEvent {
            position: point(px(x), px(y)),
            pressed_button: pressed,
            modifiers: Modifiers::default(),
        }));
    }

    fn press(&mut self, x: f32, y: f32) {
        self.input(PlatformInput::MouseDown(gpui::MouseDownEvent {
            position: point(px(x), px(y)),
            button: MouseButton::Left,
            modifiers: Modifiers::default(),
            click_count: 1,
            first_mouse: false,
        }));
    }

    fn release(&mut self, x: f32, y: f32) {
        self.input(PlatformInput::MouseUp(gpui::MouseUpEvent {
            position: point(px(x), px(y)),
            button: MouseButton::Left,
            modifiers: Modifiers::default(),
            click_count: 1,
        }));
    }

    /// Lets every read finish and every animation land.
    fn still(&mut self) -> Result<()> {
        for _ in 0..30 {
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

/// The chapters on the left, the right sidebar closed: the picture has the
/// desk.
fn layout(ws: &mut Workspace, window: &mut gpui::Window, cx: &mut Context<Workspace>) {
    ws.search = None;
    if !ws.left.open {
        ws.toggle_left(window, cx);
    }
    if ws.right.open {
        ws.toggle_right(window, cx);
    }
    ws.left.width = 220.0;
    ws.left.reveal.set(1.0);
    ws.right.reveal.set(0.0);
    ws.left.panes = dr_shell::panes::Panes::single(LeftTab::Chapters);
    ws.dock_locked = true;
}

/// The window point at fractions `(u, v)` of the picture on `page`.
fn at(h: &mut Headless, page: &Entity<MediaPage>, (u, v): (f32, f32)) -> (f32, f32) {
    h.cx.update(|cx| {
        let p = page.read(cx);
        let (f, o) = (
            p.frame().unwrap_or_default(),
            p.stage_origin().unwrap_or((0.0, 0.0)),
        );
        (o.0 + f.x + u * f.w, o.1 + f.y + v * f.h)
    })
}

fn run(modules: PathBuf) -> Result<()> {
    let dir = modules.join("m19");
    std::fs::create_dir_all(&dir)?;
    let mut h = Headless::new()?;
    let lib =
        h.cx.update(|cx| h.view.read(cx).library.clone())
            .ok_or_else(|| anyhow!("a library"))?;
    let book = h.cx.update(|cx| h.view.read(cx).book_id.clone());

    let image = material(
        &lib,
        &book,
        "image",
        "东岸速写",
        "第四章用：湖在北，旧城的街区在东南，河从南边绕过去。",
        dr_testkit::media::png(1600, 1000),
        (1600, 1000),
    )?;
    let pdf = material(
        &lib,
        &book,
        "pdf",
        "潮汐笔记",
        "",
        dr_testkit::media::sample_pdf(),
        (0, 0),
    )?;
    let lake = region(
        &lib,
        &book,
        &image,
        "note",
        json!({"x": 0.09, "y": 0.15, "w": 0.43, "h": 0.36}),
        "湖的形状和第四章写的对不上，要么改图，要么改文。",
    )?;
    region(
        &lib,
        &book,
        &image,
        "todo",
        json!({"x": 0.54, "y": 0.53, "w": 0.42, "h": 0.32}),
        "确认旧城一共几个街区。",
    )?;
    out(
        &lib,
        "comment.create",
        json!({"book": book, "target": {"kind": "material", "id": image},
               "body": "整张图的比例尺还没定。"}),
    )?;
    region(
        &lib,
        &book,
        &pdf,
        "note",
        json!({"page": 1, "x": 0.08, "y": 0.6, "w": 0.66, "h": 0.06}),
        "这一行写进第四章开头。",
    )?;
    region(
        &lib,
        &book,
        &pdf,
        "todo",
        json!({"page": 2, "x": 0.08, "y": 0.12, "w": 0.84, "h": 0.2}),
        "核对头三天的潮位。",
    )?;
    h.wait(|ws, _| ws.book.materials.len() >= 2)?;
    let image_target = Target::Material(image.parse().map_err(|_| anyhow!("material id"))?);
    let pdf_target = Target::Material(pdf.parse().map_err(|_| anyhow!("material id"))?);

    // How long a picture takes to come up when its page opens.
    let opened = Instant::now();
    h.set(|ws, window, cx| {
        layout(ws, window, cx);
        ws.open(image_target.clone(), Open::KEEP, cx);
    });
    let t = image_target.clone();
    h.wait(move |ws, cx| {
        ws.module_page(&t)
            .cloned()
            .and_then(|v| v.downcast::<MediaPage>().ok())
            .is_some_and(|p| p.read(cx).ready())
    })?;
    let image_ms = opened.elapsed().as_secs_f64() * 1e3;
    let opened = Instant::now();
    h.set(|ws, _, cx| ws.open(pdf_target.clone(), Open::KEEP, cx));
    let t = pdf_target.clone();
    h.wait(move |ws, cx| {
        ws.module_page(&t)
            .cloned()
            .and_then(|v| v.downcast::<MediaPage>().ok())
            .is_some_and(|p| p.read(cx).ready())
    })?;
    let pdf_ms = opened.elapsed().as_secs_f64() * 1e3;
    let image_page = h.page(&image_target).ok_or_else(|| anyhow!("image page"))?;
    let pdf_page = h.page(&pdf_target).ok_or_else(|| anyhow!("pdf page"))?;
    // A page turned: rendered at the size it is shown.
    let turned = Instant::now();
    h.on_page(&pdf_page, |p, _, cx| p.turn_to(2, cx));
    let probe = pdf_page.clone();
    h.wait(move |_, cx| probe.read(cx).ready())?;
    let turn_ms = turned.elapsed().as_secs_f64() * 1e3;
    h.on_page(&pdf_page, |p, _, cx| p.turn_to(1, cx));

    for appearance in [Appearance::Light, Appearance::Dark] {
        let a = appearance.slug();
        h.cx.update(|cx| theme::force_appearance(Some(appearance), cx));

        // The image with its comments: the lake's chosen, the pointer on
        // the blocks.
        h.set(|ws, window, cx| {
            layout(ws, window, cx);
            ws.open(image_target.clone(), Open::KEEP, cx);
        });
        h.still()?;
        let lake_id = lake.clone();
        h.on_page(&image_page, move |p, _, cx| p.select(&lake_id, cx));
        let (x, y) = at(&mut h, &image_page, (0.75, 0.7));
        h.pointer(x, y, None);
        h.still()?;
        h.save(&dir, &format!("image-{a}.png"))?;

        // The PDF's first page, its pager at the foot.
        h.set(|ws, _, cx| ws.open(pdf_target.clone(), Open::KEEP, cx));
        h.on_page(&pdf_page, |p, _, cx| p.turn_to(1, cx));
        h.pointer(W - 10.0, H - 10.0, None);
        h.still()?;
        h.save(&dir, &format!("pdf-{a}.png"))?;

        // Zoomed in on the image, drawing: a rectangle being dragged out
        // over the river, then the composer where it ended.
        h.set(|ws, _, cx| ws.open(image_target.clone(), Open::KEEP, cx));
        h.on_page(&image_page, |p, _, cx| {
            p.reset_zoom(cx);
            p.set_drawing(true, cx);
        });
        h.still()?;
        let (zx, zy) = at(&mut h, &image_page, (0.62, 0.78));
        h.on_page(&image_page, move |p, _, cx| {
            p.zoom_by(2.2, Some(point(px(zx), px(zy))), cx)
        });
        h.still()?;
        let (ax, ay) = at(&mut h, &image_page, (0.5, 0.7));
        let (bx, by) = at(&mut h, &image_page, (0.66, 0.84));
        h.press(ax, ay);
        h.draw()?;
        h.pointer(bx, by, Some(MouseButton::Left));
        h.still()?;
        h.save(&dir, &format!("draw-{a}.png"))?;
        h.release(bx, by);
        h.still()?;
        h.save(&dir, &format!("compose-{a}.png"))?;
        h.on_page(&image_page, |p, _, cx| {
            p.close_composer(cx);
            p.set_drawing(false, cx);
            p.reset_zoom(cx);
        });
        h.still()?;
    }
    println!(
        "image page open → picture shown: {image_ms:.1} ms; PDF page open → first page: \
         {pdf_ms:.1} ms; page turn → rendered: {turn_ms:.1} ms"
    );
    Ok(())
}

fn main() -> Result<()> {
    let out = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../docs/rust-rewrite/modules"));
    run(out)
}
