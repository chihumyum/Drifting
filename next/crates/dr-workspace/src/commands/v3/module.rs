use super::*;
use dr_model::shared::KvEntry;
pub(crate) fn register(r: &mut Registry) {
    r.add::<ModuleList>()
        .add::<ModuleRead>()
        .add::<FieldSet>()
        .add::<KvPut>()
        .add::<KvRemove>()
        .add::<ProseRead>()
        .add::<ProseSet>()
        .add::<ProseReplace>()
        .add::<ProseDocument>();
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct In {
    pub book: String,
    pub entry: String,
    pub module: String,
}
pub(super) fn selected(v: &BookViewV3<'_>, i: &In) -> Result<(m::Entry, m::ModuleSpec)> {
    let e = live(v, &i.entry)?;
    let t = e
        .effective_template(&v.templates_map())
        .cloned()
        .ok_or_else(|| WsError::not_found("entry template", &i.entry))?;
    let module = t
        .modules
        .into_iter()
        .find(|m| m.id.as_str() == i.module)
        .ok_or_else(|| WsError::not_found("module", &i.module))?;
    Ok((e, module))
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct Summary {
    pub id: String,
    pub definition: Option<types::ModuleSpec>,
    pub retained: bool,
    pub prose_doc: Option<String>,
}
fn modules(cx: &Cx<'_>, s: &BookSlot, e: &m::Entry) -> Result<Vec<Summary>> {
    let v = s.reader_v3.view();
    let templates = v.templates_map();
    let active = e
        .effective_template(&templates)
        .map(|t| t.modules.clone())
        .unwrap_or_default();
    let mut ids: BTreeSet<ModuleId> = active
        .iter()
        .map(|m| m.id.clone())
        .chain(e.fields.keys().cloned())
        .chain(e.kv.keys().cloned())
        .collect();
    if e.is_level(&templates) {
        ids.insert(m::level_about_module_id());
    }
    ids.extend(
        v.patches()
            .iter()
            .filter(|p| p.entry == e.id)
            .map(|p| p.module.clone()),
    );
    ids.extend(
        v.plot_grids()
            .iter()
            .filter(|g| g.entry == e.id)
            .map(|g| g.module.clone()),
    );
    let mut prose = BTreeMap::new();
    for info in cx.workspace().library().docs(Some(s.book.as_str()), None)? {
        if let Ok(DocId::Body(body)) = DocId::parse(&info.doc_id)
            && body.entry() == &e.id
        {
            ids.insert(body.module().clone());
            prose.insert(body.module().clone(), info.doc_id);
        }
    }
    ids.into_iter()
        .map(|id| {
            let definition = active.iter().find(|m| m.id == id).cloned();
            let retained = definition.is_none()
                && !(e.is_level(&templates) && id == m::level_about_module_id());
            Ok(Summary {
                id: id.to_string(),
                definition: definition.map(convert).transpose()?,
                retained,
                prose_doc: prose.remove(&id),
            })
        })
        .collect()
}
op! {
    ModuleList="module.list",Read,Shared,"List current and retained v3 modules and their registered prose documents.",fn(cx,input:EntityIn)->Vec<Summary> {
        let s = cx.book_v3(&input.book)?;
        let e = live(&s.reader_v3.view(), &input.id)?;
        modules(cx, &s, &e)
    }
}
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct Data {
    pub module: Summary,
    pub fields: BTreeMap<String, types::FieldValue>,
    pub kv: Vec<types::KvEntry>,
    pub patches: Vec<content::Patch>,
    pub grid: Option<content::Grid>,
    pub relations: Vec<content::Relation>,
}
op! {
    ModuleRead="module.read",Read,Shared,"Read a current or retained v3 module and its structured content.",fn(cx,input:In)->Data {
        read(cx, input)
    }
}
fn read(cx: &Cx<'_>, input: In) -> Result<Data> {
    let s = cx.book_v3(&input.book)?;
    let v = s.reader_v3.view();
    let e = live(&v, &input.entry)?;
    let summary = modules(cx, &s, &e)?
        .into_iter()
        .find(|m| m.id == input.module)
        .ok_or_else(|| WsError::not_found("module", &input.module))?;
    let id: ModuleId = pid("module", &input.module)?;
    let definition: Option<m::ModuleSpec> = summary.definition.clone().map(convert).transpose()?;
    let grid = if let Some(g) = v.plot_grid(&e.id, &id) {
        Some(content::grid_value(g))
    } else {
        definition
            .as_ref()
            .filter(|m| m.kind == m::ModuleKind::PlotGrid)
            .map(|m| content::grid(&v, &e.id, m))
    };
    let relations = if definition.is_some_and(|m| m.kind == m::ModuleKind::Relations) {
        convert(v.relations_of(&dr_model::shared::EntityRef {
            kind: dr_model::kind::EntityKind::Entry,
            id: e.id.to_string(),
        }))?
    } else {
        Vec::new()
    };
    Ok(Data {
        module: summary,
        fields: convert(e.fields.get(&id).cloned().unwrap_or_default())?,
        kv: convert(e.kv.get(&id).cloned().unwrap_or_default())?,
        patches: convert(v.patches_of(&e.id, &id))?,
        grid,
        relations,
    })
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct FieldIn {
    #[serde(flatten)]
    pub target: In,
    pub field: String,
    pub value: types::FieldValue,
}
pub(super) fn field_ok(v: &BookViewV3<'_>, def: &m::FieldDef, value: &m::FieldValue) -> Result<()> {
    use m::{FieldType as T, FieldValue as V};
    if matches!(value, V::Null) {
        return Ok(());
    }
    let valid = match (&def.field_type, value) {
        (T::Text | T::LongText, V::Text(_)) => true,
        (T::Date, V::Text(s)) => s.is_ascii() && dr_model::Day::parse(s).is_some(),
        (T::Number, V::Number(n)) => n.is_finite(),
        (T::Toggle, V::Bool(_)) => true,
        (T::Select, V::Text(s)) => def.options.contains(s),
        (T::MultiSelect, V::List(xs)) => xs.iter().all(|s| def.options.contains(s)),
        (T::Aliases, V::List(_)) => true,
        (T::EntityRef, V::Text(s)) => v.entry(&pid("entry", s)?).is_some_and(|e| {
            !e.is_trashed()
                && def
                    .target_template
                    .as_ref()
                    .is_none_or(|t| e.template.as_ref() == Some(t))
        }),
        (T::Image, V::Text(s)) => v.assets().iter().any(|a| a.id.as_str() == s),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(WsError::invalid(format!(
            "value does not match field {}",
            def.id
        )))
    }
}
op! {
    FieldSet="module.set_field",Write,Book,"Set or clear a typed field value in a v3 entry module.",fn(cx,input:FieldIn)->Done {
        let s = cx.book_v3(&input.target.book)?;
        let v = s.reader_v3.view();
        let (mut e, module) = selected(&v, &input.target)?;
        if module.kind != m::ModuleKind::Fields {
            return Err(WsError::invalid("module is not fields"));
        }
        let def = module
            .config
            .defs
            .iter()
            .find(|d| d.id == input.field)
            .ok_or_else(|| WsError::not_found("field", &input.field))?;
        let value: m::FieldValue = convert(input.value)?;
        field_ok(&v, def, &value)?;
        let fields = e.fields.entry(module.id.clone()).or_default();
        if value == m::FieldValue::Null {
            fields.remove(&input.field);
        } else {
            fields.insert(input.field.clone(), value.clone());
        }
        let mut entries = v.entries_map();
        entries.insert(e.id.clone(), e.clone());
        graph_ok(&entries, &v.templates_map(), &v.memberships_raw())?;
        let id = e.id.clone();
        let (_, at) = cx.write_book_v3(&s, move |t| {
            t.entries().entry(&e.id)?.set_field(
                &module.id,
                &input.field,
                if value == m::FieldValue::Null {
                    None
                } else {
                    Some(&value)
                },
            )?;
            Ok(())
        })?;
        undo(cx, &s, &at, vec![key("entries", &id)]);
        cx.effect(EffectAction::Updated, "entry", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct KvPutIn {
    #[serde(flatten)]
    pub target: In,
    pub row: types::KvEntry,
}
op! {
    KvPut="module.put_kv",Write,Book,"Add or update an ordered key/value row in a v3 module.",fn(cx,input:KvPutIn)->Done {
        let s = cx.book_v3(&input.target.book)?;
        let (e, module) = selected(&s.reader_v3.view(), &input.target)?;
        if module.kind != m::ModuleKind::KeyValue {
            return Err(WsError::invalid("module is not key/value"));
        }
        let row: KvEntry = convert(input.row)?;
        let id = e.id.clone();
        let (_, at) = cx.write_book_v3(&s, move |t| {
            t.entries().entry(&e.id)?.put_kv(&module.id, &row)?;
            Ok(())
        })?;
        undo(cx, &s, &at, vec![key("entries", &id)]);
        cx.effect(EffectAction::Updated, "entry", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct KvRemoveIn {
    #[serde(flatten)]
    pub target: In,
    pub row: String,
}
op! {
    KvRemove="module.remove_kv",Write,Book,"Remove a key/value row from a v3 module.",fn(cx,input:KvRemoveIn)->Done {
        let s = cx.book_v3(&input.target.book)?;
        let (e, module) = selected(&s.reader_v3.view(), &input.target)?;
        if module.kind != m::ModuleKind::KeyValue {
            return Err(WsError::invalid("module is not key/value"));
        }
        let row: KvEntryId = pid("row", &input.row)?;
        let id = e.id.clone();
        let (_, at) = cx.write_book_v3(&s, move |t| {
            t.entries().entry(&e.id)?.remove_kv(&module.id, &row)?;
            Ok(())
        })?;
        undo(cx, &s, &at, vec![key("entries", &id)]);
        cx.effect(EffectAction::Updated, "entry", id.as_str(), None);
        Ok(Done { id: id.to_string() })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ProseIn {
    pub book: String,
    /// Entry or template ID, selected by `template`.
    pub owner: String,
    pub module: String,
    #[serde(default)]
    pub template: bool,
}
pub(super) fn document(cx: &Cx<'_>, i: &ProseIn) -> Result<(Arc<BookSlot>, DocId)> {
    let s = cx.book_v3(&i.book)?;
    let v = s.reader_v3.view();
    let mid: ModuleId = pid("module", &i.module)?;
    let retained = |doc: &DocId| -> Result<bool> {
        Ok(cx
            .workspace()
            .library()
            .doc_info(&doc.to_string())?
            .is_some_and(|d| d.book_id.as_deref() == Some(s.book.as_str())))
    };
    let doc = if i.template {
        let t = template_of(&v, &i.owner)?;
        let doc = template_doc(&s.book, &t.id, &mid)?;
        if !retained(&doc)?
            && (!t.is_leaf()
                || !t
                    .module(&mid)
                    .is_some_and(|m| m.kind == m::ModuleKind::Prose))
        {
            return Err(WsError::invalid("template module is not prose"));
        }
        doc
    } else {
        let e = live(&v, &i.owner)?;
        let templates = v.templates_map();
        let doc = body_id(&e.id, &mid);
        if !retained(&doc)?
            && !(e.is_level(&templates) && mid == m::level_about_module_id()
                || e.effective_template(&templates).is_some_and(|t| {
                    t.module(&mid)
                        .is_some_and(|m| m.kind == m::ModuleKind::Prose)
                }))
        {
            return Err(WsError::invalid(
                "entry module is not prose or level description",
            ));
        }
        doc
    };
    valid_doc(&doc)?;
    owns(cx, &s, &doc)?;
    Ok((s, doc))
}
op! {
    ProseDocument="module.prose_document",Write,Book,"Initialize a v3 prose module or level description and return its document ID.",fn(cx,input:ProseIn)->Done {
        let (s, doc) = document(cx, &input)?;
        if let DocId::Body(body)=&doc {
            let v=s.reader_v3.view();let e=live(&v,body.entry().as_str())?;
            initialize_selected(cx,&s,&e,&v.templates_map(),&BTreeMap::new(),Some(body.module()))?;
        }
        cx.create_prose(&s.book, &doc)?;
        cx.undo_nothing();
        Ok(Done {
            id: doc.to_string(),
        })
    }
}
op! {
    ProseRead="module.read_prose",Read,Shared,"Read a v3 prose module, level description or template prose with block IDs and version.",fn(cx,input:ProseIn)->super::super::prose::ProseText {
        let (_, doc) = document(cx, &input)?;
        if cx
            .workspace()
            .library()
            .doc_info(&doc.to_string())?
            .is_none()
        {
            return Ok(super::super::prose::ProseText {
                paragraphs: Vec::new(),
                total: 0,
                version: String::new(),
            });
        }
        super::super::prose::ProseRead::run(
            cx,
            super::super::prose::ProseReadIn {
                doc: doc.to_string(),
                from: 0,
                limit: Some(usize::MAX),
            },
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SetIn {
    #[serde(flatten)]
    pub target: ProseIn,
    pub paragraphs: Vec<super::super::prose_template::TemplateParagraph>,
}
op! {
    ProseSet="module.set_prose",Write,Book,"Write paragraphs of a v3 prose module, level description or template prose.",fn(cx,input:SetIn)->Done {
        let (s, doc) = document(cx, &input.target)?;
        for p in &input.paragraphs {
            if p.heading.is_some_and(|h| !(1..=3).contains(&h))
                || p.text.contains('\n')
                || p.text.contains('\u{fffc}')
            {
                return Err(WsError::invalid("invalid paragraph or heading"));
            }
        }
        cx.create_prose(&s.book, &doc)?;
        let prose = cx.prose(&doc)?;
        let links=written_links(cx,&s,&doc);
        let at = cx.write_prose_raw(&prose, move |state| {
            let at = state.oplog_frontiers();
            let b = dr_doc::prose::BorrowedProse::new(state, &doc)?;
            let mut txn=b.txn();
            super::super::prose_template::replace_paragraphs(&mut txn, &input.paragraphs)?;
            if let Some(links)=links {let len=txn.view().len();crate::autolink::link_written_v3(&mut txn,&links,0..len)?;}
            Ok(at)
        })?;
        cx.undo_with(Invocation::new(
            "prose.restore",
            super::super::prose::ProseRestoreIn {
                doc: prose.doc.to_string(),
                at: frontiers_hex(&at),
            },
        ));
        cx.effect(EffectAction::Updated, "prose", prose.doc.to_string(), None);
        Ok(Done {
            id: prose.doc.to_string(),
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ReplaceIn {
    #[serde(flatten)]
    pub target: ProseIn,
    pub block_id: String,
    pub find: String,
    pub replace: String,
}
op! {
    ProseReplace="module.replace_prose",Write,Book,"Replace an exact passage in a v3 module or level description, addressed by block ID.",fn(cx,input:ReplaceIn)->super::super::prose::Replaced {
        let (_, doc) = document(cx, &input.target)?;
        super::super::prose::ProseReplace::run(
            cx,
            super::super::prose::ProseReplaceIn {
                doc: doc.to_string(),
                find: input.find,
                replace: input.replace,
                block_id: Some(input.block_id),
            },
        )
    }
}
fn written_links(
    cx: &Cx<'_>,
    slot: &BookSlot,
    doc: &DocId,
) -> Option<Arc<dr_text::autolink::LinkMatcher<dr_text::autolink::LinkTarget>>> {
    (matches!(doc, DocId::Body(_))
        && cx.workspace().auto_links()
        && crate::autolink::links_for(cx.actor()))
    .then(|| crate::autolink::book_matcher(slot, doc))
}

pub(super) fn initialize(
    cx: &Cx<'_>,
    slot: &BookSlot,
    e: &m::Entry,
    templates: &BTreeMap<EntryTemplateId, m::EntryTemplate>,
    bodies: &BTreeMap<String, String>,
) -> Result<()> {
    initialize_selected(cx, slot, e, templates, bodies, None)
}

fn initialize_selected(
    cx: &Cx<'_>,
    slot: &BookSlot,
    e: &m::Entry,
    templates: &BTreeMap<EntryTemplateId, m::EntryTemplate>,
    bodies: &BTreeMap<String, String>,
    only: Option<&ModuleId>,
) -> Result<()> {
    let t = e.effective_template(templates);
    let mids: Vec<ModuleId> = if e.is_level(templates) {
        vec![m::level_about_module_id()]
    } else {
        t.into_iter()
            .flat_map(|t| t.prose_modules().map(|m| m.id.clone()))
            .collect()
    };
    for mid in bodies.keys() {
        if !mids.iter().any(|m| m.as_str() == mid) {
            return Err(WsError::invalid("initial body names a non-prose module"));
        }
    }
    if bodies.values().any(|s| s.contains('\u{fffc}')) {
        return Err(WsError::invalid(
            "initial body cannot contain an embedded-object marker",
        ));
    }
    // Prepare every source before any write; no template is read half way through an edit.
    let mut plans = Vec::new();
    for mid in mids
        .into_iter()
        .filter(|mid| only.is_none_or(|id| id == mid))
    {
        let doc = body_id(&e.id, &mid);
        valid_doc(&doc)?;
        if cx
            .workspace()
            .library()
            .doc_info(&doc.to_string())?
            .is_some()
        {
            continue;
        }
        let source = if !bodies.contains_key(mid.as_str()) {
            if let Some(t) = t.filter(|t| t.is_leaf()) {
                let id = template_doc(&slot.book, &t.id, &mid)?;
                if cx
                    .workspace()
                    .library()
                    .doc_info(&id.to_string())?
                    .is_some()
                {
                    let p = cx.prose(&id)?;
                    Some((id, p.handle.read(|d| d.fork())?))
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        plans.push((doc, bodies.get(mid.as_str()).cloned(), source));
    }
    for (doc, text, source) in plans {
        cx.create_prose(&slot.book, &doc)?;
        let p = cx.prose(&doc)?;
        if text.is_some() || source.is_some() {
            let links = written_links(cx, slot, &doc);
            cx.write_prose(&p, move |t| {
                if let Some(text) = text {
                    if !text.is_empty() {
                        t.insert_paragraphs(0, &text)?;
                    }
                } else if let Some((id, copy)) = source {
                    let r = dr_doc::prose::ProseReader::from_loro(id, &copy)?;
                    t.insert_copy_v3(0, &r.view())?;
                }
                if let Some(links) = links {
                    let len = t.view().len();
                    crate::autolink::link_written_v3(t, &links, 0..len)?;
                }
                Ok(())
            })?;
        }
    }
    Ok(())
}
