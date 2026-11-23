//! The side columns the workbench brings (原型第一页): on the left
//! 「装什么」, the module's blocks and below them every kind of block; on the
//! right 「长什么样」 (the box tree of the size shown and the picked node's
//! properties, only the steps of §4's list) and 「写给 Agent」 (the template's
//! three, and one sentence for each block). The right column's third tab,
//! 「Agent」, is the shell's: the same conversation.

use std::collections::BTreeMap;

use dr_i18n::keys::{self, module_bench as k};
use dr_model::custom_module::{
    Align, Background, BlockKind, Border, BoxDir, Connector, Decoration, EachDir, Font, LookSize,
    MODULE_MARKS, ModuleValue, Node, RADIUS_STEPS, SPACING_STEPS, Separator, Show, TextSize, Width,
};
use dr_shell::strings::{t, tf};
use dr_ui::{
    Theme,
    components::Segmented,
    fonts::Role,
    input::{FieldEvent, TextArea, TextField},
    sand::{self, Icon, KindMark},
    style::DrStyled,
};
use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, EntityId, Focusable as _,
    InteractiveElement, IntoElement, MouseButton, ParentElement, Render, SharedString,
    StatefulInteractiveElement as _, Styled, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::edit::{self, MoveTo, NodePath, Prop, Spot, Words};
use crate::state::{Bench, kind_name};

/// A block being dragged in 「装什么」.
#[derive(Clone, Debug)]
pub struct BlockDrag {
    pub bench: EntityId,
    pub block: String,
}

struct Ghost(SharedString);

impl Render for Ghost {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Theme::of(window, cx).palette;
        div()
            .px(px(8.0))
            .py(px(4.0))
            .rounded(px(2.0))
            .bg(p.page.solid())
            .border(px(0.5))
            .border_color(p.hairline())
            .child(self.0.clone())
    }
}

/// A text input of a panel and what it says, kept while it is shown (its
/// subscription with it).
enum Input {
    Line(Entity<TextField>, #[allow(dead_code)] Subscription),
    Area(Entity<TextArea>, #[allow(dead_code)] Subscription),
}

impl Input {
    /// Shows `value` unless the author is in it.
    fn show(&self, value: &str, window: &Window, cx: &mut App) {
        match self {
            Input::Line(f, _) => {
                let r = f.read(cx);
                if r.text() != value && !r.is_composing() && !r.focus_handle(cx).is_focused(window)
                {
                    f.update(cx, |f, cx| f.set_text(value.to_owned(), cx));
                }
            }
            Input::Area(f, _) => {
                let r = f.read(cx);
                if r.text() != value && !r.is_composing() && !r.focus_handle(cx).is_focused(window)
                {
                    f.update(cx, |f, cx| f.set_text(value.to_owned(), cx));
                }
            }
        }
    }

    fn reset(&self, value: &str, cx: &mut App) {
        match self {
            Input::Line(f, _) => f.update(cx, |f, cx| f.set_text(value.to_owned(), cx)),
            Input::Area(f, _) => f.update(cx, |f, cx| f.set_text(value.to_owned(), cx)),
        }
    }

    fn element(&self) -> AnyElement {
        match self {
            Input::Line(f, _) => f.clone().into_any_element(),
            Input::Area(f, _) => f.clone().into_any_element(),
        }
    }
}

/// What a panel's input commits: the text left in it (`Some`) or Esc
/// (`None`, back to what is stored).
type Commit<V> = fn(&mut V, &str, Option<String>, &mut Window, &mut Context<V>);

fn make_input<V: 'static>(
    key: &str,
    text: &str,
    multiline: bool,
    commit: Commit<V>,
    window: &mut Window,
    cx: &mut Context<V>,
) -> Input {
    let id = SharedString::from(format!("module-bench-input-{key}"));
    let key = key.to_owned();
    let on = move |this: &mut V,
                   e: &FieldEvent,
                   text: String,
                   window: &mut Window,
                   cx: &mut Context<V>| match e {
        FieldEvent::Submitted(_) | FieldEvent::Blurred => {
            commit(this, &key, Some(text), window, cx)
        }
        FieldEvent::Cancelled => commit(this, &key, None, window, cx),
        FieldEvent::Changed(_) => {}
    };
    if multiline {
        let field = cx.new(|cx| {
            TextArea::new(id, window, cx)
                .with_text(text.to_owned())
                .framed(2.0)
        });
        let sub = cx.subscribe_in(
            &field,
            window,
            move |this, f, e: &FieldEvent, window, cx| {
                let text = f.read(cx).text();
                on(this, e, text, window, cx)
            },
        );
        Input::Area(field, sub)
    } else {
        let field = cx.new(|cx| TextField::new(id, window, cx).with_text(text.to_owned()));
        let sub = cx.subscribe_in(
            &field,
            window,
            move |this, f, e: &FieldEvent, window, cx| {
                let text = f.read(cx).text();
                on(this, e, text, window, cx)
            },
        );
        Input::Line(field, sub)
    }
}

fn caption(text: SharedString, theme: &Theme) -> gpui::Div {
    div()
        .font_role(Role::Index)
        .type_px(12.5, 18.0)
        .text_color(theme.palette.ink(3).solid())
        .child(text)
}

// 「装什么」.

pub struct BlocksPanel {
    bench: Entity<Bench>,
    inputs: BTreeMap<String, Input>,
    _subs: Vec<Subscription>,
}

impl BlocksPanel {
    pub fn new(bench: Entity<Bench>, cx: &mut Context<Self>) -> Self {
        let subs = vec![cx.observe(&bench, |_, _, cx| cx.notify())];
        BlocksPanel {
            bench,
            inputs: BTreeMap::new(),
            _subs: subs,
        }
    }

