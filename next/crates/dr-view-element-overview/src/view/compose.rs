//! Shift selects two graph entries; the existing centred panel names their relation.

use dr_i18n::keys::common;
use dr_i18n::keys::relation_graph as k;
use dr_model::{shared::normalize_relation_type_name, v3::RelationDirection};
use dr_shell::strings::t;
use dr_ui::{
    Theme,
    components::Button,
    input::field::{FieldEvent, TextField},
    tokens::radius,
};
use dr_workspace::{
    Actor,
    commands::v3::relations::{CreatePair, Definition, PairIn, RelationInfo},
};
use gpui::{prelude::*, *};

use super::ElementOverview;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairDirection {
    Forward,
    Reverse,
    Both,
}

impl PairDirection {
    pub fn glyph(self) -> &'static str {
        match self {
            Self::Forward => "→",
            Self::Reverse => "←",
            Self::Both => "↔",
        }
    }
}

#[derive(Clone, Debug)]
pub struct RelationDraft {
    pub source: String,
    pub target: String,
    pub name: String,
    pub direction: PairDirection,
    source_name: String,
    target_name: String,
}

impl RelationDraft {
    fn existing<'a>(&self, relations: &'a [RelationInfo]) -> Option<&'a RelationInfo> {
        let key = normalize_relation_type_name(&self.name);
        relations
            .iter()
            .find(|r| normalize_relation_type_name(&r.name) == key)
    }

    pub fn direction(&self, relations: &[RelationInfo]) -> PairDirection {
        match self.existing(relations).map(|r| r.direction) {
            Some(RelationDirection::Symmetric) => PairDirection::Both,
            Some(RelationDirection::Directed) if self.direction == PairDirection::Both => {
                PairDirection::Forward
            }
            _ => self.direction,
        }
    }

    fn input(&self, book: &str, relations: &[RelationInfo]) -> Option<PairIn> {
        let name = self.name.trim();
        if name.is_empty() || self.source == self.target {
            return None;
        }
        let direction = self.direction(relations);
        let (left, right) = if direction == PairDirection::Reverse {
            (&self.target, &self.source)
        } else {
            (&self.source, &self.target)
        };
        let existing = self.existing(relations);
        Some(PairIn {
            book: book.to_owned(),
            left: left.clone(),
            right: right.clone(),
            relation_type: existing.map(|r| r.id.clone()),
            new_type: existing.is_none().then(|| Definition {
                name: name.to_owned(),
                description: Default::default(),
                direction: if direction == PairDirection::Both {
                    RelationDirection::Symmetric
                } else {
                    RelationDirection::Directed
                },
            }),
        })
    }
}

impl ElementOverview {
    pub fn relation_draft(&self) -> Option<&RelationDraft> {
        self.relation_draft.as_ref()
    }

    pub fn relation_error(&self) -> bool {
        self.relation_error
    }

    pub fn cancel_relation(&mut self, cx: &mut Context<Self>) {
        self.relation_source = None;
        self.relation_draft = None;
        self.relation_name = None;
        self.relation_field_sub = None;
        self.relation_error = false;
        cx.notify();
    }

    pub(super) fn pick_relation_endpoint(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if crate::is_frozen(cx) || self.relation_draft.is_some() {
            return;
        }
        let Some(source) = self.relation_source.clone() else {
            self.relation_source = Some(id.to_owned());
            self.focus_element(Some(id.to_owned()), window, cx);
            window.focus(&self.relation_focus, cx);
            return;
        };
        if source == id {
            return;
        }
        let Some(book) = self.book.v3() else {
            return;
        };
        let Some(source_name) = book.entry(&source).map(|e| e.title.clone()) else {
            self.cancel_relation(cx);
            return;
        };
        let Some(target_name) = book.entry(id).map(|e| e.title.clone()) else {
            return;
        };
        self.relation_source = None;
        self.relation_draft = Some(RelationDraft {
            source_name,
            target_name,
            source,
            target: id.to_owned(),
            name: String::new(),
            direction: PairDirection::Forward,
        });
        self.relation_error = false;
        let placeholder = t(cx, k::NAME);
        let field =
            cx.new(|cx| TextField::new("se-relation-name", window, cx).placeholder(placeholder));
        self.relation_field_sub =
            Some(
                cx.subscribe_in(&field, window, |this, _, event, window, cx| match event {
                    FieldEvent::Changed(name) => {
                        if let Some(draft) = &mut this.relation_draft {
                            draft.name = name.to_string();
                            draft.direction = draft.direction(&this.relation_types);
                            this.relation_error = false;
                            cx.notify();
                        }
                    }
                    FieldEvent::Submitted(_) => {}
                    FieldEvent::Cancelled => {
                        this.cancel_relation(cx);
                        window.focus(&this.relation_focus, cx);
                    }
                    FieldEvent::Blurred => {}
                }),
            );
        window.focus(&field.focus_handle(cx), cx);
        self.relation_name = Some(field);
        cx.notify();
    }

    pub fn set_relation_name(&mut self, name: &str, cx: &mut Context<Self>) {
        if let Some(draft) = &mut self.relation_draft {
            draft.name = name.to_owned();
            draft.direction = draft.direction(&self.relation_types);
            self.relation_error = false;
            if let Some(field) = &self.relation_name {
                field.update(cx, |field, cx| field.set_text(name, cx));
            }
            cx.notify();
        }
    }

