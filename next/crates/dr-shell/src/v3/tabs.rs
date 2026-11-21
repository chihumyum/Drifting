//! What a left-column Tab is mounted on (`kernel-v5.md` §5): its name,
//! whether it is still there and why not, the Tab writes, and the list the
//! shell draws itself: the book sequence. Dragging in it changes the manual
//! order of the layer it is dropped in. A Tab cannot mount a view (DV,
//! 2026-11-16): one a book stored from before reads as gone.
use super::{EntryDrag, entry_target};
use crate::{
    book::v3::BookV3,
    nav::Open,
    pages::PageViewHost,
    strings::t,
    v3::level_switch::{host_still_valid, toast_save_failed},
};
use dr_i18n::keys;
use dr_ui::{
    Theme,
    components::{
        DraggedPill, Pill, SandCell,
        hover_card::{SidebarCard, SidebarCards},
        overlay,
    },
    fonts::Role,
    style::DrStyled,
};
use dr_workspace::{
    Actor, WsError,
    commands::v3::types::{ProjectTab, TabMount},
};
use gpui::{prelude::*, *};
use serde_json::{Value, json};
use std::rc::Rc;

/// Whether what `mount` is mounted on is not there now: the entry is in
/// Recently Deleted, has both its switches off or is not in the book; the
/// book was turned off; a Tab on a view, always (a Tab cannot mount a view,
/// DV 2026-11-16: one a book stored from before reads as gone even while the
/// view is there). The Tab stays, faded, and its content says so
/// (`kernel-v5.md` §5). 「全部」 is always there.
pub fn is_gone(v: &BookV3, mount: &TabMount) -> bool {
    match mount {
        TabMount::Root => false,
        TabMount::Entry { entry } => !(v.entry(entry).is_some() && v.has_below(entry)),
        TabMount::View { .. } => true,
        TabMount::Book => v.project.book.is_none(),
    }
}

/// The name of what `mount` is mounted on: what its Tab is called. An
/// entry gone from the book altogether reads as 「条目」; an old Tab on a view
/// is called by the view's name, or 「视图」 once the view is gone too.
pub fn mount_name(v: &BookV3, mount: &TabMount, cx: &App) -> SharedString {
    match mount {
        TabMount::Root => t(cx, keys::v3_shell::OUTERMOST),
        TabMount::Entry { entry } => v
            .entry(entry)
            .map(|e| e.title.clone())
            .or_else(|| v.trashed_titles.get(entry).cloned())
            .map(SharedString::from)
            .unwrap_or_else(|| t(cx, keys::v3_tabs::ENTRIES)),
        TabMount::View { view } => v
            .timeline_views
            .iter()
            .find(|tv| &tv.id == view)
            .map(|tv| SharedString::from(tv.name.clone()))
            .unwrap_or_else(|| t(cx, keys::v3_tabs::VIEWS)),
        TabMount::Book => t(cx, keys::v3_tabs::BOOK),
    }
}

/// What `tab` is called: [`mount_name`], or, once the entry it is mounted
/// on was deleted for good, the title the Tab kept (`entry.purge`,
/// `kernel-v5.md` §5: it keeps being called by it).
pub fn tab_name(v: &BookV3, tab: &ProjectTab, cx: &App) -> SharedString {
    match (&tab.mount, &tab.gone_title) {
        (TabMount::Entry { entry }, Some(title))
            if v.entry(entry).is_none() && !v.trashed_titles.contains_key(entry) =>
        {
            SharedString::from(title.clone())
        }
        _ => mount_name(v, &tab.mount, cx),
    }
}

/// Runs a Tab command on the library's thread; a refused write says so in a
/// notice. `done` gets its output.
pub fn write(
    host: &PageViewHost,
    command: &'static str,
    mut input: Value,
    done: impl FnOnce(Value, &mut App) + 'static,
    cx: &mut App,
) {
    if !host_still_valid(host, cx) {
        return;
    }
    input["book"] = json!(host.book_id);
    let lib = host.library.clone();
    let job = cx
        .background_executor()
        .spawn(async move { lib.call(&Actor::User, command, input) });
    let host = host.clone();
    cx.spawn(async move |cx| match job.await {
        Ok(answer) => {
            cx.update(|cx| done(answer["output"].clone(), cx));
        }
        Err(error) => {
            log::warn!("{command} failed: {error}");
            cx.update(|cx| toast_save_failed(&host, cx));
        }
    })
    .detach();
}

