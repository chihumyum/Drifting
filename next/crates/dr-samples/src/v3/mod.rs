//! The sample recipes and the legacy import share this typed v2-catalog to
//! v3 adapter. It never changes the source document or the v3 schema.
//!
//! Undecided migration policy is explicit input, not a new novel default.

mod catalog;
mod samples;
pub use catalog::{sync_catalog, validate};
pub use samples::{SampleBookV3, a_q, convert, pride_and_prejudice, write_book};

use std::collections::BTreeMap;

use dr_doc::import_v1::BookView;
use dr_doc::v3::novel::*;
use dr_model::id::*;
use dr_model::import_v1::EntityRef;
use dr_model::kind::EntityKind;
use dr_model::v3::{EntryTemplate, RelationTypeV3};
use serde::{Deserialize, Serialize};

/// Choices still awaiting the author (m10-import.md 22, 23, 25). There is
/// deliberately no permissive default. Tests supply labelled test choices.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MappingChoices {
    /// Explicit symbolic ids for fresh novel roots. These aliases are resolved
    /// only inside the newly allocated target, never to source/old-library ids.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub root_references: BTreeMap<EntryId, RootReference>,
    pub act_binding: Option<ActBindingChoice>,
    pub unaffiliated: Option<UnaffiliatedChoice>,
    pub relation_templates: BTreeMap<RelationTypeId, TemplateRestriction>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RootReference {
    Manuscript,
    Ideas,
    Elements,
    Storylines,
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
        DocId::Template(id) => match id.owner() {
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
    /// Resolve author-selected aliases against this transaction's actual
    /// roots. No root role is selected by default, and the full template is
    /// otherwise unchanged. Empty aliases keep the existing mapping hash.
    pub(crate) fn resolved_roots(
        &self,
        roots: [&EntryId; 4],
        source: &BookView<'_>,
    ) -> dr_doc::Result<Self> {
        let authored = source
            .nodes()
            .iter()
            .map(|e| e.id.to_string())
            .chain(source.acts().iter().map(|e| e.id.to_string()))
            .chain(source.drift_groups().iter().map(|e| e.id.to_string()))
            .chain(source.categories().iter().map(|e| e.id.to_string()))
            .chain(source.elements().iter().map(|e| e.id.to_string()))
            .chain(source.storylines().iter().map(|e| e.id.to_string()))
            .collect::<std::collections::BTreeSet<_>>();
        if self
            .root_references
            .keys()
            .any(|id| authored.contains(id.as_str()))
        {
            return Err(catalog::invalid(
                "root reference collides with an authored source entry",
            ));
        }
        let resolve = |id: &EntryId| match self.root_references.get(id) {
            Some(RootReference::Manuscript) => (*roots[0]).clone(),
            Some(RootReference::Ideas) => (*roots[1]).clone(),
            Some(RootReference::Elements) => (*roots[2]).clone(),
            Some(RootReference::Storylines) => (*roots[3]).clone(),
            None => id.clone(),
        };
        let mut mapped = self.clone();
        if let Some(choice) = &mut mapped.unaffiliated {
            choice.parent = choice.parent.as_ref().map(resolve);
            choice.template.settings.home = choice
                .template
                .settings
                .home
                .as_ref()
                .map(|v| v.as_ref().map(resolve));
        }
        Ok(mapped)
    }

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
