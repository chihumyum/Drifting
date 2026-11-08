use dr_i18n::keys::agent_panel::onboarding::prompts as k;
use dr_view_agent::onboarding::{
    Chapter, Element, Event, StarterSource, Step, View, build_starter_prompts, next_step,
    resolve_view, waits_on_change,
};

#[test]
fn migration_is_once_and_does_not_override_explicit_reset_or_unknown_values() {
    use dr_view_agent::onboarding::initial_step;
    assert_eq!(initial_step(None, true), Step::Done);
    assert_eq!(initial_step(None, false), Step::New);
    for step in [Step::New, Step::Change, Step::Done] {
        assert_eq!(
            initial_step(Some(serde_json::to_value(step).unwrap()), true),
            step
        );
    }
    assert_eq!(
        initial_step(Some(serde_json::json!("future")), true),
        Step::New
    );
    assert_eq!(
        initial_step(Some(serde_json::json!(false)), true),
        Step::New
    );
}

#[test]
fn guide_never_covers_an_existing_or_starting_conversation() {
    for step in [Step::New, Step::Change, Step::Done] {
        for usable in [None, Some(false), Some(true)] {
            assert_eq!(resolve_view(step, usable, false), None);
        }
        assert_eq!(resolve_view(step, None, true), None);
        assert_eq!(resolve_view(step, Some(false), true), Some(View::Connect));
    }
    assert_eq!(
        resolve_view(Step::New, Some(true), true),
        Some(View::Suggest)
    );
    assert_eq!(resolve_view(Step::Change, Some(true), true), None);
    assert_eq!(resolve_view(Step::Done, Some(true), true), None);
}

#[test]
fn only_sending_then_opening_a_real_change_finishes_the_guide() {
    assert_eq!(next_step(Step::New, Event::ChangeSeen), Step::New);
    let step = next_step(Step::New, Event::Sent);
    assert_eq!(step, Step::Change);
    assert!(!waits_on_change(step, 0));
    assert!(waits_on_change(step, 1));
    assert_eq!(next_step(step, Event::Sent), step);
    assert_eq!(next_step(step, Event::ChangeSeen), Step::Done);
    assert_eq!(next_step(Step::Done, Event::Sent), Step::Done);
    assert_eq!(next_step(Step::Done, Event::Reset), Step::New);
}

#[test]
fn starters_follow_recent_written_chapter_then_book_order_and_element_links() {
    let seed = dr_testkit::seed::generate(dr_testkit::seed::Preset::Tiny, 31).unwrap();
    let reader = seed.books[0].book.view();
    let chapters = reader.chapters();
    let elements = reader.elements();
    let mut source = StarterSource {
        chapters: chapters
            .iter()
            .take(3)
            .enumerate()
            .map(|(index, chapter)| Chapter {
                id: chapter.id.to_string(),
                title: chapter.title.clone(),
                book_order: index,
                word_count: if index == 2 { 0 } else { 1 },
            })
            .collect(),
        elements: elements
            .iter()
            .take(3)
            .map(|element| Element {
                id: element.id.to_string(),
                name: element.name.clone(),
            })
            .collect(),
        recent_chapter_ids: vec![chapters[2].id.to_string(), chapters[1].id.to_string()],
        ..Default::default()
    };
    source.relation_counts.insert(elements[2].id.to_string(), 3);
    let prompts = build_starter_prompts(&source);
    assert_eq!(prompts.len(), 3);
    assert_eq!(prompts[0].key, k::COMMENT_CHAPTER);
    assert_eq!(
        prompts[0].values,
        vec![("chapter", chapters[1].title.clone())]
    );
    assert_eq!(prompts[1].key, k::TIGHTEN_CHAPTER);
    assert_eq!(prompts[2].key, k::RELATE_ELEMENTS);
    assert_eq!(
        prompts[2].values,
        vec![
            ("first", elements[2].name.clone()),
            ("second", elements[0].name.clone())
        ]
    );
    source.recent_chapter_ids.clear();
    source.elements.truncate(1);
    let prompts = build_starter_prompts(&source);
    assert_eq!(
        prompts[0].values,
        vec![("chapter", chapters[0].title.clone())]
    );
    assert_eq!(prompts[2].key, k::COMPLETE_ELEMENT);
    source.elements.clear();
    assert_eq!(build_starter_prompts(&source)[2].key, k::EXTRACT_ELEMENTS);
    source.chapters.clear();
    assert_eq!(
        build_starter_prompts(&source)
            .iter()
            .map(|prompt| prompt.key)
            .collect::<Vec<_>>(),
        [k::OUTLINE, k::INTERVIEW, k::CAST_CHARACTERS]
    );
}
