//! Screenshots of the chapter page and the helpers around typing (F4e,
//! second batch), drawn headless: GPUI's test platform, the macOS text
//! system and the Metal renderer into a texture (no window opens).
//!
//! ```text
//! cargo run -p dr-editor --example page-capture -- <dir>
//! ```
//!
//! The chrome here is a sample of what the shell (F6) draws through
//! `PageChrome`: the folio line, the title, the synopsis and a rule above
//! the text, ⁂ with its two actions after it, the empty-chapter hint. The
//! book is synthetic.
//!
//! A material note (fifth batch), light and dark: a highlight, a table with
//! its bar, an embedded picture and a PDF card (`note-light.png`,
//! `note-dark.png`); the picture is drawn here, the PDF is a stub.

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use dr_editor::assist::BAR_DELAY;
use dr_editor::page::{EMPTY_HINTS, PageChrome, PageInfo, PageKind};
use dr_editor::{ChapterEditor, EditorSettings};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{
    AnyElement, AnyWindowHandle, App, AppContext as _, Context, Entity, EntityInputHandler,
    FontWeight, HeadlessAppContext, IntoElement, ParentElement, Render, Styled, Window, div, hsla,
    px, size,
};
use serde_json::{Value, json};

const WIDTH: f32 = 960.;
const HEIGHT: f32 = 760.;

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

/// The sample chrome: the 0.1 client's chapter page, plainly drawn.
struct Chrome;

impl PageChrome for Chrome {
    fn head(&self, page: &PageInfo, _: &mut Window, _: &mut App) -> Option<AnyElement> {
        let muted = hsla(0., 0., 0.45, 1.);
        let mut folio = Vec::new();
        match page.kind {
            PageKind::Chapter => {
                if let Some(n) = page.number {
                    folio.push(format!("第 {n} 章"));
                }
                if let Some(s) = &page.storyline {
                    folio.push(s.name.clone());
                }
            }
            PageKind::Idea => folio.push("构想".into()),
            PageKind::Other => {}
        }
        folio.push(format!("{} 字", page.words));
        let synopsis = if page.synopsis.is_empty() {
            div().text_color(muted.opacity(0.6)).child("梗概…")
        } else {
            div().text_color(muted).child(page.synopsis.clone())
        };
        Some(
            div()
                .w_full()
                .flex()
                .justify_center()
                .px(px(48.))
                .pt(px(64.))
                .pb(px(28.))
                .child(
                    div()
                        .w_full()
                        .max_w(px(720.))
                        .flex()
                        .flex_col()
                        .gap(px(14.))
                        .child(
                            div()
                                .text_size(px(13.))
                                .text_color(muted)
                                .child(folio.join(" · ")),
                        )
                        .child(
                            div()
                                .text_size(px(30.))
                                .font_weight(FontWeight::NORMAL)
                                .child(page.title.clone()),
                        )
                        .child(synopsis.text_size(px(15.)))
                        .child(div().mt(px(6.)).h(px(0.5)).bg(muted.opacity(0.35))),
                )
                .into_any_element(),
        )
    }

    fn end(&self, page: &PageInfo, _: &mut Window, _: &mut App) -> Option<AnyElement> {
        let muted = hsla(0., 0., 0.45, 1.);
        let accent = hsla(0.58, 0.45, 0.42, 1.);
        let mut col = div()
            .w_full()
            .flex()
            .flex_col()
            .items_center()
            .pt(px(36.))
            .pb(px(96.));
        if page.empty {
            let mut hints = div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .mb(px(32.))
                .text_size(px(13.))
                .text_color(muted.opacity(0.8));
            for (label, markdown) in EMPTY_HINTS {
                hints = hints.child(format!("{label}　{markdown}"));
            }
            hints = hints.child("全局搜索　⌘⇧F").child("时间线　⌘J");
            col = col.child(hints);
        }
        if page.kind == PageKind::Chapter {
            let status = if page.finished() {
                "改回草稿"
            } else {
                "标为完成"
            };
            col = col
                .child(
                    div()
                        .text_size(px(22.))
                        .text_color(if page.finished() { accent } else { muted })
                        .child("⁂"),
                )
                .child(
                    div()
                        .mt(px(10.))
                        .flex()
                        .gap(px(18.))
                        .text_size(px(13.))
                        .text_color(muted)
                        .child(status)
                        .child("新建下一章"),
                );
        }
        Some(col.into_any_element())
    }
}

