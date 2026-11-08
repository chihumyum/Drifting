//! The story workshop's commands: plot grids (`plot_grid.*`), element
//! patches (`patch.*`) and field templates (`storyline_template.*`,
//! `category_template.*`), with the 0.1 interface's rules.

mod common;

use common::*;
use dr_workspace::{Actor, WsError};
use serde_json::{Value, json};

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

fn chapter(e: &Env, b: &str, title: &str, text: &str) -> String {
    id(&e.out(
        "chapter.create",
        json!({"book": b, "title": title, "text": text}),
    ))
}

fn grid(e: &Env, b: &str, node: &str) -> Value {
    e.out("plot_grid.get", json!({"book": b, "node": node}))
}

fn undo(e: &Env) {
    e.ws().undo(&Actor::User).unwrap().unwrap();
}

#[test]
fn a_plot_grid_starts_three_by_three_and_is_edited_by_id() {
    let e = env();
    let b = e.book();
    let c = chapter(&e, &b, "一", "");
    let g = grid(&e, &b, &c);
    assert_eq!(g["exists"], false);
    assert_eq!(
        (g["cell_w"].clone(), g["cell_h"].clone()),
        (json!(184.0), json!(96.0))
    );
    let g = e.out("plot_grid.create", json!({"book": b, "node": c}));
    assert_eq!(g["exists"], true);
    assert_eq!(g["rows"].as_array().unwrap().len(), 3);
    assert_eq!(g["columns"].as_array().unwrap().len(), 3);
    assert_eq!(
        field(&g["rows"], "label"),
        [json!(""), json!(""), json!("")]
    );
    // Creating again returns the same grid.
    assert_eq!(e.out("plot_grid.create", json!({"book": b, "node": c})), g);
    let rows: Vec<String> = ids(&g["rows"]);
    let cols: Vec<String> = ids(&g["columns"]);

    // A cell as typed; empty clears it; undo brings the text back.
    e.call(
        "plot_grid.cell",
        json!({"book": b, "node": c, "row": rows[0], "column": cols[1], "text": " 开场\n雨 "}),
    );
    let g = grid(&e, &b, &c);
    assert_eq!(
        g["cells"],
        json!([{"row": rows[0], "column": cols[1], "text": " 开场\n雨 "}])
    );
    e.call(
        "plot_grid.cell",
        json!({"book": b, "node": c, "row": rows[0], "column": cols[1], "text": ""}),
    );
    assert_eq!(grid(&e, &b, &c)["cells"], json!([]));
    undo(&e);
    assert_eq!(grid(&e, &b, &c)["cells"].as_array().unwrap().len(), 1);

    // Labels are kept as typed; a row goes first or after another.
    e.call(
        "plot_grid.line_update",
        json!({"book": b, "node": c, "axis": "row", "id": rows[1], "label": " 第二幕 "}),
    );
    let first = id(&e.out(
        "plot_grid.line_add",
        json!({"book": b, "node": c, "axis": "row", "label": "序"}),
    ));
    let after = id(&e.out(
        "plot_grid.line_add",
        json!({"book": b, "node": c, "axis": "row", "after": rows[0], "label": "插"}),
    ));
    let g = grid(&e, &b, &c);
    assert_eq!(
        ids(&g["rows"]),
        [
            first.clone(),
            rows[0].clone(),
            after.clone(),
            rows[1].clone(),
            rows[2].clone()
        ]
    );
    assert_eq!(g["rows"][3]["label"], " 第二幕 ");
    // Move a column first, then back by undo.
    e.call(
        "plot_grid.line_update",
        json!({"book": b, "node": c, "axis": "column", "id": cols[2], "after": null}),
    );
    assert_eq!(ids(&grid(&e, &b, &c)["columns"])[0], cols[2]);
    undo(&e);
    assert_eq!(ids(&grid(&e, &b, &c)["columns"]), cols);
    assert!(matches!(
        e.try_call(
            "plot_grid.line_update",
            json!({"book": b, "node": c, "axis": "column", "id": cols[0], "after": cols[0]})
        ),
        Err(WsError::Invalid(_))
    ));

    // Removing a row takes its cells; undo brings both back.
    e.call(
        "plot_grid.line_remove",
        json!({"book": b, "node": c, "axis": "row", "id": rows[0]}),
    );
    let g = grid(&e, &b, &c);
    assert!(!ids(&g["rows"]).contains(&rows[0]));
    assert_eq!(g["cells"], json!([]));
    undo(&e);
    let g = grid(&e, &b, &c);
    assert_eq!(ids(&g["rows"])[1], rows[0]);
    assert_eq!(g["cells"].as_array().unwrap().len(), 1);

    // The last column cannot go.
    for col in &cols[1..] {
        e.call(
            "plot_grid.line_remove",
            json!({"book": b, "node": c, "axis": "column", "id": col}),
        );
    }
    assert!(matches!(
        e.try_call(
            "plot_grid.line_remove",
            json!({"book": b, "node": c, "axis": "column", "id": cols[0]})
        ),
        Err(WsError::Invalid(_))
    ));
}

