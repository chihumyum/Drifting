//! What a left-column Tab is mounted on (`kernel-v5.md` §5): its name,
//! whether it is still there and why not, the Tab writes, and the two lists
//! the shell draws itself: a view's lanes with their entries along its
//! scale, and the book sequence. Dragging in them changes the order where
//! it lives: the scale for a view, the start's order for the book (manual
//! order under a folder, the scale under a view).
use super::{EntryDrag, entry_target};
use crate::{
    book::v3::BookV3,
    nav::Open,
    pages::PageViewHost,
    strings::{t, tf},
    v3::level_switch::{host_still_valid, toast_save_failed},
};
use dr_i18n::keys;
use dr_ui::{
    Theme,
    components::{DraggedPill, Pill, SandCell, overlay},
    fonts::Role,
    sand::{self, KindMark},
    style::DrStyled,
};
use dr_workspace::{
    Actor, RecordKey, WritePreconditions, WsError,
    commands::v3::types::{BookRoot, ProjectTab, TabMount, TimelineView},
};
use gpui::{prelude::*, *};
use serde_json::{Value, json};

/// Why a Tab shows nothing: what it is mounted on is not there now. The
/// Tab stays, with its name; its content says why and offers another mount.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Gone {
    /// The entry is in Recently Deleted.
    Trashed(String),
    /// The entry holds nothing any more: its two switches are off.
    Closed(String),
    /// The view was deleted.
    ViewDeleted(String),
    /// The project's book was turned off.
    BookOff,
    /// It is not in the book at all.
    Missing,
}

impl Gone {
    pub fn text(&self, tab: &ProjectTab, cx: &App) -> SharedString {
        match self {
            Gone::Trashed(name) => tf(cx, keys::v3_tabs::GONE_TRASHED, &[("name", name)]),
            Gone::Closed(name) => tf(cx, keys::v3_tabs::GONE_CLOSED, &[("name", name)]),
            Gone::ViewDeleted(name) => tf(cx, keys::v3_tabs::GONE_VIEW_DELETED, &[("name", name)]),
            Gone::BookOff => t(cx, keys::v3_tabs::GONE_BOOK_OFF),
            Gone::Missing => tf(cx, keys::v3_tabs::GONE_MISSING, &[("name", &tab.name)]),
        }
    }
}

/// What is wrong with `mount` now, if anything.
pub fn gone(v: &BookV3, mount: &TabMount) -> Option<Gone> {
    match mount {
        TabMount::Root => None,
        TabMount::Entry { entry } => match v.entry(entry) {
            Some(_) if v.has_below(entry) => None,
            Some(e) => Some(Gone::Closed(e.title.clone())),
            None => Some(match v.trashed_titles.get(entry) {
                Some(name) => Gone::Trashed(name.clone()),
                None => Gone::Missing,
            }),
        },
        TabMount::View { view } => match v.timeline_views.iter().find(|tv| &tv.id == view) {
            Some(tv) if tv.deleted_at.is_none() => None,
            Some(tv) => Some(Gone::ViewDeleted(tv.name.clone())),
            None => Some(Gone::Missing),
        },
        TabMount::Book => v.project.book.is_none().then_some(Gone::BookOff),
    }
}

