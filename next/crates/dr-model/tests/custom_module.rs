//! The module format and its one validator (`custom-modules.md` §3–§6, §12,
//! §14 rows 1–2). The sample modules are dr-testkit's fixtures
//! (`dr_testkit::samples::modules`), read by path: dr-testkit depends on
//! this crate.

use dr_model::custom_module::values::{
    BlockValue, InputValue, ItemStep, StoredItem, StoredScope, StoredValue, check_input,
    check_path, read_plain, read_scope,
};
use dr_model::custom_module::{
    BlockKind, LookSize, MAX_MODULE_BYTES, ModuleError, ModuleValue, Node, module_name_hint,
    parse_module_json, to_canonical_json, validate_module_value,
};
use serde_json::{Value, json};

const SAMPLES: [(&str, &str); 4] = [
    (
        "foreshadowing",
        include_str!("../../dr-testkit/fixtures/modules/foreshadowing.driftingmodule"),
    ),
    (
        "character-arc",
        include_str!("../../dr-testkit/fixtures/modules/character-arc.driftingmodule"),
    ),
    (
        "world-chronology",
        include_str!("../../dr-testkit/fixtures/modules/world-chronology.driftingmodule"),
    ),
    (
        "magic-rule",
        include_str!("../../dr-testkit/fixtures/modules/magic-rule.driftingmodule"),
    ),
];

fn foreshadowing() -> Value {
    serde_json::from_str(SAMPLES[0].1).unwrap()
}

fn parse(v: &Value) -> Result<ModuleValue, ModuleError> {
    parse_module_json(&serde_json::to_string(v).unwrap())
}

fn malformed(v: &Value) {
    match parse(v) {
        Err(ModuleError::MalformedJson(_)) => {}
        other => panic!("expected MalformedJson for {v}, got {other:?}"),
    }
}

fn invalid(v: &Value, says: &str) {
    match parse(v) {
        Err(ModuleError::Invalid(msg)) => assert!(msg.contains(says), "{msg:?} vs {says:?}"),
        other => panic!("expected Invalid({says}) for {v}, got {other:?}"),
    }
}

fn with(mut v: Value, path: &[&str], set: Value) -> Value {
    let mut at = &mut v;
    for (i, seg) in path.iter().enumerate() {
        let last = i + 1 == path.len();
        at = match seg.parse::<usize>() {
            Ok(n) => &mut at[n],
            Err(_) if last => {
                at[*seg] = set;
                return v;
            }
            Err(_) => &mut at[*seg],
        };
    }
    *at = set;
    v
}

#[test]
fn every_sample_module_is_valid_and_written_canonically() {
    for (name, raw) in SAMPLES {
        let value = parse_module_json(raw).unwrap_or_else(|e| panic!("{name}: {e}"));
        let canonical = to_canonical_json(&value).unwrap();
        assert_eq!(canonical, raw, "{name} is not in canonical form");
        // The same module written again is the same bytes, and reads back equal.
        assert_eq!(to_canonical_json(&value).unwrap(), canonical);
        assert_eq!(parse_module_json(&canonical).unwrap(), value);
    }
}

#[test]
fn canonical_output_does_not_depend_on_how_the_input_was_written() {
    let compact = serde_json::to_string(&foreshadowing()).unwrap();
    // Keys of the input in another order, explicit defaults spelled out.
    let mut shuffled: serde_json::Map<String, Value> = serde_json::Map::new();
    let src = foreshadowing();
    for key in [
        "sample",
        "agent",
        "look",
        "blocks",
        "credit",
        "locale",
        "name",
        "formatVersion",
        "format",
    ] {
        shuffled.insert(key.into(), src[key].clone());
    }
    let shuffled = with(
        Value::Object(shuffled),
        &["look", "line", "nowrap"],
        json!(false),
    );
    let a = to_canonical_json(&parse_module_json(&compact).unwrap()).unwrap();
    let b = to_canonical_json(&parse(&shuffled).unwrap()).unwrap();
    assert_eq!(a, b);
    assert_eq!(a, SAMPLES[0].1);
}