/// One row of an entry in a Tab's list: its mark and title, opening it on
/// a click (kept on a double click), its hover card, and dragging to change
/// the order `drop` writes. `lead` goes before the mark (a number).
#[allow(clippy::too_many_arguments)]
fn entry_row(
    host: &PageViewHost,
    scope: &str,
    id: &str,
    depth: usize,
    lead: Option<SharedString>,
    cards: SidebarCards,
    drop: impl Fn(&EntryDrag, bool, &mut Window, &mut App) + 'static,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let Some(v) = host.book.v3() else {
        return div().into_any_element();
    };
    let Some(entry) = v.entry(id) else {
        return div().into_any_element();
    };
    let Some(target) = entry_target(id) else {
        return div().into_any_element();
    };
    let (mark, color) = host.book.mark(&target);
    let workspace = host.workspace.upgrade();
    // A row just back from Recently Deleted flashes once (`trash`).
    let selected = workspace
        .as_ref()
        .is_some_and(|ws| ws.read(cx).nav.is_selected(&target))
        || super::trash::flashing(id, window, cx);
    let open = target.clone();
    let weak = host.workspace.clone();
    let mut cell = SandCell::new(
        SharedString::from(format!("v3-tab-{scope}-entry-{id}")),
        entry.title.clone(),
    )
    .mark(mark)
    .color_opt(color)
    .selected(selected)
    .on_click(move |event, _, cx| {
        if let Some(ws) = weak.upgrade() {
            ws.update(cx, |ws, cx| {
                ws.open(
                    open.clone(),
                    if event.click_count() > 1 {
                        Open::KEEP
                    } else {
                        Open::PREVIEW
                    },
                    cx,
                )
            });
        }
    });
    if let Some(lead) = lead {
        let theme = Theme::of(window, cx);
        cell = cell.lead(
            div()
                .w(px(18.0))
                .flex_none()
                .font_role(Role::Index)
                .type_px(theme.scale.caption, theme.scale.line_caption)
                .text_color(theme.palette.muted().solid())
                .child(lead),
        );
    }
    let cell = match workspace {
        Some(ws) => crate::workspace::sidebar_page_hover_card(
            format!("v3-tab-{scope}-card-{id}"),
            cell,
            &target,
            &ws,
            None,
            SidebarCard {
                cards,
                on_pointer_open: None,
            },
            cx,
        ),
        None => cell.into_any_element(),
    };
    let bounds = overlay::use_bounds(
        SharedString::from(format!("v3-tab-{scope}-bounds-{id}")),
        window,
        cx,
    );
    let drop_bounds = bounds.clone();
    let page = host.clone();
    let can_page = host.clone();
    let title = entry.title.clone();
    let ghost = entry.title.clone();
    let onto = id.to_owned();
    let palette = Theme::of(window, cx).palette;
    let line = palette.accent.alpha(0.55);
    div()
        .id(SharedString::from(format!("v3-tab-{scope}-row-{id}")))
        .relative()
        .w_full()
        .pl(px(depth.min(20) as f32 * 14.0))
        .on_drag(
            EntryDrag::new(page.clone(), id, title),
            move |_, _, window, cx| {
                let pill = Pill::new(ghost.clone()).mark(mark, color);
                let at = window.mouse_position();
                cx.new(|_| DraggedPill::new(pill, at))
            },
        )
        .can_drop(move |value, _, _| {
            value.downcast_ref::<EntryDrag>().is_some_and(|drag| {
                drag.matches(&can_page)
                    && drag.hung_host.is_none()
                    && (drag.timeline_clip.is_some() || drag.entry != onto)
            })
        })
        .drag_over::<EntryDrag>(move |style, _, _, _| style.border_b_1().border_color(line))
        .on_drop(move |drag: &EntryDrag, window, cx| {
            if !drag.matches(&page) || !drag.is_current(cx) {
                return;
            }
            if detach_timeline_clip(&page, drag, cx) {
                return;
            }
            let after = drop_bounds
                .read(cx)
                .is_some_and(|b| window.mouse_position().y > b.center().y);
            drop(drag, after, window, cx);
        })
        .child(overlay::probe(bounds))
        .child(cell)
        .into_any_element()
}

/// Detaches a timeline lane clip dropped back onto the left sidebar (`摘名`),
/// leaving its residence untouched (`kernel-v5.md` §16, `W9Bottom`).
pub fn detach_timeline_clip(host: &PageViewHost, drag: &EntryDrag, cx: &mut App) -> bool {
    let Some(clip) = &drag.timeline_clip else {
        return false;
    };
    if !drag.matches(host) || !drag.is_current(cx) {
        return true;
    }
    write(
        host,
        "timeline_view.remove",
        json!({
            "view": clip.view,
            "entry": drag.entry,
            "lane": clip.lane,
        }),
        |_, _| {},
        cx,
    );
    true
}

/// Moves `moving` to live beside `onto` (before or after it), in `onto`'s
/// folder's manual order (`entry.move` reads `index` among the folder's
/// stored children; a folder in a view keeps its manual order, DV
/// 2026-11-16).
pub fn move_beside(
    lib: &dr_workspace::Workspace,
    book: &str,
    moving: &str,
    onto: &str,
    after: bool,
) -> Result<(), WsError> {
    let input = move_beside_input(lib, book, moving, onto, after)?;
    lib.call(&Actor::User, "entry.move", input)?;
    Ok(())
}