#[test]
fn a_plot_grid_has_its_ids_before_it_is_stored_and_two_devices_get_one() {
    use loro::ExportMode;
    let a = env();
    let z = env();
    let b = a.book();
    let c = chapter(&a, &b, "一", "");
    let sync = |from: &Env, to: &Env| {
        for d in from.ws().library().docs(None, None).unwrap() {
            // A chapter without text has nothing stored yet.
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
    sync(&a, &z);
    // Not stored, but its rows and columns have their ids already: the
    // first cell typed stores the grid.
    let g = grid(&a, &b, &c);
    assert_eq!(g["exists"], false);
    let (rows, cols) = (ids(&g["rows"]), ids(&g["columns"]));
    assert_eq!((rows.len(), cols.len()), (3, 3));
    assert_eq!(grid(&z, &b, &c), g, "the same ids on every device");
    a.call(
        "plot_grid.cell",
        json!({"book": b, "node": c, "row": rows[0], "column": cols[0], "text": "开场"}),
    );
    let stored = grid(&a, &b, &c);
    assert_eq!(stored["exists"], true);
    assert_eq!(ids(&stored["rows"]), rows);
    // The other device, offline, labels a row of its own default grid.
    z.call(
        "plot_grid.line_update",
        json!({"book": b, "node": c, "axis": "row", "id": rows[1], "label": "伏笔"}),
    );
    sync(&a, &z);
    sync(&z, &a);
    for dev in [&a, &z] {
        let g = grid(dev, &b, &c);
        assert_eq!(ids(&g["rows"]), rows, "one 3 × 3 grid");
        assert_eq!(ids(&g["columns"]), cols);
        assert_eq!(field(&g["rows"], "label")[1], "伏笔");
        assert_eq!(field(&g["cells"], "text"), [json!("开场")]);
    }
    // Clearing a grid never stored writes nothing.
    let other = chapter(&a, &b, "二", "");
    let o = a.call("plot_grid.clear", json!({"book": b, "node": other}));
    assert!(o["journal"].is_null());
    assert_eq!(grid(&a, &b, &other)["exists"], false);
}

#[test]
fn plot_grid_size_and_clear() {
    let e = env();
    let b = e.book();
    let idea = id(&e.out("idea.create", json!({"book": b, "title": "想法"})));
    // Ideas have plot grids too.
    let g = e.out("plot_grid.create", json!({"book": b, "node": idea}));
    let (r, c) = (ids(&g["rows"])[0].clone(), ids(&g["columns"])[0].clone());
    e.call(
        "plot_grid.size",
        json!({"book": b, "node": idea, "cell_w": 300.0, "cell_h": 120.0}),
    );
    assert_eq!(grid(&e, &b, &idea)["cell_w"], 300.0);
    assert!(matches!(
        e.try_call(
            "plot_grid.size",
            json!({"book": b, "node": idea, "cell_w": 500.0, "cell_h": 120.0})
        ),
        Err(WsError::Violation(_))
    ));
    e.call(
        "plot_grid.cell",
        json!({"book": b, "node": idea, "row": r, "column": c, "text": "x"}),
    );
    e.call(
        "plot_grid.line_update",
        json!({"book": b, "node": idea, "axis": "row", "id": r, "label": "行名"}),
    );
    // 清空: labels and cells go; rows, columns and size stay; undo restores.
    e.call("plot_grid.clear", json!({"book": b, "node": idea}));
    let g = grid(&e, &b, &idea);
    assert_eq!(g["cells"], json!([]));
    assert_eq!(g["rows"][0]["label"], "");
    assert_eq!(g["rows"].as_array().unwrap().len(), 3);
    assert_eq!(g["cell_w"], 300.0);
    undo(&e);
    let g = grid(&e, &b, &idea);
    assert_eq!(g["rows"][0]["label"], "行名");
    assert_eq!(g["cells"].as_array().unwrap().len(), 1);
    // Purging the idea takes its grid along.
    e.call("idea.trash", json!({"book": b, "id": idea}));
    e.call("idea.purge", json!({"book": b, "id": idea}));
    assert!(matches!(
        e.try_call("plot_grid.get", json!({"book": b, "node": idea})),
        Err(WsError::NotFound { .. })
    ));
}

#[test]
fn patches_follow_the_interface() {
    let e = env();
    let b = e.book();
    let anna = id(&e.out("element.create", json!({"book": b, "name": "安娜"})));
    let c1 = chapter(&e, &b, "一", "安娜来了。\n她带着伞。");
    let c2 = chapter(&e, &b, "二", "雨停了。");
    let blocks = e.out("prose.read", json!({"doc": format!("node:{c1}")}))["paragraphs"].clone();
    let blk = blocks[1]["block_id"].as_str().unwrap().to_string();

    // Floating and even empty (「+ 新建」); an empty title is none.
    let floating = id(&e.out(
        "patch.create",
        json!({"book": b, "element": anna, "title": ""}),
    ));
    // From a passage of chapter two, then one from chapter one.
    let late = id(&e.out(
        "patch.create",
        json!({"book": b, "element": anna, "title": "改名", "body": "从此叫安妮。",
               "source": c2, "source_text": "雨停了。"}),
    ));
    let early = id(&e.out(
        "patch.create",
        json!({"book": b, "element": anna, "body": "有一把伞。",
               "source": c1, "source_block": blk, "source_text": "她带着伞。"}),
    ));
    // A paragraph without its chapter is refused.
    assert!(matches!(
        e.try_call(
            "patch.create",
            json!({"book": b, "element": anna, "source_block": blk})
        ),
        Err(WsError::Violation(_))
    ));
    let list = e.out("patch.list", json!({"book": b, "element": anna}));
    // By the source chapter's reading order; floating last.
    assert_eq!(ids(&list), [early.clone(), late.clone(), floating.clone()]);
    assert_eq!(list[2]["title"], Value::Null);
    assert_eq!(list[0]["source_block"], json!(blk));

    // 改章节归属: the paragraph goes, the passage stays; undo puts it back.
    e.call(
        "patch.update",
        json!({"book": b, "id": early, "source": c2, "title": "伞"}),
    );
    let list = e.out("patch.list", json!({"book": b, "element": anna}));
    let p = list
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == early)
        .unwrap();
    assert_eq!(
        (
            p["source"].clone(),
            p["source_block"].clone(),
            p["source_text"].clone()
        ),
        (json!(c2), Value::Null, json!("她带着伞。"))
    );
    undo(&e);
    let list = e.out("patch.list", json!({"book": b, "element": anna}));
    let p = list
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == early)
        .unwrap();
    assert_eq!(
        (
            p["source"].clone(),
            p["source_block"].clone(),
            p["title"].clone()
        ),
        (json!(c1), json!(blk), Value::Null)
    );

    // 失效: the passage is gone, then back; only changes are written.
    let doc = format!("node:{c1}");
    e.call(
        "prose.replace",
        json!({"doc": doc, "find": "她带着伞。", "replace": "她空着手。"}),
    );
    let out = e.call("patch.check_sources", json!({"book": b, "node": c1}));
    assert_eq!(out["output"]["invalidated"], json!([early]));
    assert!(out["journal"].is_null(), "not an author's step");
    let list = e.out("patch.list", json!({"book": b, "element": anna}));
    let p = list
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == early)
        .unwrap();
    assert!(p["invalidated_at"].as_i64().is_some());
    let again = e.out("patch.check_sources", json!({"book": b, "node": c1}));
    assert_eq!(again["invalidated"], json!([]));
    e.call(
        "prose.replace",
        json!({"doc": doc, "find": "她空着手。", "replace": "她带着伞。"}),
    );
    let out = e.out("patch.check_sources", json!({"book": b, "node": c1}));
    assert_eq!(out["restored"], json!([early]));

    // Delete at once, even with a relation and a comment on it; undo brings
    // all three back.
    let t = id(&e.out(
        "relation_type.create",
        json!({"book": b, "name": "关于", "orientation": "symmetric",
               "source_kinds": ["element", "node", "patch"], "target_kinds": ["element", "node", "patch"]}),
    ));
    e.call(
        "relation.create",
        json!({"book": b, "from": {"kind": "patch", "id": late}, "to": {"kind": "node", "id": c1}, "relation_type": t}),
    );
    e.call(
        "comment.create",
        json!({"book": b, "target": {"kind": "patch", "id": late}, "body": "核对"}),
    );
    let out = e.call("patch.delete", json!({"book": b, "id": late}));
    let fx = effects(&out);
    assert!(fx.contains(&"purged patch".to_string()), "{fx:?}");
    assert!(
        e.out("relation.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    undo(&e);
    assert!(ids(&e.out("patch.list", json!({"book": b, "element": anna}))).contains(&late));
    assert_eq!(
        e.out("relation.list", json!({"book": b}))
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // Move among the element's patches.
    e.call(
        "patch.move",
        json!({"book": b, "id": floating, "place": "first"}),
    );
    undo(&e);
}

#[test]
fn templates_are_copied_on_create_and_never_after() {
    let e = env();
    let b = e.book();
    // The storyline template: neither part trimmed; repeats allowed.
    let f1 = id(&e.out(
        "storyline_template.put",
        json!({"book": b, "key": " 主题 ", "value": "一句话"}),
    ));
    e.call(
        "storyline_template.put",
        json!({"book": b, "key": "主题", "value": ""}),
    );
    assert!(matches!(
        e.try_call(
            "storyline_template.put",
            json!({"book": b, "key": " ", "value": ""})
        ),
        Err(WsError::Invalid(_))
    ));
    let s = id(&e.out("storyline.create", json!({"book": b, "name": "主线"})));
    let line = e.out("storyline.list", json!({"book": b}));
    let facts = &line
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == s)
        .unwrap()["fields"];
    assert_eq!(field(facts, "key"), [json!(" 主题 "), json!("主题")]);
    assert!(!ids(facts).contains(&f1), "copies get their own ids");
    // Changing the template leaves the storyline alone.
    e.call(
        "storyline_template.put",
        json!({"book": b, "id": f1, "key": "母题", "value": "x"}),
    );
    e.call("storyline_template.remove", json!({"book": b, "id": f1}));
    let line = e.out("storyline.list", json!({"book": b}));
    let facts = &line
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == s)
        .unwrap()["fields"];
    assert_eq!(facts.as_array().unwrap().len(), 2);
    // Undo of the removal brings the field back with its id.
    undo(&e);
    assert!(ids(&e.out("storyline_template.list", json!({"book": b}))).contains(&f1));

    // A category's template, copied into its new elements only.
    let cat = id(&e.out("category.create", json!({"book": b, "name": "人物"})));
    e.call(
        "category_template.put",
        json!({"book": b, "category": cat, "key": "年龄", "value": ""}),
    );
    e.call(
        "category_template.put",
        json!({"book": b, "category": cat, "key": "口头禅", "value": "（提示）", "place": "first"}),
    );
    let tpl = e.out(
        "category_template.list",
        json!({"book": b, "category": cat}),
    );
    assert_eq!(field(&tpl, "key"), [json!("口头禅"), json!("年龄")]);
    // Remove one and undo: it comes back with its id and place.
    let first = ids(&tpl)[0].clone();
    e.call(
        "category_template.remove",
        json!({"book": b, "category": cat, "id": first}),
    );
    assert_eq!(
        e.out(
            "category_template.list",
            json!({"book": b, "category": cat})
        )
        .as_array()
        .unwrap()
        .len(),
        1
    );
    undo(&e);
    assert_eq!(
        ids(&e.out(
            "category_template.list",
            json!({"book": b, "category": cat})
        )),
        ids(&tpl)
    );
    let anna = id(&e.out(
        "element.create",
        json!({"book": b, "name": "安娜", "category": cat}),
    ));
    let bea = id(&e.out("element.create", json!({"book": b, "name": "贝雅"})));
    let els = e.out("element.list", json!({"book": b}));
    let fields_of = |id: &str| {
        els.as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == id)
            .unwrap()["fields"]
            .clone()
    };
    assert_eq!(
        field(&fields_of(&anna), "key"),
        [json!("口头禅"), json!("年龄")]
    );
    assert_eq!(
        field(&fields_of(&anna), "value"),
        [json!("（提示）"), json!("")]
    );
    assert!(fields_of(&bea).as_array().unwrap().is_empty());
    // Moving an element into the category does not apply the template.
    e.call(
        "element.update",
        json!({"book": b, "id": bea, "category": cat}),
    );
    let els = e.out("element.list", json!({"book": b}));
    let bea_fields = &els
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == bea)
        .unwrap()["fields"];
    assert!(bea_fields.as_array().unwrap().is_empty());
}

