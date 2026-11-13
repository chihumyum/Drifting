//! Canonical v3 level surface.
pub mod v3 {
    use dr_i18n::keys;
    use dr_shell::{
        book::{Book, v3::SettingSource},
        strings::{t, tf},
        v3::{LevelHost, Rendered},
    };
    use dr_ui::{Theme, components::Button, fonts::Role, style::DrStyled};
    use dr_workspace::commands::v3::types::LevelSettingsOverride;
    use gpui::{prelude::*, *};

    pub struct SettingsView {
        pub host: LevelHost,
    }
    pub fn register(cx: &mut App) {
        dr_shell::v3::add_level_settings(cx, make);
    }
    pub fn make(host: LevelHost, _: &mut Window, cx: &mut App) -> Rendered {
        let view = cx.new(|_| SettingsView { host });
        let weak = view.downgrade();
        Rendered::new(view).on_refresh(move |book, cx| {
            let _ = weak.update(cx, |this, cx| {
                this.host.page.book = book;
                cx.notify();
            });
        })
    }
    pub fn label(key: &str, cx: &App) -> SharedString {
        t(
            cx,
            match key {
                "default_template" => keys::v3_levels::DEFAULT_TEMPLATE,
                "display" => keys::v3_levels::DISPLAY,
                "auto_link" => keys::v3_levels::AUTO_LINK,
                "accept" => keys::v3_levels::ACCEPT,
                "home" => keys::v3_levels::HOME,
                "is_manuscript" => keys::v3_levels::IS_MANUSCRIPT,
                "lane" => keys::v3_levels::LANE,
                _ => keys::v3_levels::FORMAT_SHORTCUTS,
            },
        )
    }
    pub fn overridden(s: Option<&LevelSettingsOverride>, key: &str) -> bool {
        s.is_some_and(|s| match key {
            "default_template" => s.default_template.is_some(),
            "display" => s.display.is_some(),
            "auto_link" => s.auto_link.is_some(),
            "accept" => s.accept.is_some(),
            "home" => s.home.is_some(),
            "is_manuscript" => s.is_manuscript.is_some(),
            "lane" => s.lane.is_some(),
            "format_shortcuts" => s.format_shortcuts.is_some(),
            _ => false,
        })
    }
    pub fn source(book: &Book, source: &SettingSource, cx: &App) -> SharedString {
        let Some(v) = book.v3() else { return "".into() };
        match source {
            SettingSource::Default => t(cx, keys::v3_levels::SOURCE_DEFAULT),
            SettingSource::Override { entry } => {
                let name = v
                    .entry(entry)
                    .map(|e| e.title.clone())
                    .unwrap_or_else(|| entry.clone());
                tf(cx, keys::v3_levels::SOURCE_OVERRIDE, &[("name", &name)])
            }
            SettingSource::Template { entry, template } => {
                let name = v
                    .template(template)
                    .map(|t| t.name.clone())
                    .unwrap_or_else(|| template.clone());
                let level = v
                    .entry(entry)
                    .map(|e| e.title.clone())
                    .unwrap_or_else(|| entry.clone());
                tf(
                    cx,
                    keys::v3_levels::SOURCE_TEMPLATE,
                    &[("name", &name), ("level", &level)],
                )
            }
            SettingSource::Lane { entry, .. } => {
                let name = v
                    .entry(entry)
                    .map(|e| e.title.clone())
                    .unwrap_or_else(|| entry.clone());
                tf(cx, keys::v3_levels::SOURCE_LANE, &[("name", &name)])
            }
        }
    }
    pub fn value(book: &Book, level: &str, key: &str, cx: &App) -> SharedString {
        let Some(v) = book.v3() else { return "".into() };
        let Some(l) = v.levels.get(level) else {
            return "".into();
        };
        let s = &l.settings;
        let template = |id: Option<&str>| {
            id.map(|id| {
                v.template(id)
                    .map(|t| t.name.clone())
                    .unwrap_or_else(|| id.to_owned())
                    .into()
            })
            .unwrap_or_else(|| t(cx, keys::v3_levels::NONE))
        };
        let on = |b| {
            t(
                cx,
                if b {
                    keys::v3_levels::ON
                } else {
                    keys::v3_levels::OFF
                },
            )
        };
        match key {
            "default_template" => template(s.default_template.as_deref()),
            "display" => dr_shell::v3::page::display_name(&s.display, cx),
            "auto_link" => on(s.auto_link),
            "accept" => on(s.accept),
            "is_manuscript" => on(s.is_manuscript),
            "lane" => on(s.lane),
            "home" => s
                .home
                .as_deref()
                .map(|id| {
                    v.entry(id)
                        .map(|e| e.title.clone())
                        .unwrap_or_else(|| id.to_owned())
                        .into()
                })
                .unwrap_or_else(|| t(cx, keys::v3_levels::THIS_LEVEL)),
            _ => match s.format_shortcuts.as_str() {
                "full" => t(cx, keys::v3_levels::FORMAT_FULL),
                "notes" => t(cx, keys::v3_levels::FORMAT_NOTES),
                "plain" => t(cx, keys::v3_levels::FORMAT_PLAIN),
                other => other.to_owned().into(),
            },
        }
    }

    impl Render for SettingsView {
        fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let theme = Theme::of(window, cx);
            let book = self.host.page.book.clone();
            let Some(v) = book.v3() else {
                return div().into_any_element();
            };
            let Some(level) = v.levels.get(&self.host.level) else {
                return div().into_any_element();
            };
            let mut settings = div().flex().flex_col().gap_3();
            for key in [
                "default_template",
                "display",
                "auto_link",
                "accept",
                "home",
                "is_manuscript",
                "lane",
                "format_shortcuts",
            ] {
                let label = label(key, cx);
                let host = self.host.page.clone();
                let id = self.host.level.clone();
                let lane = key == "accept" && v.is_lane(&self.host.level);
                let mut row = div()
                    .id(SharedString::from(format!("g2-setting-row-{key}")))
                    .role(gpui::Role::Group)
                    .aria_label(label.clone())
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(div().flex_1().min_w_0().child(label.clone()))
                    .child(
                        Button::new(
                            SharedString::from(format!("g2-setting-{key}")),
                            value(&book, &self.host.level, key, cx),
                        )
                        .disabled(lane || key == "home" && !level.settings.accept)
                        .on_click(move |_, window, cx| {
                            crate::dialogs::v3::open_setting(
                                host.clone(),
                                id.clone(),
                                key,
                                window,
                                cx,
                            )
                        }),
                    );
                if overridden(
                    v.entry(&self.host.level).and_then(|e| e.overrides.as_ref()),
                    key,
                ) {
                    let host = self.host.page.clone();
                    let id = self.host.level.clone();
                    row = row.child(
                        Button::new(
                            SharedString::from(format!("g2-restore-{key}")),
                            tf(cx, keys::v3_levels::RESTORE, &[("name", &label)]),
                        )
                        .text()
                        .on_click(move |_, window, cx| {
                            crate::dialogs::v3::restore(host.clone(), id.clone(), key, window, cx)
                        }),
                    );
                }
                settings = settings.child(div().flex().flex_col().gap_1().child(row).children(
                    level.sources.get(key).map(|s| {
                        let provenance = source(&book, s, cx);
                        div()
                            .id(SharedString::from(format!("g2-setting-source-{key}")))
                            .role(gpui::Role::Note)
                            .aria_label(provenance.clone())
                            .font_role(Role::Index)
                            .text_color(theme.palette.muted().solid())
                            .child(provenance)
                    }),
                ));
            }

            settings.id("g2-level-settings").into_any_element()
        }
    }
}
