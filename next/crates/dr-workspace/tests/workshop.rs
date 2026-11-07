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
