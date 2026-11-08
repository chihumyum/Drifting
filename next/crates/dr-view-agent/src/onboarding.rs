//! The empty conversation is the guide. These decisions are independent of
//! the view and use the same rules as the 0.1 onboarding.

use std::collections::HashMap;

use dr_i18n::{Key, keys};
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chapter {
    pub id: String,
    pub title: String,
    pub book_order: usize,
    pub word_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Element {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default)]
pub struct StarterSource {
    pub chapters: Vec<Chapter>,
    /// Oldest first, to resolve equal relationship counts deterministically.
    pub elements: Vec<Element>,
    pub relation_counts: HashMap<String, usize>,
    /// Most recently opened first, as in the old companion.
    pub recent_chapter_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StarterPrompt {
    pub key: Key,
    pub values: Vec<(&'static str, String)>,
    pub mark: Option<StarterMark>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StarterMark {
    Chapter(String),
    Element(String),
}

pub fn build_starter_prompts(source: &StarterSource) -> Vec<StarterPrompt> {
    use keys::agent_panel::onboarding::prompts as k;
    let written: Vec<_> = source
        .chapters
        .iter()
        .filter(|chapter| chapter.word_count > 0 && !chapter.title.trim().is_empty())
        .collect();
    let chapter = source
        .recent_chapter_ids
        .iter()
        .find_map(|id| written.iter().copied().find(|chapter| &chapter.id == id))
        .or_else(|| {
            written
                .iter()
                .copied()
                .min_by_key(|chapter| chapter.book_order)
        });
    let Some(chapter) = chapter else {
        return [k::OUTLINE, k::INTERVIEW, k::CAST_CHARACTERS]
            .into_iter()
            .map(|key| StarterPrompt {
                key,
                values: Vec::new(),
                mark: None,
            })
            .collect();
    };
    let chapter_prompt = |key| StarterPrompt {
        key,
        values: vec![("chapter", chapter.title.clone())],
        mark: Some(StarterMark::Chapter(chapter.id.clone())),
    };
    let mut prompts = vec![
        chapter_prompt(k::COMMENT_CHAPTER),
        chapter_prompt(k::TIGHTEN_CHAPTER),
    ];
    let mut elements: Vec<_> = source
        .elements
        .iter()
        .filter(|element| !element.name.trim().is_empty())
        .collect();
    // Stable sorting retains the author's oldest-first order on ties.
    elements.sort_by_key(|element| {
        std::cmp::Reverse(
            source
                .relation_counts
                .get(&element.id)
                .copied()
                .unwrap_or(0),
        )
    });
    prompts.push(match elements.as_slice() {
        [first, second, ..] => StarterPrompt {
            key: k::RELATE_ELEMENTS,
            values: vec![
                ("first", first.name.clone()),
                ("second", second.name.clone()),
            ],
            mark: Some(StarterMark::Element(first.id.clone())),
        },
        [first] => StarterPrompt {
            key: k::COMPLETE_ELEMENT,
            values: vec![("element", first.name.clone())],
            mark: Some(StarterMark::Element(first.id.clone())),
        },
        [] => chapter_prompt(k::EXTRACT_ELEMENTS),
    });
    prompts
}
