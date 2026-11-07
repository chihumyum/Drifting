//! The paint layers (F4d): `decor` measures frames with and without a few
//! hundred decorations on the longest chapter of the heavy seed; `capture`
//! writes screenshots of synthetic prose with every decoration, block style
//! and immersive writing's focus.
//!
//! Both run GPUI headless (its test platform, the real macOS text system and
//! the Metal renderer drawing into a texture): no window opens, nothing
//! needs screen-recording permission, and the clock is GPUI's test clock, so
//! a transition can be caught half-way.
//!
//! Frame time is the CPU time of one whole frame (render, layout, paint) of
//! the editor, as the window benchmark's "work per frame". The plain and the
//! decorated chapter are measured in alternation, so a busy machine slows
//! both alike. The chapter is open through its workspace session
//! (`dr_editor::SessionSource`), so the typing passes write to storage; the
//! screenshots' synthetic pages use gpui-prose's standalone `LoroSource`
//! (`ProseDoc::from_paragraphs`), since they are not the seed's.

use std::{
    path::{Path, PathBuf},
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use dr_testkit::rng::Rng;
use gpui::{
    AnyWindowHandle, AppContext as _, Context, Entity, EntityInputHandler, HeadlessAppContext,
    Hsla, IntoElement, ParentElement, Render, SharedString, Styled, Window, div, hsla, px, size,
};
use gpui_prose::{
    BlockKind, Book, Chapter, EditorOptions, ProseDoc, ProseEditor, ProseStyle,
    render::{
        BlockStyle, Decoration, Emphasis, Look, SandTexture, Strength, Tick, TickLane, Touch,
        Underline, Wash,
    },
    schema::block,
};
use serde_json::json;

use crate::{
    corpus::Corpus,
    report::{self, summary},
};

/// Seeds the decorations' placement and the synthetic textures.
const DECOR_SEED: u64 = 0x5eed_dec0;

const WIDTH: f32 = 1100.;
const HEIGHT: f32 = 820.;

/// The page shown in the headless window.
struct Page {
    editor: Entity<ProseEditor>,
    background: Hsla,
}

impl Render for Page {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .bg(self.background)
            .child(ProseEditor::element(&self.editor, cx))
    }
}

struct Headless {
    cx: HeadlessAppContext,
    window: AnyWindowHandle,
    editor: Entity<ProseEditor>,
}

impl Headless {
    fn new(book: Book, style: ProseStyle) -> Headless {
        let text_system = gpui_platform::current_platform(true).text_system();
        let mut cx = HeadlessAppContext::with_platform(
            text_system,
            Arc::new(()),
            gpui_platform::current_headless_renderer,
        );
        // The workspace's holders run on their own threads.
        cx.allow_parking();
        let background = style.background;
        let options = EditorOptions {
            cursor_blink: None,
            ..EditorOptions::default()
        };
        let mut slot = None;
        let window = cx
            .open_window(size(px(WIDTH), px(HEIGHT)), |window, cx| {
                let editor =
                    cx.new(|cx| ProseEditor::with_options(book, style, options, window, cx));
                slot = Some(editor.clone());
                cx.new(|_| Page { editor, background })
            })
            .expect("open the headless window");
        let mut h = Headless {
            cx,
            window: window.into(),
            editor: slot.expect("the editor"),
        };
        for _ in 0..4 {
            h.draw();
        }
        h
    }

    fn editor<R>(
        &mut self,
        f: impl FnOnce(&mut ProseEditor, &mut Window, &mut Context<ProseEditor>) -> R,
    ) -> R {
        let editor = self.editor.clone();
        self.cx
            .update_window(self.window, |_, window, cx| {
                editor.update(cx, |e, cx| f(e, window, cx))
            })
            .expect("the window")
    }

    /// One frame: re-render, lay out and paint. Its CPU time in ms.
    fn draw(&mut self) -> f64 {
        self.cx.run_until_parked();
        let editor = self.editor.clone();
        self.cx
            .update_window(self.window, |_, window, cx| {
                window.simulate_next_frame(cx);
                editor.update(cx, |_, cx| cx.notify());
                let t = Instant::now();
                window.draw(cx).clear(cx);
                t.elapsed().as_secs_f64() * 1000.
            })
            .expect("the window")
    }

