//! The sample recipes and the legacy import share this typed v2-catalog to
//! v3 adapter. It never changes the source document or the v3 schema.
//!
//! Undecided migration policy is explicit input, not a new novel default.

mod catalog;
mod samples;
pub use catalog::{sync_catalog, validate};
pub use samples::{SampleBookV3, a_q, convert, pride_and_prejudice, write_book};

use std::collections::BTreeMap;

use dr_doc::book::BookView;
use dr_doc::v3::novel::*;
use dr_model::book::EntityRef;
use dr_model::id::*;
use dr_model::kind::EntityKind;
use dr_model::v3::{EntryTemplate, RelationTypeV3};
use serde::{Deserialize, Serialize};

/// Choices still awaiting the author (m10-import.md 22, 23, 25). There is
/// deliberately no permissive default. Tests supply labelled test choices.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MappingChoices {
    pub act_binding: Option<ActBindingChoice>,
    pub unaffiliated: Option<UnaffiliatedChoice>,
    pub relation_templates: BTreeMap<RelationTypeId, TemplateRestriction>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActBindingChoice {
    pub relation_type: RelationTypeV3,
    pub act_is_source: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UnaffiliatedChoice {
    pub parent: Option<EntryId>,
    /// A full level template states default/allow/home explicitly.
    pub template: EntryTemplate,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TemplateRestriction {
    pub source: Vec<EntryTemplateId>,
    pub target: Vec<EntryTemplateId>,
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

pub const UNAFFILIATED: &str = "import-unaffiliated";

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

/// Length-framed UTF-8 avoids concatenation collisions; names never become
/// ids themselves. FNV-1a is only an id derivation, not a security boundary.
pub fn element_group(category: &str, name: &str) -> EntryId {
    let mut hash = 0xcbf29ce484222325_u64;
    for bytes in [category.as_bytes(), name.as_bytes()] {
        for byte in (bytes.len() as u64).to_le_bytes().iter().chain(bytes) {
            hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        }
    }
    eid(&format!("import-element-group-{hash:016x}"))
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

pub fn body_id(entry: &str, module: &str) -> DocId {
    DocId::Body(BodyDocId::new(eid(entry), mid(module)))
}

/// The id map is shared by body writing, history, TODO projections and
/// template ownership. It does not change material document identities.
pub fn prose_id(old: &DocId) -> DocId {
    match old {
        DocId::Node(id) => body_id(id.as_str(), MOD_PROSE),
        DocId::Element(id) => body_id(id.as_str(), MOD_PROSE),
        DocId::Category(id) => body_id(id.as_str(), MOD_ABOUT),
        DocId::Storyline(id) => body_id(id.as_str(), MOD_ABOUT),
        DocId::Template(id) => match id.owner() {
            Some(TemplateOwner::Category(id)) => DocId::Template(TemplateId::for_entry_module(
                &category_template(id.as_str()),
                &mid(MOD_PROSE),
            )),
            Some(TemplateOwner::Storyline(id)) => DocId::Template(TemplateId::for_entry_module(
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
    pub fn pending(&self, source: &BookView<'_>) -> Vec<Pending> {
        let mut out = Vec::new();
        let mut add = |code: &str, source: String| {
            out.push(Pending {
                code: code.into(),
                source,
            })
        };
        for act in source.acts().iter().filter(|a| a.drift.is_some()) {
            if self.act_binding.is_none() {
                add(
                    "act-binding-relation-type-and-direction",
                    act.id.to_string(),
                );
            }
        }
        if self.unaffiliated.is_none()
            && source
                .nodes()
                .iter()
                .any(|n| n.narrative_order.is_some() && n.storylines.is_empty())
        {
            add(
                "synthetic-lane-tree-home-and-template-settings",
                source.book_id().to_string(),
            );
        }
        for rt in source
            .relation_types()
            .iter()
            .filter(|r| !r.locked && r.system_key.is_none())
        {
            if rt
                .source_kinds
                .iter()
                .chain(&rt.target_kinds)
                .any(|k| map_kind(k) != *k)
                && !self.relation_templates.contains_key(&rt.id)
            {
                add("relation-type-template-restrictions", rt.id.to_string());
            }
        }
        out
    }
}
