//! Shared template-prose replacement and concurrent merge contracts on canonical modules.
mod common;
use common::*;
use dr_workspace::Actor;
use serde_json::{Value, json};
fn paragraphs(e: &Env, b: &str) -> Value {
    let result = Value::Array(
        e.out(
            "module.read_prose",
            json!({"book":b,"owner":"tpl-character","module":"mod-prose","template":true}),
        )["paragraphs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                let mut row = json!({"text":p["text"]});
                if p["heading"].as_u64().is_some_and(|n| n > 0) {
                    row["heading"] = p["heading"].clone();
                }
                row
            })
            .collect(),
    );
    if result == json!([{"text":""}]) {
        json!([])
    } else {
        result
    }
}

#[test]
fn set_body_keeps_empty_headings_next_to_what_changed() {
    let e = env();
    let b = e.book();
    let set = |body: Value| {
        e.call(
            "module.set_prose",
            json!({"book": b, "owner":"tpl-character", "module":"mod-prose", "template":true, "paragraphs": body}),
        );
        paragraphs(&e, &b)
    };
    // Every way round: append after, insert before, replace between,
    // delete at the end, empty headings at the edges.
    // (A lone empty paragraph, heading or not, is no template.)
    for body in [
        json!([{"heading": 1, "text": ""}, {"text": "一"}]),
        json!([{"heading": 1, "text": ""}, {"text": "一"}, {"heading": 2, "text": ""}]),
        json!([{"text": "零"}, {"heading": 1, "text": ""}, {"text": "一"}, {"heading": 2, "text": ""}]),
        json!([{"text": "零"}, {"heading": 3, "text": "中"}, {"heading": 2, "text": ""}]),
        json!([{"text": "零"}]),
        json!([{"heading": 2, "text": ""}, {"text": "零"}]),
        json!([]),
        json!([{"text": "末"}]),
    ] {
        assert_eq!(set(body.clone()), body);
    }
}

#[test]
fn two_devices_changing_one_template_merge() {
    use loro::ExportMode;
    let a = env();
    let z = env();
    let b = a.book();
    let sync = |from: &Env, to: &Env| {
        for d in from.ws().library().docs(None, None).unwrap() {
            let Ok(copy) = from.ws().library().load_copy(&d.doc_id) else {
                continue;
            };
            let bytes = copy.export(ExportMode::all_updates()).unwrap();
            let book = d.book_id.clone().unwrap_or_default();
            to.ws()
                .import_remote(&d.doc_id, Some((&d.kind, &book)), bytes, &Actor::Sync)
                .unwrap();
        }
    };
    let set = |e: &Env, body: Value| {
        e.call(
            "module.set_prose",
            json!({"book": b, "owner":"tpl-character", "module":"mod-prose", "template":true, "paragraphs": body}),
        );
    };
    set(
        &a,
        json!([{"heading": 1, "text": "外貌"}, {"text": "一句"}, {"heading": 1, "text": "经历"}]),
    );
    sync(&a, &z);
    // A rewrites the middle, Z adds a paragraph at the end, offline.
    set(
        &a,
        json!([{"heading": 1, "text": "外貌"}, {"text": "两句"}, {"heading": 1, "text": "经历"}]),
    );
    set(
        &z,
        json!([{"heading": 1, "text": "外貌"}, {"text": "一句"}, {"heading": 1, "text": "经历"}, {"text": "生于雨季"}]),
    );
    sync(&a, &z);
    sync(&z, &a);
    let want = json!([
        {"heading": 1, "text": "外貌"}, {"text": "两句"},
        {"heading": 1, "text": "经历"}, {"text": "生于雨季"},
    ]);
    for dev in [&a, &z] {
        assert_eq!(paragraphs(dev, &b), want);
    }
}