    fn settle(&mut self, by: Duration) {
        self.cx.advance_clock(by);
        for _ in 0..3 {
            self.draw();
        }
    }

    fn save(&mut self, dir: &Path, name: &str) {
        let image = self
            .cx
            .capture_screenshot(self.window)
            .expect("capture the window");
        image.save(dir.join(name)).expect("write the screenshot");
        println!("wrote {name}");
    }
}

// ----- textures -----------------------------------------------------------------------

/// The textures a host hands the editor: loaded from a directory of
/// `hl.png`, `hl-hot.png`, `ul.png` and `blob-0..5.png` (Drifting's are in
/// dr-ui's assets), or synthetic grains drawn here.
pub struct Textures {
    pub swash: Rc<SandTexture>,
    pub swash_hot: Rc<SandTexture>,
    pub underline: Rc<SandTexture>,
    pub seals: Vec<Rc<SandTexture>>,
}

/// Grains along a band: `count` circles, denser in the middle, thinning
/// and drying towards the right end; `keep` of them (a sparser stroke from
/// the same seed).
fn grains(seed: u64, w: f32, h: f32, half: f32, count: usize, keep: usize) -> String {
    let mut rng = Rng::new(seed);
    let mut out = String::new();
    let mut unit = || rng.unit() as f32;
    for i in 0..count {
        let x = unit() * w;
        let along = x / w;
        // The band wavers and narrows to a dry tail.
        let wave = (along * 9.).sin() * 0.12 + (along * 23.).sin() * 0.05;
        let reach = half * (1. - along.powf(3.) * 0.55) * (1. + wave);
        let spread = (unit() + unit() + unit()) / 3. * 2. - 1.;
        let y = h / 2. + spread * reach;
        let dry = along > 0.9 && unit() < (along - 0.9) * 6.;
        let r = 0.7 + unit() * 1.6 * (1. - along * 0.4);
        let skip = i % count.max(1) >= keep || dry;
        if !skip {
            out.push_str(&format!(
                r#"<circle cx="{x:.1}" cy="{y:.1}" r="{r:.2}" fill="white"/>"#
            ));
        }
    }
    out
}

fn seal(seed: u64) -> String {
    let mut rng = Rng::new(seed);
    let mut out = String::new();
    for _ in 0..260 {
        let a = rng.unit() as f32 * std::f32::consts::TAU;
        let d = (rng.unit() as f32).sqrt() * 38.;
        let r = 1.2 + rng.unit() as f32 * 2.5;
        out.push_str(&format!(
            r#"<circle cx="{:.1}" cy="{:.1}" r="{r:.2}" fill="white"/>"#,
            48. + a.cos() * d,
            48. + a.sin() * d * 0.9
        ));
    }
    out
}

impl Textures {
    pub fn synthetic() -> Textures {
        Textures {
            swash: Rc::new(SandTexture::from_svg(
                "bench/hl",
                720.,
                64.,
                grains(DECOR_SEED + 1, 720., 64., 22., 5200, 5200),
            )),
            swash_hot: Rc::new(SandTexture::from_svg(
                "bench/hl-hot",
                720.,
                64.,
                grains(DECOR_SEED + 1, 720., 64., 22., 5200, 3400),
            )),
            underline: Rc::new(SandTexture::from_svg(
                "bench/ul",
                720.,
                26.,
                grains(DECOR_SEED + 2, 720., 26., 5., 2600, 2600),
            )),
            seals: (0..6)
                .map(|i| {
                    Rc::new(SandTexture::from_svg(
                        format!("bench/blob-{i}"),
                        96.,
                        96.,
                        seal(DECOR_SEED + 10 + i),
                    ))
                })
                .collect(),
        }
    }

    pub fn load(dir: &Path) -> Textures {
        let png = |name: &str| {
            let bytes = std::fs::read(dir.join(format!("{name}.png")))
                .unwrap_or_else(|e| panic!("read {name}.png: {e}"));
            Rc::new(
                SandTexture::from_png(format!("host/{name}"), &bytes)
                    .unwrap_or_else(|| panic!("{name}.png is not a PNG")),
            )
        };
        Textures {
            swash: png("hl"),
            swash_hot: png("hl-hot"),
            underline: png("ul"),
            seals: (0..6).map(|i| png(&format!("blob-{i}"))).collect(),
        }
    }
}

