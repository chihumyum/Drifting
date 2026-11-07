//! A page's end: the empty page's hint and ⁂.
//!
//! ⁂ is the brush's three stones, ink 4 (the accent once the chapter is
//! finished). The pointer moving on it for 70 ms (or a click) turns it
//! into its actions in one column centred on it: ⁂ shrinks and fades while
//! the actions unfold from its line. Leaving the column folds them back.
//! Each action is a dense sand cell. A click within 250 ms of a hover
//! opening the column was meant for ⁂ and does nothing.

use std::time::Instant;

use dr_editor::page::{self, EMPTY_HINTS, PageInfo, PageKind};
use dr_i18n::keys;
use dr_shell::nav::{Open, Target};
use dr_shell::pages::{PageEditorRef, PageHost};
use dr_shell::{Settings, keymap, t};
use dr_ui::{
    Theme,
    anim::{self, Tween},
    components::SandCell,
    fonts::Role,
    sand::{self, Icon},
    style::DrStyled,
    tokens::{Easing, page as tk},
};
use gpui::{
    App, AppContext as _, Context, Div, ElementId, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _, Task,
    Window, div, prelude::FluentBuilder as _, px,
};

use crate::NewTitles;

/// The width the action column is centred in (wider than any of them).
const MENU_ROOM: f32 = 320.0;

/// ⁂'s actions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndAction {
    /// 「标为完成」 / 「改回草稿」.
    Finish,
    /// 「新建下一章」: right after this chapter; it opens with the caret in
    /// its title, selected.
    Next,
}

pub struct PageEnd {
    host: PageHost,
    page: PageInfo,
    open: bool,
    /// 0 is ⁂, 1 its actions.
    shown: Tween,
    /// When a hover (not a click) opened the actions.
    hover_opened: Option<Instant>,
    arm: Option<Task<()>>,
}

impl PageEnd {
    pub fn new(host: PageHost, page: &PageInfo) -> Self {
        PageEnd {
            host,
            page: page.clone(),
            open: false,
            shown: Tween::still(0.0),
            hover_opened: None,
            arm: None,
        }
    }

    pub fn set_page(&mut self, page: &PageInfo) {
        self.page = page.clone();
    }

    /// The facts it shows.
    pub fn page(&self) -> &PageInfo {
        &self.page
    }

