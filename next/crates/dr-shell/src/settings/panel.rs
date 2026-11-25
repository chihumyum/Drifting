//! The settings panel, generated from the registry.
//!
//! It covers the window with a rail of groups and sections
//! on the left (the search field on top), every section in one scroll on
//! the right. Clicking a section jumps there at once; scrolling moves the
//! rail's current item (workspace.md, 「桌面完整 Settings」). Each row is the
//! control its kind calls for (f5-ui.md, 「给设置注册表用的控件约定」).
//!
//! Search matches section names, group headings, each setting's name,
//! description, options and extra search terms in the interface language,
//! ignoring case and runs of white space; the rows that are not stored
//! settings (links, the diagnostics summary, the version) by their names
//! and descriptions. Nothing matching shows nothing (as in the 0.1 client).
//!
//! M08's first batch: 外观, 编辑器 (with a preview set in the editor's
//! settings and 还原推荐样式), 语言, 快捷键 (the shortcut registry; a
//! shortcut is rebound by clicking it and pressing the new keys, Esc
//! cancels), 本地数据 (this build keeps everything on this machine; the
//! crash-report switch and a de-identified diagnostics summary to copy) and
//! 关于 Drifting (version, credits and licences, contact).

use dr_i18n::{Key, keys, normalize};
use dr_ui::{
    Theme,
    components::{
        Button, Choice, ColorSwatch, NumberField, PanelIconButton, Range, Segmented, Select,
        Switch, color, menu::section_label,
    },
    fonts::Role,
    glass::{self, Ground, Kind as GlassKind, Mode, Spec, Tone},
    input::{FieldEvent, TextField},
    sand::{self, Icon},
    style::DrStyled,
    tokens::{menu as m, radius},
};
use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, EventEmitter, FocusHandle,
    Focusable, InteractiveElement, IntoElement, Keystroke, ParentElement, PathPromptOptions,
    Render, ScrollHandle, SharedString, StatefulInteractiveElement, Styled, Subscription, Window,
    div, prelude::FluentBuilder as _, px,
};
use serde_json::Value;

use super::Settings;
use super::fonts;
use super::registry::{self, InfoRow, Kind, RowAction, Section, SettingDef};
use crate::keymap::{self, Shortcut};
use crate::strings::{t, tf};
use crate::workspace::{LEADING_INSET, TITLEBAR_HEIGHT};
use crate::{ShellInfo, Strings};

pub enum PanelEvent {
    Close,
}

