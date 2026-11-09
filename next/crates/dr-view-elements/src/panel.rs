//! The left sidebar's elements panel (the 0.1 client's `ElementPanel`):
//! the book's elements by category, as a compact index or a name list.
//!
//! - **Head**: 「3 类 · 24 要素」, which switches compact ⇄ list; then the
//!   element overview (要素全景), expand / collapse all, the sort menu
//!   (elements within a category, and the categories themselves:
//!   alphabetically or newest first) and 「新类目」.
//! - **Order**: categories alphabetically (a category named exactly
//!   `others` last) or newest first; 未分类 at the end when some element has
//!   no category. In a category, its named groups first (alphabetically),
//!   then the ungrouped elements; elements alphabetically (numbers by value)
//!   or newest first. Ids are UUID v7 in both clients, so their order is the
//!   order they were made in.
//! - **Name list**: a category's head (disclosure, mark, name in the
//!   structure face, 「· N」, a + under the pointer); its elements as cells
//!   with the last change's date (hidden below 200 px); a named group's head
//!   (a tick, the name, 「· N」, a + under the pointer; a double click
//!   renames the group on all its elements).
//! - **Compact index**: each category inside a brush frame in its colour,
//!   its name on a plate cut into the frame; the elements as tiles that
//!   flow and wrap, each as wide as its name wants (80–172 px); a named
//!   group in a hairline box. A collapsed category's frame fades.
//! - A click on an element or a category previews it, a double click keeps
//!   it. A category's + opens 「新建要素」 / 「新建分组…」 (a name, then
//!   「创建并打开首个要素」).
//!
//! The panel is two views: [`ElementPanel`] (the list) and [`PanelHead`]
//! (the head row). The shell hosts them once it has a place for a module's
//! panel (m11-elements.md, 「待协调」 F6).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use chrono::{Datelike as _, TimeZone as _};
use dr_i18n::keys;
use dr_shell::book::{Book, color_of};
use dr_shell::nav::{Open, Target};
use dr_shell::strings::tf;
use dr_shell::workspace::SuperView;
use dr_shell::{Services, Workspace, t};
use dr_ui::{
    Theme,
    components::{
        Button, IconButton, Layer, Menu, MenuItem, SandCell,
        overlay::{self, Align, Place},
    },
    fonts::Role,
    glass::{self, Kind as GlassKind, Mode, Spec, Tone},
    input::field::{FieldEvent, TextField},
    sand::{self, Icon, KindMark, SandFrame},
    style::DrStyled,
    tokens::{Rgb, radius},
};
use dr_workspace::{
    Actor, Workspace as Library,
    commands::element::{CategoryCreate, CategoryCreateIn, ElementCreate, ElementCreateIn},
    dto::{CategoryInfo, ElementInfo},
};
use gpui::{
    AnyElement, App, AppContext as _, Bounds, ClickEvent, Context, ElementId, Entity,
    Focusable as _, InteractiveElement as _, IntoElement, ParentElement as _, Pixels, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Task, WeakEntity,
    Window, div, prelude::FluentBuilder as _, px,
};

use crate::data;

/// The key of the 未分类 bucket.
pub const UNCATEGORIZED: &str = "uncategorized";

/// How the panel lists the elements (the 0.1 default is compact).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum View {
    #[default]
    Compact,
    List,
}

/// An order (the 0.1 default is alphabetical, for both levels).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Sort {
    #[default]
    Alphabet,
    /// Newest first.
    Created,
}

/// One category (or 未分类) as the panel lists it.
#[derive(Clone, Debug)]
pub struct Section {
    /// The category's id, or [`UNCATEGORIZED`].
    pub key: String,
    pub category: Option<CategoryInfo>,
    /// Named groups, alphabetically, each with its elements in order.
    pub groups: Vec<(String, Vec<ElementInfo>)>,
    /// The elements in no group, in order.
    pub loose: Vec<ElementInfo>,
}

impl Section {
    pub fn count(&self) -> usize {
        self.loose.len() + self.groups.iter().map(|(_, e)| e.len()).sum::<usize>()
    }
}

/// Compares two names as the 0.1 panel did (`localeCompare` with numbers
/// by value and case ignored), with ICU's Chinese collation as dr-editor
/// sorts names (pinyin; Latin letters alongside): the 0.1 WebView compared
/// in the system's language, which for these authors is Chinese.
pub fn natural(a: &str, b: &str) -> std::cmp::Ordering {
    use icu_collator::CollatorPreferences;
    use icu_collator::options::{CollatorOptions, Strength};
    use icu_collator::preferences::CollationNumericOrdering;
    use std::sync::OnceLock;
    static COLLATOR: OnceLock<Option<icu_collator::CollatorBorrowed<'static>>> = OnceLock::new();
    let collator = COLLATOR.get_or_init(|| {
        let zh = icu_locale_core::locale!("zh");
        let mut prefs: CollatorPreferences = (&zh).into();
        prefs.numeric_ordering = Some(CollationNumericOrdering::True);
        let mut options = CollatorOptions::default();
        options.strength = Some(Strength::Primary);
        icu_collator::Collator::try_new(prefs, options).ok()
    });
    match collator {
        Some(c) => c.compare(a, b).then_with(|| a.cmp(b)),
        None => a.cmp(b),
    }
}

/// The book's elements by category, in the panel's order.
pub fn sections(book: &Book, sort: Sort, category_sort: Sort) -> Vec<Section> {
    let order_elements = |list: &mut Vec<ElementInfo>| match sort {
        Sort::Alphabet => list.sort_by(|a, b| natural(&a.name, &b.name).then(a.id.cmp(&b.id))),
        Sort::Created => list.sort_by(|a, b| b.id.cmp(&a.id)),
    };
    let known: HashSet<&str> = book.categories.iter().map(|c| c.id.as_str()).collect();
    let mut by_key: HashMap<String, Vec<ElementInfo>> = HashMap::new();
    for e in &book.elements {
        let key = match e.category.as_deref() {
            Some(c) if known.contains(c) => c.to_owned(),
            _ => UNCATEGORIZED.to_owned(),
        };
        by_key.entry(key).or_default().push(e.clone());
    }
    let mut categories: Vec<&CategoryInfo> = book.categories.iter().collect();
    match category_sort {
        Sort::Alphabet => categories.sort_by(|a, b| natural(&a.name, &b.name)),
        Sort::Created => categories.sort_by(|a, b| b.id.cmp(&a.id)),
    }
    // A category named exactly `others` goes last (the 0.1 panel).
    categories.sort_by_key(|c| c.name == "others");
    let mut make = |key: String, category: Option<CategoryInfo>| -> Section {
        let all = by_key.remove(&key).unwrap_or_default();
        let mut groups: BTreeMap<String, Vec<ElementInfo>> = BTreeMap::new();
        let mut loose = Vec::new();
        for e in all {
            match e.group_name.clone().filter(|g| !g.trim().is_empty()) {
                Some(g) => groups.entry(g).or_default().push(e),
                None => loose.push(e),
            }
        }
        let mut groups: Vec<(String, Vec<ElementInfo>)> = groups.into_iter().collect();
        groups.sort_by(|a, b| natural(&a.0, &b.0));
        for (_, list) in groups.iter_mut() {
            order_elements(list);
        }
        order_elements(&mut loose);
        Section {
            key,
            category,
            groups,
            loose,
        }
    };
    let mut out: Vec<Section> = categories
        .into_iter()
        .map(|c| make(c.id.clone(), Some(c.clone())))
        .collect();
    let loose = make(UNCATEGORIZED.to_owned(), None);
    if loose.count() > 0 {
        out.push(loose);
    }
    out
}

/// The basis of a compact tile (`ElementIdentityTile`): 44 px and 12.5 px a
/// unit (a CJK character 1, a Latin letter 0.62, a space 0.35), from 80 to
/// 172 px.
pub fn tile_basis(name: &str) -> f32 {
    let units: f32 = name
        .chars()
        .map(|c| {
            if c == ' ' {
                0.35
            } else if c.is_ascii() {
                0.62
            } else {
                1.0
            }
        })
        .sum();
    (44.0 + units * 12.5).clamp(80.0, 172.0)
}