pub(super) fn move_beside_input(
    lib: &dr_workspace::Workspace,
    book: &str,
    moving: &str,
    onto: &str,
    after: bool,
) -> Result<Value, WsError> {
    let list: Vec<dr_workspace::commands::v3::types::Entry> = serde_json::from_value(
        lib.call(
            &Actor::User,
            "entry.list",
            json!({ "book": book, "all": true, "trashed": true }),
        )?["output"]
            .clone(),
    )
    .map_err(|e| WsError::Internal(e.to_string()))?;
    let parent = list
        .iter()
        .find(|e| e.id == onto)
        .ok_or_else(|| WsError::Invalid("the drop target is gone".into()))?
        .parent
        .clone();
    let siblings: Vec<String> = list
        .iter()
        .filter(|e| e.parent == parent)
        .map(|e| e.id.clone())
        .collect();
    let index = siblings
        .iter()
        .filter(|id| *id != moving)
        .position(|id| id == onto)
        .ok_or_else(|| WsError::Invalid("the drop target is no longer a sibling".into()))?
        + usize::from(after);
    Ok(json!({ "book": book, "id": moving, "parent": parent, "index": index }))
}

/// Drops `moving` before or after `onto` in a Tab mounted on the book: the
/// book reads from the root, so this is a drop in 「全部」: `moving` goes to
/// live beside `onto`, in the manual order of `onto`'s layer.
pub fn drop_in_book(host: &PageViewHost, moving: &str, onto: &str, after: bool, cx: &mut App) {
    if host.book.v3().is_none() {
        return;
    }
    let lib = host.library.clone();
    let book = host.book_id.clone();
    let (moving, onto) = (moving.to_owned(), onto.to_owned());
    let job = cx
        .background_executor()
        .spawn(async move { move_beside(&lib, &book, &moving, &onto, after) });
    let host = host.clone();
    cx.spawn(async move |cx| {
        if let Err(error) = job.await {
            log::warn!("reordering the book failed: {error}");
            cx.update(|cx| toast_save_failed(&host, cx));
        }
    })
    .detach();
}

fn scroll_list(id: &str) -> Stateful<Div> {
    div()
        .id(SharedString::from(id.to_owned()))
        .size_full()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(px(2.0))
}

/// The fold of the book Tab's 「最近删除」: whether it is open, and which of
/// its rows are opened to what went in with them.
struct BookTrash {
    open: bool,
    unfolded: std::collections::BTreeSet<String>,
}

/// A Tab mounted on the book: the book sequence, one entry a row (the App
/// numbers nothing). Dragging is a drop in 「全部」 ([`drop_in_book`]). Its
/// last section is 「最近删除」 with what had prose in the book.
pub fn book_list(host: &PageViewHost, window: &mut Window, cx: &mut App) -> AnyElement {
    let Some(v) = host.book.v3() else {
        return div().into_any_element();
    };
    let order = v.book_entries();
    let cards = window.use_keyed_state("book-sidebar-cards", cx, |_, _| SidebarCards::default());
    let cards = cards.read(cx).clone();
    let mut list = scroll_list("v3-tab-book");
    for id in &order {
        let host_ = host.clone();
        let onto = id.clone();
        list = list.child(entry_row(
            host,
            "book",
            id,
            0,
            None,
            cards.clone(),
            move |drag, after, _, cx| drop_in_book(&host_, &drag.entry, &onto, after, cx),
            window,
            cx,
        ));
    }
    let fold = window.use_keyed_state("book-sidebar-trash", cx, |_, _| BookTrash {
        open: true,
        unfolded: Default::default(),
    });
    let (open, unfolded) = {
        let f = fold.read(cx);
        (f.open, f.unfolded.clone())
    };
    if let Some((count, rows)) = super::trash::section(v, &TabMount::Book, &unfolded) {
        let toggle = fold.clone();
        list = list.child(super::trash::head(
            "book",
            count,
            open,
            move |_, cx| {
                toggle.update(cx, |f, cx| {
                    f.open = !f.open;
                    cx.notify();
                })
            },
            window,
            cx,
        ));
        if open {
            let folder = fold.clone();
            let hooks = super::trash::RowHooks {
                fold: Rc::new(move |id: &str, cx: &mut App| {
                    folder.update(cx, |f, cx| {
                        if !f.unfolded.remove(id) {
                            f.unfolded.insert(id.to_owned());
                        }
                        cx.notify();
                    })
                }),
                restored: Rc::new(|_: &str, _: &mut App| {}),
            };
            for row in &rows {
                list = list.child(super::trash::row(
                    host,
                    "book",
                    row,
                    unfolded.contains(&row.id),
                    cards.clone(),
                    hooks.clone(),
                    window,
                    cx,
                ));
            }
        }
    }
    list.into_any_element()
}