    fn commit(
        &mut self,
        key: &str,
        text: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((what, id)) = key.split_once(':') else {
            return;
        };
        let id = id.to_owned();
        match text {
            Some(text) => self.bench.update(cx, |b, cx| match what {
                "name" => b.change(|v| edit::rename_block(v, &id, &text), cx),
                _ => b.change(|v| edit::set_options(v, &id, &text), cx),
            }),
            None => {
                let stored = self.stored(what, &id, cx);
                if let Some(input) = self.inputs.get(key) {
                    input.reset(&stored, cx);
                }
                let focus = self.bench.read(cx).focus.clone();
                focus.focus(window, cx);
            }
        }
    }

    fn stored(&self, what: &str, id: &str, cx: &App) -> String {
        let bench = self.bench.read(cx);
        let Some(block) = bench.value.as_ref().and_then(|v| v.block(id)) else {
            return String::new();
        };
        match what {
            "name" => block.name.clone(),
            _ => block.options.join("\n"),
        }
    }
}

impl Render for BlocksPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let bench = self.bench.read(cx);
        let bench_id = self.bench.entity_id();
        let value = bench.value.clone();
        let picked = bench.sel_block.clone();
        let mut rows: Vec<AnyElement> = Vec::new();
        let mut keep: Vec<String> = Vec::new();
        if let Some(value) = &value {
            let mut flat = Vec::new();
            walk(&value.blocks, 0, &mut flat);
            for (block, depth) in flat {
                let id = block.id.clone();
                let selected = picked.as_deref() == Some(id.as_str());
                let holder = block.kind.holds_blocks();
                let group = SharedString::from(format!("module-bench-row-{id}"));
                let row_sel = format!("module-bench-block-{id}");
                let e = self.bench.clone();
                let pick = id.clone();
                let drop_to = if holder {
                    MoveTo::Into(id.clone())
                } else {
                    MoveTo::Before(id.clone())
                };
                let e_drop = self.bench.clone();
                let e_del = self.bench.clone();
                let del = id.clone();
                let drag_label = SharedString::from(block.name.clone());
                let row = div()
                    .id(SharedString::from(row_sel.clone()))
                    .debug_selector(move || row_sel.clone())
                    .group(group.clone())
                    .role(gpui::Role::ListItem)
                    .aria_label(SharedString::from(block.name.clone()))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .min_h(px(s.row_height))
                    .pl(px(8.0 + 12.0 * depth as f32))
                    .pr(px(6.0))
                    .rounded(px(2.0))
                    .cursor_pointer()
                    .when(selected, |el| {
                        el.bg(p.page.solid())
                            .border(px(0.5))
                            .border_color(p.hairline())
                    })
                    .on_click(move |_, window, cx| {
                        e.update(cx, |b, cx| {
                            b.pick_block(&pick, cx);
                            b.focus.focus(window, cx);
                        })
                    })
                    .on_drag(
                        BlockDrag {
                            bench: bench_id,
                            block: id.clone(),
                        },
                        move |_, _, _, cx| cx.new(|_| Ghost(drag_label.clone())),
                    )
                    .drag_over::<BlockDrag>(move |st, _, _, _| st.bg(p.accent.alpha(0.07)))
                    .on_drop(move |drag: &BlockDrag, _, cx| {
                        if drag.bench == bench_id {
                            let (block, to) = (drag.block.clone(), drop_to.clone());
                            e_drop.update(cx, |b, cx| {
                                b.change(|v| edit::move_block(v, &block, &to), cx)
                            });
                        }
                    })
                    .child(div().w(px(12.0)).flex_none().when(holder, |el| {
                        el.child(sand::icon(Icon::ChevronDown, 12.0, p.ink(4).solid()))
                    }))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .font_role(if holder { Role::Prose } else { Role::Ui })
                            .type_px(s.body, s.line_body)
                            .text_color(p.ink(if selected { 1 } else { 2 }).solid())
                            .child(block.name.clone()),
                    )
                    .child(
                        div()
                            .flex_none()
                            .font_role(Role::Index)
                            .type_px(12.5, 16.0)
                            .text_color(p.ink(4).solid())
                            .child(kind_name(block.kind, cx)),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!(
                                "module-bench-block-delete-{id}"
                            )))
                            .debug_selector({
                                let id = id.clone();
                                move || format!("module-bench-block-delete-{id}")
                            })
                            .role(gpui::Role::Button)
                            .aria_label(t(cx, keys::common::DELETE))
                            .flex_none()
                            .opacity(0.0)
                            .group_hover(group, |st| st.opacity(1.0))
                            .child(sand::icon(Icon::Close, 12.0, p.ink(4).solid()))
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                e_del.update(cx, |b, cx| {
                                    b.change(|v| edit::remove_block(v, &del), cx)
                                })
                            }),
                    );
                rows.push(row.into_any_element());
                if selected {
                    let name_key = format!("name:{id}");
                    keep.push(name_key.clone());
                    if !self.inputs.contains_key(&name_key) {
                        let input = make_input(
                            &name_key,
                            &block.name,
                            false,
                            |this: &mut Self, key, text, window, cx| {
                                this.commit(key, text, window, cx)
                            },
                            window,
                            cx,
                        );
                        self.inputs.insert(name_key.clone(), input);
                    }
                    let mut editor = div()
                        .pl(px(26.0 + 12.0 * depth as f32))
                        .pr(px(6.0))
                        .py(px(6.0))
                        .flex()
                        .flex_col()
                        .gap(px(6.0));
                    let name = &self.inputs[&name_key];
                    name.show(&block.name, window, cx);
                    let sel = format!("module-bench-block-name-{id}");
                    editor = editor
                        .child(caption(t(cx, keys::template_editor::NAME), &theme))
                        .child(
                            div()
                                .debug_selector(move || sel.clone())
                                .child(name.element()),
                        );
                    if block.kind.has_options() {
                        let opt_key = format!("options:{id}");
                        keep.push(opt_key.clone());
                        let joined = block.options.join("\n");
                        if !self.inputs.contains_key(&opt_key) {
                            let input = make_input(
                                &opt_key,
                                &joined,
                                true,
                                |this: &mut Self, key, text, window, cx| {
                                    this.commit(key, text, window, cx)
                                },
                                window,
                                cx,
                            );
                            self.inputs.insert(opt_key.clone(), input);
                        }
                        let options = &self.inputs[&opt_key];
                        options.show(&joined, window, cx);
                        let sel = format!("module-bench-block-options-{id}");
                        editor = editor
                            .child(caption(t(cx, keys::template_editor::OPTIONS), &theme))
                            .child(
                                div()
                                    .debug_selector(move || sel.clone())
                                    .child(options.element()),
                            );
                    }
                    rows.push(editor.into_any_element());
                }
            }
        }
        self.inputs.retain(|key, _| keep.contains(key));
        let e_end = self.bench.clone();
        let list = div()
            .id("module-bench-blocks")
            .debug_selector(|| "module-bench-blocks".into())
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(px(8.0))
            .py(px(4.0))
            .flex()
            .flex_col()
            .gap(px(1.0))
            .children(rows)
            .child(
                div()
                    .id("module-bench-blocks-end")
                    .min_h(px(36.0))
                    .flex_1()
                    .drag_over::<BlockDrag>(move |st, _, _, _| st.bg(p.accent.alpha(0.05)))
                    .on_drop(move |drag: &BlockDrag, _, cx| {
                        if drag.bench == bench_id {
                            let block = drag.block.clone();
                            e_end.update(cx, |b, cx| {
                                b.change(|v| edit::move_block(v, &block, &MoveTo::End), cx)
                            });
                        }
                    }),
            );
        let chips = dr_model::custom_module::BlockKind::ALL.iter().map(|&kind| {
            let e = self.bench.clone();
            let name = kind_name(kind, cx);
            let sel = format!("module-bench-add-{}", kind.as_str());
            div()
                .id(SharedString::from(sel.clone()))
                .debug_selector(move || sel.clone())
                .role(gpui::Role::Button)
                .aria_label(name.clone())
                .h(px(24.0))
                .px(px(8.0))
                .rounded(px(12.0))
                .border(px(0.5))
                .border_color(p.hairline())
                .flex()
                .items_center()
                .font_role(if kind.holds_blocks() {
                    Role::Prose
                } else {
                    Role::Ui
                })
                .type_px(13.0, 24.0)
                .text_color(p.ink(2).solid())
                .hover(move |st| st.text_color(p.ink(1).solid()))
                .cursor_pointer()
                .on_click(move |_, window, cx| {
                    e.update(cx, |b, cx| {
                        b.add_block(kind, cx);
                        b.focus.focus(window, cx);
                    })
                })
                .child(name)
        });
        let palette = div()
            .flex_none()
            .px(px(12.0))
            .pt(px(8.0))
            .pb(px(12.0))
            .border_t(px(0.5))
            .border_color(p.hairline())
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(caption(t(cx, k::BLOCKS), &theme).text_color(p.ink(4).solid()))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .gap(px(4.0))
                    .children(chips),
            );
        div()
            .id("module-bench-left")
            .debug_selector(|| "module-bench-left".into())
            .size_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex_none()
                    .px_2()
                    .flex()
                    .flex_row()
                    .items_center()
                    .child(
                        Segmented::new("module-bench-holds", [t(cx, k::HOLDS)], 0)
                            .font(Role::Structure),
                    ),
            )
            .child(list)
            .child(palette)
    }
}