// ----- looks (Drifting's values, from the design system) -------------------------

struct Inks {
    comment: Hsla,
    todo: Hsla,
    entity: Hsla,
    accent: Hsla,
    new: Hsla,
    changed: Hsla,
    external: Hsla,
}

impl Inks {
    fn light() -> Inks {
        Inks {
            comment: hsla(355. / 360., 0.55, 0.42, 1.),
            todo: hsla(40. / 360., 0.78, 0.45, 1.),
            entity: hsla(200. / 360., 0.5, 0.36, 1.),
            accent: hsla(210. / 360., 0.9, 0.5, 1.),
            new: hsla(148. / 360., 0.42, 0.34, 1.),
            changed: hsla(258. / 360., 0.42, 0.52, 1.),
            external: hsla(214. / 360., 0.62, 0.4, 1.),
        }
    }

    fn dark() -> Inks {
        Inks {
            comment: hsla(355. / 360., 0.62, 0.66, 0.72),
            todo: hsla(42. / 360., 0.8, 0.62, 0.72),
            entity: hsla(200. / 360., 0.55, 0.68, 1.),
            accent: hsla(210. / 360., 0.9, 0.62, 1.),
            new: hsla(148. / 360., 0.4, 0.66, 1.),
            changed: hsla(252. / 360., 0.6, 0.78, 1.),
            external: hsla(210. / 360., 0.72, 0.74, 1.),
        }
    }
}

fn comment(t: &Textures, inks: &Inks, id: String, range: std::ops::Range<usize>) -> Decoration {
    Decoration::new(
        id,
        range,
        Look::Wash(Wash::sand(
            t.swash.clone(),
            Some(t.swash_hot.clone()),
            inks.comment,
            Strength::new(0.27, 0.61),
        )),
    )
    .touch(Touch::POINT)
    .tick(Tick {
        color: inks.comment,
        lane: TickLane::Span,
    })
}

fn todo(t: &Textures, inks: &Inks, id: String, range: std::ops::Range<usize>) -> Decoration {
    Decoration::new(
        id,
        range,
        Look::Wash(Wash::sand(
            t.swash.clone(),
            Some(t.swash_hot.clone()),
            inks.todo,
            Strength::new(0.29, 0.66),
        )),
    )
    .touch(Touch::POINT)
    .tick(Tick {
        color: inks.todo,
        lane: TickLane::Span,
    })
}

fn entity(t: &Textures, inks: &Inks, id: String, range: std::ops::Range<usize>) -> Decoration {
    Decoration::new(
        id,
        range,
        Look::Underline(Underline::sand(
            t.underline.clone(),
            inks.entity,
            Strength::new(0.7, 0.95),
        )),
    )
    .touch(Touch::HOVER)
}

fn suggestion(inks: &Inks, id: String, range: std::ops::Range<usize>) -> Decoration {
    Decoration::new(
        id,
        range,
        Look::Underline(Underline::dotted(inks.entity, Strength::new(0.55, 0.85))),
    )
}

fn find(inks: &Inks, id: String, range: std::ops::Range<usize>, current: bool) -> Decoration {
    Decoration::new(
        id,
        range,
        Look::Wash(Wash::flat(inks.accent, Strength::new(0.16, 0.34))),
    )
    .emphasis(if current {
        Emphasis::Hot
    } else {
        Emphasis::Rest
    })
}

fn agent(inks: &Inks, id: String, range: std::ops::Range<usize>, kind: u8) -> Decoration {
    let (color, lane) = match kind {
        0 => (inks.new, 0),
        1 => (inks.changed, 1),
        _ => (inks.external, 1),
    };
    Decoration::new(id, range, Look::Ink(color))
        .touch(Touch::Fade)
        .tick(Tick {
            color,
            lane: TickLane::Lane(lane),
        })
}

// ----- the benchmark ----------------------------------------------------------------

/// How many of each decoration the decorated chapter carries.
const COMMENTS: usize = 400;
const LINKS: usize = 300;
const SUGGESTIONS: usize = 120;
const FINDS: usize = 120;
const AGENT: usize = 60;

