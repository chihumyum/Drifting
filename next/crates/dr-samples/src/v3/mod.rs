//! The sample recipes and the legacy import share this typed v2-catalog to
//! v3 adapter. It never changes the source document or the v3 schema.
//!
//! Undecided migration policy is explicit input, not a new novel default.

mod catalog;
mod samples;
pub use catalog::{act_import_notes, side_documents, sync_catalog, validate};
pub use samples::{SampleBookV3, a_q, convert, pride_and_prejudice, write_book};

use dr_doc::import_v1::BookView;
use dr_doc::v3::novel::*;
use dr_model::id::*;
use dr_model::import_v1::{EntityRef, TemplateOwner};
use dr_model::kind::EntityKind;
use serde::{Deserialize, Serialize};

/// Items 22 (act track), 23 (`未归属`) and 25 (relation-type endpoint kinds)
/// all use settled product defaults (author decision, 2026-11-11). Optional
/// `profile` remains available for developer/test resume-policy tags.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MappingChoices {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pending {
    pub code: String,
    pub source: String,
}

pub(crate) fn eid(s: &str) -> EntryId {
    EntryId::parse(s).expect("checked entry id")
}
pub(crate) fn tid(s: &str) -> EntryTemplateId {
    EntryTemplateId::parse(s).expect("checked template id")
}
pub(crate) fn mid(s: &str) -> ModuleId {
    ModuleId::parse(s).expect("checked module id")
}

fn template_id(namespace: &str, source: &str) -> EntryTemplateId {
    let full = format!("import-{namespace}-{source}");
    EntryTemplateId::parse(&full)
        .ok()
        .filter(|id| id.as_str().len() + 1 + MOD_PROSE.len() <= dr_model::id::MAX_ID_LEN)
        .unwrap_or_else(|| {
            tid(&format!(
                "import-{namespace}-{:016x}",
                dr_doc::peer::fnv1a64(source.as_bytes())
            ))
        })
}
pub fn category_template(id: &str) -> EntryTemplateId {
    template_id("category", id)
}
pub fn storyline_template(id: &str) -> EntryTemplateId {
    template_id("storyline", id)
}

pub fn map_kind(kind: &EntityKind) -> EntityKind {
    match kind {
        EntityKind::Node | EntityKind::Element | EntityKind::Storyline | EntityKind::Category => {
            EntityKind::Entry
        }
        other => other.clone(),
    }
}

pub fn map_ref(r: &EntityRef) -> EntityRef {
    EntityRef::new(map_kind(&r.kind), &r.id)
}

/// Default v3 prose module implied by a legacy entity kind when addressing its
/// prose body (`Node` / `Element` -> `mod-prose`, `Category` / `Storyline` -> `about`).
pub fn default_link_module(kind: &EntityKind) -> Option<ModuleId> {
    match kind {
        EntityKind::Node | EntityKind::Element => Some(mid(MOD_PROSE)),
        EntityKind::Storyline | EntityKind::Category => Some(mid(MOD_ABOUT)),
        _ => None,
    }
}

/// Adapt a legacy [`dr_model::prose::EntityLink`] (plus an optional explicit
/// target module) into a validated [`dr_model::v3::EntityLinkV3`].
pub fn map_entity_link(
    link: &dr_model::prose::EntityLink,
    explicit_module: Option<ModuleId>,
) -> dr_doc::Result<dr_model::v3::EntityLinkV3> {
    let kind = map_kind(&link.kind);
    if !kind.may_be_linked_v3() {
        return Err(dr_doc::DocError::NotInProfile("invalid v3 entity link"));
    }
    if kind == EntityKind::Material && explicit_module.is_some() {
        return Err(dr_doc::DocError::NotInProfile(
            "material link cannot carry a module",
        ));
    }
    let valid_target = match kind {
        EntityKind::Entry => EntryId::parse(&link.target).is_ok(),
        EntityKind::Material => MaterialId::parse(&link.target).is_ok(),
        _ => false,
    };
    if !valid_target {
        return Err(dr_doc::DocError::NotInProfile("invalid v3 entity link"));
    }
    let module = match explicit_module {
        Some(m) => Some(m),
        None if link.block.is_some() || link.end_block.is_some() => default_link_module(&link.kind),
        None => None,
    };
    Ok(dr_model::v3::EntityLinkV3 {
        target: link.target.clone(),
        kind,
        module,
        block: link.block.clone(),
        end_block: link.end_block.clone(),
    })
}

pub fn body_id(entry: &str, module: &str) -> DocId {
    DocId::Body(BodyDocId::new(eid(entry), mid(module)))
}

/// The id map is shared by body writing, history, TODO projections and
/// template ownership. It does not change material document identities.
pub fn prose_id(book: &BookId, old: &DocId) -> DocId {
    match old {
        DocId::Node(id) => body_id(id.as_str(), MOD_PROSE),
        DocId::Element(id) => body_id(id.as_str(), MOD_PROSE),
        DocId::Category(id) => body_id(id.as_str(), MOD_ABOUT),
        DocId::Storyline(id) => body_id(id.as_str(), MOD_ABOUT),
        DocId::Template(id) => match TemplateOwner::of(id) {
            Some(TemplateOwner::Category(id)) => DocId::Template(TemplateId::for_entry_module(
                book,
                &category_template(id.as_str()),
                &mid(MOD_PROSE),
            )),
            Some(TemplateOwner::Storyline(id)) => DocId::Template(TemplateId::for_entry_module(
                book,
                &storyline_template(id.as_str()),
                &mid(MOD_PROSE),
            )),
            None => old.clone(),
        },
        other => other.clone(),
    }
}

impl MappingChoices {
    /// Policy questions only. Source integrity is checked separately by the
    /// importer, before any target or installation identity is written.
    pub fn pending(&self, _source: &BookView<'_>) -> Vec<Pending> {
        Vec::new()
    }
}