#[test]
fn the_structure_is_closed() {
    let base = foreshadowing();
    // Unknown keys anywhere.
    malformed(&with(base.clone(), &["script"], json!("alert(1)")));
    malformed(&with(
        base.clone(),
        &["blocks", "0", "formula"],
        json!("=SUM(A1)"),
    ));
    malformed(&with(
        base.clone(),
        &["look", "line", "html"],
        json!("<b>x</b>"),
    ));
    malformed(&with(
        base.clone(),
        &["look", "line", "color"],
        json!("#ff0000"),
    ));
    malformed(&with(base.clone(), &["look", "style"], json!("color: red")));
    malformed(&with(base.clone(), &["agent", "model"], json!("gpt")));
    malformed(&with(
        base.clone(),
        &["credit", "homepage"],
        json!("https://x"),
    ));
    malformed(&with(base.clone(), &["madeWith"], json!("x")));
    // Unknown kinds and values.
    malformed(&with(
        base.clone(),
        &["blocks", "0", "type"],
        json!("formula"),
    ));
    malformed(&with(
        base.clone(),
        &["blocks", "0", "blocks", "0", "type"],
        json!("entity_ref"),
    ));
    malformed(&with(
        base.clone(),
        &["look", "line", "border"],
        json!("red"),
    ));
    malformed(&with(
        base.clone(),
        &["look", "line", "bg"],
        json!("url(x.png)"),
    ));
    malformed(&with(base.clone(), &["look", "line", "box"], json!("flex")));
    malformed(&with(
        base.clone(),
        &["look", "line", "kids", "0", "font"],
        json!("Helvetica"),
    ));
    malformed(&with(
        base.clone(),
        &["look", "full"],
        json!({"image": "x.png"}),
    ));
    malformed(&with(base.clone(), &["look", "full"], json!({})));
    malformed(&with(
        base.clone(),
        &["look", "full"],
        json!({"box": "col", "value": "items"}),
    ));
    // A key that belongs to another kind of node.
    malformed(&with(base.clone(), &["look", "line", "suffix"], json!("x")));
    malformed(&with(
        base.clone(),
        &["look", "full"],
        json!({"mark": "book", "ink": 1}),
    ));
    malformed(&with(
        base.clone(),
        &["look", "full"],
        json!({"each": "items", "item": {"value": "line"}}),
    ));
    // Numbers that are not whole are not steps either.
    malformed(&with(base, &["look", "line", "gap"], json!(8.5)));
}

#[test]
fn style_outside_the_vocabulary_is_refused() {
    let base = foreshadowing();
    invalid(
        &with(base.clone(), &["look", "line", "gap"], json!(5)),
        "gap 5",
    );
    invalid(
        &with(base.clone(), &["look", "line", "pad"], json!(32)),
        "pad 32",
    );
    invalid(
        &with(base.clone(), &["look", "line", "radius"], json!(3)),
        "radius 3",
    );
    invalid(
        &with(
            base.clone(),
            &["look", "line", "kids", "0", "ink"],
            json!(5),
        ),
        "ink 5",
    );
    invalid(
        &with(
            base.clone(),
            &["look", "line", "kids", "0", "ink"],
            json!(0),
        ),
        "ink 0",
    );
    invalid(
        &with(base.clone(), &["look", "full"], json!({"mark": "star"})),
        "sand marks",
    );
    invalid(
        &with(
            base.clone(),
            &["look", "full"],
            json!({"box": "grid", "cols": [50]}),
        ),
        "column width 50",
    );
    invalid(
        &with(
            base.clone(),
            &["look", "full"],
            json!({"box": "grid", "cols": [328]}),
        ),
        "column width 328",
    );
    invalid(
        &with(base.clone(), &["look", "full"], json!({"box": "grid"})),
        "columns",
    );
    invalid(
        &with(
            base.clone(),
            &["look", "full"],
            json!({"box": "row", "cols": ["fill"]}),
        ),
        "only a grid",
    );
    invalid(
        &with(
            base.clone(),
            &["look", "full"],
            json!({"box": "col", "max": 1000}),
        ),
        "max 1000",
    );
    invalid(
        &with(base.clone(), &["look", "full"], json!({"text": ""})),
        "fixed text",
    );
    invalid(
        &with(base, &["look", "line", "kids", "0", "lines"], json!(11)),
        "lines",
    );
}