fn decorate(h: &mut Headless, t: &Textures, inks: &Inks) -> f64 {
    let len = h.editor(|e, _, _| e.book().chapters[0].doc.len_chars());
    let mut rng = Rng::new(DECOR_SEED);
    let mut spans = |n: usize, lo: usize, hi: usize| -> Vec<std::ops::Range<usize>> {
        (0..n)
            .map(|_| {
                let start = rng.below((len - hi - 1) as u64) as usize;
                start..start + rng.range(lo, hi)
            })
            .collect()
    };
    let comments: Vec<Decoration> = spans(COMMENTS, 4, 60)
        .into_iter()
        .enumerate()
        .map(|(i, r)| comment(t, inks, format!("c{i}"), r))
        .collect();
    let links: Vec<Decoration> = spans(LINKS, 2, 4)
        .into_iter()
        .enumerate()
        .map(|(i, r)| entity(t, inks, format!("e{i}"), r))
        .chain(
            spans(SUGGESTIONS, 2, 3)
                .into_iter()
                .enumerate()
                .map(|(i, r)| suggestion(inks, format!("s{i}"), r)),
        )
        .collect();
    let finds: Vec<Decoration> = spans(FINDS, 2, 2)
        .into_iter()
        .enumerate()
        .map(|(i, r)| find(inks, format!("f{i}"), r, i == 7))
        .collect();
    let agents: Vec<Decoration> = spans(AGENT, 6, 80)
        .into_iter()
        .enumerate()
        .map(|(i, r)| agent(inks, format!("a{i}"), r, (i % 3) as u8))
        .collect();
    let seals = t.seals.clone();
    let started = Instant::now();
    h.editor(move |e, _, cx| {
        e.set_tick_seals(seals, cx);
        e.set_decorations(0, "comments", comments, cx);
        e.set_decorations(0, "links", links, cx);
        e.set_decorations(0, "find", finds, cx);
        e.set_decorations(0, "agent", agents, cx);
    });
    let set_ms = started.elapsed().as_secs_f64() * 1000.;
    h.settle(Duration::from_secs(2));
    set_ms
}

fn undecorate(h: &mut Headless) {
    h.editor(|e, _, cx| e.clear_decorations(cx));
    h.settle(Duration::from_secs(1));
}

/// Scrolls the chapter top to bottom, `step` px a frame.
fn scroll_pass(h: &mut Headless, step: f64, frames: &mut Vec<f64>) {
    h.editor(|e, _, cx| {
        e.scroll_by_estimate(-1e9, cx);
    });
    h.draw();
    let viewport = f64::from(HEIGHT);
    for _ in 0..20_000 {
        let at_end = h.editor(|e, _, cx| {
            let (y, total) = e.scroll_y();
            if y + viewport >= total - 1. {
                return true;
            }
            e.scroll_by_estimate(step, cx);
            false
        });
        if at_end {
            break;
        }
        frames.push(h.draw());
    }
}

/// Types `count` characters one at a time in the middle of the chapter,
/// each followed by a frame; then takes them back out.
fn typing_pass(h: &mut Headless, count: usize, keys: &mut Vec<f64>) {
    let at = h.editor(|e, window, cx| {
        let doc = &e.book().chapters[0].doc;
        let line = doc.visible_lines() / 2;
        let at = doc.line_start(line) + 3;
        e.select(0, at..at, window, cx);
        at
    });
    h.draw();
    for i in 0..count {
        let t = Instant::now();
        h.editor(|e, window, cx| {
            e.replace_text_in_range(None, if i % 2 == 0 { "字" } else { "句" }, window, cx);
        });
        let edit = t.elapsed().as_secs_f64() * 1000.;
        keys.push(edit + h.draw());
    }
    h.editor(|e, window, cx| {
        e.select(0, at..at + count, window, cx);
        e.press_backspace(window, cx);
    });
    h.draw();
}

