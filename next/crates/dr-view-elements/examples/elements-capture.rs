//! The element and category pages and the elements panel (M11) and the
//! storyline page (M13) drawn offscreen, light and dark, into `<dir>/m11/`
//! and `<dir>/m13/`:
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
use dr_view_elements::dialogs::AskFor;
use dr_view_elements::panel::{ElementPanel, PanelHead, View};
use gpui::{
    AnyWindowHandle, AppContext as _, Context, Entity, Focusable as _, HeadlessAppContext,
    IntoElement, ParentElement as _, Render, Styled as _, Window, div, px, size,
};

const W: f32 = 1280.0;
/// The panel's window: a sidebar's width.
const PANEL_W: f32 = 300.0;
const H: f32 = 800.0;
const VERSION: &str = "0.2.0-dev";

struct Headless {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    view: Entity<Workspace>,
    panel: (Entity<ElementPanel>, AnyWindowHandle),
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
        let ws = view.downgrade();
        let (list, head) = cx.update(|cx| dr_view_elements::make_panel(ws, cx));
        let host = {
            let list = list.clone();
            cx.open_window(size(px(PANEL_W), px(H)), move |_, cx| {
                cx.new(|_| PanelHost { head, list })
            })?
        };
        let mut h = Headless {
            cx,
            window: window.into(),
            view,
            panel: (list, host.into()),
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

    /// What the element dialog asks now.
    fn asking(&mut self) -> Option<dr_view_elements::dialogs::Asking> {
        self.cx
            .update(|cx| dr_view_elements::dialogs::dialogs(cx).and_then(|d| d.read(cx).asking()))
    }

    fn close_dialog(&mut self) -> Result<()> {
        let dialogs = self.cx.update(|cx| dr_view_elements::dialogs::dialogs(cx));
        if let Some(d) = dialogs {
            self.in_window(move |window, cx| d.update(cx, |d, cx| d.close(window, cx)));
        }
        self.wait(|h| h.asking().is_none())?;
        self.settle()
    }

    /// The panel's window.
    fn save_panel(&mut self, dir: &Path, name: &str) -> Result<()> {
        let window = self.panel.1;
        // A few frames: the list reads its dates when it first draws.
        for _ in 0..12 {
            self.cx.update_window(window, |_, window, cx| {
                window.simulate_next_frame(cx);
                window.refresh();
                window.draw(cx).clear(cx);
            })?;
            self.cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(30));
        }
        self.write_png(window, dir, name)
    }

    /// Writes the window as a 256-colour PNG (as dr-shell's capture does).
    fn save(&mut self, dir: &Path, name: &str) -> Result<()> {
        self.write_png(self.window, dir, name)
    }