#[test]
fn a_categorys_element_template_seeds_new_elements() {
    let e = env();
    let b = e.book();
    let cat = id(&e.out("category.create", json!({"book": b, "name": "人物"})));
    let body = json!([
        {"heading": 1, "text": "外貌"},
        {"text": "（写一两句）"},
        {"heading": 2, "text": "经历"},
    ]);
    e.call(
        "category_template.set_body",
        json!({"book": b, "category": cat, "paragraphs": body}),
    );
    assert_eq!(
        e.out(
            "category_template.body",
            json!({"book": b, "category": cat})
        ),
        body
    );
    let cats = e.out("category.list", json!({"book": b}));
    assert_eq!(cats[0]["has_element_template"], true);
    // A new element of the category starts with it, headings and all.
    let anna = id(&e.out(
        "element.create",
        json!({"book": b, "name": "安娜", "category": cat}),
    ));
    let p = e.out("prose.read", json!({"doc": format!("element:{anna}")}))["paragraphs"].clone();
    assert_eq!(
        field(&p, "text"),
        [json!("外貌"), json!("（写一两句）"), json!("经历")]
    );
    assert_eq!(field(&p, "heading"), [json!(1), json!(0), json!(2)]);
    // Text of its own wins; no category, no template.
    let bea = id(&e.out(
        "element.create",
        json!({"book": b, "name": "贝雅", "category": cat, "text": "自己的"}),
    ));
    let p = e.out("prose.read", json!({"doc": format!("element:{bea}")}))["paragraphs"].clone();
    assert_eq!(field(&p, "text"), [json!("自己的")]);
    // Empty removes it; undo brings it back.
    e.call(
        "category_template.set_body",
        json!({"book": b, "category": cat, "paragraphs": []}),
    );
    assert_eq!(
        e.out("category.list", json!({"book": b}))[0]["has_element_template"],
        false
    );
    undo(&e);
    assert_eq!(
        e.out(
            "category_template.body",
            json!({"book": b, "category": cat})
        ),
        body
    );
    assert!(matches!(
        e.try_call(
            "category_template.set_body",
            json!({"book": b, "category": cat, "paragraphs": [{"heading": 4, "text": "x"}]})
        ),
        Err(WsError::Invalid(_))
    ));
}

