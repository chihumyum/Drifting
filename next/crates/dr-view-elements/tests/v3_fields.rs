//! V3 typed fields: synthetic seed, real controls, stale refresh and validation.
use dr_shell::{
    Services, SettingsFile, ShellInfo, book::Book, pages::PageViewHost, v3::ModuleHost,
};
use dr_view_elements::fields::v3::{TypedFields, option_label, parse};
use dr_workspace::{
    Actor, Workspace,
    commands::v3::types::{FieldDef, FieldValue},
};
use gpui::{
    EntityInputHandler, Focusable, TestAppContext, VisualTestContext, WeakEntity, px, size,
};
use serde_json::{Value, json};
use std::{
    rc::Rc,
    time::{Duration, Instant},
};
fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn def(kind: &str) -> FieldDef {
    serde_json::from_value(json!({"id":kind,"name":kind,"field_type":kind})).unwrap()
}
#[test]
fn input_conversion_rejects_invalid_numbers_and_dates_and_keeps_alias_punctuation() {
    assert_eq!(
        parse(&def("number"), "1.25"),
        Some(FieldValue::Number(1.25))
    );
    for text in ["NaN", "inf", "-inf", "1e900", "text"] {
        assert_eq!(parse(&def("number"), text), None);
    }
    assert_eq!(parse(&def("date"), "2026-02-30"), None);
    assert_eq!(
        parse(&def("date"), "2024-02-29"),
        Some(FieldValue::Text("2024-02-29".into()))
    );
    assert_eq!(
        parse(&def("aliases"), " A, B\n A, B \nC\n"),
        Some(FieldValue::List(vec!["A, B".into(), "C".into()]))
    );
    assert_eq!(
        parse(&def("long_text"), "line\nline"),
        Some(FieldValue::Text("line\nline".into()))
    );
    assert_eq!(parse(&def("text"), ""), Some(FieldValue::Null));
}
fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|w, cx| {
        w.simulate_next_frame(cx);
        w.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}
#[gpui::test]
fn draft_survives_refresh_and_invalid_input_stays_editable(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let id = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "test").unwrap();
    let entries = call(&ws, "entry.list", json!({"book":id,"all":true}));
    let entry = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let module = json!({"id":"all-fields","name":"Fields","kind":"fields","config":{"defs":[def("text"),def("number"),def("date"),def("aliases")]}});
    call(
        &ws,
        "entry_template.put_module",
        json!({"book":id,"template":"tpl-chapter","module":module}),
    );
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(dr_ui::Appearance::Light),
            },
            Services::default(),
            SettingsFile::in_memory(),
            cx,
        )
    });
    let old = Rc::new(Book::load(&ws, &id).unwrap());
    let host = ModuleHost {
        page: PageViewHost {
            workspace: WeakEntity::new_invalid(),
            library: ws.clone(),
            book_id: id.clone(),
            book: old.clone(),
        },
        entry: entry.clone(),
        module: serde_json::from_value(module).unwrap(),
    };
    let window = cx.add_window(|w, cx| TypedFields::new(host, w, cx));
    let view = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|w, _| w.activate_window());
    vcx.simulate_resize(size(px(1000.), px(800.)));
    draw(&mut vcx);
    let field = view.read_with(&vcx, |v, _| v.input("number").unwrap());
    field.update_in(&mut vcx, |f, w, cx| {
        f.focus_handle(cx).focus(w, cx);
        f.replace_text_in_range(None, "invalid", w, cx);
    });
    view.update(&mut vcx, |v, cx| v.refresh(old.clone(), cx));
    draw(&mut vcx);
    assert_eq!(field.read_with(&vcx, |f, _| f.text()), "invalid");
    vcx.update(|w, cx| w.blur(cx));
    draw(&mut vcx);
    assert!(!view.read_with(&vcx, |v, _| v.is_settled()));
    assert_eq!(field.read_with(&vcx, |f, _| f.text()), "invalid");
    field.update_in(&mut vcx, |f, w, cx| {
        f.focus_handle(cx).focus(w, cx);
        f.select_all_text(cx);
        f.replace_text_in_range(None, "42", w, cx);
    });
    vcx.update(|w, cx| w.blur(cx));
    draw(&mut vcx);
    // An old snapshot while the command is settling must not erase the edit.
    view.update(&mut vcx, |v, cx| v.refresh(old, cx));
    draw(&mut vcx);
    assert_eq!(field.read_with(&vcx, |f, _| f.text()), "42");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(&mut vcx);
        let book = Rc::new(Book::load(&ws, &id).unwrap());
        view.update(&mut vcx, |v, cx| v.refresh(book, cx));
        if view.read_with(&vcx, |v, _| v.is_settled()) {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        call(
            &ws,
            "module.read",
            json!({"book":id,"entry":entry,"module":"all-fields"})
        )["fields"]["number"],
        42.0
    );
    assert_eq!(field.read_with(&vcx, |f, _| f.text()), "42");

    call(
        &ws,
        "module.set_field",
        json!({"book":id,"entry":entry,"module":"all-fields","field":"number","value":43.0}),
    );
    let current = Rc::new(Book::load(&ws, &id).unwrap());
    view.update(&mut vcx, |v, cx| v.refresh(current, cx));
    draw(&mut vcx);
    assert_eq!(
        field.read_with(&vcx, |f, _| f.text()),
        "43",
        "a confirmed save must not hide a later external value"
    );
}