    pub fn cycle_relation_direction(&mut self, cx: &mut Context<Self>) {
        if let Some(draft) = &mut self.relation_draft {
            let existing = draft.existing(&self.relation_types);
            draft.direction = match (
                draft.direction(&self.relation_types),
                existing.map(|r| r.direction),
            ) {
                (_, Some(RelationDirection::Symmetric)) => PairDirection::Both,
                (PairDirection::Forward, _) => PairDirection::Reverse,
                (PairDirection::Reverse, Some(_)) => PairDirection::Forward,
                (PairDirection::Reverse, None) => PairDirection::Both,
                (PairDirection::Both, _) => PairDirection::Forward,
            };
            cx.notify();
        }
    }

    pub fn confirm_relation(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<String> {
        if crate::is_frozen(cx) {
            return None;
        }
        let lib = self.lib.as_ref()?;
        let input = self
            .relation_draft
            .as_ref()?
            .input(&self.book_id, &self.relation_types)?;
        match lib.run::<CreatePair>(&Actor::User, input) {
            Ok(placed) => {
                let row = placed.output.id;
                self.cancel_relation(cx);
                self.sync_workspace_book(cx);
                window.focus(&self.relation_focus, cx);
                Some(row)
            }
            Err(error) => {
                log::warn!("graph relation write failed: {error}");
                self.relation_error = true;
                cx.notify();
                None
            }
        }
    }

    pub(super) fn render_relation_composer(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let draft = self.relation_draft.as_ref()?;
        let field = self.relation_name.as_ref()?;
        let p = Theme::of(window, cx).palette;
        let entry_name = |id: &str, saved: &str| {
            self.book
                .v3()
                .and_then(|v| v.entry(id))
                .map(|e| e.title.clone())
                .unwrap_or_else(|| saved.to_owned())
        };
        let selected = draft.existing(&self.relation_types).map(|r| r.id.as_str());
        let locked = draft
            .existing(&self.relation_types)
            .is_some_and(|r| r.direction == RelationDirection::Symmetric);
        let choices: Vec<_> = self
            .relation_types
            .iter()
            .map(|r| {
                let name = r.name.clone();
                div()
                    .id(ElementId::Name(format!("se-relation-use-{}", r.id).into()))
                    .px(px(8.0))
                    .py(px(4.0))
                    .rounded(px(radius::SM))
                    .cursor_pointer()
                    .border_1()
                    .border_color(p.hairline())
                    .text_size(px(11.5))
                    .when(selected == Some(r.id.as_str()), |el| {
                        el.bg(p.ink(4).alpha(0.14))
                    })
                    .on_click(cx.listener(move |this, _, _, cx| this.set_relation_name(&name, cx)))
                    .child(SharedString::from(r.name.clone()))
                    .into_any_element()
            })
            .collect();
        Some(
            div()
                .id("se-pending-link-modal")
                .debug_selector(|| "se-pending-link-modal".into())
                .absolute()
                .inset_0()
                .bg(p.ink(1).alpha(0.18))
                .flex()
                .items_center()
                .justify_center()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_scroll(|_, _, cx| cx.stop_propagation())
                .child(
                    div()
                        .w(px(348.0))
                        .p(px(16.0))
                        .rounded(px(radius::MD))
                        .bg(p.paper.solid())
                        .border_1()
                        .border_color(p.hairline())
                        .flex()
                        .flex_col()
                        .gap(px(12.0))
                        .child(
                            div()
                                .text_size(px(13.0))
                                .text_color(p.ink(1).solid())
                                .child(t(cx, k::TITLE)),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(div().flex_1().min_w_0().child(SharedString::from(
                                    entry_name(&draft.source, &draft.source_name),
                                )))
                                .child(
                                    Button::new(
                                        "se-relation-direction",
                                        draft.direction(&self.relation_types).glyph(),
                                    )
                                    .text()
                                    .small()
                                    .disabled(locked)
                                    .on_click(cx.listener(
                                        |this, _, _, cx| this.cycle_relation_direction(cx),
                                    )),
                                )
                                .child(div().flex_1().min_w_0().child(SharedString::from(
                                    entry_name(&draft.target, &draft.target_name),
                                ))),
                        )
                        .child(
                            div()
                                .id("se-relation-used-names")
                                .max_h(px(144.0))
                                .overflow_y_scroll()
                                .flex()
                                .flex_wrap()
                                .gap(px(6.0))
                                .children(choices),
                        )
                        .child(field.clone())
                        .when(self.relation_error, |el| {
                            el.child(
                                div()
                                    .text_size(px(12.0))
                                    .text_color(p.ink(2).solid())
                                    .child(t(cx, common::SAVE_FAILED)),
                            )
                        })
                        .child(
                            div()
                                .flex()
                                .justify_end()
                                .gap(px(8.0))
                                .child(
                                    Button::new("se-relation-cancel", t(cx, common::CANCEL))
                                        .text()
                                        .small()
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.cancel_relation(cx);
                                            window.focus(&this.relation_focus, cx);
                                        })),
                                )
                                .child(
                                    Button::new("se-relation-create", t(cx, k::CREATE))
                                        .small()
                                        .disabled(
                                            draft
                                                .input(&self.book_id, &self.relation_types)
                                                .is_none(),
                                        )
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.confirm_relation(window, cx);
                                        })),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }
}