/// 「MM/DD」 this year, 「YY/MM/DD」 before (the 0.1 cells' date).
pub fn short_date(ms: i64, now_ms: i64) -> String {
    let local = |ms: i64| chrono::Local.timestamp_millis_opt(ms).single();
    let (Some(at), Some(now)) = (local(ms), local(now_ms)) else {
        return String::new();
    };
    if at.year() == now.year() {
        format!("{:02}/{:02}", at.month(), at.day())
    } else {
        format!("{:02}/{:02}/{:02}", at.year() % 100, at.month(), at.day())
    }
}

/// The open popover under a category's +.
enum Create {
    /// 「新建要素」 / 「新建分组…」.
    Menu { category: String },
    /// A group's name, then its first element.
    Group {
        category: String,
        name: Entity<TextField>,
    },
}

/// The elements panel's list.
pub struct ElementPanel {
    ws: WeakEntity<Workspace>,
    lib: Option<Library>,
    book: Rc<Book>,
    pub mode: View,
    pub sort: Sort,
    pub category_sort: Sort,
    /// Collapsed categories (their keys).
    pub collapsed: HashSet<String>,
    pub sort_open: bool,
    create: Option<Create>,
    /// A group being renamed: its category's key, its name, the field.
    renaming: Option<(String, String, Entity<TextField>)>,
    /// Each element's last stored change (ms), for the list's dates.
    updated: HashMap<String, i64>,
    updated_for: Option<Rc<Book>>,
    task: Option<Task<()>>,
    bounds: Option<Entity<Option<Bounds<Pixels>>>>,
    _subs: Vec<Subscription>,
}

impl ElementPanel {
    pub fn new(ws: WeakEntity<Workspace>, cx: &mut Context<Self>) -> ElementPanel {
        let lib = cx.try_global::<Services>().and_then(|s| s.library.clone());
        cx.spawn(async move |this, cx| this.update(cx, |p, cx| p.follow(cx)).ok())
            .detach();
        ElementPanel {
            ws,
            lib,
            book: Rc::default(),
            mode: View::default(),
            sort: Sort::default(),
            category_sort: Sort::default(),
            collapsed: HashSet::new(),
            sort_open: false,
            create: None,
            renaming: None,
            updated: HashMap::new(),
            updated_for: None,
            task: None,
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

    /// The panel's sections now (tests).
    pub fn sections(&self) -> Vec<Section> {
        sections(&self.book, self.sort, self.category_sort)
    }

    pub fn toggle_mode(&mut self, cx: &mut Context<Self>) {
        self.mode = match self.mode {
            View::Compact => View::List,
            View::List => View::Compact,
        };
        cx.notify();
    }

    /// Collapses every category, or expands them all when any is collapsed.
    pub fn toggle_all(&mut self, cx: &mut Context<Self>) {
        if self.collapsed.is_empty() {
            self.collapsed = self.sections().into_iter().map(|s| s.key).collect();
        } else {
            self.collapsed.clear();
        }
        cx.notify();
    }

    pub fn toggle(&mut self, key: &str, cx: &mut Context<Self>) {
        if !self.collapsed.remove(key) {
            self.collapsed.insert(key.to_owned());
        }
        cx.notify();
    }

    pub fn set_sort(&mut self, sort: Sort, cx: &mut Context<Self>) {
        self.sort = sort;
        cx.notify();
    }

    pub fn set_category_sort(&mut self, sort: Sort, cx: &mut Context<Self>) {
        self.category_sort = sort;
        cx.notify();
    }

    fn open(&self, target: Target, how: Open, cx: &mut App) {
        self.ws.update(cx, |ws, cx| ws.open(target, how, cx)).ok();
    }

    fn opener(
        entity: &Entity<Self>,
        target: Target,
    ) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
        let entity = entity.clone();
        move |e, _, cx| {
            let how = if e.click_count() > 1 {
                Open::KEEP
            } else {
                Open::PREVIEW
            };
            let target = target.clone();
            entity.update(cx, |p, cx| p.open(target, how, cx));
        }
    }

    /// 「新类目」: a category named as in the 0.1 client, in a colour of the
    /// six (the 0.1 client picked one at random).
    pub fn new_category(&mut self, cx: &mut Context<Self>) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let book = self.book.id.clone();
        let colors = [
            "#c4704f", "#4f7cac", "#6f9a57", "#a3685c", "#8a6fae", "#c49a3f",
        ];
        let pick = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
            % colors.len() as u32) as usize;
        let color = colors[pick].to_owned();
        cx.background_executor()
            .spawn(async move {
                let made = lib.run::<CategoryCreate>(
                    &Actor::User,
                    CategoryCreateIn {
                        book,
                        name: "New Category".to_owned(),
                        color: Some(color),
                        text: None,
                    },
                );
                if let Err(error) = made {
                    log::warn!("the category could not be made: {error}");
                }
            })
            .detach();
    }

    /// Makes an element in category `key` (and `group`), then opens it.
    pub fn new_element(
        &mut self,
        key: &str,
        group: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(lib) = self.lib.clone() else {
            return;
        };
        self.create = None;
        let book = self.book.id.clone();
        let category = (key != UNCATEGORIZED).then(|| key.to_owned());
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let made = cx
                .background_executor()
                .spawn(async move {
                    let made = lib
                        .run::<ElementCreate>(
                            &Actor::User,
                            ElementCreateIn {
                                book: book.clone(),
                                name: String::new(),
                                numbered: true,
                                category,
                                summary: String::new(),
                                aliases: Vec::new(),
                                text: None,
                            },
                        )?
                        .output;
                    if group.is_some() {
                        let mut edit = data::element_edit(&book, &made.id);
                        edit.group_name = Some(group);
                        data::update_element(&lib, edit)?;
                    }
                    Ok::<_, dr_workspace::WsError>(made.id)
                })
                .await;
            match made {
                Ok(id) => {
                    this.update(cx, |p, cx| {
                        if let Ok(id) = id.parse() {
                            p.open(Target::Element(id), Open::KEEP, cx);
                        }
                    })
                    .ok();
                }
                Err(error) => log::warn!("the element could not be made: {error}"),
            }
        })
        .detach();
    }

    /// A category's +: its menu.
    pub fn open_create(&mut self, key: &str, cx: &mut Context<Self>) {
        self.create = Some(Create::Menu {
            category: key.to_owned(),
        });
        cx.notify();
    }

    /// 「新建分组…」: the group's name.
    pub fn ask_group(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Create::Menu { category }) = &self.create else {
            return;
        };
        let category = category.clone();
        let hint = t(
            cx,
            keys::element_category_create_menu::GROUP_NAME_PLACEHOLDER,
        );
        let name = cx.new(|cx| {
            TextField::new("element-panel-group-name", window, cx)
                .small()
                .placeholder(hint)
        });
        let key = category.clone();
        let sub = cx.subscribe_in(&name, window, move |p, field, e, window, cx| match e {
            FieldEvent::Submitted(_) => {
                let text = field.read(cx).text();
                p.create_group(&key, text, window, cx);
            }
            FieldEvent::Cancelled => {
                p.create = Some(Create::Menu {
                    category: key.clone(),
                });
                cx.notify();
            }
            FieldEvent::Changed(_) => cx.notify(),
            FieldEvent::Blurred => {}
        });
        self._subs.push(sub);
        name.focus_handle(cx).focus(window, cx);
        self.create = Some(Create::Group { category, name });
        cx.notify();
    }

    /// Whether `name` is already a group of category `key` (case ignored).
    pub fn group_taken(&self, key: &str, name: &str) -> bool {
        let name = name.trim().to_lowercase();
        self.sections()
            .into_iter()
            .find(|s| s.key == key)
            .is_some_and(|s| s.groups.iter().any(|(g, _)| g.to_lowercase() == name))
    }

    /// Makes group `name` in category `key` with its first element.
    pub fn create_group(
        &mut self,
        key: &str,
        name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let name = name.trim().to_owned();
        if name.is_empty() || self.group_taken(key, &name) {
            return;
        }
        self.new_element(key, Some(name), window, cx);
    }

    pub fn close_create(&mut self, cx: &mut Context<Self>) {
        self.create = None;
        cx.notify();
    }

    /// A double click on a group's head: rename it in place.
    pub fn start_rename_group(
        &mut self,
        key: &str,
        group: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let field = cx.new(|cx| {
            TextField::new("element-panel-group-rename", window, cx)
                .small()
                .with_text(group.to_owned())
        });
        let sub = cx.subscribe_in(&field, window, |p, field, e, _, cx| match e {
            FieldEvent::Submitted(_) | FieldEvent::Blurred => {
                let text = field.read(cx).text();
                p.finish_rename_group(Some(text), cx);
            }
            FieldEvent::Cancelled => p.finish_rename_group(None, cx),
            FieldEvent::Changed(_) => {}
        });
        self._subs.push(sub);
        field.update(cx, |f, cx| f.select_all_text(cx));
        field.focus_handle(cx).focus(window, cx);
        self.renaming = Some((key.to_owned(), group.to_owned(), field));
        cx.notify();
    }

    /// Ends renaming a group: `Some` renames it on every element in it (an
    /// empty or unchanged name does nothing).
    pub fn finish_rename_group(&mut self, name: Option<String>, cx: &mut Context<Self>) {
        let Some((key, old, _)) = self.renaming.take() else {
            return;
        };
        cx.notify();
        let Some(name) = name.map(|n| n.trim().to_owned()) else {
            return;
        };
        if name.is_empty() || name == old {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let book = self.book.id.clone();
        let ids: Vec<String> = self
            .sections()
            .into_iter()
            .find(|s| s.key == key)
            .and_then(|s| s.groups.into_iter().find(|(g, _)| *g == old))
            .map(|(_, list)| list.into_iter().map(|e| e.id).collect())
            .unwrap_or_default();
        cx.background_executor()
            .spawn(async move {
                for id in ids {
                    let mut edit = data::element_edit(&book, &id);
                    edit.group_name = Some(Some(name.clone()));
                    if let Err(error) = data::update_element(&lib, edit) {
                        log::warn!("the group could not be renamed: {error}");
                    }
                }
            })
            .detach();
    }

    /// Reads each element's last stored change off the main thread (the
    /// list's dates).
    fn read_dates(&mut self, cx: &mut Context<Self>) {
        let fresh = self
            .updated_for
            .as_ref()
            .is_some_and(|b| Rc::ptr_eq(b, &self.book));
        if fresh || self.task.is_some() || self.book.is_empty() || self.mode != View::List {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        let book = self.book.clone();
        let ids: Vec<String> = book.elements.iter().map(|e| e.id.clone()).collect();
        self.task = Some(cx.spawn(async move |this, cx| {
            let dates = cx
                .background_executor()
                .spawn(async move {
                    let store = lib.library();
                    ids.into_iter()
                        .filter_map(|id| {
                            let ts = store.head(&format!("element:{id}")).ok().flatten()?.ts;
                            Some((id, ts))
                        })
                        .collect::<HashMap<_, _>>()
                })
                .await;
            this.update(cx, |p, cx| {
                p.task = None;
                p.updated = dates;
                p.updated_for = Some(book);
                cx.notify();
            })
            .ok();
        }));
    }
}

impl Render for ElementPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.read_dates(cx);
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let bounds = overlay::use_bounds("element-panel-bounds", window, cx);
        self.bounds = Some(bounds.clone());
        let width = bounds
            .read(cx)
            .map(|b| f32::from(b.size.width))
            .unwrap_or(260.0);
        let entity = cx.entity();
        let ws = self.ws.upgrade();
        let selected = |target: &Target, cx: &App| {
            ws.as_ref()
                .is_some_and(|ws| ws.read(cx).nav.is_selected(target))
        };
        let sections = self.sections();
        let mut list = div()
            .id("element-panel")
            .relative()
            .size_full()
            .overflow_y_scroll()
            .pb(px(24.0))
            .flex()
            .flex_col()
            .child(overlay::probe(bounds));
        if self.book.elements.is_empty() && self.book.categories.is_empty() {
            list = list.child(
                div()
                    .p(px(16.0))
                    .font_role(Role::Ui)
                    .type_px(theme.scale.body, theme.scale.line_body)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, keys::left_sidebar::empty::NO_ELEMENTS)),
            );
            return list;
        }
        for section in sections {
            let el = match self.mode {
                View::List => list_section(self, &entity, &section, width, &selected, window, cx),
                View::Compact => compact_section(self, &entity, &section, &selected, window, cx),
            };
            list = list.child(el);
        }
        list
    }
}

