//! The import's dialogs (dr-ui's `Dialog`): progress, the gate, the
//! summary, a failure. Each says where it came from in its eyebrow
//! (「Drifting 0.1」, as the bookshelf's entry does) and names the chosen
//! folder, never its full path.

use std::collections::BTreeMap;

use dr_i18n::keys;
use dr_i18n::number::grouped;
use dr_import_v1::gate::{BodyRef, Reason};
use dr_import_v1::legacy::{Freshness, ProseKind};
use dr_import_v1::progress::Step;
use dr_import_v1::receipt::{Block, MATERIALS_HEADING};
use dr_shell::actions::Dismiss;
use dr_shell::strings::{tf, tp};
use dr_shell::{Settings, t};
use dr_ui::{
    Theme,
    components::{Button, Dialog, Progress as Bar},
    fonts::{Role, weight},
    sand::{self, Icon},
    style::DrStyled,
};
use gpui::{
    AnyElement, App, Context, InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder as _, px,
};

use crate::copy;
use crate::flow::{Blocked, Done, Failed, Found, LegacyImport, Ready, Running, State, now_ms};

/// Where the dialogs say they come from (the product and its version are not
/// translated, as on the bookshelf's entry).
const EYEBROW: &str = "Drifting 0.1";
const WIDTH: f32 = 480.0;
/// The gate's list of bodies scrolls past this.
const LIST_MAX_H: f32 = 232.0;

impl Render for LegacyImport {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let differences_open = self.differences_open();
        let dialog = match &self.state {
            State::Idle | State::Picking => None,
            State::Found(f) => Some(found(f, window, cx)),
            State::Ready(r) => Some(ready(r, window, cx)),
            State::Switching(d) => Some(
                Dialog::new("v3-import-switching", t(cx, keys::import::v3::SWITCHING))
                    .subtitle(d.folder.clone())
                    .width(WIDTH)
                    .body(Bar::new(None))
                    .into_any_element(),
            ),
            State::Running(r) => Some(running(r, window, cx)),
            State::Blocked(b) => Some(blocked(b, window, cx)),
            State::Done(d) => Some(done(d, differences_open, window, cx)),
            State::Failed(f) => Some(failed(f, window, cx)),
        };
        div()
            .id("legacy-import")
            .absolute()
            .top_0()
            .left_0()
            .size_0()
            .track_focus(&self.focus)
            .key_context("LegacyImport")
            .on_action(cx.listener(|import, _: &Dismiss, window, cx| import.close(window, cx)))
            .children(dialog)
    }
}

/// A closure that closes the dialog.
fn closer(cx: &mut Context<LegacyImport>) -> impl Fn(&mut Window, &mut App) + Clone + 'static {
    let entity = cx.entity();
    move |window: &mut Window, cx: &mut App| entity.update(cx, |i, cx| i.close(window, cx))
}

/// A line in secondary ink.
fn quiet(text: impl Into<SharedString>, window: &Window, cx: &App) -> gpui::Div {
    let theme = Theme::of(window, cx);
    div()
        .font_role(Role::Ui)
        .type_px(theme.scale.secondary, theme.scale.line_body)
        .text_color(theme.palette.muted().solid())
        .child(text.into())
}

/// Numbers and placeholders: index type, secondary ink.
fn index(text: impl Into<SharedString>, window: &Window, cx: &App) -> gpui::Div {
    let theme = Theme::of(window, cx);
    div()
        .font_role(Role::Index)
        .type_px(theme.scale.caption, theme.scale.line_caption)
        .text_color(theme.palette.muted().solid())
        .child(text.into())
}

/// A sentence of the import's own ([`copy`]), with its count.
fn missing(key: &'static str, count: Option<usize>, _: &Window, cx: &App) -> AnyElement {
    div().child(copy::text(key, count, cx)).into_any_element()
}

fn name_or_untitled(name: &str, cx: &App) -> SharedString {
    if name.trim().is_empty() {
        t(cx, keys::common::UNTITLED)
    } else {
        name.to_owned().into()
    }
}

