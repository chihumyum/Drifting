use std::collections::BTreeMap;

use dr_export::Labels;
use dr_mirror::file::{Edits, Header, Unwritable, parse, render};
use dr_model::id::{BodyDocId, BookId, EntryId, EntryTemplateId, ModuleId};
use dr_model::v3::{EntryTemplate, FieldDef, FieldType as T, FieldValue as V, ModuleSpec};
use dr_testkit::seed::BuilderV3;

fn definition(id: &str, name: &str, field_type: T, options: &[&str]) -> FieldDef {
    FieldDef {
        id: id.into(),
        name: name.into(),
        field_type,
        options: options.iter().map(|s| (*s).into()).collect(),
        target_template: None,
        default_value: None,
        pos: None,
    }
}

fn text(s: &str) -> V {
    V::Text(s.to_owned())
}

fn list(xs: &[&str]) -> V {
    V::List(xs.iter().map(|s| (*s).to_owned()).collect())
}

fn fixture() -> (BodyDocId, Header) {
    text_fixture("安娜回到钟楼。", "  她等到四点。\n钟停了。\n\n")
}

fn text_fixture(summary: &str, blurb: &str) -> (BodyDocId, Header) {
    let entry = EntryId::parse("rain").unwrap();
    let main = ModuleId::parse("properties").unwrap();
    let more = ModuleId::parse("other-properties").unwrap();
    let id = BodyDocId::new(entry.clone(), ModuleId::parse("body").unwrap());
    let template = EntryTemplate {
        id: EntryTemplateId::parse("properties").unwrap(),
        name: "属性".into(),
        mark: None,
        color: None,
        agent: None,
        modules: vec![
            ModuleSpec::fields(
                main.clone(),
                "章",
                vec![
                    definition("summary", "梗概", T::Text, &[]),
                    definition("blurb", "长备注", T::LongText, &[]),
                    definition("time", "日期", T::Date, &[]),
                    definition("number", "次序", T::Number, &[]),
                    definition("status", "写作状态", T::Select, &["draft", "finished"]),
                    definition("weather", "天气", T::MultiSelect, &["雨", "晴"]),
                    definition("flag", "已校对", T::Toggle, &[]),
                    definition("alias", "别名", T::Aliases, &[]),
                    definition("portrait", "封面", T::Image, &[]),
                    definition("mentioned", "条目", T::EntityRef, &[]),
                    definition("duplicate", "备注", T::Text, &[]),
                    definition("identity", "drifting-id", T::Text, &[]),
                    definition("host", "挂在", T::Text, &[]),
                    definition("empty", "空着的", T::Text, &[]),
                    definition("literal", "title: \"quoted\"", T::Text, &[]),
                ],
            ),
            ModuleSpec::fields(
                more.clone(),
                "别的字段",
                vec![
                    definition("duplicate", "备注", T::Text, &[]),
                    definition("reserved", "aliases", T::Text, &[]),
                ],
            ),
        ],
        level: false,
        linkable: false,
        settings: Default::default(),
        verbs: Vec::new(),
        deleted_at: None,
    };
    let mut seed = BuilderV3::new(BookId::parse("mirror-frontmatter").unwrap()).unwrap();
    seed.edit_book(|txn| {
        txn.template(&template.id)?.set_full(&template)?;
        let row = txn
            .entries()
            .create(&entry, None, "雨夜", Some(&template.id), false)?;
        for (field, value) in [
            ("summary", text(summary)),
            ("blurb", text(blurb)),
            ("time", text("2026-11-16")),
            ("number", V::Number(1.25)),
            ("status", text("draft")),
            ("weather", list(&["雨"])),
            ("flag", V::Bool(false)),
            ("alias", list(&["雨里的那一章"])),
            ("portrait", text("picture")),
            ("mentioned", text("anna")),
            ("duplicate", text("甲")),
            ("identity", text("这不是身份")),
            ("host", text("这不是挂名")),
            ("literal", text("true")),
        ] {
            row.set_field(&main, field, Some(&value))?;
        }
        row.set_field(&more, "duplicate", Some(&text("乙")))?
            .set_field(&more, "reserved", Some(&text("ordinary field")))?;
        Ok(())
    })
    .unwrap();
    let view = seed.book.view();
    let header = Header::for_entry(
        &view.entry(&entry).unwrap(),
        &template,
        &Labels {
            options: BTreeMap::from([
                ("draft".to_owned(), "草稿".to_owned()),
                ("finished".to_owned(), "已完成".to_owned()),
            ]),
            ..Default::default()
        },
        vec!["[[主线]]".into(), "[[回忆线]]".into()],
        |kind, value| match (kind, value) {
            (T::Image, "picture") => Some("[[素材库/图片.png]]".into()),
            (T::EntityRef, "anna") => Some("[[安娜]]".into()),
            _ => None,
        },
    );
    (id, header)
}