    /// Whether ⁂'s actions are out.
    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Turns ⁂ into its actions as a click on it does (the keyboard's way
    /// in, when the shell gives one).
    pub fn open_actions(&mut self, window: &Window, cx: &mut Context<Self>) {
        if self.page.kind == PageKind::Chapter {
            self.show(false, window, cx);
        }
    }

    fn show(&mut self, by_hover: bool, window: &Window, cx: &mut Context<Self>) {
        self.arm = None;
        if self.open {
            return;
        }
        let reduce = Theme::of(window, cx).reduce_motion;
        let now = anim::now();
        self.open = true;
        self.hover_opened = by_hover.then_some(now);
        let d = if reduce {
            Default::default()
        } else {
            tk::END_OPEN
        };
        self.shown
            .retarget(1.0, now, d, Easing::new(0.22, 1.0, 0.36, 1.0));
        cx.notify();
    }

    fn hide(&mut self, window: &Window, cx: &mut Context<Self>) {
        self.arm = None;
        if !self.open {
            return;
        }
        let reduce = Theme::of(window, cx).reduce_motion;
        self.open = false;
        let d = if reduce {
            Default::default()
        } else {
            tk::END_CLOSE
        };
        self.shown.retarget(0.0, anim::now(), d, Easing::EASE);
        cx.notify();
    }

    /// The pointer moved onto ⁂: open once it has stayed a moment.
    fn arm(&mut self, window: &Window, cx: &mut Context<Self>) {
        if self.open || self.arm.is_some() {
            return;
        }
        let handle = window.window_handle();
        self.arm = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(tk::END_INTENT).await;
            cx.update_window(handle, |_, window, cx| {
                this.update(cx, |end, cx| end.show(true, window, cx)).ok();
            })
            .ok();
        }));
    }

    /// A click on one of the actions: ignored right after a hover opened
    /// them (it was meant for ⁂).
    fn act(&mut self, action: EndAction, window: &Window, cx: &mut Context<Self>) {
        if self
            .hover_opened
            .is_some_and(|at| anim::now().duration_since(at) < tk::END_CLICK_GUARD)
        {
            return;
        }
        self.choose(action, window, cx);
    }

    /// Does `action` (and folds the actions back), as choosing it does.
    pub fn choose(&mut self, action: EndAction, window: &Window, cx: &mut Context<Self>) {
        if self.page.kind != PageKind::Chapter {
            return;
        }
        self.hide(window, cx);
        let (lib, book, doc) = (
            self.host.library.clone(),
            self.host.book.clone(),
            self.page.doc.clone(),
        );
        match action {
            EndAction::Finish => {
                let finished = !self.page.finished();
                cx.background_spawn(async move {
                    if let Err(error) = page::set_finished(&lib, &book, &doc, finished) {
                        log::warn!("{doc}: the status was not stored: {error}");
                    }
                })
                .detach();
            }
            EndAction::Next => {
                let title = t(cx, keys::chapter_end::DEFAULT_TITLE).to_string();
                let task = cx.background_spawn(async move {
                    page::new_chapter_after(&lib, &book, &doc, &title)
                });
                let workspace = self.host.workspace.clone();
                // In the whole book the new chapter appears in the scroll;
                // on its own page it opens in a tab.
                let in_book = matches!(self.host.editor, PageEditorRef::Book(_));
                cx.spawn(async move |_, cx| match task.await {
                    Ok(new_doc) => {
                        cx.update(|cx| {
                            NewTitles::add(new_doc.clone(), cx);
                            let target = new_doc
                                .strip_prefix("node:")
                                .and_then(|id| Target::from_key(&format!("chapter:{id}")));
                            if let (false, Some(target)) = (in_book, target) {
                                workspace
                                    .update(cx, |ws, cx| ws.open(target, Open::KEEP.at_title(), cx))
                                    .ok();
                            }
                        });
                    }
                    Err(error) => log::warn!("the next chapter was not made: {error}"),
                })
                .detach();
            }
        }
    }
}

/// The keys bound now to the shortcut registered as `id`, as they read.
fn shortcut(id: &str, cx: &App) -> SharedString {
    let Some(shortcut) = keymap::find(id) else {
        return SharedString::default();
    };
    let overrides = Settings::read(cx).key_bindings();
    shortcut
        .effective(&overrides)
        .first()
        .map(|keys| keymap::display(keys, cx.platform_info().os).into())
        .unwrap_or_default()
}

/// An empty page's hint, faint under where the first line goes: the
/// Markdown for the three heading levels, then search and the timeline.
fn hints(window: &Window, cx: &App) -> Div {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let rows: Vec<(SharedString, SharedString)> = EMPTY_HINTS
        .iter()
        .map(|(label, md)| (SharedString::from(*label), SharedString::from(*md)))
        .chain([
            (
                t(cx, keys::guide::hints::SEARCH),
                shortcut("globalSearch", cx),
            ),
            (
                t(cx, keys::guide::hints::TIMELINE),
                shortcut("toggleBottomTimeline", cx),
            ),
        ])
        .collect();
    let column = || div().flex().flex_col().gap(px(tk::HINTS_ROW_GAP));
    div()
        .pt(px(tk::HINTS_TOP))
        .flex()
        .flex_row()
        .gap(px(tk::HINTS_COLUMN_GAP))
        .font_role(Role::Ui)
        .type_px(s.secondary, s.line_body)
        .text_color(p.muted().solid())
        .child(column().children(rows.iter().map(|(label, _)| div().child(label.clone()))))
        .child(
            column()
                .items_end()
                .font_role(Role::Index)
                .children(rows.into_iter().map(|(_, keys)| div().child(keys))),
        )
}