fn ready_body_lines(r: &Ready, cx: &App) -> (SharedString, Vec<String>) {
    let pending = r
        .pending
        .iter()
        .map(|p| format!("{}: {}", p.code, p.source))
        .collect::<Vec<_>>();
    (t(cx, keys::import::v3::DESTINATION), pending)
}

fn ready(r: &Ready, window: &mut Window, cx: &mut Context<LegacyImport>) -> AnyElement {
    let entity = cx.entity();
    let close = closer(cx);
    let (destination, pending_lines) = ready_body_lines(r, cx);
    let pending = pending_lines
        .into_iter()
        .map(|line| index(line, window, cx))
        .collect::<Vec<_>>();
    Dialog::new("v3-import-ready", t(cx, keys::import::v3::TITLE))
        .eyebrow(EYEBROW)
        .subtitle(r.folder.clone())
        .width(WIDTH)
        .body(quiet(destination, window, cx))
        .when(!pending.is_empty(), |d| {
            d.body(quiet(t(cx, keys::import::v3::PENDING), window, cx))
                .body(
                    div()
                        .id("v3-import-pending")
                        .max_h(px(LIST_MAX_H))
                        .overflow_y_scroll()
                        .children(pending),
                )
        })
        .action(
            Button::new("v3-import-cancel", t(cx, keys::common::CANCEL))
                .text()
                .on_click({
                    let close = close.clone();
                    move |_, window, cx| close(window, cx)
                }),
        )
        .action(
            Button::new("v3-import-start", t(cx, keys::import::v3::START))
                .primary()
                .on_click(move |_, window, cx| {
                    entity.update(cx, |i, cx| i.start_configured(window, cx))
                }),
        )
        .on_close(close)
        .into_any_element()
}

// Progress.

fn running(r: &Running, window: &mut Window, cx: &mut Context<LegacyImport>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = r.progress.as_ref();
    let in_book =
        p.filter(|p| p.book > 0 && matches!(p.step, Step::Bodies | Step::Book | Step::Assets));
    let what = match in_book {
        Some(p) => name_or_untitled(&p.book_name, cx),
        None => t(cx, keys::common::PROCESSING),
    };
    let count = in_book.map(|p| {
        tf(
            cx,
            keys::project_picker::PROJECT_COUNT,
            &[("filtered", &p.book), ("total", &p.books)],
        )
    });
    let share = p.map(|p| p.overall as f32);
    let percent = (share.unwrap_or(0.0) * 100.0).floor() as u32;
    let doing = if r.cancelling {
        t(cx, keys::agent_panel::pending::CANCELLING)
    } else {
        t(cx, keys::project_picker::desk::IMPORTING)
    };
    let entity = cx.entity();
    Dialog::new("legacy-import-running", t(cx, keys::user_menu::IMPORT))
        .eyebrow(EYEBROW)
        .subtitle(r.folder.clone())
        .width(WIDTH)
        .body(
            div()
                .flex()
                .flex_row()
                .items_baseline()
                .gap(px(12.0))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(theme.palette.ink(1).solid())
                        .child(what),
                )
                .children(count.map(|c| index(c, window, cx))),
        )
        .body(Bar::new(share))
        .status(
            div()
                .flex()
                .flex_row()
                .items_baseline()
                .gap(px(8.0))
                .child(quiet(doing, window, cx))
                .child(index(format!("{percent}%"), window, cx)),
        )
        .action(
            Button::new("legacy-import-stop", t(cx, keys::common::CANCEL))
                .text()
                .disabled(r.cancelling)
                .busy(r.cancelling)
                .on_click(move |_, _, cx| entity.update(cx, |import, cx| import.cancel(cx))),
        )
        .into_any_element()
}

// The 0.1 libraries on this device.