#[test]
fn types_round_trip_in_template_order_with_only_the_canonical_reserved_keys() {
    let (id, header) = fixture();
    let extra = "tags: [待改]  # 外面的分类\ncssclasses:\n- 引文\nmetadata:\n  keep: 'as is'\n";
    let written = render(&id, &header, extra, "# 一\n\n正文。").unwrap();
    assert!(
        written.starts_with("---\ndrifting-id: rain/body\n梗概: 安娜回到钟楼。\n长备注: |2+\n")
    );
    assert!(written.contains(
        "日期: 2026-11-16\n次序: 1.25\n写作状态: 草稿\n天气: [\"雨\"]\n已校对: false\naliases: [\"雨里的那一章\"]\n"
    ));
    assert!(written.contains(
        "封面: \"[[素材库/图片.png]]\"\n条目: \"[[安娜]]\"\n空着的:\n\"title: \\\"quoted\\\"\": \"true\"\n"
    ));
    assert!(written.contains("挂在: [\"[[主线]]\",\"[[回忆线]]\"]\n"));
    assert!(!written.contains("\n备注:"));
    assert!(!written.contains("ordinary field"));
    assert_eq!(written.matches("drifting-id:").count(), 1);
    let parsed = parse(&written).unwrap();
    assert_eq!(parsed.id.as_deref(), Some(id.as_str()));
    assert_eq!(parsed.body, "# 一\n\n正文。\n");
    assert_eq!(parsed.extra(&header), extra);
    assert!(parsed.edits(&header).fields.is_empty());
    assert!(!parsed.edits(&header).read_only_changed);
}

#[test]
fn reads_back_only_recognized_changed_keys_and_distinguishes_removed_keys_from_nulls() {
    let (id, header) = fixture();
    let altered = r#"---
drifting-id: 'rain/body'
梗概: # 作者明确清空
日期: 2026-02-29
次序: 2.5
写作状态: finished
天气:
  - 晴
已校对: true
aliases: ['她''的章', "第二个"]
封面: '[[素材库/另一张.png]]'
挂在: []
空着的: 新填的
"title: \"quoted\"": 'true'
---
# 一
"#;
    let parsed = parse(altered).unwrap();
    let edits = parsed.edits(&header);
    let changed = changes(&edits);
    assert_eq!(parsed.id.as_deref(), Some(id.as_str()));
    assert_eq!(changed.len(), 8);
    assert_eq!(changed["time"].1, None);
    assert_eq!(
        changed["summary"],
        (&text("安娜回到钟楼。"), Some(&V::Null))
    );
    assert_eq!(changed["number"].1, Some(&V::Number(2.5)));
    assert_eq!(changed["status"].1, Some(&text("finished")));
    assert_eq!(changed["weather"].1, Some(&list(&["晴"])));
    assert_eq!(changed["flag"].1, Some(&V::Bool(true)));
    assert_eq!(changed["alias"].1, Some(&list(&["她'的章", "第二个"])));
    assert_eq!(changed["empty"], (&V::Null, Some(&text("新填的"))));
    assert!(edits.read_only_changed);

    let label = altered.replace("写作状态: finished", "写作状态: 已完成");
    assert_eq!(parse(&label).unwrap().edits(&header), edits);
}

fn changes(edits: &Edits) -> BTreeMap<&str, (&V, Option<&V>)> {
    edits
        .fields
        .iter()
        .map(|e| (e.slot.field.as_str(), (&e.expected, e.value.as_ref())))
        .collect()
}

#[test]
fn other_editors_spellings_are_read_and_values_that_do_not_fit_are_refused() {
    let (_, header) = fixture();
    let spelled = "---\n梗概: 2026\n长备注: true\n日期: '2026-11-17'\n次序: \"3000\"\n写作状态: 已完成\n天气: 晴\n已校对: 'true'\naliases: 老王\n空着的: 1.50\n---\n";
    let edits = parse(spelled).unwrap().edits(&header);
    let changed = changes(&edits);
    assert_eq!(changed.len(), 9, "{changed:?}");
    assert_eq!(changed["summary"].1, Some(&text("2026")));
    assert_eq!(changed["blurb"].1, Some(&text("true")));
    assert_eq!(changed["time"].1, Some(&text("2026-11-17")));
    assert_eq!(changed["number"].1, Some(&V::Number(3000.0)));
    assert_eq!(changed["status"].1, Some(&text("finished")));
    assert_eq!(changed["weather"].1, Some(&list(&["晴"])));
    assert_eq!(changed["flag"].1, Some(&V::Bool(true)));
    assert_eq!(changed["alias"].1, Some(&list(&["老王"])));
    assert_eq!(changed["empty"].1, Some(&text("1.50")));

    // Each of these is refused (an edit without a value), so the file is kept
    // aside before the App's value is written back. The unchanged literal
    // key is no edit.
    let unfit = "---\n梗概: [bad]\n写作状态: 不知道\n次序: .inf\n已校对: yes\n天气: [未知]\naliases: [{a: b}]\n日期: 明天\n\"title: \\\"quoted\\\"\": \"true\"\n---\n";
    let edits = parse(unfit).unwrap().edits(&header);
    let changed = changes(&edits);
    assert_eq!(
        changed.keys().copied().collect::<Vec<_>>(),
        [
            "alias", "flag", "number", "status", "summary", "time", "weather"
        ]
    );
    assert!(changed.values().all(|(_, value)| value.is_none()));
    assert_eq!(changed["summary"].0, &text("安娜回到钟楼。"));
    let empty = "---\n次序: ''\n已校对: \"\"\n---\n";
    let empty_edits = parse(empty).unwrap().edits(&header);
    let changed = changes(&empty_edits)
        .into_iter()
        .map(|(k, (_, v))| (k, v.cloned()))
        .collect::<Vec<_>>();
    assert_eq!(
        changed,
        [("flag", Some(V::Null)), ("number", Some(V::Null))]
    );
}

