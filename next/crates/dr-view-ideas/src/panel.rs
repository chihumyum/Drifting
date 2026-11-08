//! The left sidebar's 构想 panel (the 0.1 client's `leftBars/DriftPanel`
//! and the drift half of `LeftSidebarSubHeader`).

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use dr_i18n::keys;
use dr_i18n::keys::left_sidebar as ls;
use dr_shell::book::{Book, color_of};
use dr_shell::nav::{Open, Target};
use dr_shell::pages::{PageMenuItem, PageMenuSection};
use dr_shell::strings::{t, tf, tp};
use dr_shell::{Services, Workspace};
use dr_ui::Theme;
use dr_ui::components::menu::RowIcon;
use dr_ui::components::{
    CardAction, CardBody, HoverCard, IconButton, Menu, MenuItem, SandCell,
    overlay::{self, Align, Layer, Place},
};
use dr_ui::fonts::Role;
use dr_ui::input::{FieldEvent, TextField};
use dr_ui::sand::{self, Icon};
use dr_ui::style::DrStyled as _;
use dr_ui::tokens::Rgb;
use dr_workspace::dto::{GroupInfo, IdeaInfo};
use dr_workspace::{Workspace as Library, WsError};
use gpui::{
    AnyElement, App, AppContext as _, Bounds, ClickEvent, Context, ElementId, Entity,
    Focusable as _, InteractiveElement as _, IntoElement, ParentElement as _, Pixels, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Task, WeakEntity,
    Window, div, prelude::FluentBuilder as _, px,
};

use crate::data;
use crate::model::{self, Meta, NEW_GROUP_NAME, Node, Sort, Tree};

/// Below this width a row's date and words are left out (0.1:
/// `META_HIDE_WIDTH`), so the title keeps its room.
const META_HIDE_WIDTH: f32 = 200.0;
/// Each level of nesting moves a row this far right (0.1: `INDENT_STEP`).
const INDENT: f32 = 14.0;

/// The panel's list.
pub struct IdeaPanel {
    ws: WeakEntity<Workspace>,
    lib: Option<Library>,
    book: Rc<Book>,
    pub sort: Sort,
    pub meta: Meta,
    /// Folded groups (their ids). Not kept between runs, as in 0.1.
    pub collapsed: HashSet<String>,
    pub sort_open: bool,
    /// A group being renamed, and its field.
    renaming: Option<(String, Entity<TextField>)>,
    /// Each idea's last stored change (ms) and words, for the rows.
    updated: HashMap<String, i64>,
    words: HashMap<String, u64>,
    read_for: Option<Rc<Book>>,
    task: Option<Task<()>>,
    /// Writes not back yet (tests).
    writing: usize,
    /// A group whose card is held open (captures), or, `false`, held shut
    /// for one frame after it was let go.
    card: Option<(String, bool)>,
    bounds: Option<Entity<Option<Bounds<Pixels>>>>,
    _subs: Vec<Subscription>,
}

impl IdeaPanel {
    pub fn new(ws: WeakEntity<Workspace>, cx: &mut Context<Self>) -> IdeaPanel {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        cx.spawn(async move |this, cx| this.update(cx, |p, cx| p.follow(cx)).ok())
            .detach();
        IdeaPanel {
            ws,
            lib,
            book: Rc::default(),
            sort: Sort::default(),
            meta: Meta::default(),
            collapsed: HashSet::new(),
            sort_open: false,
            renaming: None,
            updated: HashMap::new(),
            words: HashMap::new(),
            read_for: None,
            task: None,
            writing: 0,
            card: None,
            bounds: None,
            _subs: Vec::new(),
        }
    }

    fn follow(&mut self, cx: &mut Context<Self>) {
        let Some(ws) = self.ws.upgrade() else {
            return;
        };
        self.book = ws.read(cx).book.clone();
        // Any change of the workspace may move the selection; a new book
        // snapshot changes the lists.
        self._subs.push(cx.observe(&ws, |p, ws, cx| {
            p.book = ws.read(cx).book.clone();
            cx.notify();
        }));
        cx.notify();
    }

    /// The tree as drawn now.
    pub fn tree(&self) -> Tree {
        model::tree(
            &self.book.idea_groups,
            &self.book.ideas,
            self.sort,
            &self.updated,
        )
    }

