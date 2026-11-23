//! What the workbench does to a module (`custom-modules.md` §3, §4, §8),
//! without a window: every change keeps block ids (values stay), passes
//! the validator, and only ever sets the vocabulary's steps.

use dr_model::custom_module::{
    BlockKind, BoxDir, LookSize, ModuleValue, Node, SPACING_STEPS, Show, validate_module_value,
};
use dr_view_module_bench::edit::{
    self, MoveTo, Prop, Spot, Words, add_block, move_block, remove_block, rename_block, rows,
    set_options, set_own, set_prop, set_words, spot,
};

fn sample(name: &str) -> ModuleValue {
    dr_testkit::samples::MODULE_FILES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, raw)| dr_model::custom_module::parse_module_json(raw).unwrap())
        .unwrap()
}

fn ok(v: &ModuleValue) {
    validate_module_value(v).unwrap_or_else(|e| panic!("refused: {e}"));
}

fn options() -> Vec<String> {
    ["甲", "乙", "丙"].map(str::to_owned).to_vec()
}

/// Every kind of block goes into an empty module, a list's items and a
/// group, drawn where its value is kept; the module stays valid each time.
#[test]
fn every_kind_of_block_is_added_where_it_is_kept_and_drawn() {
    let mut v = ModuleValue::empty("新模块");
    ok(&v);
    let mut ids = Vec::new();
    for kind in BlockKind::ALL {
        let (next, id) = add_block(&v, kind, "一样", &options(), None).unwrap();
        ok(&next);
        assert!(next.block(&id).is_some());
        assert_eq!(next.scope_of(&id), Some(None));
        ids.push(id);
        v = next;
    }
    // Ids are new each time and never one the module has.
    let mut sorted = ids.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), ids.len());
    // Into the list: kept by its items, drawn inside its each node.
    let list = ids[10].clone();
    let (v2, inner) = add_block(&v, BlockKind::Text, "一句", &[], Some(&list)).unwrap();
    ok(&v2);
    assert_eq!(v2.scope_of(&inner), Some(Some(list.as_str())));
    let mut drawn_in_each = false;
    v2.look.block.walk(&mut |n| {
        if let Node::Each(e) = n
            && e.list == list
        {
            e.item.kids.iter().for_each(|k| {
                if matches!(k, Node::Value(x) if x.block == inner) {
                    drawn_in_each = true;
                }
            });
        }
    });
    assert!(drawn_in_each, "drawn in the list's items");
    // Into a group: kept by the entry.
    let group = ids[9].clone();
    let (v3, in_group) = add_block(&v2, BlockKind::Number, "数", &[], Some(&group)).unwrap();
    ok(&v3);
    assert_eq!(v3.scope_of(&in_group), Some(None));
    // Not into a block that holds none.
    let (v4, top) = add_block(&v3, BlockKind::Date, "日", &[], Some(&ids[0])).unwrap();
    assert_eq!(v4.blocks.last().unwrap().id, top);
}

/// Renaming, moving and taking a block away keep every other block's id;
/// a block taken away takes the nodes that drew it and its label with it.
#[test]
fn blocks_are_renamed_moved_and_taken_away_by_id() {
    let v = sample("foreshadowing");
    let renamed = rename_block(&v, "line", "一句话（改）").unwrap();
    ok(&renamed);
    assert_eq!(renamed.block("line").unwrap().name, "一句话（改）");
    assert!(rename_block(&v, "line", "  ").is_none(), "no empty name");
    assert!(rename_block(&v, "line", "a\nb").is_none(), "one line");

    // Moving 「状态」 to the end of the list's items keeps it there.
    let moved = move_block(&v, "st", &MoveTo::Into("items".into())).unwrap();
    ok(&moved);
    let items = &moved.block("items").unwrap().blocks;
    assert_eq!(items.last().unwrap().id, "st");
    // Out of the list: kept by the entry, it may be drawn anywhere, so its
    // node stays.
    let out = move_block(&v, "line", &MoveTo::End).unwrap();
    ok(&out);
    assert_eq!(out.scope_of("line"), Some(None));
    // Into a list: kept by its items, it is no longer drawn outside them;
    // the node goes, and the box that only labelled it.
    let arc = sample("character-arc");
    let into = move_block(&arc, "need", &MoveTo::Into("turns".into())).unwrap();
    ok(&into);
    assert_eq!(into.scope_of("need"), Some(Some("turns")));
    let mut drawn = 0;
    let mut label = 0;
    into.look.block.walk(&mut |n| match n {
        Node::Value(x) if x.block == "need" => drawn += 1,
        Node::Text(t) if t.text == "需要" => label += 1,
        _ => {}
    });
    assert_eq!((drawn, label), (0, 0), "neither the value nor its label");
    // Not into itself.
    assert!(move_block(&v, "items", &MoveTo::Into("items".into())).is_none());
    assert!(move_block(&v, "items", &MoveTo::Before("line".into())).is_none());

    // Taken away: the block, the nodes drawing it, the sentence for the
    // Agent and the sample's values for it.
    let gone = remove_block(&v, "back").unwrap();
    ok(&gone);
    assert!(gone.block("back").is_none());
    assert!(!gone.agent.blocks.contains_key("back"));
    let json = serde_json::to_string(&gone).unwrap();
    assert!(!json.contains("\"back\""), "nothing names it: {json}");
    // The others keep their ids.
    for id in ["items", "line", "st"] {
        assert!(gone.block(id).is_some(), "{id}");
    }
}

