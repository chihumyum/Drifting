use super::*;

impl TemplateEditor {
    pub(super) fn guidance(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut section = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .mt(px(12.))
            .child(t(cx, k::FOR_AGENT));
        for (binding, key, multiline) in [
            (Binding::AgentName, k::NAME, false),
            (Binding::AgentDescription, k::DESCRIPTION, false),
            (Binding::AgentInstructions, k::INSTRUCTIONS, true),
        ] {
            let field = self.field(binding, t(cx, key), multiline, window, cx);
            section = section.child(
                div()
                    .flex()
                    .gap(px(16.))
                    .items_start()
                    .child(div().w(px(120.)).child(t(cx, key)))
                    .child(field),
            );
        }
        for module in self.draft.modules.clone() {
            let field = self.field(
                Binding::ModuleInstructions(module.id),
                format!("{} · {}", t(cx, k::MODULE_INSTRUCTIONS), module.name).into(),
                false,
                window,
                cx,
            );
            section = section.child(
                div()
                    .flex()
                    .gap(px(16.))
                    .items_start()
                    .child(div().w(px(120.)).child(module.name))
                    .child(field),
            );
        }
        section = section.child(
            Button::new("k5-agent-preview", t(cx, k::AGENT_PREVIEW))
                .text()
                .small()
                .icon(if self.preview_open {
                    Icon::ChevronDown
                } else {
                    Icon::ChevronRight
                })
                .on_click(cx.listener(|this, _, _, cx| {
                    this.preview_open = !this.preview_open;
                    cx.notify();
                })),
        );
        if self.preview_open {
            let preview = self.preview(cx);
            section = section.child(
                div()
                    .id("k5-preview")
                    .role(gpui::Role::Group)
                    .aria_label(t(cx, k::AGENT_PREVIEW))
                    .p(px(16.))
                    .font_role(Role::Index)
                    .type_px(13., 21.)
                    .child(
                        div()
                            .id("k5-preview-text")
                            .role(gpui::Role::Label)
                            .aria_label(preview.clone())
                            .child(dr_ui::text::wrapped(preview)),
                    ),
            );
        }
        section.into_any_element()
    }

    pub(super) fn preview(&self, cx: &App) -> String {
        let template = &self.draft;
        let agent = template.agent.as_ref();
        let name = agent
            .map(|a| a.name.as_str())
            .filter(|n| !n.trim().is_empty())
            .unwrap_or(&template.name);
        let description = agent.map(|a| a.description.as_str()).unwrap_or_default();
        let mut out = format!(
            "---\nname: {}\ndescription: {}\n---\n",
            serde_json::json!(name),
            serde_json::json!(description)
        );
        if let Some(agent) = agent
            && !agent.instructions.is_empty()
        {
            out.push_str(&format!("\n{}\n", agent.instructions));
        }
        if !template.modules.is_empty() {
            out.push_str(&format!("\n{}:\n", t(cx, k::MODULES)));
            for module in &template.modules {
                let kind = if module.kind == "fields" && module.config.defs.len() == 1 {
                    &module.config.defs[0].field_type
                } else {
                    &module.kind
                };
                out.push_str(&format!("- {} ({})", module.name, type_label(kind, cx)));
                if let Some(agent) = &module.agent {
                    if !agent.writable {
                        out.push_str(&format!(" [{}]", t(cx, k::READ_ONLY)));
                    }
                    if !agent.instructions.is_empty() {
                        out.push_str(&format!(": {}", agent.instructions));
                    }
                }
                out.push('\n');
            }
        }
        let template_name = |id: &str| {
            self.host
                .book
                .v3()
                .and_then(|b| b.template(id))
                .map(|t| t.name.clone())
                .unwrap_or_else(|| id.into())
        };
        if template.kind == "level" {
            let settings = &template.settings;
            out.push_str(&format!("\n{}:\n", t(cx, k::THIS_LEVEL)));
            let mut line =
                |key, value: String| out.push_str(&format!("- {}: {value}\n", t(cx, key)));
            if let Some(value) = &settings.default_template {
                line(
                    k::DEFAULT_TEMPLATE,
                    value
                        .as_deref()
                        .map(template_name)
                        .unwrap_or_else(|| t(cx, k::NONE).to_string()),
                );
            }
            if let Some(allow) = &settings.allow {
                line(
                    k::ALLOW,
                    if allow.is_empty() {
                        t(cx, k::ALL_TEMPLATES).to_string()
                    } else {
                        allow
                            .iter()
                            .map(|id| template_name(id))
                            .collect::<Vec<_>>()
                            .join(", ")
                    },
                );
            }
            if let Some(display) = &settings.display {
                line(
                    k::DISPLAY,
                    super::levels::display_label(display, cx).to_string(),
                );
            }
            for (key, value) in [
                (k::AUTO_LINK, settings.auto_link),
                (k::ACCEPT, template.lane.then_some(true).or(settings.accept)),
                (k::MANUSCRIPT, settings.is_manuscript),
            ] {
                if let Some(value) = value {
                    line(key, t(cx, if value { k::YES } else { k::NO }).to_string());
                }
            }
            if template.lane {
                line(k::LANE, t(cx, k::YES).to_string());
            }
            if let Some(home) = &settings.home {
                line(
                    k::HOME,
                    home.as_deref()
                        .and_then(|id| self.host.book.v3()?.entry(id))
                        .map(|entry| entry.title.clone())
                        .unwrap_or_else(|| t(cx, k::THIS_LEVEL).to_string()),
                );
            }
            if let Some(format) = &settings.format_shortcuts {
                line(
                    k::FORMAT_SHORTCUTS,
                    super::levels::format_label(format, cx).to_string(),
                );
            }
            if !template.verbs.is_empty() {
                out.push_str(&format!("\n{}:\n", t(cx, k::ACTIONS)));
                for verb in &template.verbs {
                    out.push_str(&format!(
                        "- {}: {}",
                        verb.name,
                        verb.target_template
                            .as_deref()
                            .map(template_name)
                            .unwrap_or_else(|| t(cx, k::CHOOSE_TEMPLATE).to_string())
                    ));
                    if !verb.description.is_empty() {
                        out.push_str(&format!(" — {}", verb.description));
                    }
                    out.push('\n');
                }
            }
        }
        out
    }
}