/// A category's +, under the pointer (always shown in the compact index).
fn plus_button(
    entity: &Entity<ElementPanel>,
    key: &str,
    group_hover: Option<SharedString>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let bounds = overlay::use_bounds(
        ElementId::Name(format!("element-panel-plus-bounds-{key}").into()),
        window,
        cx,
    );
    let open = {
        let entity = entity.clone();
        let key = key.to_owned();
        move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
            entity.update(cx, |p, cx| p.open_create(&key, cx))
        }
    };
    let button = IconButton::new(
        SharedString::from(format!("element-panel-plus-{key}")),
        Icon::Plus,
    )
    .label(t(cx, keys::element_category_create_menu::OPEN_CREATE_MENU))
    .on_click(open);
    let el = div()
        .relative()
        .flex_none()
        .child(overlay::probe(bounds))
        .child(button);
    match group_hover {
        Some(group) => el
            .invisible()
            .group_hover(group, |st| st.visible())
            .into_any_element(),
        None => el.into_any_element(),
    }
}

/// The popover under a category's + (its menu, or the new group's name).
fn create_popover(
    panel: &ElementPanel,
    entity: &Entity<ElementPanel>,
    key: &str,
    category_name: &SharedString,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let (category, form) = match panel.create.as_ref()? {
        Create::Menu { category } => (category, None),
        Create::Group { category, name } => (category, Some(name.clone())),
    };
    if category != key {
        return None;
    }
    let anchor = *overlay::use_bounds(
        ElementId::Name(format!("element-panel-plus-bounds-{key}").into()),
        window,
        cx,
    )
    .read(cx);
    let anchor = anchor?;
    let theme = Theme::of(window, cx);
    let title = tf(
        cx,
        keys::element_category_create_menu::TITLE,
        &[("name", category_name)],
    );
    let body: AnyElement = match form {
        None => {
            let new_element = {
                let entity = entity.clone();
                let key = key.to_owned();
                move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                    entity.update(cx, |p, cx| p.new_element(&key, None, window, cx))
                }
            };
            let new_group = {
                let entity = entity.clone();
                move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                    entity.update(cx, |p, cx| p.ask_group(window, cx))
                }
            };
            Menu::new("element-panel-create")
                .section(title, &theme)
                .item(
                    MenuItem::new(
                        "element-panel-new-element",
                        sand::Kind::Element.into_row(),
                        t(cx, keys::element_category_create_menu::NEW_ELEMENT),
                    )
                    .on_click(new_element),
                )
                .item(
                    MenuItem::new(
                        "element-panel-new-group",
                        Icon::FolderPlus,
                        t(cx, keys::element_category_create_menu::NEW_GROUP),
                    )
                    .on_click(new_group),
                )
                .into_any_element()
        }
        Some(name) => {
            let p = theme.palette;
            let typed = name.read(cx).text();
            let taken = panel.group_taken(key, &typed);
            let empty = typed.trim().is_empty();
            let back = {
                let entity = entity.clone();
                let key = key.to_owned();
                move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
                    entity.update(cx, |p, cx| p.open_create(&key, cx))
                }
            };
            let create = {
                let entity = entity.clone();
                let key = key.to_owned();
                let name = name.clone();
                move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                    let text = name.read(cx).text();
                    entity.update(cx, |p, cx| p.create_group(&key, text, window, cx))
                }
            };
            glass::glass_box(
                "element-panel-group-form",
                GlassKind::Rest,
                Mode::default(),
                false,
                Spec::new(Tone::Clear, radius::SHEET).filled(p.page),
                window,
                cx,
            )
            .w(px(260.0))
            .p(px(12.0))
            .rounded(px(radius::SHEET))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .font_role(Role::Ui)
            .type_px(theme.scale.secondary, theme.scale.line_body)
            .child(
                div()
                    .text_color(p.ink(2).solid())
                    .child(t(cx, keys::element_category_create_menu::GROUP_TITLE)),
            )
            .child(
                div()
                    .font_role(Role::Index)
                    .type_px(theme.scale.caption, theme.scale.line_caption)
                    .text_color(p.ink(4).solid())
                    .child(t(cx, keys::element_category_create_menu::GROUP_NAME_LABEL)),
            )
            .child(name.clone())
            .when(taken, |el| {
                el.child(
                    div()
                        .text_color(p.accent.solid())
                        .child(t(cx, keys::element_category_create_menu::DUPLICATE_GROUP)),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_end()
                    .gap(px(8.0))
                    .child(
                        Button::new(
                            "element-panel-group-back",
                            t(cx, keys::element_category_create_menu::BACK),
                        )
                        .text()
                        .on_click(back),
                    )
                    .child(
                        Button::new(
                            "element-panel-group-create",
                            t(cx, keys::element_category_create_menu::CREATE_GROUP),
                        )
                        .primary()
                        .disabled(taken || empty)
                        .on_click(create),
                    ),
            )
            .into_any_element()
        }
    };
    let dismiss = entity.clone();
    Some(
        overlay::float(
            Place::Rect {
                rect: anchor,
                align: Align::End,
                gap: 6.0,
            },
            Layer::Popover,
            div()
                .id(ElementId::Name(
                    format!("element-panel-create-float-{key}").into(),
                ))
                .occlude()
                .on_mouse_down_out(move |e, _, cx| {
                    if anchor.contains(&e.position) {
                        return;
                    }
                    dismiss.update(cx, |p, cx| p.close_create(cx))
                })
                .child(body),
        )
        .into_any_element(),
    )
}

