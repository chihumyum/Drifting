//! `module.set_prose` writes checklist items and `prose.read` reads them
//! back (`kernel-v5.md` §7, §12; task book T7b). A paragraph whose words
//! change is edited where it stands: its block id, so a checklist item's
//! comment id, stays.
mod common;
use common::*;
use serde_json::{Value, json};

struct Prose {
    e: Env,
    book: String,
    entry: String,
}

impl Prose {
    fn new() -> Self {
        let e = env();
        e.ws().set_auto_links(false);
        let book = e.book();
        let entries = e.out("entry.list", json!({"book":book,"all":true}));
        let parent = entries
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["template"] == "tpl-manuscript")
            .unwrap()["id"]
            .clone();
        let entry = e.out(
            "entry.create",
            json!({"book":book,"parent":parent,"title":"Synthetic checklist","template":"tpl-chapter"}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        Self { e, book, entry }
    }
    fn doc(&self) -> String {
        format!("body:{}/mod-prose", self.entry)
    }
    fn set(&self, paragraphs: Value) -> dr_workspace::Result<Value> {
        self.e.try_call(
            "module.set_prose",
            json!({"book":self.book,"owner":self.entry,"module":"mod-prose","paragraphs":paragraphs}),
        )
    }
    fn write(&self, paragraphs: Value) {
        self.set(paragraphs.clone())
            .unwrap_or_else(|e| panic!("module.set_prose {paragraphs}: {e}"));
    }
    fn read(&self) -> Vec<Value> {
        self.e.out("prose.read", json!({"doc":self.doc()}))["paragraphs"]
            .as_array()
            .unwrap()
            .clone()
    }
    fn module_read(&self) -> Vec<Value> {
        self.e.out(
            "module.read_prose",
            json!({"book":self.book,"owner":self.entry,"module":"mod-prose"}),
        )["paragraphs"]
            .as_array()
            .unwrap()
            .clone()
    }
    fn ids(&self) -> Vec<String> {
        self.read()
            .iter()
            .map(|p| p["block_id"].as_str().unwrap().to_owned())
            .collect()
    }
    fn texts(&self) -> Vec<String> {
        self.read()
            .iter()
            .map(|p| p["text"].as_str().unwrap().to_owned())
            .collect()
    }
    fn version(&self) -> String {
        self.e.out("prose.read", json!({"doc":self.doc()}))["version"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

fn keys(p: &Value) -> Vec<&str> {
    let mut k: Vec<&str> = p.as_object().unwrap().keys().map(String::as_str).collect();
    k.sort_unstable();
    k
}

#[test]
fn set_prose_writes_checklist_items_and_both_reads_return_them() {
    let p = Prose::new();
    p.write(json!([
        {"heading":1,"text":"清单"},
        {"text":"普通的一段"},
        {"list":"task","text":"买纸"},
        {"list":"task","checked":true,"text":"磨墨"},
        {"list":"bullet","list_level":1,"text":"一个小点"},
        {"list":"ordered","text":"第一步"}
    ]));
    for read in [p.read(), p.module_read()] {
        assert_eq!(read.len(), 6, "{read:?}");
        // A paragraph that is not a list item reads exactly as before.
        assert_eq!(keys(&read[0]), ["block_id", "heading", "index", "text"]);
        assert_eq!(read[0]["heading"], 1);
        assert_eq!(keys(&read[1]), ["block_id", "heading", "index", "text"]);
        assert_eq!(read[2]["list"], "task");
        assert_eq!(read[2]["checked"], false);
        assert!(read[2].get("list_level").is_none());
        assert_eq!(read[3]["list"], "task");
        assert_eq!(read[3]["checked"], true);
        assert_eq!(read[4]["list"], "bullet");
        assert_eq!(read[4]["list_level"], 1);
        // Only a task item has a tick.
        assert!(read[4].get("checked").is_none());
        assert_eq!(read[5]["list"], "ordered");
        assert_eq!(read[5]["text"], "第一步");
    }
    let shape = p.e.out("prose.shape", json!({"doc":p.doc()}));
    assert_eq!(shape["tasks"], 2);
    assert_eq!(shape["done"], 1);

    // What a read gives back, written back as it is, changes nothing: no
    // paragraph, id, tick or version.
    let (ids, version) = (p.ids(), p.version());
    let read = p.read();
    p.write(Value::Array(read.clone()));
    assert_eq!(p.read(), read);
    assert_eq!(p.ids(), ids);
    assert_eq!(p.version(), version);
}

#[test]
fn set_prose_refuses_list_attributes_that_mean_nothing() {
    let p = Prose::new();
    p.write(json!([{"text":"原样"}]));
    let version = p.version();
    for bad in [
        json!([{"list":"todo","text":"未知的清单种类"}]),
        json!([{"list_level":1,"text":"不是清单却有层级"}]),
        json!([{"checked":true,"text":"不是清单却打了勾"}]),
        json!([{"list":"bullet","checked":true,"text":"只有任务项能打勾"}]),
        json!([{"heading":4,"text":"没有 H4"}]),
    ] {
        assert!(p.set(bad.clone()).is_err(), "{bad}");
        assert_eq!(p.version(), version, "{bad}");
    }
    // `heading: 0` is what a read says for body text.
    p.write(json!([{"heading":0,"text":"正文"}]));
    assert_eq!(p.read()[0]["heading"], 0);
    assert_eq!(p.texts(), ["正文"]);
}

#[test]
fn changed_paragraphs_are_edited_in_place_and_keep_their_block_ids() {
    let p = Prose::new();
    p.write(json!([
        {"text":"开头"},
        {"list":"task","text":"买纸"},
        {"text":"结尾"}
    ]));
    let [a, task, b]: [String; 3] = p.ids().try_into().unwrap();

    // The item's words change: it stays the same checklist item.
    p.write(json!([
        {"text":"开头"},
        {"list":"task","text":"买宣纸"},
        {"text":"结尾"}
    ]));
    let read = p.read();
    assert_eq!(p.ids(), [a.clone(), task.clone(), b.clone()]);
    assert_eq!(read[1]["list"], "task");
    assert_eq!(read[1]["checked"], false);
    assert_eq!(read[1]["text"], "买宣纸");

    // Another paragraph changes: the item stays as it is.
    let item = p.read()[1].clone();
    p.write(json!([
        {"text":"新的开头"},
        {"list":"task","text":"买宣纸"},
        {"text":"结尾"}
    ]));
    assert_eq!(p.ids(), [a.clone(), task.clone(), b.clone()]);
    assert_eq!(p.read()[1], item);
    assert_eq!(p.read()[0]["text"], "新的开头");

    // The tick, and a paragraph turned into a heading, change in place.
    p.write(json!([
        {"heading":2,"text":"新的开头"},
        {"list":"task","checked":true,"text":"买宣纸"},
        {"text":"结尾"}
    ]));
    let read = p.read();
    assert_eq!(p.ids(), [a.clone(), task.clone(), b.clone()]);
    assert_eq!(read[0]["heading"], 2);
    assert_eq!(read[1]["checked"], true);

    // A new item in the middle and one at the end: the others keep theirs.
    p.write(json!([
        {"heading":2,"text":"新的开头"},
        {"list":"task","text":"裁纸"},
        {"list":"task","checked":true,"text":"买宣纸"},
        {"text":"结尾"},
        {"list":"task","text":"收笔"}
    ]));
    let ids = p.ids();
    assert_eq!(ids.len(), 5);
    assert_eq!(
        [&ids[0], &ids[2], &ids[3]],
        [&a, &task, &b],
        "kept paragraphs keep their ids"
    );
    let unique: std::collections::BTreeSet<&String> = ids.iter().collect();
    assert_eq!(unique.len(), 5, "new paragraphs get new ids: {ids:?}");
    let read = p.read();
    assert_eq!(read[1]["list"], "task");
    assert_eq!(read[4]["list"], "task");
    assert_eq!(read[4]["text"], "收笔");
    assert_eq!(read[3]["text"], "结尾");
    assert!(read[3].get("list").is_none());

    // An item changed and one added next to it: the changed one is the one
    // that keeps its id, the closest match.
    let (cut, end) = (ids[1].clone(), ids[4].clone());
    p.write(json!([
        {"heading":2,"text":"新的开头"},
        {"list":"task","text":"裁纸"},
        {"list":"task","text":"磨墨"},
        {"list":"task","checked":true,"text":"买上好的宣纸"},
        {"text":"结尾"},
        {"list":"task","text":"收笔"}
    ]));
    let ids = p.ids();
    assert_eq!(ids[1], cut);
    assert_eq!(ids[3], task);
    assert_eq!(ids[4], b);
    assert_eq!(ids[5], end);

    // Lines taken out, the last one too: the rest keep theirs.
    p.write(json!([
        {"heading":2,"text":"新的开头"},
        {"list":"task","checked":true,"text":"买上好的宣纸"},
        {"text":"结尾"}
    ]));
    assert_eq!(p.ids(), [a.clone(), task.clone(), b.clone()]);
    assert_eq!(p.texts(), ["新的开头", "买上好的宣纸", "结尾"]);
    assert_eq!(p.read()[0]["heading"], 2);
    assert_eq!(p.read()[1]["checked"], true);
    assert!(p.read()[2].get("list").is_none());
}

#[test]
fn in_place_edits_keep_what_the_paragraph_shape_does_not_say() {
    let p = Prose::new();
    p.write(json!([{"text":"引一段话"},{"list":"task","text":"一项"}]));
    // A quote the paragraph shape cannot express, and bold on a word.
    let session = p.e.ws().prose_session(&p.doc()).unwrap();
    session
        .edit(|t| {
            t.set_block_attrs(
                0,
                &dr_model::prose::BlockAttrs {
                    quote: true,
                    ..Default::default()
                },
            )?;
            t.set_style(0..1, &dr_model::prose::InlineStyle::Bold)
        })
        .unwrap();
    drop(session);
    let ids = p.ids();
    p.write(json!([{"text":"引一段长话"},{"list":"task","text":"一项"}]));
    assert_eq!(p.ids(), ids);
    assert_eq!(p.texts(), ["引一段长话", "一项"]);
    let session = p.e.ws().prose_session(&p.doc()).unwrap();
    let reader = session.reader();
    let view = reader.view();
    let first = view.paragraphs().next().unwrap();
    assert!(first.attrs.quote, "the quote stays");
    assert!(
        first.runs[0].marks.bold,
        "the untouched word keeps its bold"
    );
}

#[test]
fn empty_paragraphs_and_a_blank_module_keep_their_place() {
    let p = Prose::new();
    // Into a blank module, ending with an empty item.
    p.write(json!([{"text":"甲"},{"list":"task","text":""}]));
    let read = p.read();
    assert_eq!(read.len(), 2);
    assert_eq!(read[1]["list"], "task");
    assert_eq!(read[1]["text"], "");
    let ids = p.ids();
    // After an empty last paragraph.
    p.write(json!([{"text":"甲"},{"list":"task","text":""},{"text":"乙"}]));
    assert_eq!(p.ids()[..2], ids[..]);
    assert_eq!(p.texts(), ["甲", "", "乙"]);
    assert_eq!(p.read()[1]["list"], "task");
    assert!(p.read()[2].get("list").is_none());
    // Everything out, then in again.
    p.write(json!([]));
    assert_eq!(p.texts(), [""]);
    assert!(p.read()[0].get("list").is_none());
    p.write(json!([{"list":"bullet","text":"重新开始"}]));
    assert_eq!(p.texts(), ["重新开始"]);
    assert_eq!(p.read()[0]["list"], "bullet");
}
