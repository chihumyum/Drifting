//! Universal commands. Every operation checks the book version before writing.
use super::{BookIn, Done, EntityIn, Named, name_ok, now, pid};
use crate::cx::{Cx, EffectAction, Invocation};
use crate::error::{Result, WsError};
use crate::naming::{frontiers_from_hex, frontiers_hex};
use crate::registry::Registry;
use crate::workspace::BookSlot;
use dr_doc::v3::{BookViewV3, CollectionV3};
use dr_model::id::*;
use dr_model::v3 as m;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

macro_rules! op {
    (
        $(#[$m:meta])*
        $ty:ident = $name:literal, $access:ident, $conc:ident, $summary:literal,
        fn($cx:ident, $inp:ident: $input:ty) -> $output:ty $body:block
    ) => {
        $(#[$m])*
        pub struct $ty;
        impl $crate::registry::Op for $ty {
            const BOOK_VERSION: Option<i64> = Some(3);
            const NAME: &'static str = $name;
            const ACCESS: $crate::registry::Access = $crate::registry::Access::$access;
            const CONCURRENCY: $crate::registry::Concurrency =
                $crate::registry::Concurrency::$conc;
            const SUMMARY: &'static str = $summary;
            type Input = $input;
            type Output = $output;
            #[allow(unused_variables)]
            fn run($cx: &$crate::cx::Cx<'_>, $inp: Self::Input) -> $crate::error::Result<$output> $body
        }
    };
}

pub mod content;
pub mod entry;
pub mod history;
pub mod membership;
pub mod module;
pub mod template;
pub mod timeline;
pub mod types;

pub(crate) fn register(r: &mut Registry) {
    content::register(r);
    entry::register(r);
    template::register(r);
    module::register(r);
    membership::register(r);
    timeline::register(r);
    history::register(r);
}

fn convert<T: serde::de::DeserializeOwned>(value: impl Serialize) -> Result<T> {
    serde_json::from_value(
        serde_json::to_value(value).map_err(|e| WsError::Internal(e.to_string()))?,
    )
    .map_err(|e| WsError::invalid(e.to_string()))
}
fn live(v: &BookViewV3<'_>, id: &str) -> Result<m::Entry> {
    v.entry(&pid("entry", id)?)
        .filter(|e| !e.is_trashed())
        .ok_or_else(|| WsError::not_found("entry", id))
}
fn template_of(v: &BookViewV3<'_>, id: &str) -> Result<m::EntryTemplate> {
    v.template(&pid("template", id)?)
        .filter(|t| !t.is_trashed())
        .ok_or_else(|| WsError::not_found("template", id))
}
fn graph_ok(
    entries: &BTreeMap<EntryId, m::Entry>,
    templates: &BTreeMap<EntryTemplateId, m::EntryTemplate>,
    memberships: &[m::Membership],
) -> Result<()> {
    for e in entries.values().filter(|e| !e.is_trashed()) {
        let declares = e
            .overrides
            .as_ref()
            .and_then(|o| o.is_manuscript)
            .or_else(|| {
                e.effective_template(templates)
                    .and_then(|t| t.settings.is_manuscript)
            })
            .unwrap_or(false);
        m::check_manuscript_no_nest(&e.id, declares, entries, templates)?;
        let hosts = memberships
            .iter()
            .filter(|r| {
                r.member == e.id
                    && m::check_membership(&r.host, &r.member, entries, templates).is_ok()
            })
            .map(|r| r.host.clone())
            .collect::<Vec<_>>();
        m::check_autolink_name_unique(
            Some(&e.id),
            e.parent.as_ref(),
            &hosts,
            e.is_leaf(templates),
            &e.title,
            &e.aliases(templates).into_iter().collect::<Vec<_>>(),
            memberships,
            entries,
            templates,
        )?;
    }
    Ok(())
}
fn settings_ok(settings: &m::LevelSettingsOverride, v: &BookViewV3<'_>) -> Result<()> {
    let templates = v.templates_map();
    if settings.display.as_ref().is_some_and(|d| !d.is_known())
        || settings
            .format_shortcuts
            .as_ref()
            .is_some_and(|f| !f.is_known())
    {
        return Err(WsError::invalid("unknown level display or formatting mode"));
    }
    if let Some(Some(id)) = &settings.default_template {
        m::check_entry_template(&templates, Some(id))?;
    }
    if let Some(ids) = &settings.allow {
        for id in ids {
            m::check_entry_template(&templates, Some(id))?;
        }
    }
    if let Some(Some(id)) = &settings.home {
        let e = live(v, id.as_str())?;
        if !e.is_level(&templates) {
            return Err(WsError::invalid("home must be a level"));
        }
    }
    Ok(())
}
fn body_id(entry: &EntryId, module: &ModuleId) -> DocId {
    DocId::Body(BodyDocId::new(entry.clone(), module.clone()))
}
fn template_doc(book: &BookId, template: &EntryTemplateId, module: &ModuleId) -> Result<DocId> {
    Ok(DocId::Template(pid(
        "template document",
        &format!("{book}/{template}/{module}"),
    )?))
}
fn valid_doc(doc: &DocId) -> Result<()> {
    DocId::parse(&doc.to_string())
        .map(|_| ())
        .map_err(|e| WsError::invalid(e.to_string()))
}
fn owns(cx: &Cx<'_>, slot: &BookSlot, doc: &DocId) -> Result<()> {
    if !slot.reader_v3.view().owns_prose(doc) {
        return Err(WsError::not_found("prose owner", doc.to_string()));
    }
    if let Some(info) = cx.workspace().library().doc_info(&doc.to_string())?
        && info.book_id.as_deref() != Some(slot.book.as_str())
    {
        return Err(WsError::invalid("prose belongs to another book"));
    }
    Ok(())
}
fn undo(cx: &Cx<'_>, slot: &BookSlot, at: &loro::Frontiers, keys: Vec<history::Key>) {
    cx.undo_with(Invocation::new(
        "entry_history.restore",
        history::RestoreIn {
            book: slot.book.to_string(),
            at: frontiers_hex(at),
            targets: keys,
        },
    ));
}
fn key(collection: &str, id: impl ToString) -> history::Key {
    history::Key {
        collection: collection.into(),
        id: id.to_string(),
    }
}