#[test]
fn no_id_of_anything_in_a_project() {
    let base = foreshadowing();
    // A sample entry is a few words, never an entry's id.
    invalid(
        &with(
            base.clone(),
            &["sample", "items", "0", "back"],
            json!(["0192f3a4-5b6c-7d8e-9f00-112233445566"]),
        ),
        "by id",
    );
    // A block id is short; an id-shaped one does not fit.
    invalid(
        &with(
            base.clone(),
            &["blocks", "0", "id"],
            json!("0192f3a4-5b6c-7d8e-9f00-112233445566"),
        ),
        "block id",
    );
    // No files: no sample image.
    let magic: Value = serde_json::from_str(SAMPLES[3].1).unwrap();
    invalid(
        &with(magic, &["sample", "seal"], json!("asset-1")),
        "no files",
    );
}

#[test]
fn every_reference_is_drawable() {
    let base = foreshadowing();
    invalid(
        &with(base.clone(), &["look", "full"], json!({"value": "nope"})),
        "does not have",
    );
    invalid(
        &with(
            base.clone(),
            &["look", "full"],
            json!({"each": "line", "item": {"box": "col"}}),
        ),
        "not a list",
    );
    // `line` lives in the items of `items`: outside an each over it, there is nothing to draw.
    invalid(
        &with(base.clone(), &["look", "full"], json!({"value": "line"})),
        "outside the items",
    );
    // Shown as something its kind is not.
    invalid(
        &with(
            base.clone(),
            &["look", "line", "kids", "0", "show"],
            json!("text"),
        ),
        "not shown as text",
    );
    invalid(
        &with(
            base.clone(),
            &["look", "block", "item", "kids", "1", "show"],
            json!("dots"),
        ),
        "not shown as dots",
    );
    invalid(
        &with(
            base.clone(),
            &["look", "block", "item", "kids", "1", "show"],
            json!("count"),
        ),
        "not shown as count",
    );
    let magic: Value = serde_json::from_str(SAMPLES[3].1).unwrap();
    invalid(
        &with(magic, &["look", "full"], json!({"value": "cost"})),
        "group",
    );
}

#[test]
fn values_can_be_kept_and_read() {
    let base = foreshadowing();
    // `id` is where a list item keeps its own id.
    invalid(
        &with(base.clone(), &["blocks", "0", "blocks", "0", "id"], json!("id")),
        "block id",
    );
    invalid(
        &with(
            base.clone(),
            &["blocks", "0", "blocks", "1", "id"],
            json!("line"),
        ),
        "two blocks",
    );
    invalid(
        &with(
            base.clone(),
            &["blocks", "0", "blocks", "1", "options"],
            json!([]),
        ),
        "needs options",
    );
    invalid(
        &with(
            base.clone(),
            &["blocks", "0", "blocks", "1", "options"],
            json!(["埋着", "埋着"]),
        ),
        "twice",
    );
    invalid(
        &with(
            base.clone(),
            &["blocks", "0", "blocks", "0", "options"],
            json!(["a"]),
        ),
        "only a select",
    );
    invalid(
        &with(
            base.clone(),
            &["blocks", "0", "blocks", "0", "blocks"],
            json!([{"id": "x", "type": "text", "name": "x"}]),
        ),
        "only a group or a list",
    );
    invalid(
        &with(
            base.clone(),
            &["sample", "items", "0", "st"],
            json!("没有这个"),
        ),
        "not a select",
    );
    invalid(
        &with(base.clone(), &["sample", "items", "0", "line"], json!(3)),
        "not a text",
    );
    invalid(
        &with(base.clone(), &["sample", "line"], json!("x")),
        "does not keep",
    );
    invalid(
        &with(base, &["agent", "blocks", "nope"], json!("x")),
        "does not have",
    );
}

fn block(id: usize, kind: &str) -> Value {
    json!({"id": format!("b{id}"), "type": kind, "name": format!("块{id}")})
}