pub struct SettingsPanel {
    focus: FocusHandle,
    search: Entity<TextField>,
    font_family_input: Entity<TextField>,
    system_fonts: Option<Vec<String>>,
    font_status: Option<(bool, SharedString)>,
    replayed_guides: bool,
    query: String,
    scroll: ScrollHandle,
    /// The shortcut being recorded, and the keystroke interceptor doing it.
    recording: Option<&'static str>,
    interceptor: Option<Subscription>,
    /// A refused rebinding: the shortcut and why.
    conflict: Option<(&'static str, SharedString)>,
    /// The diagnostics summary was copied (or could not be).
    copied: Option<bool>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<PanelEvent> for SettingsPanel {}

impl Focusable for SettingsPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// The sections a query leaves, and in each the settings it matches
/// (`None` for a section matched by its own name: all of it).
pub fn search(query: &str, strings: &dr_i18n::I18n) -> Vec<(Section, Option<Vec<&'static str>>)> {
    let q = normalize(query);
    let hit = |key: Key| strings.contains(key, &q);
    Section::ALL
        .into_iter()
        .filter_map(|section| {
            if q.is_empty() || hit(section.label()) || hit(section.group()) {
                return Some((section, None));
            }
            let mut found: Vec<&'static str> = registry::in_section(section)
                .filter(|def| matches(def, &q, strings))
                .map(|def| def.key)
                .collect();
            if section == Section::Keys {
                found.extend(
                    keymap::listed_shortcuts()
                        .filter(|s| s.listed.is_some_and(|(l, d)| hit(l) || hit(d)))
                        .map(|s| s.id),
                );
            }
            found.extend(
                registry::info_in(section)
                    .filter(|r| {
                        hit(r.label)
                            || r.description.is_some_and(hit)
                            || r.group.is_some_and(hit)
                            || normalize(r.id).contains(&q)
                    })
                    .map(|r| r.id),
            );
            (!found.is_empty()).then_some((section, Some(found)))
        })
        .collect()
}

fn matches(def: &SettingDef, q: &str, strings: &dr_i18n::I18n) -> bool {
    let hit = |key: Key| strings.contains(key, q);
    hit(def.label)
        || def.description.is_some_and(hit)
        || def.group.is_some_and(hit)
        || def.search.iter().any(|term| normalize(term).contains(q))
        || match def.kind {
            Kind::Choice(options) => options.iter().any(|o| hit(o.label)),
            Kind::Locale => dr_i18n::Locale::ALL
                .iter()
                .any(|l| normalize(l.native_name()).contains(q)),
            _ => false,
        }
}

impl SettingsPanel {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let placeholder = t(cx, keys::settings::SEARCH_PLACEHOLDER);
        let search = cx.new(|cx| {
            TextField::new("settings-search", window, cx)
                .placeholder(placeholder)
                .icon(Icon::Search)
        });
        let font_placeholder = t(cx, keys::settings::editor::FONT_SYSTEM_MANUAL_PLACEHOLDER);
        let initial_font = Settings::read(cx)
            .str(registry::FONT_FAMILY)
            .unwrap_or_default();
        let font_family_input = cx.new(|cx| {
            TextField::new("settings-font-family-manual", window, cx)
                .small()
                .placeholder(font_placeholder)
                .with_text(initial_font)
        });
        let font_sub = cx.subscribe(&font_family_input, |panel, field, event, cx| {
            if let FieldEvent::Submitted(text) = event {
                let trimmed = text.trim().to_owned();
                if !trimmed.is_empty() {
                    set(registry::FONT_SOURCE, Value::from("system"), cx);
                    set(registry::FONT_FAMILY, Value::from(trimmed), cx);
                    panel.font_status = None;
                    cx.notify();
                } else {
                    field.update(cx, |f, cx| f.set_text("", cx));
                }
            }
        });
        let subscription = cx.subscribe_in(&search, window, |panel, field, event, window, cx| {
            match event {
                FieldEvent::Changed(text) => {
                    panel.query = text.clone();
                    panel.scroll.set_offset(gpui::point(px(0.0), px(0.0)));
                    cx.notify();
                }
                FieldEvent::Cancelled => {
                    if panel.query.is_empty() {
                        cx.emit(PanelEvent::Close);
                    } else {
                        panel.query.clear();
                        field.update(cx, |f, cx| f.set_text("", cx));
                        cx.notify();
                    }
                }
                FieldEvent::Submitted(_) | FieldEvent::Blurred => {}
            }
            let _ = window;
        });
        let settings = cx.observe_global::<Settings>(|_, cx| cx.notify());
        let strings = cx.observe_global::<Strings>(|_, cx| cx.notify());
        SettingsPanel {
            focus: cx.focus_handle(),
            search,
            font_family_input,
            system_fonts: None,
            font_status: None,
            replayed_guides: false,
            query: String::new(),
            scroll: ScrollHandle::new(),
            recording: None,
            interceptor: None,
            conflict: None,
            copied: None,
            _subscriptions: vec![subscription, font_sub, settings, strings],
        }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.search.read(cx).focus_handle(cx).focus(window, cx);
    }

    fn import_custom_font(&mut self, cx: &mut Context<Self>) {
        let prompt = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: None,
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = prompt.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let _ = this.update(cx, |panel, cx| match fonts::import_font_file(&path, cx) {
                Ok(_family) => {
                    panel.font_status =
                        Some((true, t(cx, keys::settings::editor::FONT_IMPORT_DONE)));
                    cx.notify();
                }
                Err(err_key) => {
                    panel.font_status = Some((false, t(cx, err_key)));
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub fn query(&self) -> &str {
        &self.query
    }

    /// Searches for `text`, as if typed into the field.
    pub fn set_query(&mut self, text: &str, cx: &mut Context<Self>) {
        self.query = text.to_owned();
        self.search.update(cx, |f, cx| f.set_text(text, cx));
        cx.notify();
    }

    /// Starts recording a new binding for the shortcut `id`.
    pub fn record(&mut self, id: &'static str, cx: &mut Context<Self>) {
        self.recording = Some(id);
        self.conflict = None;
        let this = cx.entity().downgrade();
        self.interceptor = Some(cx.intercept_keystrokes(move |event, window, cx| {
            let keystroke = event.keystroke.clone();
            if this
                .update(cx, |panel, cx| panel.recorded(&keystroke, window, cx))
                .unwrap_or(false)
            {
                cx.stop_propagation();
            }
        }));
        cx.notify();
    }

    /// A key pressed while recording. Returns whether it was taken.
    fn recorded(&mut self, keystroke: &Keystroke, _: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(id) = self.recording else {
            return false;
        };
        let os = cx.platform_info().os;
        if keystroke.key == "escape" && !keystroke.modifiers.modified() {
            self.stop_recording(cx);
            return true;
        }
        let Some(keys) = keymap::portable(keystroke, os) else {
            // A key that types text: not a shortcut; keep listening.
            return true;
        };
        let overrides = Settings::read(cx).key_bindings();
        if let Some(other) = keymap::conflict(id, &keys, os, &overrides) {
            let action: SharedString = match other.listed {
                Some((label, _)) => t(cx, label),
                None => other.action.into(),
            };
            let message = tf(
                cx,
                keys::settings::keys::CONFLICT,
                &[
                    ("accelerator", &keymap::display(&keys, os)),
                    ("action", &action),
                ],
            );
            self.conflict = Some((id, message));
            self.stop_recording(cx);
            return true;
        }
        Settings::update(cx, |file| file.set_key_binding(id, Some(&keys)));
        let overrides = Settings::read(cx).key_bindings();
        keymap::apply(&overrides, cx);
        self.stop_recording(cx);
        true
    }

    fn stop_recording(&mut self, cx: &mut Context<Self>) {
        self.recording = None;
        self.interceptor = None;
        cx.notify();
    }
}

impl Render for SettingsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let requested = super::take_requested_section(window, cx);
        if requested.is_some() {
            self.query.clear();
            self.search.update(cx, |field, cx| field.set_text("", cx));
        }
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let found: Vec<_> = search(&self.query, Strings::get(cx))
            .into_iter()
            .filter(|(section, _)| {
                !matches!(section, Section::Account | Section::Models | Section::Agent)
                    || super::has_module_section(*section, cx)
            })
            .collect();
        if let Some(section) = requested
            && let Some(index) = found
                .iter()
                .position(|(candidate, _)| *candidate == section)
        {
            self.scroll.scroll_to_item(index);
        }
        let current = self.scroll.top_item();
        let rail = rail(&found, current, &self.search, &self.scroll, window, cx);
        let mut sections = div()
            .id("settings-content")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .px(px(48.0))
            .pb(px(120.0));
        for (section, only) in &found {
            sections = sections.child(self.section(*section, only.as_deref(), window, cx));
        }
        let entity = cx.entity();
        let close = div()
            .absolute()
            .top(px((TITLEBAR_HEIGHT - 28.0) / 2.0))
            .right(px(8.0))
            .child(
                PanelIconButton::new("settings-close", Icon::Close)
                    .label(t(cx, keys::common::CLOSE))
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |_, cx| cx.emit(PanelEvent::Close))
                    }),
            );
        glass::surface(
            Ground::flat(p.desk),
            div()
                .id("settings")
                .track_focus(&self.focus)
                .on_action(
                    cx.listener(|panel, _: &crate::actions::FindInEditor, window, cx| {
                        panel.focus(window, cx);
                    }),
                )
                .absolute()
                .inset_0()
                .occlude()
                .bg(p.desk.solid())
                .flex()
                .flex_row()
                .child(rail)
                .child(
                    glass::surface(
                        Ground::flat(p.paper),
                        div()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .pt(px(TITLEBAR_HEIGHT))
                            .bg(p.paper.solid())
                            .border_l(px(0.5))
                            .border_color(p.hairline())
                            .child(sections),
                    )
                    .into_any_element(),
                )
                .child(close),
        )
    }
}

fn section_icon(section: Section) -> Icon {
    match section {
        Section::Account => Icon::NameSeal,
        Section::Appearance => Icon::Enso,
        Section::Editor => Icon::BrushWriting,
        Section::Language => Icon::Wen,
        Section::Keys => Icon::MovableType,
        Section::Models => Icon::DharmaWheel,
        Section::Agent => Icon::Shikigami,
        Section::LocalData => Icon::Folder,
        Section::About => Icon::OpenBook,
    }
}

