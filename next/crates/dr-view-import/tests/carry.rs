//! What the 0.1 library kept for this device, once its import is the open
//! library (`m10-import.md` 「0.1 的设置、快捷键和工作记忆（2026-11-21）」):
//! through the real dialog, on the synthetic 0.1 library with synthetic
//! device state.
#[path = "../../dr-import-v1/tests/common/mod.rs"]
mod common;

use std::time::{Duration, Instant};

use common::device_state;
use dr_i18n::Locale;
use dr_shell::settings::registry::*;
use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace};
use dr_view_import::{LegacyImport, State};
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

const VERSION: &str = "0.2.0-dev";

fn library() -> (tempfile::TempDir, dr_workspace::Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let mut opts = dr_workspace::library_options(VERSION);
    opts.device = Some(dr_store::Device::open(dir.path()).unwrap());
    let lib = dr_store::Library::open(dir.path().join("library"), opts).unwrap();
    let ws = dr_workspace::Workspace::open(lib, Default::default()).unwrap();
    (dir, ws)
}

fn setup(
    cx: &mut TestAppContext,
    lib: dr_workspace::Workspace,
    settings: SettingsFile,
) -> (Entity<Workspace>, &mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib),
                ..Default::default()
            },
            settings,
            cx,
        );
        dr_view_shelf::init(cx);
        dr_view_import::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    (view, cx)
}

fn importer(cx: &mut VisualTestContext) -> Entity<LegacyImport> {
    cx.update(|_, cx| dr_view_import::importer(cx).unwrap())
}

fn state(cx: &mut VisualTestContext) -> State {
    importer(cx).read_with(cx, |i, _| i.state().clone())
}