/// A row-icon helper: a kind mark for a menu row.
trait IntoRow {
    fn into_row(self) -> dr_ui::components::menu::RowIcon;
}

impl IntoRow for sand::Kind {
    fn into_row(self) -> dr_ui::components::menu::RowIcon {
        dr_ui::components::menu::RowIcon::Mark(self, None)
    }
}

/// The category's name and colour (未分类: its own name, the faint ink).
fn section_look(section: &Section, p: &dr_ui::tokens::Palette, cx: &App) -> (SharedString, Rgb) {
    match &section.category {
        Some(c) => (
            c.name.clone().into(),
            color_of(&c.color).unwrap_or(p.ink(4)),
        ),
        None => (t(cx, keys::left_sidebar::UNCATEGORIZED), p.ink(4)),
    }
}

/// A category in the name list.
fn list_section(
    panel: &ElementPanel,
    entity: &Entity<ElementPanel>,
    section: &Section,
    width: f32,
    selected: &dyn Fn(&Target, &App) -> bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let (name, color) = section_look(section, p, cx);
    let count = section.count();
    let collapsed = panel.collapsed.contains(&section.key) || count == 0;
    let group: SharedString = format!("element-panel-head-{}", section.key).into();
    let toggle = {
        let entity = entity.clone();
        let key = section.key.clone();
        move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
            entity.update(cx, |p, cx| p.toggle(&key, cx))
        }
    };
    let category_target = section
        .category
        .as_ref()
        .and_then(|c| c.id.parse().ok())
        .map(Target::Category);
    let label = div()
        .id(ElementId::Name(format!("{group}-name").into()))
        .flex_1()
        .min_w_0()
        .truncate()
        .font_role(Role::Structure)
        .type_px(s.body, s.line_body)
        .text_color(p.ink(2).solid())
        .child(name.clone())
        .when_some(category_target.clone(), |el, target| {
            el.cursor_pointer()
                .on_click(ElementPanel::opener(entity, target))
        });
    let head = div()
        .id(ElementId::Name(group.clone()))
        .group(group.clone())
        .pl(px(14.0))
        .pr(px(12.0))
        .py(px(4.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .child(
            div()
                .id(ElementId::Name(format!("{group}-chevron").into()))
                .size(px(14.0))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .on_click(toggle)
                .child(sand::icon(
                    if collapsed {
                        Icon::ChevronRight
                    } else {
                        Icon::ChevronDown
                    },
                    11.0,
                    p.ink(3).solid(),
                )),
        )
        .child(
            KindMark::new(
                ElementId::Name(format!("{group}-mark").into()),
                sand::Kind::Category,
            )
            .color(color),
        )
        .child(label)
        .child(
            div()
                .flex_none()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.ink(4).solid())
                .child(format!("· {count}")),
        )
        .when(section.category.is_some(), |el| {
            el.child(plus_button(
                entity,
                &section.key,
                Some(group.clone()),
                window,
                cx,
            ))
        });
    let popover = create_popover(panel, entity, &section.key, &name, window, cx);
    let mut col = div()
        .mb(px(8.0))
        .flex()
        .flex_col()
        .child(head)
        .children(popover);
    if collapsed {
        return col.into_any_element();
    }
    let date = |e: &ElementInfo| -> Option<String> {
        (width >= 200.0)
            .then(|| panel.updated.get(&e.id).copied())
            .flatten()
            .map(|ms| short_date(ms, crate::now_ms()))
    };
    let row = |e: &ElementInfo, cx: &mut App| -> AnyElement {
        let Some(target) = e.id.parse().ok().map(Target::Element) else {
            return div().into_any_element();
        };
        let name: SharedString = if e.name.trim().is_empty() {
            t(cx, keys::element_editor::UNTITLED)
        } else {
            e.name.clone().into()
        };
        let readout = date(e).map(|d| {
            div()
                .flex_none()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.muted().solid())
                .child(d)
        });
        div()
            .mx(px(6.0))
            .child(
                SandCell::new(
                    ElementId::Name(format!("element-panel-row-{}", e.id).into()),
                    name,
                )
                .mark(sand::Kind::Element)
                .color(color)
                .selected(selected(&target, cx))
                .children(readout)
                .on_click(ElementPanel::opener(entity, target)),
            )
            .into_any_element()
    };
    for (g, members) in &section.groups {
        col = col.child(group_head(
            panel,
            entity,
            section,
            g,
            members.len(),
            false,
            window,
            cx,
        ));
        for e in members {
            col = col.child(row(e, cx));
        }
    }
    for e in &section.loose {
        col = col.child(row(e, cx));
    }
    col.into_any_element()
}