fn found(f: &Found, window: &mut Window, cx: &mut Context<LegacyImport>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let entity = cx.entity();
    let now = now_ms();
    let mut rows = div()
        .id("legacy-import-found")
        .max_h(px(LIST_MAX_H))
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .py(px(4.0))
        .border_t(px(0.5))
        .border_b(px(0.5))
        .border_color(p.hairline());
    for (i, library) in f.libraries.iter().enumerate() {
        let when = library
            .modified_ms
            .map(|at| dr_view_shelf::format::ago(at, now, cx));
        let entity = entity.clone();
        let kind = if library.account {
            t(cx, keys::settings::rail::ACCOUNT)
        } else {
            t(cx, keys::common::LOCAL)
        };
        // The row is a button to assistive technology, named by what it
        // shows: which kind of library and its folder.
        let name = format!("{kind} {}", library.folder);
        rows = rows.child(
            div()
                .id(("legacy-import-library", i))
                .role(gpui::Role::Button)
                .aria_label(name)
                .flex()
                .flex_row()
                .items_baseline()
                .gap(px(12.0))
                .px(px(8.0))
                .py(px(8.0))
                .cursor_pointer()
                .hover(|el| el.bg(p.ink(1).alpha(0.05)))
                .on_click(move |_, window, cx| {
                    entity.update(cx, |import, cx| import.pick(i, window, cx))
                })
                .child(div().text_color(p.ink(1).solid()).child(kind))
                .child(div().flex_1().min_w_0().truncate().child(index(
                    library.folder.clone(),
                    window,
                    cx,
                )))
                .children(when.map(|w| index(w, window, cx))),
        );
    }
    let close = closer(cx);
    Dialog::new("legacy-import-found", t(cx, keys::user_menu::IMPORT))
        .eyebrow(EYEBROW)
        .width(WIDTH)
        .body(rows)
        .action(
            Button::new(
                "legacy-import-folder",
                t(cx, keys::import_dialog::CHOOSE_FOLDER),
            )
            .text()
            .on_click(move |_, window, cx| {
                entity.update(cx, |import, cx| import.choose_folder(window, cx))
            }),
        )
        .action(
            Button::new("legacy-import-found-cancel", t(cx, keys::common::CANCEL))
                .text()
                .on_click({
                    let close = close.clone();
                    move |_, window, cx| close(window, cx)
                }),
        )
        .on_close(close)
        .into_any_element()
}

// The gate.

fn kind_label(body: &BodyRef, cx: &App) -> SharedString {
    use keys::project_home::create::kinds;
    t(
        cx,
        match body.kind {
            ProseKind::NodeContent if body.drift => kinds::DRIFT,
            ProseKind::NodeContent => kinds::CHAPTER,
            ProseKind::Element => kinds::ELEMENT,
            ProseKind::Storyline => kinds::STORYLINE,
            ProseKind::Category => kinds::CATEGORY,
            ProseKind::LibraryItem => kinds::MATERIAL,
        },
    )
}

