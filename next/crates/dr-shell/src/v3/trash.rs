//! The left column's 「最近删除」 (`kernel-v5.md` §16; the author chose 一甲
//! and 二乙 on 2026-11-21): the last section of every Tab's tree, drawn like
//! the material library's. Its head says how many entries it holds and folds
//! it; its rows are dimmed, each an entry with its mark, its name and a
//! small line 「住在「…」 · N 天前」 naming where it goes back to (where
//! `entry.restore` puts it, which may be further up than where it lived).
//! What went in with an entry is folded under it with the usual triangle,
//! and can be restored on its own. A row's hover card has 「恢复」 and
//! 「永久删除」, neither asking first; a restored entry's row flashes once
//! where it now is, and nothing else is said. Nothing shows when the Tab
//! has nothing deleted.
//!
//! What a Tab lists: 「全部」 everything; a Tab on an entry what lived in
//! its tree (under it, at any depth, or hung on it or on an entry under it);
//! a Tab on the book what had prose that is part of the book.
use std::{collections::BTreeSet, rc::Rc, time::SystemTime};

use dr_i18n::keys;
use dr_ui::{
    Theme,
    components::{
        CardAction, CardBody, HoverCard, SandCell,
        hover_card::{SidebarCard, SidebarCards},
    },
    fonts::{Role, weight},
    sand::{self, Icon},
    style::DrStyled,
    tokens::radius,
};
use dr_workspace::commands::v3::types::TabMount;
use gpui::{prelude::*, *};
use serde_json::json;

use crate::{
    book::v3::{BookV3, Trashed},
    pages::{PageViewHost, UsageFlash},
    strings::{t, tf},
};

/// A row of the section: a deleted entry, how deep it is folded, and
/// whether something went in with it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrashRow {
    pub id: String,
    pub depth: usize,
    pub holds: bool,
}

/// The section of a Tab on `mount`: the number of entries it holds and
/// its rows, the rows in `unfolded` opened to what went in with them.
/// `None` when the Tab has nothing deleted.
pub fn section(
    v: &BookV3,
    mount: &TabMount,
    unfolded: &BTreeSet<String>,
) -> Option<(usize, Vec<TrashRow>)> {
    let roots: Vec<&Trashed> = v
        .trash_roots
        .iter()
        .filter_map(|id| v.trash.get(id))
        .filter(|row| match mount {
            TabMount::Root => true,
            TabMount::Entry { entry } => row.places.contains(entry),
            TabMount::Book => row.in_book,
            TabMount::View { .. } => false,
        })
        .collect();
    if roots.is_empty() {
        return None;
    }
    let mut count = 0;
    let mut rows = Vec::new();
    for root in roots {
        let mut todo = vec![(root, 0usize, true)];
        while let Some((row, depth, shown)) = todo.pop() {
            count += 1;
            if shown {
                rows.push(TrashRow {
                    id: row.id.clone(),
                    depth,
                    holds: !row.folded.is_empty(),
                });
            }
            let open = shown && unfolded.contains(&row.id);
            todo.extend(
                row.folded
                    .iter()
                    .rev()
                    .filter_map(|id| v.trash.get(id))
                    .map(|child| (child, depth + 1, open)),
            );
        }
    }
    Some((count, rows))
}

/// The small line under a deleted entry's name: where it goes back to and
/// when it was deleted.
pub fn line(row: &Trashed, now: SystemTime, cx: &App) -> SharedString {
    let lives = match &row.lands_title {
        Some(name) if row.lands.is_some() => tf(cx, keys::v3_shell::LIVES_IN, &[("name", name)]),
        _ => t(cx, keys::v3_shell::LIVES_OUTERMOST),
    };
    let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(row.deleted_at.max(0) as u64);
    format!("{lives} · {}", crate::notifications::ago(at, now, cx)).into()
}

