//! The workbench's paper (原型第一页): the module's name (pressed, it is
//! renamed), what it is (「我的模块 · 用在 N 个项目」, 「另存一份」), the four
//! rows that set the preview (大小、内容、宽窄、深浅) and the preview, drawn
//! by the renderer every entry page uses (`dr_view_module_look`). A press on
//! a node of the preview picks it in 「长什么样」. Images dropped or pasted on
//! the paper go to the Agent's composer (CW). The paper has none of the
//! tools in its corner (the prototype has none).

use std::rc::Rc;

use dr_i18n::keys::module_bench as k;
use dr_model::custom_module::LookSize;
use dr_shell::{
    pages::AgentImages,
    strings::{t, tf, tp},
    workspace::TITLEBAR_HEIGHT,
};
use dr_ui::{
    Theme,
    components::Segmented,
    fonts::Role,
    input::{FieldEvent, TextField},
    sand::{self, Icon},
    style::DrStyled,
    theme::Appearance,
};
use dr_view_module_look::{AppWords, Blanks, Picking, Scope, paint, plan};
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, ExternalPaths, FocusHandle, Focusable,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement as _, Styled, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::state::{Bench, Breadth, Content};

pub struct BenchPage {
    bench: Entity<Bench>,
    title: Entity<TextField>,
    _subs: Vec<Subscription>,
}

impl BenchPage {
    pub fn new(bench: Entity<Bench>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let name = bench.read(cx).name().unwrap_or_default().to_owned();
        let title = cx.new(|cx| {
            TextField::new("module-bench-title", window, cx)
                .bare()
                .with_text(name)
        });
        let subs = vec![
            cx.observe(&bench, |_, _, cx| cx.notify()),
            cx.subscribe_in(
                &title,
                window,
                |this, field, e: &FieldEvent, window, cx| match e {
                    FieldEvent::Submitted(text) => {
                        this.rename(text, cx);
                        let focus = this.bench.read(cx).focus.clone();
                        focus.focus(window, cx);
                    }
                    FieldEvent::Blurred => {
                        let text = field.read(cx).text();
                        this.rename(&text, cx);
                    }
                    FieldEvent::Cancelled => {
                        let name = this.bench.read(cx).name().unwrap_or_default().to_owned();
                        field.update(cx, |f, cx| f.set_text(name, cx));
                        let focus = this.bench.read(cx).focus.clone();
                        focus.focus(window, cx);
                    }
                    FieldEvent::Changed(_) => {}
                },
            ),
        ];
        BenchPage {
            bench,
            title,
            _subs: subs,
        }
    }

    /// The title field (tests, the debug bridge).
    pub fn title(&self) -> &Entity<TextField> {
        &self.title
    }

    fn rename(&mut self, text: &str, cx: &mut Context<Self>) {
        let text = text.to_owned();
        self.bench
            .update(cx, |b, cx| b.change(|v| crate::edit::rename(v, &text), cx));
    }

    /// Images dropped or pasted on the paper go to the Agent (CW, §8 入口 2
    /// 「拖进草图或截图」): they wait in its composer, the right column open
    /// on it. Nothing is sent.
    fn give(&self, images: AgentImages, window: &mut Window, cx: &mut Context<Self>) {
        let ws = self.bench.read(cx).ws.clone();
        ws.update(cx, |ws, cx| ws.give_agent_images(images, window, cx))
            .ok();
    }
}

impl Focusable for BenchPage {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.bench.read(cx).focus.clone()
    }
}

/// Whether the keyboard is in one of dr-ui's text inputs: ⌘Z is theirs.
pub(crate) fn typing(window: &Window) -> bool {
    window.context_stack().iter().any(|c| {
        c.contains(dr_ui::input::field::KEY_CONTEXT) || c.contains(dr_ui::input::area::KEY_CONTEXT)
    })
}