fn blocked(b: &Blocked, window: &mut Window, cx: &mut Context<LegacyImport>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let (p, s) = (theme.palette, theme.scale);
    let gate = &b.gate;
    let count_of = |f: Freshness| gate.doubtful.iter().filter(|d| d.freshness == f).count();
    let reasons: Vec<AnyElement> = gate
        .reasons
        .iter()
        .map(|reason| {
            let (key, count) = match reason {
                Reason::NoHandoff => (copy::NO_HANDOFF, None),
                Reason::Unproven => (copy::UNPROVEN, Some(count_of(Freshness::Unproven))),
                Reason::Stale => (copy::STALE, Some(count_of(Freshness::NodeBasisBehind))),
                Reason::ChangedAfterHandoff => (
                    copy::CHANGED_AFTER_HANDOFF,
                    Some(count_of(Freshness::HandoffMismatch)),
                ),
                Reason::Sync => (copy::SYNC, None),
            };
            missing(key, count, window, cx)
        })
        .collect();

    // The bodies, by book, in the gate's order.
    let mut books: Vec<(&str, Option<&str>)> = Vec::new();
    let mut by_book: BTreeMap<&str, Vec<&BodyRef>> = BTreeMap::new();
    for d in &gate.doubtful {
        if !by_book.contains_key(d.book.as_str()) {
            books.push((d.book.as_str(), d.book_name.as_deref()));
        }
        by_book.entry(d.book.as_str()).or_default().push(d);
    }
    let mut list = div()
        .id("legacy-import-doubtful")
        .max_h(px(LIST_MAX_H))
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(px(10.0))
        .py(px(8.0))
        .border_t(px(0.5))
        .border_b(px(0.5))
        .border_color(p.hairline());
    for (book, name) in books {
        let rows = by_book.get(book).map(Vec::as_slice).unwrap_or_default();
        let mut group = div().flex().flex_col().gap(px(2.0)).child(
            div()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .weight(weight::SEMIBOLD)
                .text_color(p.ink(1).solid())
                .child(name_or_untitled(name.unwrap_or(""), cx)),
        );
        for body in rows {
            group = group.child(
                div()
                    .flex()
                    .flex_row()
                    .items_baseline()
                    .gap(px(10.0))
                    // At least as wide as two CJK characters, wider for a
                    // longer label; never wrapped.
                    .child(
                        div()
                            .min_w(px(44.0))
                            .flex_none()
                            .whitespace_nowrap()
                            .child(index(kind_label(body, cx), window, cx)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(p.ink(2).solid())
                            .child(name_or_untitled(body.title.as_deref().unwrap_or(""), cx)),
                    ),
            );
        }
        list = list.child(group);
    }

    let url = gate.release_url;
    let close = closer(cx);
    let entity = cx.entity();
    Dialog::new("legacy-import-blocked", t(cx, keys::user_menu::IMPORT))
        .eyebrow(EYEBROW)
        .subtitle(b.folder.clone())
        .width(WIDTH)
        .body(missing(copy::BLOCKED_TITLE, None, window, cx))
        .body(div().flex().flex_col().gap(px(4.0)).children(reasons))
        .body(list)
        .body(
            div()
                .flex()
                .flex_col()
                .items_start()
                .gap(px(6.0))
                .child(missing(copy::GET_LAST_RELEASE, None, window, cx))
                .child(
                    Button::new(
                        "legacy-import-download",
                        copy::text(copy::ACTION_DOWNLOAD, None, cx),
                    )
                    .text()
                    .small()
                    .on_click(move |_, _, cx| cx.open_url(url)),
                ),
        )
        .action(
            Button::new("legacy-import-cancel", t(cx, keys::common::CANCEL))
                .text()
                .on_click({
                    let close = close.clone();
                    move |_, window, cx| close(window, cx)
                }),
        )
        .action(
            Button::new(
                "legacy-import-anyway",
                copy::text(copy::ACTION_IMPORT_ANYWAY, None, cx),
            )
            .primary()
            .on_click(move |_, window, cx| {
                entity.update(cx, |import, cx| import.import_anyway(window, cx))
            }),
        )
        .on_close(close)
        .into_any_element()
}

// The summary.

/// 「有 N 处和旧版不完全一样」 under the count lines, in their look, with the
/// disclosure triangle at its end; a button to assistive technology, named
/// by what it says. Pressed, it opens or closes [`differences`].
fn differences_line(
    total: usize,
    open: bool,
    window: &Window,
    cx: &mut Context<LegacyImport>,
) -> AnyElement {
    let p = Theme::of(window, cx).palette;
    let label = copy::text(copy::DIFFERENCES, Some(total), cx);
    let entity = cx.entity();
    div()
        .id("legacy-import-differences-line")
        .debug_selector(|| "legacy-import-differences-line".into())
        .role(gpui::Role::Button)
        .aria_label(label.clone())
        .aria_expanded(open)
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        // The hover wash reaches past the text, which stays in line with
        // the lines above.
        .mx(px(-4.0))
        .px(px(4.0))
        .cursor_pointer()
        .hover(|el| el.bg(p.ink(1).alpha(0.04)).text_color(p.ink(1).solid()))
        .on_click(move |_, _, cx| entity.update(cx, |import, cx| import.toggle_differences(cx)))
        .child(div().flex_1().min_w_0().child(label))
        .child(sand::icon(
            if open {
                Icon::ChevronDown
            } else {
                Icon::ChevronRight
            },
            11.0,
            p.muted().solid(),
        ))
        .into_any_element()
}

/// What differs from 0.1, by book: each book's name, then its sentences as
/// summary.md words them (but for the two that end in 「逐条列在下方」, said
/// without it: `Difference::dialog_text`), each with its count where the
/// importer counts it (「N 处」); above a book's material lines, summary.md's
/// heading of that block. Scrolls past [`LIST_MAX_H`] between hairlines, as
/// the books and the gate's list do. Each book name, heading and line is a
/// label to assistive technology, read as it shows (a line with its count).
fn differences(d: &Done, window: &Window, cx: &App) -> AnyElement {
    let theme = Theme::of(window, cx);
    let (p, s) = (theme.palette, theme.scale);
    let strings = dr_shell::Strings::get(cx);
    let mut list = div()
        .id("legacy-import-differences")
        .debug_selector(|| "legacy-import-differences".into())
        .max_h(px(LIST_MAX_H))
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(px(10.0))
        .py(px(8.0))
        .border_t(px(0.5))
        .border_b(px(0.5))
        .border_color(p.hairline());
    for (i, book) in d
        .books
        .iter()
        .filter(|b| !b.differences.is_empty())
        .enumerate()
    {
        let name = name_or_untitled(&book.name, cx);
        let mut group = div().flex().flex_col().gap(px(4.0)).child(
            div()
                .id(SharedString::from(format!(
                    "legacy-import-differences-book-{i}"
                )))
                .debug_selector(move || format!("legacy-import-differences-book-{i}"))
                .role(gpui::Role::Label)
                .aria_label(name.clone())
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .weight(weight::SEMIBOLD)
                .text_color(p.ink(1).solid())
                .child(name),
        );
        let mut materials_heading = false;
        for (j, line) in book.differences.iter().enumerate() {
            if line.block == Block::Materials && !materials_heading {
                materials_heading = true;
                let heading = t(cx, MATERIALS_HEADING);
                group = group.child(
                    div()
                        .id(SharedString::from(format!(
                            "legacy-import-differences-materials-{i}"
                        )))
                        .debug_selector(move || format!("legacy-import-differences-materials-{i}"))
                        .role(gpui::Role::Label)
                        .aria_label(heading.clone())
                        .pl(px(12.0))
                        .pt(px(4.0))
                        .font_role(Role::Ui)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.muted().solid())
                        .child(heading),
                );
            }
            let count = line
                .counted
                .then(|| tp(cx, keys::v5_files::USAGE_COUNT, line.count as u64, &[]));
            let text = line.dialog_text(strings);
            let read = match &count {
                Some(c) => format!("{text} {c}"),
                None => text.clone(),
            };
            group = group.child(
                div()
                    .id(SharedString::from(format!(
                        "legacy-import-difference-{i}-{j}"
                    )))
                    .debug_selector(move || format!("legacy-import-difference-{i}-{j}"))
                    .role(gpui::Role::Label)
                    .aria_label(read)
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap(px(12.0))
                    .pl(px(12.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.ink(2).solid())
                            .child(text),
                    )
                    .children(count.map(|c| {
                        div()
                            .flex_none()
                            .whitespace_nowrap()
                            .child(index(c, window, cx))
                    })),
            );
        }
        list = list.child(group);
    }
    list.into_any_element()
}