impl Render for PageEnd {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let now = anim::now();
        let k = self.shown.value(now).clamp(0.0, 1.0);
        anim::keep_going(!self.shown.settled(now), window);
        let chapter = self.page.kind == PageKind::Chapter;
        let finished = self.page.finished();
        let ink = if finished { p.accent } else { p.ink(4) };
        let doc = self.page.doc.clone();
        let id = |what: &str| ElementId::Name(format!("page-end-{what}-{doc}").into());
        let mark = sand::icon(
            Icon::StonesTriad,
            tk::ORNAMENT * (1.0 - (1.0 - tk::END_SHRINK) * k),
            ink.alpha(1.0 - k),
        );
        let (w, h) = tk::ORNAMENT_TARGET;
        let trigger = div()
            .id(id("mark"))
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(mark)
            .when(chapter, |el| {
                el.cursor_pointer()
                    .role(gpui::Role::Button)
                    .aria_label(t(
                        cx,
                        if finished {
                            keys::chapter_end::TRIGGER_FINISHED
                        } else {
                            keys::chapter_end::TRIGGER
                        },
                    ))
                    .on_hover(cx.listener(|end, hovered: &bool, window, cx| {
                        if *hovered {
                            end.arm(window, cx);
                        } else if !end.open {
                            end.arm = None;
                        }
                    }))
                    .on_click(cx.listener(|end, _, window, cx| end.show(false, window, cx)))
            });
        // The actions, one column centred on ⁂, folded onto its line until
        // they open.
        let actions = [
            (
                EndAction::Finish,
                if finished {
                    Icon::BrushLifted
                } else {
                    Icon::BrushLaid
                },
                t(
                    cx,
                    if finished {
                        keys::chapter_end::MARK_DRAFT
                    } else {
                        keys::chapter_end::MARK_FINISHED
                    },
                ),
            ),
            (
                EndAction::Next,
                Icon::Sprout,
                t(cx, keys::chapter_end::INSERT_AFTER),
            ),
        ];
        let rows = actions.len() as f32;
        let menu = (chapter && (self.open || k > 0.0)).then(|| {
            let middle = (rows - 1.0) / 2.0;
            div()
                .absolute()
                .top(px(h / 2.0 - rows * tk::END_ROW / 2.0))
                .left(px(w / 2.0 - MENU_ROOM / 2.0))
                .w(px(MENU_ROOM))
                .flex()
                .justify_center()
                .child(
                    div()
                        .id(id("actions"))
                        .flex()
                        .flex_col()
                        .items_start()
                        .when(k < 1.0, |el| el.opacity(k))
                        .on_hover(cx.listener(|end, hovered: &bool, window, cx| {
                            if !*hovered {
                                end.hide(window, cx);
                            }
                        }))
                        .children(actions.into_iter().enumerate().map(
                            |(i, (action, icon, label))| {
                                let fold = (middle - i as f32) * tk::END_ROW * (1.0 - k);
                                div().relative().top(px(fold)).child(
                                    SandCell::new(id(&format!("action-{i}")), label)
                                        .icon(icon)
                                        .dense()
                                        .on_click(cx.listener(move |end, _, window, cx| {
                                            end.act(action, window, cx)
                                        })),
                                )
                            },
                        )),
                )
        });
        div()
            .w_full()
            .flex()
            .flex_col()
            .items_center()
            .pb(px(tk::BOTTOM))
            .when(self.page.empty, |el| el.child(hints(window, cx)))
            .child(
                div()
                    .relative()
                    .mt(px(tk::ORNAMENT_TOP))
                    .mb(px(tk::ORNAMENT_BOTTOM))
                    .w(px(w))
                    .h(px(h))
                    .child(trigger)
                    .children(menu),
            )
    }
}
