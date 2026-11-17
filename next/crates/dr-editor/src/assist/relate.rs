//! Relations in the prose (RL, `kernel-v5.md` §19 「指针停在名字上」「就地建
//! 关系」; the chosen prototype is 第 3 版 of `relations-proto.html`).
//!
//! - **Lines.** While a link's hover card is open, every pair of entries
//!   named on screen that a relation joins is drawn: an arc from name to
//!   name in the dry underline's brush (`paint`), the relations' names on it
//!   in a blank between two rows (`·` between several, a small arrow after a
//!   directed one pointing at the end it points to), a dry stroke under each
//!   joined name. Where the lines go is [`geom`]'s. They are worked out
//!   again every frame from what the editor painted, so scrolling moves
//!   them and a name scrolled out of view loses its lines; the card going
//!   takes them. Only entry links count: links to files do not.
//! - **The card's last row 「建关系」** opens the composer: the card goes, and
//!   a bar sits at the bottom of what the editor shows (not scrolling with
//!   the text): this entry, the direction, the other entry (a click on a
//!   name in the prose, every other name outlined meanwhile, or the @ field
//!   searching every live entry of the book), the relation's name (a row of
//!   the names already used above the bar: one click reuses it, the one
//!   chosen lit; a name never used makes a new relation), 取消 and 建立.
//!   A name already used fixes the direction (symmetric: the button does
//!   nothing; directed: it only swaps which entry is on the left); a new one
//!   steps →, ←, ↔. 建立 runs `relation_row.create_pair` (RD's placement
//!   rules; an existing pair writes nothing), one undo step in the book, and
//!   the host is told the row ([`AssistEvent::RelationPlaced`]) to show it
//!   in the right column. The lines of this entry stay a moment after.
//!   Esc or 取消 leaves.
//! - **A rail row pointed at** ([`RelationFocus`]): the right column's
//!   relations card says which row the pointer rests on; the prose draws
//!   that row's pairs the same way.

pub mod geom;
mod paint;

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;
use std::time::Duration;

use dr_model::shared::normalize_relation_type_name;
use dr_model::v3::RelationDirection;
use dr_text::autolink::LinkTarget;
use dr_ui::components::menu::{float_shadow, slab_edge};
use dr_ui::components::{Align, Button, Layer, Place};
use dr_ui::fonts::{Role, weight};
use dr_ui::glass::{self, Ground, Kind as GlassKind, Mode, Spec, Tone};
use dr_ui::input::{FieldEvent, TextField};
use dr_ui::sand::{self, Icon, KindMark};
use dr_ui::style::DrStyled as _;
use dr_ui::theme::Theme;
use dr_ui::tokens::{Rgb, radius};
use dr_workspace::Actor;
use dr_workspace::commands::v3::relations::{CreatePair, Definition, PairIn};
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, Global, InteractiveElement,
    IntoElement, ParentElement, Pixels, ScrollHandle, SharedString, StatefulInteractiveElement,
    Styled, Subscription, Task, Window, canvas, deferred, div, point, px, size,
};

pub use geom::{Curve, Label, Name};

use super::{Assist, AssistEvent};

/// How long a new relation's lines stay after 建立 (the prototype's 2.6 s).
pub const LINGER: Duration = Duration::from_millis(2600);
/// The composer's width, and its gap above the bottom of the view.
const BAR_WIDTH: f32 = 600.0;
const BAR_GAP: f32 = 14.0;
/// Rows of the @ field's list.
const MAX_CANDIDATES: usize = 6;

/// The words of the relation layer, from the host (dr-editor has no
/// locale); the Chinese ones until a host sets them.
#[derive(Clone, Debug)]
pub struct RelationLabels {
    /// The card's row and nothing else: 「建关系」.
    pub create: SharedString,
    /// 「建立」.
    pub confirm: SharedString,
    /// 「取消」.
    pub cancel: SharedString,
    /// The direction button's name for assistive tools: 「方向」.
    pub direction: SharedString,
    /// The @ field's name: 「另一个条目」.
    pub other_entry: SharedString,
    /// The relation name field's name: 「关系」.
    pub relation: SharedString,
    /// The chosen entry's ×: 「换一个」.
    pub change: SharedString,
}

impl Default for RelationLabels {
    fn default() -> Self {
        RelationLabels {
            create: "建关系".into(),
            confirm: "建立".into(),
            cancel: "取消".into(),
            direction: "方向".into(),
            other_entry: "另一个条目".into(),
            relation: "关系".into(),
            change: "换一个".into(),
        }
    }
}

/// The right column's relation row the pointer rests on (`kernel-v5.md`
/// §19 「指针停在一行上」): the prose draws that row's pairs. The rail sets
/// it with [`RelationFocus::point`]; every editor of the window follows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RelationFocus {
    pub row: Option<String>,
}

impl Global for RelationFocus {}

impl RelationFocus {
    /// The row pointed at now (`None`: none).
    pub fn point(row: Option<String>, cx: &mut App) {
        if cx.try_global::<RelationFocus>().map(|f| &f.row) != Some(&row) {
            cx.set_global(RelationFocus { row });
        }
    }

    pub fn row(cx: &App) -> Option<String> {
        cx.try_global::<RelationFocus>().and_then(|f| f.row.clone())
    }
}

/// One relation of the book as the composer offers it.
#[derive(Clone, Debug, PartialEq)]
pub struct RelationKind {
    pub id: String,
    pub name: String,
    pub normalized: String,
    pub symmetric: bool,
}

/// A live entry the @ field finds.
#[derive(Clone, Debug, PartialEq)]
pub struct EntryInfo {
    pub id: String,
    pub title: String,
    /// Its template's name, after the title in the list.
    pub kind: String,
    /// Its template's colour, for its mark.
    pub color: Option<Rgb>,
}