fn walk<'a>(
    blocks: &'a [dr_model::custom_module::Block],
    depth: usize,
    out: &mut Vec<(&'a dr_model::custom_module::Block, usize)>,
) {
    for b in blocks {
        out.push((b, depth));
        walk(&b.blocks, depth + 1, out);
    }
}

// 「长什么样」.

pub struct LookPanel {
    bench: Entity<Bench>,
    inputs: BTreeMap<String, Input>,
    _subs: Vec<Subscription>,
}

impl LookPanel {
    pub fn new(bench: Entity<Bench>, cx: &mut Context<Self>) -> Self {
        let subs = vec![cx.observe(&bench, |_, _, cx| cx.notify())];
        LookPanel {
            bench,
            inputs: BTreeMap::new(),
            _subs: subs,
        }
    }

    fn set(&self, prop: Prop, cx: &mut App) {
        set_prop(&self.bench, prop, cx);
    }

    fn commit_text(
        &mut self,
        key: &str,
        text: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match text {
            Some(text) if !text.trim().is_empty() => {
                self.set(Prop::Text(text.trim().to_owned()), cx)
            }
            _ => {
                let stored = self.picked_text(cx).unwrap_or_default();
                if let Some(input) = self.inputs.get(key) {
                    input.reset(&stored, cx);
                }
                if text.is_none() {
                    let focus = self.bench.read(cx).focus.clone();
                    focus.focus(window, cx);
                }
            }
        }
    }