    /// The book's live ideas.
    pub fn idea_count(&self) -> usize {
        self.book.ideas.iter().filter(|i| !i.trashed).count()
    }

    /// Nothing written is still on its way, and the rows' readouts are read.
    pub fn is_settled(&self) -> bool {
        self.writing == 0 && self.task.is_none()
    }

    /// Holds group `id`'s card open (`None`: back to the pointer), for
    /// captures and the debug bridge.
    pub fn show_card(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        self.card = match (id, self.card.take()) {
            (Some(id), _) => Some((id, true)),
            (None, Some((was, _))) => Some((was, false)),
            (None, None) => None,
        };
        cx.notify();
    }

    pub fn renaming(&self) -> Option<(&str, Entity<TextField>)> {
        self.renaming
            .as_ref()
            .map(|(id, f)| (id.as_str(), f.clone()))
    }

    pub fn toggle(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.collapsed.remove(id) {
            self.collapsed.insert(id.to_owned());
        }
        cx.notify();
    }

    /// 展开／折叠全部: folds every group, or opens them all when any is
    /// folded (0.1: one press, like a folding fan).
    pub fn toggle_all(&mut self, cx: &mut Context<Self>) {
        if self.collapsed.is_empty() {
            self.collapsed = self.tree().group_ids().into_iter().collect();
        } else {
            self.collapsed.clear();
        }
        cx.notify();
    }

    pub fn set_sort(&mut self, sort: Sort, cx: &mut Context<Self>) {
        self.sort = sort;
        self.sort_open = false;
        cx.notify();
    }

    pub fn set_meta(&mut self, meta: Meta, cx: &mut Context<Self>) {
        self.meta = meta;
        self.sort_open = false;
        cx.notify();
    }

    fn open(&self, target: Target, how: Open, cx: &mut App) {
        self.ws.update(cx, |ws, cx| ws.open(target, how, cx)).ok();
    }