    fn write_png(&mut self, window: AnyWindowHandle, dir: &Path, name: &str) -> Result<()> {
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
}

fn capture(dir: PathBuf) -> Result<()> {
    let mut h = Headless::new()?;
    let out = dir.join("m11");
    let m13 = dir.join("m13");
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
    let tower = h
        .read(|ws, _| {
            ws.book
                .storylines
                .iter()
                .find(|l| l.name == "钟楼")
                .cloned()
        })
        .context("钟楼 in 《慢钟》")?;
    let storyline = Target::Storyline(tower.id.parse()?);
    // A chapter template on 钟楼, as the author would have written one.
    {
        use dr_workspace::commands::template::{
            ChapterTemplateSetBody, SetChapterTemplateIn, TemplateParagraph,
        };
        let (lib, book) = h.read(|ws, cx| {
            (
                cx.global::<dr_shell::Services>().library.clone(),
                ws.book.id.clone(),
            )
        });
        let lib = lib.context("a library")?;
        let para = |heading: Option<u8>, text: &str| TemplateParagraph {
            heading,
            text: text.to_owned(),
        };
        lib.run::<ChapterTemplateSetBody>(
            &dr_workspace::Actor::User,
            SetChapterTemplateIn {
                book,
                storyline: tower.id.clone(),
                paragraphs: vec![
                    para(Some(2), "钟楼里"),
                    para(None, "这一章从钟声停下的那一刻写起。"),
                    para(Some(2), "知微看见了什么"),
                    para(None, ""),
                ],
            },
        )
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    }
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

        // Its ⋯ menu: share, 更改类目 (the category's mark) and 更改分组,
        // the snapshot history, 删除要素 last.
        {
            let key = element.key();
            h.set(move |ws, _, cx| {
                ws.corner_menu = Some(key);
                cx.notify();
            });
            h.settle()?;
            h.save(&out, &format!("element-menu-{suffix}.png"))?;
            h.set(|ws, _, cx| {
                ws.corner_menu = None;
                cx.notify();
            });
            h.settle()?;
        }

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
        h.wait(|h| h.asking().is_some())?;
        h.settle()?;
        h.save(&out, &format!("element-alert-{suffix}.png"))?;
        h.close_dialog()?;

        // The ⋯ menu's dialogs: 更改类目, 分组 (a new name typed), 删除.
        let ws = h.view.downgrade();
        for (ask, name) in [
            (
                AskFor::ChangeCategory(zhiwei.id.clone()),
                "element-category",
            ),
            (AskFor::ChangeGroup(zhiwei.id.clone()), "element-group"),
            (AskFor::DeleteElement(zhiwei.id.clone()), "element-delete"),
        ] {
            let ws = ws.clone();
            h.in_window(move |window, cx| dr_view_elements::dialogs::open(ask, ws, window, cx));
            h.settle()?;
            if name == "element-group" {
                let field = h.cx.update(|cx| {
                    dr_view_elements::dialogs::dialogs(cx).and_then(|d| d.read(cx).field())
                });
                if let Some(field) = field {
                    h.cx.update(|cx| field.update(cx, |f, cx| f.set_text("沈家", cx)));
                    h.settle()?;
                }
            }
            h.save(&out, &format!("{name}-{suffix}.png"))?;
            h.close_dialog()?;
        }

        h.open(category.clone())?;
        h.wait(|h| {
            h.cx.update(|cx| {
                dr_view_elements::category_page(&people.id, cx)
                    .is_some_and(|(_, end)| end.read(cx).words_read())
            })
        })?;
        h.settle()?;
        h.save(&out, &format!("category-{suffix}.png"))?;

        // The storyline page (M13): its head, then scrolled down to its
        // fields and chapter sequence; the ⋯ menu's delete confirmation.
        h.open(storyline.clone())?;
        h.wait(|h| {
            h.cx.update(|cx| dr_view_elements::storyline_page(&tower.id, cx).is_some())
        })?;
        h.settle()?;
        h.save(&m13, &format!("storyline-{suffix}.png"))?;
        let target = storyline.clone();
        h.set(move |ws, _, cx| {
            if let Some(editor) = ws.editor_of(&target) {
                let prose = editor.read(cx).editor().clone();
                prose.update(cx, |p, cx| {
                    p.scroll_by_estimate(560.0, cx);
                });
            }
        });
        // The chapter template opens once its place is first drawn.
        h.wait(|h| {
            h.cx.update(|cx| {
                dr_view_elements::storyline_page(&tower.id, cx)
                    .and_then(|(_, end)| end.read(cx).template.clone())
                    .is_some_and(|t| t.read(cx).is_open())
            })
        })?;
        h.settle()?;
        h.save(&m13, &format!("storyline-sequence-{suffix}.png"))?;
        let target = storyline.clone();
        h.set(move |ws, _, cx| {
            if let Some(editor) = ws.editor_of(&target) {
                let prose = editor.read(cx).editor().clone();
                prose.update(cx, |p, cx| {
                    p.scroll_by_estimate(-2000.0, cx);
                });
            }
        });
        let ws = h.view.downgrade();
        let ask = AskFor::DeleteStoryline(tower.id.clone());
        h.in_window(move |window, cx| dr_view_elements::dialogs::open(ask, ws, window, cx));
        h.settle()?;
        h.save(&m13, &format!("storyline-delete-{suffix}.png"))?;
        h.close_dialog()?;

        // The elements panel, in both views (its own window until the shell
        // hosts it).
        for (view, name) in [(View::Compact, "panel-compact"), (View::List, "panel-list")] {
            let panel = h.panel.0.clone();
            h.cx.update(|cx| {
                panel.update(cx, |p, cx| {
                    if p.mode != view {
                        p.toggle_mode(cx);
                    }
                })
            });
            h.settle()?;
            h.save_panel(&out, &format!("{name}-{suffix}.png"))?;
        }
    }
    Ok(())
}

/// The panel's head and list in a sidebar-wide window, on the desk.
struct PanelHost {
    head: Entity<PanelHead>,
    list: Entity<ElementPanel>,
}

impl Render for PanelHost {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = dr_ui::Theme::of(window, cx);
        let p = theme.palette;
        let header_h = (theme.scale.row_height * 1.25).max(40.0);
        dr_ui::glass::surface(
            dr_ui::glass::Ground::flat(p.desk),
            div()
                .size_full()
                .flex()
                .flex_col()
                .bg(p.desk.solid())
                .text_color(p.ink(1).solid())
                .child(
                    div()
                        .h(px(header_h))
                        .flex_none()
                        .pl(px(12.0))
                        .pr(px(10.0))
                        .border_t(px(0.5))
                        .border_color(p.rule.solid())
                        .child(self.head.clone()),
                )
                .child(div().flex_1().min_h_0().child(self.list.clone())),
        )
    }
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        bail!("usage: elements-capture <docs/rust-rewrite/modules>");
    };
    capture(PathBuf::from(dir))
}