    fn picked_text(&self, cx: &App) -> Option<String> {
        let b = self.bench.read(cx);
        let value = b.value.as_ref()?;
        let root = edit::tree(value, b.size)?;
        match edit::spot(root, b.sel_node.as_ref()?)? {
            Spot::Node(Node::Text(t)) => Some(t.text.clone()),
            _ => None,
        }
    }
}

/// Sets `prop` on the node picked in the size shown.
fn set_prop(bench: &Entity<Bench>, prop: Prop, cx: &mut App) {
    bench.update(cx, |b, cx| {
        let (size, Some(path)) = (b.size, b.sel_node.clone()) else {
            return;
        };
        b.change(|v| edit::set_prop(v, size, &path, prop), cx)
    });
}

/// A row of choices for one property: `label`, then `options` (value and
/// words), the one `current` chosen.
fn prop_row(
    id: &str,
    label: SharedString,
    options: Vec<(Prop, SharedString)>,
    current: &Prop,
    bench: &Entity<Bench>,
    theme: &Theme,
) -> AnyElement {
    let at = options.iter().position(|(p, _)| p == current).unwrap_or(0);
    let (props, labels): (Vec<Prop>, Vec<SharedString>) = options.into_iter().unzip();
    let bench = bench.clone();
    let sel = format!("module-bench-prop-{id}");
    div()
        .debug_selector(move || sel.clone())
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .child(caption(label, theme).w(px(52.0)).flex_none())
        .child(
            div().flex_1().min_w_0().child(
                Segmented::new(
                    SharedString::from(format!("module-bench-prop-{id}-seg")),
                    labels,
                    at,
                )
                .text_size(13.0)
                .pad_x(6.0)
                .on_change(move |i, _, cx| {
                    if let Some(prop) = props.get(i).cloned() {
                        set_prop(&bench, prop, cx);
                    }
                }),
            ),
        )
        .into_any_element()
}

fn steps(make: fn(u8) -> Prop, steps: &[u8]) -> Vec<(Prop, SharedString)> {
    steps
        .iter()
        .map(|&n| (make(n), SharedString::from(n.to_string())))
        .collect()
}

