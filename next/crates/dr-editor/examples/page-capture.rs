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
}

impl Render for Page {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .bg(hsla(40. / 360., 0.2, 0.985, 1.))
            .text_color(hsla(0., 0., 0.12, 1.))
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
        });
        let mut slot = None;
        let (ws, book, doc) = (ws.clone(), book.to_owned(), doc.to_owned());
        let window = cx
            .open_window(size(px(WIDTH), px(HEIGHT)), |window, cx| {
                let view = cx.new(|cx| {
                    let mut v =
                        ChapterEditor::open(ws, &book, &doc, EditorSettings::default(), window, cx)
                            .expect("open the chapter");
                    v.set_chrome(Some(Rc::new(Chrome)), cx);
                    // The paint layers draw the links (and their cards).
                    v.set_decor_looks(
                        dr_editor::decor::DecorLooks::new(
                            &dr_ui::tokens::Palette::LIGHT,
                            hsla(0.58, 0.55, 0.42, 1.),
                            false,
                        ),
                        cx,
                    );
                    v
                });
                slot = Some(view.clone());
                cx.new(|_| Page { view })
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
    let _ = ws.shutdown();
}
