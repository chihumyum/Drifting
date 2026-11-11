//! Read-only oracle for the mapping in kernel-v3.md, independent of K1.
//!
//! These are test expectations, not v3 storage types. References identify
//! source rows (or required synthetic roots), never allocate target UUIDs,
//! module ids, position keys or Loro documents. A future import test must
//! compare its actual v3 result to this data, not just compare totals.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use dr_import_v1::{Result, handoff::BookSettings, legacy::Legacy, prose::pm};
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum Entry {
    Manuscript,
    Ideas,
    Elements,
    Storylines,
    Act(String),
    Node(String),
    IdeaGroup(String),
    Category(String),
    Element(String),
    ElementGroup { category: String, name: String },
    Storyline(String),
    Unaffiliated,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub enum LeafTemplate {
    Chapter,
    Idea,
    Category(String),
    Storyline(String),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub enum Layout {
    Board(f64, f64),
    Grid {
        mode: String,
        x: Option<i64>,
        y: Option<i64>,
    },
    Graph(f64, f64),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Level {
    pub entry: Entry,
    pub parent: Option<Entry>,
    pub title: String,
    /// Legacy rank/boundary, not a new timeline or tree coordinate.
    pub order: Option<f64>,
    pub color: Option<String>,
    pub default_leaf: Option<LeafTemplate>,
    pub lane: bool,
    pub layout: Option<Layout>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Field {
    pub old_id: String,
    pub name: String,
    /// Old string value; no inferred v3 field type or new module id.
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Leaf {
    pub entry: Entry,
    /// None is unresolved, not a decision to put an orphan at the root.
    pub home: Option<Entry>,
    pub template: Option<LeafTemplate>,
    pub title: String,
    pub order: Option<f64>,
    pub summary: String,
    pub status: Option<String>,
    pub aliases: Vec<String>,
    pub portrait: Option<String>,
    pub fields: Vec<Field>,
    pub kv: Vec<Field>,
    pub layout: Option<Layout>,
    pub deleted_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Template {
    pub template: LeafTemplate,
    pub name: String,
    /// Additional legacy fields. Built-in modules belong to K1's project
    /// template; an empty list here does not remove those modules.
    pub fields: Vec<Field>,
    /// The projection retains field ordering, including duplicates.
    pub field_projection: Option<String>,
    pub initial_body: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Membership {
    pub member: Entry,
    pub level: Entry,
    pub primary: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Placement {
    pub entry: Entry,
    pub at: f64,
    /// Old nodes have no duration. Do not invent one.
    pub span: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Pin {
    pub old_id: String,
    pub at: f64,
    pub label: String,
    /// timeline_marker has no color column.
    pub color: Option<String>,
    pub entry: Option<Entry>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct View {
    /// Ordered old storylines, plus the required synthetic lane if needed.
    pub lanes: Vec<Entry>,
    pub placements: Vec<Placement>,
    pub pins: Vec<Pin>,
    pub book_order_view: bool,
    pub act_rail: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub enum Body {
    Leaf(Entry),
    About(Entry),
    Material(String),
    Template(LeafTemplate),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Prose {
    pub source: String,
    pub target: Body,
    /// Preserve the complete old JSON, including marks and block ids.
    pub json: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub enum Endpoint {
    Entry(Entry),
    Material(String),
    Comment(String),
    Patch(String),
    Unresolved { kind: String, id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Relation {
    pub old_id: String,
    pub from: Endpoint,
    pub to: Endpoint,
    pub relation_type: String,
    /// Symmetric endpoints compare as an unordered pair after target ids
    /// are assigned; their original source order remains available here.
    pub orientation: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ActBinding {
    pub act: Entry,
    pub idea: Entry,
    // Deliberately no type/direction: the mapping does not decide them.
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Comment {
    pub old_id: String,
    pub kind: String,
    pub target: Option<Endpoint>,
    /// Which prose module owns the old anchor (if it targets prose).
    pub body: Option<Body>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Patch {
    pub old_id: String,
    pub owner: Entry,
    pub source: Option<Body>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlotGrid {
    pub old_id: String,
    pub entry: Entry,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Pending {
    pub code: String,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Manifest {
    pub book: String,
    pub levels: Vec<Level>,
    pub leaves: Vec<Leaf>,
    pub leaf_templates: Vec<Template>,
    pub memberships: Vec<Membership>,
    pub default_view: View,
    pub act_bindings: Vec<ActBinding>,
    pub relations: Vec<Relation>,
    pub comments: Vec<Comment>,
    pub patches: Vec<Patch>,
    pub plot_grids: Vec<PlotGrid>,
    pub prose: Vec<Prose>,
    pub settings: BookSettings,
    /// Source evidence only; this retired UI preference creates no view.
    pub retired_timeline_view: Option<String>,
    /// Full authored rows for the mapping's final "contents unchanged" row.
    /// No Yjs bytes, credentials or machine-local tables are read here.
    pub source_rows: BTreeMap<String, Vec<Value>>,
    pub pending: Vec<Pending>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Counts {
    pub levels: usize,
    pub leaves: usize,
    pub leaf_templates: usize,
    pub memberships: usize,
    pub primaries: usize,
    pub lanes: usize,
    pub placements: usize,
    pub pins: usize,
    pub act_binding_relations: usize,
    pub patches: usize,
    pub plot_grids: usize,
    pub notes: usize,
    pub todos: usize,
    pub existing_relations: usize,
    pub materials: usize,
    pub folders: usize,
    pub assets: usize,
    pub memory: usize,
    pub writing_days: usize,
}

impl Manifest {
    pub fn counts(&self) -> Counts {
        let n = |table: &str| self.source_rows[table].len();
        Counts {
            levels: self.levels.len(),
            leaves: self.leaves.len(),
            leaf_templates: self.leaf_templates.len(),
            memberships: self.memberships.len(),
            primaries: self.memberships.iter().filter(|m| m.primary).count(),
            lanes: self.default_view.lanes.len(),
            placements: self.default_view.placements.len(),
            pins: self.default_view.pins.len(),
            act_binding_relations: self.act_bindings.len(),
            patches: n("element_patch"),
            plot_grids: n("plot_grid_document"),
            notes: self.source_rows["comment"]
                .iter()
                .filter(|r| r["kind"] == "note")
                .count(),
            todos: self.source_rows["comment"]
                .iter()
                .filter(|r| r["kind"] == "todo")
                .count(),
            existing_relations: self.relations.len(),
            materials: n("library_item"),
            folders: n("material_folder"),
            assets: n("project_asset"),
            memory: n("agent_memory"),
            writing_days: n("writing_day"),
        }
    }
}

fn pending(out: &mut Manifest, code: &str, source: &str) {
    out.pending.push(Pending {
        code: code.into(),
        source: source.into(),
    });
}

/// Only the old schema is queried. Opening read-only also makes accidental
/// writes fail, even if a future helper were to try one.
pub fn read(path: &Path, book: &str) -> Result<Manifest> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.pragma_update(None, "query_only", true)?;
    let old = Legacy::new(conn)?;
    let rows = old.book(book)?;
    let mut out = Manifest {
        book: book.into(),
        levels: Vec::new(),
        leaves: Vec::new(),
        leaf_templates: vec![
            Template {
                template: LeafTemplate::Chapter,
                name: "章".into(),
                fields: vec![],
                field_projection: None,
                initial_body: None,
            },
            Template {
                template: LeafTemplate::Idea,
                name: "构想".into(),
                fields: vec![],
                field_projection: None,
                initial_body: None,
            },
        ],
        memberships: Vec::new(),
        act_bindings: Vec::new(),
        relations: Vec::new(),
        prose: Vec::new(),
        comments: Vec::new(),
        patches: Vec::new(),
        plot_grids: Vec::new(),
        default_view: View {
            lanes: vec![],
            placements: vec![],
            pins: vec![],
            book_order_view: false,
            act_rail: false,
        },
        settings: old
            .stamp
            .as_ref()
            .and_then(|s| s.books.get(book))
            .cloned()
            .unwrap_or_default(),
        retired_timeline_view: old
            .stamp
            .as_ref()
            .and_then(|s| s.settings.get("timeline-view"))
            .cloned(),
        source_rows: authored_rows(&old.conn, book)?,
        pending: Vec::new(),
    };
    let level = |entry, parent, title: String, order, color, default_leaf, lane, layout| Level {
        entry,
        parent,
        title,
        order,
        color,
        default_leaf,
        lane,
        layout,
    };
    for (entry, title, template) in [
        (Entry::Manuscript, "书稿", Some(LeafTemplate::Chapter)),
        (Entry::Ideas, "构想", Some(LeafTemplate::Idea)),
        (Entry::Elements, "要素", None),
        (Entry::Storylines, "故事线", None),
    ] {
        out.levels.push(level(
            entry,
            None,
            title.into(),
            None,
            None,
            template,
            false,
            None,
        ));
    }
    let mut acts: Vec<_> = rows.acts.iter().collect();
    acts.sort_by(|a, b| {
        a.start_order
            .partial_cmp(&b.start_order)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.id.cmp(&b.id))
    });
    for act in &acts {
        out.levels.push(level(
            Entry::Act(act.id.clone()),
            Some(Entry::Manuscript),
            act.name.clone(),
            act.start_order,
            act.color.clone(),
            Some(LeafTemplate::Chapter),
            false,
            None,
        ));
        if act.start_order.is_none() {
            pending(&mut out, "act-without-boundary", &act.id);
        }
        if let Some(idea) = &act.drift {
            out.act_bindings.push(ActBinding {
                act: Entry::Act(act.id.clone()),
                idea: Entry::Node(idea.clone()),
            });
            pending(&mut out, "act-binding-relation-type-and-direction", &act.id);
        }
    }
    for pair in acts.windows(2) {
        if pair[0].start_order.is_some() && pair[0].start_order == pair[1].start_order {
            pending(&mut out, "duplicate-act-boundary", &pair[1].id);
        }
    }
    for group in &rows.groups {
        out.levels.push(level(
            Entry::IdeaGroup(group.id.clone()),
            Some(
                group
                    .parent
                    .as_ref()
                    .map(|p| Entry::IdeaGroup(p.clone()))
                    .unwrap_or(Entry::Ideas),
            ),
            group.name.clone(),
            group.order,
            group.color.clone(),
            Some(LeafTemplate::Idea),
            false,
            None,
        ));
    }
    for cat in &rows.categories {
        let template = LeafTemplate::Category(cat.id.clone());
        let fs = fields(
            &rows,
            "element-category",
            &cat.id,
            "element-template",
            &cat.template_kv_json,
        )?;
        let mut names = BTreeSet::new();
        if fs.iter().any(|f| !names.insert(&f.name)) {
            pending(&mut out, "duplicate-category-field-name", &cat.id);
        }
        out.leaf_templates.push(Template {
            template: template.clone(),
            name: cat.name.clone(),
            fields: fs,
            field_projection: Some(cat.template_kv_json.clone()),
            initial_body: cat.template_json.clone(),
        });
        out.levels.push(level(
            Entry::Category(cat.id.clone()),
            Some(Entry::Elements),
            cat.name.clone(),
            None,
            Some(cat.color.clone()),
            Some(template),
            false,
            Some(Layout::Grid {
                mode: cat.layout.clone(),
                x: cat.grid_x,
                y: cat.grid_y,
            }),
        ));
    }
    for line in &rows.storylines {
        let default_leaf = match nonempty_body(&line.template) {
            Ok(true) => {
                let template = LeafTemplate::Storyline(line.id.clone());
                out.leaf_templates.push(Template {
                    template: template.clone(),
                    name: line.name.clone(),
                    fields: vec![],
                    field_projection: None,
                    initial_body: Some(line.template.clone()),
                });
                Some(template)
            }
            Ok(false) => Some(LeafTemplate::Chapter),
            Err(_) => {
                pending(&mut out, "unreadable-storyline-template", &line.id);
                None
            }
        };
        out.levels.push(level(
            Entry::Storyline(line.id.clone()),
            Some(Entry::Storylines),
            line.name.clone(),
            Some(line.order_key as f64),
            Some(line.color.clone()),
            default_leaf,
            true,
            None,
        ));
        out.default_view
            .lanes
            .push(Entry::Storyline(line.id.clone()));
    }
    for node in &rows.nodes {
        let (home, template, layout) = match node.kind.as_str() {
            "chapter" => {
                let home = node.book_order.and_then(|at| {
                    let act = acts
                        .iter()
                        .rev()
                        .find(|a| a.start_order.is_some_and(|start| start <= at));
                    if let Some(act) = act {
                        if acts
                            .iter()
                            .filter(|a| a.start_order == act.start_order)
                            .count()
                            > 1
                        {
                            return None;
                        }
                        Some(Entry::Act(act.id.clone()))
                    } else {
                        Some(Entry::Manuscript)
                    }
                });
                if node.book_order.is_none() {
                    pending(&mut out, "chapter-without-book-order", &node.id);
                }
                (home, Some(LeafTemplate::Chapter), None)
            }
            "drift" => (
                Some(
                    node.group
                        .as_ref()
                        .map(|g| Entry::IdeaGroup(g.clone()))
                        .unwrap_or(Entry::Ideas),
                ),
                Some(LeafTemplate::Idea),
                Some(Layout::Board(node.x, node.y)),
            ),
            _ => {
                pending(&mut out, "unknown-node-kind", &node.id);
                (None, None, None)
            }
        };
        out.leaves.push(Leaf {
            entry: Entry::Node(node.id.clone()),
            home,
            template,
            title: node.title.clone(),
            order: if node.kind == "chapter" {
                node.book_order
            } else {
                None
            },
            summary: node.summary.clone(),
            status: Some(node.status.clone()),
            aliases: vec![],
            portrait: None,
            fields: vec![],
            kv: vec![],
            layout,
            deleted_at: node.deleted_at.clone(),
        });
        if node.kind == "drift" && node.book_order.is_some() {
            pending(&mut out, "idea-has-legacy-book-order", &node.id);
        }
        let links: Vec<_> = rows.links.iter().filter(|l| l.node == node.id).collect();
        for link in &links {
            out.memberships.push(Membership {
                member: Entry::Node(node.id.clone()),
                level: Entry::Storyline(link.storyline.clone()),
                primary: link.primary,
            });
        }
        if links.iter().filter(|l| l.primary).count() > 1 {
            pending(&mut out, "multiple-primary-storylines", &node.id);
        }
        if let Some(at) = node.narrative_order {
            if links.is_empty() {
                out.memberships.push(Membership {
                    member: Entry::Node(node.id.clone()),
                    level: Entry::Unaffiliated,
                    primary: false,
                });
            }
            out.default_view.placements.push(Placement {
                entry: Entry::Node(node.id.clone()),
                at,
                span: None,
            });
        }
    }
    if out
        .memberships
        .iter()
        .any(|m| m.level == Entry::Unaffiliated)
    {
        // Actual 0.1 timeline label: bottomTimeline.synthetic.unaffiliated.
        // Author settled 11-11 (#23): placed last under the storylines root,
        // using the storyline template and level settings.
        out.levels.push(level(
            Entry::Unaffiliated,
            Some(Entry::Storylines),
            "未归属".into(),
            None,
            None,
            Some(LeafTemplate::Chapter),
            true,
            None,
        ));
        out.default_view.lanes.push(Entry::Unaffiliated);
    }
    let mut groups = BTreeSet::new();
    for element in &rows.elements {
        let category = element
            .category
            .as_ref()
            .filter(|id| rows.categories.iter().any(|c| &c.id == *id));
        let mut home = category.map(|id| Entry::Category(id.clone()));
        if let Some(category) = category {
            if let Some(name) = element.group_name.as_ref().filter(|n| !n.is_empty()) {
                let group = Entry::ElementGroup {
                    category: category.clone(),
                    name: name.clone(),
                };
                if groups.insert(group.clone()) {
                    out.levels.push(level(
                        group.clone(),
                        home.clone(),
                        name.clone(),
                        None,
                        None,
                        None,
                        false,
                        None,
                    ));
                }
                home = Some(group);
            }
        } else {
            pending(&mut out, "element-without-category", &element.id);
        }
        let names: BTreeSet<_> = out
            .leaf_templates
            .iter()
            .filter(|t| category.is_some_and(|id| t.template == LeafTemplate::Category(id.clone())))
            .flat_map(|t| t.fields.iter().map(|f| f.name.clone()))
            .collect();
        let (field_values, kv) = fields(&rows, "element", &element.id, "facts", &element.kv_json)?
            .into_iter()
            .partition(|f| names.contains(&f.name));
        let mut seen = BTreeSet::new();
        if rows
            .kv
            .iter()
            .filter(|f| {
                f.owner_kind == "element" && f.owner_id == element.id && names.contains(&f.key)
            })
            .any(|f| !seen.insert(&f.key))
        {
            pending(&mut out, "multiple-values-for-one-field", &element.id);
        }
        let pin = out
            .settings
            .element_pins
            .get(&element.id)
            .map(|&(x, y)| Layout::Graph(x, y));
        out.leaves.push(Leaf {
            entry: Entry::Element(element.id.clone()),
            home,
            template: category.map(|id| LeafTemplate::Category(id.clone())),
            title: element.name.clone(),
            order: None,
            summary: element.summary.clone(),
            status: None,
            aliases: serde_json::from_str(&element.aliases_json)?,
            portrait: element.portrait.clone(),
            fields: field_values,
            kv,
            layout: pin,
            deleted_at: element.deleted_at.clone(),
        });
    }
    for pin in &rows.time_pins {
        out.default_view.pins.push(Pin {
            old_id: pin.id.clone(),
            at: pin.narrative_order,
            label: pin.label.clone(),
            color: None,
            entry: pin.drift.as_ref().map(|id| Entry::Node(id.clone())),
        });
    }
    for relation in &rows.relations {
        out.relations.push(Relation {
            old_id: relation.id.clone(),
            from: endpoint(&relation.from_kind, &relation.from_id),
            to: endpoint(&relation.to_kind, &relation.to_id),
            relation_type: relation.relation_type.clone(),
            orientation: rows
                .relation_types
                .iter()
                .find(|t| t.id == relation.relation_type)
                .map(|t| t.orientation.clone())
                .unwrap_or_default(),
        });
    }
    for comment in &rows.comments {
        let target = comment
            .target_kind
            .as_deref()
            .zip(comment.target_id.as_deref());
        let body = target.and_then(|(kind, id)| match kind {
            "node" => Some(Body::Leaf(Entry::Node(id.into()))),
            "element" => Some(Body::Leaf(Entry::Element(id.into()))),
            "category" => Some(Body::About(Entry::Category(id.into()))),
            "storyline" => Some(Body::About(Entry::Storyline(id.into()))),
            "library_item"
                if rows
                    .materials
                    .iter()
                    .any(|m| m.id == id && m.kind == "text") =>
            {
                Some(Body::Material(id.into()))
            }
            _ => None,
        });
        out.comments.push(Comment {
            old_id: comment.id.clone(),
            kind: comment.kind.clone(),
            target: target.map(|(kind, id)| endpoint(kind, id)),
            body,
        });
    }
    for patch in &rows.patches {
        out.patches.push(Patch {
            old_id: patch.id.clone(),
            owner: Entry::Element(patch.element.clone()),
            source: patch
                .source_node
                .as_ref()
                .map(|id| Body::Leaf(Entry::Node(id.clone()))),
        });
    }
    for grid in &rows.plot_docs {
        out.plot_grids.push(PlotGrid {
            old_id: grid.id.clone(),
            entry: Entry::Node(grid.node.clone()),
        });
    }
    let (owners, _) = old.prose_owners()?;
    for owner in owners.iter().filter(|o| o.project_id == book) {
        use dr_import_v1::legacy::ProseKind;
        let target = match owner.kind {
            ProseKind::NodeContent => Body::Leaf(Entry::Node(owner.id.clone())),
            ProseKind::Element => Body::Leaf(Entry::Element(owner.id.clone())),
            ProseKind::Category => Body::About(Entry::Category(owner.id.clone())),
            ProseKind::Storyline => Body::About(Entry::Storyline(owner.id.clone())),
            ProseKind::LibraryItem => Body::Material(owner.id.clone()),
        };
        out.prose.push(Prose {
            source: owner.old_doc_id(),
            target,
            json: owner.cache.clone(),
        });
    }
    for template in &out.leaf_templates {
        if let Some(body) = &template.initial_body {
            out.prose.push(Prose {
                source: match &template.template {
                    LeafTemplate::Category(id) => {
                        format!("element_category:{id}.element_template_json")
                    }
                    LeafTemplate::Storyline(id) => {
                        format!("storylines:{id}.node_content_template_json")
                    }
                    _ => unreachable!("built-in template has no old JSON"),
                },
                target: Body::Template(template.template.clone()),
                json: Some(body.clone()),
            });
        }
    }
    if rows
        .kv
        .iter()
        .any(|k| k.owner_kind == "project" && k.namespace == "storyline-template")
    {
        pending(
            &mut out,
            "project-storyline-field-template-destination",
            book,
        );
    }
    // Do not silently repair broken parents, links or bindings into a new
    // tree. Keep their records and report what cannot be represented yet.
    validate_references(&mut out);
    Ok(out)
}

pub fn nonempty_body(json: &str) -> Result<bool> {
    Ok(pm::parse(json)?
        .lines
        .iter()
        .any(|l| !l.text.is_empty() || l.atom || l.path.iter().any(|p| p.kind == "table")))
}

/// The old kv table has no rank column: its owner's JSON projection gives
/// the authored order. Preserve every row, including unprojected extras.
fn fields(
    rows: &dr_import_v1::legacy::BookRows,
    kind: &str,
    id: &str,
    namespace: &str,
    projection: &str,
) -> Result<Vec<Field>> {
    let mut left: Vec<_> = rows
        .kv
        .iter()
        .filter(|r| r.owner_kind == kind && r.owner_id == id && r.namespace == namespace)
        .collect();
    let mut ordered = Vec::new();
    for field in serde_json::from_str::<Vec<Value>>(projection)? {
        let key = field["key"].as_str().unwrap_or_default();
        let value = field["value"].as_str().unwrap_or_default();
        let at = left
            .iter()
            .position(|r| r.key == key && r.value == value)
            .or_else(|| left.iter().position(|r| r.key == key));
        if let Some(at) = at {
            ordered.push(left.remove(at));
        }
    }
    ordered.extend(left);
    Ok(ordered
        .into_iter()
        .map(|r| Field {
            old_id: r.id.clone(),
            name: r.key.clone(),
            value: r.value.clone(),
        })
        .collect())
}

fn endpoint(kind: &str, id: &str) -> Endpoint {
    match kind {
        "node" => Endpoint::Entry(Entry::Node(id.into())),
        "element" => Endpoint::Entry(Entry::Element(id.into())),
        "category" => Endpoint::Entry(Entry::Category(id.into())),
        "storyline" => Endpoint::Entry(Entry::Storyline(id.into())),
        "library_item" => Endpoint::Material(id.into()),
        "comment" => Endpoint::Comment(id.into()),
        "patch" => Endpoint::Patch(id.into()),
        _ => Endpoint::Unresolved {
            kind: kind.into(),
            id: id.into(),
        },
    }
}

fn validate_references(out: &mut Manifest) {
    let levels: BTreeMap<_, _> = out
        .levels
        .iter()
        .map(|l| (l.entry.clone(), l.parent.clone()))
        .collect();
    let entries: BTreeSet<_> = levels
        .keys()
        .cloned()
        .chain(out.leaves.iter().map(|l| l.entry.clone()))
        .collect();
    let mut issues = Vec::new();
    for (entry, parent) in levels
        .iter()
        .chain(out.leaves.iter().map(|l| (&l.entry, &l.home)))
    {
        if parent.as_ref().is_some_and(|p| !levels.contains_key(p)) {
            issues.push(("missing-home-level", format!("{entry:?}")));
        }
        let mut seen = BTreeSet::new();
        let mut next = Some(entry.clone());
        while let Some(at) = next {
            if !seen.insert(at.clone()) {
                issues.push(("level-cycle", format!("{entry:?}")));
                break;
            }
            next = levels.get(&at).cloned().flatten();
        }
    }
    for m in &out.memberships {
        if !entries.contains(&m.member) || !levels.contains_key(&m.level) {
            issues.push(("dangling-membership", format!("{m:?}")));
        }
    }
    for b in &out.act_bindings {
        if !entries.contains(&b.idea) {
            issues.push(("dangling-act-binding", format!("{:?}", b.act)));
        }
    }
    for p in &out.default_view.pins {
        if p.entry.as_ref().is_some_and(|e| !entries.contains(e)) {
            issues.push(("dangling-time-pin", p.old_id.clone()));
        }
    }
    let endpoint_exists = |endpoint: &Endpoint| match endpoint {
        Endpoint::Entry(e) => entries.contains(e),
        Endpoint::Material(id) => out.source_rows["library_item"]
            .iter()
            .any(|r| r["id"] == *id),
        Endpoint::Comment(id) => out.source_rows["comment"].iter().any(|r| r["id"] == *id),
        Endpoint::Patch(id) => out.source_rows["element_patch"]
            .iter()
            .any(|r| r["id"] == *id),
        Endpoint::Unresolved { .. } => false,
    };
    for r in &out.relations {
        if !endpoint_exists(&r.from) || !endpoint_exists(&r.to) {
            issues.push(("unrepresentable-relation-endpoint", r.old_id.clone()));
        }
    }
    for c in &out.comments {
        if c.target.as_ref().is_some_and(|t| !endpoint_exists(t)) {
            issues.push(("unrepresentable-comment-target", c.old_id.clone()));
        }
    }
    for (code, source) in issues {
        pending(out, code, &source);
    }
}

/// Select every authored column, scoped to exactly one old book. Values
/// remain old-schema data; JSON columns remain strings, without flattening
/// or discarding rich content. The SQL here never creates a target library.
fn authored_rows(c: &Connection, book: &str) -> Result<BTreeMap<String, Vec<Value>>> {
    let mut out = BTreeMap::new();
    for table in [
        "project",
        "book_node",
        "book_act",
        "drift_group",
        "element_category",
        "element",
        "storylines",
        "timeline_marker",
        "entity_kv_entry",
        "element_patch",
        "comment",
        "comment_action",
        "entity_relation_type",
        "entity_relation",
        "library_item",
        "material_folder",
        "project_asset",
        "agent_memory",
        "writing_day",
    ] {
        let predicate = if table == "project" {
            "id"
        } else {
            "project_id"
        };
        out.insert(
            table.into(),
            sql_rows(
                c,
                &format!("SELECT * FROM {table} WHERE {predicate} = ?1 ORDER BY id"),
                book,
            )?,
        );
    }
    for (table, sql) in [
        (
            "node_content",
            "SELECT x.* FROM node_content x JOIN book_node n ON n.id = x.node_id WHERE n.project_id = ?1 ORDER BY x.node_id",
        ),
        (
            "node_storyline_link",
            "SELECT x.* FROM node_storyline_link x JOIN book_node n ON n.id = x.node_id WHERE n.project_id = ?1 ORDER BY x.node_id, x.storyline_id",
        ),
        (
            "entity_relation_type_endpoint_kind",
            "SELECT x.* FROM entity_relation_type_endpoint_kind x JOIN entity_relation_type t ON t.id = x.relation_type_id WHERE t.project_id = ?1 ORDER BY x.relation_type_id, x.side, x.entity_kind",
        ),
        (
            "plot_grid_document",
            "SELECT x.* FROM plot_grid_document x JOIN book_node n ON n.id = x.node_id WHERE n.project_id = ?1 ORDER BY x.id",
        ),
        (
            "plot_grid_row",
            "SELECT x.* FROM plot_grid_row x JOIN plot_grid_document d ON d.id = x.document_id JOIN book_node n ON n.id = d.node_id WHERE n.project_id = ?1 ORDER BY x.id",
        ),
        (
            "plot_grid_column",
            "SELECT x.* FROM plot_grid_column x JOIN plot_grid_document d ON d.id = x.document_id JOIN book_node n ON n.id = d.node_id WHERE n.project_id = ?1 ORDER BY x.id",
        ),
        (
            "plot_grid_cell",
            "SELECT x.* FROM plot_grid_cell x JOIN plot_grid_document d ON d.id = x.document_id JOIN book_node n ON n.id = d.node_id WHERE n.project_id = ?1 ORDER BY x.id",
        ),
    ] {
        out.insert(table.into(), sql_rows(c, sql, book)?);
    }
    Ok(out)
}

fn sql_rows(c: &Connection, sql: &str, book: &str) -> Result<Vec<Value>> {
    let mut stmt = c.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().map(str::to_owned).collect();
    let mut rows = stmt.query([book])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut record = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let value = match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(v) => json!(v),
                ValueRef::Real(v) => json!(v),
                ValueRef::Text(_) => Value::String(row.get(i)?),
                ValueRef::Blob(_) => {
                    return Err(dr_import_v1::ImportError::Invalid(format!(
                        "unexpected blob in manifest column {name}"
                    )));
                }
            };
            record.insert(name.clone(), value);
        }
        out.push(Value::Object(record));
    }
    Ok(out)
}