struct Page {
    view: Entity<ChapterEditor>,
    ground: gpui::Hsla,
    ink: gpui::Hsla,
}

impl Render for Page {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .bg(self.ground)
            .text_color(self.ink)
            .child(self.view.clone())
    }
}

struct Shot {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    view: Entity<ChapterEditor>,
}

impl Shot {
    fn open(ws: &Workspace, book: &str, doc: &str) -> Shot {
        Shot::open_with(ws, book, doc, true, None)
    }

    /// `doc` without the chapter chrome, in the theme of `palette` (the
    /// shell's colours: `dr_shell::workspace::editors::base_style`).
    fn open_with(
        ws: &Workspace,
        book: &str,
        doc: &str,
        chrome: bool,
        palette: Option<&'static dr_ui::tokens::Palette>,
    ) -> Shot {
        let text_system = gpui_platform::current_platform(true).text_system();
        let mut cx = HeadlessAppContext::with_platform(
            text_system,
            Arc::new(dr_ui::Assets::new()),
            gpui_platform::current_headless_renderer,
        );
        cx.allow_parking();
        cx.update(|cx| {
            if let Err(e) = dr_ui::init(cx) {
                eprintln!("dr-ui fonts: {e} (menus fall back)");
            }
            gpui_prose::bind_keys(cx);
            if let Some(p) = palette {
                dr_ui::theme::force_appearance(
                    Some(if p.dark {
                        dr_ui::theme::Appearance::Dark
                    } else {
                        dr_ui::theme::Appearance::Light
                    }),
                    cx,
                );
            }
        });
        let (ground, ink) = match palette {
            Some(p) => (p.page.solid(), p.ink(1).solid()),
            None => (hsla(40. / 360., 0.2, 0.985, 1.), hsla(0., 0., 0.12, 1.)),
        };
        let mut slot = None;
        let (ws, book, doc) = (ws.clone(), book.to_owned(), doc.to_owned());
        let window = cx
            .open_window(size(px(WIDTH), px(HEIGHT)), |window, cx| {
                let view = cx.new(|cx| {
                    let mut v =
                        ChapterEditor::open(ws, &book, &doc, EditorSettings::default(), window, cx)
                            .expect("open the chapter");
                    if chrome {
                        v.set_chrome(Some(Rc::new(Chrome)), cx);
                    }
                    let p = palette.unwrap_or(&dr_ui::tokens::Palette::LIGHT);
                    let link = match palette {
                        Some(p) => p.accent.solid(),
                        None => hsla(0.58, 0.55, 0.42, 1.),
                    };
                    if palette.is_some() {
                        v.set_base_style(
                            gpui_prose::ProseStyle {
                                text: p.ink(1).solid(),
                                muted: p.muted().solid(),
                                background: gpui::transparent_black(),
                                selection: p.accent.alpha(0.22),
                                cursor: p.accent.solid(),
                                link,
                                ..gpui_prose::ProseStyle::default()
                            },
                            cx,
                        );
                    }
                    // The paint layers draw the links (and their cards).
                    v.set_decor_looks(dr_editor::decor::DecorLooks::new(p, link, false), cx);
                    v
                });
                slot = Some(view.clone());
                cx.new(|_| Page { view, ground, ink })
            })
            .expect("the window");
        let mut shot = Shot {
            cx,
            window: window.into(),
            view: slot.expect("the view"),
        };
        let view = shot.view.clone();
        shot.update(|window, cx| {
            let editor = view.read(cx).editor().clone();
            let focus = gpui::Focusable::focus_handle(editor.read(cx), cx);
            window.focus(&focus, cx);
        });
        shot.settle();
        shot
    }