/// A named group's head (`ElementGroupHeader`): a tick, the name, 「· N」, a
/// + under the pointer; a double click renames it.
#[allow(clippy::too_many_arguments)]
fn group_head(
    panel: &ElementPanel,
    entity: &Entity<ElementPanel>,
    section: &Section,
    group: &str,
    count: usize,
    compact: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let id: SharedString = format!("element-panel-group-{}-{group}", section.key).into();
    if let Some((key, old, field)) = &panel.renaming
        && *key == section.key
        && old == group
    {
        return div()
            .map(|el| {
                if compact {
                    el.px(px(8.0))
                } else {
                    el.pl(px(26.0)).pr(px(10.0))
                }
            })
            .py(px(2.0))
            .child(field.clone())
            .into_any_element();
    }
    let rename = {
        let entity = entity.clone();
        let key = section.key.clone();
        let group = group.to_owned();
        move |e: &ClickEvent, window: &mut Window, cx: &mut App| {
            if e.click_count() > 1 {
                entity.update(cx, |p, cx| p.start_rename_group(&key, &group, window, cx));
            }
        }
    };
    let add = {
        let entity = entity.clone();
        let key = section.key.clone();
        let group = group.to_owned();
        move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
            entity.update(cx, |p, cx| {
                p.new_element(&key, Some(group.clone()), window, cx)
            })
        }
    };
    div()
        .id(ElementId::Name(id.clone()))
        .group(id.clone())
        .map(|el| {
            if compact {
                el.pt(px(5.0)).px(px(8.0)).pb(px(1.0))
            } else {
                el.pt(px(2.0)).pl(px(26.0)).pr(px(10.0))
            }
        })
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .font_role(Role::Index)
        .type_px(s.caption, s.caption * 1.2)
        .text_color(p.ink(4).solid())
        .aria_label(t(
            cx,
            keys::left_sidebar::groups::RENAME_ELEMENT_GROUP_TITLE,
        ))
        .on_click(rename)
        .child(div().w(px(8.0)).h(px(1.0)).flex_none().bg(p.rule.solid()))
        .child(div().min_w_0().truncate().child(group.to_owned()))
        .child(div().flex_none().child(format!("· {count}")))
        .child(div().flex_1())
        .child(
            div()
                .flex_none()
                .invisible()
                .group_hover(id.clone(), |st| st.visible())
                .child(
                    IconButton::new(SharedString::from(format!("{id}-add")), Icon::Plus)
                        .label(t(cx, keys::left_sidebar::groups::ADD_ELEMENT_TO_GROUP))
                        .on_click(add),
                ),
        )
        .into_any_element()
}

/// A category in the compact index: a brush frame in its colour, its name
/// on a plate cut into the frame, the elements as flowing tiles.
fn compact_section(
    panel: &ElementPanel,
    entity: &Entity<ElementPanel>,
    section: &Section,
    selected: &dyn Fn(&Target, &App) -> bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let (name, color) = section_look(section, p, cx);
    let count = section.count();
    let empty = count == 0;
    let collapsed = panel.collapsed.contains(&section.key) || empty;
    let id: SharedString = format!("element-panel-frame-{}", section.key).into();
    let category_target = section
        .category
        .as_ref()
        .and_then(|c| c.id.parse().ok())
        .map(Target::Category);
    let toggle = {
        let entity = entity.clone();
        let key = section.key.clone();
        move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
            entity.update(cx, |p, cx| p.toggle(&key, cx))
        }
    };
    let plate = div()
        .h(px(22.0))
        .pl(px(5.0))
        .pr(px(7.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .bg(p.desk.solid())
        .child(
            KindMark::new(
                ElementId::Name(format!("{id}-mark").into()),
                sand::Kind::Category,
            )
            .color(color),
        )
        .child(
            div()
                .id(ElementId::Name(format!("{id}-name").into()))
                .font_role(Role::Structure)
                .type_px(s.body, s.line_body)
                .text_color(p.ink(2).solid())
                .child(name.clone())
                .when_some(category_target, |el, target| {
                    el.cursor_pointer()
                        .on_click(ElementPanel::opener(entity, target))
                }),
        );
    let head = div()
        .id(ElementId::Name(format!("{id}-head").into()))
        .group(id.clone())
        .min_h(px(26.0))
        .pl(px(6.0))
        .py(px(4.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(4.0))
        .child(plate)
        .child(div().flex_1())
        .child(
            div()
                .id(ElementId::Name(format!("{id}-disclosure").into()))
                .size(px(14.0))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .map(|el| {
                    if empty {
                        el.invisible()
                    } else if collapsed {
                        el.cursor_pointer().on_click(toggle)
                    } else {
                        el.cursor_pointer()
                            .on_click(toggle)
                            .invisible()
                            .group_hover(id.clone(), |st| st.visible())
                    }
                })
                .child(sand::icon(
                    if collapsed {
                        Icon::ChevronRight
                    } else {
                        Icon::ChevronDown
                    },
                    11.0,
                    p.ink(3).solid(),
                )),
        )
        .when(section.category.is_some(), |el| {
            el.child(plus_button(entity, &section.key, None, window, cx))
        });
    let popover = create_popover(panel, entity, &section.key, &name, window, cx);
    let tile = |e: &ElementInfo, cx: &mut App| -> AnyElement {
        let Some(target) = e.id.parse().ok().map(Target::Element) else {
            return div().into_any_element();
        };
        let label: SharedString = if e.name.trim().is_empty() {
            t(cx, keys::element_editor::UNTITLED)
        } else {
            e.name.clone().into()
        };
        let on = selected(&target, cx);
        let tid: SharedString = format!("element-panel-tile-{}", e.id).into();
        div()
            .id(ElementId::Name(tid.clone()))
            .relative()
            .flex_grow(1.0)
            .flex_shrink(1.0)
            .flex_basis(px(tile_basis(&label)))
            .min_h(px(28.0))
            .pl(px(8.0))
            .pr(px(10.0))
            .py(px(4.0))
            .rounded(px(3.0))
            .flex()
            .flex_row()
            .items_start()
            .gap(px(6.0))
            .cursor_pointer()
            .role(gpui::Role::Button)
            .aria_label(label.clone())
            .font_role(Role::Ui)
            .type_px(s.body, s.line_body)
            .text_color(if on { p.ink(1) } else { p.ink(2) }.solid())
            .hover(move |st| st.text_color(p.ink(1).solid()))
            .on_click(ElementPanel::opener(entity, target))
            .child(SandFrame::new(ElementId::Name(format!("{tid}-frame").into()), on).color(color))
            .child(
                div().mt(px(6.0)).size(px(10.0)).flex_none().child(
                    KindMark::new(
                        ElementId::Name(format!("{tid}-mark").into()),
                        sand::Kind::Element,
                    )
                    .color(color)
                    .scale(10.0 / 14.0),
                ),
            )
            .child(div().min_w_0().child(label))
            .into_any_element()
    };
    let flow = |members: &[ElementInfo], cx: &mut App| -> AnyElement {
        let mut flow = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(4.0))
            .px(px(8.0))
            .pt(px(4.0))
            .pb(px(1.0));
        for e in members {
            flow = flow.child(tile(e, cx));
        }
        flow.into_any_element()
    };
    let mut body = div().flex().flex_col();
    if !collapsed {
        for (g, members) in &section.groups {
            body = body.child(
                div()
                    .mx(px(4.0))
                    .mt(px(3.0))
                    .pb(px(5.0))
                    .border_1()
                    .border_color(p.rule.solid())
                    .rounded(px(3.0))
                    .child(group_head(
                        panel,
                        entity,
                        section,
                        g,
                        members.len(),
                        true,
                        window,
                        cx,
                    ))
                    .child(flow(members, cx)),
            );
        }
        if !section.loose.is_empty() {
            body = body.child(
                div()
                    .when(!section.groups.is_empty(), |el| el.mt(px(3.0)))
                    .child(flow(&section.loose, cx)),
            );
        }
    }
    div()
        .id(ElementId::Name(id.clone()))
        .relative()
        .mx(px(12.0))
        .mt(px(2.0))
        .mb(px(if collapsed { 4.0 } else { 12.0 }))
        .pb(px(if collapsed { 0.0 } else { 8.0 }))
        .child(
            // The frame runs round the section; the plate cuts it.
            div()
                .absolute()
                .top(px(13.0))
                .left_0()
                .right_0()
                .bottom_0()
                .child(
                    SandFrame::new(ElementId::Name(format!("{id}-sand").into()), !collapsed)
                        .color(color),
                ),
        )
        .child(head)
        .children(popover)
        .child(body)
        .into_any_element()
}

/// The panel's head row: the counts (switching the view), the element
/// overview, expand / collapse all, the sort menu, 「新类目」.
pub struct PanelHead {
    pub panel: Entity<ElementPanel>,
    ws: WeakEntity<Workspace>,
    _sub: Subscription,
}

impl PanelHead {
    pub fn new(
        panel: Entity<ElementPanel>,
        ws: WeakEntity<Workspace>,
        cx: &mut Context<Self>,
    ) -> PanelHead {
        let sub = cx.observe(&panel, |_, _, cx| cx.notify());
        PanelHead {
            panel,
            ws,
            _sub: sub,
        }
    }
}

impl Render for PanelHead {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let panel = self.panel.read(cx);
        let book = panel.book.clone();
        let mode = panel.mode;
        let (sort, category_sort, sort_open) = (panel.sort, panel.category_sort, panel.sort_open);
        let text = tf(
            cx,
            keys::left_sidebar::meta::ELEMENTS,
            &[
                ("categories", &book.categories.len()),
                ("elements", &book.elements.len()),
            ],
        );
        let toggle_mode = {
            let panel = self.panel.clone();
            move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
                panel.update(cx, |p, cx| p.toggle_mode(cx))
            }
        };
        let ink = p.ink(1).solid();
        let meta = div()
            .id("element-panel-mode")
            .flex_1()
            .min_w_0()
            .truncate()
            .cursor_pointer()
            .font_role(Role::Index)
            .type_px(s.caption, s.line_caption)
            .text_color(p.muted().solid())
            .hover(move |st| st.text_color(ink))
            .role(gpui::Role::Button)
            .aria_label(t(
                cx,
                match mode {
                    View::Compact => keys::left_sidebar::view_mode::ELEMENT_COMPACT_TITLE,
                    View::List => keys::left_sidebar::view_mode::ELEMENT_LIST_TITLE,
                },
            ))
            .on_click(toggle_mode)
            .child(text);
        let ws = self.ws.clone();
        let overview_on = ws
            .upgrade()
            .is_some_and(|w| w.read(cx).super_view == Some(SuperView::Elements));
        let overview = IconButton::new("element-panel-overview", Icon::KnotLinks)
            .label(t(cx, SuperView::Elements.label()))
            .selected(overview_on)
            .on_click(move |_, _, cx| {
                ws.update(cx, |ws, cx| ws.toggle_super_view(SuperView::Elements, cx))
                    .ok();
            });
        let all = {
            let panel = self.panel.clone();
            IconButton::new("element-panel-all", Icon::FoldingFan)
                .label(t(cx, keys::left_sidebar::actions::COLLAPSE_ALL))
                .on_click(move |_, _, cx| panel.update(cx, |p, cx| p.toggle_all(cx)))
        };
        let sort_bounds = overlay::use_bounds("element-panel-sort-bounds", window, cx);
        let sort_button = {
            let panel = self.panel.clone();
            IconButton::new("element-panel-sort", Icon::Sort)
                .label(t(cx, keys::left_sidebar::actions::SORT))
                .selected(sort_open)
                .on_click(move |_, _, cx| {
                    panel.update(cx, |p, cx| {
                        p.sort_open = !p.sort_open;
                        cx.notify();
                    })
                })
        };
        let menu = match (sort_open, *sort_bounds.read(cx)) {
            (true, Some(anchor)) => Some(sort_menu(
                &self.panel,
                sort,
                category_sort,
                anchor,
                &theme,
                cx,
            )),
            _ => None,
        };
        let new_category = {
            let panel = self.panel.clone();
            IconButton::new("element-panel-new-category", Icon::NewCategory)
                .label(t(cx, keys::left_sidebar::actions::NEW_CATEGORY))
                .on_click(move |_, _, cx| panel.update(cx, |p, cx| p.new_category(cx)))
        };
        div()
            .size_full()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(2.0))
            .child(meta)
            .child(overview)
            .child(all)
            .child(
                div()
                    .relative()
                    .child(overlay::probe(sort_bounds))
                    .child(sort_button),
            )
            .children(menu)
            .child(new_category)
    }
}

