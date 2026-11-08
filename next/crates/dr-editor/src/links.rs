//! Entity links (人物链接) as the editor shows them, and what the editor
//! adds to gpui-prose through its extension hooks.
//!
//! An `entity:<id>` mark gets a look from what it points at: an element,
//! chapter, storyline or category link in the link colour with a thin
//! underline; a link whose target is gone (deleted, or in the trash) muted,
//! with the underline only. Whether a target is alive comes from the
//! workspace's catalog (F3's `BookCatalog`, the same lookup position links
//! use), cached per target until the book changes.

use std::cell::RefCell;
use std::collections::HashMap;

use dr_model::kind::EntityKind;
use dr_workspace::{BookCatalog, LinkGroup};
use gpui_prose::render::RunStyle;
use gpui_prose::schema::inline;
use gpui_prose::style::ProseStyle;
use gpui_prose::text::Marks;
use gpui_prose::{InputRule, ProseExtension, Typed};
use loro::LoroValue;

use crate::rules::markdown_rule;

/// Whether entity link targets are alive.
pub trait LinkTargets {
    fn alive(&self, kind: &EntityKind, id: &str) -> bool;
}

impl LinkTargets for BookCatalog {
    fn alive(&self, kind: &EntityKind, id: &str) -> bool {
        let groups: &[LinkGroup] = match kind {
            EntityKind::Element => &[LinkGroup::Elements],
            // A node is a chapter or an idea (构想).
            EntityKind::Node => &[LinkGroup::Chapters, LinkGroup::Drifts],
            EntityKind::Storyline => &[LinkGroup::Storylines],
            EntityKind::Category => &[LinkGroup::Categories],
            _ => return true,
        };
        groups.iter().any(|g| self.by_id(*g, id).is_some())
    }
}

/// The kind an entity mark's value names (elements when unsaid).
pub fn link_kind(value: &LoroValue) -> EntityKind {
    match value {
        LoroValue::Map(map) => match map.get("kind") {
            Some(LoroValue::String(s)) => EntityKind::parse(s),
            _ => EntityKind::Element,
        },
        _ => EntityKind::Element,
    }
}

/// gpui-prose's extension for Drifting: entity link looks and Markdown
/// input rules.
pub struct DriftingExtension {
    targets: Option<Box<dyn LinkTargets>>,
    alive: RefCell<HashMap<String, bool>>,
    markdown: bool,
    /// A material note's rules too (`==highlight==`).
    note: std::cell::Cell<bool>,
    /// The paint layers draw the links' dry underline (crate::decor), so
    /// the run gets none of its own.
    dry_underline: std::cell::Cell<bool>,
    /// Whether each TODO of the book is done, for task items linked to one
    /// (the paint layers keep it, crate::decor).
    todos: RefCell<std::collections::HashMap<String, bool>>,
}

impl DriftingExtension {
    /// Rules of a material note too (`==highlight==`); set per document.
    pub fn set_note(&self, note: bool) {
        self.note.set(note);
    }

    /// `targets`: where to look link targets up (`None`: every link alive).
    pub fn new(targets: Option<Box<dyn LinkTargets>>) -> DriftingExtension {
        DriftingExtension {
            targets,
            alive: RefCell::default(),
            markdown: true,
            note: std::cell::Cell::new(false),
            dry_underline: std::cell::Cell::new(false),
            todos: RefCell::default(),
        }
    }

    /// Turns the Markdown input rules on or off.
    pub fn with_markdown(mut self, on: bool) -> DriftingExtension {
        self.markdown = on;
        self
    }

    /// Forgets cached link targets (the book changed).
    pub fn invalidate(&self) {
        self.alive.borrow_mut().clear();
    }

    /// Whether the paint layers draw the links' underline.
    pub fn set_dry_underline(&self, on: bool) {
        self.dry_underline.set(on);
    }

    /// The book's TODOs and whether each is done; whether anything changed.
    pub fn set_todos(&self, todos: std::collections::HashMap<String, bool>) -> bool {
        let mut held = self.todos.borrow_mut();
        let changed = *held != todos;
        *held = todos;
        changed
    }

    /// Whether a link's target still exists (cached until [`Self::invalidate`]).
    pub fn alive(&self, kind: &EntityKind, id: &str) -> bool {
        self.is_alive(kind, id)
    }

    fn is_alive(&self, kind: &EntityKind, id: &str) -> bool {
        let Some(targets) = &self.targets else {
            return true;
        };
        *self
            .alive
            .borrow_mut()
            .entry(id.to_owned())
            .or_insert_with(|| targets.alive(kind, id))
    }
}

impl ProseExtension for DriftingExtension {
    fn style_run(&self, marks: &Marks, run: &mut RunStyle, style: &ProseStyle) {
        let mut linked = None;
        for (key, value) in marks.iter() {
            if let Some(id) = inline::entity_target(key) {
                let alive = self.is_alive(&link_kind(value), id);
                linked = Some(linked.unwrap_or(false) || alive);
            }
        }
        match linked {
            Some(true) => {
                run.color = style.link;
                run.underline = Some(style.link.opacity(0.45));
            }
            Some(false) => {
                run.color = style.muted;
                run.underline = Some(style.muted.opacity(0.6));
            }
            None => {}
        }
        if linked.is_some() && self.dry_underline.get() {
            run.underline = None;
        }
    }

    fn task_done(&self, todo: &str) -> Option<bool> {
        self.todos.borrow().get(todo).copied()
    }

    fn input_rule(&self, typed: &Typed<'_>) -> Option<InputRule> {
        if !self.markdown {
            return None;
        }
        markdown_rule(typed).or_else(|| {
            self.note
                .get()
                .then(|| crate::rules::highlight_rule(typed))
                .flatten()
        })
    }
}
