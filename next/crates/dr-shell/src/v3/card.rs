//! The shared entry card. Operation pickers are supplied by G2; callers may
//! add their own rows without replacing the common header or danger boundary.
use crate::{
    nav::{Open, Target},
    pages::{CardRows, PageMenuHost, PageMenuItem, RunRow},
    strings::t,
};
use dr_i18n::keys;
use dr_ui::{
    components::{CardAction, CardBody, CardKeys, menu::RowIcon},
    sand::Icon,
};
use gpui::{prelude::*, *};
use std::rc::Rc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum EntryAction {
    /// A new entry living under the entry (or beside it, when nothing can
    /// live under it).
    New,
    ChangeTemplate,
    BelongTo,
    /// A new entry attached to the entry (`entry.create` with `host`): the
    /// 「新建」 of an entry page's 「挂在这里的条目」 (`kernel-v5.md` §16
    /// 「新建」). Not on the card.
    NewAttached,
}

pub struct Row {
    pub id: SharedString,
    pub label: SharedString,
    pub icon: RowIcon,
    pub danger: bool,
    pub checked: bool,
    /// None means the owning group has no handler for this entry yet.
    pub run: Option<RunRow>,
    /// A switch that goes nowhere (「层级」): run from the keyboard, the
    /// card stays open with the keyboard on it, its tick turned at once
    /// (KB, `kernel-v5.md` §15 item 48). Every other row closes the card.
    pub stays_open: bool,
}
/// The rows that are switches the card stays open for (KB): only 「层级」
/// (`dr-view-elements`' `entry-toggle-level`).
pub const STAYS_OPEN: &[&str] = &["entry-toggle-level"];
/// The row that puts the entry into Recently Deleted.
pub const TRASH: &str = "entry-trash";
impl From<PageMenuItem> for Row {
    fn from(row: PageMenuItem) -> Self {
        let stays_open = STAYS_OPEN.contains(&row.id.as_ref());
        Self {
            id: row.id,
            label: row.label,
            icon: row.icon,
            danger: row.danger,
            checked: row.checked,
            run: Some(row.run),
            stays_open,
        }
    }
}
fn open(host: &PageMenuHost, target: Target) -> RunRow {
    let weak = host.workspace.clone();
    let book = host.book_id.clone();
    Rc::new(move |_, cx| {
        if let Some(ws) = weak.upgrade() {
            ws.update(cx, |ws, cx| {
                if ws.book_id == book && ws.book.exists(&target) {
                    ws.open(target.clone(), Open::KEEP, cx);
                }
            });
        }
    })
}
/// Common rows, with the registered and per-surface extensions. Danger rows
/// always come last; the author sees each common action exactly once.
pub fn rows(target: &Target, host: &PageMenuHost, extra: &CardRows, cx: &App) -> Vec<Row> {
    let Target::Entry { id, .. } = target else {
        return Vec::new();
    };
    let Some(v) = host.book.v3().filter(|v| v.entry(id.as_str()).is_some()) else {
        return Vec::new();
    };
    let row = |id: &str, label, icon: Icon, run| Row {
        id: id.to_owned().into(),
        label: t(cx, label),
        icon: icon.into(),
        danger: false,
        checked: false,
        run,
        stays_open: false,
    };
    let mut extensions = super::entry_card_rows(target, host, cx);
    extensions.lead.extend(extra.lead.clone());
    extensions.before_danger.extend(extra.before_danger.clone());
    let mut out: Vec<Row> = extensions
        .lead
        .into_iter()
        .flat_map(|s| s.items)
        .map(Into::into)
        .collect();
    out.push(row(
        "entry-open",
        keys::v3_shell::OPEN,
        Icon::ArrowIn,
        Some(open(host, target.clone())),
    ));
    if v.entry(id.as_str()).is_some_and(|e| e.level) {
        out.push(row(
            "entry-open-book",
            keys::v3_shell::BOOK_VIEW,
            Icon::OpenBook,
            Some(open(host, Target::Book(id.clone()))),
        ));
    }
    out.push(row(
        "entry-new",
        keys::v3_shell::NEW_ENTRY,
        Icon::Plus,
        super::entry_action(EntryAction::New, target, host, cx),
    ));
    let edit = v
        .template_of(id.as_str())
        .and_then(|t| t.id.parse().ok())
        .map(|id| open(host, Target::Template(id)));
    out.push(row(
        "entry-edit-template",
        keys::v3_shell::EDIT_TEMPLATE,
        Icon::Edit,
        edit,
    ));
    out.push(row(
        "entry-change-template",
        keys::v3_shell::CHANGE_TEMPLATE,
        Icon::Swap,
        super::entry_action(EntryAction::ChangeTemplate, target, host, cx),
    ));
    out.push(row(
        "entry-belong-to",
        keys::v3_shell::BELONG_TO,
        Icon::Folder,
        super::entry_action(EntryAction::BelongTo, target, host, cx),
    ));
    out.extend(
        extensions
            .before_danger
            .into_iter()
            .flat_map(|s| s.items)
            .map(Row::from),
    );
    let (weak, book, id) = (host.workspace.clone(), host.book_id.clone(), id.to_string());
    let trash: RunRow = Rc::new(move |_, cx| {
        if let Some(ws) = weak.upgrade() {
            ws.update(cx, |ws, cx| {
                if ws.book_id == book && ws.book.v3().is_some_and(|v| v.entry(&id).is_some()) {
                    ws.run_command("entry.trash", serde_json::json!({"book":book,"id":id}), cx);
                }
            });
        }
    });
    let mut trash = row(TRASH, keys::v3_shell::TRASH, Icon::Trash, Some(trash));
    trash.danger = true;
    out.push(trash);
    out.sort_by_key(|r| r.danger);
    out
}

pub fn body(
    id: &str,
    target: &Target,
    host: &PageMenuHost,
    extra: &CardRows,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    body_keyed(id, target, host, extra, None, window, cx)
}

/// [`body`], its rows walked by the keyboard when `keys` is given (KB): they
/// are lit by it, in [`rows`]' order, and a row that does nothing is passed
/// over.
pub fn body_keyed(
    id: &str,
    target: &Target,
    host: &PageMenuHost,
    extra: &CardRows,
    keys: Option<&Entity<CardKeys>>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let (mark, color) = host.book.mark(target);
    let mut body = CardBody::new(
        SharedString::from(format!("{id}-body")),
        host.book.title(target).unwrap_or_default().to_owned(),
    )
    .mark(mark, color);
    let all = rows(target, host, extra, cx);
    if let Some(keys) = keys {
        let stops = all.iter().map(|r| r.run.is_some()).collect();
        keys.update(cx, |k, _| k.set_stops(stops));
    }
    for danger in [false, true] {
        let section: Vec<_> = all
            .iter()
            .enumerate()
            .filter(|(_, r)| r.danger == danger)
            .map(|(index, row)| {
                let mut action = CardAction::new(
                    SharedString::from(format!("{id}-{}", row.id)),
                    row.icon,
                    row.label.clone(),
                )
                .current(row.checked);
                if let Some(keys) = keys {
                    action = action.keys(keys, index);
                }
                if danger {
                    action = action.danger();
                }
                if let Some(run) = &row.run {
                    let run = run.clone();
                    action
                        .on_click(move |_, window, cx| run(window, cx))
                        .into_any_element()
                } else {
                    div().opacity(0.4).child(action).into_any_element()
                }
            })
            .collect();
        if !section.is_empty() {
            body = body.section(section);
        }
    }
    let _ = window;
    body.into_any_element()
}