impl Render for BenchPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let bench = self.bench.read(cx);
        let focus = bench.focus.clone();
        // The name shown follows the module while it is not being typed.
        if let Some(name) = bench.name().map(str::to_owned) {
            let field = self.title.read(cx);
            if field.text() != name
                && !field.is_composing()
                && !field.focus_handle(cx).is_focused(window)
            {
                self.title.update(cx, |f, cx| f.set_text(name, cx));
            }
        }
        let bench = self.bench.read(cx);
        let head = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.0))
            .child(sand::icon(Icon::Stitched, 20.0, p.ink(2).solid()))
            .child(
                div()
                    .id("module-bench-title-field")
                    .debug_selector(|| "module-bench-title".into())
                    .flex_1()
                    .min_w_0()
                    .font_role(Role::Prose)
                    .type_px(26.0, 34.0)
                    .text_color(p.ink(1).solid())
                    .child(self.title.clone()),
            );
        let entity = self.bench.clone();
        let meta = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(10.0))
            .font_role(Role::Index)
            .type_px(13.0, 18.0)
            .text_color(p.ink(4).solid())
            .child(match bench.uses {
                Some(n) if n > 0 => tp(cx, k::USED_IN, n as u64, &[("count", &n)]),
                _ => t(cx, k::MY_MODULE),
            })
            .child(
                div()
                    .id("module-bench-save-as")
                    .debug_selector(|| "module-bench-save-as".into())
                    .role(gpui::Role::Button)
                    .aria_label(t(cx, k::SAVE_AS))
                    .cursor_pointer()
                    .text_color(p.ink(3).solid())
                    .hover(move |st| st.text_color(p.ink(1).solid()))
                    .on_click(move |_, _, cx| entity.update(cx, |b, cx| b.save_as(cx)))
                    .child(t(cx, k::SAVE_AS)),
            );
        let controls = self.controls(window, cx);
        let preview = self.preview(window, cx);
        div()
            .id("module-bench")
            .debug_selector(|| "module-bench".into())
            .key_context("ModuleBench")
            .track_focus(&focus)
            .on_action(
                cx.listener(|this, _: &dr_shell::actions::Undo, window, cx| {
                    if typing(window) {
                        cx.propagate();
                        return;
                    }
                    this.bench.update(cx, |b, cx| b.undo(cx));
                }),
            )
            .on_action(
                cx.listener(|this, _: &dr_shell::actions::Redo, window, cx| {
                    if typing(window) {
                        cx.propagate();
                        return;
                    }
                    this.bench.update(cx, |b, cx| b.redo(cx));
                }),
            )
            // ⌘V: images or files on the clipboard go to the Agent, read
            // as its composer reads them (text alone stays where it is).
            .on_action(
                cx.listener(|this, _: &dr_shell::actions::Paste, window, cx| {
                    let images = (!typing(window))
                        .then(|| cx.read_from_clipboard())
                        .flatten()
                        .and_then(|item| AgentImages::on_clipboard(&item));
                    match images {
                        Some(images) => this.give(images, window, cx),
                        None => cx.propagate(),
                    }
                }),
            )
            // Files dropped anywhere on the paper (the Agent column's wash
            // while they are over it).
            .drag_over::<ExternalPaths>(move |style, _, _, _| style.bg(p.ink(1).alpha(0.05)))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                this.give(AgentImages::Files(paths.paths().to_vec()), window, cx)
            }))
            .size_full()
            .overflow_y_scroll()
            .pt(px(TITLEBAR_HEIGHT + 28.0))
            .px(px(36.0))
            .pb(px(90.0))
            .flex()
            .flex_col()
            .gap(px(14.0))
            .font_role(Role::Ui)
            .type_px(s.body, s.line_body)
            .text_color(p.ink(1).solid())
            .child(head)
            .child(meta)
            .child(controls)
            .child(preview)
    }
}