    fn update<R>(&mut self, f: impl FnOnce(&mut Window, &mut App) -> R) -> R {
        self.cx
            .update_window(self.window, |_, window, cx| f(window, cx))
            .expect("the window")
    }

    fn draw(&mut self) {
        self.cx.run_until_parked();
        self.update(|window, cx| {
            window.simulate_next_frame(cx);
            window.refresh();
            window.draw(cx).clear(cx);
        });
    }

    fn settle(&mut self) {
        for _ in 0..4 {
            self.draw();
        }
    }

    fn editor<R>(
        &mut self,
        f: impl FnOnce(
            &mut gpui_prose::ProseEditor,
            &mut Window,
            &mut Context<gpui_prose::ProseEditor>,
        ) -> R,
    ) -> R {
        let view = self.view.clone();
        self.update(|window, cx| {
            let editor = view.read(cx).editor().clone();
            editor.update(cx, |e, cx| f(e, window, cx))
        })
    }

    fn type_text(&mut self, text: &str) {
        for c in text.chars() {
            let s = c.to_string();
            self.editor(|e, window, cx| e.replace_text_in_range(None, &s, window, cx));
            self.draw();
        }
        self.settle();
    }

    fn save(&mut self, dir: &Path, name: &str) {
        self.settle();
        let image = self
            .cx
            .capture_screenshot(self.window)
            .expect("capture the window");
        image.save(dir.join(name)).expect("write the screenshot");
        eprintln!("wrote {}", dir.join(name).display());
    }
}

/// A synthetic picture: a harbour at dusk in flat bands.
fn harbour_png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("png header");
        let horizon = height * 3 / 5;
        let mut data = Vec::with_capacity((width * height * 3) as usize);
        for y in 0..height {
            for x in 0..width {
                let t = y as f32 / horizon as f32;
                let px = if y < horizon {
                    // The sky: warm at the horizon, cooler above.
                    [
                        (120. + 110. * t) as u8,
                        (130. + 70. * t) as u8,
                        (170. - 30. * t) as u8,
                    ]
                } else {
                    // The water, with a lamp's streak.
                    let streak =
                        (x as i32 - (width as i32) * 2 / 3).unsigned_abs() < 6 && (y / 4) % 2 == 0;
                    if streak {
                        [235, 205, 140]
                    } else {
                        let d = (y - horizon) as f32 / (height - horizon) as f32;
                        [
                            (70. - 30. * d) as u8,
                            (90. - 35. * d) as u8,
                            (110. - 30. * d) as u8,
                        ]
                    }
                };
                data.extend_from_slice(&px);
            }
        }
        writer.write_image_data(&data).expect("png data");
    }
    bytes
}

