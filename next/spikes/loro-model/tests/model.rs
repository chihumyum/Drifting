//! Schema v0 behaviour: genesis, block ids, anchors, links, embeds, peers,
//! storage and Agent writes.

use loro::{ExportMode, LoroDoc, LoroValue, UndoManager};
use loro_model_spike::anchor::Anchor;
use loro_model_spike::book::{Book, BookIndex};
use loro_model_spike::prose::{ProseDoc, entity_links, genesis};
use loro_model_spike::schema::{self, block};
use loro_model_spike::seed::{self, History, SeedConfig};
use loro_model_spike::store::{Durability, Holder, Store};
use loro_model_spike::{agent, undo_cases};

fn sync(from: &LoroDoc, to: &LoroDoc) {
    let bytes = from.export(ExportMode::updates(&to.oplog_vv())).unwrap();
    to.import(&bytes).unwrap();
}

fn ids(p: &ProseDoc) -> Vec<String> {
    p.paragraphs().into_iter().map(|p| p.id.unwrap()).collect()
}

fn texts(p: &ProseDoc) -> Vec<String> {
    p.paragraphs().into_iter().map(|p| p.text()).collect()
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("loro-model-spike-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn genesis_is_deterministic_and_concurrent_init_merges() {
    assert_eq!(genesis("node:x"), genesis("node:x"));
    assert_ne!(genesis("node:x"), genesis("node:y"));
    let a = ProseDoc::create("node:x", 1);
    let b = ProseDoc::create("node:x", 2);
    a.insert_text(0, "甲");
    a.doc.commit();
    b.insert_text(0, "乙");
    b.doc.commit();
    sync(&a.doc, &b.doc);
    sync(&b.doc, &a.doc);
    assert_eq!(a.text().to_string(), b.text().to_string());
    assert_eq!(a.paragraphs().len(), 1, "one paragraph, not two");
    assert!(a.text().to_string().ends_with('\n'));
}

#[test]
fn seed_is_byte_identical_across_runs() {
    let cfg = SeedConfig::tiny();
    let s1 = seed::generate(&cfg, History::Typed);
    let s2 = seed::generate(&cfg, History::Typed);
    assert_eq!(s1.stats.corpus_sha256, s2.stats.corpus_sha256);
    assert_eq!(
        s1.book.doc.export(ExportMode::all_updates()).unwrap(),
        s2.book.doc.export(ExportMode::all_updates()).unwrap()
    );
    for (a, b) in s1.prose.iter().zip(&s2.prose) {
        assert_eq!(
            a.prose.doc.export(ExportMode::all_updates()).unwrap(),
            b.prose.doc.export(ExportMode::all_updates()).unwrap(),
            "{}",
            a.doc_id
        );
    }
    let st = &s1.stats;
    assert_eq!(st.chapter_chars, cfg.chapter_chars);
    assert_eq!(st.element_chars, cfg.element_chars);
    assert_eq!(st.drift_chars, cfg.drift_chars);
    assert_eq!(st.drift_max, cfg.drift_max);
    // Body character counts match the configuration (newlines excluded).
    for e in &s1.prose {
        let n = e
            .prose
            .text()
            .to_string()
            .chars()
            .filter(|c| *c != '\n')
            .count();
        let objects = e
            .prose
            .text()
            .to_string()
            .chars()
            .filter(|c| *c == schema::OBJECT)
            .count();
        assert_eq!(n - objects, e.chars, "{}", e.doc_id);
    }
    // Every paragraph has a unique id.
    for e in &s1.prose {
        assert_eq!(e.prose.repair_block_ids(), 0, "{}", e.doc_id);
    }
    let idx = BookIndex::read(&s1.book.doc);
    assert_eq!(idx.chapters.len(), cfg.chapters);
    assert_eq!(idx.elements, cfg.elements);
    assert_eq!(idx.todos, cfg.todos);
    assert_eq!(idx.comments, cfg.comments);
}

#[test]
fn two_devices_importing_the_same_library_do_not_duplicate() {
    // The same old library imported on two devices with deterministic
    // import peers produces the same ops; merging them changes nothing.
    let cfg = SeedConfig::tiny();
    let a = seed::generate(&cfg, History::Bulk);
    let b = seed::generate(&cfg, History::Bulk);
    let before = a.prose[0].prose.text().to_string();
    sync(&b.prose[0].prose.doc, &a.prose[0].prose.doc);
    assert_eq!(a.prose[0].prose.text().to_string(), before);
    sync(&b.book.doc, &a.book.doc);
    assert_eq!(BookIndex::read(&a.book.doc).chapters.len(), cfg.chapters);
}

#[test]
fn enter_keeps_block_ids_with_the_text() {
    let p = ProseDoc::create("node:t", 7);
    p.insert_text(0, "第一段");
    let first = ids(&p)[0].clone();
    // Enter at the end: the written paragraph keeps its id.
    let caret = p.split(3);
    assert_eq!(caret, 4);
    p.insert_text(caret, "第二段");
    let after = ids(&p);
    assert_eq!(after[0], first);
    assert_eq!(texts(&p), vec!["第一段", "第二段"]);
    let second = after[1].clone();
    // Enter in the middle of the second paragraph: the second half keeps it.
    p.split(4 + 2);
    assert_eq!(texts(&p), vec!["第一段", "第二", "段"]);
    let ids3 = ids(&p);
    assert_eq!(ids3[0], first);
    assert_eq!(ids3[2], second);
    assert_ne!(ids3[1], second);
    // Enter at the start of a paragraph: the new empty one comes first.
    p.split(0);
    assert_eq!(texts(&p), vec!["", "第一段", "第二", "段"]);
    assert_eq!(ids(&p)[1], first);
    assert_eq!(p.repair_block_ids(), 0);
}

#[test]
fn split_carries_heading_only_in_the_middle() {
    let p = ProseDoc::create("node:h", 7);
    p.insert_text(0, "标题文字");
    p.set_block_attr(4, block::HEADING, Some(2.into()));
    p.split(4); // at end: new paragraph is body text
    assert_eq!(p.paragraphs()[0].heading(), Some(2));
    assert_eq!(p.paragraphs()[1].heading(), None);
    p.split(2); // in the middle: both halves are headings
    let ps = p.paragraphs();
    assert_eq!(texts(&p), vec!["标题", "文字", ""]);
    assert_eq!(ps[0].heading(), Some(2));
    assert_eq!(ps[1].heading(), Some(2));
}

#[test]
fn merging_keeps_the_first_paragraph() {
    let p = ProseDoc::create("node:m", 7);
    p.insert_text(0, "甲甲");
    p.set_block_attr(2, block::HEADING, Some(1.into()));
    let c = p.split(2);
    p.insert_text(c, "乙乙");
    let c = p.split(c + 2);
    p.insert_text(c, "丙丙");
    let before = ids(&p);
    assert_eq!(texts(&p), vec!["甲甲", "乙乙", "丙丙"]);
    // Backspace at the start of 乙乙: joins into 甲甲, keeps its heading and id.
    p.delete(2..3);
    assert_eq!(texts(&p), vec!["甲甲乙乙", "丙丙"]);
    let ps = p.paragraphs();
    assert_eq!(ps[0].id.as_deref(), Some(before[0].as_str()));
    assert_eq!(ps[0].heading(), Some(1));
    assert_eq!(ps[1].id.as_deref(), Some(before[2].as_str()));
    // Cross-paragraph delete from the middle of the first into the second.
    p.delete(3..6);
    assert_eq!(texts(&p), vec!["甲甲乙丙"]);
    assert_eq!(p.paragraphs()[0].id.as_deref(), Some(before[0].as_str()));
    assert_eq!(p.paragraphs()[0].heading(), Some(1));
    assert_eq!(p.repair_block_ids(), 0);
}

#[test]
fn deleting_whole_paragraphs_keeps_the_next_one() {
    let p = ProseDoc::create("node:w", 7);
    let c = p.split(0); // empty paragraph above
    p.insert_text(c, "正文");
    p.set_block_attr(c + 2, block::HEADING, Some(3.into()));
    let before = ids(&p);
    // Backspace at the start of 正文 removes the empty paragraph above.
    p.delete(0..1);
    assert_eq!(texts(&p), vec!["正文"]);
    assert_eq!(p.paragraphs()[0].id.as_deref(), Some(before[1].as_str()));
    assert_eq!(p.paragraphs()[0].heading(), Some(3));
}

#[test]
fn undo_of_a_merge_restores_both_ids() {
    let p = ProseDoc::create("node:u", 7);
    p.insert_text(0, "甲");
    let c = p.split(1);
    p.insert_text(c, "乙");
    p.doc.commit();
    let before = ids(&p);
    let mut um = UndoManager::new(&p.doc);
    p.delete(1..2);
    p.doc.commit();
    assert_eq!(texts(&p), vec!["甲乙"]);
    um.undo().unwrap();
    assert_eq!(texts(&p), vec!["甲", "乙"]);
    assert_eq!(ids(&p), before);
}

#[test]
fn concurrent_splits_never_duplicate_ids() {
    let a = ProseDoc::create("node:c", 1);
    a.insert_text(0, "一二三四五六");
    a.doc.commit();
    let b = ProseDoc::create("node:c", 2);
    sync(&a.doc, &b.doc);
    a.split(2);
    a.doc.commit();
    b.split(4);
    b.doc.commit();
    sync(&a.doc, &b.doc);
    sync(&b.doc, &a.doc);
    assert_eq!(texts(&a), vec!["一二", "三四", "五六"]);
    assert_eq!(a.repair_block_ids(), 0);
    assert_eq!(ids(&a), ids(&b));
}

#[test]
fn repair_is_deterministic_on_two_peers() {
    // A duplicated id (as a paste without id refresh would make) is fixed
    // to the same value by both peers.
    let a = ProseDoc::create("node:r", 1);
    a.insert_text(0, "甲");
    let c = a.split(1);
    a.insert_text(c, "乙");
    let dup = ids(&a)[0].clone();
    a.set_block_attr(a.len() - 1, block::ID, Some(dup.as_str().into()));
    a.doc.commit();
    let b = ProseDoc::create("node:r", 2);
    sync(&a.doc, &b.doc);
    assert_eq!(a.repair_block_ids(), 1);
    assert_eq!(b.repair_block_ids(), 1);
    a.doc.commit();
    b.doc.commit();
    sync(&a.doc, &b.doc);
    sync(&b.doc, &a.doc);
    assert_eq!(ids(&a), ids(&b));
    assert_eq!(a.repair_block_ids(), 0);
}

#[test]
fn anchors_exclude_edge_typing_and_collapse_on_delete() {
    let p = ProseDoc::create("node:a", 7);
    p.insert_text(0, "零一二三四五六七八九");
    let a = Anchor::new(&p.text(), 3..6).unwrap();
    let r = a.resolve(&p.doc).unwrap();
    assert_eq!(
        (r.range.clone(), r.collapsed, r.updated.is_none()),
        (3..6, false, true)
    );
    p.insert_text(6, "后");
    p.insert_text(3, "前");
    let r = a.resolve(&p.doc).unwrap();
    assert_eq!(
        p.text().slice(r.range.start, r.range.end).unwrap(),
        "三四五"
    );
    p.insert_text(5, "中");
    let r = a.resolve(&p.doc).unwrap();
    assert_eq!(
        p.text().slice(r.range.start, r.range.end).unwrap(),
        "三中四五"
    );
    // Delete the tail: the anchor shrinks.
    p.delete(7..8);
    let r = a.resolve(&p.doc).unwrap();
    assert_eq!(
        p.text().slice(r.range.start, r.range.end).unwrap(),
        "三中四"
    );
    let a = r.updated.unwrap();
    // Delete everything anchored: it collapses where the text was.
    p.delete(4..7);
    p.doc.commit();
    let r = a.resolve(&p.doc).unwrap();
    assert!(r.collapsed);
    assert_eq!(r.range, 4..4);
    let point = r.updated.unwrap();
    assert!(point.is_point());
    p.insert_text(0, "头");
    assert_eq!(point.resolve(&p.doc).unwrap().range, 5..5);
}

#[test]
fn anchor_does_not_come_back_after_undo() {
    // Undo re-inserts deleted text with new op ids, so cursors on the old
    // characters stay where the deletion was. The editor has to carry
    // anchors through its own undo (UndoItemMeta) if it wants them back.
    let p = ProseDoc::create("node:au", 7);
    p.insert_text(0, "零一二三四五");
    p.doc.commit();
    let a = Anchor::new(&p.text(), 2..4).unwrap();
    let mut um = UndoManager::new(&p.doc);
    p.delete(1..5);
    p.doc.commit();
    um.undo().unwrap();
    assert_eq!(p.text().to_string(), "零一二三四五\n");
    let r = a.resolve(&p.doc).unwrap();
    assert!(r.collapsed, "anchor stays collapsed: {r:?}");
}

#[test]
fn anchors_survive_merge_and_storage() {
    let a = ProseDoc::create("node:as", 1);
    a.insert_text(0, "甲乙丙丁戊己");
    a.doc.commit();
    let b = ProseDoc::create("node:as", 2);
    sync(&a.doc, &b.doc);
    let anchor = Anchor::new(&a.text(), 1..4).unwrap();
    let (s, e) = anchor.encode();
    let anchor = Anchor::decode(&s, &e).unwrap();
    b.insert_text(2, "插");
    b.doc.commit();
    a.insert_text(0, "前");
    a.doc.commit();
    sync(&b.doc, &a.doc);
    sync(&a.doc, &b.doc);
    let ra = anchor.resolve(&a.doc).unwrap();
    let rb = anchor.resolve(&b.doc).unwrap();
    assert_eq!(ra, rb);
    assert_eq!(
        a.text().slice(ra.range.start, ra.range.end).unwrap(),
        "乙插丙丁"
    );
}

#[test]
fn entity_links_overlap_and_do_not_expand() {
    let p = ProseDoc::create("node:l", 7);
    p.insert_text(0, "安娜卡列尼娜来了");
    p.link_entity(0..6, "el-anna", "element");
    p.link_entity(2..6, "el-karenina", "element");
    let links = entity_links(&p.text());
    assert_eq!(
        links,
        vec![
            (0..6, "el-anna".to_string()),
            (2..6, "el-karenina".to_string())
        ]
    );
    // Typing right after or right before a link does not extend it.
    p.insert_text(6, "啊");
    p.insert_text(0, "看");
    let links = entity_links(&p.text());
    assert_eq!(
        links,
        vec![
            (1..7, "el-anna".to_string()),
            (3..7, "el-karenina".to_string())
        ]
    );
    // Typing inside a link is part of it.
    p.insert_text(2, "·");
    assert_eq!(entity_links(&p.text())[0], (1..8, "el-anna".to_string()));
    // A link across a paragraph break never marks the newline.
    let c = p.split(5);
    assert!(c > 0);
    for para in p.paragraphs() {
        assert!(para.attrs.keys().all(|k| !k.starts_with("entity")));
    }
    p.unlink_entity(0..p.len(), "el-karenina");
    assert!(entity_links(&p.text()).iter().all(|(_, t)| t == "el-anna"));
}

#[test]
fn embeds_are_placeholders_with_side_entries() {
    let p = ProseDoc::create("material:e", 7);
    p.insert_text(0, "前文");
    let c = p.split(2);
    p.insert_text(c, "后文");
    let table = p.insert_embed(c, "tbl-1", "table");
    let rows = table.ensure_mergeable_map("rows").unwrap();
    let cell = rows
        .ensure_mergeable_map("r0")
        .unwrap()
        .ensure_mergeable_map("cells")
        .unwrap()
        .ensure_mergeable_text("c0")
        .unwrap();
    cell.insert(0, "格子").unwrap();
    p.doc.commit();
    let texts: Vec<String> = p.paragraphs().iter().map(|x| x.text()).collect();
    assert_eq!(
        texts,
        vec!["前文".to_string(), "\u{FFFC}".into(), "后文".into()]
    );
    assert_eq!(p.embed_refs(), vec![(3, "tbl-1".to_string())]);
    // Concurrent cell creation merges into one cell text.
    let q = ProseDoc::create("material:e", 8);
    sync(&p.doc, &q.doc);
    let cell_q = q
        .embeds()
        .ensure_mergeable_map("tbl-1")
        .unwrap()
        .ensure_mergeable_map("rows")
        .unwrap()
        .ensure_mergeable_map("r1")
        .unwrap()
        .ensure_mergeable_map("cells")
        .unwrap()
        .ensure_mergeable_text("c0")
        .unwrap();
    cell_q.insert(0, "乙").unwrap();
    q.doc.commit();
    let cell_p = rows
        .ensure_mergeable_map("r1")
        .unwrap()
        .ensure_mergeable_map("cells")
        .unwrap()
        .ensure_mergeable_text("c0")
        .unwrap();
    cell_p.insert(0, "甲").unwrap();
    p.doc.commit();
    sync(&q.doc, &p.doc);
    sync(&p.doc, &q.doc);
    let v = cell_p.to_string();
    assert!(v == "甲乙" || v == "乙甲", "{v}");
    // Deleting the placeholder leaves the entry (undo can bring it back).
    let mut um = UndoManager::new(&p.doc);
    p.delete(3..5);
    p.doc.commit();
    assert!(p.embed_refs().is_empty());
    assert!(p.embeds().get("tbl-1").is_some());
    um.undo().unwrap();
    assert_eq!(p.embed_refs(), vec![(3, "tbl-1".to_string())]);
}

#[test]
fn peers_persist_per_doc_and_rotate_with_the_epoch() {
    let dir = scratch("peers");
    let path = dir.join("lib.sqlite");
    let p1 = {
        let s = Store::open(&path, Durability::Normal).unwrap();
        let a = s.peer_for("node:1").unwrap();
        let b = s.peer_for("node:2").unwrap();
        assert_ne!(a, b);
        assert_eq!(s.peer_for("node:1").unwrap(), a);
        a
    };
    let mut s = Store::open(&path, Durability::Normal).unwrap();
    assert_eq!(s.peer_for("node:1").unwrap(), p1);
    s.rotate_epoch().unwrap();
    assert_ne!(s.peer_for("node:1").unwrap(), p1);
}

#[test]
fn store_round_trip_with_compaction() {
    let dir = scratch("store");
    let path = dir.join("lib.sqlite");
    let store = Store::open(&path, Durability::Normal).unwrap();
    let doc_id = "node:s";
    let prose = ProseDoc::create(doc_id, store.peer_for(doc_id).unwrap());
    store.register(doc_id, "chapter").unwrap();
    let mut h = Holder::new(doc_id, prose.doc.clone());
    // The genesis is persisted like any update.
    h.flush(&store, "genesis").unwrap();
    for i in 0..30 {
        prose.insert_text(prose.len() - 1, &format!("字{i}"));
        h.commit(&store, "user").unwrap();
        if i == 15 {
            let c = store.compact(doc_id, &prose.doc).unwrap();
            assert_eq!(c.deleted_updates, 17);
        }
    }
    assert_eq!(store.pending(doc_id).unwrap().0, 14);
    drop(store);
    let store = Store::open(&path, Durability::Normal).unwrap();
    let loaded = store.load_for_edit(doc_id).unwrap().unwrap();
    assert_eq!(
        loaded.get_text("body").to_string(),
        prose.text().to_string()
    );
    assert_eq!(loaded.peer_id(), store.peer_for(doc_id).unwrap());
    // Origins are recorded per update row.
    let n: i64 = store
        .conn
        .query_row(
            "SELECT count(*) FROM loro_update WHERE origin = 'user'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 14);
}

#[test]
fn agent_writes_carry_a_durable_message() {
    let p = ProseDoc::create("node:ag", 7);
    p.insert_text(0, "正文");
    p.doc.commit();
    let origin = agent::agent_origin("sess", 3);
    agent::write_in_place(&p, &origin, |p| p.insert_text(0, "甲"));
    let id = p
        .text()
        .get_cursor(0, loro::cursor::Side::Middle)
        .unwrap()
        .id
        .unwrap();
    assert_eq!(
        agent::message_of(&p.doc, id).as_deref(),
        Some(origin.as_str())
    );
    agent::write_forked(&p, &origin, 4242, |p| p.insert_text(0, "乙"));
    let id = p
        .text()
        .get_cursor(0, loro::cursor::Side::Middle)
        .unwrap()
        .id
        .unwrap();
    assert_eq!(id.peer, 4242);
    assert_eq!(
        agent::message_of(&p.doc, id).as_deref(),
        Some(origin.as_str())
    );
    // The message survives a snapshot round trip.
    let snap = p.doc.export(ExportMode::Snapshot).unwrap();
    let q = LoroDoc::from_snapshot(&snap).unwrap();
    assert_eq!(agent::message_of(&q, id).as_deref(), Some(origin.as_str()));
}

#[test]
fn book_entities_merge_when_created_twice() {
    let a = Book::create("b1", 1);
    let b = Book::create("b1", 2);
    a.put(schema::book::ELEMENTS, "el-1", vec![("name", "安".into())]);
    a.doc.commit();
    b.put(
        schema::book::ELEMENTS,
        "el-1",
        vec![("summary", "摘要".into())],
    );
    b.doc.commit();
    sync(&a.doc, &b.doc);
    sync(&b.doc, &a.doc);
    let m = a.entity(schema::book::ELEMENTS, "el-1").unwrap();
    let v = m.get_deep_value();
    let LoroValue::Map(v) = v else { panic!() };
    assert!(v.get("name").is_some() && v.get("summary").is_some());
    // The built-in relation type exists exactly once.
    assert_eq!(a.doc.get_map(schema::book::RELATION_TYPES).len(), 1);
}

#[test]
fn undo_cases_in_our_usage() {
    let cases = undo_cases::run_all();
    for c in &cases {
        println!(
            "{:7} wrong={:5} ours={:5} steps={} {} | expected {:?} actual {:?}",
            c.issue,
            c.wrong(),
            c.our_usage,
            c.undo_steps,
            c.name,
            c.expected,
            c.actual
        );
    }
    // What the editor relies on: author Undo never removes Agent text, and
    // merge interval 0 with editor-side bursts restores the text.
    for c in &cases {
        let relied_on = c.issue == "—" || c.name.starts_with("merge interval 0");
        if relied_on {
            assert!(!c.wrong(), "{}", c.name);
        }
    }
    // Known Loro 1.17.1 bugs, pinned so that a Loro upgrade that fixes them
    // fails here and the schema / spike documents get updated.
    let wrong: Vec<&str> = cases.iter().filter(|c| c.wrong()).map(|c| c.name).collect();
    assert_eq!(
        wrong,
        vec![
            "heading set by author, changed by another device, author undoes",
            "heading set by author, changed by an in-place Agent write, author undoes",
            "author sets a link, another device changes it, author undoes",
            "manual undo group around two Backspaces, remote map change in between",
            "manual group: type x, it syncs, retype as y, remote dependent change, undo",
            "merge interval: type x, it syncs, retype as y, remote dependent change, undo",
            "forked Agent write imported after the author retyped inside the merge interval",
        ]
    );
}

#[test]
fn bulk_and_typed_seeds_share_the_corpus() {
    let cfg = SeedConfig::tiny();
    let a = seed::generate(&cfg, History::Bulk);
    let b = seed::generate(&cfg, History::Typed);
    assert_eq!(a.stats.corpus_sha256, b.stats.corpus_sha256);
    assert!(b.stats.commits > a.stats.commits * 10);
    assert_eq!(a.stats.chapter_max, cfg.chapter_max);
}