fn section_subsections(section: Section) -> Vec<Key> {
    let mut groups: Vec<Key> = Vec::new();
    for def in registry::in_section(section) {
        if let Some(g) = def.group
            && !groups.contains(&g)
        {
            groups.push(g);
        }
    }
    for info in registry::info_in(section) {
        if let Some(g) = info.group
            && !groups.contains(&g)
        {
            groups.push(g);
        }
    }
    groups
}

fn rail(
    found: &[(Section, Option<Vec<&'static str>>)],
    current: usize,
    search: &Entity<TextField>,
    scroll: &ScrollHandle,
    window: &mut Window,
    cx: &mut Context<SettingsPanel>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let s = theme.scale;
    let mut col = div()
        .id("settings-rail")
        .flex_none()
        .w(px(m::WIDTH_STANDARD))
        .h_full()
        .pt(px(TITLEBAR_HEIGHT))
        .px(px(m::ROW_INSET))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(
            div()
                .absolute()
                .top_0()
                .left(px(LEADING_INSET))
                .h(px(TITLEBAR_HEIGHT))
                .flex()
                .items_center()
                .font_role(Role::Structure)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(2).solid())
                .child(t(cx, keys::v3_shell::SETTINGS)),
        )
        .child(div().px(px(4.0)).pb(px(8.0)).child(search.clone()));
    let mut group: Option<Key> = None;
    for (i, (section, only)) in found.iter().enumerate() {
        if group != Some(section.group()) {
            group = Some(section.group());
            col = col.child(
                div()
                    .pt(px(8.0))
                    .child(section_label(t(cx, section.group()), &theme)),
            );
        }
        let selected = i == current;
        let scroll_row = scroll.clone();
        let row = glass::glass_box(
            ElementId::Name(format!("rail-{}", section.slug()).into()),
            GlassKind::Hidden,
            Mode::default(),
            selected,
            Spec::new(Tone::Clear, radius::MENU_ROW),
            window,
            cx,
        )
        .h(px(s.menu_row))
        .px(px(m::ROW_PAD_X))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(m::ICON_GAP))
        .cursor_pointer()
        .font_role(Role::Ui)
        .type_px(s.menu_text, s.menu_line)
        .text_color(if selected { p.ink(1) } else { p.ink(2) }.solid())
        .child(sand::icon(
            section_icon(*section),
            14.0,
            if selected { p.ink(1) } else { p.muted() }.solid(),
        ))
        .child(t(cx, section.label()))
        .on_click(move |_, _, _| scroll_row.scroll_to_item(i));
        col = col.child(row);
        if selected && only.is_none() {
            let subs = section_subsections(*section);
            if subs.len() > 1 {
                for (sub_i, sub_key) in subs.into_iter().enumerate() {
                    let scroll_sub = scroll.clone();
                    col = col.child(
                        div()
                            .id(ElementId::Name(
                                format!("rail-sub-{}-{sub_i}", section.slug()).into(),
                            ))
                            .pl(px(m::ROW_PAD_X + 20.0))
                            .pr(px(m::ROW_PAD_X))
                            .py(px(3.0))
                            .rounded(px(radius::SM))
                            .cursor_pointer()
                            .hover(|st| st.bg(p.ink(1).alpha(0.04)))
                            .font_role(Role::Ui)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.muted().solid())
                            .child(t(cx, sub_key))
                            .on_click(move |_, _, _| scroll_sub.scroll_to_item(i)),
                    );
                }
            }
        }
    }
    col.into_any_element()
}

impl SettingsPanel {
    fn section(
        &mut self,
        section: Section,
        only: Option<&[&'static str]>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let mut col = div()
            .id(ElementId::Name(
                format!("section-{}", section.slug()).into(),
            ))
            .pt(px(28.0))
            .flex()
            .flex_col();
        let mut title = div().flex().flex_row().items_center().pb(px(8.0)).child(
            div()
                .flex_1()
                .font_role(Role::Structure)
                .type_px(s.heading + 4.0, s.heading + 12.0)
                .text_color(p.ink(1).solid())
                .child(t(cx, section.label())),
        );
        if section == Section::Editor && editor_changed(cx) {
            title = title.child(
                Button::new(
                    "editor-reset-style",
                    t(cx, keys::settings::editor::RESET_STYLE),
                )
                .text()
                .small()
                .on_click(|_, _, cx| reset_editor_style(cx)),
            );
        }
        if section == Section::Keys && !Settings::read(cx).key_bindings().is_empty() {
            title = title.child(
                Button::new("keys-reset-all", t(cx, keys::settings::keys::RESET_ALL))
                    .text()
                    .small()
                    .on_click(|_, _, cx| {
                        Settings::update(cx, |file| file.reset_key_bindings());
                        let overrides = Settings::read(cx).key_bindings();
                        keymap::apply(&overrides, cx);
                    }),
            );
        }
        col = col.child(title);
        let wanted = |key: &str| only.is_none_or(|keys| keys.contains(&key));
        match section {
            Section::Keys => {
                let count = keymap::listed_shortcuts().count();
                col = col.child(sub_heading(
                    tf(
                        cx,
                        keys::settings::keys::ALL_ACTIONS_SHORT,
                        &[("count", &count)],
                    ),
                    &theme,
                ));
                for shortcut in keymap::listed_shortcuts().filter(|s| wanted(s.id)) {
                    col = col.child(self.shortcut_row(shortcut, window, cx));
                }
            }
            Section::About => {
                if only.is_none() {
                    col = col.child(about_header(&theme, cx));
                }
                col = self.info_rows(col, section, &|_| true, &mut None, &wanted, window, cx);
                if only.is_none() {
                    col = col.child(
                        div()
                            .pt(px(28.0))
                            .font_role(Role::Structure)
                            .type_px(s.secondary, s.line_body)
                            .italic_face()
                            .text_color(p.muted().solid())
                            .child(t(cx, keys::settings::about::TAGLINE)),
                    );
                }
            }
            _ => {
                if section == Section::Editor && only.is_none() {
                    col = col.child(editor_preview(&theme, cx));
                }
                if section == Section::LocalData && only.is_none() {
                    col = col.child(local_intro(&theme, cx));
                }
                // Rows under no heading open the section (本地数据's backup
                // and restore).
                let mut heading: Option<Key> = None;
                col = self.info_rows(
                    col,
                    section,
                    &|r| r.group.is_none(),
                    &mut heading,
                    &wanted,
                    window,
                    cx,
                );
                for def in registry::in_section(section).filter(|d| wanted(d.key)) {
                    if def.key == registry::FONT_FAMILY {
                        continue;
                    }
                    if matches!(def.kind, Kind::Module(_)) {
                        if let Some(control) = super::module_row(def.key, window, cx) {
                            col = col.child(row(
                                def.key,
                                t(cx, def.label),
                                def.description.map(|key| t(cx, key)),
                                control,
                                &theme,
                            ));
                        }
                        continue;
                    }
                    if let Some(group) = def.group
                        && def.group != heading
                    {
                        heading = def.group;
                        col = col.child(
                            div()
                                .pt(px(16.0))
                                .pb(px(4.0))
                                .font_role(Role::Ui)
                                .type_px(s.caption, s.line_caption)
                                .text_color(p.muted().solid())
                                .child(t(cx, group)),
                        );
                    }
                    let control = control(def, window, cx);
                    col = col.child(row(
                        def.key,
                        t(cx, def.label),
                        def.description.map(|d| t(cx, d)),
                        control,
                        &theme,
                    ));
                    if def.key == registry::FONT_SOURCE
                        && let Some(detail) = self.font_detail_row(window, cx)
                    {
                        col = col.child(detail);
                    }
                }
                // Under the settings' last heading when they share it (数据使用).
                col = self.info_rows(
                    col,
                    section,
                    &|r| r.group.is_some(),
                    &mut heading,
                    &wanted,
                    window,
                    cx,
                );
                if section == Section::LocalData && only.is_none() {
                    col = col.child(
                        div()
                            .pt(px(16.0))
                            .font_role(Role::Ui)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.muted().solid())
                            .child(t(cx, keys::settings::privacy::NOTE_LOCAL)),
                    );
                }
            }
        }
        col.into_any_element()
    }