/// A material whose asset is `bytes`: its id.
fn material_with_asset(
    ws: &Workspace,
    book: &str,
    dir: &Path,
    (kind, mime, ext): (&str, &str, &str),
    title: &str,
    bytes: &[u8],
    dimensions: Option<(u32, u32)>,
) -> String {
    let file = dir.join(format!("{title}.{ext}"));
    std::fs::write(&file, bytes).expect("the asset file");
    let asset = dr_model::id::new_uuid_v7();
    let record = ws
        .library()
        .import_asset(&dr_store::asset::SourceImport {
            book_id: book,
            asset_id: &asset,
            source: &file,
            mime,
            ext,
            dimensions,
            limit: 16 << 20,
        })
        .expect("import the asset");
    let mut put = json!({"book": book, "id": asset, "kind": kind, "mime": mime,
                         "size": bytes.len(), "sha256": record.sha256});
    if let Some((w, h)) = dimensions {
        put["width"] = w.into();
        put["height"] = h.into();
    }
    out(ws, "asset.put", put);
    out(
        ws,
        "material.create",
        json!({"book": book, "kind": kind, "title": title, "asset": asset}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// A material note in `palette`'s theme: a highlight, a table (the caret in
/// a cell, its bar up), a picture and a PDF.
fn note_shot(
    ws: &Workspace,
    book: &str,
    doc: &str,
    materials: (&str, &str),
    palette: &'static dr_ui::tokens::Palette,
    dir: &Path,
    (name, cells_selected): (&str, bool),
) {
    let mut shot = Shot::open_with(ws, book, doc, false, Some(palette));
    let view = shot.view.clone();
    // The highlight: 整件事里少数可以重复核对的事实.
    let text = shot.editor(|e, _, _| e.book().chapters[0].doc.plain_text());
    let start = text.chars().position(|c| c == '整').unwrap_or(0);
    let end = text
        .chars()
        .position(|c| c == '实')
        .map_or(start, |i| i + 1);
    shot.editor(|e, window, cx| e.select(0, start..end, window, cx));
    shot.update(|window, cx| view.update(cx, |v, cx| v.toggle_highlight(window, cx)));
    // The picture and the PDF after the second paragraph, the table after
    // the first.
    let second_end = shot.editor(|e, _, _| {
        let d = &e.book().chapters[0].doc;
        d.line_start(1) + d.line(1).chars
    });
    shot.editor(|e, window, cx| e.select(0, second_end..second_end, window, cx));
    shot.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.insert_material(materials.1, window, cx);
        })
    });
    shot.editor(|e, window, cx| e.select(0, second_end..second_end, window, cx));
    shot.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.insert_material(materials.0, window, cx);
        })
    });
    let first_end = shot.editor(|e, _, _| e.book().chapters[0].doc.line(0).chars);
    let cells: Vec<Vec<String>> = [
        ["人物", "时间", "说法"],
        ["约格", "傍晚六点", "看见一艘没挂灯的船"],
        ["许岚竹", "七点前后", "听见两声汽笛\n第二声更长"],
    ]
    .iter()
    .map(|r| r.iter().map(|c| c.to_string()).collect())
    .collect();
    shot.update(|window, cx| {
        let embeds = view.read(cx).note_embeds().expect("a note").clone();
        dr_editor::embeds::insert_table(&embeds, first_end, cells, Vec::new(), window, cx);
    });
    shot.settle();
    // The caret at the end of 七点前后, the bar up.
    let table = shot.update(|_, cx| view.read(cx).note_embeds().unwrap().tables()[0].clone());
    shot.update(|window, cx| table.update(cx, |t, cx| t.focus_cell(2, 1, true, window, cx)));
    if cells_selected {
        // Two rows of two cells, selected whole.
        shot.update(|window, cx| {
            table.update(cx, |t, cx| t.select_cells((1, 0), (2, 1), window, cx))
        });
    }
    shot.cx
        .advance_clock(dr_editor::table::BAR_RETURN + Duration::from_millis(20));
    shot.settle();
    shot.cx.advance_clock(Duration::from_secs(1));
    shot.save(dir, name);
}