#[gpui::test]
fn builtin_enum_options_localize_display_labels_without_changing_stored_values(
    cx: &mut TestAppContext,
) {
    use dr_i18n::Locale;
    cx.executor().allow_parking();
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open(
        dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap(),
        Default::default(),
    )
    .unwrap();
    let id = call(&ws, "project.create", json!({"name": "枚举本地化"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let idea = dr_testkit::seed::acceptance::novel_entry(&ws, &id, "tpl-idea", "夜航", None)["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let module = json!({
        "id": "mod-multi",
        "name": "多选状态",
        "kind": "fields",
        "config": {
            "defs": [
                {
                    "id": "status_select",
                    "name": "状态单选",
                    "field_type": "select",
                    "options": ["draft", "finished", "discarded", "drifting", "resting", "custom-opt"]
                },
                {
                    "id": "tags",
                    "name": "状态多选",
                    "field_type": "multi_select",
                    "options": ["drifting", "resting", "custom-opt"]
                }
            ]
        }
    });
    call(
        &ws,
        "entry_template.put_module",
        json!({"book": id, "template": "tpl-idea", "module": module}),
    );

    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(dr_ui::Appearance::Light),
            },
            Services::default(),
            SettingsFile::in_memory(),
            cx,
        );
        for locale in Locale::ALL {
            dr_shell::Strings::install(locale, cx);
            for raw in ["draft", "finished", "discarded", "drifting", "resting"] {
                let label = option_label(raw, cx);
                assert!(!label.is_empty(), "{locale:?} {raw}");
                if locale != Locale::En {
                    assert_ne!(label.as_ref(), raw, "{locale:?} should localize {raw}");
                }
            }
            assert_eq!(option_label("custom-opt", cx).as_ref(), "custom-opt");
        }
        dr_shell::Strings::install(Locale::En, cx);
        assert_eq!(option_label("draft", cx).as_ref(), "Draft");
        assert_eq!(option_label("finished", cx).as_ref(), "Finished");
        assert_eq!(option_label("discarded", cx).as_ref(), "Discarded");
        assert_eq!(option_label("drifting", cx).as_ref(), "Floating");
        assert_eq!(option_label("resting", cx).as_ref(), "Resting");

        dr_shell::Strings::install(Locale::Ja, cx);
        assert_eq!(option_label("draft", cx).as_ref(), "下書き");
        assert_eq!(option_label("finished", cx).as_ref(), "完成");
        assert_eq!(option_label("discarded", cx).as_ref(), "不採用");
        assert_eq!(option_label("drifting", cx).as_ref(), "漂流中");
        assert_eq!(option_label("resting", cx).as_ref(), "停泊中");

        dr_shell::Strings::install(Locale::ZhCn, cx);
        assert_eq!(option_label("draft", cx).as_ref(), "草稿");
        assert_eq!(option_label("finished", cx).as_ref(), "已完成");
        assert_eq!(option_label("discarded", cx).as_ref(), "已弃用");
        assert_eq!(option_label("drifting", cx).as_ref(), "漂浮中");
        assert_eq!(option_label("resting", cx).as_ref(), "休眠");
    });

    let book = Rc::new(Book::load(&ws, &id).unwrap());
    let host = ModuleHost {
        page: PageViewHost {
            workspace: WeakEntity::new_invalid(),
            library: ws.clone(),
            book_id: id.clone(),
            book,
        },
        entry: idea.clone(),
        module: serde_json::from_value(module).unwrap(),
    };
    let window = cx.add_window(|w, cx| TypedFields::new(host, w, cx));
    let view = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|w, _| w.activate_window());
    vcx.simulate_resize(size(px(1000.), px(800.)));
    draw(&mut vcx);

    view.update(&mut vcx, |v, cx| {
        v.set("status_select", FieldValue::Text("finished".into()), cx);
        v.set("tags", FieldValue::List(vec!["drifting".into()]), cx);
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !view.read_with(&vcx, |v, _| v.is_settled()) {
        draw(&mut vcx);
        assert!(Instant::now() < deadline, "field save timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
    let stored = call(
        &ws,
        "module.read",
        json!({"book": id, "entry": idea, "module": "mod-multi"}),
    )["fields"]
        .clone();
    assert_eq!(stored["status_select"], "finished");
    assert_eq!(stored["tags"], json!(["drifting"]));
}