#[test]
fn a_01_element_template_reads_as_paragraphs() {
    use dr_workspace::commands::template::{TemplateParagraph, body_json, body_of};
    // As the 0.1 template editor stored it: headings, paragraphs, a quote,
    // a hard break, a rule.
    let old = r#"{"type":"doc","content":[
        {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"身世"}]},
        {"type":"paragraph","content":[{"type":"text","text":"生于"},{"type":"hardBreak"},{"type":"text","marks":[{"type":"bold"}],"text":"雨季"}]},
        {"type":"horizontalRule"},
        {"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"引"}]}]},
        {"type":"paragraph"}
    ]}"#;
    let p = |h: Option<u8>, t: &str| TemplateParagraph {
        heading: h,
        text: t.into(),
    };
    let want = vec![
        p(Some(2), "身世"),
        p(None, "生于 雨季"),
        p(None, "引"),
        p(None, ""),
    ];
    assert_eq!(body_of(Some(old)), want);
    assert_eq!(body_of(Some(&body_json(&want))), want);
    assert!(body_of(Some("{}")).is_empty());
    assert!(body_of(Some("not json")).is_empty());
    assert!(body_of(None).is_empty());
}

#[test]
fn books_carry_their_creation_and_elements_their_references() {
    let e = env();
    let b = e.book();
    let info = e.out("book.get", json!({"book": b}));
    assert!(info["created_at"].as_i64().is_some());
    assert_eq!(
        e.out("book.list", json!({}))[0]["created_at"],
        info["created_at"]
    );
    // Who mentions an element and whom it mentions: `mention.list`.
    let anna = id(&e.out("element.create", json!({"book": b, "name": "安娜"})));
    let bea = id(&e.out(
        "element.create",
        json!({"book": b, "name": "贝雅", "text": "她认识安娜。"}),
    ));
    let agent = Actor::agent("s", 1, "c");
    let c = dr_workspace::Workspace::call(
        e.ws(),
        &agent,
        "chapter.create",
        json!({"book": b, "title": "一", "text": "安娜和贝雅，还是安娜。"}),
    )
    .unwrap()["output"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    // The author links 安娜 in 贝雅's body by hand.
    let doc = format!("element:{bea}");
    let s = e.ws().prose_session(&doc).unwrap();
    let a2 = anna.clone();
    s.edit(move |t| {
        t.link_entity(
            3..5,
            &dr_model::prose::EntityLink {
                target: a2,
                kind: dr_model::kind::EntityKind::Element,
                block: None,
                end_block: None,
            },
        )
    })
    .unwrap();
    drop(s);
    for d in e.ws().library().docs(Some(&b), None).unwrap() {
        e.ws().library().reindex_doc(&d.doc_id).unwrap();
    }
    let into = e.out(
        "mention.list",
        json!({"book": b, "to": {"kind": "element", "id": anna}}),
    );
    let from: Vec<(String, u64)> = into
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["from"]["id"].as_str().unwrap().to_string(),
                m["count"].as_u64().unwrap(),
            )
        })
        .collect();
    let mut want = vec![(c.clone(), 2), (bea.clone(), 1)];
    want.sort();
    let mut from = from;
    from.sort();
    assert_eq!(from, want);
    let out = e.out(
        "mention.list",
        json!({"book": b, "from": {"kind": "element", "id": bea}}),
    );
    assert_eq!(out[0]["to"]["id"], json!(anna));
}