    /// Runs `f` off the main thread; `then` gets its answer back here.
    fn write<T: Send + 'static>(
        &mut self,
        what: &'static str,
        f: impl FnOnce(&Library, &str) -> Result<T, WsError> + Send + 'static,
        then: impl FnOnce(&mut IdeaPanel, T, &mut Context<IdeaPanel>) + 'static,
        cx: &mut Context<Self>,
    ) {
        let (Some(lib), false) = (self.lib.clone(), self.book.is_empty()) else {
            return;
        };
        let book = self.book.id.clone();
        self.writing += 1;
        let task = cx.background_spawn(async move { f(&lib, &book) });
        cx.spawn(async move |this, cx| {
            let done = task.await;
            this.update(cx, |p, cx| {
                p.writing -= 1;
                match done {
                    Ok(v) => then(p, v, cx),
                    Err(error) => log::warn!("{what} failed: {error}"),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// 「新构想」 (at the top level) or 「在此新建构想」 (in `group`): made,
    /// opened as a tab of its own, its group unfolded.
    pub fn new_idea(&mut self, group: Option<String>, cx: &mut Context<Self>) {
        let title = t(cx, ls::actions::NEW_DRIFT).to_string();
        if let Some(g) = &group {
            self.collapsed.remove(g);
        }
        self.write(
            "making an idea",
            move |lib, book| data::create_idea(lib, book, &title, group.as_deref()),
            |p, id, cx| {
                if let Ok(id) = id.parse() {
                    p.open(Target::Idea(id), Open::KEEP, cx);
                }
            },
            cx,
        );
    }

    /// 「新建分组」 (at the top level) or 「新建子分组」 (under `parent`),
    /// named 新分组 as in 0.1; its parent unfolded.
    pub fn new_group(&mut self, parent: Option<String>, cx: &mut Context<Self>) {
        if let Some(p) = &parent {
            self.collapsed.remove(p);
        }
        self.write(
            "making an idea group",
            move |lib, book| data::create_group(lib, book, NEW_GROUP_NAME, parent.as_deref()),
            |_, _, _| {},
            cx,
        );
    }

    /// A double click on a group's head: rename it in place.
    pub fn start_rename(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(group) = self.book.idea_groups.iter().find(|g| g.id == id) else {
            return;
        };
        let field = cx.new(|cx| {
            TextField::new("idea-panel-group-rename", window, cx)
                .small()
                .with_text(group.name.clone())
        });
        let sub = cx.subscribe_in(&field, window, |p, field, e, _, cx| match e {
            FieldEvent::Submitted(_) | FieldEvent::Blurred => {
                let text = field.read(cx).text();
                p.finish_rename(Some(text), cx);
            }
            FieldEvent::Cancelled => p.finish_rename(None, cx),
            FieldEvent::Changed(_) => {}
        });
        self._subs.push(sub);
        field.update(cx, |f, cx| f.select_all_text(cx));
        field.focus_handle(cx).focus(window, cx);
        self.renaming = Some((id.to_owned(), field));
        cx.notify();
    }

    /// Ends renaming: `Some` stores the name (an empty one keeps 新分组, as
    /// 0.1; an unchanged one does nothing).
    pub fn finish_rename(&mut self, name: Option<String>, cx: &mut Context<Self>) {
        let Some((id, _)) = self.renaming.take() else {
            return;
        };
        cx.notify();
        let Some(name) = name.map(|n| n.trim().to_owned()) else {
            return;
        };
        let name = if name.is_empty() {
            NEW_GROUP_NAME.to_owned()
        } else {
            name
        };
        if self
            .book
            .idea_groups
            .iter()
            .any(|g| g.id == id && g.name == name)
        {
            return;
        }
        self.write(
            "renaming an idea group",
            move |lib, book| data::rename_group(lib, book, &id, &name),
            |_, _, _| {},
            cx,
        );
    }

    /// An idea into `group` (`None`: out of every group).
    pub fn move_idea(&mut self, id: &str, group: Option<String>, cx: &mut Context<Self>) {
        let id = id.to_owned();
        self.write(
            "moving an idea",
            move |lib, book| data::move_idea(lib, book, &id, group.as_deref()),
            |_, _, _| {},
            cx,
        );
    }

    /// A group under `parent` (`None`: the top level), where its levels fit.
    pub fn move_group(&mut self, id: &str, parent: Option<String>, cx: &mut Context<Self>) {
        if !model::can_move_group(&self.book.idea_groups, id, parent.as_deref()) {
            return;
        }
        let id = id.to_owned();
        self.write(
            "moving an idea group",
            move |lib, book| data::move_group(lib, book, &id, parent.as_deref()),
            |_, _, _| {},
            cx,
        );
    }

    /// 「删除分组」: its sub-groups and ideas move up to its parent (F3; 0.1
    /// did the same, without asking: nothing is lost, and ⌘Z brings it back).
    pub fn delete_group(&mut self, id: &str, cx: &mut Context<Self>) {
        let id = id.to_owned();
        self.collapsed.remove(&id);
        self.write(
            "deleting an idea group",
            move |lib, book| data::delete_group(lib, book, &id),
            |_, _, _| {},
            cx,
        );
    }

    /// Reads each idea's last stored change and words off the main thread.
    fn read_meta(&mut self, cx: &mut Context<Self>) {
        let fresh = self
            .read_for
            .as_ref()
            .is_some_and(|b| Rc::ptr_eq(b, &self.book));
        if fresh || self.task.is_some() || self.book.is_empty() {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let book = self.book.clone();
        let ids: Vec<String> = book.ideas.iter().map(|i| i.id.clone()).collect();
        self.task = Some(cx.spawn(async move |this, cx| {
            let (updated, words) = cx
                .background_executor()
                .spawn(async move {
                    let store = lib.library();
                    let mut updated = HashMap::new();
                    let mut words = HashMap::new();
                    for id in ids {
                        let doc = format!("node:{id}");
                        if let Some(head) = store.head(&doc).ok().flatten() {
                            updated.insert(id.clone(), head.ts);
                        }
                        if let Some(stats) = store.doc_stats(&doc).ok().flatten() {
                            words.insert(id, stats.words);
                        }
                    }
                    (updated, words)
                })
                .await;
            this.update(cx, |p, cx| {
                p.task = None;
                p.updated = updated;
                p.words = words;
                p.read_for = Some(book);
                cx.notify();
            })
            .ok();
        }));
    }
}

/// Where group `id` can move, as hover-card rows: the top level, then each
/// group its levels fit under (its parent ticked).
fn move_rows(
    entity: &Entity<IdeaPanel>,
    tree: &Tree,
    groups: &[GroupInfo],
    id: &str,
    cx: &App,
) -> Vec<AnyElement> {
    let current = groups
        .iter()
        .find(|g| g.id == id)
        .and_then(|g| g.parent.clone());
    let choose = |target: Option<String>| {
        let (entity, id) = (entity.clone(), id.to_owned());
        move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
            let target = target.clone();
            entity.update(cx, |p, cx| p.move_group(&id, target, cx))
        }
    };
    let mut rows = vec![
        CardAction::new(
            SharedString::from(format!("idea-move-{id}-root")),
            Icon::FolderNone,
            t(cx, ls::groups::MOVE_GROUP_TO_ROOT),
        )
        .current(current.is_none())
        .on_click(choose(None))
        .into_any_element(),
    ];
    for g in model::flat(tree) {
        let here = current.as_deref() == Some(g.id.as_str());
        if !here && !model::can_move_group(groups, id, Some(&g.id)) {
            continue;
        }
        let mut row = CardAction::new(
            SharedString::from(format!("idea-move-{id}-{}", g.id)),
            RowIcon::Mark(
                sand::Kind::DriftGroup,
                g.color.as_deref().and_then(color_of),
            ),
            model::path(groups, g),
        )
        .current(here);
        if !here {
            row = row.on_click(choose(Some(g.id.clone())));
        }
        rows.push(row.into_any_element());
    }
    rows
}

/// What an idea's hover card adds to the shell's (its page card and ⋯
/// rows): 移动到分组, when the book has groups (0.1 left it out otherwise).
pub(crate) fn idea_move_section(
    book: &Book,
    idea: &IdeaInfo,
    run: impl Fn(Option<String>) -> dr_shell::pages::RunRow,
    cx: &App,
) -> Option<PageMenuSection> {
    if book.idea_groups.is_empty() {
        return None;
    }
    let tree = model::tree(
        &book.idea_groups,
        &book.ideas,
        Sort::Created,
        &HashMap::new(),
    );
    let mut items = vec![PageMenuItem {
        id: format!("idea-move-{}-root", idea.id).into(),
        icon: Icon::FolderNone.into(),
        label: t(cx, ls::groups::MOVE_DRIFT_TO_ROOT),
        checked: idea.group.is_none(),
        danger: false,
        run: run(None),
    }];
    for g in model::flat(&tree) {
        items.push(PageMenuItem {
            id: format!("idea-move-{}-{}", idea.id, g.id).into(),
            icon: RowIcon::Mark(
                sand::Kind::DriftGroup,
                g.color.as_deref().and_then(color_of),
            ),
            label: model::path(&book.idea_groups, g).into(),
            checked: idea.group.as_deref() == Some(g.id.as_str()),
            danger: false,
            run: run(Some(g.id.clone())),
        });
    }
    Some(PageMenuSection {
        title: Some(t(cx, keys::editor_top_bar::menu::MOVE_TO_GROUP)),
        items,
    })
}

impl IdeaPanel {
    fn group_card(
        &self,
        entity: &Entity<IdeaPanel>,
        node: &Node,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let _ = window;
        let tree = self.tree();
        let groups = self.book.idea_groups.clone();
        let g = &node.group;
        let id = g.id.clone();
        let color = g.color.as_deref().and_then(color_of);
        let mut body = CardBody::new(
            SharedString::from(format!("idea-group-card-{id}")),
            g.name.clone(),
        )
        .mark(sand::Kind::DriftGroup, color)
        .count(tp(
            cx,
            ls::groups::DRIFT_COUNT,
            node.count as u64,
            &[("count", &node.count)],
        ));
        let on = |f: fn(&mut IdeaPanel, &str, &mut Window, &mut Context<IdeaPanel>)| {
            let (entity, id) = (entity.clone(), id.clone());
            move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                entity.update(cx, |p, cx| f(p, &id, window, cx))
            }
        };
        let mut create = Vec::new();
        if model::can_nest_under(&groups, &id) {
            create.push(
                CardAction::new(
                    SharedString::from(format!("idea-group-sub-{id}")),
                    Icon::FolderPlus,
                    t(cx, ls::groups::NEW_SUB_GROUP),
                )
                .on_click(on(|p, id, _, cx| p.new_group(Some(id.to_owned()), cx)))
                .into_any_element(),
            );
        }
        create.push(
            CardAction::new(
                SharedString::from(format!("idea-group-new-{id}")),
                Icon::Plus,
                t(cx, ls::groups::NEW_DRIFT_IN_GROUP),
            )
            .on_click(on(|p, id, _, cx| p.new_idea(Some(id.to_owned()), cx)))
            .into_any_element(),
        );
        body = body.section(create);
        body = body.section(vec![
            CardAction::new(
                SharedString::from(format!("idea-group-rename-{id}")),
                Icon::Edit,
                t(cx, ls::groups::RENAME),
            )
            .on_click(on(|p, id, window, cx| p.start_rename(id, window, cx)))
            .into_any_element(),
        ]);
        // The move choices, when one of them is possible.
        let rows = move_rows(entity, &tree, &groups, &id, cx);
        let can_move = groups.iter().any(|x| {
            x.id != id
                && g.parent.as_deref() != Some(x.id.as_str())
                && model::can_move_group(&groups, &id, Some(&x.id))
        }) || g.parent.is_some();
        if can_move {
            body = body.section(rows);
        }
        body = body.section(vec![
            CardAction::new(
                SharedString::from(format!("idea-group-delete-{id}")),
                Icon::Trash,
                t(cx, ls::groups::DELETE_GROUP),
            )
            .danger()
            .on_click(on(|p, id, _, cx| p.delete_group(id, cx)))
            .into_any_element(),
        ]);
        body.into_any_element()
    }

    fn group_head(
        &self,
        entity: &Entity<IdeaPanel>,
        node: &Node,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let g = &node.group;
        let id: SharedString = format!("idea-panel-group-{}", g.id).into();
        let indent = node.depth as f32 * INDENT;
        if let Some((renaming, field)) = &self.renaming
            && *renaming == g.id
        {
            return div()
                .pl(px(14.0 + indent))
                .pr(px(12.0))
                .py(px(2.0))
                .child(field.clone())
                .into_any_element();
        }
        let collapsed = self.collapsed.contains(&g.id);
        let click = {
            let (entity, gid) = (entity.clone(), g.id.clone());
            move |e: &ClickEvent, window: &mut Window, cx: &mut App| {
                if e.click_count() > 1 {
                    entity.update(cx, |p, cx| p.start_rename(&gid, window, cx));
                } else {
                    entity.update(cx, |p, cx| p.toggle(&gid, cx));
                }
            }
        };
        let add = {
            let (entity, gid) = (entity.clone(), g.id.clone());
            IconButton::new(SharedString::from(format!("{id}-add")), Icon::Plus)
                .label(t(cx, ls::groups::NEW_DRIFT_IN_GROUP))
                .on_click(move |_, _, cx| {
                    entity.update(cx, |p, cx| p.new_idea(Some(gid.clone()), cx))
                })
        };
        let chevron = sand::icon(
            if collapsed {
                Icon::ChevronRight
            } else {
                Icon::ChevronDown
            },
            if node.depth == 0 { 11.0 } else { 9.0 },
            p.ink(3).solid(),
        );
        let count = format!("· {}", node.count);
        let head = if node.depth == 0 {
            // A top-level group: chevron, the folder in its colour, the name
            // in the structure face, the count; + and a sub-group's folder
            // under the pointer.
            let color = g.color.as_deref().and_then(color_of).unwrap_or(p.ink(4));
            let sub = model::can_nest_under(&self.book.idea_groups, &g.id).then(|| {
                let (entity, gid) = (entity.clone(), g.id.clone());
                IconButton::new(SharedString::from(format!("{id}-sub")), Icon::FolderPlus)
                    .label(t(cx, ls::groups::NEW_SUB_GROUP))
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |p, cx| p.new_group(Some(gid.clone()), cx))
                    })
            });
            div()
                .id(ElementId::Name(id.clone()))
                .group(id.clone())
                .pl(px(14.0 + indent))
                .pr(px(12.0))
                .py(px(4.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .cursor_pointer()
                .role(gpui::Role::Button)
                .aria_label(g.name.clone())
                .on_click(click)
                .child(chevron)
                .child(sand::icon(Icon::Folder, 11.0, color.solid()))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_role(Role::Structure)
                        .type_px(s.body, s.line_body)
                        .text_color(p.ink(2).solid())
                        .child(g.name.clone()),
                )
                .child(
                    div()
                        .flex_none()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.ink(4).solid())
                        .child(count),
                )
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .flex_row()
                        .invisible()
                        .group_hover(id.clone(), |st| st.visible())
                        .children(sub)
                        .child(add),
                )
                .into_any_element()
        } else {
            // A sub-group: understated, index type, the same click.
            div()
                .id(ElementId::Name(id.clone()))
                .group(id.clone())
                .pl(px(22.0 + indent))
                .pr(px(10.0))
                .py(px(3.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .cursor_pointer()
                .role(gpui::Role::Button)
                .aria_label(g.name.clone())
                .font_role(Role::Index)
                .type_px(s.caption, s.caption * 1.2)
                .text_color(p.ink(4).solid())
                .on_click(click)
                .child(chevron)
                .child(div().min_w_0().truncate().child(g.name.clone()))
                .child(div().flex_none().child(count))
                .child(div().flex_1())
                .child(
                    div()
                        .flex_none()
                        .invisible()
                        .group_hover(id.clone(), |st| st.visible())
                        .child(add),
                )
                .into_any_element()
        };
        let card = {
            let (entity, node) = (entity.clone(), node.clone());
            move |window: &mut Window, cx: &mut App| {
                let panel = entity.read(cx);
                let _ = panel;
                entity
                    .clone()
                    .update(cx, |p, cx| p.group_card(&entity, &node, window, cx))
            }
        };
        let card =
            HoverCard::new(ElementId::Name(format!("{id}-card").into()), head, card).beside();
        match &self.card {
            Some((held, open)) if *held == g.id => card.force_open(*open).into_any_element(),
            _ => card.into_any_element(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn idea_row(
        &self,
        entity: &Entity<IdeaPanel>,
        ws: Option<&Entity<Workspace>>,
        idea: &IdeaInfo,
        depth: usize,
        color: Option<Rgb>,
        show_meta: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let Some(target) = idea.id.parse().ok().map(Target::Idea) else {
            return div().into_any_element();
        };
        let selected = ws.is_some_and(|ws| ws.read(cx).nav.is_selected(&target));
        let title: SharedString = if idea.title.trim().is_empty() {
            t(cx, keys::common::UNTITLED)
        } else {
            idea.title.clone().into()
        };
        let readout = (show_meta && self.meta != Meta::None).then(|| {
            let words = match self.words.get(&idea.id) {
                Some(n) => model::short_words(*n),
                None => t(cx, keys::common::COUNTING).to_string(),
            };
            let date = self
                .updated
                .get(&idea.id)
                .map(|ms| dr_view_elements::panel::short_date(*ms, crate::now_ms()))
                .unwrap_or_default();
            let text = match self.meta {
                Meta::Words => words,
                Meta::Both if !date.is_empty() => format!("{words} · {date}"),
                Meta::Both => words,
                _ => date,
            };
            div()
                .flex_none()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.muted().solid())
                .child(text)
        });
        let resting = idea.status == "resting";
        let open = {
            let (entity, target) = (entity.clone(), target.clone());
            move |e: &ClickEvent, _: &mut Window, cx: &mut App| {
                let how = if e.click_count() > 1 {
                    Open::KEEP
                } else {
                    Open::PREVIEW
                };
                let target = target.clone();
                entity.update(cx, |p, cx| p.open(target, how, cx));
            }
        };
        // An eddy in its group's colour; fainter when it floats free.
        let cell = SandCell::new(
            ElementId::Name(format!("idea-panel-row-{}", idea.id).into()),
            title,
        )
        .mark(sand::Kind::Drift {
            loose: idea.group.is_none(),
        })
        .color(color.unwrap_or(p.ink(3)))
        .selected(selected)
        .children(readout)
        .on_click(open);
        let row = div()
            .mx(px(6.0))
            .pl(px(depth as f32 * INDENT))
            // A resting idea sits in its place, muted (0.1 merged the old
            // rest drawer into the list this way).
            .when(resting && !selected, |el| el.opacity(0.7))
            .child(cell)
            .into_any_element();
        let Some(ws) = ws else {
            return row;
        };
        // The page's own rows (an idea's ⋯ menu, [`crate::menu`]) already
        // hold its status, 移动到分组 and 删除节点: nothing to add.
        dr_shell::workspace::page_hover_card(
            format!("idea-panel-row-card-{}", idea.id),
            row,
            &target,
            ws,
            dr_shell::pages::CardRows::default(),
            cx,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn group_body(
        &self,
        entity: &Entity<IdeaPanel>,
        ws: Option<&Entity<Workspace>>,
        node: &Node,
        show_meta: bool,
        out: &mut Vec<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) {
        out.push(self.group_head(entity, node, window, cx));
        if self.collapsed.contains(&node.group.id) {
            return;
        }
        for child in &node.children {
            self.group_body(entity, ws, child, show_meta, out, window, cx);
        }
        let color = node.group.color.as_deref().and_then(color_of);
        for idea in &node.ideas {
            out.push(self.idea_row(
                entity,
                ws,
                idea,
                node.depth + 1,
                color,
                show_meta,
                window,
                cx,
            ));
        }
    }
}

impl Render for IdeaPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.read_meta(cx);
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let bounds = overlay::use_bounds("idea-panel-bounds", window, cx);
        self.bounds = Some(bounds.clone());
        let width = bounds
            .read(cx)
            .map(|b| f32::from(b.size.width))
            .unwrap_or(260.0);
        let show_meta = width >= META_HIDE_WIDTH;
        let entity = cx.entity();
        let ws = self.ws.upgrade();
        let list = div()
            .id("idea-panel")
            .relative()
            .size_full()
            .overflow_y_scroll()
            .pt(px(6.0))
            .pb(px(12.0))
            .flex()
            .flex_col()
            .child(overlay::probe(bounds));
        if self.idea_count() == 0 && self.book.idea_groups.is_empty() {
            return list.child(
                div()
                    .p(px(16.0))
                    .font_role(Role::Ui)
                    .type_px(theme.scale.body, theme.scale.line_body)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, ls::empty::NO_DRIFTS)),
            );
        }
        let tree = self.tree();
        let mut rows = Vec::new();
        let release = matches!(self.card, Some((_, false)));
        for node in &tree.groups {
            self.group_body(&entity, ws.as_ref(), node, show_meta, &mut rows, window, cx);
        }
        for idea in &tree.loose {
            rows.push(self.idea_row(&entity, ws.as_ref(), idea, 0, None, show_meta, window, cx));
        }
        if release {
            // Shut this frame; the pointer has it again from the next.
            self.card = None;
        }
        list.children(rows)
    }
}

/// The panel's head row: 「N 条构想」, then 展开／折叠全部, the sort menu,
/// 新建分组 and 新构想.
pub struct PanelHead {
    pub panel: Entity<IdeaPanel>,
    _sub: Subscription,
}

impl PanelHead {
    pub fn new(panel: Entity<IdeaPanel>, cx: &mut Context<Self>) -> PanelHead {
        let sub = cx.observe(&panel, |_, _, cx| cx.notify());
        PanelHead { panel, _sub: sub }
    }
}

impl Render for PanelHead {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let panel = self.panel.read(cx);
        let (sort, meta, sort_open) = (panel.sort, panel.meta, panel.sort_open);
        let folded = !panel.collapsed.is_empty();
        let text = tf(cx, ls::meta::DRIFTS, &[("count", &panel.idea_count())]);
        let head_text = div()
            .flex_1()
            .min_w_0()
            .truncate()
            .font_role(Role::Index)
            .type_px(s.caption, s.line_caption)
            .text_color(p.muted().solid())
            .child(text);
        let all = {
            let panel = self.panel.clone();
            IconButton::new(
                "idea-panel-all",
                if folded {
                    Icon::FoldingFan
                } else {
                    Icon::FoldingFanClosed
                },
            )
            .label(t(cx, ls::actions::COLLAPSE_ALL))
            .on_click(move |_, _, cx| panel.update(cx, |p, cx| p.toggle_all(cx)))
        };
        let sort_bounds = overlay::use_bounds("idea-panel-sort-bounds", window, cx);
        let sort_button = {
            let panel = self.panel.clone();
            IconButton::new("idea-panel-sort", Icon::Sort)
                .label(t(cx, ls::actions::SORT))
                .selected(sort_open)
                .on_click(move |_, _, cx| {
                    panel.update(cx, |p, cx| {
                        p.sort_open = !p.sort_open;
                        cx.notify();
                    })
                })
        };
        let menu = match (sort_open, *sort_bounds.read(cx)) {
            (true, Some(anchor)) => Some(sort_menu(&self.panel, sort, meta, anchor, &theme, cx)),
            _ => None,
        };
        let new_group = {
            let panel = self.panel.clone();
            IconButton::new("idea-panel-new-group", Icon::FolderPlus)
                .label(t(cx, ls::actions::NEW_DRIFT_GROUP))
                .on_click(move |_, _, cx| panel.update(cx, |p, cx| p.new_group(None, cx)))
        };
        let new_idea = {
            let panel = self.panel.clone();
            IconButton::new("idea-panel-new-idea", Icon::Plus)
                .label(t(cx, ls::actions::NEW_DRIFT))
                .on_click(move |_, _, cx| panel.update(cx, |p, cx| p.new_idea(None, cx)))
        };
        div()
            .size_full()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(2.0))
            .child(head_text)
            .child(all)
            .child(
                div()
                    .relative()
                    .child(overlay::probe(sort_bounds))
                    .child(sort_button),
            )
            .children(menu)
            .child(new_group)
            .child(new_idea)
    }
}

