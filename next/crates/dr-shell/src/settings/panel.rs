//! The settings panel, generated from the registry.
//!
//! Like the Super Views it covers the window: a rail of groups and sections
//! on the left (the search field on top), every section in one scroll on
//! the right. Clicking a section jumps there at once; scrolling moves the
//! rail's current item (workspace.md, 「桌面完整 Settings」). Each row is the
//! control its kind calls for (f5-ui.md, 「给设置注册表用的控件约定」).
//!
//! Search matches section names, group headings, each setting's name,
//! description, options and extra search terms in the interface language,
//! ignoring case and runs of white space. Settings → Keys lists the
//! shortcut registry; a shortcut is rebound by clicking it and pressing the
//! new keys (Esc cancels).

use dr_i18n::{Key, keys, normalize};
use dr_ui::{
    Theme,
    components::{
        Button, Choice, IconButton, PanelIconButton, Segmented, Select, Switch, menu::section_label,
    },
    fonts::Role,
    glass::{self, Ground, Kind as GlassKind, Mode, Spec, Tone},
    input::{FieldEvent, TextField},
    sand::Icon,
    style::DrStyled,
    tokens::{menu as m, radius},
};
use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, EventEmitter, FocusHandle,
    Focusable, InteractiveElement, IntoElement, Keystroke, ParentElement, Render, ScrollHandle,
    SharedString, StatefulInteractiveElement, Styled, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};
use serde_json::Value;

use super::Settings;
use super::registry::{self, Kind, Section, SettingDef};
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
    query: String,
    scroll: ScrollHandle,
    /// The shortcut being recorded, and the keystroke interceptor doing it.
    recording: Option<&'static str>,
    interceptor: Option<Subscription>,
    /// A refused rebinding: the shortcut and why.
    conflict: Option<(&'static str, SharedString)>,
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
            if section == Section::Updates && hit(keys::settings::update::CURRENT_VERSION) {
                return Some((section, None));
            }
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
            query: String::new(),
            scroll: ScrollHandle::new(),
            recording: None,
            interceptor: None,
            conflict: None,
            _subscriptions: vec![subscription, settings, strings],
        }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.search.read(cx).focus_handle(cx).focus(window, cx);
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
        let theme = Theme::of(window, cx);
        let p = theme.palette;
        let found = search(&self.query, Strings::get(cx));
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
            .id("settings-close-slot")
            .aria_label(t(cx, keys::common::CLOSE))
            .absolute()
            .top(px((TITLEBAR_HEIGHT - 28.0) / 2.0))
            .right(px(8.0))
            .child(
                PanelIconButton::new("settings-close", Icon::Close).on_click(move |_, _, cx| {
                    entity.update(cx, |_, cx| cx.emit(PanelEvent::Close))
                }),
            );
        glass::surface(
            Ground::flat(p.desk),
            div()
                .id("settings")
                .track_focus(&self.focus)
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
                .child(t(cx, keys::settings::TITLE)),
        )
        .child(div().px(px(4.0)).pb(px(8.0)).child(search.clone()));
    let mut group: Option<Key> = None;
    for (i, (section, _)) in found.iter().enumerate() {
        if group != Some(section.group()) {
            group = Some(section.group());
            col = col.child(
                div()
                    .pt(px(8.0))
                    .child(section_label(t(cx, section.group()), &theme)),
            );
        }
        let selected = i == current;
        let scroll = scroll.clone();
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
        .items_center()
        .cursor_pointer()
        .font_role(Role::Ui)
        .type_px(s.menu_text, s.menu_line)
        .text_color(if selected { p.ink(1) } else { p.ink(2) }.solid())
        .child(t(cx, section.label()))
        .on_click(move |_, _, _| scroll.scroll_to_item(i));
        col = col.child(row);
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
                for shortcut in keymap::listed_shortcuts().filter(|s| wanted(s.id)) {
                    col = col.child(self.shortcut_row(shortcut, window, cx));
                }
            }
            Section::Updates => {
                let version = cx.try_global::<ShellInfo>().map_or("", |i| i.version);
                let channel = t(cx, keys::settings::update::CHANNEL_DESC);
                col = col.child(row(
                    "update-version",
                    t(cx, keys::settings::update::CURRENT_VERSION),
                    None,
                    div()
                        .font_role(Role::Index)
                        .type_px(s.caption, s.line_caption)
                        .text_color(p.ink(2).solid())
                        .child(format!("{version} · {channel}"))
                        .into_any_element(),
                    &theme,
                ));
            }
            _ => {
                let mut heading: Option<Key> = None;
                for def in registry::in_section(section).filter(|d| wanted(d.key)) {
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
                }
            }
        }
        col.into_any_element()
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

fn row(
    id: &str,
    label: SharedString,
    description: Option<SharedString>,
    control: AnyElement,
    theme: &Theme,
) -> AnyElement {
    let p = theme.palette;
    let s = theme.scale;
    div()
        .id(ElementId::Name(format!("row-{id}").into()))
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

/// The control a setting's kind calls for.
fn control(def: &'static SettingDef, window: &mut Window, cx: &mut App) -> AnyElement {
    let file = Settings::read(cx);
    let key = def.key;
    let theme = Theme::of(window, cx);
    match def.kind {
        Kind::Switch => Switch::new(key, file.bool(key))
            .on_change(move |on, _, cx| set(key, Value::Bool(on), cx))
            .into_any_element(),
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
            let value = file.number(key);
            let text = if step >= 1.0 {
                format!("{value:.0}")
            } else {
                let s = format!("{value:.2}");
                s.trim_end_matches('0').trim_end_matches('.').to_owned()
            };
            let p = theme.palette;
            let s = theme.scale;
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .child(
                    IconButton::new(SharedString::from(format!("{key}-less")), Icon::Minus)
                        .disabled(value <= min)
                        .on_click(move |_, _, cx| {
                            let next = ((value - step) / step).round() * step;
                            set(key, Value::from(next.max(min)), cx)
                        }),
                )
                .child(
                    div()
                        .min_w(px(64.0))
                        .flex()
                        .justify_center()
                        .font_role(Role::Index)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.ink(1).solid())
                        .child(format!("{text} {unit}").trim().to_owned()),
                )
                .child(
                    IconButton::new(SharedString::from(format!("{key}-more")), Icon::Plus)
                        .disabled(value >= max)
                        .on_click(move |_, _, cx| {
                            let next = ((value + step) / step).round() * step;
                            set(key, Value::from(next.min(max)), cx)
                        }),
                )
                .into_any_element()
        }
    }
}
