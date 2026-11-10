#![allow(dead_code)]
//! Explicit fixture-only policy. Never a product default.
use dr_doc::v3::novel::*;
use dr_model::{id::*, kind::*, v3::*};
use dr_samples::v3::*;
fn tid(id: &str) -> EntryTemplateId {
    EntryTemplateId::parse(id).unwrap()
}
pub fn test_choices(source: &dr_samples::SeededBook) -> MappingChoices {
    let mut choices = MappingChoices::default();
    let mut lane = novel_project_templates()
        .into_iter()
        .find(|t| t.id.as_str() == TPL_STORYLINE)
        .unwrap();
    lane.id = tid("test-unaffiliated-lane");
    lane.settings.home = Some(None);
    choices.unaffiliated = Some(UnaffiliatedChoice {
        parent: None,
        template: lane,
    });
    choices.act_binding = Some(ActBindingChoice {
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
    });
    let all: Vec<_> = source
        .book
        .view()
        .categories()
        .iter()
        .map(|c| category_template(c.id.as_str()))
        .chain([
            tid(TPL_CHAPTER),
            tid(TPL_IDEA),
            tid(TPL_STORYLINE),
            tid(TPL_CATEGORY),
            tid(TPL_GROUP),
        ])
        .collect();
    for rt in source
        .book
        .view()
        .relation_types()
        .iter()
        .filter(|r| !r.locked && r.system_key.is_none())
    {
        choices.relation_templates.insert(
            rt.id.clone(),
            TemplateRestriction {
                source: all.clone(),
                target: all.clone(),
            },
        );
    }
    choices
}
