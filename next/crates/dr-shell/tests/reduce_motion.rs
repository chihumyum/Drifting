//! 关闭动态效果 (外观, below 界面字号): on, every movement lands at once
//! whatever the system says; off, the system's 减少动态效果 decides. It is a
//! device setting, so it is kept in the settings file and comes back when
//! the app opens again.

use dr_i18n::{I18n, Locale, Platform};
use dr_shell::settings::{self, panel, registry};
use dr_shell::{Services, Settings, SettingsFile, ShellInfo};
use dr_ui::{Theme, ThemeSettings};
use gpui::{Context, IntoElement, Render, TestAppContext, Window, div};
use serde_json::{Value, json};

struct Probe;

impl Render for Probe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

fn init(file: SettingsFile, cx: &mut TestAppContext) {
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services::default(),
            file,
            cx,
        );
    });
}

#[test]
fn the_switch_forces_motion_off_or_hands_it_back_to_the_system() {
    assert_eq!(settings::reduce_motion(Some(true)), Some(true));
    assert_eq!(
        settings::reduce_motion(Some(false)),
        None,
        "off follows the system, it does not force motion on"
    );
    assert_eq!(settings::reduce_motion(None), None);

    let def = registry::find(registry::REDUCE_MOTION).unwrap();
    assert_eq!(def.kind, registry::Kind::Switch);
    assert_eq!(def.default_value(), Value::Bool(false));
    assert_eq!(def.scope, registry::Scope::Device);
    assert_eq!(def.section, registry::Section::Appearance);
    assert_eq!(def.description, None);
    // Right below 界面字号 in 外观.
    let keys: Vec<_> = registry::in_section(registry::Section::Appearance)
        .map(|d| d.key)
        .collect();
    let at = keys.iter().position(|k| *k == registry::TEXT_SIZE).unwrap();
    assert_eq!(keys.get(at + 1), Some(&registry::REDUCE_MOTION));
}

#[test]
fn the_search_finds_the_switch_by_its_name_and_its_other_words() {
    let zh = I18n::new(Locale::ZhCn, Platform::Mac);
    assert_eq!(zh.t(def_label()), "关闭动态效果");
    for query in ["动态效果", "reduce motion"] {
        assert_eq!(
            panel::search(query, &zh),
            vec![(
                registry::Section::Appearance,
                Some(vec![registry::REDUCE_MOTION])
            )],
            "{query}"
        );
    }
    assert_eq!(
        panel::search("动画", &zh),
        vec![(
            registry::Section::Appearance,
            Some(vec![
                registry::REDUCE_MOTION,
                registry::AGENT_EDIT_REVEAL_ANIMATION,
            ])
        )],
        "动画 matches both reduce_motion and agent_edit_reveal_animation"
    );
    let en = I18n::new(Locale::En, Platform::Mac);
    assert_eq!(en.t(def_label()), "Turn off animations");
}

fn def_label() -> dr_i18n::Key {
    registry::find(registry::REDUCE_MOTION).unwrap().label
}

#[gpui::test]
fn the_theme_follows_the_switch_and_the_switch_survives_a_restart(
    cx: &mut TestAppContext,
    again: &mut TestAppContext,
) {
    let dir = tempfile::tempdir().unwrap();
    init(SettingsFile::open(dir.path()), cx);
    let (_, cx) = cx.add_window_view(|_, _| Probe);
    let system = cx.update(|_, cx| cx.reduce_motion());
    let reduced = |cx: &mut gpui::VisualTestContext| {
        cx.update(|window, cx| Theme::of(window, cx).reduce_motion)
    };
    let forced = |cx: &mut gpui::VisualTestContext| {
        cx.update(|_, cx| cx.global::<ThemeSettings>().reduce_motion)
    };

    // Off by default: the system decides.
    assert_eq!(forced(cx), None);
    assert_eq!(reduced(cx), system);

    cx.update(|_, cx| {
        Settings::update(cx, |f| f.set(registry::REDUCE_MOTION, json!(true), None)).unwrap();
    });
    assert_eq!(forced(cx), Some(true));
    assert!(reduced(cx), "on: nothing moves");

    cx.update(|_, cx| {
        Settings::update(cx, |f| f.set(registry::REDUCE_MOTION, json!(false), None)).unwrap();
    });
    assert_eq!(forced(cx), None, "off hands the choice back to the system");
    assert_eq!(reduced(cx), system);

    cx.update(|_, cx| {
        Settings::update(cx, |f| f.set(registry::REDUCE_MOTION, json!(true), None)).unwrap();
        Settings::flush(cx);
    });
    let raw: Value = serde_json::from_slice(
        &std::fs::read(dir.path().join(dr_shell::settings::store::FILE_NAME)).unwrap(),
    )
    .unwrap();
    assert_eq!(
        raw["device"][registry::REDUCE_MOTION],
        true,
        "kept for this device only"
    );
    assert!(raw["account"].get(registry::REDUCE_MOTION).is_none());

    // The app opens again over the same settings file.
    init(SettingsFile::open(dir.path()), again);
    let (_, again) = again.add_window_view(|_, _| Probe);
    assert_eq!(forced(again), Some(true));
    assert!(reduced(again));
}