/// The sort menu (`排序类目内要素` and `外层类目`).
fn sort_menu(
    panel: &Entity<ElementPanel>,
    sort: Sort,
    category_sort: Sort,
    anchor: Bounds<Pixels>,
    theme: &Theme,
    cx: &App,
) -> AnyElement {
    use keys::left_sidebar::sort as k;
    let row = |id: &'static str, icon: Icon, label, value: Sort, outer: bool| {
        let panel = panel.clone();
        let current = if outer { category_sort } else { sort };
        MenuItem::new(id, icon, t(cx, label))
            .checked(value == current)
            .on_click(move |_, _, cx| {
                panel.update(cx, |p, cx| {
                    if outer {
                        p.set_category_sort(value, cx)
                    } else {
                        p.set_sort(value, cx)
                    }
                })
            })
    };
    let menu = Menu::new("element-sort-menu")
        .section(t(cx, k::CATEGORY_ELEMENTS), theme)
        .item(row(
            "sort-elements-alpha",
            Icon::AlphaDown,
            k::ALPHABET,
            Sort::Alphabet,
            false,
        ))
        .item(row(
            "sort-elements-created",
            Icon::Sprout,
            k::CREATED_AT,
            Sort::Created,
            false,
        ))
        .separator(theme)
        .section(t(cx, k::OUTER_CATEGORIES_GROUP), theme)
        .item(row(
            "sort-categories-alpha",
            Icon::AlphaDown,
            k::ALPHABET,
            Sort::Alphabet,
            true,
        ))
        .item(row(
            "sort-categories-created",
            Icon::Sprout,
            k::CREATED_AT,
            Sort::Created,
            true,
        ));
    let dismiss = panel.clone();
    overlay::float(
        Place::Rect {
            rect: anchor,
            align: Align::End,
            gap: 6.0,
        },
        Layer::Popover,
        div()
            .id("element-sort-float")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_compare_by_pinyin_with_numbers_by_value() {
        let mut names = vec!["人物 10", "人物 2", "地点", "物件与往事", "人物 1", "Alice"];
        names.sort_by(|a, b| natural(a, b));
        // CLDR's zh order puts Han before Latin, as the 0.1 WebView did.
        assert_eq!(
            names,
            ["地点", "人物 1", "人物 2", "人物 10", "物件与往事", "Alice"]
        );
    }

    #[test]
    fn tiles_are_as_wide_as_their_names_want() {
        assert_eq!(tile_basis("知微"), 80.0);
        assert_eq!(tile_basis("青梅镇钟楼"), 44.0 + 5.0 * 12.5);
        assert_eq!(tile_basis("一二三四五六七八九十一二三"), 172.0);
    }

    #[test]
    fn dates_drop_the_year_this_year() {
        let now = chrono::Local
            .with_ymd_and_hms(2026, 11, 8, 12, 0, 0)
            .unwrap()
            .timestamp_millis();
        let this = chrono::Local
            .with_ymd_and_hms(2026, 3, 5, 9, 0, 0)
            .unwrap()
            .timestamp_millis();
        let last = chrono::Local
            .with_ymd_and_hms(2025, 12, 31, 9, 0, 0)
            .unwrap()
            .timestamp_millis();
        assert_eq!(short_date(this, now), "03/05");
        assert_eq!(short_date(last, now), "25/12/31");
    }
}

/// K4 G2's versioned level displays. The legacy panel above is unchanged.
pub mod v3 {
    use std::{collections::BTreeSet, rc::Rc};

