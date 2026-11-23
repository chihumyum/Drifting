//! The layout, without a window: the four sample modules
//! (`dr_testkit::samples::modules`) laid out at the three sizes with their
//! sample values, with none, and with an entry's values as the book reads
//! them; what a size that is not laid out falls back to (§4); what a value
//! shows for each kind of block and each 「显示成」.

use std::collections::BTreeMap;

use dr_model::custom_module::values::{BlockValue, ItemValues};
use dr_model::custom_module::{
    Align, Background, BlockKind, Border, BoxDir, Column, ColumnFill, Decoration, EachDir,
    LookSize, ModuleValue, Separator, Show, Width,
};
use dr_view_module_look::plan::{DOTS, plan};
use dr_view_module_look::{
    Content, Fill, Names, NoNames, PNode, PValue, Picture, Plan, Scope, Words,
};

struct Zh;

impl Words for Zh {
    fn count_of(&self, count: usize, list: &str) -> String {
        format!("{count} 个{list}")
    }
}

fn sample(name: &str) -> ModuleValue {
    dr_testkit::samples::modules()
        .into_iter()
        .find(|m| m.name == name)
        .unwrap_or_else(|| panic!("no sample module {name}"))
}

fn laid(module: &ModuleValue, values: &Scope, size: LookSize) -> Plan {
    plan(module, values, size, &Zh)
}

fn value<'a>(plan: &'a Plan, block: &str) -> Vec<&'a PValue> {
    plan.root
        .values()
        .into_iter()
        .filter(|v| v.block == block)
        .collect()
}

fn root_box(plan: &Plan) -> &dr_view_module_look::PBox {
    match &plan.root {
        PNode::Box(b) => b,
        other => panic!("the root is a box, not {other:?}"),
    }
}

#[test]
fn every_sample_lays_out_at_every_size_with_its_sample_and_with_nothing() {
    for module in dr_testkit::samples::modules() {
        for size in [LookSize::Line, LookSize::Block, LookSize::Full] {
            for values in [
                Scope::sample(&module),
                Scope::empty(),
                Scope::blank(&module),
            ] {
                let p = laid(&module, &values, size);
                assert_eq!(p.size, size);
                assert_eq!(p.own, module.look.own(size).is_some(), "{}", module.name);
                // Every value names a block of the module, in the scope that
                // keeps it.
                for v in p.root.values() {
                    let block = module.block(&v.block).expect("a block of the module");
                    assert_eq!(v.kind, block.kind);
                    let chain = module.list_chain(&v.block).unwrap();
                    assert_eq!(
                        v.path.iter().map(|s| s.list.as_str()).collect::<Vec<_>>(),
                        chain,
                        "{}: {}",
                        module.name,
                        v.block
                    );
                }
            }
        }
    }
}

#[test]
fn a_blank_scope_has_one_item_in_every_list_and_no_values() {
    let m = sample("世界观年表");
    let p = laid(&m, &Scope::blank(&m), LookSize::Block);
    let PNode::Each(eras) = &p.root else {
        panic!("eras");
    };
    assert_eq!(eras.items.len(), 1);
    assert_eq!(eras.items[0].id, None);
    // The nested list has its one item too, and every block shows.
    let blocks: Vec<_> = p.root.values().iter().map(|v| v.block.clone()).collect();
    assert_eq!(blocks, ["era", "span", "year", "event", "where"]);
    assert!(
        p.root
            .values()
            .iter()
            .all(|v| v.content == Content::Missing)
    );
}