pub fn run_decor(write: bool) {
    let corpus = Corpus::heavy();
    let load_start = report::load();
    let textures = Textures::synthetic();
    let inks = Inks::light();
    let mut h = Headless::new(corpus.chapter(), ProseStyle::default());
    let chars_before = h.editor(|e, _, _| e.book().chapters[0].doc.len_chars());
    let (mut scroll_plain, mut scroll_decor) = (Vec::new(), Vec::new());
    let (mut type_plain, mut type_decor) = (Vec::new(), Vec::new());
    let mut set_ms = Vec::new();
    let mut painted = 0usize;
    for round in 0..3 {
        undecorate(&mut h);
        scroll_pass(&mut h, 48., &mut scroll_plain);
        typing_pass(&mut h, 120, &mut type_plain);
        set_ms.push(decorate(&mut h, &textures, &inks));
        scroll_pass(&mut h, 48., &mut scroll_decor);
        if round == 0 {
            painted = h.editor(|e, _, _| e.painted_decorations());
        }
        typing_pass(&mut h, 120, &mut type_decor);
    }
    let chars_after = h.editor(|e, _, _| e.book().chapters[0].doc.len_chars());
    drop(h);
    let load_end = report::load();
    let p95 = |samples: &[f64]| dr_testkit::evidence::Summary::of(samples).p95;
    let ratio = |a: &[f64], b: &[f64]| (p95(b) / p95(a) * 100.).round() / 100.;
    let count = COMMENTS + LINKS + SUGGESTIONS + FINDS + AGENT;
    let results = json!({
        "method": format!(
            "Headless GPUI (test platform, macOS text system, Metal into a texture), {WIDTH}x{HEIGHT} window, the longest chapter of the heavy seed open through its workspace session (dr_editor::SessionSource). Frame = CPU time of one whole editor frame (render, layout, paint). Decorated = {COMMENTS} comment swashes (sand, hot texture, ticks), {LINKS} sand underlines, {SUGGESTIONS} dotted suggestions, {FINDS} find hits, {AGENT} Agent inks (ticks), all settled. Scroll: top to bottom, 48 px a frame. Typing: 120 characters one by one mid-chapter, edit (a transaction through the session) + frame each, then taken back out. Plain and decorated alternate, 3 rounds each."
        ),
        "chapter_chars": chars_before,
        "decorations": {
            "count": count,
            "painted_in_one_view": painted,
            "set_all_groups": summary(&set_ms),
        },
        "scroll_frame": {
            "plain": summary(&scroll_plain),
            "decorated": summary(&scroll_decor),
            "p95_ratio": ratio(&scroll_plain, &scroll_decor),
            "budget_p95_ms": 16.7,
        },
        "keystroke_frame": {
            "plain": summary(&type_plain),
            "decorated": summary(&type_decor),
            "p95_ratio": ratio(&type_plain, &type_decor),
            "budget_p95_ms": 16.0,
        },
    });
    report::finish(
        "decor",
        write,
        &corpus.shape,
        results,
        (load_start, load_end),
        &[
            ("decorations are painted in the first view", painted > 0),
            (
                "every scroll pass reached the end",
                !scroll_plain.is_empty() && !scroll_decor.is_empty(),
            ),
            (
                "the typing passes left the chapter as long as before",
                chars_after == chars_before,
            ),
        ],
    );
}

// ----- screenshots -----------------------------------------------------------------

fn dark_style() -> ProseStyle {
    ProseStyle {
        text: hsla(40. / 360., 0.1, 0.86, 1.),
        muted: hsla(40. / 360., 0.05, 0.6, 1.),
        background: hsla(30. / 360., 0.06, 0.12, 1.),
        selection: hsla(210. / 360., 0.7, 0.6, 0.28),
        cursor: hsla(210. / 360., 0.9, 0.65, 1.),
        link: hsla(210. / 360., 0.7, 0.7, 1.),
        ..ProseStyle::default()
    }
}

fn dark_blocks() -> BlockStyle {
    BlockStyle {
        quote_wash: Some(hsla(30. / 360., 0.08, 0.2, 1.)),
        quote_ink: Some(hsla(40. / 360., 0.08, 0.72, 1.)),
        rule: hsla(40. / 360., 0.05, 0.5, 0.6),
        ..BlockStyle::default()
    }
}