impl Render for LookPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let me = self.bench.clone();
        let bench = self.bench.read(cx);
        let size = bench.size;
        let value = bench.value.clone();
        let picked = bench.sel_node.clone();
        let size_name = t(
            cx,
            match size {
                LookSize::Line => k::size::LINE,
                LookSize::Block => k::size::BLOCK,
                LookSize::Full => k::size::FULL,
            },
        );
        let mut bar = div()
            .debug_selector(|| "module-bench-sizebar".into())
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .child(
                div()
                    .font_role(Role::Ui)
                    .type_px(14.0, 24.0)
                    .text_color(p.ink(1).solid())
                    .child(size_name),
            )
            .child(div().flex_1());
        let own = value
            .as_ref()
            .is_some_and(|v| edit::tree(v, size).is_some());
        if size != LookSize::Block {
            let e = self.bench.clone();
            bar = bar.child(
                Segmented::new(
                    "module-bench-follow",
                    [t(cx, k::FOLLOW), t(cx, k::OWN)],
                    usize::from(own),
                )
                .text_size(13.0)
                .pad_x(6.0)
                .on_change(move |i, _, cx| {
                    e.update(cx, |b, cx| {
                        let size = b.size;
                        b.change(|v| edit::set_own(v, size, i == 1), cx);
                        b.sel_node = None;
                    })
                }),
            );
        }
        let mut col = div()
            .id("module-bench-look-panel")
            .debug_selector(|| "module-bench-look-panel".into())
            .size_full()
            .overflow_y_scroll()
            .px(px(10.0))
            .pt(px(8.0))
            .pb(px(16.0))
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(bar);
        let mut keep = Vec::new();
        match value
            .as_ref()
            .and_then(|v| edit::tree(v, size).map(|root| (v, root)))
        {
            None => {
                col = col.child(
                    div()
                        .px(px(2.0))
                        .py(px(8.0))
                        .font_role(Role::Index)
                        .type_px(13.0, 18.0)
                        .text_color(p.ink(4).solid())
                        .child(t(
                            cx,
                            if size == LookSize::Line {
                                k::AUTO_LINE
                            } else {
                                k::AUTO_FULL
                            },
                        )),
                );
            }
            Some((value, root)) => {
                let mut tree = div().flex().flex_col().gap(px(1.0)).pb(px(6.0));
                let mut selected_spot = None;
                for (path, depth, spot) in edit::rows(root) {
                    let on = picked.as_ref() == Some(&path);
                    if on {
                        selected_spot = Some((path.clone(), spot));
                    }
                    let (label, tag) = row_words(value, spot, cx);
                    let e = self.bench.clone();
                    let sel = format!("module-bench-node-{}", path_key(&path));
                    let go = path.clone();
                    tree = tree.child(
                        div()
                            .id(SharedString::from(sel.clone()))
                            .debug_selector(move || sel.clone())
                            .role(gpui::Role::ListItem)
                            .aria_label(label.clone())
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .min_h(px(26.0))
                            .pl(px(6.0 + 14.0 * depth as f32))
                            .pr(px(6.0))
                            .rounded(px(2.0))
                            .cursor_pointer()
                            .font_role(Role::Ui)
                            .type_px(13.5, 20.0)
                            .text_color(p.ink(if on { 1 } else { 2 }).solid())
                            .when(on, |el| {
                                el.bg(p.page.solid())
                                    .border(px(0.5))
                                    .border_color(p.hairline())
                            })
                            .on_click(move |_, window, cx| {
                                e.update(cx, |b, cx| {
                                    b.pick_row(go.clone(), cx);
                                    b.focus.focus(window, cx);
                                })
                            })
                            .child(div().min_w_0().truncate().child(label))
                            .when_some(tag, |el, tag| {
                                el.child(
                                    div()
                                        .flex_none()
                                        .font_role(Role::Index)
                                        .type_px(12.0, 16.0)
                                        .text_color(p.ink(4).solid())
                                        .child(tag),
                                )
                            }),
                    );
                }
                col = col.child(tree);
                if let Some((path, spot)) = selected_spot {
                    let props = self.props(value, &path, spot, &me, &mut keep, &theme, window, cx);
                    col = col.child(
                        div()
                            .debug_selector(|| "module-bench-props".into())
                            .pt(px(10.0))
                            .px(px(2.0))
                            .pb(px(4.0))
                            .border_t(px(0.5))
                            .border_color(p.hairline())
                            .flex()
                            .flex_col()
                            .gap(px(7.0))
                            .children(props),
                    );
                }
            }
        }
        self.inputs.retain(|key, _| keep.contains(key));
        let _ = s;
        col
    }
}