#[test]
fn foreshadowing_draws_a_ledger_with_marks_and_counts_in_its_line() {
    let m = sample("伏笔追踪");
    let p = laid(&m, &Scope::sample(&m), LookSize::Block);
    let PNode::Each(each) = &p.root else {
        panic!("一块 is the list of items");
    };
    assert_eq!(each.list, "items");
    assert_eq!(each.name, "伏笔");
    assert_eq!(each.dir, EachDir::Col);
    assert_eq!(each.sep, Separator::Hair);
    assert_eq!(each.items.len(), 2);
    let item = &each.items[0].body;
    assert_eq!(item.dir, BoxDir::Row);
    assert_eq!(item.gap, 8.0);
    assert_eq!(item.align, Align::Center);
    // 收了 is the last of 埋着、提过、收了: full; 埋着 the first: hollow.
    let marks: Vec<_> = value(&p, "st").into_iter().map(|v| &v.content).collect();
    assert_eq!(
        marks,
        [&Content::Mark(Fill::Full), &Content::Mark(Fill::Hollow)]
    );
    let lines: Vec<_> = value(&p, "line").into_iter().map(|v| &v.content).collect();
    assert_eq!(
        lines,
        [
            &Content::Words("墙上的旧照片少了一个人".into()),
            &Content::Words("钟楼的钟慢了七分钟".into())
        ]
    );
    let back = value(&p, "back");
    assert!(
        matches!(&back[0].content, Content::Entries(xs) if xs[0].title == "第十二章" && xs[0].id.is_none())
    );
    assert_eq!(back[1].content, Content::Missing);
    // The words beside a value: mono, note, the faintest ink.
    let PNode::Box(hug) = &item.kids[2] else {
        panic!("「收在」 and its entry are a box");
    };
    assert_eq!(hug.width, Width::Hug);
    let PNode::Text(words) = &hug.kids[0] else {
        panic!("「收在」");
    };
    assert_eq!(words.text, "收在");
    assert_eq!(
        (words.style.font, words.style.size, words.style.ink),
        (
            dr_model::custom_module::Font::Mono,
            dr_model::custom_module::TextSize::Note,
            4
        )
    );

    // 一行 is its own: the count, and its words after it.
    let line = laid(&m, &Scope::sample(&m), LookSize::Line);
    assert!(line.own);
    let count = &value(&line, "items")[0];
    assert_eq!(count.show, Show::Count);
    assert_eq!(count.content, Content::Count(2));
    assert_eq!(count.suffix.as_deref(), Some(" 处伏笔"));
    // 铺满 follows 一块.
    let full = laid(&m, &Scope::sample(&m), LookSize::Full);
    assert!(!full.own);
    assert!(matches!(full.root, PNode::Each(_)));
}

#[test]
fn a_line_that_is_not_laid_out_is_the_first_blocks_and_a_list_as_its_count() {
    let m = sample("人物弧光");
    let line = laid(&m, &Scope::sample(&m), LookSize::Line);
    assert!(!line.own);
    let b = root_box(&line);
    assert_eq!(b.dir, BoxDir::Row);
    assert!(b.nowrap);
    let blocks: Vec<_> = line.root.values().iter().map(|v| v.block.clone()).collect();
    assert_eq!(blocks, ["want", "need", "resolve"]);
    assert_eq!(
        value(&line, "want")[0].content,
        Content::Words("找回那块怀表".into())
    );
    assert_eq!(
        value(&line, "resolve")[0].content,
        Content::Words("3".into())
    );
    assert!(line.root.values().iter().all(|v| v.lines == Some(1)));

    // A list among the first blocks shows as its count, in the App's words;
    // images and groups are left out.
    let rule = sample("魔法规则卡");
    let line = laid(&rule, &Scope::sample(&rule), LookSize::Line);
    let blocks: Vec<_> = line.root.values().iter().map(|v| v.block.clone()).collect();
    assert_eq!(blocks, ["power", "school", "schools"]);
    let chrono = sample("世界观年表");
    let mut no_line = chrono.clone();
    no_line.look.line = None;
    let line = laid(&no_line, &Scope::sample(&no_line), LookSize::Line);
    assert_eq!(
        value(&line, "eras")[0].content,
        Content::Words("2 个纪元".into())
    );
}

#[test]
fn a_full_size_that_is_not_laid_out_is_the_block_stretched() {
    let m = sample("人物弧光");
    let block = laid(&m, &Scope::sample(&m), LookSize::Block);
    let full = laid(&m, &Scope::sample(&m), LookSize::Full);
    assert!(!full.own);
    assert_eq!(root_box(&block).width, Width::Auto);
    assert_eq!(root_box(&full).width, Width::Fill);
    let mut stretched = root_box(&block).clone();
    stretched.width = Width::Fill;
    assert_eq!(root_box(&full), &stretched);

    // A module that lays 铺满 out has it drawn as laid out.
    let rule = sample("魔法规则卡");
    let full = laid(&rule, &Scope::sample(&rule), LookSize::Full);
    assert!(full.own);
    assert_eq!(root_box(&full).max, Some(320.0));
    assert_eq!(root_box(&full).pad, 24.0);
}