/// The section's head: 「最近删除」, its count and the fold, drawn like the
/// material library's section heads. A click folds or unfolds it.
pub fn head(
    scope: &str,
    count: usize,
    open: bool,
    on_toggle: impl Fn(&mut Window, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    head_with_empty(scope, count, open, on_toggle, None, window, cx)
}

/// Callback invoked when the author clicks 「清空」 on a Recently Deleted section.
pub type OnEmpty = Rc<dyn Fn(&mut Window, &mut App)>;

/// Like [`head`], with an optional bulk 「清空」 action that purges every
/// deleted root in the section.
#[allow(clippy::too_many_arguments)]
pub fn head_with_empty(
    scope: &str,
    count: usize,
    open: bool,
    on_toggle: impl Fn(&mut Window, &mut App) + 'static,
    on_empty: Option<OnEmpty>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let (p, s) = (theme.palette, theme.scale);
    let title = t(cx, keys::v5_files::TRASH_SECTION);
    let selector = format!("v5-trash-head-{scope}");
    let empty_btn = (count > 0).then_some(on_empty).flatten().map(|run| {
        let label = t(cx, keys::v5_files::EMPTY_TRASH);
        div()
            .id(SharedString::from(format!("v5-trash-empty-{scope}")))
            .px(px(5.0))
            .py(px(1.0))
            .rounded(px(radius::SM))
            .cursor_pointer()
            .font_role(Role::Ui)
            .type_px(s.caption, s.line_caption)
            .text_color(p.danger.alpha(0.85))
            .hover(move |st| st.bg(p.danger.alpha(0.10)).text_color(p.danger.solid()))
            .role(gpui::Role::Button)
            .aria_label(label.clone())
            .child(label)
            .on_mouse_down(MouseButton::Left, |_, window, cx| {
                window.prevent_default();
                cx.stop_propagation();
            })
            .on_click(move |_, window, cx| {
                cx.stop_propagation();
                run(window, cx);
            })
    });
    div()
        .pt(px(10.0))
        .w_full()
        .child(
            div()
                .id(SharedString::from(format!("v5-trash-head-{scope}")))
                .debug_selector(move || selector)
                .h(px(24.0))
                .px(px(6.0))
                .rounded(px(radius::SM))
                .cursor_pointer()
                .hover(move |st| st.bg(p.ink(1).alpha(0.04)))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(5.0))
                .role(gpui::Role::Button)
                .aria_label(title.clone())
                .aria_expanded(open)
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.caption, s.line_caption)
                        .weight(weight::MEDIUM)
                        .text_color(p.ink(3).solid())
                        .child(title),
                )
                .child(
                    div()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.ink(4).solid())
                        .child(count.to_string()),
                )
                .child(div().flex_1())
                .children(empty_btn)
                .child(sand::icon(
                    if open {
                        Icon::ChevronDown
                    } else {
                        Icon::ChevronRight
                    },
                    11.0,
                    p.ink(4).solid(),
                ))
                .on_click(move |_, window, cx| on_toggle(window, cx)),
        )
        .into_any_element()
}

/// Something a row tells its list about one of its entries (by id).
pub type RowHook = Rc<dyn Fn(&str, &mut App)>;

/// What a row does besides its card: fold or unfold what went in with it,
/// and hear that its entry was restored (to show where it went).
#[derive(Clone)]
pub struct RowHooks {
    pub fold: RowHook,
    pub restored: RowHook,
}