    /// The rows of `section` that are not stored settings (those `pick`
    /// takes), under their headings.
    #[allow(clippy::too_many_arguments)]
    fn info_rows(
        &mut self,
        mut col: gpui::Stateful<gpui::Div>,
        section: Section,
        pick: &dyn Fn(&InfoRow) -> bool,
        heading: &mut Option<Key>,
        wanted: &dyn Fn(&str) -> bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = Theme::of(window, cx);
        for info in registry::info_in(section).filter(|r| pick(r) && wanted(r.id)) {
            if info.action == RowAction::Module {
                if let Some(control) = super::module_row(info.id, window, cx) {
                    col = col.child(control);
                }
                continue;
            }
            // Where the Markdown folder is matters only while it is on; the
            // tour's row only when the app has a tour.
            if (info.action == RowAction::ReplayGuides && crate::pages::guide(cx).is_none())
                || (info.action == RowAction::Updates && !super::has_updates_row(cx))
            {
                continue;
            }
            if info.group.is_some() && info.group != *heading {
                *heading = info.group;
                if let Some(group) = info.group {
                    col = col.child(sub_heading(t(cx, group), &theme));
                }
            }
            if info.action == RowAction::Updates {
                if let Some(updates) = super::updates_row(window, cx) {
                    col = col.child(row(
                        info.id,
                        t(cx, info.label),
                        updates.description,
                        updates.control.unwrap_or_else(|| div().into_any_element()),
                        &theme,
                    ));
                }
                continue;
            }
            let control = self.info_control(info, window, cx);
            let description = match (info.action, self.copied) {
                (RowAction::CopyDiagnostics, Some(true)) => {
                    Some(t(cx, keys::settings::privacy::DIAGNOSTICS_COPIED))
                }
                (RowAction::CopyDiagnostics, Some(false)) => {
                    Some(t(cx, keys::settings::privacy::DIAGNOSTICS_COPY_FAILED))
                }

                _ => info.description.map(|d| t(cx, d)),
            };
            let label = t(cx, info.label);
            col = col.child(row(info.id, label, description, control, &theme));
        }
        col
    }