/// Immersive writing's page (M26): the paper alone (the shell hides the
/// rest), every paragraph but the caret's faded, the caret's row held on
/// the typewriter line.
fn immersive_shot(
    ws: &Workspace,
    book: &str,
    palette: &'static dr_ui::tokens::Palette,
    dir: &Path,
    (name, title): (&str, &str),
) {
    let text = [
        "潮水退到第三道石阶的时候，叶青知才把值班表合上。",
        "码头上只剩一盏灯还亮着，灯罩上的锈把光切成了几块，落在湿漉漉的木板上，像有人随手丢下的纸片。",
        "她想起约格说过，这盏灯是整座码头最老的东西，比石阶还老，比他自己守在这里的年头还要长。",
        "远处传来两声汽笛，第二声更长。她数了数，和昨晚一样，中间隔着九秒。",
        "她没有回头，只是把手里的铅笔换到左手，在本子边上画了一道短线，又画了一道。",
        "风从海面上推过来，带着铁锈和海藻的味道。灯光又一次扫过窗户，玻璃里那个影子还在，比刚才近了一点。",
        "她终于站起来，把本子塞进外套口袋，沿着石阶往下走，脚步声很轻，轻得像是怕吵醒什么。",
        "第三道石阶上有一枚铁钉，钉帽朝上，亮得不像是在水里泡过一夜。",
        "她弯腰捡起来，攥在手心里，冰凉的。",
        "灯又亮了一下。",
    ]
    .join("\n");
    let id = out(
        ws,
        "chapter.create",
        json!({"book": book, "title": title, "text": text, "summary": "潮退之后，叶青知在码头数汽笛。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut shot = Shot::open_with(ws, book, &format!("node:{id}"), true, Some(palette));
    let view = shot.view.clone();
    shot.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.set_immersive(true, cx);
            v.editor()
                .clone()
                .update(cx, |e, cx| e.set_paragraph_focus(true, cx));
        })
    });
    // The caret at the end of the sixth paragraph, a word typed there.
    let end = shot.editor(|e, _, _| {
        let d = &e.book().chapters[0].doc;
        d.line_start(5) + d.line(5).chars
    });
    shot.editor(|e, window, cx| e.select(0, end..end, window, cx));
    shot.type_text("她数到九。");
    shot.cx.advance_clock(Duration::from_secs(1));
    shot.save(dir, name);
}