impl LookPanel {
    #[allow(clippy::too_many_arguments)]
    fn props(
        &mut self,
        value: &ModuleValue,
        path: &NodePath,
        spot: Spot<'_>,
        me: &Entity<Bench>,
        keep: &mut Vec<String>,
        theme: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        use k::opt;
        use k::prop;
        let mut rows = Vec::new();
        let none = || t(cx, opt::NONE);
        let type_rows = |rows: &mut Vec<AnyElement>,
                         (font, size, ink): (Font, TextSize, u8),
                         cx: &mut Context<Self>| {
            rows.push(prop_row(
                "font",
                t(cx, prop::FONT),
                vec![
                    (Prop::Font(Font::Serif), t(cx, opt::SERIF)),
                    (Prop::Font(Font::Sans), t(cx, opt::SANS)),
                    (Prop::Font(Font::Mono), t(cx, opt::MONO)),
                ],
                &Prop::Font(font),
                me,
                theme,
            ));
            rows.push(prop_row(
                "size",
                t(cx, prop::SIZE),
                vec![
                    (Prop::Size(TextSize::Title), t(cx, opt::TITLE)),
                    (Prop::Size(TextSize::Body), t(cx, opt::BODY)),
                    (Prop::Size(TextSize::Small), t(cx, opt::SMALL)),
                    (Prop::Size(TextSize::Note), t(cx, opt::NOTE)),
                ],
                &Prop::Size(size),
                me,
                theme,
            ));
            rows.push(prop_row(
                "ink",
                t(cx, prop::INK),
                vec![
                    (Prop::Ink(1), t(cx, opt::INK1)),
                    (Prop::Ink(2), t(cx, opt::INK2)),
                    (Prop::Ink(3), t(cx, opt::INK3)),
                    (Prop::Ink(4), t(cx, opt::INK4)),
                ],
                &Prop::Ink(ink),
                me,
                theme,
            ));
        };
        match spot {
            Spot::Node(Node::Box(b)) | Spot::Item(b) => {
                let [dir, gap, pad, align, width, border, bg, radius, deco] = edit::box_props(b);
                let item = matches!(spot, Spot::Item(_));
                let mut dirs = vec![
                    (Prop::Dir(BoxDir::Col), t(cx, opt::COL)),
                    (Prop::Dir(BoxDir::Row), t(cx, opt::ROW)),
                ];
                if !item {
                    dirs.push((Prop::Dir(BoxDir::Grid), t(cx, opt::GRID)));
                }
                rows.push(prop_row("dir", t(cx, prop::DIR), dirs, &dir, me, theme));
                rows.push(prop_row(
                    "gap",
                    t(cx, prop::GAP),
                    steps(Prop::Gap, &SPACING_STEPS),
                    &gap,
                    me,
                    theme,
                ));
                rows.push(prop_row(
                    "pad",
                    t(cx, prop::PAD),
                    steps(Prop::Pad, &SPACING_STEPS),
                    &pad,
                    me,
                    theme,
                ));
                rows.push(prop_row(
                    "align",
                    t(cx, prop::ALIGN),
                    vec![
                        (Prop::Align(Align::Start), t(cx, opt::START)),
                        (Prop::Align(Align::Center), t(cx, opt::CENTER)),
                        (Prop::Align(Align::End), t(cx, opt::END)),
                        (Prop::Align(Align::Stretch), t(cx, opt::STRETCH)),
                    ],
                    &align,
                    me,
                    theme,
                ));
                rows.push(prop_row(
                    "width",
                    t(cx, prop::WIDTH),
                    vec![
                        (Prop::Width(Width::Auto), t(cx, opt::AUTO)),
                        (Prop::Width(Width::Hug), t(cx, opt::HUG)),
                        (Prop::Width(Width::Fill), t(cx, opt::FILL)),
                    ],
                    &width,
                    me,
                    theme,
                ));
                rows.push(prop_row(
                    "border",
                    t(cx, prop::BORDER),
                    vec![
                        (Prop::Border(Border::None), none()),
                        (Prop::Border(Border::Hair), t(cx, opt::HAIRLINE)),
                        (Prop::Border(Border::Glass), t(cx, opt::GLASS_LINE)),
                        (Prop::Border(Border::Sand), t(cx, opt::SAND_FRAME)),
                    ],
                    &border,
                    me,
                    theme,
                ));
                rows.push(prop_row(
                    "bg",
                    t(cx, prop::BG),
                    vec![
                        (Prop::Bg(Background::None), none()),
                        (Prop::Bg(Background::Paper), t(cx, opt::PAPER)),
                        (Prop::Bg(Background::Wash), t(cx, opt::WASH)),
                    ],
                    &bg,
                    me,
                    theme,
                ));
                rows.push(prop_row(
                    "radius",
                    t(cx, prop::RADIUS),
                    steps(Prop::Radius, &RADIUS_STEPS),
                    &radius,
                    me,
                    theme,
                ));
                rows.push(prop_row(
                    "deco",
                    t(cx, prop::DECO),
                    vec![
                        (Prop::Deco(Decoration::None), none()),
                        (Prop::Deco(Decoration::Arc), t(cx, opt::ARC)),
                    ],
                    &deco,
                    me,
                    theme,
                ));
            }
            Spot::Node(Node::Each(e)) => {
                let [dir, gap, sep, link] = edit::each_props(e);
                rows.push(prop_row(
                    "each-dir",
                    t(cx, prop::DIR),
                    vec![
                        (Prop::EachDir(EachDir::Col), t(cx, opt::COL)),
                        (Prop::EachDir(EachDir::Row), t(cx, opt::ROW)),
                    ],
                    &dir,
                    me,
                    theme,
                ));
                rows.push(prop_row(
                    "gap",
                    t(cx, prop::GAP),
                    steps(Prop::Gap, &SPACING_STEPS),
                    &gap,
                    me,
                    theme,
                ));
                rows.push(prop_row(
                    "sep",
                    t(cx, prop::SEP),
                    vec![
                        (Prop::Sep(Separator::None), none()),
                        (Prop::Sep(Separator::Hair), t(cx, opt::LINE)),
                        (Prop::Sep(Separator::Axis), t(cx, opt::AXIS)),
                    ],
                    &sep,
                    me,
                    theme,
                ));
                rows.push(prop_row(
                    "link",
                    t(cx, prop::LINK),
                    vec![
                        (Prop::Link(Connector::None), none()),
                        (Prop::Link(Connector::Arrow), t(cx, opt::ARROW)),
                    ],
                    &link,
                    me,
                    theme,
                ));
            }
            Spot::Node(Node::Value(v)) => {
                let kind = value.block(&v.block).map(|b| b.kind);
                let shown = edit::shown_as(v, kind);
                let shows = match kind {
                    Some(BlockKind::Number) => Some(vec![
                        (Prop::Show(Show::Text), t(cx, opt::NUMBER)),
                        (Prop::Show(Show::Dots), t(cx, opt::DOTS)),
                    ]),
                    Some(BlockKind::Select) => Some(vec![
                        (Prop::Show(Show::Text), t(cx, opt::WORDS)),
                        (Prop::Show(Show::Mark), t(cx, opt::MARK)),
                    ]),
                    _ => None,
                };
                if let Some(shows) = shows {
                    rows.push(prop_row(
                        "show",
                        t(cx, prop::SHOW),
                        shows,
                        &Prop::Show(shown),
                        me,
                        theme,
                    ));
                }
                type_rows(&mut rows, edit::value_type(v), cx);
            }
            Spot::Node(Node::Text(tn)) => {
                let key = format!("text:{}", path_key(path));
                keep.push(key.clone());
                if !self.inputs.contains_key(&key) {
                    let input = make_input(
                        &key,
                        &tn.text,
                        false,
                        |this: &mut Self, key, text, window, cx| {
                            this.commit_text(key, text, window, cx)
                        },
                        window,
                        cx,
                    );
                    self.inputs.insert(key.clone(), input);
                }
                let input = &self.inputs[&key];
                input.show(&tn.text, window, cx);
                rows.push(
                    div()
                        .debug_selector(|| "module-bench-prop-text".into())
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .child(caption(t(cx, prop::TEXT), theme).w(px(52.0)).flex_none())
                        .child(div().flex_1().min_w_0().child(input.element()))
                        .into_any_element(),
                );
                type_rows(&mut rows, edit::text_type(tn), cx);
            }
            Spot::Node(Node::Mark(m)) => {
                let p = theme.palette;
                let marks = MODULE_MARKS.iter().map(|&name| {
                    let on = m.mark == name;
                    let bench = me.clone();
                    let sel = format!("module-bench-mark-{name}");
                    div()
                        .id(SharedString::from(sel.clone()))
                        .debug_selector(move || sel.clone())
                        .role(gpui::Role::Button)
                        .aria_label(SharedString::from(name))
                        .size(px(24.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(2.0))
                        .cursor_pointer()
                        .when(on, |el| {
                            el.bg(p.page.solid())
                                .border(px(0.5))
                                .border_color(p.hairline())
                        })
                        .on_click(move |_, _, cx| set_prop(&bench, Prop::Mark(name.to_owned()), cx))
                        .child(
                            KindMark::new(
                                ElementId::Name(format!("module-bench-mark-glyph-{name}").into()),
                                dr_view_module_look::paint::mark_kind(name),
                            )
                            .color(p.ink(2)),
                        )
                });
                rows.push(
                    div()
                        .debug_selector(|| "module-bench-prop-mark".into())
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .child(caption(t(cx, prop::MARK), theme).w(px(52.0)).flex_none())
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .flex_wrap()
                                .gap(px(2.0))
                                .children(marks),
                        )
                        .into_any_element(),
                );
            }
        }
        rows
    }
}

