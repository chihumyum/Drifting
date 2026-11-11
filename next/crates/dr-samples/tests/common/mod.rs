#![allow(dead_code)]
//! Explicit fixture-only policy for #22 (`act_binding`). Never a product default.
use dr_doc::v3::novel::*;
use dr_model::{id::*, kind::*, v3::*};
use dr_samples::v3::*;
fn tid(id: &str) -> EntryTemplateId {
    EntryTemplateId::parse(id).unwrap()
}
pub fn test_choices(_source: &dr_samples::SeededBook) -> MappingChoices {
    MappingChoices {
        act_binding: Some(ActBindingChoice {
            act_is_source: true,
            relation_type: RelationTypeV3 {
                id: RelationTypeId::parse("test-act-notes").unwrap(),
                name: "Test act notes".into(),
                normalized_name: "test act notes".into(),
                description: String::new(),
                orientation: RelationOrientation::Directed,
                system_key: None,
                locked: false,
                source_role: String::new(),
                target_role: String::new(),
                color: None,
                source_kinds: vec![EntityKind::Entry],
                target_kinds: vec![EntityKind::Entry],
                source_templates: vec![tid(TPL_GROUP)],
                target_templates: vec![tid(TPL_IDEA)],
            },
        }),
    }
}
