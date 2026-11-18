use super::*;
pub(crate) fn register(r: &mut Registry) {
    r.add::<TemplateList>()
        .add::<TemplatePut>()
        .add::<TemplateDelete>()
        .add::<ModulePut>()
        .add::<ModuleRemove>();
}
op! {
    TemplateList="entry_template.list",Read,Shared,"List the templates of a book: modules, the switch's default, linkable, settings and actions.",fn(cx,input:BookIn)->Vec<types::EntryTemplate> {
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
fn put(
    cx: &Cx<'_>,
    book: &str,
    mut t: m::EntryTemplate,
    module: Option<&str>,
    draft: bool,
) -> Result<Done> {
    let slot = cx.book_v3(book)?;
    let v = slot.reader_v3.view();
    let before = v.graph();
    let mut templates = before.templates.clone();
    name_ok(&t.name)?;
    if let Some(mark) = &t.mark
        && !m::is_valid_mark(mark)
    {
        return Err(WsError::invalid(
            "mark must be a sand mark name or a single character",
        ));
    }
    if t.deleted_at.is_some() {
        return Err(WsError::invalid("use a live template"));
    }
    for module in &mut t.modules {
        for field in &mut module.config.defs {
            if matches!(field.default_value, Some(m::FieldValue::Null)) {
                field.default_value = None;
            }
        }
    }
    if t.settings.display.as_ref().is_some_and(|d| !d.is_known())
        || t.settings
            .format_shortcuts
            .as_ref()
            .is_some_and(|f| !f.is_known())
    {
        return Err(WsError::invalid("unknown level display or formatting mode"));
    }
    templates.insert(t.id.clone(), t.clone());
    let mut ids = BTreeSet::new();
    for module in &t.modules {
        name_ok(&module.name)?;
        if !module.kind.is_known() || !ids.insert(&module.id) {
            return Err(WsError::invalid("unknown or duplicate module"));
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
    // References may point to the template being created. The template's
    // switch default never changes an existing entry's switch.
    for id in t.settings.default_template.iter().flatten() {
        m::check_entry_template(&templates, Some(id))?;
    }
    if let Some(Some(home)) = &t.settings.home {
        let e = live(&v, home.as_str())?;
        if !e.is_level() {
            return Err(WsError::invalid(
                "home must be a live entry with its switch on",
            ));
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
    let after = BookGraphV3 {
        templates,
        ..before.clone()
    };
    changes_ok(&before, &after)?;
    let id = t.id.clone();
    let title = t.name.clone();
    let template = rec(CollectionV3::Templates, &id);
    let replaced = match module {
        Some(module) => template.at(["modules", module]),
        None => template,
    };
    // A template that starts taking entries from elsewhere brings the
    // members of its entries back: where such an entry is a lane of a live
    // view, they get a position there (`VIEW-LANE-MEMBERS-PLACED`). Only the
    // lanes are looked at, and only those that leave `accept` to the
    // template.
    let accept_on = t.settings.accept == Some(true)
        && before
            .templates
            .get(&t.id)
            .is_none_or(|old| old.settings.accept != Some(true));
    let mut lanes: Vec<EntryId> = Vec::new();
    if accept_on {
        for tv in v.timeline_views_raw().iter().filter(|tv| !tv.is_trashed()) {
            for lane in &tv.lanes {
                let follows = before.entries.get(&lane.entry).is_some_and(|e| {
                    e.template.as_ref() == Some(&t.id)
                        && e.overrides.as_ref().is_none_or(|o| o.accept.is_none())
                });
                if follows && !lanes.contains(&lane.entry) {
                    lanes.push(lane.entry.clone());
                }
            }
        }
    }
    let (placed, at) = cx.write_book_v3(&slot, Replaces::records([replaced]), move |tx| {
        if draft && tx.view().template(&t.id).is_some() {
            return Err(WsError::Conflict("template draft id already exists".into()));
        }
        tx.template(&t.id)?.set_full(&t)?;
        let mut placed = BTreeSet::new();
        for lane in &lanes {
            placed.extend(membership::place_unplaced_lane_entries(tx, lane)?);
        }
        Ok(placed)
    })?;
    if !draft {
        let mut keys = vec![key("templates", &id)];
        keys.extend(placed.iter().map(|vid| key("timeline_views", vid)));
        undo(cx, &slot, &at, keys);
        cx.effect(
            EffectAction::Updated,
            "entry_template",
            id.as_str(),
            Some(&title),
        );
    }
    Ok(Done { id: id.to_string() })
}
op! {
    TemplatePut="entry_template.put",Write,Book,"Create or replace a template definition (any modules, the switch's default, linkable, settings, actions) while retaining existing entry content and switches.",fn(cx,input:PutIn)->Done {
        put(cx, &input.book, convert(input.template)?, None, false)
    }
}
op! {
    TemplateDelete="entry_template.delete",Write,Book,"Delete an unused template without deleting its retained prose documents.",fn(cx,input:EntityIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let v = s.reader_v3.view();
        let t = template_of(&v, &input.id)?;
        m::check_template_delete(&t.id, &v.entry_headers())?;
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
/// The initial definition created for a new full-editor pill. Only these
/// drafts can use the unjournaled cleanup path.
#[derive(Clone)]
pub struct EntryTemplateDraft {
    book: String,
    initial: m::EntryTemplate,
}

impl EntryTemplateDraft {
    pub fn book(&self) -> &str {
        &self.book
    }

    pub fn id(&self) -> &EntryTemplateId {
        &self.initial.id
    }
}

impl crate::Workspace {
    /// Materialize the full editor's initial draft without creating an undo step.
    pub fn create_entry_template_draft(
        &self,
        book: &str,
        draft: types::EntryTemplate,
    ) -> Result<EntryTemplateDraft> {
        let spec = crate::registry::registry()
            .get("entry_template.put")
            .expect("entry template put is registered");
        let cx = Cx::new(self, &crate::Actor::User, spec);
        let draft: m::EntryTemplate = convert(draft)?;
        put(&cx, book, draft.clone(), None, true)?;
        Ok(EntryTemplateDraft {
            book: book.to_owned(),
            initial: draft,
        })
    }

    /// Closing a new editor can remove its unchanged, unused draft. Compare the
    /// definition and its uses in the same holder job as the removal, including
    /// changes from sync. No trash record or undo step is made.
    pub fn discard_entry_template_draft(&self, draft: EntryTemplateDraft) -> Result<()> {
        let EntryTemplateDraft { book, initial } = draft;
        let spec = crate::registry::registry()
            .get("entry_template.delete")
            .expect("entry template delete is registered");
        let cx = Cx::new(self, &crate::Actor::User, spec);
        let slot = cx.book_v3(&book)?;
        let id = initial.id.clone();
        let doc_prefix = format!("template:{book}/{id}/");
        if self
            .library()
            .docs(Some(&book), Some("template"))?
            .iter()
            .any(|doc| doc.doc_id.starts_with(&doc_prefix))
        {
            return Ok(());
        }

        cx.write_book_v3(
            &slot,
            Replaces::records([rec(CollectionV3::Templates, &id)]),
            move |tx| {
                let view = tx.view();
                if view.template(&id).as_ref() != Some(&initial) {
                    return Ok(());
                }
                let defaults_to = |settings: &m::LevelSettingsOverride| {
                    settings.default_template.as_ref().and_then(Option::as_ref) == Some(&id)
                };
                let graph = view.graph();
                if graph.entries.values().any(|entry| {
                    entry.template.as_ref() == Some(&id)
                        || entry.overrides.as_ref().is_some_and(defaults_to)
                }) || graph.templates.values().any(|template| {
                    defaults_to(&template.settings)
                        || template
                            .verbs
                            .iter()
                            .any(|verb| verb.target_template.as_ref() == Some(&id))
                        || template.modules.iter().any(|module| {
                            module
                                .config
                                .defs
                                .iter()
                                .any(|field| field.target_template.as_ref() == Some(&id))
                        })
                }) {
                    return Ok(());
                }
                tx.purge(CollectionV3::Templates, id.as_str())?;
                Ok(())
            },
        )?;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ModulePutIn {
    pub book: String,
    pub template: String,
    pub module: types::ModuleSpec,
}
op! {
    ModulePut="entry_template.put_module",Write,Book,"Add or update a module definition of any kind on a template.",fn(cx,input:ModulePutIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let mut t = template_of(&s.reader_v3.view(), &input.template)?;
        let module: m::ModuleSpec = convert(input.module)?;
        let id = module.id.clone();
        t.modules.retain(|m| m.id != module.id);
        t.modules.push(module);
        put(cx, &input.book, t, Some(id.as_str()), false)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ModuleRemoveIn {
    pub book: String,
    pub template: String,
    pub module: String,
}
op! {
    ModuleRemove="entry_template.remove_module",Write,Book,"Remove a module definition while retaining values and prose on existing entries.",fn(cx,input:ModuleRemoveIn)->Done {
        let s = cx.book_v3(&input.book)?;
        let mut t = template_of(&s.reader_v3.view(), &input.template)?;
        t.modules.retain(|m| m.id.as_str() != input.module);
        put(cx, &input.book, t, Some(&input.module), false)
    }
}