#[test]
fn limits() {
    let base = foreshadowing();
    // 101 blocks.
    let many: Vec<Value> = (0..101).map(|i| block(i, "text")).collect();
    let v = with(
        with(base.clone(), &["blocks"], json!(many)),
        &["look"],
        json!({"block": {"box": "col"}}),
    );
    let v = with(with(v, &["sample"], json!({})), &["agent"], json!({}));
    invalid(&v, "blocks");
    // Lists nested five deep.
    let mut inner = block(5, "text");
    for d in (0..5).rev() {
        let mut l = block(100 + d, "list");
        l["blocks"] = json!([inner]);
        inner = l;
    }
    let v = with(
        with(
            with(base.clone(), &["blocks"], json!([inner])),
            &["sample"],
            json!({}),
        ),
        &["look"],
        json!({"block": {"box": "col"}}),
    );
    let v = with(v, &["agent"], json!({}));
    invalid(&v, "nested at most 4");
    // Four deep is fine.
    let mut inner = block(5, "text");
    for d in (0..4).rev() {
        let mut l = block(100 + d, "list");
        l["blocks"] = json!([inner]);
        inner = l;
    }
    let v = with(
        with(
            with(base.clone(), &["blocks"], json!([inner])),
            &["sample"],
            json!({}),
        ),
        &["look"],
        json!({"block": {"box": "col"}}),
    );
    parse(&with(v, &["agent"], json!({}))).unwrap();
    // 401 nodes.
    let kids: Vec<Value> = (0..400).map(|_| json!({"text": "字"})).collect();
    invalid(
        &with(
            base.clone(),
            &["look", "full"],
            json!({"box": "col", "kids": kids}),
        ),
        "nodes",
    );
    // Too many words for the Agent.
    invalid(
        &with(
            base.clone(),
            &["agent", "instructions"],
            json!("字".repeat(20_001)),
        ),
        "words for the Agent",
    );
    // Too large.
    let huge = with(
        base,
        &["agent", "description"],
        json!("x".repeat(MAX_MODULE_BYTES)),
    );
    match parse(&huge) {
        Err(ModuleError::TooLarge { .. }) => {}
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_newer_module_says_it_is_newer() {
    let base = foreshadowing();
    // Even with keys this build does not know.
    let newer = with(
        with(base.clone(), &["formatVersion"], json!(2)),
        &["glow"],
        json!(true),
    );
    assert_eq!(
        parse(&newer),
        Err(ModuleError::UnsupportedFormatVersion {
            found: 2,
            supported: 1
        })
    );
    assert_eq!(
        parse(&with(base.clone(), &["formatVersion"], json!(0))),
        Err(ModuleError::InvalidFormatVersion(0))
    );
    assert!(matches!(
        parse(&with(base, &["format"], json!("drifting.project-template"))),
        Err(ModuleError::InvalidFormat(_))
    ));
    assert!(matches!(
        parse_module_json("not json"),
        Err(ModuleError::MalformedJson(_))
    ));
}

#[test]
fn an_empty_module_is_valid_and_names_are_read_leniently() {
    let empty = ModuleValue::empty("  新模块 ");
    validate_module_value(&empty).unwrap();
    assert_eq!(empty.name, "新模块");
    assert!(matches!(
        empty.look.own(LookSize::Block),
        Some(Node::Box(_))
    ));
    assert!(empty.look.own(LookSize::Line).is_none());
    // The name of a copy this build cannot read.
    let newer = with(foreshadowing(), &["formatVersion"], json!(9));
    assert_eq!(
        module_name_hint(&newer.to_string()).as_deref(),
        Some("伏笔追踪")
    );
    assert_eq!(module_name_hint("{"), None);
    assert_eq!(module_name_hint(r#"{"name": 3}"#), None);
}

#[test]
fn scopes_and_paths() {
    let m: ModuleValue = parse_module_json(SAMPLES[2].1).unwrap();
    assert_eq!(m.scope_of("eras"), Some(None));
    assert_eq!(m.scope_of("events"), Some(Some("eras")));
    assert_eq!(m.scope_of("year"), Some(Some("events")));
    assert_eq!(m.list_chain("year"), Some(vec!["eras", "events"]));
    assert_eq!(m.list_chain("eras"), Some(vec![]));
    assert_eq!(m.scope_of("nope"), None);
    let step = |list: &str, item: &str| ItemStep {
        list: list.into(),
        item: item.into(),
    };
    check_path(&m, "year", &[step("eras", "i1"), step("events", "i2")]).unwrap();
    assert!(check_path(&m, "year", &[step("eras", "i1")]).is_err());
    assert!(check_path(&m, "era", &[]).is_err());
    // Groups are looked through: their blocks are kept where the group is.
    let magic: ModuleValue = parse_module_json(SAMPLES[3].1).unwrap();
    let root: Vec<&str> = magic
        .scope_blocks(None)
        .iter()
        .map(|b| b.id.as_str())
        .collect();
    assert!(root.contains(&"price") && root.contains(&"risk") && !root.contains(&"cost"));
    let line: Vec<&str> = magic.line_blocks(3).iter().map(|b| b.id.as_str()).collect();
    assert_eq!(line, ["power", "school", "schools"]);
}

#[test]
fn stored_values_read_as_the_current_kind_and_never_change() {
    let m: ModuleValue = parse_module_json(SAMPLES[3].1).unwrap();
    let power = m.block("power").unwrap();
    let mut b = power.clone();
    // A number read as a number; a number in text read as one too.
    assert_eq!(
        read_plain(&b, &StoredValue::Number(4.0)),
        Some(BlockValue::Number(4.0))
    );
    assert_eq!(
        read_plain(&b, &StoredValue::Text(" 3 ".into())),
        Some(BlockValue::Number(3.0))
    );
    assert_eq!(read_plain(&b, &StoredValue::Text("很强".into())), None);
    // The same stored value under another kind.
    b.kind = BlockKind::Text;
    assert_eq!(read_plain(&b, &StoredValue::Number(4.0)), None);
    assert_eq!(
        read_plain(&b, &StoredValue::Text("很强".into())),
        Some(BlockValue::Text("很强".into()))
    );
    // A select whose option went away reads as nothing.
    let school = m.block("school").unwrap();
    assert_eq!(read_plain(school, &StoredValue::Text("水".into())), None);
    assert_eq!(
        read_plain(school, &StoredValue::Text("风".into())),
        Some(BlockValue::Select("风".into()))
    );
    // Unknown stays unread.
    assert_eq!(read_plain(school, &StoredValue::Unknown), None);

    // A scope: values for blocks the copy no longer has are not shown.
    let mut scope = StoredScope::default();
    scope.plain.insert("power".into(), StoredValue::Number(2.0));
    scope
        .plain
        .insert("gone".into(), StoredValue::Text("留着".into()));
    let read = read_scope(&m, None, &scope);
    assert_eq!(read.get("power"), Some(&BlockValue::Number(2.0)));
    assert!(!read.contains_key("gone"));

    // Lists read item by item, nested lists too.
    let chron: ModuleValue = parse_module_json(SAMPLES[2].1).unwrap();
    let mut event = StoredScope::default();
    event.plain.insert("year".into(), StoredValue::Number(12.0));
    let mut era = StoredScope::default();
    era.plain
        .insert("era".into(), StoredValue::Text("雾纪".into()));
    era.lists.insert(
        "events".into(),
        vec![StoredItem {
            id: "e1".into(),
            scope: event,
        }],
    );
    let mut root = StoredScope::default();
    root.lists.insert(
        "eras".into(),
        vec![StoredItem {
            id: "x1".into(),
            scope: era,
        }],
    );
    let read = read_scope(&chron, None, &root);
    let Some(BlockValue::List(eras)) = read.get("eras") else {
        panic!("{read:?}")
    };
    assert_eq!(eras[0].id, "x1");
    let Some(BlockValue::List(events)) = eras[0].values.get("events") else {
        panic!()
    };
    assert_eq!(
        events[0].values.get("year"),
        Some(&BlockValue::Number(12.0))
    );
}

#[test]
fn inputs_are_checked_against_the_block_kind() {
    let m: ModuleValue = parse_module_json(SAMPLES[3].1).unwrap();
    let get = |id: &str| m.block(id).unwrap();
    assert_eq!(
        check_input(get("power"), &InputValue::Number(3.0)),
        Ok(Some(StoredValue::Number(3.0)))
    );
    assert!(check_input(get("power"), &InputValue::Number(f64::NAN)).is_err());
    assert!(check_input(get("power"), &InputValue::Text("3".into())).is_err());
    assert_eq!(check_input(get("power"), &InputValue::Null), Ok(None));
    assert!(check_input(get("school"), &InputValue::Text("水".into())).is_err());
    assert!(
        check_input(
            get("schools"),
            &InputValue::Texts(vec!["风".into(), "风".into()])
        )
        .is_err()
    );
    assert!(check_input(get("since"), &InputValue::Text("2024-02-30".into())).is_err());
    assert!(check_input(get("price"), &InputValue::Text("两\n行".into())).is_err());
    assert!(check_input(get("rules"), &InputValue::Text("两\n行".into())).is_ok());
    assert!(check_input(get("forbidden"), &InputValue::Bool(true)).is_ok());
    assert!(check_input(get("cost"), &InputValue::Null).is_err());
    let chron: ModuleValue = parse_module_json(SAMPLES[2].1).unwrap();
    assert!(check_input(chron.block("eras").unwrap(), &InputValue::Texts(vec![])).is_err());
}