/// Synthetic prose for the screenshots (no real book text).
const SCENE: &[(BlockKind, &str)] = &[
    (BlockKind::H1, "第三章　码头"),
    (
        BlockKind::Body,
        "林岚把吸铁石拍在桌上，说这东西能把河里的铁钉都吸上来。周舟没接话，只把灯芯往下拨了拨，屋里暗了一层。",
    ),
    (
        BlockKind::Body,
        "第二天一早，码头上围了一圈人。老秦挤在最前面，看他从水里一根一根地往外拽，拽到太阳落山，钉子堆得比膝盖还高。",
    ),
    (
        BlockKind::Body,
        "TODO：把码头这一段再压短一点，钉子的数目前后要对上",
    ),
    (
        BlockKind::Body,
        "雨停的时候，船已经离岸很远了。她回头看了一眼，岸上的灯一盏一盏地灭下去，像有人在黑里慢慢合上一本书。",
    ),
    (
        BlockKind::Body,
        "后来他们都说，那天夜里河面上起过一阵风，风里有铁锈的味道，也有人说什么都没有，只是水声比平常大一些。",
    ),
];

fn find_all(text: &str, needle: &str) -> Vec<std::ops::Range<usize>> {
    let chars: Vec<char> = text.chars().collect();
    let n: Vec<char> = needle.chars().collect();
    (0..chars.len().saturating_sub(n.len() - 1))
        .filter(|&i| chars[i..i + n.len()] == n[..])
        .map(|i| i..i + n.len())
        .collect()
}

fn scene_decorations(h: &mut Headless, t: &Textures, inks: &Inks, drawn: bool) {
    let text = h.editor(|e, _, _| e.book().chapters[0].doc.plain_text());
    let at = |needle: &str| find_all(&text, needle)[0].clone();
    let comments = vec![
        comment(t, inks, "c1".into(), at("吸铁石拍在桌上")),
        comment(
            t,
            inks,
            "c2".into(),
            at("看他从水里一根一根地往外拽，拽到太阳落山"),
        )
        .emphasis(if drawn {
            Emphasis::Drawn(1)
        } else {
            Emphasis::Hot
        }),
        todo(
            t,
            inks,
            "t1".into(),
            at("把码头这一段再压短一点，钉子的数目前后要对上"),
        ),
    ];
    let todo_keyword = Decoration::new("t1:kw", at("TODO"), Look::Ink(inks.todo));
    let links = vec![
        entity(t, inks, "e1".into(), at("林岚")),
        entity(t, inks, "e2".into(), at("周舟")),
        suggestion(inks, "s1".into(), at("老秦")),
    ];
    let finds: Vec<Decoration> = find_all(&text, "灯")
        .into_iter()
        .enumerate()
        .map(|(i, r)| find(inks, format!("f{i}"), r, i == 1))
        .collect();
    let agents = vec![
        agent(inks, "a1".into(), at("像有人在黑里慢慢合上一本书"), 0),
        agent(inks, "a2".into(), at("风里有铁锈的味道"), 1),
        agent(inks, "a3".into(), at("只是水声比平常大一些"), 2),
    ];
    let seals = t.seals.clone();
    h.editor(move |e, _, cx| {
        e.set_tick_seals(seals, cx);
        e.set_decorations(0, "comments", comments, cx);
        e.set_decorations(0, "todo", vec![todo_keyword], cx);
        e.set_decorations(0, "links", links, cx);
        e.set_decorations(0, "find", finds, cx);
        e.set_decorations(0, "agent", agents, cx);
    });
}