    fn info_control(
        &mut self,
        info: &'static InfoRow,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        match info.action {
            RowAction::Module => div().into_any_element(),
            RowAction::Open { url, button } => Button::new(
                ElementId::Name(format!("open-{}", info.id).into()),
                t(cx, button),
            )
            .small()
            .on_click(move |_, _, cx| cx.open_url(url))
            .into_any_element(),
            RowAction::CopyDiagnostics => {
                let panel = cx.entity();
                Button::new(
                    "copy-diagnostics",
                    t(cx, keys::settings::privacy::COPY_DIAGNOSTICS),
                )
                .small()
                .on_click(move |_, _, cx| {
                    let summary = diagnostics_summary(cx);
                    cx.write_to_clipboard(gpui::ClipboardItem::new_string(summary));
                    panel.update(cx, |p, cx| {
                        p.copied = Some(true);
                        cx.notify();
                    });
                })
                .into_any_element()
            }
            RowAction::Feedback => {
                let panel = cx.entity();
                Button::new("open-feedback", t(cx, keys::settings::about::FEEDBACK))
                    .small()
                    .on_click(move |_, window, cx| {
                        // Settings closes; the dialog comes up over the page.
                        panel.update(cx, |_, cx| cx.emit(PanelEvent::Close));
                        window.dispatch_action(Box::new(crate::actions::SendFeedback), cx);
                    })
                    .into_any_element()
            }
            RowAction::Backup | RowAction::Restore => {
                let (id, label) = if info.action == RowAction::Backup {
                    ("open-backup", keys::settings::sync::backup::EXPORT_BUTTON)
                } else {
                    ("open-restore", keys::settings::sync::backup::RESTORE_BUTTON)
                };
                let panel = cx.entity();
                let backup = info.action == RowAction::Backup;
                let button =
                    Button::new(id, t(cx, label))
                        .small()
                        .on_click(move |_, window, cx| {
                            // Settings closes; the dialog comes up over the page.
                            panel.update(cx, |_, cx| cx.emit(PanelEvent::Close));
                            if backup {
                                window.dispatch_action(Box::new(crate::actions::BackupLibrary), cx);
                            } else {
                                window
                                    .dispatch_action(Box::new(crate::actions::RestoreLibrary), cx);
                            }
                        });
                if backup {
                    return button.into_any_element();
                }
                // 「打开恢复前副本」, the 0.1 ghost button beside 恢复….
                let copies = Button::new(
                    "open-pre-restore",
                    t(cx, keys::settings::sync::backup::OPEN_SAFETY),
                )
                .text()
                .small()
                .on_click(|_, _, cx| {
                    if let Some(folder) = pre_restore_folder(cx) {
                        cx.open_with_system(&folder);
                    }
                });
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .child(button)
                    .child(copies)
                    .into_any_element()
            }

            RowAction::ExportAllMarkdown => {
                let panel = cx.entity();
                Button::new(
                    "export-all-markdown",
                    t(cx, keys::settings::account::EXPORT_ALL_BTN),
                )
                .small()
                .on_click(move |_, window, cx| {
                    panel.update(cx, |_, cx| cx.emit(PanelEvent::Close));
                    window
                        .dispatch_action(Box::new(crate::actions::ExportAllRelationalMarkdown), cx);
                })
                .into_any_element()
            }
            RowAction::ImportFiles => {
                let panel = cx.entity();
                let has_lib = cx
                    .try_global::<crate::Services>()
                    .is_some_and(|s| s.library.is_some());
                Button::new("import-files", t(cx, keys::settings::sync::SELECT_FILE))
                    .small()
                    .disabled(!has_lib)
                    .on_click(move |_, window, cx| {
                        panel.update(cx, |_, cx| cx.emit(PanelEvent::Close));
                        window.dispatch_action(Box::new(crate::actions::ImportDocuments), cx);
                    })
                    .into_any_element()
            }
            RowAction::FontsCredit => {
                let mut label = "Drifting Sans · Drifting Serif · Sarasa Mono SC".to_owned();
                if let Some((_, family)) = fonts::imported_custom_font(cx) {
                    label.push_str(&format!(" · {family}"));
                }
                div()
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.ink(2).solid())
                    .child(label)
                    .into_any_element()
            }
            RowAction::ReplayGuides => {
                let has_seen = crate::pages::guide(cx).is_some_and(|g| (g.has_seen)(cx))
                    && !self.replayed_guides;
                let panel = cx.entity();
                Button::new(
                    "replay-guides",
                    t(cx, keys::settings::appearance::REPLAY_GUIDES_ACTION),
                )
                .small()
                .disabled(!has_seen)
                .on_click(move |_, _, cx| {
                    if let Some(guide) = crate::pages::guide(cx) {
                        (guide.reset)(cx);
                        panel.update(cx, |p, cx| {
                            p.replayed_guides = true;
                            cx.notify();
                        });
                    }
                })
                .into_any_element()
            }
            // Drawn from M42's hook in `info_rows`.
            RowAction::Updates => div().into_any_element(),
            RowAction::Version => div()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.ink(2).solid())
                .child(version_line(cx))
                .into_any_element(),
        }
    }

    fn font_detail_row(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let source = Settings::read(cx)
            .str(registry::FONT_SOURCE)
            .unwrap_or_else(|| "system-serif".into());
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        match source.as_str() {
            "system" => {
                let list = self
                    .system_fonts
                    .get_or_insert_with(|| fonts::system_font_families(cx))
                    .clone();
                let current = Settings::read(cx)
                    .str(registry::FONT_FAMILY)
                    .unwrap_or_default();
                let mut choices = Vec::with_capacity(list.len() + 1);
                choices.push(Choice::plain(t(
                    cx,
                    keys::settings::editor::FONT_SYSTEM_PLACEHOLDER,
                )));
                choices.extend(list.iter().cloned().map(Choice::plain));
                let selected = list
                    .iter()
                    .position(|n| n == &current)
                    .map(|i| i + 1)
                    .unwrap_or(0);
                let list_for_pick = list;
                let input_sync = self.font_family_input.clone();
                let input_apply = self.font_family_input.clone();
                Some(
                    div()
                        .id("settings-font-system-detail")
                        .py(px(10.0))
                        .border_b(px(0.5))
                        .border_color(p.subtle_hairline())
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(
                            Select::new("settings-system-font-select", choices, selected)
                                .on_change(move |i, _, cx| {
                                    let chosen = i
                                        .checked_sub(1)
                                        .and_then(|idx| list_for_pick.get(idx))
                                        .cloned()
                                        .unwrap_or_default();
                                    set(registry::FONT_FAMILY, Value::from(chosen.clone()), cx);
                                    input_sync.update(cx, |f, cx| f.set_text(chosen, cx));
                                }),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .child(self.font_family_input.clone()),
                                )
                                .child(
                                    Button::new(
                                        "settings-font-family-apply",
                                        t(cx, keys::settings::editor::FONT_USE),
                                    )
                                    .small()
                                    .on_click(
                                        move |_, _, cx| {
                                            let text =
                                                input_apply.read(cx).text().trim().to_owned();
                                            if !text.is_empty() {
                                                set(registry::FONT_FAMILY, Value::from(text), cx);
                                            }
                                        },
                                    ),
                                ),
                        )
                        .into_any_element(),
                )
            }
            "custom" => {
                let imported = fonts::imported_custom_font(cx);
                let panel_import = cx.entity();
                let panel_remove = cx.entity();
                let btn_label = if imported.is_some() {
                    t(cx, keys::settings::editor::FONT_REPLACE)
                } else {
                    t(cx, keys::settings::editor::FONT_IMPORT)
                };
                let mut actions = div().flex().flex_row().items_center().gap(px(8.0)).child(
                    Button::new("settings-font-import", btn_label)
                        .small()
                        .on_click(move |_, _, cx| {
                            panel_import.update(cx, |p, cx| p.import_custom_font(cx));
                        }),
                );
                if let Some((_, family)) = &imported {
                    actions = actions
                        .child(
                            div()
                                .font_role(Role::Index)
                                .type_px(s.caption, s.line_caption)
                                .text_color(p.ink(2).solid())
                                .child(family.clone()),
                        )
                        .child(
                            Button::new(
                                "settings-font-remove",
                                t(cx, keys::settings::editor::FONT_REMOVE),
                            )
                            .text()
                            .small()
                            .on_click(move |_, _, cx| {
                                fonts::remove_custom_font(cx);
                                panel_remove.update(cx, |p, cx| {
                                    p.font_status = Some((
                                        true,
                                        t(cx, keys::settings::editor::FONT_REMOVE_DONE),
                                    ));
                                    cx.notify();
                                });
                            }),
                        );
                }
                let mut box_el = div()
                    .id("settings-font-custom-detail")
                    .py(px(10.0))
                    .border_b(px(0.5))
                    .border_color(p.subtle_hairline())
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(actions)
                    .child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.muted().solid())
                            .child(t(cx, keys::settings::editor::FONT_IMPORT_HELP)),
                    );
                if let Some((ok, msg)) = &self.font_status {
                    box_el = box_el.child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.caption, s.line_caption)
                            .text_color(if *ok { p.accent } else { p.danger }.solid())
                            .child(msg.clone()),
                    );
                }
                Some(box_el.into_any_element())
            }
            _ => None,
        }
    }

    fn shortcut_row(
        &mut self,
        shortcut: &'static Shortcut,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let s = theme.scale;
        let os = cx.platform_info().os;
        let overrides = Settings::read(cx).key_bindings();
        let (label, desc) = shortcut.listed.expect("only listed shortcuts have rows");
        let recording = self.recording == Some(shortcut.id);
        let current: SharedString = if recording {
            t(cx, keys::settings::keys::PRESS_NEW_COMBO)
        } else {
            let keys = shortcut.effective(&overrides);
            keys.first()
                .map(|k| keymap::display(k, os))
                .unwrap_or_default()
                .into()
        };
        let id = shortcut.id;
        let entity = cx.entity();
        let chip = Button::new(SharedString::from(format!("key-{id}")), current)
            .small()
            .on_click(move |_, _, cx| entity.update(cx, |panel, cx| panel.record(id, cx)));
        let mut controls = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .child(chip);
        if overrides.contains_key(id) {
            controls = controls.child(
                Button::new(
                    SharedString::from(format!("key-reset-{id}")),
                    t(cx, keys::settings::keys::RESET),
                )
                .text()
                .small()
                .on_click(move |_, _, cx| {
                    Settings::update(cx, |file| file.set_key_binding(id, None));
                    let overrides = Settings::read(cx).key_bindings();
                    keymap::apply(&overrides, cx);
                }),
            );
        }
        let conflict = self
            .conflict
            .as_ref()
            .filter(|(c, _)| *c == id)
            .map(|(_, message)| message.clone());
        let mut el = div().flex().flex_col().child(row(
            id,
            t(cx, label),
            Some(t(cx, desc)),
            controls.into_any_element(),
            &theme,
        ));
        if recording {
            el = el.child(
                div()
                    .pb(px(6.0))
                    .font_role(Role::Index)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.accent.solid())
                    .child(t(cx, keys::settings::keys::RECORDING)),
            );
        }
        if let Some(message) = conflict {
            el = el.child(
                div()
                    .pb(px(6.0))
                    .font_role(Role::Ui)
                    .type_px(s.caption, s.line_caption)
                    .text_color(p.danger.solid())
                    .child(message),
            );
        }
        el.into_any_element()
    }
}