fn main() {
    let dir = PathBuf::from(
        std::env::args()
            .nth(1)
            .unwrap_or_else(|| "f4e-capture".into()),
    );
    std::fs::create_dir_all(&dir).expect("the folder");
    let tmp = tempfile::tempdir().expect("temp dir");
    let lib = dr_store::Library::open(tmp.path(), library_options("capture")).expect("library");
    let ws = Workspace::open(lib, WorkspaceOptions::default()).expect("workspace");
    let book = out(&ws, "book.create", json!({"name": "潮汐档案"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let people = out(
        &ws,
        "category.create",
        json!({"book": book, "name": "人物"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let line = out(
        &ws,
        "storyline.create",
        json!({"book": book, "name": "码头线"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (name, aliases) in [
        ("叶青知", vec!["叶工"]),
        ("约格", vec!["老约"]),
        ("许岚竹", vec![]),
    ] {
        let summary = if name == "约格" {
            "码头的看守，记得每一艘船的名字。"
        } else {
            ""
        };
        out(
            &ws,
            "element.create",
            json!({"book": book, "name": name, "aliases": aliases, "category": people, "summary": summary}),
        );
    }
    out(
        &ws,
        "chapter.create",
        json!({"book": book, "title": "返航之前", "text": "开头。"}),
    );
    let text = "叶青知到达码头时，先记下了窗玻璃中一闪而过的倒影。她翻开值班表，把眼前的情形与上一次的记录放在一起。\n灯光每隔九秒扫过一次窗户，这是整件事里少数可以重复核对的事实。\n";
    let id = out(
        &ws,
        "chapter.create",
        json!({"book": book, "title": "灯下的观察", "text": text, "summary": "叶青知在码头核对两份抄本。", "storyline": line}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("node:{id}");
    let empty = format!(
        "node:{}",
        out(
            &ws,
            "chapter.create",
            json!({"book": book, "title": "空白的一章"})
        )["id"]
            .as_str()
            .unwrap()
    );

    // The page, with names linked as they were typed.
    let mut shot = Shot::open(&ws, &book, &doc);
    let end = shot.editor(|e, _, _| {
        let d = &e.book().chapters[0].doc;
        d.line_start(1) + d.line(1).chars
    });
    shot.editor(|e, window, cx| e.select(0, end..end, window, cx));
    shot.type_text("约格在门外等着。");
    shot.cx
        .advance_clock(dr_editor::assist::LINK_DELAY + Duration::from_millis(20));
    shot.save(&dir, "page.png");

    // A link's hover card: the pointer rests on 约格.
    shot.cx.advance_clock(Duration::from_millis(200));
    shot.settle();
    let ids = shot.editor(|e, _, _| {
        (0..8).map(|i| format!("l{i}")).find(|id| {
            e.decoration_range(0, "links", id)
                .is_some_and(|r| e.book().chapters[0].doc.slice(r.clone()) == "约格")
        })
    });
    if let Some(id) = ids {
        shot.editor(|_, _, cx| {
            cx.emit(gpui_prose::render::DecorationEvent::Pointed {
                ids: vec![(
                    0,
                    gpui_prose::render::DecorationKey {
                        group: "links".into(),
                        id: id.into(),
                    },
                )],
            })
        });
        shot.cx.advance_clock(Duration::from_millis(240));
        shot.save(&dir, "link-card.png");
        shot.editor(|_, _, cx| {
            cx.emit(gpui_prose::render::DecorationEvent::Pointed { ids: Vec::new() })
        });
        shot.cx.advance_clock(Duration::from_millis(240));
    }

    // The @ picker.
    shot.type_text("他看见@叶");
    shot.save(&dir, "picker.png");
    shot.update(|window, cx| {
        window.dispatch_keystroke(gpui::Keystroke::parse("escape").unwrap(), cx)
    });
    shot.type_text("。");

    // The slash menu.
    shot.editor(|e, window, cx| e.press_enter(window, cx));
    shot.type_text("/");
    shot.save(&dir, "slash.png");
    shot.update(|window, cx| {
        window.dispatch_keystroke(gpui::Keystroke::parse("escape").unwrap(), cx)
    });

    // The selection bar.
    shot.editor(|e, window, cx| e.select(0, 6..20, window, cx));
    shot.settle();
    shot.cx.advance_clock(BAR_DELAY + Duration::from_millis(20));
    shot.save(&dir, "bar.png");
    drop(shot);

    // An empty chapter: the hint.
    let mut shot = Shot::open(&ws, &book, &empty);
    shot.save(&dir, "empty.png");
    drop(shot);

    // A material note, light and dark.
    let picture = material_with_asset(
        &ws,
        &book,
        tmp.path(),
        ("image", "image/png", "png"),
        "码头旧照",
        &harbour_png(560, 180),
        Some((560, 180)),
    );
    let pdf = material_with_asset(
        &ws,
        &book,
        tmp.path(),
        ("pdf", "application/pdf", "pdf"),
        "潮汐表 1987",
        b"%PDF-1.4\n% a stub for the capture\n%%EOF\n",
        None,
    );
    for (palette, name, cells_selected) in [
        (&dr_ui::tokens::Palette::LIGHT, "note-light.png", false),
        (&dr_ui::tokens::Palette::DARK, "note-dark.png", false),
        (&dr_ui::tokens::Palette::LIGHT, "note-cells-light.png", true),
        (&dr_ui::tokens::Palette::DARK, "note-cells-dark.png", true),
    ] {
        // Each shot on a fresh copy of the note.
        let copy = out(
            &ws,
            "material.create",
            json!({"book": book, "kind": "text", "title": "第三次走访",
                   "text": "三个人说的时间对不上，先列在一起。\n灯光每隔九秒扫过一次窗户，这是整件事里少数可以重复核对的事实。\n"}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        note_shot(
            &ws,
            &book,
            &format!("material:{copy}"),
            (&picture, &pdf),
            palette,
            &dir,
            (name, cells_selected),
        );
    }
    // Titles the text does not hold (a title is a name the text links to).
    for (palette, name, title) in [
        (
            &dr_ui::tokens::Palette::LIGHT,
            "immersive-light.png",
            "石阶以下",
        ),
        (
            &dr_ui::tokens::Palette::DARK,
            "immersive-dark.png",
            "数汽笛的人",
        ),
    ] {
        immersive_shot(&ws, &book, palette, &dir, (name, title));
    }
    let _ = ws.shutdown();
}