/// 排序构想 (by time made, time changed, title) and 单元格右侧 (date, words,
/// both, neither).
fn sort_menu(
    panel: &Entity<IdeaPanel>,
    sort: Sort,
    meta: Meta,
    anchor: Bounds<Pixels>,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    use ls::sort as k;
    let by = |id: &'static str, icon: Icon, label, value: Sort| {
        let panel = panel.clone();
        MenuItem::new(id, icon, t(cx, label))
            .checked(value == sort)
            .on_click(move |_, _, cx| panel.update(cx, |p, cx| p.set_sort(value, cx)))
    };
    let shows = |id: &'static str, icon: Icon, label, value: Meta| {
        let panel = panel.clone();
        MenuItem::new(id, icon, t(cx, label))
            .checked(value == meta)
            .on_click(move |_, _, cx| panel.update(cx, |p, cx| p.set_meta(value, cx)))
    };
    let menu = Menu::new("idea-sort-menu")
        .section(t(cx, k::DRIFTS), theme)
        .item(by(
            "idea-sort-created",
            Icon::Sprout,
            k::CREATED_AT,
            Sort::Created,
        ))
        .item(by(
            "idea-sort-updated",
            Icon::BrushWriting,
            k::UPDATED_AT,
            Sort::Updated,
        ))
        .item(by(
            "idea-sort-title",
            Icon::AlphaDown,
            k::TITLE,
            Sort::Title,
        ))
        .separator(theme)
        .section(t(cx, k::CELL_META_GROUP), theme)
        .item(shows("idea-meta-date", Icon::Ri, k::SHOW_DATE, Meta::Date))
        .item(shows(
            "idea-meta-words",
            Icon::Zi,
            k::SHOW_WORD_COUNT,
            Meta::Words,
        ))
        .item(shows(
            "idea-meta-both",
            Icon::ZiRi,
            k::SHOW_BOTH,
            Meta::Both,
        ))
        .item(shows("idea-meta-none", Icon::Wu, k::SHOW_NONE, Meta::None));
    let dismiss = panel.clone();
    overlay::float(
        Place::Rect {
            rect: anchor,
            align: Align::End,
            gap: 6.0,
        },
        Layer::Popover,
        div()
            .id("idea-sort-float")
            .occlude()
            .on_mouse_down_out(move |e, _, cx| {
                if anchor.contains(&e.position) {
                    return;
                }
                dismiss.update(cx, |p, cx| {
                    p.sort_open = false;
                    cx.notify();
                })
            })
            .child(menu),
    )
    .into_any_element()
}