fn sub_heading(text: SharedString, theme: &Theme) -> gpui::Div {
    div()
        .pt(px(16.0))
        .pb(px(4.0))
        .font_role(Role::Ui)
        .type_px(theme.scale.caption, theme.scale.line_caption)
        .text_color(theme.palette.muted().solid())
        .child(text)
}

/// 版本 0.2.0-dev · 通道 Alpha · 引擎 GPUI + Loro + SQLite · the platform.
pub fn version_line(cx: &App) -> String {
    let version = cx.try_global::<ShellInfo>().map_or("", |i| i.version);
    format!(
        "{version} · {} {} · {} GPUI + Loro + SQLite · {}",
        t(cx, keys::settings::about::CHANNEL),
        t(cx, keys::settings::about::CHANNEL_PRE_ALPHA),
        t(cx, keys::settings::about::ENGINE),
        t(cx, keys::settings::update::CHANNEL_DESC),
    )
}

/// The folder the library's pre-restore backups are kept in, made when it
/// is not there yet (the 0.1 client opened it all the same); `None`
/// without a library or when it cannot be made.
pub fn pre_restore_folder(cx: &App) -> Option<std::path::PathBuf> {
    let lib = cx
        .try_global::<crate::Services>()
        .and_then(|s| s.library.as_ref())?;
    let folder = dr_store::Library::pre_restore_dir(lib.library().paths().root.clone());
    match std::fs::create_dir_all(&folder) {
        Ok(()) => Some(folder),
        Err(error) => {
            log::warn!("the pre-restore folder could not be made: {error}");
            None
        }
    }
}

/// The de-identified diagnostics summary (the 0.1 client's 脱敏诊断摘要,
/// formatVersion 2 JSON): version, platform, locale, open library book count,
/// and privacy flags. No prose, no ids, no paths, no credentials.
pub fn diagnostics_summary(cx: &App) -> String {
    let info = cx.try_global::<ShellInfo>();
    let books = cx
        .try_global::<crate::Services>()
        .and_then(|s| s.library.as_ref())
        .and_then(|lib| lib.library().docs(None, Some("book")).ok())
        .map(|docs| docs.len());
    let file = Settings::read(cx);
    let payload = serde_json::json!({
        "format": "drifting.sanitized-diagnostics",
        "formatVersion": 2,
        "generatedAt": chrono::Utc::now().to_rfc3339(),
        "app": {
            "version": info.map_or("unknown", |i| i.version),
            "platform": std::env::consts::OS,
            "architecture": std::env::consts::ARCH,
            "engine": "GPUI + Loro + SQLite",
        },
        "locale": Settings::locale(cx).code(),
        "library": {
            "open": books.is_some(),
            "books": books.unwrap_or(0),
        },
        "privacy": {
            "crashReportsEnabled": file.bool(registry::CRASH_REPORTS),
            "automaticUpload": false,
            "manuscriptIncluded": false,
            "credentialsIncluded": false,
            "absolutePathsIncluded": false,
            "rawErrorTextIncluded": false,
        },
    });
    serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_owned()) + "\n"
}

/// Whether any editor setting differs from its default.
fn editor_changed(cx: &App) -> bool {
    let file = Settings::read(cx);
    registry::in_section(Section::Editor).any(|d| file.is_changed(d, None))
}

/// 还原推荐样式: every editor setting back to its default.
pub fn reset_editor_style(cx: &mut App) {
    Settings::update(cx, |file| {
        for def in registry::in_section(Section::Editor) {
            file.reset(def.key, None);
        }
    });
}