/// The entity links of `doc` as (linked text, target id).
fn links_of(e: &Env, doc: &str) -> Vec<(String, String)> {
    let s = e.ws().prose_session(doc).unwrap();
    let r = s.reader();
    let v = r.view();
    let text: Vec<char> = v.plain_text().chars().collect();
    v.entity_links()
        .into_iter()
        .map(|(range, l)| (text[range].iter().collect(), l.target))
        .collect()
}

fn paragraphs(e: &Env, doc: &str) -> Value {
    e.out("prose.read", json!({"doc": doc}))["paragraphs"].clone()
}

#[test]
fn a_template_is_a_page_of_its_own_copied_whole_into_new_pages() {
    use dr_model::kind::EntityKind;
    use dr_model::prose::{EntityLink, Heading, InlineStyle};
    let e = env();
    let b = e.book();
    let cat = id(&e.out("category.create", json!({"book": b, "name": "人物"})));
    let anna = id(&e.out("element.create", json!({"book": b, "name": "安娜"})));
    let doc = e.out(
        "category_template.document",
        json!({"book": b, "category": cat}),
    )["doc"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(doc, format!("template:category:{cat}"));
    assert_eq!(
        e.out("category.list", json!({"book": b}))[0]["has_element_template"],
        false,
        "a blank template is no template"
    );
    // The author writes the template in an editor: a heading, bold, a link.
    let s = e.ws().prose_session(&doc).unwrap();
    let target = anna.clone();
    s.edit(move |t| {
        t.insert_paragraphs(0, "外貌\n安娜的姐姐")?;
        t.set_heading(0, Some(Heading::H1))?;
        t.set_style(0..2, &InlineStyle::Bold)?;
        t.link_entity(
            3..5,
            &EntityLink {
                target,
                kind: EntityKind::Element,
                block: None,
                end_block: None,
            },
        )
    })
    .unwrap();
    drop(s);
    assert_eq!(
        e.out("category.list", json!({"book": b}))[0]["has_element_template"],
        true
    );
    assert_eq!(
        e.out(
            "category_template.body",
            json!({"book": b, "category": cat})
        ),
        json!([{"heading": 1, "text": "外貌"}, {"text": "安娜的姐姐"}])
    );
    // A new element of the category starts with a copy: marks and links
    // too, under block ids of its own.
    let bea = id(&e.out(
        "element.create",
        json!({"book": b, "name": "贝雅", "category": cat}),
    ));
    let page = format!("element:{bea}");
    let p = paragraphs(&e, &page);
    assert_eq!(field(&p, "text"), [json!("外貌"), json!("安娜的姐姐")]);
    assert_eq!(field(&p, "heading"), [json!(1), json!(0)]);
    assert_eq!(links_of(&e, &page), [("安娜".to_string(), anna.clone())]);
    let t = paragraphs(&e, &doc);
    assert_ne!(p[0]["block_id"], t[0]["block_id"]);
    {
        let s = e.ws().prose_session(&page).unwrap();
        let r = s.reader();
        let first = r.view().paragraphs().next().unwrap();
        assert!(first.runs[0].marks.bold);
    }
    // `set_body` keeps the paragraphs it shares: the heading keeps its id
    // and its bold; undo brings the old text back.
    e.call(
        "category_template.set_body",
        json!({"book": b, "category": cat, "paragraphs": [
            {"heading": 1, "text": "外貌"}, {"text": "（写一两句）"},
        ]}),
    );
    let t2 = paragraphs(&e, &doc);
    assert_eq!(t2[0]["block_id"], t[0]["block_id"]);
    assert_eq!(field(&t2, "text"), [json!("外貌"), json!("（写一两句）")]);
    assert_eq!(field(&t2, "heading"), [json!(1), json!(0)]);
    // Setting what is there writes nothing.
    let o = e.call(
        "category_template.set_body",
        json!({"book": b, "category": cat, "paragraphs": [
            {"heading": 1, "text": "外貌"}, {"text": "（写一两句）"},
        ]}),
    );
    assert!(effects(&o).is_empty());
    undo(&e);
    assert_eq!(
        field(&paragraphs(&e, &doc), "text"),
        [json!("外貌"), json!("安娜的姐姐")]
    );
    // The element made from it never changes with it.
    e.call(
        "category_template.set_body",
        json!({"book": b, "category": cat, "paragraphs": []}),
    );
    assert_eq!(field(&paragraphs(&e, &doc), "text"), [json!("")]);
    assert_eq!(
        e.out("category.list", json!({"book": b}))[0]["has_element_template"],
        false
    );
    assert_eq!(
        field(&paragraphs(&e, &page), "text"),
        [json!("外貌"), json!("安娜的姐姐")]
    );
}

#[test]
fn a_storylines_chapter_template_starts_its_new_chapters() {
    let e = env();
    let b = e.book();
    let line = id(&e.out("storyline.create", json!({"book": b, "name": "主线"})));
    assert_eq!(
        e.out("storyline.list", json!({"book": b}))[0]["has_chapter_template"],
        false
    );
    let body =
        json!([{"heading": 2, "text": "开场"}, {"text": ""}, {"heading": 3, "text": "收束"}]);
    e.call(
        "chapter_template.set_body",
        json!({"book": b, "storyline": line, "paragraphs": body}),
    );
    assert_eq!(
        e.out(
            "chapter_template.body",
            json!({"book": b, "storyline": line})
        ),
        body
    );
    assert_eq!(
        e.out("storyline.list", json!({"book": b}))[0]["has_chapter_template"],
        true
    );
    assert_eq!(
        e.out(
            "chapter_template.document",
            json!({"book": b, "storyline": line})
        )["doc"],
        format!("template:storyline:{line}")
    );
    // A chapter on it with no text starts from the template.
    let one = id(&e.out(
        "chapter.create",
        json!({"book": b, "title": "一", "storyline": line}),
    ));
    let p = paragraphs(&e, &format!("node:{one}"));
    assert_eq!(field(&p, "text"), [json!("开场"), json!(""), json!("收束")]);
    assert_eq!(field(&p, "heading"), [json!(2), json!(0), json!(3)]);
    // Its own text wins; a chapter on no storyline starts empty.
    let two = id(&e.out(
        "chapter.create",
        json!({"book": b, "title": "二", "storyline": line, "text": "雨。"}),
    ));
    assert_eq!(
        field(&paragraphs(&e, &format!("node:{two}")), "text"),
        [json!("雨。")]
    );
    let three = id(&e.out("chapter.create", json!({"book": b, "title": "三"})));
    assert_eq!(
        field(&paragraphs(&e, &format!("node:{three}")), "text"),
        [json!("")]
    );
    assert!(matches!(
        e.try_call(
            "chapter_template.set_body",
            json!({"book": b, "storyline": line, "paragraphs": [{"heading": 0, "text": "x"}]})
        ),
        Err(WsError::Invalid(_))
    ));
}

#[test]
fn the_01_field_is_the_template_until_a_document_takes_over() {
    use dr_doc::book::BorrowedBook;
    use dr_model::id::{BookId, CategoryId};
    use dr_store::OpenDoc;
    use dr_workspace::commands::template::{TemplateParagraph, body_json};
    let e = env();
    let b = e.book();
    let cat = id(&e.out("category.create", json!({"book": b, "name": "地点"})));
    // An old library's field, as an import leaves it.
    let p = |h: Option<u8>, t: &str| TemplateParagraph {
        heading: h,
        text: t.into(),
    };
    let json = body_json(&[p(Some(1), "方位"), p(None, "（写一两句）")]);
    let (book, cid) = (BookId::parse(&b).unwrap(), CategoryId::parse(&cat).unwrap());
    let h = e
        .ws()
        .library()
        .open_doc(&format!("book:{b}"), OpenDoc::Existing)
        .unwrap();
    h.write(dr_store::Origin::Import, move |d| {
        let bb = BorrowedBook::new(d, &book).unwrap();
        let mut txn = bb.txn();
        txn.category(&cid)
            .unwrap()
            .element_template(Some(&json))
            .unwrap();
    })
    .unwrap();
    drop(h);
    let want = json!([{"heading": 1, "text": "方位"}, {"text": "（写一两句）"}]);
    assert_eq!(
        e.out(
            "category_template.body",
            json!({"book": b, "category": cat})
        ),
        want
    );
    assert_eq!(
        e.out("category.list", json!({"book": b}))[0]["has_element_template"],
        true
    );
    let inn = id(&e.out(
        "element.create",
        json!({"book": b, "name": "客栈", "category": cat}),
    ));
    assert_eq!(
        field(&paragraphs(&e, &format!("element:{inn}")), "text"),
        [json!("方位"), json!("（写一两句）")]
    );
    // Opening it for the editor writes the field into the document; that
    // is not a step of the author's.
    let o = e.call(
        "category_template.document",
        json!({"book": b, "category": cat}),
    );
    assert!(o["journal"].is_null());
    let doc = o["output"]["doc"].as_str().unwrap().to_string();
    assert_eq!(
        field(&paragraphs(&e, &doc), "heading"),
        [json!(1), json!(0)]
    );
    assert_eq!(
        e.out(
            "category_template.body",
            json!({"book": b, "category": cat})
        ),
        want
    );
    // From now on the document is the template, even emptied.
    e.call(
        "category_template.set_body",
        json!({"book": b, "category": cat, "paragraphs": []}),
    );
    assert_eq!(
        e.out("category.list", json!({"book": b}))[0]["has_element_template"],
        false
    );
    let well = id(&e.out(
        "element.create",
        json!({"book": b, "name": "古井", "category": cat}),
    ));
    assert_eq!(
        field(&paragraphs(&e, &format!("element:{well}")), "text"),
        [json!("")]
    );
}

#[test]
fn two_devices_changing_one_template_merge() {
    use loro::ExportMode;
    let a = env();
    let z = env();
    let b = a.book();
    let cat = id(&a.out("category.create", json!({"book": b, "name": "人物"})));
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
            "category_template.set_body",
            json!({"book": b, "category": cat, "paragraphs": body}),
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
        assert_eq!(
            dev.out(
                "category_template.body",
                json!({"book": b, "category": cat})
            ),
            want
        );
    }
}