#[test]
fn every_kind_of_block_shows_its_value() {
    let m = sample("魔法规则卡");
    let p = laid(&m, &Scope::sample(&m), LookSize::Block);
    let b = root_box(&p);
    assert_eq!(b.dir, BoxDir::Grid);
    assert_eq!(b.cols, [Column::Fill(ColumnFill::Fill), Column::Fixed(96)]);
    assert_eq!(
        (b.border, b.bg, b.radius, b.deco, b.pad),
        (Border::Sand, Background::Paper, 4.0, Decoration::Arc, 16.0)
    );
    let one = |block: &str| value(&p, block)[0].content.clone();
    assert_eq!(
        one("power"),
        Content::Dots {
            filled: 4,
            of: DOTS
        }
    );
    assert_eq!(one("school"), Content::Words("风".into()));
    // 风险 高 is the last of 低、中、高.
    assert_eq!(one("risk"), Content::Mark(Fill::Full));
    assert_eq!(one("price"), Content::Words("一段记忆".into()));
    assert_eq!(one("forbidden"), Content::Toggle(false));
    // No sample image (§6): nothing kept.
    assert_eq!(one("seal"), Content::Missing);
    assert_eq!(
        one("rules"),
        Content::Words("只在起雾的夜里有效。\n念错一个字，钟会停。".into())
    );
    assert_eq!(value(&p, "rules")[0].lines, Some(4));
    let full = laid(&m, &Scope::sample(&m), LookSize::Full);
    assert_eq!(
        value(&full, "schools")[0].content,
        Content::Choices(vec!["风".into(), "山".into()])
    );
    assert_eq!(
        value(&full, "since")[0].content,
        Content::Words("2024-03-01".into())
    );
    // A mark node.
    let mut marks = Vec::new();
    p.root.walk(&mut |n| {
        if let PNode::Mark(m) = n {
            marks.push(m.mark.clone());
        }
    });
    assert_eq!(marks, ["lightbulb"]);

    // With nothing kept: dots all hollow, a toggle off, the rest missing.
    let empty = laid(&m, &Scope::empty(), LookSize::Block);
    let one = |block: &str| value(&empty, block)[0].content.clone();
    assert_eq!(
        one("power"),
        Content::Dots {
            filled: 0,
            of: DOTS
        }
    );
    assert_eq!(one("forbidden"), Content::Toggle(false));
    assert_eq!(one("risk"), Content::Missing);
    assert_eq!(one("school"), Content::Missing);
}

#[test]
fn a_select_as_a_mark_is_hollow_half_or_full_by_its_place() {
    let opts: Vec<String> = ["起点", "动摇", "转折", "新我"].map(String::from).to_vec();
    use dr_view_module_look::plan::fill_of;
    assert_eq!(fill_of(&opts, "起点"), Some(Fill::Hollow));
    assert_eq!(fill_of(&opts, "动摇"), Some(Fill::Half));
    assert_eq!(fill_of(&opts, "转折"), Some(Fill::Half));
    assert_eq!(fill_of(&opts, "新我"), Some(Fill::Full));
    assert_eq!(fill_of(&opts, "别的"), None);
    // Dots are clamped to their number.
    let m = sample("人物弧光");
    let mut values = Scope::sample(&m);
    values
        .plain
        .insert("resolve".into(), dr_view_module_look::Shown::Number(9.4));
    let p = laid(&m, &values, LookSize::Block);
    assert_eq!(
        value(&p, "resolve")[0].content,
        Content::Dots {
            filled: DOTS,
            of: DOTS
        }
    );
    values
        .plain
        .insert("resolve".into(), dr_view_module_look::Shown::Number(-2.0));
    let p = laid(&m, &values, LookSize::Block);
    assert_eq!(
        value(&p, "resolve")[0].content,
        Content::Dots {
            filled: 0,
            of: DOTS
        }
    );
}

struct Book;