#[test]
fn other_editors_frontmatter_is_read_and_their_properties_are_kept() {
    let (_, header) = fixture();
    let raw = "\u{FEFF}---\r\n# lead\r\ndrifting-id: 'rain/body' # identity\r\n写作状态: draft\r\n长备注: >\r\n  一行\r\n  两行\r\n# surround\r\ntags:\r\n  - a\r\n  - b\r\nauthor: 'O''Brien' # note\r\n---\r\n正文\r\n";
    let parsed = parse(raw).unwrap();
    assert_eq!(parsed.id.as_deref(), Some("rain/body"));
    assert_eq!(parsed.body, "正文\n");
    assert_eq!(
        parsed.extra(&header),
        "# lead\n# surround\ntags:\n  - a\n  - b\nauthor: 'O''Brien' # note\n"
    );
    let edits = parsed.edits(&header);
    assert_eq!(edits.fields.len(), 1);
    assert_eq!(edits.fields[0].slot.field, "blurb");
    assert_eq!(edits.fields[0].value, Some(text("一行 两行\n")));
}

#[test]
fn broken_frontmatter_is_refused_and_plain_body_is_kept() {
    for broken in [
        "---\ndrifting-id: rain/body\n正文",
        "---\n  stray\n---\n",
        "---\ndrifting-id: rain/body\ntags: [a, b\n---\n",
        "---\ndrifting-id: rain/body\ndrifting-id: elsewhere/body\n---\n",
        "---\ndrifting-id: rain/body\nforeign: *missing\n---\n",
    ] {
        assert!(parse(broken).is_err(), "{broken}");
    }
    let (_, header) = fixture();
    let plain = parse("正文\n").unwrap();
    assert_eq!(plain.id, None);
    assert_eq!(plain.body, "正文\n");
    assert!(plain.edits(&header).fields.is_empty());
}

#[test]
fn preserves_unmanaged_text_on_transitions_that_would_make_it_invalid() {
    let (id, header) = fixture();
    let anchor = "---\ndrifting-id: rain/body\n梗概: &summary 一句\nother: *summary\n---\n正文\n";
    let parsed = parse(anchor).unwrap();
    assert!(matches!(
        render(&id, &header, &parsed.extra(&header), &parsed.body),
        Err(Unwritable::Broken(_))
    ));
    // A definition added in Drifting may now occupy a key formerly unmanaged:
    // a collision of its own, not a malformed header.
    assert!(matches!(
        render(&id, &header, "tags: [a]\n已校对: 外面作者的属性\n", "正文\n"),
        Err(Unwritable::KeyCollision(key)) if key == "已校对"
    ));
    assert!(matches!(
        render(&id, &header, "\"aliases\": [别处的名字]\n", "正文\n"),
        Err(Unwritable::KeyCollision(key)) if key == "aliases"
    ));
}

use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]
    #[test]
    fn text_fields_round_trip_through_yaml(
        chars in prop::collection::vec(prop::sample::select(vec![
            'a', '钟', ' ', '　', '\n', '\r', '\t', '\u{0085}', '\u{2028}', '\u{2029}',
            ':', '#', '\\', '"', '\'', '[', ']', '{', '}', '&', '*', '?', '-', '1', '0',
        ]), 0..64),
    ) {
        let text: String = chars.into_iter().collect();
        let (id, header) = text_fixture(&text, &text);
        let raw = render(&id, &header, "tags: [outside]\n", "正文\n").unwrap();
        let parsed = parse(&raw).unwrap();
        prop_assert!(parsed.edits(&header).fields.is_empty(), "{:?}", raw);
        prop_assert_eq!(parsed.extra(&header), "tags: [outside]\n");
        prop_assert_eq!(parsed.body, "正文\n");
    }
}