    use dr_i18n::keys;
    use dr_shell::{
        book::Book,
        nav::Open,
        strings::t,
        v3::{DisplaySurface, LevelHost, Rendered, entry_target},
    };
    use dr_ui::{
        Theme,
        components::{IconButton, SandCell, Segmented},
        fonts::Role,
        sand::{Icon, SandFrame},
        style::DrStyled,
    };
    use gpui::{prelude::*, *};

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Display {
        List,
        Board,
        Grid,
        Islands,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Section {
        Residents,
        Members,
        Unassigned,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum Row {
        Section(Section),
        Entry { id: String, depth: usize },
        Tiles { ids: Vec<String>, depth: usize },
        Island { id: String, members: Vec<String> },
    }

    /// Flatten only the effective residence tree. Accepted entries are a
    /// separate section and never silently become children in the tree.
    pub fn rows(
        book: &Book,
        level: &str,
        display: Display,
        grouped: bool,
        folded: &BTreeSet<String>,
        columns: usize,
    ) -> Vec<Row> {
        let Some(v) = book.v3() else {
            return Vec::new();
        };
        let Some(root) = v.levels.get(level) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if grouped && display == Display::List {
            let mut leaves = Vec::new();
            let mut pending: Vec<_> = root.children.iter().rev().cloned().collect();
            let mut seen = BTreeSet::new();
            while let Some(id) = pending.pop() {
                if !seen.insert(id.clone()) {
                    continue;
                }
                if let Some(l) = v.levels.get(&id) {
                    pending.extend(l.children.iter().rev().cloned());
                } else {
                    leaves.push(id);
                }
            }
            let mut used = BTreeSet::new();
            for lane in v
                .entries
                .iter()
                .filter(|e| v.template_of(&e.id).is_some_and(|t| t.lane))
            {
                let members: Vec<_> = leaves
                    .iter()
                    .filter(|id| {
                        let accepted: Vec<_> = v
                            .memberships
                            .iter()
                            .filter(|m| {
                                m.member == **id && v.template_of(&m.host).is_some_and(|t| t.lane)
                            })
                            .map(|m| m.host.as_str())
                            .collect();
                        let primary = v
                            .entry(id)
                            .and_then(|e| e.primary.as_deref())
                            .filter(|p| accepted.contains(p))
                            .or_else(|| accepted.first().copied());
                        primary == Some(lane.id.as_str())
                    })
                    .cloned()
                    .collect();
                if !members.is_empty() {
                    out.push(Row::Entry {
                        id: lane.id.clone(),
                        depth: 0,
                    });
                    used.extend(members.iter().cloned());
                    if !folded.contains(&lane.id) {
                        out.extend(members.into_iter().map(|id| Row::Entry { id, depth: 1 }));
                    }
                }
            }
            let loose: Vec<_> = leaves.into_iter().filter(|id| !used.contains(id)).collect();
            if !loose.is_empty() {
                out.push(Row::Section(Section::Unassigned));
                out.extend(loose.into_iter().map(|id| Row::Entry { id, depth: 0 }));
            }
        } else {
            out.push(Row::Section(Section::Residents));
            let mut pending: Vec<_> = root
                .children
                .iter()
                .rev()
                .map(|id| (id.clone(), 0))
                .collect();
            let mut seen = BTreeSet::new();
            while let Some((id, depth)) = pending.pop() {
                if !seen.insert(id.clone()) {
                    continue;
                }
                let Some(child) = v.levels.get(&id) else {
                    if display == Display::List {
                        out.push(Row::Entry { id, depth });
                    } else if let Some(Row::Tiles {
                        ids,
                        depth: row_depth,
                    }) = out.last_mut()
                        && *row_depth == depth
                        && ids.len() < columns.max(1)
                    {
                        ids.push(id);
                    } else {
                        out.push(Row::Tiles {
                            ids: vec![id],
                            depth,
                        });
                    }
                    continue;
                };
                if display == Display::Islands {
                    let mut members = Vec::new();
                    let mut todo: Vec<_> = child
                        .children
                        .iter()
                        .chain(&child.members)
                        .rev()
                        .cloned()
                        .collect();
                    let mut visited = BTreeSet::from([id.clone()]);
                    if !folded.contains(&id) {
                        while let Some(member) = todo.pop() {
                            if !visited.insert(member.clone()) {
                                continue;
                            }
                            if let Some(l) = v.levels.get(&member) {
                                todo.extend(l.children.iter().chain(&l.members).rev().cloned());
                            }
                            members.push(member);
                        }
                    }
                    out.push(Row::Island { id, members });
                } else {
                    out.push(Row::Entry {
                        id: id.clone(),
                        depth,
                    });
                    if !folded.contains(&id) {
                        pending.extend(
                            child
                                .children
                                .iter()
                                .rev()
                                .map(|id| (id.clone(), depth + 1)),
                        );
                    }
                }
            }
        }
        if !root.members.is_empty() {
            out.push(Row::Section(Section::Members));
            for id in &root.members {
                out.push(Row::Entry {
                    id: id.clone(),
                    depth: 0,
                });
            }
        }
        out
    }

    pub struct LevelDisplay {
        pub host: LevelHost,
        pub display: Display,
        pub grouped: bool,
        pub folded: BTreeSet<String>,
        pub rows: Rc<Vec<Row>>,
        list: ListState,
        scroll: ScrollHandle,
    }

    pub fn register(cx: &mut App) {
        for (name, kind) in [
            ("list", Display::List),
            ("grid", Display::Grid),
            ("island", Display::Islands),
        ] {
            dr_shell::v3::add_level_display(cx, name, move |host, _, cx| make(host, kind, cx));
        }
    }

    pub fn make(host: LevelHost, display: Display, cx: &mut App) -> Rendered {
        let view = cx.new(|_| LevelDisplay::new(host, display));
        let weak = view.downgrade();
        Rendered::new(view).on_refresh(move |book, cx| {
            let _ = weak.update(cx, |this, cx| this.refresh(book, cx));
        })
    }

    impl LevelDisplay {
        pub fn new(host: LevelHost, display: Display) -> Self {
            let mut this = Self {
                host,
                display,
                grouped: false,
                folded: BTreeSet::new(),
                rows: Rc::default(),
                list: ListState::new(0, ListAlignment::Top, px(300.0)),
                scroll: ScrollHandle::new(),
            };
            this.rebuild();
            this
        }
        fn rebuild(&mut self) {
            let columns = if self.host.surface == DisplaySurface::Sidebar {
                2
            } else {
                4
            };
            let rows = rows(
                &self.host.page.book,
                &self.host.level,
                self.display,
                self.grouped,
                &self.folded,
                columns,
            );
            // Keep the visible entry anchored when a book event inserts or
            // removes rows above it. reset() alone clears GPUI's anchor.
            if *self.rows != rows {
                let mut offset = self.list.logical_scroll_top();
                if let Some(row) = self.rows.get(offset.item_ix)
                    && let Some(index) = rows.iter().position(|next| next == row)
                {
                    offset.item_ix = index;
                }
                offset.item_ix = offset.item_ix.min(rows.len().saturating_sub(1));
                self.list.reset(rows.len());
                self.list.scroll_to(offset);
                self.rows = Rc::new(rows);
            } else {
                // Tile names can change wrapping without changing row IDs.
                self.list.remeasure_items(0..rows.len());
            }
        }
        pub fn scroll_state(&self) -> ListState {
            self.list.clone()
        }
        pub fn refresh(&mut self, book: Rc<Book>, cx: &mut Context<Self>) {
            self.host.page.book = book;
            self.rebuild();
            cx.notify();
        }
        pub fn toggle(&mut self, id: &str, cx: &mut Context<Self>) {
            if !self.folded.remove(id) {
                self.folded.insert(id.into());
            }
            self.rebuild();
            cx.notify();
        }
        fn entry(&self, id: &str, depth: usize, tile: bool, cx: &mut App) -> AnyElement {
            let Some(v) = self.host.page.book.v3() else {
                return div().into_any_element();
            };
            let Some(entry) = v.entry(id) else {
                return div().into_any_element();
            };
            let Some(target) = entry_target(id) else {
                return div().into_any_element();
            };
            let (mark, color) = self.host.page.book.mark(&target);
            let weak = self.host.page.workspace.clone();
            let card_ws = weak.upgrade();
            let selected = card_ws
                .as_ref()
                .is_some_and(|ws| ws.read(cx).nav.is_selected(&target));
            let open = target.clone();
            let cell = SandCell::new(
                SharedString::from(format!("g2-entry-{}-{id}", self.host.level)),
                entry.title.clone(),
            )
            .mark(mark)
            .color_opt(color)
            .selected(selected)
            .font(if v.levels.contains_key(id) {
                Role::Structure
            } else {
                Role::Ui
            })
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
            let cell = if let Some(ws) = card_ws {
                dr_shell::workspace::page_hover_card(
                    format!("g2-card-{}-{id}", self.host.level),
                    cell,
                    &target,
                    &ws,
                    Default::default(),
                    cx,
                )
            } else {
                cell.into_any_element()
            };
            div()
                .pl(px(depth.min(20) as f32 * 14.0))
                .min_w_0()
                .when(tile, |el| {
                    el.min_w(px(super::tile_basis(&entry.title)))
                        .max_w(px(172.0))
                        .flex_1()
                })
                .child(cell)
                .into_any_element()
        }
        fn heading(&self, section: Section, cx: &App) -> SharedString {
            t(
                cx,
                match section {
                    Section::Residents => keys::v3_levels::RESIDENTS,
                    Section::Members => keys::v3_levels::MEMBERS,
                    Section::Unassigned => keys::v3_levels::UNASSIGNED,
                },
            )
        }
        fn row(
            &self,
            row: &Row,
            entity: &Entity<Self>,
            window: &mut Window,
            cx: &mut App,
        ) -> AnyElement {
            let theme = Theme::of(window, cx);
            match row {
                Row::Section(section) => div()
                    .h(px(32.0))
                    .pt_2()
                    .font_role(Role::Structure)
                    .text_color(theme.palette.muted().solid())
                    .child(self.heading(*section, cx))
                    .into_any_element(),
                Row::Entry { id, depth } => {
                    let mut row = div().flex().items_center().min_w_0();
                    if self
                        .host
                        .page
                        .book
                        .v3()
                        .is_some_and(|v| v.levels.contains_key(id))
                    {
                        let weak = entity.downgrade();
                        let id = id.clone();
                        let folded = self.folded.contains(&id);
                        let name = self
                            .host
                            .page
                            .book
                            .v3()
                            .and_then(|v| v.entry(&id))
                            .map(|e| e.title.clone())
                            .unwrap_or_default();
                        row = row.child(
                            IconButton::new(
                                SharedString::from(format!("g2-fold-{id}")),
                                if folded {
                                    Icon::ChevronRight
                                } else {
                                    Icon::ChevronDown
                                },
                            )
                            .label(dr_shell::strings::tf(
                                cx,
                                if folded {
                                    keys::v3_levels::EXPAND
                                } else {
                                    keys::v3_levels::COLLAPSE
                                },
                                &[("name", &name)],
                            ))
                            .on_click(move |_, _, cx| {
                                let _ = weak.update(cx, |this, cx| this.toggle(&id, cx));
                            }),
                        );
                    }
                    row.child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(self.entry(id, *depth, false, cx)),
                    )
                    .into_any_element()
                }
                Row::Tiles { ids, depth } => div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .py_1()
                    .pl(px(*depth as f32 * 14.0))
                    .children(ids.iter().map(|id| self.entry(id, 0, true, cx)))
                    .into_any_element(),
                Row::Island { id, members } => {
                    let color = entry_target(id)
                        .and_then(|t| self.host.page.book.mark(&t).1)
                        .unwrap_or(theme.palette.accent);
                    div()
                        .relative()
                        .mx_2()
                        .my_2()
                        .p_2()
                        .child(
                            div().absolute().inset_0().child(
                                SandFrame::new(SharedString::from(format!("g2-island-{id}")), true)
                                    .color(color),
                            ),
                        )
                        .child(self.row(
                            &Row::Entry {
                                id: id.clone(),
                                depth: 0,
                            },
                            entity,
                            window,
                            cx,
                        ))
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .gap_1()
                                .children(members.iter().map(|id| self.entry(id, 0, true, cx))),
                        )
                        .into_any_element()
                }
            }
        }
        fn board(&self, cx: &mut App) -> AnyElement {
            let Some(v) = self.host.page.book.v3() else {
                return div().into_any_element();
            };
            let Some(level) = v.levels.get(&self.host.level) else {
                return div().into_any_element();
            };
            let mut seen = BTreeSet::new();
            let ids: Vec<_> = level
                .children
                .iter()
                .chain(&level.members)
                .filter(|id| seen.insert(*id))
                .collect();
            let positions: Vec<_> = ids
                .iter()
                .enumerate()
                .map(|(index, id)| {
                    v.entry(id)
                        .and_then(|e| e.layout.board)
                        .unwrap_or(((index % 3) as f64 * 192.0, (index / 3) as f64 * 76.0))
                })
                .collect();
            // A negative saved coordinate is still on the canvas: translate
            // the viewport, rather than piling negative cards at (0, 0).
            let origin = positions
                .iter()
                .fold((0.0_f64, 0.0_f64), |(x, y), p| (x.min(p.0), y.min(p.1)));
            let mut board = div().relative().min_w(px(600.0)).min_h(px(480.0));
            let mut width: f32 = 600.0;
            let mut height: f32 = 480.0;
            for (id, position) in ids.iter().zip(&positions) {
                let (x, y) = (
                    (position.0 - origin.0) as f32 + 8.0,
                    (position.1 - origin.1) as f32 + 8.0,
                );
                width = width.max(x + 188.0);
                height = height.max(y + 72.0);
                board = board.child(
                    div()
                        .absolute()
                        .left(px(x))
                        .top(px(y))
                        .w(px(180.0))
                        .p_2()
                        .child(self.entry(id, 0, false, cx)),
                );
            }
            div()
                .id("g2-board-scroll")
                .overflow_scroll()
                .track_scroll(&self.scroll)
                .size_full()
                .child(board.w(px(width)).h(px(height)))
                .into_any_element()
        }
    }