/// What the book says about relations, read once after each change.
#[derive(Debug, Default)]
pub struct Index {
    /// Oldest first.
    pub kinds: Vec<RelationKind>,
    /// Unordered pair of live entries → the relations between them.
    pairs: HashMap<(String, String), Vec<Label>>,
    /// Row id → its pairs of live entries and their label.
    rows: HashMap<String, HashMap<(String, String), Vec<Label>>>,
    /// Live entries, in the book's order.
    pub entries: Vec<EntryInfo>,
}

impl Index {
    fn read(ws: &dr_workspace::Workspace, book: &str) -> Option<Index> {
        crate::v3::read(ws, book, |v| {
            let templates = v.templates_map();
            let mut live: HashMap<String, EntryInfo> = HashMap::new();
            let mut entries = Vec::new();
            for e in v.entries() {
                if e.is_trashed() {
                    continue;
                }
                let t = e.effective_template(&templates);
                let info = EntryInfo {
                    id: e.id.to_string(),
                    title: e.title.clone(),
                    kind: t.map(|t| t.name.clone()).unwrap_or_default(),
                    color: t.and_then(|t| t.color.as_deref()).and_then(hex),
                };
                live.insert(info.id.clone(), info.clone());
                entries.push(info);
            }
            let mut types = v.relation_types();
            types.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
            let kinds: Vec<RelationKind> = types
                .iter()
                .map(|t| RelationKind {
                    id: t.id.to_string(),
                    name: t.name.clone(),
                    normalized: t.normalized_name.clone(),
                    symmetric: t.direction == RelationDirection::Symmetric,
                })
                .collect();
            let rows = v.relations();
            let mut index = Index {
                kinds,
                entries,
                ..Index::default()
            };
            for t in &types {
                let symmetric = t.direction == RelationDirection::Symmetric;
                for row in rows.iter().filter(|r| r.relation_type == t.id) {
                    let mut of_row: HashMap<(String, String), Vec<Label>> = HashMap::new();
                    for (l, r) in row.pairs() {
                        let (l, r) = (l.to_string(), r.to_string());
                        if l == r || !live.contains_key(&l) || !live.contains_key(&r) {
                            continue;
                        }
                        let label = Label {
                            name: t.name.clone(),
                            to: (!symmetric).then(|| r.clone()),
                        };
                        let key = geom::pair_key(&l, &r);
                        for list in [
                            index.pairs.entry(key.clone()).or_default(),
                            of_row.entry(key).or_default(),
                        ] {
                            if !list.contains(&label) {
                                list.push(label.clone());
                            }
                        }
                    }
                    index.rows.insert(row.id.to_string(), of_row);
                }
            }
            index
        })
        .ok()
    }

    pub fn entry(&self, id: &str) -> Option<&EntryInfo> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// The relation called `name` (as names are compared), if there is one.
    pub fn kind_named(&self, name: &str) -> Option<&RelationKind> {
        let n = normalize_relation_type_name(name);
        (!n.is_empty())
            .then(|| self.kinds.iter().find(|k| k.normalized == n))
            .flatten()
    }
}

fn hex(s: &str) -> Option<Rgb> {
    let h = s.trim_start_matches('#');
    (h.len() == 6)
        .then(|| u32::from_str_radix(h, 16).ok().map(Rgb::hex))
        .flatten()
}

/// Which way a new pair goes: this entry → the other, the other → this
/// entry, or both ways.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    To,
    From,
    Both,
}

impl Dir {
    pub fn glyph(self) -> &'static str {
        match self {
            Dir::To => "→",
            Dir::From => "←",
            Dir::Both => "↔",
        }
    }
}

/// The composer while it is open.
pub(crate) struct Compose {
    src: String,
    src_at: Option<(usize, SharedString)>,
    dst: Option<String>,
    dst_at: Option<(usize, SharedString)>,
    name: String,
    dir: Dir,
    query: String,
    at_field: Entity<TextField>,
    name_field: Entity<TextField>,
    busy: bool,
    _subs: Vec<Subscription>,
}

/// The composer as tests and the debug bridge read it.
#[derive(Clone, Debug, PartialEq)]
pub struct ComposeState {
    pub src: String,
    pub dst: Option<String>,
    pub name: String,
    pub dir: Dir,
    /// Whether the direction button does anything.
    pub dir_locked: bool,
    /// The @ field's list: entry ids.
    pub candidates: Vec<String>,
    /// The row of used names above the bar, and which is lit.
    pub names: Vec<(String, bool)>,
    pub ready: bool,
}

/// A line as it was drawn.
#[derive(Clone, Debug, PartialEq)]
pub struct DrawnLine {
    pub a: Name,
    pub b: Name,
    pub labels: Vec<Label>,
    pub curve: Curve,
    /// Where the names on it sit (their middle).
    pub label_at: (f32, f32),
}

/// What the relation layer drew last frame (for tests).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Drawn {
    pub lines: Vec<DrawnLine>,
    /// Names with a dry stroke under them.
    pub joined: Vec<Name>,
    /// Names outlined to be picked (while composing).
    pub picks: Vec<Name>,
    /// The dashed line to the chosen other entry.
    pub pending: Option<(Name, Name)>,
    /// The blanks between rows the names were placed on.
    pub blanks: Vec<f32>,
}

