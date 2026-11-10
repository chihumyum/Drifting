//! The empty conversation is the guide. These decisions are independent of
//! the view and use the same rules as the 0.1 onboarding.

use dr_i18n::Key;
use dr_shell::Settings;
use gpui::App;
use serde::{Deserialize, Serialize};

pub const STEP_KEY: &str = "agent.onboarding";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Step {
    #[default]
    New,
    Change,
    Done,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// Only a send from the companion advances this guide.
    Sent,
    ChangeSeen,
    Reset,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    Connect,
    Suggest,
}

pub fn next_step(step: Step, event: Event) -> Step {
    match (step, event) {
        (Step::New, Event::Sent) => Step::Change,
        (Step::Change, Event::ChangeSeen) => Step::Done,
        (_, Event::Reset) => Step::New,
        _ => step,
    }
}

pub fn resolve_view(step: Step, usable: Option<bool>, empty_conversation: bool) -> Option<View> {
    match (empty_conversation, usable, step) {
        (true, Some(false), _) => Some(View::Connect),
        (true, Some(true), Step::New) => Some(View::Suggest),
        _ => None,
    }
}

pub fn waits_on_change(step: Step, changed_entities: usize) -> bool {
    step == Step::Change && changed_entities > 0
}

pub fn step(cx: &App) -> Step {
    initial_step(Settings::device_memory(cx, STEP_KEY), false)
}

/// The one-time 0.1 migration rule: an absent value with a remembered,
/// existing conversation means this installation has already used Agent.
/// An explicit reset (New), or damaged/unknown stored value, stays New.
pub fn initial_step(stored: Option<serde_json::Value>, has_remembered_conversation: bool) -> Step {
    match stored {
        Some(value) => serde_json::from_value(value).unwrap_or_default(),
        None if has_remembered_conversation => Step::Done,
        None => Step::New,
    }
}

/// Call once the conversation list can confirm the remembered conversation.
/// Empty installations are marked New too, so a later first conversation is
/// not mistaken for a migration. Existing explicit steps are never changed.
pub fn migrate_existing(cx: &mut App, has_remembered_conversation: bool) -> Step {
    let stored = Settings::device_memory(cx, STEP_KEY);
    let next = initial_step(stored.clone(), has_remembered_conversation);
    if stored
        .as_ref()
        .is_none_or(|value| serde_json::from_value::<Step>(value.clone()).is_err())
    {
        Settings::set_device_memory(cx, STEP_KEY, serde_json::to_value(next).ok());
    }
    next
}

pub fn note(cx: &mut App, event: Event) {
    let before = step(cx);
    let after = next_step(before, event);
    if before != after || event == Event::Reset {
        Settings::set_device_memory(cx, STEP_KEY, serde_json::to_value(after).ok());
        cx.refresh_windows();
    }
}

/// Empty conversations use the copied template guidance in Agent context.
#[derive(Clone, Debug, Default)]
pub struct StarterSource;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StarterPrompt {
    pub key: Key,
    pub values: Vec<(&'static str, String)>,
}

pub fn build_starter_prompts(_: &StarterSource) -> Vec<StarterPrompt> {
    Vec::new()
}