/// The name of what `mount` is mounted on: what the 「⋯」 list says in
/// grey after a Tab's name, and what a new Tab is called.
pub fn mount_name(v: &BookV3, mount: &TabMount, cx: &App) -> SharedString {
    match mount {
        TabMount::Root => t(cx, keys::v3_shell::OUTERMOST),
        TabMount::Entry { entry } => v
            .entry(entry)
            .map(|e| e.title.clone())
            .or_else(|| v.trashed_titles.get(entry).cloned())
            .unwrap_or_default()
            .into(),
        TabMount::View { view } => v
            .timeline_views
            .iter()
            .find(|tv| &tv.id == view)
            .map(|tv| tv.name.clone())
            .unwrap_or_default()
            .into(),
        TabMount::Book => t(cx, keys::v3_tabs::BOOK),
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
fn entry_row(
    host: &PageViewHost,
    scope: &str,
    id: &str,
    depth: usize,
    lead: Option<SharedString>,
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
    let selected = workspace
        .as_ref()
        .is_some_and(|ws| ws.read(cx).nav.is_selected(&target));
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
        Some(ws) => crate::workspace::page_hover_card(
            format!("v3-tab-{scope}-card-{id}"),
            cell,
            &target,
            &ws,
            Default::default(),
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
            value
                .downcast_ref::<EntryDrag>()
                .is_some_and(|drag| drag.matches(&can_page) && drag.entry != onto)
        })
        .drag_over::<EntryDrag>(move |style, _, _, _| style.border_b_1().border_color(line))
        .on_drop(move |drag: &EntryDrag, window, cx| {
            if !drag.matches(&page) || !drag.is_current(cx) {
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

/// Where `moving` goes on `view`'s scale to sit before or after `onto` in
/// `order` (the list as shown, along the scale).
fn scale_at(view: &TimelineView, order: &[String], moving: &str, onto: &str, after: bool) -> f64 {
    let at = |id: &str| view.placements.iter().find(|p| p.entry == id).map(|p| p.at);
    let rest: Vec<&String> = order.iter().filter(|id| *id != moving).collect();
    let end = view
        .placements
        .iter()
        .map(|p| p.at)
        .fold(f64::NEG_INFINITY, f64::max);
    let end = if end.is_finite() { end + 1.0 } else { 0.0 };
    let Some(ix) = rest.iter().position(|id| *id == onto) else {
        return end;
    };
    let here = at(onto).unwrap_or(end);
    let next = if after {
        rest.get(ix + 1).and_then(|id| at(id))
    } else {
        ix.checked_sub(1).and_then(|i| at(rest[i]))
    };
    match next {
        Some(next) if (next - here).abs() > f64::EPSILON => (here + next) / 2.0,
        _ if after => here + 1.0,
        _ => here - 1.0,
    }
}

/// Puts `moving` on `view`'s scale before or after `onto` in `order`.
fn place_on_scale(
    host: &PageViewHost,
    view: &str,
    order: &[String],
    moving: &str,
    onto: &str,
    after: bool,
    cx: &mut App,
) {
    let Some(v) = host.book.v3() else {
        return;
    };
    let Some(tv) = v.timeline_view(view) else {
        return;
    };
    let at = scale_at(tv, order, moving, onto, after);
    let span = tv
        .placements
        .iter()
        .find(|p| p.entry == moving)
        .and_then(|p| p.span);
    let input = json!({
        "book": host.book_id, "view": view, "entry": moving, "at": at, "span": span,
    });
    let mut guard = WritePreconditions {
        require_all: false,
        ..v.guard_for(&input)
    };
    guard
        .records
        .extend(v.shown_precondition(&RecordKey::timeline_view(view)));
    let lib = host.library.clone();
    let job = cx
        .background_executor()
        .spawn(async move { lib.call_guarded(&Actor::User, "timeline_view.place", input, guard) });
    let host = host.clone();
    cx.spawn(async move |cx| {
        if let Err(error) = job.await {
            log::warn!("placing on the scale failed: {error}");
            cx.update(|cx| toast_save_failed(&host, cx));
        }
    })
    .detach();
}

/// Moves `moving` to live beside `onto` (before or after it), in `onto`'s
/// folder: the folder's manual order, or its scale while it is in a view
/// (`entry.move` reads `index` against what it shows then).
pub fn move_beside(
    lib: &dr_workspace::Workspace,
    book: &str,
    moving: &str,
    onto: &str,
    after: bool,
) -> Result<(), WsError> {
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
    let views: Vec<TimelineView> = serde_json::from_value(
        lib.call(&Actor::User, "timeline_view.list", json!({ "book": book }))?["output"].clone(),
    )
    .map_err(|e| WsError::Internal(e.to_string()))?;
    let in_view = parent.as_deref().is_some_and(|p| {
        views
            .iter()
            .any(|tv| tv.deleted_at.is_none() && tv.lanes.iter().any(|l| l.entry == p))
    });
    let siblings: Vec<String> = match parent.as_deref() {
        Some(p) if in_view => lib.call(
            &Actor::User,
            "entry.get",
            json!({ "book": book, "id": p }),
        )?["output"]["below"]["children"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| c["id"].as_str().map(str::to_owned))
            .collect(),
        _ => list
            .iter()
            .filter(|e| e.parent == parent)
            .map(|e| e.id.clone())
            .collect(),
    };
    let index = siblings
        .iter()
        .filter(|id| *id != moving)
        .position(|id| id == onto)
        .ok_or_else(|| WsError::Invalid("the drop target is no longer a sibling".into()))?
        + usize::from(after);
    lib.call(
        &Actor::User,
        "entry.move",
        json!({ "book": book, "id": moving, "parent": parent, "index": index }),
    )?;
    Ok(())
}

/// Drops `moving` before or after `onto` in `lane`'s list in a Tab mounted
/// on the view `view`: a new place on the view's scale. Only within the
/// lane: the entry is on no other lane of the list it was dropped in.
pub fn drop_in_view(
    host: &PageViewHost,
    view: &str,
    lane: &str,
    moving: &str,
    onto: &str,
    after: bool,
    cx: &mut App,
) {
    let Some(v) = host.book.v3() else {
        return;
    };
    let Some(tv) = v.timeline_view(view) else {
        return;
    };
    let order = v.lane_entries(tv, lane);
    if !order.iter().any(|id| id == moving) || !order.iter().any(|id| id == onto) {
        return;
    }
    place_on_scale(host, view, &order, moving, onto, after, cx);
}

/// Drops `moving` before or after `onto` in a Tab mounted on the book: the
/// order at the book's start (the folders' manual order, or the scale when
/// it starts at a view or a lane).
pub fn drop_in_book(host: &PageViewHost, moving: &str, onto: &str, after: bool, cx: &mut App) {
    let Some(v) = host.book.v3() else {
        return;
    };
    match v.project.book.as_ref().map(|b| &b.root) {
        Some(BookRoot::View { view } | BookRoot::Lane { view, .. }) => {
            let order = v.book_entries();
            place_on_scale(host, view, &order, moving, onto, after, cx);
        }
        Some(BookRoot::Root | BookRoot::Entry { .. }) => {
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
        _ => {}
    }
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

/// A Tab mounted on a view: each lane (its mark and name), and under it the
/// lane's entries along the view's scale, an entry on two lanes under both.
/// Dragging an entry within a lane changes its place on the scale.
pub fn view_list(host: &PageViewHost, view: &str, window: &mut Window, cx: &mut App) -> AnyElement {
    let Some(v) = host.book.v3() else {
        return div().into_any_element();
    };
    let Some(tv) = v.timeline_view(view) else {
        return div().into_any_element();
    };
    let theme = Theme::of(window, cx);
    let mut list = scroll_list(&format!("v3-tab-view-{view}"));
    for lane in &tv.lanes {
        let Some(entry) = v.entry(&lane.entry) else {
            continue;
        };
        let (mark, color) = entry_target(&lane.entry)
            .map(|t| host.book.mark(&t))
            .unwrap_or((sand::Kind::Element, None));
        let open = entry_target(&lane.entry);
        let weak = host.workspace.clone();
        list = list.child(
            div()
                .id(SharedString::from(format!("v3-tab-lane-{}", lane.entry)))
                .role(gpui::Role::Button)
                .aria_label(entry.title.clone())
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .px_2()
                .pt_2()
                .pb_1()
                .cursor_pointer()
                .font_role(Role::Structure)
                .type_px(theme.scale.caption, theme.scale.line_caption)
                .text_color(theme.palette.muted().solid())
                .child(
                    KindMark::new(
                        SharedString::from(format!("v3-tab-lane-mark-{}", lane.entry)),
                        mark,
                    )
                    .when_some(color, |m, c| m.color(c)),
                )
                .child(entry.title.clone())
                .on_click(move |_, _, cx| {
                    if let (Some(ws), Some(target)) = (weak.upgrade(), open.clone()) {
                        ws.update(cx, |ws, cx| ws.open(target, Open::PREVIEW, cx));
                    }
                }),
        );
        let order = v.lane_entries(tv, &lane.entry);
        for id in &order {
            let host_ = host.clone();
            let view_ = view.to_owned();
            let lane_ = lane.entry.clone();
            let onto = id.clone();
            list = list.child(entry_row(
                host,
                &format!("view-{}", lane.entry),
                id,
                1,
                None,
                move |drag, after, _, cx| {
                    drop_in_view(&host_, &view_, &lane_, &drag.entry, &onto, after, cx);
                },
                window,
                cx,
            ));
        }
    }
    list.into_any_element()
}

/// A Tab mounted on the book: the book sequence, one entry a row, its
/// number first. Dragging changes the order at the book's start: the
/// folders' manual order, or the scale when it starts at a view.
pub fn book_list(host: &PageViewHost, window: &mut Window, cx: &mut App) -> AnyElement {
    let Some(v) = host.book.v3() else {
        return div().into_any_element();
    };
    let order = v.book_entries();
    let mut list = scroll_list("v3-tab-book");
    for id in &order {
        let number = v
            .manuscript_number(id)
            .map(|n| SharedString::from(n.to_string()));
        let host_ = host.clone();
        let onto = id.clone();
        list = list.child(entry_row(
            host,
            "book",
            id,
            0,
            Some(number.unwrap_or_default()),
            move |drag, after, _, cx| drop_in_book(&host_, &drag.entry, &onto, after, cx),
            window,
            cx,
        ));
    }
    list.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::scale_at;
    use dr_workspace::commands::v3::types::{TimelinePlacement, TimelineView};

    fn view(ats: &[(&str, f64)]) -> TimelineView {
        TimelineView {
            id: "v".into(),
            name: "v".into(),
            pos: None,
            lanes: vec![],
            placements: ats
                .iter()
                .map(|(e, at)| TimelinePlacement {
                    entry: (*e).into(),
                    at: *at,
                    span: None,
                })
                .collect(),
            pins: vec![],
            deleted_at: None,
        }
    }

    #[test]
    fn a_dropped_entry_lands_between_its_new_neighbours_on_the_scale() {
        let tv = view(&[("a", 1.0), ("b", 2.0), ("c", 3.0)]);
        let order: Vec<String> = ["a", "b", "c"].map(String::from).to_vec();
        // c before b: between a and b.
        assert_eq!(scale_at(&tv, &order, "c", "b", false), 1.5);
        // a after c: past the end.
        assert_eq!(scale_at(&tv, &order, "a", "c", true), 4.0);
        // c before a: before the start.
        assert_eq!(scale_at(&tv, &order, "c", "a", false), 0.0);
        // a after b: between b and c.
        assert_eq!(scale_at(&tv, &order, "a", "b", true), 2.5);
    }
}