fn blocks_doc() -> ProseDoc {
    let mut doc = ProseDoc::from_paragraphs([
        (BlockKind::H1, "块的样子"),
        (
            BlockKind::Body,
            "正文照常排，左边齐着版心。下面两段是引文，相邻的引文画成一块，不画左边的竖条，只铺一层底色、往里收一格、换一档墨。",
        ),
        (
            BlockKind::Body,
            "“船到桥头自然直。”他说这话的时候，手里还攥着那根钉子。",
        ),
        (BlockKind::Body, "“可桥在哪儿呢？”"),
        (BlockKind::Body, "缩进一级的段落整段往右挪两个字。"),
        (
            BlockKind::Body,
            "缩进两级的段落再挪两个字，换行时也齐着自己的左边。缩进两级的段落再挪两个字，换行时也齐着自己的左边。",
        ),
        (BlockKind::Body, ""),
        (BlockKind::Body, "居中的一行"),
        (BlockKind::Body, "落款靠右　　林岚"),
        (BlockKind::H2, "H2 也能缩进、对齐"),
        (BlockKind::H3, "H3 居中"),
        (
            BlockKind::Body,
            "三级标题和正文一样吃块样式：缩进、对齐、引文都同等对待。",
        ),
    ]);
    let set = |doc: &mut ProseDoc, line: usize, key: &str, value: loro::LoroValue| {
        doc.set_block_attr(line, key, Some(value), gpui_prose::text::ORIGIN_USER);
    };
    set(&mut doc, 2, block::QUOTE, true.into());
    set(&mut doc, 3, block::QUOTE, true.into());
    set(&mut doc, 4, block::INDENT, 1i64.into());
    set(&mut doc, 5, block::INDENT, 2i64.into());
    set(&mut doc, 6, block::RULE, true.into());
    set(&mut doc, 7, block::ALIGN, "center".into());
    set(&mut doc, 8, block::ALIGN, "right".into());
    set(&mut doc, 9, block::INDENT, 1i64.into());
    set(&mut doc, 10, block::ALIGN, "center".into());
    doc.drain();
    doc
}

fn book_of(doc: ProseDoc) -> Book {
    Book::new(vec![Chapter {
        title: SharedString::from("合成样张"),
        doc,
    }])
}

pub fn run_capture(dir: String, textures: Option<String>) {
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("create the screenshot directory");
    let t = textures.map_or_else(Textures::synthetic, |d| Textures::load(Path::new(&d)));
    for (slug, style, blocks, inks) in [
        (
            "light",
            ProseStyle::default(),
            BlockStyle::default(),
            Inks::light(),
        ),
        ("dark", dark_style(), dark_blocks(), Inks::dark()),
    ] {
        // Every decoration at rest, a comment pointed at from its card, the
        // current find hit.
        let mut h = Headless::new(
            book_of(ProseDoc::from_paragraphs(SCENE.iter().copied())),
            style.clone(),
        );
        h.editor(|e, _, cx| e.set_block_style(blocks.clone(), cx));
        scene_decorations(&mut h, &t, &inks, false);
        h.settle(Duration::from_secs(1));
        h.save(&dir, &format!("decorations-{slug}.png"));
        // The same comment jumped to: drawn along its rows, caught 0.2 s in.
        scene_decorations(&mut h, &t, &inks, true);
        h.draw();
        h.settle(Duration::from_millis(200));
        h.save(&dir, &format!("drawing-{slug}.png"));
        // Everything fading in, caught 0.05 s into its 0.3 s (eased out:
        // about four tenths of its strength).
        h.editor(|e, _, cx| e.clear_decorations(cx));
        h.settle(Duration::from_millis(10));
        scene_decorations(&mut h, &t, &inks, false);
        h.draw();
        h.settle(Duration::from_millis(50));
        h.save(&dir, &format!("fading-in-{slug}.png"));

        // Block styles.
        let mut h = Headless::new(book_of(blocks_doc()), style.clone());
        h.editor(|e, _, cx| e.set_block_style(blocks.clone(), cx));
        h.settle(Duration::from_millis(100));
        h.save(&dir, &format!("blocks-{slug}.png"));

        // Immersive writing: the caret in the fourth paragraph.
        let mut h = Headless::new(
            book_of(ProseDoc::from_paragraphs(SCENE.iter().copied())),
            style.clone(),
        );
        h.editor(|e, window, cx| {
            let at = e.book().chapters[0].doc.line_start(4) + 6;
            e.select(0, at..at, window, cx);
            e.set_paragraph_focus(true, cx);
        });
        h.settle(Duration::from_secs(1));
        h.save(&dir, &format!("immersive-{slug}.png"));
    }
    // The scrollbar ticks of the decorated longest chapter of the heavy seed.
    let corpus = Corpus::heavy();
    let mut h = Headless::new(corpus.chapter(), ProseStyle::default());
    decorate(&mut h, &t, &Inks::light());
    h.editor(|e, _, cx| {
        e.scroll_by_estimate(9000., cx);
    });
    h.settle(Duration::from_millis(100));
    h.save(&dir, "dense-light.png");
    // The editor's sessions go before the workspace closes.
    drop(h);
}