/// The relation layer of one editor (held by its [`Assist`]).
pub(crate) struct Relate {
    labels: RelationLabels,
    index: Option<Rc<Index>>,
    compose: Option<Compose>,
    /// After 建立: this entry's lines, at this occurrence, a moment longer.
    linger: Option<(String, Option<(usize, SharedString)>)>,
    linger_task: Option<Task<()>>,
    /// The editor's bounds (its wrap), recorded each frame.
    pub(super) viewport: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The page a flow body scrolls in: what of the body shows.
    page: Option<ScrollHandle>,
    strokes: Rc<RefCell<paint::Strokes>>,
    drawn: Option<Drawn>,
    /// The card's side, fixed when it opened: (link, above).
    card_side: Option<((usize, SharedString), bool)>,
    /// How many times the book was read (for tests).
    pub reads: usize,
    _focus: Option<Subscription>,
}

impl Relate {
    pub(super) fn new() -> Relate {
        Relate {
            labels: RelationLabels::default(),
            index: None,
            compose: None,
            linger: None,
            linger_task: None,
            viewport: Rc::new(Cell::new(None)),
            page: None,
            strokes: Rc::default(),
            drawn: None,
            card_side: None,
            reads: 0,
            _focus: None,
        }
    }

    pub(super) fn invalidate(&mut self) {
        self.index = None;
    }

    pub(super) fn composing(&self) -> bool {
        self.compose.is_some()
    }

    pub(super) fn card_closed(&mut self) {
        self.card_side = None;
    }
}

/// The box of a name painted over `boxes` (its widest row).
fn main_box(boxes: &[Bounds<Pixels>]) -> Option<Bounds<Pixels>> {
    boxes
        .iter()
        .copied()
        .max_by(|a, b| a.size.width.partial_cmp(&b.size.width).unwrap_or(std::cmp::Ordering::Equal))
}

fn shows(view: &Bounds<Pixels>, r: &Bounds<Pixels>) -> bool {
    r.top() >= view.top() - px(2.)
        && r.bottom() <= view.bottom() + px(2.)
        && r.right() > view.left()
        && r.left() < view.right()
}

fn intersect(a: Bounds<Pixels>, b: Bounds<Pixels>) -> Option<Bounds<Pixels>> {
    let l = a.left().max(b.left());
    let t = a.top().max(b.top());
    let r = a.right().min(b.right());
    let bo = a.bottom().min(b.bottom());
    (r > l && bo > t).then(|| Bounds::from_corners(point(l, t), point(r, bo)))
}

/// What is to be drawn: whose lines, joined where.
enum Focus {
    /// The lines of `entry` (at that occurrence when it is on screen).
    Entry(String, Option<(usize, SharedString)>),
    /// The pairs of one row.
    Row(String),
}

impl Assist {
    /// Sets the relation layer's words.
    pub fn set_relation_labels(&mut self, labels: RelationLabels) {
        self.relate.labels = labels;
    }

    /// The card's last row: 「建关系」.
    pub(super) fn relate_label(&self) -> SharedString {
        self.relate.labels.create.clone()
    }

    /// The page a flow body scrolls in, so the lines and the composer keep
    /// to what of the body shows.
    pub fn set_page(&mut self, page: Option<ScrollHandle>) {
        self.relate.page = page;
    }

