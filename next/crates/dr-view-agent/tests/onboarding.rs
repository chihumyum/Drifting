use dr_view_agent::onboarding::{Event, Step, View, next_step, resolve_view, waits_on_change};

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