fn done(d: &Done, open: bool, window: &mut Window, cx: &mut Context<LegacyImport>) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let locale = Settings::locale(cx);
    let imported: Vec<_> = d.books.iter().filter(|b| b.status == "imported").collect();
    let words: u64 = imported.iter().filter_map(|b| b.words).sum();
    let headline = tp(
        cx,
        keys::project_picker::rail::LIBRARY,
        imported.len() as u64,
        &[
            ("count", &imported.len()),
            ("words", &grouped(words, locale)),
        ],
    );
    let mut rows = div()
        .id("legacy-import-books")
        .max_h(px(LIST_MAX_H))
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(px(4.0))
        .py(px(8.0))
        .border_t(px(0.5))
        .border_b(px(0.5))
        .border_color(p.hairline());
    for book in &d.books {
        let status = match book.status.as_str() {
            "imported" => {
                quiet(t(cx, keys::import_dialog::status::COMMITTED), window, cx).into_any_element()
            }
            "already-imported" => missing(copy::ALREADY_IMPORTED, None, window, cx),
            "already-in-library" => missing(copy::ALREADY_IN_LIBRARY, None, window, cx),
            "cancelled" => quiet(
                t(cx, keys::settings::hosted::connect_errors::CANCELLED),
                window,
                cx,
            )
            .into_any_element(),
            "importing" => missing(copy::CARRIES_ON, None, window, cx),
            other => index(other.to_owned(), window, cx).into_any_element(),
        };
        let words = book.words.filter(|_| book.status == "imported").map(|w| {
            tf(
                cx,
                keys::common::WORDS_COUNT,
                &[("count", &grouped(w, locale))],
            )
        });
        rows = rows.child(
            div()
                .flex()
                .flex_row()
                .items_baseline()
                .gap(px(12.0))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(p.ink(1).solid())
                        .child(name_or_untitled(&book.name, cx)),
                )
                .children(words.map(|w| index(w, window, cx)))
                .child(status),
        );
    }
    let close = closer(cx);
    let differing = d.differences();
    Dialog::new("legacy-import-done", t(cx, keys::user_menu::IMPORT))
        .eyebrow(EYEBROW)
        .subtitle(d.folder.clone())
        .width(WIDTH)
        .body(div().text_color(p.ink(1).solid()).child(headline))
        .body(rows)
        .when(d.from_caches > 0, |dialog| {
            dialog.body(
                div()
                    .debug_selector(|| "legacy-import-from-caches".into())
                    .child(missing(copy::FROM_CACHES, Some(d.from_caches), window, cx)),
            )
        })
        .when(!d.left.is_empty(), |dialog| {
            dialog.body(
                div()
                    .debug_selector(|| "legacy-import-left".into())
                    .child(missing(
                        copy::ACCOUNT_LIBRARIES_LEFT,
                        Some(d.left.len()),
                        window,
                        cx,
                    )),
            )
        })
        .when(differing > 0, |dialog| {
            dialog
                .body(differences_line(differing, open, window, cx))
                .when(open, |dialog| dialog.body(differences(d, window, cx)))
        })
        .action(
            Button::new(
                "legacy-import-finish",
                t(cx, keys::import_dialog::summary::DONE),
            )
            .primary()
            .on_click({
                let close = close.clone();
                move |_, window, cx| close(window, cx)
            }),
        )
        .on_close(close)
        .into_any_element()
}