fn settled(cx: &mut VisualTestContext) -> State {
    let until = Instant::now() + Duration::from_secs(40);
    loop {
        cx.run_until_parked();
        let now = state(cx);
        if !matches!(
            now,
            State::Running(_) | State::Switching(_) | State::Picking
        ) {
            return now;
        }
        assert!(Instant::now() < until, "timed out: {now:?}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn get(cx: &mut VisualTestContext, key: &str) -> Value {
    cx.update(|_, cx| Settings::read(cx).get(key))
}

#[gpui::test]
fn the_01_settings_shortcuts_and_working_memory_come_over_once(cx: &mut TestAppContext) {
    let (_dir, lib) = library();
    // Set here before the import: the font size by the author, the line
    // height by the account's preference sync.
    let mut file = SettingsFile::in_memory();
    file.set(FONT_SIZE, json!(22), None).unwrap();
    file.set_device_memory(
        dr_view_account::PREFERENCE_LEDGER_MEMORY_KEY,
        Some(json!({
            "ledger": {"account_id": "u-1", "entries": {
                LINE_HEIGHT: {"changed_at": "2026-11-01T08:00:00.000Z", "pending": false}
            }},
            "baseline": {}
        })),
    );
    let (_view, cx) = setup(cx, lib, file);

    // A language other than the system's, so it is a choice.
    let locale = if Locale::from_system() == Locale::Ko {
        "fr"
    } else {
        "ko"
    };
    let mut settings = device_state::settings();
    settings["uiLocale"] = json!(locale);
    let old = common::build_v3(true);
    device_state::add(
        &old,
        &settings,
        &device_state::shortcuts(),
        false,
        Some(device_state::WORKING_MEMORY),
    );
    let i = importer(cx);
    let source = old.root.clone();
    cx.update(|w, cx| i.update(cx, |i, cx| i.start(source, w, cx)));
    assert!(matches!(state(cx), State::Ready(_)));
    let target = importer(cx).read_with(cx, |i, _| i.destination().unwrap().target());
    cx.update(|w, cx| i.update(cx, |i, cx| i.start_configured(w, cx)));
    let State::Done(done) = settled(cx) else {
        panic!("{:?}", state(cx))
    };
    assert_eq!(done.books[0].status, "imported");
    let active = cx.update(|_, cx| cx.global::<Services>().library.clone().unwrap());
    assert_eq!(active.library().paths().root, target);

    // Each mapped setting the author had changed in 0.1.
    for (key, value) in [
        (THEME, json!("dark")),
        (TEXT_SIZE, json!("large")),
        (UI_LOCALE, json!(locale)),
        (PARAGRAPH_INDENT, json!("two")),
        (PAGE_WIDTH, json!(880.0)),
        (AUTO_IMMERSIVE, json!(true)),
        (TYPEWRITER, json!(true)),
        (TYPEWRITER_POSITION, json!(40.0)),
        (AUTO_ENTITY_LINKS, json!(false)),
        (AGENT_MAX_MODEL_ROUNDS, Value::Null),
        (CRASH_REPORTS, json!(false)),
        (AGENT_PROACTIVE, json!(false)),
    ] {
        assert_eq!(get(cx, key), value, "{key}");
    }
    // Out of range here: clamped. Set here: kept.
    assert_eq!(get(cx, PARAGRAPH_SPACING), json!(2.5));
    assert_eq!(get(cx, FONT_SIZE), json!(22.0));
    assert_eq!(get(cx, LINE_HEIGHT), json!(1.5));
    // No equivalent: left as this client has it.
    assert_eq!(get(cx, AGENT_PROVIDER), json!("deepseek"));
    // Shortcuts: the swapped pair and a new chord; ⌘, is the settings'.
    let bindings = cx.update(|_, cx| Settings::read(cx).key_bindings());
    assert_eq!(bindings["goBack"], "secondary-]");
    assert_eq!(bindings["goForward"], "secondary-[");
    assert_eq!(bindings["toggleBottomTimeline"], "shift-secondary-j");
    assert_eq!(bindings.len(), 3);
    assert_eq!(
        cx.update(|_, cx| Settings::device_memory(cx, dr_view_import::carry::ADOPTED)),
        Some(json!(true))
    );

    // The book's working memory.
    let book = dr_model::id::BookId::parse(common::BOOK).unwrap();
    let memory = dr_agent::memory::load(active.library(), &book).unwrap();
    assert_eq!(memory.content_md, device_state::WORKING_MEMORY);

    // Recorded beside the receipt, the losses too.
    let rows = dr_import_v1::carry::rows(&target).unwrap();
    let outcome = |kind: &str, key: &str| {
        rows.iter()
            .find(|r| r.kind == kind && r.old_key == key)
            .map(|r| r.outcome.clone())
            .unwrap_or_else(|| panic!("no row for {key}"))
    };
    let s = |field: &str| format!("settings-storage.{field}");
    assert_eq!(outcome("setting", &s("themeMode")), "adopted");
    assert_eq!(outcome("setting", &s("paragraphSpacing")), "clamped");
    assert_eq!(outcome("setting", &s("bodyFontSize")), "kept-here");
    assert_eq!(outcome("setting", &s("lineHeight")), "kept-here");
    assert_eq!(outcome("setting", &s("agentProvider")), "no-equivalent");
    assert_eq!(outcome("setting", &s("accentColor")), "no-equivalent");
    assert_eq!(outcome("setting", &s("caretColor")), "default");
    assert_eq!(outcome("setting", "project-checkin.enabled"), "adopted");
    assert_eq!(outcome("shortcut", "findInEditor"), "conflict");
    assert_eq!(outcome("shortcut", "saveCurrentEditor"), "no-equivalent");
    assert_eq!(outcome("shortcut", "closeActiveTab"), "default");
    assert_eq!(outcome("working-memory", common::BOOK), "adopted");
    let summary = std::fs::read_to_string(
        dr_import_v1::receipt::directory(&target).join(dr_import_v1::receipt::SUMMARY),
    )
    .unwrap();
    assert!(summary.starts_with("# 旧书导入摘要"));
    for line in [
        "- 带过来的设置：",
        "- 超出新版范围、已收进范围的设置：`settings-storage.paragraphSpacing`",
        "- 新版里已经设过、没有改的设置：",
        "- 新版没有对应、没有带过来的设置：",
        "- 带过来的快捷键：",
        "- 和新版别的命令冲突、保留默认的快捷键：`findInEditor`",
        "- 新版没有这个命令的快捷键：`saveCurrentEditor`",
        "- 带过来的工作记忆：《阿Q正传》",
    ] {
        assert!(summary.contains(line), "{line}\n{summary}");
    }

    // Once per device: changed here afterwards, taking over again changes
    // nothing and records nothing more.
    cx.update(|_, cx| {
        Settings::update(cx, |file| file.set(THEME, json!("light"), None).unwrap());
        dr_view_import::carry::adopt_settings(&target, cx);
    });
    assert_eq!(get(cx, THEME), json!("light"));
    assert_eq!(dr_import_v1::carry::rows(&target).unwrap(), rows);
}

/// A 0.1 library whose hand-over captured no settings (an older stamp, or
/// none) takes nothing over and leaves it to a later import.
#[gpui::test]
fn without_captured_settings_nothing_is_taken_over_and_a_later_import_may(cx: &mut TestAppContext) {
    let (_dir, lib) = library();
    let (_view, cx) = setup(cx, lib, SettingsFile::in_memory());
    let old = common::build_v3(false);
    let i = importer(cx);
    let source = old.root.clone();
    cx.update(|w, cx| i.update(cx, |i, cx| i.start(source, w, cx)));
    let target = importer(cx).read_with(cx, |i, _| i.destination().unwrap().target());
    cx.update(|w, cx| i.update(cx, |i, cx| i.start_configured(w, cx)));
    let State::Blocked(_) = settled(cx) else {
        panic!("{:?}", state(cx))
    };
    cx.update(|w, cx| i.update(cx, |i, cx| i.import_anyway(w, cx)));
    let State::Done(_) = settled(cx) else {
        panic!("{:?}", state(cx))
    };
    assert_eq!(get(cx, THEME), json!("system"));
    assert_eq!(
        cx.update(|_, cx| Settings::device_memory(cx, dr_view_import::carry::ADOPTED)),
        None
    );
    assert!(dr_import_v1::carry::rows(&target).unwrap().is_empty());
}