/// A select's options come one per line, trimmed and without repeats; none
/// left is no change; the sample keeps only values among them.
#[test]
fn options_are_set_from_lines() {
    let v = sample("foreshadowing");
    let next = set_options(&v, "st", "埋着\n 收了 \n\n收了").unwrap();
    ok(&next);
    assert_eq!(next.block("st").unwrap().options, ["埋着", "收了"]);
    assert!(set_options(&v, "st", "\n \n").is_none());
    assert!(
        set_options(&v, "line", "a").is_none(),
        "only a choice has options"
    );
    let json = serde_json::to_string(&next.sample).unwrap();
    assert!(!json.contains("提过"), "{json}");
}

/// Every property row offers only the §4 steps; each set passes the
/// validator; a grid gets its columns, leaving it drops them.
#[test]
fn properties_set_only_steps_of_the_vocabulary() {
    let v = sample("magic-rule");
    let root = edit::tree(&v, LookSize::Block).unwrap();
    let all = rows(root);
    assert!(!all.is_empty());
    for (path, _, at) in &all {
        let props: Vec<Prop> = match at {
            Spot::Node(Node::Box(_)) | Spot::Item(_) => SPACING_STEPS
                .iter()
                .map(|&g| Prop::Gap(g))
                .chain(SPACING_STEPS.iter().map(|&p| Prop::Pad(p)))
                .chain([
                    Prop::Dir(BoxDir::Row),
                    Prop::Dir(BoxDir::Grid),
                    Prop::Dir(BoxDir::Col),
                ])
                .collect(),
            Spot::Node(Node::Value(_)) => vec![Prop::Ink(1), Prop::Ink(4)],
            Spot::Node(Node::Text(_)) => vec![Prop::Text("新的字".into())],
            Spot::Node(Node::Mark(_)) => vec![Prop::Mark("compass".into())],
            Spot::Node(Node::Each(_)) => vec![Prop::Gap(24)],
        };
        let mut at_v = v.clone();
        for prop in props {
            if let Some(next) = set_prop(&at_v, LookSize::Block, path, prop.clone()) {
                validate_module_value(&next).unwrap_or_else(|e| panic!("{path:?} {prop:?}: {e}"));
                at_v = next;
            }
        }
    }
    // Grid columns.
    let v = sample("character-arc");
    let grid = set_prop(&v, LookSize::Block, &[], Prop::Dir(BoxDir::Grid)).unwrap();
    ok(&grid);
    let Node::Box(b) = &grid.look.block else {
        panic!("the root is a box")
    };
    assert_eq!(b.cols.len(), 2);
    let back = set_prop(&grid, LookSize::Block, &[], Prop::Dir(BoxDir::Col)).unwrap();
    let Node::Box(b) = &back.look.block else {
        panic!("the root is a box")
    };
    assert!(b.cols.is_empty());
    // A property a node does not have changes nothing.
    assert!(set_prop(&v, LookSize::Block, &[], Prop::Show(Show::Dots)).is_none());
    assert!(set_prop(&v, LookSize::Block, &[99], Prop::Gap(8)).is_none());
}

/// 一行 and 铺满 follow 一块 until laid out on their own (a copy of 一块),
/// and follow it again.
#[test]
fn line_and_full_follow_the_block_or_are_laid_out_on_their_own() {
    let v = ModuleValue::empty("空");
    let v = add_block(&v, BlockKind::Text, "一行", &[], None).unwrap().0;
    assert!(edit::tree(&v, LookSize::Full).is_none());
    let own = set_own(&v, LookSize::Full, true).unwrap();
    ok(&own);
    assert_eq!(own.look.full.as_ref(), Some(&own.look.block));
    assert!(set_own(&own, LookSize::Full, true).is_none());
    let back = set_own(&own, LookSize::Full, false).unwrap();
    assert!(back.look.full.is_none());
    assert!(
        set_own(&v, LookSize::Block, false).is_none(),
        "一块 is always laid out"
    );
    // The tree's rows: each node with its path, an each's item box under it.
    let fore = sample("foreshadowing");
    let all = rows(edit::tree(&fore, LookSize::Block).unwrap());
    assert!(matches!(all[0].2, Spot::Node(Node::Each(_))));
    assert_eq!(all[1].0, vec![0]);
    assert!(matches!(all[1].2, Spot::Item(_)));
    for (path, _, _) in &all {
        assert!(spot(&fore.look.block, path).is_some(), "{path:?}");
    }
}

/// The words for the Agent: the template's three and one sentence a block.
#[test]
fn words_for_the_agent_are_set_and_cleared() {
    let v = sample("foreshadowing");
    let next = set_words(
        &v,
        &Words::Instructions,
        "只登记写进正文的。\n收回要指到章。",
    )
    .unwrap();
    ok(&next);
    assert_eq!(
        next.agent.instructions,
        "只登记写进正文的。\n收回要指到章。"
    );
    let next = set_words(&next, &Words::Block("line".into()), "  一句话写清  ").unwrap();
    assert_eq!(next.agent.blocks["line"], "一句话写清");
    let cleared = set_words(&next, &Words::Block("line".into()), "").unwrap();
    assert!(!cleared.agent.blocks.contains_key("line"));
    assert!(set_words(&v, &Words::Block("nope".into()), "x").is_none());
    ok(&cleared);
}