impl BenchPage {
    /// The four rows that set the preview, on one line: 一行、一块、铺满 ·
    /// 示例、空、借真实条目 · 窄、中、宽 (not while it fills) · 浅、深.
    fn controls(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let bench = self.bench.read(cx);
        let size_at = match bench.size {
            LookSize::Line => 0,
            LookSize::Block => 1,
            LookSize::Full => 2,
        };
        let content_at = match bench.content {
            Content::Sample => 0,
            Content::Blank => 1,
            Content::Real => 2,
        };
        let real = match &bench.real {
            Some(real) => tf(cx, k::REAL_OF, &[("name", &real.title)]),
            None => t(cx, k::REAL),
        };
        let breadth_at = match bench.breadth {
            Breadth::Narrow => 0,
            Breadth::Medium => 1,
            Breadth::Wide => 2,
        };
        let dark = bench.dark.unwrap_or(theme.dark());
        let full = bench.size == LookSize::Full;
        let seg = |id: &'static str, labels: Vec<SharedString>, at: usize| {
            Segmented::new(id, labels, at).text_size(13.5).pad_x(7.0)
        };
        let gap = || div().w(px(1.0)).h(px(16.0)).bg(p.hairline());
        let e = self.bench.clone();
        let sizes = seg(
            "module-bench-size",
            vec![
                t(cx, k::size::LINE),
                t(cx, k::size::BLOCK),
                t(cx, k::size::FULL),
            ],
            size_at,
        )
        .on_change(move |i, _, cx| {
            let size = [LookSize::Line, LookSize::Block, LookSize::Full][i.min(2)];
            e.update(cx, |b, cx| b.set_size(size, cx));
        });
        let e = self.bench.clone();
        let contents = seg(
            "module-bench-content",
            vec![t(cx, k::SAMPLE), t(cx, k::BLANK), real],
            content_at,
        )
        .on_change(move |i, _, cx| {
            let content = [Content::Sample, Content::Blank, Content::Real][i.min(2)];
            e.update(cx, |b, cx| b.set_content(content, cx));
        });
        let e = self.bench.clone();
        let breadths = seg(
            "module-bench-breadth",
            vec![t(cx, k::NARROW), t(cx, k::MEDIUM), t(cx, k::WIDE)],
            breadth_at,
        )
        .on_change(move |i, _, cx| {
            let breadth = [Breadth::Narrow, Breadth::Medium, Breadth::Wide][i.min(2)];
            e.update(cx, |b, cx| b.set_breadth(breadth, cx));
        });
        let e = self.bench.clone();
        let shades = seg(
            "module-bench-shade",
            vec![t(cx, k::LIGHT), t(cx, k::DARK)],
            usize::from(dark),
        )
        .on_change(move |i, _, cx| e.update(cx, |b, cx| b.set_dark(i == 1, cx)));
        div()
            .debug_selector(|| "module-bench-controls".into())
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap_x(px(8.0))
            .gap_y(px(6.0))
            .child(sizes)
            .child(gap())
            .child(contents)
            .child(gap())
            .when(!full, |el| el.child(breadths).child(gap()))
            .child(shades)
            .into_any_element()
    }

    /// The preview: the module at the size shown, with the values chosen,
    /// in the shade chosen, as wide as chosen.
    fn preview(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let window_theme = Theme::of(window, cx);
        let bench = self.bench.read(cx);
        let Some(value) = bench.value.clone() else {
            return div().into_any_element();
        };
        let dark = bench.dark.unwrap_or(window_theme.dark());
        let appearance = if dark {
            Appearance::Dark
        } else {
            Appearance::Light
        };
        let theme = Theme {
            appearance,
            palette: appearance.palette(),
            ..window_theme
        };
        let p = theme.palette;
        if value.blocks.is_empty() {
            let wp = window_theme.palette;
            return div()
                .id("module-bench-empty")
                .debug_selector(|| "module-bench-empty".into())
                .flex()
                .flex_col()
                .items_center()
                .gap(px(12.0))
                .py(px(60.0))
                .px(px(20.0))
                .rounded(px(6.0))
                .border(px(1.0))
                .border_color(wp.hairline())
                .text_color(wp.ink(4).solid())
                .type_px(14.0, 20.0)
                .child(sand::icon(Icon::ImagePlus, 24.0, wp.ink(4).solid()))
                .child(t(cx, k::DROP_SKETCH))
                .into_any_element();
        }
        let size = bench.size;
        let (scope, blanks) = match bench.content {
            Content::Sample => (Scope::sample(&value), Blanks::Dash),
            Content::Blank => (Scope::blank(&value), Blanks::Names),
            Content::Real => match &bench.real {
                Some(real) => {
                    let names = BookNames(bench.book().cloned());
                    (Scope::read(&real.values, &names), Blanks::Dash)
                }
                None => (Scope::empty(), Blanks::Dash),
            },
        };
        let laid = plan::plan(&value, &scope, size, &AppWords(cx));
        let e = self.bench.clone();
        let picking = laid.own.then(|| Picking {
            picked: bench.sel_node.clone(),
            on_pick: Rc::new(move |path: &[u16], _: &mut Window, cx: &mut App| {
                let path = path.to_vec();
                e.update(cx, |b, cx| b.pick_node(path, cx));
            }),
        });
        let look = paint::paint_with(
            "module-bench-look",
            &laid,
            blanks,
            None,
            theme,
            picking,
            window,
            cx,
        );
        let bench = self.bench.read(cx);
        let width = if size == LookSize::Full {
            None
        } else {
            bench.breadth.px()
        };
        let frame = div()
            .id("module-bench-preview")
            .debug_selector(|| "module-bench-preview".into())
            .w_full()
            .self_center()
            .when_some(width, |el, w| el.max_w(px(w)));
        let s = theme.scale;
        let body = match size {
            LookSize::Line => div()
                .w(px(300.0))
                .mx_auto()
                .p(px(12.0))
                .rounded(px(8.0))
                .bg(p.page.solid())
                .border(px(0.5))
                .border_color(p.hairline())
                .flex()
                .flex_col()
                .gap(px(6.0))
                .when_some(bench.real.as_ref(), |el, real| {
                    el.child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.body, s.line_body)
                            .text_color(p.ink(1).solid())
                            .child(real.title.clone()),
                    )
                })
                .child(look),
            _ => div()
                .w_full()
                .rounded(px(3.0))
                .bg(p.page.solid())
                .border(px(0.5))
                .border_color(p.hairline())
                .pt(px(22.0))
                .px(px(24.0))
                .pb(px(26.0))
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    div()
                        .font_role(Role::Structure)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.ink(3).solid())
                        .child(value.name.clone()),
                )
                .child(look),
        };
        frame.child(body).into_any_element()
    }
}

/// Entry titles from the book in front; a picture is drawn as its empty
/// frame (the preview reads no files).
struct BookNames(Option<Rc<dr_shell::book::Book>>);

impl dr_view_module_look::Names for BookNames {
    fn entry(&self, id: &str) -> Option<String> {
        self.0
            .as_ref()?
            .v3()?
            .entry(id)
            .filter(|e| e.deleted_at.is_none())
            .map(|e| e.title.clone())
    }

    fn image(&self, _: &str) -> Option<dr_view_module_look::Picture> {
        None
    }
}