/// A node's row in the tree: what it is, and a few words about it.
fn row_words(
    value: &ModuleValue,
    spot: Spot<'_>,
    cx: &App,
) -> (SharedString, Option<SharedString>) {
    use k::{node, tag};
    match spot {
        Spot::Node(Node::Box(b)) | Spot::Item(b) => {
            let label = t(
                cx,
                match b.dir {
                    BoxDir::Col => node::COL,
                    BoxDir::Row => node::ROW,
                    BoxDir::Grid => node::GRID,
                },
            );
            let mut tags = Vec::new();
            match b.border.unwrap_or(Border::None) {
                Border::Hair => tags.push(t(cx, tag::HAIR)),
                Border::Glass => tags.push(t(cx, tag::GLASS)),
                Border::Sand => tags.push(t(cx, tag::SAND)),
                Border::None => {}
            }
            match b.bg.unwrap_or(Background::None) {
                Background::Paper => tags.push(t(cx, tag::PAPER)),
                Background::Wash => tags.push(t(cx, tag::WASH)),
                Background::None => {}
            }
            let tag = (!tags.is_empty()).then(|| {
                SharedString::from(
                    tags.iter()
                        .map(|s| s.as_ref())
                        .collect::<Vec<_>>()
                        .join(" · "),
                )
            });
            (label, tag)
        }
        Spot::Node(Node::Each(e)) => {
            let name = value
                .block(&e.list)
                .map(|b| b.name.clone())
                .unwrap_or_default();
            (
                tf(cx, node::EACH, &[("name", &name)]),
                Some(t(
                    cx,
                    match e.dir.unwrap_or(EachDir::Col) {
                        EachDir::Row => tag::ACROSS,
                        EachDir::Col => tag::DOWN,
                    },
                )),
            )
        }
        Spot::Node(Node::Value(v)) => {
            let name = value
                .block(&v.block)
                .map(|b| b.name.clone())
                .unwrap_or_else(|| v.block.clone());
            let tag = v.show.map(|s| {
                t(
                    cx,
                    match s {
                        Show::Dots => tag::DOTS,
                        Show::Mark => tag::MARK,
                        Show::Count => tag::COUNT,
                        Show::Text => tag::WORDS,
                    },
                )
            });
            (name.into(), tag)
        }
        Spot::Node(Node::Text(tn)) => (format!("“{}”", tn.text).into(), Some(t(cx, tag::WORDS))),
        Spot::Node(Node::Mark(_)) => (t(cx, node::MARK), None),
    }
}