impl Names for Book {
    fn entry(&self, id: &str) -> Option<String> {
        (id == "0192f3a4-5b6c-7d8e-9f00-112233445566").then(|| "北渡".to_owned())
    }
    fn image(&self, id: &str) -> Option<Picture> {
        (id == "0192f3a4-5b6c-7d8e-9f00-aabbccddeeff").then(|| Picture {
            id: Some(id.to_owned()),
            name: "符印.png".into(),
            path: None,
        })
    }
}

#[test]
fn an_entrys_values_are_kept_where_their_items_are() {
    let m = sample("世界观年表");
    let event = |id: &str, year: f64, what: &str, at: Vec<String>| ItemValues {
        id: id.into(),
        values: BTreeMap::from([
            ("year".to_owned(), BlockValue::Number(year)),
            ("event".to_owned(), BlockValue::Text(what.into())),
            ("where".to_owned(), BlockValue::Entry(at)),
        ]),
    };
    let values = BTreeMap::from([(
        "eras".to_owned(),
        BlockValue::List(vec![
            ItemValues {
                id: "era-1".into(),
                values: BTreeMap::from([
                    ("era".to_owned(), BlockValue::Text("雾纪".into())),
                    (
                        "events".to_owned(),
                        BlockValue::List(vec![
                            event(
                                "ev-1",
                                87.0,
                                "大雾",
                                vec![
                                    "0192f3a4-5b6c-7d8e-9f00-112233445566".into(),
                                    // Deleted since: not drawn.
                                    "0192f3a4-5b6c-7d8e-9f00-000000000000".into(),
                                ],
                            ),
                            event("ev-2", 12.5, "钟楼", vec![]),
                        ]),
                    ),
                ]),
            },
            ItemValues {
                id: "era-2".into(),
                values: BTreeMap::new(),
            },
        ]),
    )]);
    let scope = Scope::read(&values, &Book);
    let p = laid(&m, &scope, LookSize::Block);
    let PNode::Each(eras) = &p.root else {
        panic!("eras");
    };
    assert_eq!(
        eras.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
        [Some("era-1".to_owned()), Some("era-2".to_owned())]
    );
    let years = value(&p, "year");
    assert_eq!(years.len(), 2);
    assert_eq!(years[0].content, Content::Words("87".into()));
    assert_eq!(years[1].content, Content::Words("12.5".into()));
    let path: Vec<_> = years[1]
        .path
        .iter()
        .map(|s| (s.list.as_str(), s.item.as_str()))
        .collect();
    assert_eq!(path, [("eras", "era-1"), ("events", "ev-2")]);
    let at = value(&p, "where");
    assert!(
        matches!(&at[0].content, Content::Entries(xs) if xs.len() == 1 && xs[0].title == "北渡" && xs[0].id.is_some())
    );
    assert_eq!(at[1].content, Content::Missing);
    // The second era keeps nothing: its name is missing, its events none.
    let eras_names = value(&p, "era");
    assert_eq!(eras_names[1].content, Content::Missing);

    // An image found in the book, one that is gone.
    let rule = sample("魔法规则卡");
    let values = BTreeMap::from([(
        "seal".to_owned(),
        BlockValue::Image("0192f3a4-5b6c-7d8e-9f00-aabbccddeeff".into()),
    )]);
    let p = laid(&rule, &Scope::read(&values, &Book), LookSize::Block);
    assert!(matches!(&value(&p, "seal")[0].content, Content::Image(pic) if pic.name == "符印.png"));
    let p = laid(&rule, &Scope::read(&values, &NoNames), LookSize::Block);
    assert_eq!(value(&p, "seal")[0].content, Content::Missing);
}

#[test]
fn a_value_node_for_a_block_the_module_does_not_have_draws_nothing() {
    // The validator refuses such a look (§12); the layout never panics on
    // one handed to it anyway.
    let mut m = sample("伏笔追踪");
    m.look.line = Some(dr_model::custom_module::Node::Value(
        dr_model::custom_module::ValueNode {
            block: "gone".into(),
            show: None,
            font: None,
            size: None,
            ink: None,
            lines: None,
            width: None,
            suffix: None,
        },
    ));
    let p = laid(&m, &Scope::sample(&m), LookSize::Line);
    assert!(p.root.values().is_empty());
    assert!(matches!(&p.root, PNode::Text(t) if t.text.is_empty()));
    let _ = BlockKind::Text;
}