/// The editor section's preview: a heading and two paragraphs (the 0.1
/// client's sample) set in the editor's settings.
fn editor_preview(theme: &Theme, cx: &App) -> AnyElement {
    let p = theme.palette;
    let look = crate::workspace::EditorLook::read(cx);
    let custom_family = fonts::resolved_prose_family(cx);
    let justify = Settings::read(cx).bool(registry::JUSTIFY);
    let apply_face = |el: gpui::Div| match &custom_family {
        Some(fam) => el.font_family(SharedString::from(fam.clone())),
        None => el.font_role(Role::Prose),
    };
    let body = |text: SharedString| {
        apply_face(div())
            .text_size(px(look.font_size))
            .line_height(px(look.font_size * look.line_height))
            .pb(px(look.font_size * look.paragraph_spacing))
            .text_color(p.ink(1).solid())
            .child(format!("{}{text}", "\u{3000}".repeat(look.indent)))
    };
    let h1 = look.size_of(1);
    let mut header = div()
        .pb(px(8.0))
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .child(
            div()
                .font_role(Role::Ui)
                .type_px(theme.scale.caption, theme.scale.line_caption)
                .text_color(p.muted().solid())
                .child(t(cx, keys::settings::editor::PREVIEW)),
        );
    if justify {
        header = header.child(
            div()
                .font_role(Role::Index)
                .type_px(theme.scale.caption, theme.scale.line_caption)
                .text_color(p.muted().solid())
                .child(t(cx, keys::settings::editor::JUSTIFY)),
        );
    }
    div()
        .mt(px(4.0))
        .mb(px(8.0))
        .p(px(24.0))
        .w_full()
        .max_w(px(look.page_width))
        .rounded(px(radius::SHEET))
        .bg(p.page.solid())
        .border_1()
        .border_color(p.subtle_hairline())
        .child(header)
        .child(
            apply_face(div())
                .text_size(px(h1))
                .line_height(px(h1 * 1.4))
                .pb(px(look.font_size * look.paragraph_spacing))
                .text_color(p.ink(1).solid())
                .child(t(cx, keys::settings::editor::PREVIEW_H1)),
        )
        .child(body(t(cx, keys::settings::editor::PREVIEW_P1)))
        .child(body(t(cx, keys::settings::editor::PREVIEW_P2)))
        .into_any_element()
}

/// 本地数据's opening: this build keeps everything on this machine.
fn local_intro(theme: &Theme, cx: &App) -> AnyElement {
    let (p, s) = (theme.palette, theme.scale);
    div()
        .pb(px(8.0))
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(
            div()
                .font_role(Role::Structure)
                .type_px(s.body + 2.0, s.line_body + 2.0)
                .text_color(p.ink(1).solid())
                .child(t(cx, keys::settings::sync::LOCAL_TITLE)),
        )
        .child(
            div()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(2).solid())
                .child(t(cx, keys::settings::sync::LOCAL_SUB)),
        )
        .into_any_element()
}

/// 关于's opening: the name and the line under it.
fn about_header(theme: &Theme, cx: &App) -> AnyElement {
    let (p, s) = (theme.palette, theme.scale);
    div()
        .pb(px(8.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(
            div()
                .font_role(Role::Structure)
                .type_px(s.heading + 16.0, s.heading + 26.0)
                .text_color(p.ink(1).solid())
                .child(t(cx, keys::settings::about::TITLE)),
        )
        .child(
            div()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(p.muted().solid())
                .child(t(cx, keys::settings::about::SUB)),
        )
        .into_any_element()
}

pub(crate) fn row(
    id: &str,
    label: SharedString,
    description: Option<SharedString>,
    control: AnyElement,
    theme: &Theme,
) -> AnyElement {
    let p = theme.palette;
    let s = theme.scale;
    let selector = format!("settings-row-{id}");
    div()
        .id(ElementId::Name(format!("row-{id}").into()))
        .debug_selector(move || selector)
        .py(px(12.0))
        .border_b(px(0.5))
        .border_color(p.subtle_hairline())
        .flex()
        .flex_row()
        .items_center()
        .gap(px(24.0))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.0))
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.body, s.line_body)
                        .text_color(p.ink(1).solid())
                        .child(label),
                )
                .when_some(description, |el, d| {
                    el.child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.muted().solid())
                            .child(d),
                    )
                }),
        )
        .child(div().flex_none().child(control))
        .into_any_element()
}

fn set(key: &'static str, value: Value, cx: &mut App) {
    let result = Settings::update(cx, |file| file.set(key, value, None));
    if let Err(error) = result {
        log::warn!("setting {key} refused: {error:?}");
    }
}

/// The decimals a number shows for its grain: 0.02 and 0.05 two, 1 and 10
/// none.
pub fn decimals(step: f64) -> u32 {
    let mut d = 0;
    let mut x = step.abs();
    while d < 4 && (x - x.round()).abs() > 1e-9 {
        x *= 10.0;
        d += 1;
    }
    d
}