    /// Follows the right column's pointed row.
    pub(super) fn watch_relation_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.relate._focus = Some(cx.observe_global_in::<RelationFocus>(window, |_, _, cx| {
            cx.notify()
        }));
    }

    fn relation_index(&mut self) -> Option<Rc<Index>> {
        if self.relate.index.is_none() {
            self.relate.reads += 1;
            self.relate.index = Index::read(&self.ws, &self.book).map(Rc::new);
        }
        self.relate.index.clone()
    }

    /// The book's relations and live entries as the layer read them.
    pub fn relation_book(&mut self) -> Option<Rc<Index>> {
        self.relation_index()
    }

    /// What the layer drew last frame.
    pub fn relation_drawn(&self) -> Option<&Drawn> {
        self.relate.drawn.as_ref()
    }

    /// What is visible of this editor (window coordinates), by the last
    /// frame.
    fn relation_view(&self) -> Option<Bounds<Pixels>> {
        let own = self.relate.viewport.get()?;
        match &self.relate.page {
            Some(page) => intersect(own, page.bounds()),
            None => Some(own),
        }
    }

    /// The linked entry names painted on screen in the last frame.
    fn screen_names(&self, view: &Bounds<Pixels>, index: &Index, cx: &App) -> Vec<Name> {
        let painted = self.editor.read(cx).painted_group("links");
        painted
            .into_iter()
            // `l…` are entity links; `f…` links to files, which never count.
            .filter(|d| d.key.id.starts_with('l'))
            .filter_map(|d| {
                let rect = main_box(&d.boxes)?;
                if !shows(view, &rect) {
                    return None;
                }
                let target: LinkTarget = self.link_target(d.chapter, &d.key.id, cx)?;
                if target.kind != dr_model::kind::EntityKind::Entry || index.entry(&target.id).is_none() {
                    return None;
                }
                Some(Name {
                    entry: target.id,
                    chapter: d.chapter,
                    id: d.key.id.clone(),
                    rect,
                })
            })
            .collect()
    }

    /// What is drawn now: the composer's entry, the open card's, the one
    /// lingering after 建立, or a rail row.
    fn relation_focus(&self, cx: &App) -> Option<Focus> {
        if let Some(c) = &self.compose_ref() {
            return Some(Focus::Entry(c.src.clone(), c.src_at.clone()));
        }
        if let Some(card) = &self.card
            && card.facts.target.kind == dr_model::kind::EntityKind::Entry
        {
            return Some(Focus::Entry(
                card.facts.target.id.clone(),
                Some((card.chapter, card.id.clone())),
            ));
        }
        if let Some((entry, at)) = &self.relate.linger {
            return Some(Focus::Entry(entry.clone(), at.clone()));
        }
        RelationFocus::row(cx).map(Focus::Row)
    }

    fn compose_ref(&self) -> Option<&Compose> {
        self.relate.compose.as_ref()
    }

    /// Works out this frame's lines (from the last frame's paint).
    fn draw_relations(&mut self, cx: &App) -> Option<(Drawn, Bounds<Pixels>)> {
        let focus = self.relation_focus(cx)?;
        let view = self.relation_view()?;
        let index = self.relate.index.clone()?;
        let names = self.screen_names(&view, &index, cx);
        let rows = self.editor.read(cx).painted_rows();
        let blanks = geom::blanks(
            &rows
                .into_iter()
                .filter(|r| r.bottom() > view.top() && r.top() < view.bottom())
                .collect::<Vec<_>>(),
        );
        let middle = {
            let c = view.center();
            (f32::from(c.x), f32::from(c.y))
        };
        let (focus_ix, pairs) = match &focus {
            Focus::Entry(entry, at) => {
                let ix = at
                    .as_ref()
                    .and_then(|(ch, id)| {
                        names
                            .iter()
                            .position(|n| n.chapter == *ch && &n.id == id && &n.entry == entry)
                    })
                    .or_else(|| names.iter().position(|n| &n.entry == entry));
                (ix, &index.pairs)
            }
            Focus::Row(row) => (None, index.rows.get(row)?),
        };
        let anchors = geom::anchors(&names, focus_ix, middle);
        let edges = geom::edges(&names, &anchors, pairs);
        let curves: Vec<Curve> = edges
            .iter()
            .map(|e| geom::curve(&names[e.a].rect, &names[e.b].rect))
            .collect();
        let widths: Vec<f32> = edges.iter().map(|e| geom::label_width(&e.labels)).collect();
        let at = geom::place_labels(&curves, &widths, &blanks);
        let mut joined: Vec<Name> = Vec::new();
        let mut join = |n: &Name| {
            if !joined.contains(n) {
                joined.push(n.clone());
            }
        };
        let mut lines = Vec::with_capacity(edges.len());
        for ((e, c), p) in edges.iter().zip(curves).zip(at) {
            join(&names[e.a]);
            join(&names[e.b]);
            lines.push(DrawnLine {
                a: names[e.a].clone(),
                b: names[e.b].clone(),
                labels: e.labels.clone(),
                curve: c,
                label_at: p,
            });
        }
        let mut picks = Vec::new();
        let mut pending = None;
        if let Some(c) = &self.relate.compose {
            let src = focus_ix.map(|ix| names[ix].clone());
            if let Some(src) = &src {
                join(src);
            }
            picks = names
                .iter()
                .filter(|n| src.as_ref() != Some(*n))
                .cloned()
                .collect();
            if let (Some(src), Some(dst)) = (&src, &c.dst) {
                let at = c
                    .dst_at
                    .as_ref()
                    .and_then(|(ch, id)| {
                        names
                            .iter()
                            .find(|n| n.chapter == *ch && &n.id == id && &n.entry == dst)
                    })
                    .or_else(|| {
                        let of: Vec<&Name> = names.iter().filter(|n| &n.entry == dst).collect();
                        of.into_iter().min_by(|a, b| {
                            let d = |n: &Name| {
                                let (x, y) = (n.rect.center().x - src.rect.center().x, n.rect.center().y - src.rect.center().y);
                                f32::from(x).hypot(f32::from(y) * 1.4)
                            };
                            d(a).total_cmp(&d(b))
                        })
                    });
                pending = at.map(|d| (src.clone(), d.clone()));
            }
        }
        Some((
            Drawn {
                lines,
                joined,
                picks,
                pending,
                blanks,
            },
            view,
        ))
    }

    /// The card's side: above when more of its lines go down. Fixed when
    /// the card first shows its lines.
    pub(super) fn card_goes_above(&mut self) -> bool {
        let Some(card) = &self.card else {
            return false;
        };
        let key = (card.chapter, card.id.clone());
        if let Some((k, above)) = &self.relate.card_side
            && *k == key
        {
            return *above;
        }
        let Some(drawn) = &self.relate.drawn else {
            return false;
        };
        let names: Vec<Name> = drawn
            .lines
            .iter()
            .flat_map(|l| [l.a.clone(), l.b.clone()])
            .collect();
        let Some(me) = names.iter().position(|n| n.chapter == key.0 && n.id == key.1) else {
            return false;
        };
        let mut uniq: Vec<Name> = Vec::new();
        for n in names {
            if !uniq.contains(&n) {
                uniq.push(n);
            }
        }
        let me = uniq
            .iter()
            .position(|n| n.chapter == key.0 && n.id == key.1)
            .unwrap_or(me);
        let edges: Vec<geom::Edge> = drawn
            .lines
            .iter()
            .filter_map(|l| {
                Some(geom::Edge {
                    a: uniq.iter().position(|n| *n == l.a)?,
                    b: uniq.iter().position(|n| *n == l.b)?,
                    labels: l.labels.clone(),
                })
            })
            .collect();
        let above = geom::card_above(&uniq, &edges, me);
        self.relate.card_side = Some((key, above));
        above
    }

    // ----- the composer --------------------------------------------------------------

    /// The open card's 「建关系」: the card goes and the composer opens for
    /// its entry.
    pub fn start_relation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(card) = self.card.clone() else {
            return;
        };
        if card.facts.target.kind != dr_model::kind::EntityKind::Entry {
            return;
        }
        self.close_card();
        self.open_compose(card.facts.target.id.clone(), Some((card.chapter, card.id)), window, cx);
    }

    /// Opens the composer for `entry` (at that occurrence).
    pub fn open_compose(
        &mut self,
        entry: String,
        at: Option<(usize, SharedString)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.relate.linger = None;
        self.relate.linger_task = None;
        self.relation_index();
        let at_field = cx.new(|cx| TextField::new("dr-editor-relation-at", window, cx).bare());
        let name_field = cx.new(|cx| {
            TextField::new("dr-editor-relation-name", window, cx).icon(Icon::KnotLinks)
        });
        let subs = vec![
            cx.subscribe_in(&at_field, window, |a, _, e: &FieldEvent, window, cx| match e {
                FieldEvent::Changed(text) => a.relation_query_changed(text.clone(), cx),
                FieldEvent::Cancelled => a.close_compose(window, cx),
                _ => {}
            }),
            cx.subscribe_in(&name_field, window, |a, _, e: &FieldEvent, window, cx| match e {
                FieldEvent::Changed(text) => a.relation_name_changed(text.clone(), cx),
                FieldEvent::Cancelled => a.close_compose(window, cx),
                _ => {}
            }),
        ];
        self.relate.compose = Some(Compose {
            src: entry,
            src_at: at,
            dst: None,
            dst_at: None,
            name: String::new(),
            dir: Dir::To,
            query: String::new(),
            at_field,
            name_field,
            busy: false,
            _subs: subs,
        });
        cx.notify();
    }

    /// Esc, 取消: the composer goes; the keyboard back to the prose.
    pub fn close_compose(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.relate.compose.take().is_some() {
            let focus = gpui::Focusable::focus_handle(self.editor.read(cx), cx);
            window.focus(&focus, cx);
            cx.notify();
        }
    }

    pub(super) fn drop_compose(&mut self) {
        self.relate.compose = None;
    }

    /// The composer's state.
    pub fn compose_state(&mut self) -> Option<ComposeState> {
        let index = self.relation_index().unwrap_or_default();
        let c = self.relate.compose.as_ref()?;
        let kind = index.kind_named(&c.name);
        let q = c.name.trim().to_lowercase();
        let exact = kind.is_some();
        let names = index
            .kinds
            .iter()
            .filter(|k| exact || q.is_empty() || k.name.to_lowercase().contains(&q))
            .map(|k| (k.name.clone(), kind.is_some_and(|m| m.id == k.id)))
            .collect();
        let candidates = if c.dst.is_some() {
            Vec::new()
        } else {
            candidates(&index, &c.src, &c.query)
        };
        Some(ComposeState {
            src: c.src.clone(),
            dst: c.dst.clone(),
            name: c.name.clone(),
            dir: c.dir,
            dir_locked: kind.is_some_and(|k| k.symmetric),
            candidates,
            names,
            ready: c.dst.is_some() && !c.name.trim().is_empty() && !c.busy,
        })
    }

    /// Picks `entry` as the other end (a click on its name, or its row in
    /// the @ field's list). This entry itself is never picked.
    pub fn relation_pick(
        &mut self,
        entry: &str,
        at: Option<(usize, SharedString)>,
        cx: &mut Context<Self>,
    ) {
        let Some(c) = self.relate.compose.as_mut() else {
            return;
        };
        if c.src == entry {
            return;
        }
        c.dst = Some(entry.to_owned());
        c.dst_at = at;
        cx.notify();
    }

    /// The chosen entry's ×: back to the @ field.
    pub fn relation_unpick(&mut self, cx: &mut Context<Self>) {
        if let Some(c) = self.relate.compose.as_mut() {
            c.dst = None;
            c.dst_at = None;
            c.query.clear();
            let field = c.at_field.clone();
            field.update(cx, |f, cx| f.set_text("", cx));
            cx.notify();
        }
    }

    /// Types `text` into the @ field.
    pub fn set_relation_query(&mut self, text: &str, cx: &mut Context<Self>) {
        let Some(c) = self.relate.compose.as_ref() else {
            return;
        };
        let field = c.at_field.clone();
        field.update(cx, |f, cx| f.set_text(text, cx));
        self.relation_query_changed(text.to_owned(), cx);
    }

    fn relation_query_changed(&mut self, text: String, cx: &mut Context<Self>) {
        if let Some(c) = self.relate.compose.as_mut() {
            c.query = text.trim().to_owned();
            cx.notify();
        }
    }

    /// Types `text` into the relation name field.
    pub fn set_relation_name(&mut self, text: &str, cx: &mut Context<Self>) {
        let Some(c) = self.relate.compose.as_ref() else {
            return;
        };
        let field = c.name_field.clone();
        field.update(cx, |f, cx| f.set_text(text, cx));
        self.relation_name_changed(text.to_owned(), cx);
    }

    fn relation_name_changed(&mut self, text: String, cx: &mut Context<Self>) {
        let index = self.relation_index().unwrap_or_default();
        if let Some(c) = self.relate.compose.as_mut() {
            c.name = text.trim().to_owned();
            // A used name fixes the direction.
            match index.kind_named(&c.name) {
                Some(k) if k.symmetric => c.dir = Dir::Both,
                Some(_) if c.dir == Dir::Both => c.dir = Dir::To,
                _ => {}
            }
            cx.notify();
        }
    }

    /// The direction button: a used directed name swaps the ends; a new
    /// name steps →, ←, ↔; a used symmetric name stays.
    pub fn relation_flip(&mut self, cx: &mut Context<Self>) {
        let index = self.relation_index().unwrap_or_default();
        let Some(c) = self.relate.compose.as_mut() else {
            return;
        };
        c.dir = match (index.kind_named(&c.name), c.dir) {
            (Some(k), _) if k.symmetric => Dir::Both,
            (Some(_), Dir::To) => Dir::From,
            (Some(_), _) => Dir::To,
            (None, Dir::To) => Dir::From,
            (None, Dir::From) => Dir::Both,
            (None, Dir::Both) => Dir::To,
        };
        cx.notify();
    }

    /// 建立: the pair is written through `relation_row.create_pair`; the
    /// host is told the row. Whether anything was placed.
    pub fn relation_commit(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(state) = self.compose_state().filter(|s| s.ready) else {
            return false;
        };
        let index = self.relation_index().unwrap_or_default();
        let (left, right) = match state.dir {
            Dir::From => (state.dst.clone().expect("ready"), state.src.clone()),
            _ => (state.src.clone(), state.dst.clone().expect("ready")),
        };
        let (relation_type, new_type) = match index.kind_named(&state.name) {
            Some(k) => (Some(k.id.clone()), None),
            None => (
                None,
                Some(Definition {
                    name: state.name.clone(),
                    description: Default::default(),
                    direction: if state.dir == Dir::Both {
                        RelationDirection::Symmetric
                    } else {
                        RelationDirection::Directed
                    },
                }),
            ),
        };
        let placed = self.ws.run::<CreatePair>(
            &Actor::User,
            PairIn {
                book: self.book.clone(),
                left,
                right,
                relation_type,
                new_type,
            },
        );
        let placed = match placed {
            Ok(p) => p,
            Err(e) => {
                log::warn!("relation_row.create_pair: {e}");
                return false;
            }
        };
        let (src, src_at) = self
            .relate
            .compose
            .as_ref()
            .map(|c| (c.src.clone(), c.src_at.clone()))
            .expect("composing");
        self.close_compose(window, cx);
        self.relate.index = None;
        self.relate.linger = Some((src, src_at));
        self.relate.linger_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(LINGER).await;
            this.update(cx, |a, cx| {
                a.relate.linger = None;
                cx.notify();
            })
            .ok();
        }));
        cx.emit(AssistEvent::RelationPlaced {
            row: placed.output.id,
        });
        cx.notify();
        true
    }

    // ----- drawing --------------------------------------------------------------------

    /// The lines, their names, the outlined names and the composer, onto
    /// the assist's overlay root.
    pub(super) fn relation_overlay(
        &mut self,
        mut root: gpui::Div,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if self.relation_focus(cx).is_some() {
            self.relation_index();
        }
        let drawn = self.draw_relations(cx);
        let Some((drawn, view)) = drawn else {
            self.relate.drawn = None;
            if !self.relate.strokes.borrow().is_empty() {
                self.relate.strokes.borrow_mut().clear(window);
            }
            return self.compose_bar(root, window, cx);
        };
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let origin = self.assist_origin.get();
        let dark = if p.dark { 0.72 } else { 1.0 };
        let ink = p.sand_on(p.ink(2), p.page).to_u8();
        let mut scene = paint::Scene::default();
        for line in &drawn.lines {
            scene
                .paths
                .push((paint::Path::Arc(line.curve), paint::LINE_BREADTH, 0.7 * dark * p.pigment));
        }
        for n in &drawn.joined {
            let y = f32::from(n.rect.bottom()) - 1.0;
            scene.paths.push((
                paint::Path::Straight(
                    (f32::from(n.rect.left()) - 1.0, y),
                    (f32::from(n.rect.right()) + 1.0, y),
                ),
                paint::NAME_BREADTH,
                0.55 * dark * p.pigment,
            ));
        }
        scene.dashed = drawn
            .pending
            .as_ref()
            .map(|(a, b)| geom::curve(&a.rect, &b.rect));
        let strokes = self.relate.strokes.clone();
        let dash = p.accent.alpha(0.9);
        let (vx, vy) = (view.left(), view.top());
        let rel = |x: f32, y: f32| (px(x) - vx, px(y) - vy);
        let mut layer = div()
            .absolute()
            .left(vx - origin.x)
            .top(vy - origin.y)
            .w(view.size.width)
            .h(view.size.height)
            .overflow_hidden()
            .child(
                canvas(
                    |_, _, _| {},
                    move |_, _, window, cx| strokes.borrow_mut().paint(&scene, ink, dash, window, cx),
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        // The relations' names, on their lines.
        let label_ink = p.ink(1).solid();
        let arrow_ink = p.ink(2).solid();
        let sep_ink = p.ink(4).solid();
        let halo = p.page.alpha(0.88);
        for (ix, line) in drawn.lines.iter().enumerate() {
            let (x, y) = rel(line.label_at.0, line.label_at.1);
            let mut label = div()
                .flex()
                .flex_row()
                .items_center()
                .h(px(14.))
                .px(px(3.))
                .rounded(px(7.))
                .bg(halo)
                .font_role(Role::Ui)
                .type_px(11.5, 14.)
                .weight(weight::MEDIUM)
                .text_color(label_ink)
                .whitespace_nowrap();
            for (i, l) in line.labels.iter().enumerate() {
                if i > 0 {
                    label = label.child(div().mx(px(2.)).text_color(sep_ink).child("·"));
                }
                label = label.child(SharedString::from(l.name.clone()));
                if let Some(to) = &l.to {
                    let target = if &line.a.entry == to { &line.a } else { &line.b };
                    let c = target.rect.center();
                    let angle = (f32::from(c.y) - line.label_at.1)
                        .atan2(f32::from(c.x) - line.label_at.0);
                    label = label.child(
                        sand::icon(Icon::ArrowForward, 10., arrow_ink)
                            .ml(px(2.))
                            .with_transformation(gpui::Transformation::rotate(gpui::radians(angle))),
                    );
                }
            }
            layer = layer.child(
                div()
                    .id(("dr-editor-relation-label", ix))
                    .debug_selector(move || format!("dr-editor-relation-label-{ix}"))
                    .absolute()
                    .left(x - px(200.))
                    .top(y - px(7.))
                    .w(px(400.))
                    .h(px(14.))
                    .flex()
                    .justify_center()
                    .child(label),
            );
        }
        // While composing: every other name outlined, to be clicked.
        if self.relate.compose.is_some() {
            let index = self.relate.index.clone().unwrap_or_default();
            let hair = p.hairline();
            let accent = p.accent.solid();
            let chosen = drawn.pending.as_ref().map(|(_, d)| d.clone());
            for (ix, n) in drawn.picks.iter().enumerate() {
                let (x, y) = rel(f32::from(n.rect.left()), f32::from(n.rect.top()));
                let title: SharedString = index
                    .entry(&n.entry)
                    .map(|e| e.title.clone())
                    .unwrap_or_default()
                    .into();
                let this = cx.entity();
                let (entry, at) = (n.entry.clone(), (n.chapter, n.id.clone()));
                let lit = chosen.as_ref() == Some(n);
                layer = layer.child(
                    div()
                        .id(("dr-editor-relation-pick", ix))
                        .debug_selector(move || format!("dr-editor-relation-pick-{ix}"))
                        .absolute()
                        .left(x - px(1.))
                        .top(y - px(1.))
                        .w(n.rect.size.width + px(2.))
                        .h(n.rect.size.height + px(2.))
                        .rounded(px(3.))
                        .border_1()
                        .border_color(if lit { accent } else { hair })
                        .hover(move |s| s.border_color(accent))
                        .cursor_pointer()
                        .role(gpui::Role::Button)
                        .aria_label(title)
                        .on_click(move |_, _, cx| {
                            this.update(cx, |a, cx| a.relation_pick(&entry, Some(at.clone()), cx));
                        }),
                );
            }
        }
        root = root.child(deferred(layer).with_priority(1));
        self.relate.drawn = Some(drawn);
        self.compose_bar(root, window, cx)
    }

    /// The composer docked at the bottom of what the editor shows.
    fn compose_bar(&mut self, root: gpui::Div, window: &mut Window, cx: &mut Context<Self>) -> gpui::Div {
        let Some(state) = self.compose_state() else {
            return root;
        };
        let Some(view) = self.relation_view() else {
            return root;
        };
        let index = self.relate.index.clone().unwrap_or_default();
        let (at_field, name_field) = {
            let c = self.relate.compose.as_ref().expect("composing");
            (c.at_field.clone(), c.name_field.clone())
        };
        let labels = self.relate.labels.clone();
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let this = cx.entity();
        let mark = |id: &str, key: &str| {
            let color = index.entry(id).and_then(|e| e.color);
            let m = KindMark::new(SharedString::from(format!("dr-editor-relation-mark-{key}-{id}")), sand::Kind::Category);
            match color {
                Some(c) => m.color(c),
                None => m,
            }
        };
        let title = |id: &str| -> SharedString {
            index.entry(id).map(|e| e.title.clone()).unwrap_or_default().into()
        };
        let chip = |id: &str, key: &str| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(5.))
                .h(px(26.))
                .px(px(9.))
                .rounded(px(13.))
                .bg(p.page.solid())
                .font_role(Role::Ui)
                .type_px(14., 22.)
                .text_color(p.ink(1).solid())
                .child(mark(id, key))
                .child(title(id))
        };
        // The list of the @ field, above everything.
        let mut list = div().flex().flex_col().max_h(px(124.)).overflow_hidden();
        for (ix, id) in state.candidates.iter().enumerate() {
            let entry = id.clone();
            let this = this.clone();
            let kind: SharedString = index.entry(id).map(|e| e.kind.clone()).unwrap_or_default().into();
            list = list.child(
                div()
                    .id(("dr-editor-relation-candidate", ix))
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .min_h(px(28.))
                    .px(px(8.))
                    .py(px(3.))
                    .rounded(px(4.))
                    .font_role(Role::Ui)
                    .type_px(15., 22.)
                    .text_color(p.ink(2).solid())
                    .cursor_pointer()
                    .hover(move |s| s.bg(p.ink(1).alpha(0.05)).text_color(p.ink(1).solid()))
                    .role(gpui::Role::Button)
                    .aria_label(title(id))
                    .child(mark(id, "row"))
                    .child(div().flex_1().min_w_0().truncate().child(title(id)))
                    .child(
                        div()
                            .flex_none()
                            .font_role(Role::Index)
                            .type_px(13., 18.)
                            .text_color(p.ink(4).solid())
                            .child(kind),
                    )
                    .on_click(move |_, _, cx| {
                        this.update(cx, |a, cx| a.relation_pick(&entry, None, cx));
                    }),
            );
        }
        // The names already used.
        let mut kinds = div().flex().flex_row().flex_wrap().gap(px(4.));
        for (ix, (name, on)) in state.names.iter().enumerate() {
            let glyph = index
                .kind_named(name)
                .map(|k| if k.symmetric { Dir::Both } else { Dir::To })
                .unwrap_or(Dir::To)
                .glyph();
            let picked = name.clone();
            let this = this.clone();
            let on = *on;
            let ring = p.ink(3).solid();
            kinds = kinds.child(
                div()
                    .id(("dr-editor-relation-kind", ix))
                    .h(px(24.))
                    .px(px(9.))
                    .rounded(px(12.))
                    .flex()
                    .items_center()
                    .bg(p.page.solid())
                    .font_role(Role::Ui)
                    .type_px(13., 24.)
                    .text_color(if on { p.ink(1) } else { p.ink(2) }.solid())
                    .when(on, |d| d.border_1().border_color(ring))
                    .when(!on, |d| {
                        d.hover(move |s| s.text_color(p.ink(1).solid()).border_1().border_color(p.hairline()))
                    })
                    .cursor_pointer()
                    .role(gpui::Role::Button)
                    .aria_label(SharedString::from(name.clone()))
                    .child(SharedString::from(name.clone()))
                    .child(
                        div()
                            .ml(px(4.))
                            .font_role(Role::Index)
                            .text_color(p.ink(4).solid())
                            .child(glyph),
                    )
                    .on_click(move |_, _, cx| {
                        this.update(cx, |a, cx| a.set_relation_name(&picked, cx));
                    }),
            );
        }
        // The other entry: chosen, or the @ field.
        let other: AnyElement = match &state.dst {
            Some(dst) => {
                let this = this.clone();
                chip(dst, "dst")
                    .child(
                        div()
                            .id("dr-editor-relation-unpick")
                            .flex()
                            .cursor_pointer()
                            .role(gpui::Role::Button)
                            .aria_label(labels.change.clone())
                            .child(sand::icon(Icon::Close, 12., p.ink(4).solid()))
                            .on_click(move |_, _, cx| this.update(cx, |a, cx| a.relation_unpick(cx))),
                    )
                    .into_any_element()
            }
            None => {
                let focused = gpui::Focusable::focus_handle(at_field.read(cx), cx).is_focused(window);
                glass::glass_box(
                    "dr-editor-relation-at-box",
                    GlassKind::Rest,
                    Mode::default(),
                    focused,
                    Spec::new(Tone::Clear, radius::SM).filled(p.page),
                    window,
                    cx,
                )
                .flex_1()
                .min_w_0()
                .h(px(30.))
                .px(px(10.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(radius::SM))
                .bg(p.page.solid())
                .role(gpui::Role::Group)
                .aria_label(labels.other_entry.clone())
                .child(
                    div()
                        .font_role(Role::Index)
                        .type_px(14., 22.)
                        .text_color(p.ink(4).solid())
                        .child("@"),
                )
                .child(div().flex_1().min_w_0().child(at_field.clone()))
                .into_any_element()
            }
        };
        let flip = this.clone();
        let cancel = this.clone();
        let commit = this.clone();
        let line = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.))
            .child(chip(&state.src, "src"))
            .child(
                div()
                    .flex_none()
                    .role(gpui::Role::Group)
                    .aria_label(labels.direction.clone())
                    .child(
                        Button::new("dr-editor-relation-dir", state.dir.glyph())
                            .small()
                            .disabled(state.dir_locked)
                            .on_click(move |_, _, cx| {
                                flip.update(cx, |a, cx| a.relation_flip(cx))
                            }),
                    ),
            )
            .child(div().flex_1().min_w_0().flex().child(other))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .role(gpui::Role::Group)
                    .aria_label(labels.relation.clone())
                    .child(name_field),
            )
            .child(
                Button::new("dr-editor-relation-cancel", labels.cancel.clone())
                    .text()
                    .on_click(move |_, window, cx| {
                        cancel.update(cx, |a, cx| a.close_compose(window, cx))
                    }),
            )
            .child(
                Button::new("dr-editor-relation-confirm", labels.confirm.clone())
                    .primary()
                    .disabled(!state.ready)
                    .on_click(move |_, window, cx| {
                        commit.update(cx, |a, cx| {
                            a.relation_commit(window, cx);
                        })
                    }),
            );
        let width = BAR_WIDTH.min(f32::from(view.size.width) - 24.0).max(240.0);
        let bar = glass::surface(
            Ground::flat(p.desk),
            div()
                .id("dr-editor-relation-bar")
                .debug_selector(|| "dr-editor-relation-bar".into())
                .occlude()
                .w(px(width))
                .relative()
                .rounded(px(radius::SHEET))
                .shadow(float_shadow(p))
                .px(px(10.))
                .py(px(8.))
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(slab_edge(p, radius::SHEET))
                .when(!state.candidates.is_empty(), |d| d.child(list))
                .when(!state.names.is_empty(), |d| d.child(kinds))
                .child(line),
        );
        let bottom = Bounds::new(
            point(view.left(), view.bottom()),
            size(view.size.width, px(0.)),
        );
        root.child(dr_ui::components::float(
            Place::Above {
                rect: bottom,
                align: Align::Center,
                gap: BAR_GAP,
            },
            Layer::Popover,
            bar,
        ))
    }
}