// A failure.

fn failed(f: &Failed, window: &mut Window, cx: &mut Context<LegacyImport>) -> AnyElement {
    let close = closer(cx);
    Dialog::new(
        "legacy-import-failed",
        t(cx, keys::project_picker::book_transfer::IMPORT_FAILED_TITLE),
    )
    .eyebrow(EYEBROW)
    .when_some(f.folder.clone(), |d, folder| d.subtitle(folder))
    .width(WIDTH)
    .body(index(f.message.clone(), window, cx))
    .action(
        Button::new("legacy-import-close", t(cx, keys::common::CLOSE))
            .primary()
            .on_click({
                let close = close.clone();
                move |_, window, cx| close(window, cx)
            }),
    )
    .on_close(close)
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_i18n::Locale;
    use gpui::TestAppContext;
    use std::path::PathBuf;

    #[gpui::test]
    fn ready_dialog_lines_never_expose_raw_target_path_or_mapping_json(cx: &mut TestAppContext) {
        let ready = Ready {
            folder: "synthetic-0.1".into(),
            target: PathBuf::from("synthetic-root/reimport-v5-secret-target"),
            explicit_choices: true,
            pending: Vec::new(),
        };
        cx.update(|cx| {
            for locale in Locale::ALL {
                dr_shell::Strings::install(locale, cx);
                let (dest, pending) = ready_body_lines(&ready, cx);
                assert!(
                    !dest.contains("reimport-v5-secret-target"),
                    "{locale:?}: {dest}"
                );
                assert!(!dest.contains("MappingChoices"), "{locale:?}: {dest}");
                assert!(pending.is_empty());
            }
        });
    }
}
