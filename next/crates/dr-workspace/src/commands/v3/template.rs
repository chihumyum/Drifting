use super::*;
pub(crate) fn register(r: &mut Registry) {
    r.add::<TemplateList>()
        .add::<TemplatePut>()
        .add::<TemplateDelete>()
        .add::<ModulePut>()
        .add::<ModuleRemove>();
}
op! {
    TemplateList="entry_template.list",Read,Shared,"List the templates and module definitions of a v3 book.",fn(cx,input:BookIn)->Vec<types::EntryTemplate> {
        let s = cx.book_v3(&input.book)?;
        convert(s.reader_v3.view().templates())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct PutIn {
    pub book: String,
    pub template: types::EntryTemplate,
}
/// `module`: the one module definition a call replaces or removes; `None`
/// when it replaces the template.
fn put(cx: &Cx<'_>, book: &str, mut t: m::EntryTemplate, module: Option<&str>) -> Result<Done> {
    let slot = cx.book_v3(book)?;
    let v = slot.reader_v3.view();
    let entries = v.entries_map();
    let mut templates = v.templates_map();
    name_ok(&t.name)?;
    if !t.kind.is_known() || t.deleted_at.is_some() {
        return Err(WsError::invalid("use a known live template kind"));
    }
    for module in &mut t.modules {
        for field in &mut module.config.defs {
            if matches!(field.default_value, Some(m::FieldValue::Null)) {
                field.default_value = None;
            }
        }
    }
    m::check_template_modules(&t.kind, &t.modules)?;
    if t.settings.display.as_ref().is_some_and(|d| !d.is_known())
        || t.settings
            .format_shortcuts
            .as_ref()
            .is_some_and(|f| !f.is_known())
    {
        return Err(WsError::invalid("unknown level display or formatting mode"));
    }
    if t.is_leaf() && (t.lane || !t.settings.is_empty() || !t.verbs.is_empty()) {
        return Err(WsError::invalid(
            "leaf templates cannot declare level settings, lanes or actions",
        ));
    }
    templates.insert(t.id.clone(), t.clone());
    let mut ids = BTreeSet::new();
    for module in &t.modules {
        name_ok(&module.name)?;
        if !module.kind.is_known()
            || module.id.as_str() == m::LEVEL_ABOUT_MODULE
            || !ids.insert(&module.id)
        {
            return Err(WsError::invalid("unknown, duplicate or reserved module"));
        }
        if module.kind == m::ModuleKind::Prose {
            template_doc(&slot.book, &t.id, &module.id)?;
        }
        let mut fields = BTreeSet::new();
        for field in &module.config.defs {
            name_ok(&field.name)?;
            if let Some(target) = &field.target_template {
                m::check_entry_template(&templates, Some(target))?;
            }
            if field.options.iter().collect::<BTreeSet<_>>().len() != field.options.len() {
                return Err(WsError::invalid("duplicate field option"));
            }
            if field.id.is_empty() || !fields.insert(&field.id) || !field.field_type.is_known() {
                return Err(WsError::invalid("invalid field definition"));
            }
            if let Some(dv) = &field.default_value {
                module::field_ok(&v, field, dv)?;
            }
        }
        for field in [
            &module.config.aliases_field,
            &module.config.color_field,
            &module.config.status_field,
            &module.config.summary_field,
            &module.config.portrait_field,
        ]
        .into_iter()
        .flatten()
        {
            if !fields.contains(field) {
                return Err(WsError::invalid("module role names an undefined field"));
            }
        }
        if module.config.default_rows == 0 || module.config.default_cols == 0 {
            return Err(WsError::invalid("plot dimensions must be positive"));
        }
    }
    templates.insert(t.id.clone(), t.clone());
    // Changing the kind of an in-use template must obey the same rule as switching an entry.
    for e in entries
        .values()
        .filter(|e| e.template.as_ref() == Some(&t.id) && !e.is_trashed())
    {
        if t.is_leaf() && entries.values().any(|c| c.parent.as_ref() == Some(&e.id)) {
            return Err(WsError::invalid(
                "a leaf cannot have children, including trashed children",
            ));
        }
    }
    // References may point to the template being created.
    for id in t
        .settings
        .allow
        .iter()
        .flatten()
        .chain(t.settings.default_template.iter().flatten())
    {
        m::check_entry_template(&templates, Some(id))?;
    }
    if let Some(Some(home)) = &t.settings.home {
        let e = live(&v, home.as_str())?;
        if !e.is_level(&templates) {
            return Err(WsError::invalid("home must be a level"));
        }
    }
    let mut verbs = BTreeSet::new();
    for verb in &t.verbs {
        name_ok(&verb.name)?;
        if verb.id.is_empty() || !verbs.insert(&verb.id) {
            return Err(WsError::invalid("duplicate or empty action id"));
        }
        m::check_entry_template(&templates, verb.target_template.as_ref())?;
    }
    graph_ok(&entries, &templates, &v.memberships_raw())?;
    let id = t.id.clone();
    let title = t.name.clone();
    let template = rec(CollectionV3::Templates, &id);
    let replaced = match module {
        Some(module) => template.at(["modules", module]),
        None => template,
    };
    let (_, at) = cx.write_book_v3(&slot, Replaces::records([replaced]), move |tx| {
        tx.template(&t.id)?.set_full(&t)?;
        Ok(())
    })?;
    undo(cx, &slot, &at, vec![key("templates", &id)]);
    cx.effect(
        EffectAction::Updated,
        "entry_template",
        id.as_str(),
        Some(&title),
    );
    Ok(Done { id: id.to_string() })
}
op! {
    TemplatePut="entry_template.put",Write,Book,"Create or replace a v3 template definition while retaining existing entry content.",fn(cx,input:PutIn)->Done {
        put(cx, &input.book, convert(input.template)?, None)
    }
}
op! {
    TemplateDelete="entry_template.delete",Write,Book,"Delete an unused v3 template without deleting its retained prose documents.",fn(cx,input:EntityIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let t = template_of(&v, &input.id)?;
        m::check_template_delete(&t.id, &v.entries_map())?;
        let id = t.id.clone();
        let trashed = rec(CollectionV3::Templates, &id).at(["deleted_at"]);
        let (_, at) = cx.write_book_v3(&s, Replaces::records([trashed]), move |tx| {
            tx.template(&t.id)?.deleted_at(Some(now()))?;
            Ok(())
        })?;
        undo(cx, &s, &at, vec![key("templates", &id)]);
        cx.effect(EffectAction::Trashed, "entry_template", id.as_str(), None);
        Ok(Done { id: input.id })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ModulePutIn {
    pub book: String,
    pub template: String,
    pub module: types::ModuleSpec,
}
op! {
    ModulePut="entry_template.put_module",Write,Book,"Add or update a module definition on a v3 template.",fn(cx,input:ModulePutIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let mut t = template_of(&s.reader_v3.view(), &input.template)?;
        let module: m::ModuleSpec = convert(input.module)?;
        let id = module.id.clone();
        t.modules.retain(|m| m.id != module.id);
        t.modules.push(module);
        put(cx, &input.book, t, Some(id.as_str()))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ModuleRemoveIn {
    pub book: String,
    pub template: String,
    pub module: String,
}
op! {
    ModuleRemove="entry_template.remove_module",Write,Book,"Remove a v3 module definition while retaining values and prose on existing entries.",fn(cx,input:ModuleRemoveIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let mut t = template_of(&s.reader_v3.view(), &input.template)?;
        t.modules.retain(|m| m.id.as_str() != input.module);
        put(cx, &input.book, t, Some(&input.module))
    }
}