/// The @ field's list: live entries other than `src` whose title holds
/// `query` (case aside), at most six.
fn candidates(index: &Index, src: &str, query: &str) -> Vec<String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let mut seen = BTreeSet::new();
    index
        .entries
        .iter()
        .filter(|e| e.id != src && e.title.to_lowercase().contains(&q))
        .filter(|e| seen.insert(e.id.clone()))
        .take(MAX_CANDIDATES)
        .map(|e| e.id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> Index {
        let e = |id: &str, title: &str| EntryInfo {
            id: id.into(),
            title: title.into(),
            kind: "人物".into(),
            color: None,
        };
        Index {
            kinds: vec![RelationKind {
                id: "k1".into(),
                name: "Enemy".into(),
                normalized: normalize_relation_type_name("Enemy"),
                symmetric: true,
            }],
            entries: vec![e("aq", "阿Q"), e("xd", "小D"), e("xn", "小尼姑"), e("wh", "王胡")],
            ..Index::default()
        }
    }

    #[test]
    fn the_at_field_finds_live_entries_but_not_this_one() {
        let i = index();
        assert_eq!(candidates(&i, "aq", "小"), ["xd", "xn"]);
        assert!(candidates(&i, "aq", "").is_empty());
        assert!(candidates(&i, "xd", "小D").is_empty());
    }

    #[test]
    fn names_are_compared_as_the_book_compares_them() {
        let i = index();
        assert_eq!(i.kind_named(" enemy ").map(|k| k.id.as_str()), Some("k1"));
        assert!(i.kind_named("").is_none());
        assert!(i.kind_named("Friend").is_none());
    }
}