#[test]
fn an_element_says_when_it_last_changed() {
    use dr_store::OpenDoc;
    let e = env();
    let b = e.book();
    let anna = id(&e.out("element.create", json!({"book": b, "name": "安娜"})));
    let row = |e: &Env| e.out("element.list", json!({"book": b}))[0].clone();
    let first = row(&e);
    let created = first["created_at"].as_i64().unwrap();
    assert!(first["updated_at"].as_i64().unwrap() >= created);
    // The stamp element.update writes on the element (its own key, until
    // dr-doc has the field).
    let stamp = |e: &Env| {
        let h = e
            .ws()
            .library()
            .open_doc(&format!("book:{b}"), OpenDoc::Existing)
            .unwrap();
        let id = anna.clone();
        h.read(move |d| match d.get_map("elements").get(&id) {
            Some(loro::ValueOrContainer::Container(loro::Container::Map(m))) => {
                match m.get("updated_at") {
                    Some(loro::ValueOrContainer::Value(loro::LoroValue::I64(t))) => Some(t),
                    _ => None,
                }
            }
            _ => None,
        })
        .unwrap()
    };
    assert_eq!(stamp(&e), None, "creating is not updating");
    // A rename, a field: both stamp it; the list reads the later of the
    // stamp and the body's last edit.
    e.call(
        "element.update",
        json!({"book": b, "id": anna, "name": "安妮"}),
    );
    let after_rename = stamp(&e).expect("stamped");
    assert!(after_rename >= created);
    e.call(
        "element.update",
        json!({"book": b, "id": anna, "put_fields": [{"key": "年龄", "value": "十七"}]}),
    );
    let t = stamp(&e).unwrap();
    assert!(t >= after_rename);
    assert!(row(&e)["updated_at"].as_i64().unwrap() >= t);
    // Undo puts the fields back; the stamp stays a stamp.
    undo(&e);
    assert_eq!(row(&e)["fields"], json!([]));
}

#[test]
fn set_body_keeps_empty_headings_next_to_what_changed() {
    let e = env();
    let b = e.book();
    let cat = id(&e.out("category.create", json!({"book": b, "name": "人物"})));
    let set = |body: Value| {
        e.call(
            "category_template.set_body",
            json!({"book": b, "category": cat, "paragraphs": body}),
        );
        e.out(
            "category_template.body",
            json!({"book": b, "category": cat}),
        )
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