/// One dimmed row, laid out as the tree's rows are: the fold at the
/// column's edge when something went in with it, then, indented by its
/// depth, the mark, the name and the small line; its hover card beside it,
/// shared with the rest of the column's cards.
#[allow(clippy::too_many_arguments)]
pub fn row(
    host: &PageViewHost,
    scope: &str,
    row: &TrashRow,
    open: bool,
    cards: SidebarCards,
    hooks: RowHooks,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let Some(v) = host.book.v3() else {
        return div().into_any_element();
    };
    let Some(entry) = v.trash.get(&row.id) else {
        return div().into_any_element();
    };
    let theme = Theme::of(window, cx);
    let kind = crate::book::v3::mark(entry.mark.as_deref(), &entry.id);
    let sub = line(entry, SystemTime::now(), cx);
    let id = row.id.clone();
    let fold = row.holds.then(|| {
        let fold = hooks.fold.clone();
        let id = id.clone();
        div()
            .id(SharedString::from(format!("v5-trash-fold-{scope}-{id}")))
            .size(px(14.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .role(gpui::Role::Button)
            .aria_label(tf(
                cx,
                if open {
                    keys::v3_levels::COLLAPSE
                } else {
                    keys::v3_levels::EXPAND
                },
                &[("name", &entry.title)],
            ))
            .child(sand::icon(
                if open {
                    Icon::ChevronDown
                } else {
                    Icon::ChevronRight
                },
                11.0,
                theme.palette.ink(3).solid(),
            ))
            .on_click(move |_, _, cx| {
                cx.stop_propagation();
                fold(&id, cx);
            })
    });
    let cell = SandCell::new(
        SharedString::from(format!("v5-trash-cell-{scope}-{id}")),
        entry.title.clone(),
    )
    .mark(kind)
    .subline(sub.clone());
    let (title, card_id) = (entry.title.clone(), format!("v5-trash-card-{scope}-{id}"));
    let card_host = host.clone();
    let restored = hooks.restored.clone();
    let card = HoverCard::new(SharedString::from(card_id.clone()), cell, move |_, cx| {
        card_body(
            &card_host,
            &card_id,
            &id,
            &title,
            kind,
            &sub,
            restored.clone(),
            cx,
        )
    })
    .in_sidebar(SidebarCard {
        cards,
        on_pointer_open: None,
    });
    let selector = format!("v5-trash-row-{}", row.id);
    div()
        .id(SharedString::from(format!(
            "v5-trash-row-{scope}-{}",
            row.id
        )))
        .debug_selector(move || selector)
        .w_full()
        .min_w_0()
        .flex()
        .items_center()
        .opacity(0.55)
        .children(fold)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .pl(px(row.depth.min(20) as f32 * 14.0))
                .child(card),
        )
        .into_any_element()
}

/// The row's card: its name and mark, the small line, 「恢复」 and, parted
/// by a hairline as the danger row, 「永久删除」. Neither asks first.
#[allow(clippy::too_many_arguments)]
fn card_body(
    host: &PageViewHost,
    card_id: &str,
    id: &str,
    title: &str,
    kind: sand::Kind,
    sub: &SharedString,
    restored: RowHook,
    cx: &mut App,
) -> AnyElement {
    let (restore_host, purge_host) = (host.clone(), host.clone());
    let (restore_id, purge_id) = (id.to_owned(), id.to_owned());
    let restore = CardAction::new(
        SharedString::from(format!("{card_id}-restore")),
        Icon::Rotate,
        t(cx, keys::v5_files::RESTORE),
    )
    .on_click(move |_, _, cx| restore_entry(&restore_host, &restore_id, restored.clone(), cx))
    .into_any_element();
    let purge = CardAction::new(
        SharedString::from(format!("{card_id}-purge")),
        Icon::Trash,
        t(cx, keys::v5_files::PURGE),
    )
    .danger()
    .on_click(move |_, _, cx| purge_entry(&purge_host, &purge_id, cx))
    .into_any_element();
    CardBody::new(
        SharedString::from(format!("{card_id}-body")),
        title.to_owned(),
    )
    .mark(kind, None)
    .meta(sub.clone())
    .section(vec![restore])
    .section(vec![purge])
    .into_any_element()
}

/// 「恢复」: the entry goes back where `entry.restore` puts it; once it is
/// there its row flashes once (`UsageFlash`, the reveal's flash) and the
/// list showing it hears where it went. Nothing else is said.
pub fn restore_entry(host: &PageViewHost, id: &str, restored: RowHook, cx: &mut App) {
    let entry = id.to_owned();
    super::tabs::write(
        host,
        "entry.restore",
        json!({ "id": id }),
        move |_, cx| {
            UsageFlash::trigger([flash_key(&entry)], cx);
            restored(&entry, cx);
        },
        cx,
    );
}

/// 「永久删除」: the entry and what went in with it are deleted for good
/// (`entry.purge`), without a question, as the material library's files.
pub fn purge_entry(host: &PageViewHost, id: &str, cx: &mut App) {
    super::tabs::write(host, "entry.purge", json!({ "id": id }), |_, _| {}, cx);
}

/// Bulk 「清空」: permanently purges every root entry currently trashed in
/// `mount` (each `entry.purge` also purges everything folded under that root).
pub fn purge_mount(host: &PageViewHost, mount: &TabMount, cx: &mut App) {
    let Some(v) = host.book.v3() else {
        return;
    };
    let roots: Vec<String> = v
        .trash_roots
        .iter()
        .filter_map(|id| v.trash.get(id))
        .filter(|row| match mount {
            TabMount::Root => true,
            TabMount::Entry { entry } => row.places.contains(entry),
            TabMount::Book => row.in_book,
            TabMount::View { .. } => false,
        })
        .map(|row| row.id.clone())
        .collect();
    for id in roots {
        purge_entry(host, &id, cx);
    }
}

/// The flash a tree row of `entry` shows when it has just come back.
pub fn flash_key(entry: &str) -> String {
    format!("tree-entry:{entry}")
}

/// Whether a tree row of `entry` is flashing now.
pub fn flashing(entry: &str, window: &mut Window, cx: &App) -> bool {
    UsageFlash::strength_for(&[flash_key(entry)], window, cx) > 0.0
}