    impl Render for LevelDisplay {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let mut root = div()
                .flex()
                .flex_col()
                .min_h_0()
                .w_full()
                .when(self.host.surface == DisplaySurface::Sidebar, |el| {
                    el.h_full()
                })
                .when(self.host.surface == DisplaySurface::Page, |el| {
                    el.h(px(440.0))
                });
            if self.host.surface == DisplaySurface::Sidebar {
                // The selected root is itself an entry: open its level page
                // and use exactly the same common card as its descendants.
                root = root.child(self.entry(&self.host.level, 0, false, cx));
            }
            if self.display == Display::List
                && self
                    .host
                    .page
                    .book
                    .v3()
                    .and_then(|v| v.levels.get(&self.host.level))
                    .is_some_and(|l| l.settings.is_manuscript)
            {
                let weak = cx.entity().downgrade();
                root = root.child(
                    Segmented::new(
                        "g2-list-order",
                        [
                            t(cx, keys::v3_levels::MANUSCRIPT_ORDER),
                            t(cx, keys::v3_levels::BY_STORYLINE),
                        ],
                        usize::from(self.grouped),
                    )
                    .on_change(move |index, _, cx| {
                        let _ = weak.update(cx, |this, cx| {
                            this.grouped = index == 1;
                            this.rebuild();
                            cx.notify();
                        });
                    }),
                );
            }
            let body = if self.display == Display::Board {
                self.board(cx)
            } else {
                let rows = self.rows.clone();
                let weak = cx.entity().downgrade();
                list(self.list.clone(), move |i, window, cx| {
                    weak.upgrade()
                        .map(|entity| {
                            entity.update(cx, |this, cx| this.row(&rows[i], &entity, window, cx))
                        })
                        .unwrap_or_else(|| div().into_any_element())
                })
                .size_full()
                .into_any_element()
            };
            root.child(div().flex_1().min_h_0().child(body))
                .into_any_element()
        }
    }
}
