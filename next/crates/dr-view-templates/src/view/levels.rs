use super::*;
use dr_ui::components::{Chip, Switch};

pub(super) fn display_label(value: &str, cx: &App) -> SharedString {
    t(
        cx,
        match value {
            "grid" => k::GRID,
            "board" => k::BOARD,
            "island" => k::ISLAND,
            _ => k::LIST,
        },
    )
}
pub(super) fn format_label(value: &str, cx: &App) -> SharedString {
    t(
        cx,
        match value {
            "notes" => k::FORMAT_NOTES,
            "plain" => k::FORMAT_PLAIN,
            _ => k::FORMAT_FULL,
        },
    )
}

impl TemplateEditor {
    fn reset_setting(&mut self, key: &str) {
        let settings = &mut self.draft.settings;
        match key {
            "default_template" => settings.default_template = None,
            "allow" => settings.allow = None,
            "display" => settings.display = None,
            "auto_link" => settings.auto_link = None,
            "accept" => settings.accept = None,
            "home" => settings.home = None,
            "is_manuscript" => settings.is_manuscript = None,
            "format_shortcuts" => settings.format_shortcuts = None,
            _ => {}
        }
    }
    fn setting_row(
        &self,
        key: &'static str,
        label: dr_i18n::Key,
        value: AnyElement,
        own: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let name = div()
            .w(px(170.))
            .flex_none()
            .child(dr_ui::text::wrapped(t(cx, label)));
        let mut restore = div().w(px(60.)).flex_none();
        if own {
            restore = restore.child(
                Button::new(
                    SharedString::from(format!("k5-restore-{key}")),
                    t(cx, k::RESTORE),
                )
                .small()
                .text()
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.reset_setting(key);
                    cx.notify();
                })),
            );
        }
        div()
            .id(SharedString::from(format!("k5-setting-{key}")))
            .role(gpui::Role::Group)
            .aria_label(t(cx, label))
            .flex()
            .items_center()
            .gap(px(16.))
            .child(name)
            .child(div().flex_1().min_w_0().child(value))
            .child(restore)
            .into_any_element()
    }
    fn bool_setting(
        &self,
        key: &'static str,
        label: dr_i18n::Key,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let settings = &self.draft.settings;
        let own = match key {
            "auto_link" => settings.auto_link,
            "accept" => settings.accept,
            _ => settings.is_manuscript,
        };
        let forced = key == "accept" && self.draft.lane;
        let entity = cx.entity();
        let control = div()
            .flex()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .id(SharedString::from(format!("k5-toggle-{key}")))
                    .role(gpui::Role::CheckBox)
                    .aria_label(t(cx, label))
                    .aria_toggled(if forced || own.unwrap_or(false) {
                        gpui::Toggled::True
                    } else {
                        gpui::Toggled::False
                    })
                    .child(
                        Switch::new(
                            SharedString::from(format!("k5-switch-{key}")),
                            forced || own.unwrap_or(false),
                        )
                        .disabled(forced)
                        .on_change(move |value, _, cx| {
                            entity.update(cx, |this, cx| {
                                match key {
                                    "auto_link" => this.draft.settings.auto_link = Some(value),
                                    "accept" => this.draft.settings.accept = Some(value),
                                    _ => this.draft.settings.is_manuscript = Some(value),
                                };
                                cx.notify();
                            })
                        }),
                    ),
            )
            .children((own.is_none() && !forced).then(|| t(cx, k::INHERIT)));
        self.setting_row(key, label, control.into_any_element(), own.is_some(), cx)
    }
    fn template_options(&self) -> Vec<(String, String)> {
        let mut options: Vec<_> = self
            .host
            .book
            .v3()
            .into_iter()
            .flat_map(|book| &book.templates)
            .filter(|template| template.deleted_at.is_none() && template.id != self.draft.id)
            .map(|template| (template.id.clone(), template.name.clone()))
            .collect();
        options.push((self.draft.id.clone(), self.draft.name.clone()));
        options
    }
    pub(super) fn level_settings(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let mut section = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .mt(px(12.))
            .child(t(cx, k::THIS_LEVEL));
        let options = self.template_options();
        let mut choices = vec![
            Choice::new(Icon::ChevronDown, t(cx, k::INHERIT)),
            Choice::new(Icon::ChevronDown, t(cx, k::NONE)),
        ];
        choices.extend(
            options
                .iter()
                .map(|(_, name)| Choice::new(Icon::ChevronDown, name.clone())),
        );
        let selected = match &self.draft.settings.default_template {
            None => 0,
            Some(None) => 1,
            Some(Some(id)) => options
                .iter()
                .position(|(tid, _)| tid == id)
                .map_or(1, |ix| ix + 2),
        };
        let entity = cx.entity();
        let ids: Vec<_> = options.iter().map(|(id, _)| id.clone()).collect();
        let select =
            Select::new("k5-default-template", choices, selected).on_change(move |ix, _, cx| {
                entity.update(cx, |this, cx| {
                    this.draft.settings.default_template = match ix {
                        0 => None,
                        1 => Some(None),
                        _ => Some(Some(ids[ix - 2].clone())),
                    };
                    cx.notify();
                })
            });
        section = section.child(self.setting_row(
            "default_template",
            k::DEFAULT_TEMPLATE,
            select.into_any_element(),
            self.draft.settings.default_template.is_some(),
            cx,
        ));
        let mut allow = div().flex().flex_wrap().gap(px(6.)).child(
            Button::new("k5-allow-all", t(cx, k::ALL_TEMPLATES))
                .small()
                .text()
                .on_click(cx.listener(|this, _, _, cx| {
                    this.draft.settings.allow = Some(Vec::new());
                    cx.notify();
                })),
        );
        for (id, name) in &options {
            let id = id.clone();
            let selected = self
                .draft
                .settings
                .allow
                .as_ref()
                .is_some_and(|allow| allow.contains(&id));
            let entity = cx.entity();
            allow = allow.child(
                div()
                    .id(SharedString::from(format!("k5-allow-toggle-{id}")))
                    .role(gpui::Role::CheckBox)
                    .aria_label(name.clone())
                    .aria_toggled(if selected {
                        gpui::Toggled::True
                    } else {
                        gpui::Toggled::False
                    })
                    .child(
                        Chip::new(
                            SharedString::from(format!("k5-allow-{id}")),
                            name.clone(),
                            selected,
                        )
                        .on_change(move |value, _, cx| {
                            entity.update(cx, |this, cx| {
                                let allow = this.draft.settings.allow.get_or_insert_with(Vec::new);
                                allow.retain(|tid| tid != &id);
                                if value {
                                    allow.push(id.clone());
                                }
                                cx.notify();
                            })
                        }),
                    ),
            );
        }
        if self.draft.settings.allow.is_none() {
            allow = allow.child(t(cx, k::INHERIT));
        }
        section = section.child(self.setting_row(
            "allow",
            k::ALLOW,
            allow.into_any_element(),
            self.draft.settings.allow.is_some(),
            cx,
        ));
        let displays = ["list", "grid", "board", "island"];
        let mut choices = vec![Choice::new(Icon::ChevronDown, t(cx, k::INHERIT))];
        choices.extend(
            displays
                .iter()
                .map(|value| Choice::new(Icon::ChevronDown, display_label(value, cx))),
        );
        let selected = self
            .draft
            .settings
            .display
            .as_deref()
            .and_then(|value| displays.iter().position(|d| *d == value))
            .map_or(0, |ix| ix + 1);
        let entity = cx.entity();
        let select = Select::new("k5-display", choices, selected).on_change(move |ix, _, cx| {
            entity.update(cx, |this, cx| {
                this.draft.settings.display = ix.checked_sub(1).map(|ix| displays[ix].into());
                cx.notify();
            })
        });
        section = section.child(self.setting_row(
            "display",
            k::DISPLAY,
            select.into_any_element(),
            self.draft.settings.display.is_some(),
            cx,
        ));
        section = section
            .child(self.bool_setting("auto_link", k::AUTO_LINK, cx))
            .child(self.bool_setting("accept", k::ACCEPT, cx));
        let mut homes: Vec<(Option<String>, SharedString)> = vec![(None, t(cx, k::THIS_LEVEL))];
        if let Some(book) = self.host.book.v3() {
            homes.extend(
                book.entries
                    .iter()
                    .filter(|entry| book.levels.contains_key(&entry.id))
                    .map(|entry| (Some(entry.id.clone()), entry.title.clone().into())),
            );
        }
        let mut choices = vec![Choice::new(Icon::ChevronDown, t(cx, k::INHERIT))];
        choices.extend(
            homes
                .iter()
                .map(|(_, label)| Choice::new(Icon::ChevronDown, label.clone())),
        );
        let selected = self
            .draft
            .settings
            .home
            .as_ref()
            .and_then(|value| homes.iter().position(|(id, _)| id == value))
            .map_or(0, |ix| ix + 1);
        let entity = cx.entity();
        let select = Select::new("k5-home", choices, selected).on_change(move |ix, _, cx| {
            entity.update(cx, |this, cx| {
                this.draft.settings.home = ix.checked_sub(1).map(|ix| homes[ix].0.clone());
                cx.notify();
            })
        });
        section = section.child(self.setting_row(
            "home",
            k::HOME,
            select.into_any_element(),
            self.draft.settings.home.is_some(),
            cx,
        ));
        section = section.child(self.bool_setting("is_manuscript", k::MANUSCRIPT, cx));
        let formats = ["full", "notes", "plain"];
        let mut choices = vec![Choice::new(Icon::ChevronDown, t(cx, k::INHERIT))];
        choices.extend(
            formats
                .iter()
                .map(|value| Choice::new(Icon::ChevronDown, format_label(value, cx))),
        );
        let selected = self
            .draft
            .settings
            .format_shortcuts
            .as_deref()
            .and_then(|value| formats.iter().position(|f| *f == value))
            .map_or(0, |ix| ix + 1);
        let entity = cx.entity();
        let select = Select::new("k5-format", choices, selected).on_change(move |ix, _, cx| {
            entity.update(cx, |this, cx| {
                this.draft.settings.format_shortcuts =
                    ix.checked_sub(1).map(|ix| formats[ix].into());
                cx.notify();
            })
        });
        section = section.child(self.setting_row(
            "format_shortcuts",
            k::FORMAT_SHORTCUTS,
            select.into_any_element(),
            self.draft.settings.format_shortcuts.is_some(),
            cx,
        ));
        let entity = cx.entity();
        section = section.child(
            div()
                .id("k5-lane")
                .role(gpui::Role::Group)
                .aria_label(t(cx, k::LANE))
                .flex()
                .items_center()
                .gap(px(16.))
                .child(div().w(px(170.)).child(t(cx, k::LANE)))
                .child(
                    div()
                        .id("k5-lane-toggle")
                        .role(gpui::Role::CheckBox)
                        .aria_label(t(cx, k::LANE))
                        .aria_toggled(if self.draft.lane {
                            gpui::Toggled::True
                        } else {
                            gpui::Toggled::False
                        })
                        .child(Switch::new("k5-lane-switch", self.draft.lane).on_change(
                            move |value, _, cx| {
                                entity.update(cx, |this, cx| {
                                    this.draft.lane = value;
                                    cx.notify();
                                })
                            },
                        )),
                ),
        );
        section.into_any_element()
    }
    pub(super) fn actions(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut section = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .mt(px(12.))
            .child(t(cx, k::ACTIONS));
        let options = self.template_options();
        for verb in self.draft.verbs.clone() {
            let id = verb.id.clone();
            let name = self.field(
                Binding::ActionName(id.clone()),
                t(cx, k::ACTION_NAME),
                false,
                window,
                cx,
            );
            let allowed = self
                .draft
                .settings
                .allow
                .as_ref()
                .filter(|allow| !allow.is_empty());
            let targets: Vec<_> = options
                .iter()
                .filter(|(id, _)| allowed.is_none_or(|allow| allow.contains(id)))
                .cloned()
                .collect();
            let mut choices = vec![Choice::new(Icon::ChevronDown, t(cx, k::CHOOSE_TEMPLATE))];
            choices.extend(
                targets
                    .iter()
                    .map(|(_, name)| Choice::new(Icon::ChevronDown, name.clone())),
            );
            let selected = verb
                .target_template
                .as_ref()
                .and_then(|tid| targets.iter().position(|(id, _)| id == tid))
                .map_or(0, |ix| ix + 1);
            let entity = cx.entity();
            let change = id.clone();
            let remove = id.clone();
            let select = Select::new(
                SharedString::from(format!("k5-action-target-{id}")),
                choices,
                selected,
            )
            .on_change(move |ix, _, cx| {
                entity.update(cx, |this, cx| {
                    if let Some(verb) = this.draft.verbs.iter_mut().find(|verb| verb.id == change) {
                        verb.target_template = ix.checked_sub(1).map(|ix| targets[ix].0.clone());
                    }
                    cx.notify();
                })
            });
            section = section.child(
                div()
                    .id(SharedString::from(format!("k5-action-{id}")))
                    .role(gpui::Role::Group)
                    .aria_label(verb.name)
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(name)
                    .child(select)
                    .child(
                        Button::new(
                            SharedString::from(format!("k5-remove-action-{id}")),
                            t(cx, common::DELETE),
                        )
                        .small()
                        .text()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.draft.verbs.retain(|verb| verb.id != remove);
                            cx.notify();
                        })),
                    ),
            );
        }
        section
            .child(
                Button::new("k5-add-action", t(cx, k::ADD_ACTION))
                    .small()
                    .text()
                    .icon(Icon::Plus)
                    .on_click(cx.listener(|this, _, _, cx| {
                        let pos = this
                            .draft
                            .verbs
                            .last()
                            .and_then(|verb| verb.pos.as_deref())
                            .and_then(|p| dr_model::pos::PosKey::parse(p).ok())
                            .map_or_else(dr_model::pos::PosKey::first, |p| p.after());
                        this.draft.verbs.push(TemplateVerb {
                            id: dr_model::id::new_uuid_v7(),
                            name: t(cx, k::NEW_ENTRY).to_string(),
                            description: String::new(),
                            target_template: None,
                            pos: Some(pos.to_string()),
                        });
                        cx.notify();
                    })),
            )
            .into_any_element()
    }
}
