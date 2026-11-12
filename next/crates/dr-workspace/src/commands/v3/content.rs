//! Data modules whose records live outside entry metadata.
use super::*;
use dr_model::kind::{EntityKind, RelationOrientation};
use dr_model::pos::PosKey;
use dr_model::shared::{EntityRef, PLOT_CELL_H, PLOT_CELL_W, PlotLine};

pub(crate) fn register(r: &mut Registry) {
    r.add::<PatchPut>()
        .add::<PatchEdit>()
        .add::<PatchRemove>()
        .add::<GridPut>()
        .add::<RelationPut>()
        .add::<RelationRemove>()
        .add::<RelationTypes>()
        .add::<RelationTypePut>()
        .add::<RelationTypeDelete>();
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Patch {
    pub id: String,
    pub entry: String,
    pub module: String,
    pub source_entry: Option<String>,
    pub source_module: Option<String>,
    pub source_block: Option<String>,
    pub source_text: Option<String>,
    pub title: Option<String>,
    pub body: String,
    pub pos: Option<String>,
    pub invalidated_at: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Line {
    pub id: String,
    pub pos: String,
    pub label: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Cell {
    pub row: String,
    pub column: String,
    pub text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Grid {
    pub cell_w: f64,
    pub cell_h: f64,
    pub rows: Vec<Line>,
    pub columns: Vec<Line>,
    pub cells: Vec<Cell>,
}
pub(super) fn grid(v: &BookViewV3<'_>, e: &EntryId, module: &m::ModuleSpec) -> Grid {
    let g = v.plot_grid(e, &module.id).unwrap_or_else(|| {
        let mut g = m::PlotGridV3::empty(e.clone(), module.id.clone());
        let mut pos = PosKey::first();
        for n in 1..=module.config.default_rows {
            g.rows.push(PlotLine {
                id: m::PlotGridV3::default_row_id(e, &module.id, n as usize),
                pos: Some(pos.clone()),
                label: String::new(),
            });
            pos = pos.after();
        }
        pos = PosKey::first();
        for n in 1..=module.config.default_cols {
            g.cols.push(PlotLine {
                id: m::PlotGridV3::default_col_id(e, &module.id, n as usize),
                pos: Some(pos.clone()),
                label: String::new(),
            });
            pos = pos.after();
        }
        g
    });
    grid_value(g)
}
pub(super) fn grid_value(g: m::PlotGridV3) -> Grid {
    Grid {
        cell_w: g.cell_w,
        cell_h: g.cell_h,
        rows: g
            .rows
            .into_iter()
            .map(|r| Line {
                id: r.id.to_string(),
                pos: r.pos.map(|p| p.to_string()).unwrap_or_default(),
                label: r.label,
            })
            .collect(),
        columns: g
            .cols
            .into_iter()
            .map(|r| Line {
                id: r.id.to_string(),
                pos: r.pos.map(|p| p.to_string()).unwrap_or_default(),
                label: r.label,
            })
            .collect(),
        cells: g
            .cells
            .into_iter()
            .map(|((r, c), text)| Cell {
                row: r.to_string(),
                column: c.to_string(),
                text,
            })
            .collect(),
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Ref {
    pub kind: String,
    pub id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Relation {
    pub id: String,
    pub from: Ref,
    pub to: Ref,
    pub relation_type: String,
    pub created_at: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RelationType {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "directed")]
    pub orientation: String,
    #[serde(default)]
    pub source_role: String,
    #[serde(default)]
    pub target_role: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub source_kinds: Vec<String>,
    #[serde(default)]
    pub target_kinds: Vec<String>,
    #[serde(default)]
    pub source_templates: Vec<String>,
    #[serde(default)]
    pub target_templates: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RelationTypeInfo {
    #[serde(flatten)]
    pub definition: RelationType,
    pub normalized_name: String,
    pub system_key: Option<String>,
    pub locked: bool,
}
fn directed() -> String {
    "directed".into()
}
fn selected(
    cx: &Cx<'_>,
    input: &module::In,
    kind: m::ModuleKind,
) -> Result<(Arc<BookSlot>, m::Entry, m::ModuleSpec)> {
    let s = cx.book_v3(&input.book)?;
    let (e, m) = module::selected(&s.reader_v3.view(), input)?;
    if m.kind != kind {
        return Err(WsError::invalid("wrong module kind"));
    }
    Ok((s, e, m))
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PatchIn {
    #[serde(flatten)]
    pub target: module::In,
    #[serde(default)]
    pub id: Option<String>,
    pub title: Option<String>,
    pub body: String,
    #[serde(default)]
    pub pos: Option<String>,
}
op! {
    PatchPut="module.put_patch",Write,Book,"Create or edit the text of a patch module record, preserving its source reference.",fn(cx,input:PatchIn)->Done {
        put_patch(cx, input)
    }
}
fn put_patch(cx: &Cx<'_>, input: PatchIn) -> Result<Done> {
    let (s, e, m) = selected(cx, &input.target, m::ModuleKind::Patches)?;
    let id = input
        .id
        .as_deref()
        .map(|s| pid("patch", s))
        .transpose()?
        .unwrap_or_else(PatchId::new_v7);
    if let Some(old) = s.reader_v3.view().patches().iter().find(|p| p.id == id)
        && (old.entry != e.id || old.module != m.id)
    {
        return Err(WsError::invalid("patch belongs to another module"));
    }
    let pos: Option<PosKey> = input.pos.as_deref().map(convert).transpose()?;
    let saved = id.clone();
    // A patch the caller names has its text replaced; its source reference is
    // not touched. A patch created here has a fresh id and replaces nothing.
    let replaced = input.id.is_some().then(|| {
        ["title", "body"]
            .into_iter()
            .chain(pos.is_some().then_some("pos"))
            .map(|field| rec(CollectionV3::Patches, &id).at([field]))
            .collect::<Vec<_>>()
    });
    let replaced = Replaces::records(replaced.into_iter().flatten());
    let (_, at) = cx.write_book_v3(&s, replaced, move |t| {
        let w = t.patch(&saved)?;
        w.entry(&e.id)?
            .module(&m.id)?
            .title(input.title.as_deref())?
            .body(&input.body)?;
        if let Some(pos) = pos {
            w.pos(&pos)?;
        }
        Ok(())
    })?;
    undo(cx, &s, &at, vec![key("patches", &id)]);
    cx.effect(EffectAction::Updated, "patch", id.as_str(), None);
    Ok(Done { id: id.to_string() })
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PatchEditIn {
    #[serde(flatten)]
    pub target: module::In,
    pub id: String,
    /// Omit to leave the title as it is; `null` clears it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub title: Option<Option<String>>,
    /// Omit to leave the body as it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}
op! {
    PatchEdit="module.edit_patch",Write,Book,"Change the title or the body of one patch record, leaving what is not named as it is.",fn(cx,input:PatchEditIn)->Patch {
        edit_patch(cx, input)
    }
}
fn edit_patch(cx: &Cx<'_>, input: PatchEditIn) -> Result<Patch> {
    let (s, e, m) = selected(cx, &input.target, m::ModuleKind::Patches)?;
    let id: PatchId = pid("patch", &input.id)?;
    let named = [
        ("title", input.title.is_some()),
        ("body", input.body.is_some()),
    ];
    let replaced = Replaces::records(
        named
            .iter()
            .filter(|(_, named)| *named)
            .map(|(field, _)| rec(CollectionV3::Patches, &id).at([*field])),
    );
    let saved = id.clone();
    let (patch, at) = cx.write_book_v3(&s, replaced, move |t| {
        // Read and written in one job: what is not named keeps whatever it
        // holds now, and a patch removed meanwhile is not brought back empty.
        let stored = |t: &dr_doc::v3::BookTxnV3<'_>| {
            t.view()
                .patches_of(&e.id, &m.id)
                .into_iter()
                .find(|p| p.id == saved)
                .ok_or_else(|| WsError::not_found("patch", saved.as_str()))
        };
        stored(t)?;
        let w = t.patch(&saved)?;
        if let Some(title) = &input.title {
            w.title(title.as_deref())?;
        }
        if let Some(body) = &input.body {
            w.body(body)?;
        }
        stored(t)
    })?;
    if named.iter().any(|(_, named)| *named) {
        undo(cx, &s, &at, vec![key("patches", &id)]);
        cx.effect(EffectAction::Updated, "patch", id.as_str(), None);
    } else {
        cx.undo_nothing();
    }
    convert(patch)
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RecordIn {
    #[serde(flatten)]
    pub target: module::In,
    pub id: String,
}
op! {
    PatchRemove="module.remove_patch",Write,Book,"Remove one patch record without deleting relations or other entries.",fn(cx,input:RecordIn)->Done {
        let (s, e, m) = selected(cx, &input.target, m::ModuleKind::Patches)?;
        if !s
            .reader_v3
            .view()
            .patches_of(&e.id, &m.id)
            .iter()
            .any(|p| p.id.as_str() == input.id)
        {
            return Err(WsError::not_found("patch", &input.id));
        }
        let id = input.id.clone();
        let removed = Replaces::record(CollectionV3::Patches, &id);
        let (_, at) = cx.write_book_v3(&s, removed, move |t| {
            t.purge(CollectionV3::Patches, &id)?;
            Ok(())
        })?;
        undo(cx, &s, &at, vec![key("patches", &input.id)]);
        cx.effect(EffectAction::Purged, "patch", &input.id, None);
        Ok(Done { id: input.id })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GridIn {
    #[serde(flatten)]
    pub target: module::In,
    pub grid: Grid,
}
op! {
    GridPut="module.put_grid",Write,Book,"Replace the rows, columns, cells and size of one plot module.",fn(cx,input:GridIn)->Done {
        put_grid(cx, input)
    }
}
fn put_grid(cx: &Cx<'_>, input: GridIn) -> Result<Done> {
    let (s, e, m) = selected(cx, &input.target, m::ModuleKind::PlotGrid)?;
    let g = input.grid;
    if !PLOT_CELL_W.contains(&g.cell_w)
        || !PLOT_CELL_H.contains(&g.cell_h)
        || g.rows.is_empty()
        || g.columns.is_empty()
    {
        return Err(WsError::invalid("invalid grid dimensions"));
    }
    let mut rows = BTreeSet::new();
    let mut cols = BTreeSet::new();
    for r in &g.rows {
        let _: PlotRowId = pid("row", &r.id)?;
        let _: PosKey = convert(&r.pos)?;
        if !rows.insert(r.id.clone()) {
            return Err(WsError::invalid("duplicate row"));
        }
    }
    for c in &g.columns {
        let _: PlotColId = pid("column", &c.id)?;
        let _: PosKey = convert(&c.pos)?;
        if !cols.insert(c.id.clone()) {
            return Err(WsError::invalid("duplicate column"));
        }
    }
    let mut cells = BTreeSet::new();
    for c in &g.cells {
        if !rows.contains(&c.row) || !cols.contains(&c.column) || !cells.insert((&c.row, &c.column))
        {
            return Err(WsError::invalid(
                "cell must name distinct existing row and column",
            ));
        }
    }
    let old = s.reader_v3.view().plot_grid(&e.id, &m.id);
    let id = m::PlotGridV3::key(&e.id, &m.id);
    let replaced = Replaces::record(CollectionV3::PlotGrids, &id);
    let (_, at) = cx.write_book_v3(&s, replaced, move |t| {
        let w = t.plot_grid(&e.id, &m.id)?;
        if let Some(old) = old {
            for r in old.rows {
                if !rows.contains(r.id.as_str()) {
                    w.remove_row(&r.id)?;
                }
            }
            for c in old.cols {
                if !cols.contains(c.id.as_str()) {
                    w.remove_col(&c.id)?;
                }
            }
            for ((r, c), _) in old.cells {
                w.cell(&r, &c, None)?;
            }
        }
        w.cell_w(g.cell_w)?.cell_h(g.cell_h)?;
        for r in g.rows {
            w.row(&pid("row", &r.id)?, &r.pos, &r.label)?;
        }
        for c in g.columns {
            w.col(&pid("column", &c.id)?, &c.pos, &c.label)?;
        }
        for c in g.cells {
            w.cell(
                &pid("row", &c.row)?,
                &pid("column", &c.column)?,
                Some(&c.text),
            )?;
        }
        Ok(())
    })?;
    undo(cx, &s, &at, vec![key("plot_grids", &id)]);
    cx.effect(EffectAction::Updated, "plot_grid", &id, None);
    Ok(Done { id })
}
op! {
    RelationTypes="entry_relation_type.list",Read,Shared,"List relation types available to entry modules.",fn(cx,input:BookIn)->Vec<RelationTypeInfo> {
        let s = cx.book_v3(&input.book)?;
        convert(s.reader_v3.view().relation_types())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TypeIn {
    pub book: String,
    pub definition: RelationType,
}
op! {
    RelationTypePut="entry_relation_type.put",Write,Book,"Create or edit a relation type with endpoint and template restrictions.",fn(cx,input:TypeIn)->Done {
        put_type(cx, input)
    }
}
fn put_type(cx: &Cx<'_>, input: TypeIn) -> Result<Done> {
    let s = cx.book_v3(&input.book)?;
    let v = s.reader_v3.view();
    let d = input.definition;
    let id: RelationTypeId = pid("relation type", &d.id)?;
    name_ok(&d.name)?;
    if v.relation_type(&id)
        .is_some_and(|t| t.locked || t.system_key.is_some())
    {
        return Err(WsError::invalid("locked relation type"));
    }
    if v.relation_types().iter().any(|t| {
        t.id != id && t.normalized_name == dr_model::shared::normalize_relation_type_name(&d.name)
    }) {
        return Err(WsError::invalid("duplicate relation type name"));
    }
    let orientation = RelationOrientation::from(d.orientation.as_str());
    if !matches!(
        orientation,
        RelationOrientation::Directed | RelationOrientation::Symmetric
    ) {
        return Err(WsError::invalid("unknown relation orientation"));
    }
    let kinds = |xs: &[String]| -> Result<Vec<EntityKind>> {
        xs.iter()
            .map(|s| {
                let k = EntityKind::from(s.as_str());
                if matches!(
                    k,
                    EntityKind::Entry
                        | EntityKind::Material
                        | EntityKind::Comment
                        | EntityKind::Patch
                ) {
                    Ok(k)
                } else {
                    Err(WsError::invalid("invalid endpoint kind"))
                }
            })
            .collect()
    };
    let source = kinds(&d.source_kinds)?;
    let target = kinds(&d.target_kinds)?;
    let templates = |xs: &[String]| -> Result<Vec<EntryTemplateId>> {
        xs.iter()
            .map(|id| template_of(&v, id).map(|t| t.id))
            .collect()
    };
    let st = templates(&d.source_templates)?;
    let tt = templates(&d.target_templates)?;
    let saved = id.clone();
    let replaced = Replaces::record(CollectionV3::RelationTypes, &id);
    let (_, at) = cx.write_book_v3(&s, replaced, move |t| {
        t.relation_type(&saved)?
            .name(&d.name)?
            .description(&d.description)?
            .orientation(&orientation)?
            .source_role(&d.source_role)?
            .target_role(&d.target_role)?
            .color(d.color.as_deref())?
            .source_kinds(&source)?
            .target_kinds(&target)?
            .source_templates(&st)?
            .target_templates(&tt)?;
        Ok(())
    })?;
    undo(cx, &s, &at, vec![key("relation_types", &id)]);
    cx.effect(EffectAction::Updated, "relation_type", id.as_str(), None);
    Ok(Done { id: id.to_string() })
}
op! {
    RelationTypeDelete="entry_relation_type.delete",Write,Book,"Delete an unused unlocked relation type.",fn(cx,input:EntityIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let id: RelationTypeId = pid("relation type", &input.id)?;
        let ty = v
            .relation_type(&id)
            .ok_or_else(|| WsError::not_found("relation type", &input.id))?;
        if ty.locked
            || ty.system_key.is_some()
            || v.relations_raw().iter().any(|r| r.relation_type == id)
        {
            return Err(WsError::invalid("relation type is locked or in use"));
        }
        let saved = id.clone();
        let removed = Replaces::record(CollectionV3::RelationTypes, &id);
        let (_, at) = cx.write_book_v3(&s, removed, move |t| {
            Ok(t.purge(CollectionV3::RelationTypes, saved.as_str())?)
        })?;
        undo(cx, &s, &at, vec![key("relation_types", &id)]);
        cx.effect(EffectAction::Purged, "relation_type", id.as_str(), None);
        Ok(Done { id: input.id })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RelationIn {
    #[serde(flatten)]
    pub target: module::In,
    pub other: Ref,
    pub relation_type: String,
    #[serde(default)]
    pub incoming: bool,
}
op! {
    RelationPut="module.put_relation",Write,Book,"Associate an entry with a live endpoint through its relations module.",fn(cx,input:RelationIn)->Done {
        put_relation(cx, input)
    }
}
fn put_relation(cx: &Cx<'_>, input: RelationIn) -> Result<Done> {
    let (s, e, _) = selected(cx, &input.target, m::ModuleKind::Relations)?;
    let v = s.reader_v3.view();
    let other: EntityRef = convert(input.other)?;
    let own = EntityRef {
        kind: EntityKind::Entry,
        id: e.id.to_string(),
    };
    if !v.entity_exists(&other) || own == other {
        return Err(WsError::invalid("relation needs distinct live endpoints"));
    }
    let ty = v
        .relation_type(&pid("relation type", &input.relation_type)?)
        .ok_or_else(|| WsError::not_found("relation type", &input.relation_type))?;
    let (mut from, mut to) = if input.incoming {
        (other, own)
    } else {
        (own, other)
    };
    let allows = |r: &EntityRef, kinds: &[EntityKind], templates: &[EntryTemplateId]| {
        (kinds.is_empty() || kinds.contains(&r.kind))
            && (templates.is_empty()
                || (r.kind == EntityKind::Entry
                    && v.entry(&EntryId::parse(&r.id).expect("live entry"))
                        .is_some_and(|e| e.template.is_some_and(|t| templates.contains(&t)))))
    };
    if !allows(&from, &ty.source_kinds, &ty.source_templates)
        || !allows(&to, &ty.target_kinds, &ty.target_templates)
    {
        return Err(WsError::invalid(
            "relation endpoints violate type restrictions",
        ));
    }
    if ty.orientation == RelationOrientation::Symmetric && from > to {
        std::mem::swap(&mut from, &mut to);
    }
    if let Some(r) = v.relations_raw().iter().find(|r| {
        r.relation_type == ty.id
            && ((r.from == from && r.to == to)
                || (ty.orientation == RelationOrientation::Symmetric
                    && r.from == to
                    && r.to == from))
    }) {
        cx.undo_nothing();
        return Ok(Done {
            id: r.id.to_string(),
        });
    }
    let id = RelationId::new_v7();
    let saved = id.clone();
    let (_, at) = cx.write_book_v3(&s, Replaces::nothing(), move |t| {
        t.relation(&saved)?
            .ends(&from, &to)?
            .relation_type(&ty.id)?
            .created_at(Some(now()))?;
        Ok(())
    })?;
    undo(cx, &s, &at, vec![key("relations", &id)]);
    cx.effect(EffectAction::Created, "relation", id.as_str(), None);
    Ok(Done { id: id.to_string() })
}
op! {
    RelationRemove="module.remove_relation",Write,Book,"Remove one relation projected in an entry's relations module.",fn(cx,input:RecordIn)->Done {
        let (s, e, _) = selected(cx, &input.target, m::ModuleKind::Relations)?;
        let own = EntityRef {
            kind: EntityKind::Entry,
            id: e.id.to_string(),
        };
        if !s
            .reader_v3
            .view()
            .relations_raw()
            .iter()
            .any(|r| r.id.as_str() == input.id && (r.from == own || r.to == own))
        {
            return Err(WsError::not_found("relation", &input.id));
        }
        let id = input.id.clone();
        let removed = Replaces::record(CollectionV3::Relations, &id);
        let (_, at) = cx.write_book_v3(&s, removed, move |t| Ok(t.purge(CollectionV3::Relations, &id)?))?;
        undo(cx, &s, &at, vec![key("relations", &input.id)]);
        cx.effect(EffectAction::Purged, "relation", &input.id, None);
        Ok(Done { id: input.id })
    }
}