/// The control a setting's kind calls for.
fn control(def: &'static SettingDef, window: &mut Window, cx: &mut App) -> AnyElement {
    let file = Settings::read(cx);
    let key = def.key;
    match def.kind {
        Kind::Module(_) | Kind::Text { .. } => div().into_any_element(),
        Kind::OptionalColor => {
            let theme = Theme::of(window, cx);
            let stored = file.str(key);
            let current = stored
                .as_deref()
                .and_then(color::parse_hex)
                .unwrap_or(theme.palette.accent);
            let mut row = div().flex().flex_row().items_center().gap(px(8.0)).child(
                ColorSwatch::new(SharedString::from(format!("color-{key}")), current)
                    .show_value()
                    .label(t(cx, def.label))
                    .on_pick(move |rgb, _, cx| {
                        set(key, Value::from(color::hex(rgb)), cx);
                    }),
            );
            if stored.is_some() {
                row = row.child(
                    Button::new(
                        SharedString::from(format!("color-reset-{key}")),
                        t(cx, keys::settings::appearance::ACCENT_RESET),
                    )
                    .text()
                    .small()
                    .on_click(move |_, _, cx| {
                        Settings::update(cx, |f| f.reset(key, None));
                    }),
                );
            }
            row.into_any_element()
        }
        Kind::ColorMap(defaults) => {
            let theme = Theme::of(window, cx);
            let p = theme.palette;
            let s = theme.scale;
            let current_map = file.get(key).as_object().cloned().unwrap_or_default();
            let changed = file.is_changed(def, None);
            let mut grid = div()
                .flex()
                .flex_row()
                .flex_wrap()
                .items_center()
                .justify_end()
                .gap(px(10.0));
            for (kind_key, default_hex) in defaults {
                let kind_label = match *kind_key {
                    "element" => t(cx, keys::settings::editor::ENTITY_LINK_KIND_ELEMENT),
                    "chapter" => t(cx, keys::settings::editor::ENTITY_LINK_KIND_CHAPTER),
                    "drift" => t(cx, keys::settings::editor::ENTITY_LINK_KIND_DRIFT),
                    "patch" => t(cx, keys::settings::editor::ENTITY_LINK_KIND_PATCH),
                    "category" => t(cx, keys::settings::editor::ENTITY_LINK_KIND_CATEGORY),
                    "storyline" => t(cx, keys::settings::editor::ENTITY_LINK_KIND_STORYLINE),
                    other => SharedString::from(other.to_owned()),
                };
                let hex = current_map
                    .get(*kind_key)
                    .and_then(Value::as_str)
                    .unwrap_or(default_hex);
                let rgb = color::parse_hex(hex).unwrap_or(p.accent);
                let kind_key_owned = (*kind_key).to_owned();
                grid = grid.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(4.0))
                        .child(
                            ColorSwatch::new(
                                SharedString::from(format!("link-color-{kind_key}")),
                                rgb,
                            )
                            .label(kind_label.clone())
                            .on_pick(move |picked, _, cx| {
                                let mut map = Settings::read(cx)
                                    .get(key)
                                    .as_object()
                                    .cloned()
                                    .unwrap_or_default();
                                map.insert(kind_key_owned.clone(), Value::from(color::hex(picked)));
                                set(key, Value::Object(map), cx);
                            }),
                        )
                        .child(
                            div()
                                .font_role(Role::Ui)
                                .type_px(s.caption, s.line_caption)
                                .text_color(p.ink(2).solid())
                                .child(kind_label),
                        ),
                );
            }
            if changed {
                grid = grid.child(
                    Button::new(
                        "link-kind-colors-reset",
                        t(cx, keys::settings::appearance::ACCENT_RESET),
                    )
                    .text()
                    .small()
                    .on_click(move |_, _, cx| {
                        Settings::update(cx, |f| f.reset(key, None));
                    }),
                );
            }
            grid.into_any_element()
        }
        // dr-ui's Switch draws no accessibility node; the row's name and
        // state go on a box around it (as the template editor's switches do).
        Kind::Switch => {
            let on = file.bool(key);
            div()
                .id(ElementId::Name(format!("switch-{key}").into()))
                .role(gpui::Role::CheckBox)
                .aria_label(t(cx, def.label))
                .aria_toggled(if on {
                    gpui::Toggled::True
                } else {
                    gpui::Toggled::False
                })
                .child(
                    Switch::new(key, on).on_change(move |on, _, cx| set(key, Value::Bool(on), cx)),
                )
                .into_any_element()
        }
        Kind::Choice(options) => {
            let value = file.str(key).unwrap_or_default();
            let index = options.iter().position(|o| o.value == value).unwrap_or(0);
            let labels: Vec<SharedString> = options.iter().map(|o| t(cx, o.label)).collect();
            let pick = move |i: usize, _: &mut Window, cx: &mut App| {
                set(key, Value::from(options[i].value), cx)
            };
            if options.len() <= 4 {
                Segmented::new(key, labels, index)
                    .on_change(pick)
                    .into_any_element()
            } else {
                let choices = labels
                    .into_iter()
                    .map(|l| Choice::new(Icon::Zi, l))
                    .collect();
                Select::new(key, choices, index)
                    .on_change(pick)
                    .into_any_element()
            }
        }
        Kind::Locale => {
            let current = Settings::locale(cx);
            let locales = dr_i18n::Locale::ALL;
            let index = locales.iter().position(|l| *l == current).unwrap_or(0);
            let choices = locales
                .iter()
                .map(|l| Choice::new(Icon::Wen, l.native_name()))
                .collect();
            Select::new(key, choices, index)
                .on_change(move |i, _, cx| set(key, Value::from(locales[i].code()), cx))
                .into_any_element()
        }
        Kind::Number {
            min,
            max,
            step,
            unit,
        } => {
            // The slider and the number beside it: one value, one callback
            // (the 0.1 client's GlassRange with its field).
            let value = file.number(key);
            let label = t(cx, def.label);
            let pick = move |v: f64, _: &mut Window, cx: &mut App| set(key, Value::from(v), cx);
            let mut field =
                NumberField::new(SharedString::from(format!("{key}-field")), value, min, max)
                    .decimals(decimals(step))
                    .label(label.clone())
                    .on_change(pick);
            if !unit.is_empty() {
                field = field.unit(unit);
            }
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(12.0))
                .child(
                    Range::new(SharedString::from(format!("{key}-range")), value, min, max)
                        .step(step)
                        .label(label)
                        .on_change(pick),
                )
                .child(field)
                .into_any_element()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_i18n::{I18n, Locale, Platform};

    fn zh() -> I18n {
        I18n::new(Locale::ZhCn, Platform::Mac)
    }

    #[test]
    fn search_finds_the_rows_that_are_not_settings() {
        let s = zh();
        // Nothing typed: every section, whole.
        let all = search("", &s);
        assert_eq!(all.len(), Section::ALL.len());
        assert!(all.iter().all(|(_, only)| only.is_none()));
        // A link of 关于 by its name.
        assert_eq!(
            search("许可证", &s),
            vec![(Section::About, Some(vec!["about.license"]))]
        );
        // 本地数据: the crash-report switch and the diagnostics summary; 关于:
        // 提交反馈, which can attach the summary.
        assert_eq!(
            search("诊断", &s),
            vec![
                (
                    Section::LocalData,
                    Some(vec![registry::CRASH_REPORTS, "local.diagnostics"])
                ),
                (Section::About, Some(vec!["about.feedback"])),
            ]
        );
        // A section by its own name: all of it.
        assert_eq!(search("关于", &s), vec![(Section::About, None)]);
        // Nothing matching shows nothing.
        assert!(search("zzzz", &s).is_empty());
    }

    #[test]
    fn every_info_row_has_its_words_and_sits_in_a_section() {
        let s = zh();
        for row in registry::INFO_ROWS {
            assert!(!s.t(row.label).is_empty(), "{}", row.id);
            assert!(Section::ALL.contains(&row.section));
        }
        let ids: std::collections::HashSet<_> = registry::INFO_ROWS.iter().map(|r| r.id).collect();
        assert_eq!(ids.len(), registry::INFO_ROWS.len(), "ids are unique");
    }
}