/// A path as a short string (element ids, selectors).
pub fn path_key(path: &[u16]) -> String {
    if path.is_empty() {
        return "root".into();
    }
    path.iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join("-")
}

// 「写给 Agent」.

pub struct GuidePanel {
    bench: Entity<Bench>,
    inputs: BTreeMap<String, Input>,
    _subs: Vec<Subscription>,
}

impl GuidePanel {
    pub fn new(bench: Entity<Bench>, cx: &mut Context<Self>) -> Self {
        let subs = vec![cx.observe(&bench, |_, _, cx| cx.notify())];
        GuidePanel {
            bench,
            inputs: BTreeMap::new(),
            _subs: subs,
        }
    }

    fn which(key: &str) -> Words {
        match key {
            "name" => Words::Name,
            "description" => Words::Description,
            "instructions" => Words::Instructions,
            other => Words::Block(other.trim_start_matches("block:").to_owned()),
        }
    }

    fn stored(&self, which: &Words, cx: &App) -> String {
        let b = self.bench.read(cx);
        let Some(v) = &b.value else {
            return String::new();
        };
        match which {
            Words::Name => v.agent.name.clone(),
            Words::Description => v.agent.description.clone(),
            Words::Instructions => v.agent.instructions.clone(),
            Words::Block(id) => v.agent.blocks.get(id).cloned().unwrap_or_default(),
        }
    }

    fn commit(
        &mut self,
        key: &str,
        text: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let which = Self::which(key);
        match text {
            Some(text) => self.bench.update(cx, |b, cx| {
                b.change(|v| edit::set_words(v, &which, &text), cx)
            }),
            None => {
                let stored = self.stored(&which, cx);
                if let Some(input) = self.inputs.get(key) {
                    input.reset(&stored, cx);
                }
                let focus = self.bench.read(cx).focus.clone();
                focus.focus(window, cx);
            }
        }
    }

    fn input(
        &mut self,
        key: &str,
        text: &str,
        multiline: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if !self.inputs.contains_key(key) {
            let input = make_input(
                key,
                text,
                multiline,
                |this: &mut Self, key, text, window, cx| this.commit(key, text, window, cx),
                window,
                cx,
            );
            self.inputs.insert(key.to_owned(), input);
        }
        let input = &self.inputs[key];
        input.show(text, window, cx);
        let sel = format!("module-bench-guide-{key}");
        div()
            .debug_selector(move || sel.clone())
            .child(input.element())
            .into_any_element()
    }
}

impl Render for GuidePanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let Some(value) = self.bench.read(cx).value.clone() else {
            return div().into_any_element();
        };
        let mut col = div()
            .id("module-bench-guide")
            .debug_selector(|| "module-bench-guide".into())
            .size_full()
            .overflow_y_scroll()
            .px(px(12.0))
            .pt(px(10.0))
            .pb(px(16.0))
            .flex()
            .flex_col()
            .gap(px(8.0));
        let mut keep = vec![
            "name".to_owned(),
            "description".to_owned(),
            "instructions".to_owned(),
        ];
        for (key, label, text, multiline) in [
            (
                "name",
                keys::template_editor::NAME,
                value.agent.name.clone(),
                false,
            ),
            (
                "description",
                keys::template_editor::DESCRIPTION,
                value.agent.description.clone(),
                false,
            ),
            (
                "instructions",
                keys::template_editor::INSTRUCTIONS,
                value.agent.instructions.clone(),
                true,
            ),
        ] {
            let input = self.input(key, &text, multiline, window, cx);
            col = col.child(caption(t(cx, label), &theme)).child(input);
        }
        col = col.child(caption(t(cx, k::EACH_BLOCK), &theme).mt(px(6.0)));
        for (block, _) in value.blocks_with_scope() {
            if block.kind == BlockKind::Group {
                continue;
            }
            let key = format!("block:{}", block.id);
            keep.push(key.clone());
            let text = value
                .agent
                .blocks
                .get(&block.id)
                .cloned()
                .unwrap_or_default();
            let input = self.input(&key, &text, false, window, cx);
            col = col.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(13.5, 20.0)
                            .text_color(theme.palette.ink(2).solid())
                            .child(block.name.clone()),
                    )
                    .child(input),
            );
        }
        self.inputs.retain(|key, _| keep.contains(key));
        col.into_any_element()
    }
}
