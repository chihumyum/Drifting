//! The whole import on a synthetic 0.1 library (`common`), into a real
//! dr-store library, read back through dr-doc.

mod common;

use common::*;
use dr_doc::Anchor;
use dr_doc::peer::{import_peer, random_device_peer};
use dr_doc::prose::{EmbedView, ProseDoc};
use dr_doc::v3::novel::*;
use dr_doc::v3::{BookDocV3 as BookDoc, BookReaderV3 as BookReader, BookViewV3 as BookView};
use dr_import_v1::gate::{Accept, Reason};
use dr_import_v1::legacy::Freshness;
use dr_import_v1::progress::{Progress, Step};
use dr_import_v1::receipt::{self, Receipt};
use dr_import_v1::run::{self, Options, Outcome};
use dr_model::id::*;
use dr_model::kind::*;
use dr_model::prose::Heading;
use dr_model::{DocId, Timestamp};
use dr_store::history::LabelRetention;
use dr_store::{Library, LibraryOptions};

struct New {
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
    device: std::path::PathBuf,
}

fn new_library() -> New {
    let dir = tempfile::tempdir().unwrap();
    New {
        root: dir.path().join("library"),
        device: dir.path().join("device"),
        _dir: dir,
    }
}

fn options(old: &Old, new: &New, accept: Accept) -> Options {
    let mut o = Options::new("0.2.0-test");
    o.accept = accept;
    o.v3 = v3_choices();
    o.old_root = Some(old.root.clone());
    o.device_dir = Some(new.device.clone());
    o.verify_history = true;
    o
}

/// Open a library the import just closed. dr-store's lock is sometimes
/// still held for a moment after `Library::close` returns when many tests
/// run at once (reported to F2, `m10-import.md` 待协调); retry briefly.
fn open_library(root: &std::path::Path, options: LibraryOptions) -> Library {
    let started = std::time::Instant::now();
    loop {
        match Library::open(root, options.clone()) {
            Ok(lib) => return lib,
            Err(e)
                if e.to_string().contains("already open")
                    && started.elapsed() < std::time::Duration::from_secs(5) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) => panic!("{e}"),
        }
    }
}

fn imported(outcome: Outcome) -> Box<Receipt> {
    match outcome {
        Outcome::Imported(r) => r,
        Outcome::Blocked(g) => panic!("blocked: {:?}", g.reasons),
        Outcome::Cancelled => panic!("cancelled"),
    }
}

fn snapshot(lib: &Library, id: &str) -> Vec<u8> {
    lib.load_copy(id)
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap()
}

fn book_doc(lib: &Library) -> BookDoc {
    let book = BookId::parse(BOOK).unwrap();
    BookDoc::load(
        book,
        random_device_peer(),
        &[snapshot(lib, &format!("book:{BOOK}"))],
    )
    .unwrap()
}

fn prose_doc(lib: &Library, id: &str) -> ProseDoc {
    ProseDoc::load(
        DocId::parse(id).unwrap(),
        random_device_peer(),
        &[snapshot(lib, id)],
    )
    .unwrap()
}

fn text_at(doc: &ProseDoc, anchor: &dr_model::import_v1::EncodedAnchor) -> String {
    let a = Anchor::decode(anchor).unwrap();
    let r = doc.view().resolve(&a).unwrap();
    doc.view().text_in(r.range).unwrap()
}

fn sha_of(path: &std::path::Path) -> String {
    sha256_bytes(&std::fs::read(path).unwrap())
}

#[test]
fn a_handed_off_library_imports_completely() {
    let old = build_v3(true);
    let before = sha_of(&old.db);
    let new = new_library();
    let (outcome, _) =
        run::import(&old.db, &new.root, &options(&old, &new, Accept::NOTHING)).unwrap();
    let r = imported(outcome);
    assert_eq!(sha_of(&old.db), before, "the 0.1 library is never written");
    assert!(r.gate.clear());
    assert_eq!(r.books.len(), 1);
    assert_eq!(r.books[0].status, "imported");
    assert_eq!(
        r.docs.len(),
        6,
        "chapter, idea, storyline, element, category, note"
    );
    for d in &r.docs {
        assert!(d.stored_exactly, "{} stored exactly", d.doc_id);
        assert!(d.round_trips, "{} round-trips", d.doc_id);
        assert!(d.freshness.proven_fresh(), "{} {:?}", d.doc_id, d.freshness);
    }
    let chapter_rec = r
        .docs
        .iter()
        .find(|d| d.doc_id == format!("body:{CHAPTER}/mod-prose"))
        .unwrap();
    assert_eq!(chapter_rec.freshness, Freshness::Handoff);
    assert_eq!(chapter_rec.history_versions, 2);
    assert!(r.anchors.iter().all(|a| a.cursor), "{:?}", r.anchors);
    assert_eq!(
        r.anchors.len(),
        3,
        "the v4 comment, the block comment, the patch"
    );
    assert!(r.installation_id_adopted);
    assert_eq!(r.books[0].assets_copied, 1);

    let lib = open_library(&new.root, LibraryOptions::new("0.2.0-test"));
    let book = book_doc(&lib);
    let v: BookView<'_> = book.view();

    // The book, its targets from the handoff, its facts in projection order.
    let meta = v.meta();
    assert_eq!(meta.name, "阿Q正传");
    assert_eq!(meta.word_target(), Some(80000));
    assert_eq!(meta.daily_word_target(), None, "0 turns it off");
    let facts: Vec<String> = v.facts().into_iter().map(|f| f.key).collect();
    assert_eq!(facts, ["类型", "视角"]);
    let storyline_template = v
        .template(&EntryTemplateId::parse(TPL_STORYLINE).unwrap())
        .unwrap();
    assert_eq!(
        storyline_template
            .modules
            .iter()
            .find(|m| m.id.as_str() == MOD_KV)
            .unwrap()
            .config
            .initial_kv
            .len(),
        1
    );
    let chapter = v.entry(&EntryId::parse(CHAPTER).unwrap()).unwrap();
    assert_eq!(chapter.created_at, Some(Timestamp(1_790_841_600)));
    assert!(
        v.memberships_raw()
            .iter()
            .any(|m| m.host.as_str() == STORYLINE && m.member.as_str() == CHAPTER)
    );
    assert_eq!(
        chapter.primary.as_ref().map(|id| id.as_str()),
        Some(STORYLINE)
    );
    let idea = v.entry(&EntryId::parse(IDEA).unwrap()).unwrap();
    assert_eq!(idea.parent.as_ref().map(|id| id.as_str()), Some(SUBGROUP));
    assert_eq!(idea.layout.board, Some((120.5, -40.0)));
    let subgroup = v.entry(&EntryId::parse(SUBGROUP).unwrap()).unwrap();
    assert_eq!(subgroup.parent.as_ref().map(|id| id.as_str()), Some(GROUP));
    let element = v.entry(&EntryId::parse(ELEMENT).unwrap()).unwrap();
    assert_eq!(element.layout.relation_graph, Some((12.5, -40.0)));
    let templates = v.templates_map();
    assert!(element.aliases(&templates).iter().any(|a| a == "阿贵"));
    assert!(element.aliases(&templates).iter().any(|a| a == "阿桂"));
    // Body templates: the 0.1 fields stay as they were and are written into
    // their template documents, headings, marks and links included.
    assert_eq!(r.books[0].templates, 2);
    let cat_t = prose_doc(
        &lib,
        &dr_samples::v3::prose_id(
            &BookId::parse(BOOK).unwrap(),
            &DocId::Template(TemplateId::for_category(
                &CategoryId::parse(CATEGORY).unwrap(),
            )),
        )
        .to_string(),
    );
    let paras: Vec<_> = cat_t.view().paragraphs().collect();
    assert_eq!(paras.len(), 2);
    assert_eq!(paras[0].attrs.heading, Some(Heading::H1));
    assert_eq!(paras[0].text(), "外貌");
    assert_eq!(paras[1].text(), "像阿Q那样");
    let linked = paras[1]
        .runs
        .iter()
        .find(|r| r.text == "阿Q")
        .expect("the linked run");
    assert_eq!(linked.marks.entities.len(), 1);
    assert_eq!(linked.marks.entities[0].target, ELEMENT);
    let line_t = prose_doc(
        &lib,
        &dr_samples::v3::prose_id(
            &BookId::parse(BOOK).unwrap(),
            &DocId::Template(TemplateId::for_storyline(
                &StorylineId::parse(STORYLINE).unwrap(),
            )),
        )
        .to_string(),
    );
    let paras: Vec<_> = line_t.view().paragraphs().collect();
    assert_eq!(paras[0].attrs.heading, Some(Heading::H2));
    assert_eq!(paras[0].text(), "开端");
    assert!(
        paras[1]
            .runs
            .iter()
            .any(|r| r.text == "冲突：" && r.marks.bold)
    );
    assert!(
        lib.doc_info(
            &dr_samples::v3::prose_id(
                &BookId::parse(BOOK).unwrap(),
                &DocId::Template(TemplateId::for_storyline(
                    &StorylineId::parse(STORYLINE).unwrap()
                ))
            )
            .to_string()
        )
        .unwrap()
        .is_some(),
        "registered, so F3 copies it into new chapters"
    );

    // Relation types and relations.
    let rt = v
        .relation_type(&RelationTypeId::parse(REL_TYPE).unwrap())
        .unwrap();
    assert_eq!(rt.color.as_deref(), Some("#aa5500"));
    assert_eq!(rt.orientation, RelationOrientation::Symmetric);
    assert_eq!(rt.source_kinds, [EntityKind::Entry]);
    let generic = v
        .relation_type(&dr_doc::catalog::generic_relation_type_id(
            &BookId::parse(BOOK).unwrap(),
        ))
        .unwrap();
    assert!(generic.locked, "the built-in type is the genesis one");
    let rels = v.relations_raw();
    assert!(
        !rels.iter().any(|x| x.id.as_str() == "rel-1"),
        "positive source omits its known dangling fixture edge"
    );
    let note_doc = DocId::Material(MaterialId::parse(NOTE).unwrap());
    let note_todo = CommentId::for_projection(
        &ProjectionKind::NoteTask,
        &note_doc,
        &BlockId::parse("tp1").unwrap(),
    );
    let rel2 = rels.iter().find(|x| x.id.as_str() == "rel-2").unwrap();
    assert_eq!(rel2.from.kind, EntityKind::Comment);
    assert_eq!(
        rel2.from.id,
        note_todo.as_str(),
        "relations follow the TODO's new id"
    );

    // Comments: retired values normalised, quote and snapshots, anchors.
    let chapter_doc = prose_doc(&lib, &format!("body:{CHAPTER}/mod-prose"));
    let c = v.comment(&CommentId::parse(COMMENT).unwrap()).unwrap();
    assert_eq!(c.author_kind, CommentAuthorKind::Ai);
    assert_eq!(c.status, CommentStatus::Resolved);
    assert_eq!(c.source, CommentSource::Api);
    assert_eq!(c.quote.as_deref(), Some("阿Q做正传"));
    assert_eq!(c.snapshots.len(), 1);
    assert_eq!(c.body, "这句好");
    assert_eq!(
        text_at(&chapter_doc, c.anchor.as_ref().unwrap()),
        "阿Q做正传"
    );
    let bc = v
        .comment(&CommentId::parse(BLOCK_COMMENT).unwrap())
        .unwrap();
    assert_eq!(
        bc.target_block.as_ref().map(|b| b.as_str()),
        Some("q1"),
        "a container id is remapped"
    );
    assert_eq!(
        text_at(&chapter_doc, bc.anchor.as_ref().unwrap()),
        "引文第一段\n引文第二段"
    );
    assert_eq!(bc.priority, Some(CommentPriority::High));
    let t = v.comment(&note_todo).unwrap();
    assert_eq!(t.projection.as_ref().map(|p| p.block.as_str()), Some("tp1"));
    assert_eq!(t.target_block.as_ref().map(|b| b.as_str()), Some("tp1"));
    assert!(
        v.comment(&CommentId::parse(NOTE_TODO).unwrap()).is_none(),
        "the old id is gone"
    );
    let marker = CommentId::for_projection(
        &ProjectionKind::Marker,
        &dr_samples::v3::body_id(CHAPTER, MOD_PROSE),
        &BlockId::parse("p2").unwrap(),
    );
    let m = v.comment(&marker).unwrap();
    assert_eq!(m.agent_conversation.as_deref(), Some("conv-1"));
    assert!(m.is_done());
    let region = v.comment(&CommentId::parse("region-1").unwrap()).unwrap();
    assert_eq!(region.region.map(|r| r.w), Some(0.3));

    // The patch, its anchor in the chapter.
    let patch = v
        .patches()
        .into_iter()
        .find(|p| p.id.as_str() == PATCH)
        .unwrap();
    assert_eq!(patch.source_block.as_ref().map(|b| b.as_str()), Some("q2"));
    assert_eq!(patch.body, "见《新青年》");
    assert_eq!(
        text_at(&chapter_doc, patch.anchor.as_ref().unwrap()),
        "引文"
    );

    // Materials, folders, the asset, its bytes.
    let mats = v.materials();
    let note = mats.iter().find(|m| m.id.as_str() == NOTE).unwrap();
    assert_eq!(note.folder.as_ref().map(|f| f.as_str()), Some(FOLDER));
    assert!(note.task_todos);
    let image = mats.iter().find(|m| m.id.as_str() == IMAGE).unwrap();
    assert_eq!(image.description, "未庄的土谷祠");
    assert!(
        mats.iter().position(|m| m.id.as_str() == IMAGE)
            < mats.iter().position(|m| m.id.as_str() == NOTE),
        "order_key 0 before 1"
    );
    assert_eq!(v.assets()[0].sha256, sha256_bytes(IMAGE_BYTES));
    let stored = lib
        .asset(ASSET, dr_store::asset::Variant::Source)
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read(&stored.path).unwrap(), IMAGE_BYTES);

    // Memory, writing days, time pins, acts, plot grid.
    assert_eq!(
        v.memory()[0].target_block.as_ref().map(|b| b.as_str()),
        Some("q1")
    );
    let wd = v.writing_days();
    assert_eq!((wd[0].device.as_str(), wd[0].words), (DEVICE_KEY, 1234));
    let view = v.timeline_views_raw().into_iter().next().unwrap();
    assert_eq!(
        view.pins[0].entry.as_ref().map(|id| id.as_str()),
        Some(IDEA)
    );
    let grid = v
        .plot_grid(
            &EntryId::parse(CHAPTER).unwrap(),
            &ModuleId::parse("mod-plot-grid").unwrap(),
        )
        .unwrap();
    let rows: Vec<&str> = grid.rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(rows, ["r1", "r2"]);
    assert_eq!(
        grid.rows[0].pos.as_ref().map(|p| p.as_str()),
        Some("a0"),
        "position keys kept"
    );
    assert_eq!(grid.cells.len(), 1);

    // Prose: block ids, links, the note's linked task and material embed.
    let paras: Vec<_> = chapter_doc.view().paragraphs().collect();
    let ids: Vec<&str> = paras
        .iter()
        .filter_map(|p| p.id.as_ref().map(|b| b.as_str()))
        .collect();
    assert_eq!(ids, ["h1", "p1", "q1", "q2", "p2"]);
    assert!(paras[2].attrs.quote);
    assert_eq!(chapter_doc.view().entity_links()[0].1.target, ELEMENT);
    let note_prose = prose_doc(&lib, &format!("material:{NOTE}"));
    let np: Vec<_> = note_prose.view().paragraphs().collect();
    assert_eq!(np[0].attrs.todo.as_ref(), Some(&note_todo));
    assert!(np[1].attrs.checked);
    let embed = np[2].embed().cloned().unwrap();
    assert!(
        matches!(note_prose.view().embed(&embed), Some(EmbedView::Material { material: Some(m), .. }) if m.as_str() == IMAGE)
    );

    // History: two replayed points with their 0.1 times, plus the import,
    // all kept from the 30-day retention.
    let chapter_id = format!("body:{CHAPTER}/mod-prose");
    let labels = lib.history(&chapter_id).unwrap();
    let periodic: Vec<_> = labels.iter().filter(|l| l.label == "periodic").collect();
    assert_eq!(periodic.len(), 2);
    assert!(labels.iter().any(|l| l.label == "import"));
    assert!(
        labels.iter().filter(|l| l.label != "close").all(|l| l.keep),
        "imported points are kept (dr-store's own close label is not ours)"
    );
    let oldest = periodic.iter().min_by_key(|l| l.ts).unwrap();
    assert_eq!(oldest.ts, dr_import_v1::time::parse_iso_ms(T0).unwrap());
    let back = lib.load_copy_at(&chapter_id, &oldest.frontiers).unwrap();
    assert_eq!(
        back.get_text("body").to_string(),
        "第一章\n我要给阿Q做正传。\n"
    );
    assert_eq!(r.books[0].history_meta_replayed, 3);
    assert_eq!(r.books[0].history_meta_checked, 3);

    // The metadata at each point is what 0.1 kept with the row: restoring an
    // object from a point reads its fields from the book at `book_frontiers`.
    let book_at = |label: &dr_store::history::HistoryLabel| -> BookReader {
        BookReader::load_at(
            BookId::parse(BOOK).unwrap(),
            &[snapshot(&lib, &format!("book:{BOOK}"))],
            label
                .book_frontiers
                .as_ref()
                .expect("labels carry the book's version"),
        )
        .unwrap()
    };
    let chapter_node = EntryId::parse(CHAPTER).unwrap();
    let at = |label: &dr_store::history::HistoryLabel| {
        let n = book_at(label).view().entry(&chapter_node).unwrap();
        let summary = n
            .fields
            .get(&ModuleId::parse(MOD_FIELDS).unwrap())
            .and_then(|m| m.get("summary"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned();
        (n.title, summary)
    };
    let newest = periodic.iter().max_by_key(|l| l.ts).unwrap();
    assert_eq!(at(oldest), ("第一章".into(), "初稿梗概".into()));
    assert_eq!(
        at(newest),
        ("第一章 序".into(), "初稿梗概".into()),
        "a field the row did not carry stays as the earlier row had it"
    );
    let element_points = lib.history(&format!("body:{ELEMENT}/mod-prose")).unwrap();
    let ep = element_points
        .iter()
        .find(|l| l.label == "periodic")
        .unwrap();
    let historical = book_at(ep);
    let el_then = historical
        .view()
        .entry(&EntryId::parse(ELEMENT).unwrap())
        .unwrap();
    assert_eq!(
        el_then.aliases(&historical.view().templates_map()),
        std::collections::BTreeSet::from(["阿贵".to_owned()])
    );
    let parent = historical
        .view()
        .entry(el_then.parent.as_ref().unwrap())
        .unwrap();
    assert_eq!(parent.title, "未庄");
    let facts = el_then.kv.get(&ModuleId::parse(MOD_KV).unwrap()).unwrap();
    assert_eq!(facts[0].id.as_str(), "kv-6");
    assert_eq!(
        (facts[0].key.as_str(), facts[0].value.as_str()),
        ("住处", "破庙")
    );
    assert_eq!(
        (facts[1].key.as_str(), facts[1].value.as_str()),
        ("绰号", "阿Q")
    );
    // Every change is the import peer's (or the genesis').
    let doc = lib.load_copy(&chapter_id).unwrap();
    let peers: std::collections::BTreeSet<u64> = dr_store::history::changes_since(&doc, 0)
        .into_iter()
        .map(|c| c.peer)
        .collect();
    assert!(peers.contains(&import_peer(&chapter_id)));
    assert!(
        peers
            .iter()
            .all(|p| *p == import_peer(&chapter_id) || !dr_doc::peer::is_device_peer(*p))
    );
    lib.close().unwrap();

    // The receipt in the library (dr-store `0001`); the archive, the local
    // state and the summary beside it.
    let library_db = rusqlite::Connection::open(dr_store::LibraryPaths::new(&new.root).db).unwrap();
    let in_library = |sql: &str| -> i64 { library_db.query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(in_library("SELECT count(*) FROM import_run"), 1);
    assert_eq!(in_library("SELECT count(*) FROM import_doc"), 6);
    assert_eq!(
        in_library("SELECT count(*) FROM import_anchor WHERE cursor = 1"),
        3
    );
    let dir = receipt::directory(&new.root);
    let conn = rusqlite::Connection::open(dir.join(receipt::DATABASE)).unwrap();
    let n = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(
        n("SELECT count(*) FROM sqlite_schema WHERE name LIKE 'import_%'"),
        0,
        "the receipt is no longer in the archive"
    );
    assert_eq!(n("SELECT count(*) FROM archive_agent_conversation"), 1);
    assert_eq!(
        n("SELECT count(*) FROM local_setting WHERE key = 'settings-storage'"),
        1
    );
    assert_eq!(
        n("SELECT count(*) FROM local_library_state WHERE key = 'v2-handoff'"),
        1
    );
    let summary = std::fs::read_to_string(dir.join(receipt::SUMMARY)).unwrap();
    assert!(summary.contains("阿Q正传") && summary.contains("一字不差"));
    assert!(summary.contains("当时的标题"));
    assert!(!dir.join("staging").exists(), "the staging copy is removed");
    let identity = std::fs::read_to_string(new.device.join("sync-installation-v2.json")).unwrap();
    assert!(
        identity.contains(&"ab".repeat(32)),
        "writing days continue under the 0.1 device"
    );
}

#[test]
fn without_handoff_the_gate_stops_until_the_author_accepts() {
    let old = build_v3(false);
    let new = new_library();
    let (outcome, _) =
        run::import(&old.db, &new.root, &options(&old, &new, Accept::NOTHING)).unwrap();
    let Outcome::Blocked(gate) = outcome else {
        panic!("not stopped")
    };
    assert_eq!(gate.reasons, vec![Reason::NoHandoff, Reason::Unproven]);
    let titles: Vec<_> = gate
        .doubtful
        .iter()
        .filter_map(|d| d.title.clone())
        .collect();
    assert_eq!(titles.len(), 2);
    assert!(titles.contains(&"阿Q".to_string()) && titles.contains(&"主线".to_string()));
    // The dialog groups them by book and tells chapters from ideas.
    assert!(
        gate.doubtful
            .iter()
            .all(|d| d.book_name.as_deref() == Some("阿Q正传") && !d.drift)
    );
    assert!(!new.root.join("library.sqlite").exists(), "nothing written");
    assert_eq!(gate.release_url, dr_import_v1::gate::LAST_RELEASE_URL);

    let (outcome, _) = run::import(
        &old.db,
        &new.root,
        &options(
            &old,
            &new,
            Accept {
                unproven_bodies: true,
                sync_blockers: false,
            },
        ),
    )
    .unwrap();
    let r = imported(outcome);
    let unproven: Vec<_> = r
        .docs
        .iter()
        .filter(|d| d.freshness == Freshness::Unproven)
        .collect();
    assert_eq!(unproven.len(), 2);
    let chapter = r
        .docs
        .iter()
        .find(|d| d.doc_id == format!("body:{CHAPTER}/mod-prose"))
        .unwrap();
    assert_eq!(chapter.freshness, Freshness::NodeBasisCurrent);
    let summary =
        std::fs::read_to_string(receipt::directory(&new.root).join(receipt::SUMMARY)).unwrap();
    assert!(summary.contains("无法证明是最新"));
}

#[test]
fn a_book_is_imported_once() {
    let old = build_v3(true);
    let new = new_library();
    imported(
        run::import(&old.db, &new.root, &options(&old, &new, Accept::NOTHING))
            .unwrap()
            .0,
    );
    let again = imported(
        run::import(&old.db, &new.root, &options(&old, &new, Accept::NOTHING))
            .unwrap()
            .0,
    );
    assert_eq!(again.books[0].status, "already-imported");
    assert!(again.docs.is_empty());
}

#[test]
fn independent_targets_keep_identical_source_prose_operations_and_catalog_semantics() {
    let old = build_v3(true);
    let (a, b) = (new_library(), new_library());
    for n in [&a, &b] {
        imported(
            run::import(&old.db, &n.root, &options(&old, n, Accept::NOTHING))
                .unwrap()
                .0,
        );
    }
    let rows = |n: &New| -> Vec<(String, Vec<u8>)> {
        let conn = rusqlite::Connection::open(dr_store::LibraryPaths::new(&n.root).db).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT doc_id, bytes FROM loro_update WHERE origin = 'import' ORDER BY doc_id",
            )
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    let (ra, rb) = (rows(&a), rows(&b));
    // Source-stable prose identities and their complete operation bytes are
    // deterministic. Catalog roots, synthetic groups and timeline identities
    // are allocated afresh for each new target; compare their entire catalog
    // under that explicit bijection, including unknown metadata and order.
    let prose = |rows: Vec<(String, Vec<u8>)>| {
        rows.into_iter()
            .filter(|(id, _)| !id.starts_with("book:"))
            .collect::<Vec<_>>()
    };
    assert!(ra.len() >= 9);
    assert_eq!(prose(ra), prose(rb));
    assert_eq!(catalog_state(&a), catalog_state(&b));
}

#[test]
fn an_older_library_is_brought_up_on_its_copy() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("drifting-library.db");
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        dr_import_v1::schema::create_at(&conn, 12).unwrap();
        conn.execute(
            "INSERT INTO project (id, name, summary, kv_json, storyline_template_kv_json, user_id, created_at, updated_at) VALUES (?1, '旧书', '', '[]', '[]', 'local', ?2, ?2)",
            rusqlite::params![BOOK, T0],
        )
        .unwrap();
    }
    let before = sha_of(&db);
    let new = new_library();
    let mut o = Options::new("0.2.0-test");
    o.device_dir = Some(new.device.clone());
    let r = imported(run::import(&db, &new.root, &o).unwrap().0);
    assert_eq!(r.schema_level_before, 12);
    assert_eq!(r.books[0].status, "imported");
    assert_eq!(sha_of(&db), before);
}

#[test]
fn the_import_reports_its_progress() {
    let old = build_v3(true);
    let new = new_library();
    let mut seen: Vec<Progress> = Vec::new();
    imported(
        run::import_with(
            &old.db,
            &new.root,
            &options(&old, &new, Accept::NOTHING),
            &mut |p| seen.push(p.clone()),
        )
        .unwrap()
        .0,
    );
    let mut steps: Vec<Step> = seen.iter().map(|p| p.step).collect();
    steps.dedup();
    assert_eq!(
        steps,
        [
            Step::Copying,
            Step::Checking,
            Step::Bodies,
            Step::Book,
            Step::Assets,
            Step::Finishing,
            Step::Indexing,
            Step::Done
        ]
    );
    assert!(seen.windows(2).all(|w| w[0].overall <= w[1].overall));
    assert_eq!(seen.last().unwrap().overall, 1.0);
    let bodies: Vec<&Progress> = seen.iter().filter(|p| p.step == Step::Bodies).collect();
    assert_eq!(bodies.len(), 6, "one report per body");
    assert_eq!((bodies[5].done, bodies[5].total), (6, 6));
    assert_eq!((bodies[0].book, bodies[0].books), (1, 1));
    assert_eq!(bodies[0].book_name, "阿Q正传");
    let copying = seen.iter().rev().find(|p| p.step == Step::Copying).unwrap();
    assert!(copying.total > 0 && copying.done == copying.total);
    let indexing = seen
        .iter()
        .rev()
        .find(|p| p.step == Step::Indexing)
        .unwrap();
    assert_eq!(
        (indexing.done, indexing.total),
        (9, 9),
        "six bodies, two templates and the book"
    );
}

#[test]
fn an_imported_library_has_its_indexes() {
    let old = build_v3(true);
    let new = new_library();
    let (outcome, timing) =
        run::import(&old.db, &new.root, &options(&old, &new, Accept::NOTHING)).unwrap();
    imported(outcome);
    assert_eq!(
        timing.indexed_docs, 9,
        "six bodies, two templates, the book"
    );
    let mut o = LibraryOptions::new("0.2.0-test");
    dr_index::attach(&mut o);
    o.rebuild_indexes_on_open = false;
    let lib = open_library(&new.root, o);
    assert!(lib.stale_index_docs().unwrap().is_empty());
    let chapter = format!("body:{CHAPTER}/mod-prose");
    // 第一章 序 / 我要给阿Q做正传，已经不止一两年了。 / 引文第一段 / 引文第二段 /
    // TODO: 查一查赵太爷的年纪
    assert_eq!(
        lib.doc_stats(&chapter).unwrap().unwrap().words,
        4 + 16 + 5 + 5 + 10
    );
    let outline: Vec<(u8, String)> = lib
        .outline(&chapter)
        .unwrap()
        .into_iter()
        .map(|o| (o.heading, o.text))
        .collect();
    assert_eq!(outline, vec![(1, "第一章 序".into())]);
    let hits = lib.search(Some(BOOK), "赵太爷", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].block_id.as_deref(), Some("p2"));
    assert!(lib.book_stats(BOOK).unwrap().words > 0);
    lib.close().unwrap();
}

#[test]
fn replaying_the_history_leaves_the_book_as_it_is_now() {
    let with = build_v3(true);
    let without = build_v3(true);
    {
        let conn = rusqlite::Connection::open(&without.db).unwrap();
        conn.execute("DELETE FROM entity_snapshot_history", [])
            .unwrap();
    }
    let (a, b) = (new_library(), new_library());
    imported(
        run::import(&with.db, &a.root, &options(&with, &a, Accept::NOTHING))
            .unwrap()
            .0,
    );
    imported(
        run::import(
            &without.db,
            &b.root,
            &options(&without, &b, Accept::NOTHING),
        )
        .unwrap()
        .0,
    );
    let (mut va, mut vb) = (catalog_state(&a), catalog_state(&b));
    // Cursor bytes refer to different prose operation histories. Their exact
    // resolved text is checked below; every other authored value is compared.
    for catalog in [&mut va, &mut vb] {
        fn cursor(v: &mut serde_json::Value) {
            match v {
                serde_json::Value::Object(m) => {
                    if let Some(a) = m.get_mut("anchor").and_then(|v| v.as_object_mut()) {
                        a.remove("start");
                        a.remove("end");
                    }
                    for v in m.values_mut() {
                        cursor(v);
                    }
                }
                serde_json::Value::Array(a) => {
                    for v in a {
                        cursor(v);
                    }
                }
                _ => {}
            }
        }
        cursor(catalog);
    }
    assert_eq!(va, vb);
    let quote = |n: &New| -> String {
        let lib = open_library(&n.root, LibraryOptions::new("0.2.0-test"));
        let book = book_doc(&lib);
        let c = book
            .view()
            .comment(&CommentId::parse(COMMENT).unwrap())
            .unwrap();
        let text = text_at(
            &prose_doc(&lib, &format!("body:{CHAPTER}/mod-prose")),
            c.anchor.as_ref().unwrap(),
        );
        drop(book);
        lib.close().unwrap();
        text
    };
    assert_eq!(quote(&a), quote(&b));
}

/// Full catalog comparison across two explicitly new import targets. Only
/// allocated domain identities and Loro tree coordinates are renamed; source
/// ids, every metadata field (including unknown values), parenthood and
/// sibling ordering remain in the comparison. Same-target recovery below
/// continues to compare the unmodified raw document exactly.
fn catalog_state(n: &New) -> serde_json::Value {
    let lib = open_library(&n.root, LibraryOptions::new("0.2.0-test"));
    let raw = lib.load_copy(&format!("book:{BOOK}")).unwrap();
    let mut value = serde_json::to_value(raw.get_deep_value()).unwrap();
    lib.close().unwrap();
    let mut names = std::collections::BTreeMap::new();
    fn tree(
        v: &mut serde_json::Value,
        path: &str,
        names: &mut std::collections::BTreeMap<String, String>,
    ) {
        for (i, node) in v.as_array_mut().unwrap().iter_mut().enumerate() {
            let at = format!("{path}/{i}");
            let m = node.as_object_mut().unwrap();
            let id = m["meta"]["id"].as_str().unwrap().to_owned();
            // 01900000 is the stable id namespace of this existing source
            // fixture. Other ids belong to roots/groups allocated by v3.
            if !id.starts_with("01900000-") {
                names.insert(id, format!("allocated-entry:{at}"));
            }
            m.insert("id".into(), serde_json::json!(at));
            m.insert("parent".into(), serde_json::json!(path));
            m.remove("fractional_index");
            tree(m.get_mut("children").unwrap(), &at, names);
        }
    }
    tree(&mut value["entries"], "entries", &mut names);
    if value.get("material_folders").is_some() {
        tree(
            &mut value["material_folders"],
            "material_folders",
            &mut names,
        );
    }
    if let Some(views) = value["timeline_views"].as_object() {
        let mut ordered = views.iter().collect::<Vec<_>>();
        ordered.sort_by_key(|(_, v)| v["pos"].as_str().unwrap_or(""));
        for (i, (id, _)) in ordered.into_iter().enumerate() {
            names.insert(id.clone(), format!("allocated-timeline:{i}"));
        }
    }
    fn rename(
        v: serde_json::Value,
        names: &std::collections::BTreeMap<String, String>,
    ) -> serde_json::Value {
        let text = |mut s: String| {
            for (a, b) in names {
                s = s.replace(a, b);
            }
            s
        };
        match v {
            serde_json::Value::String(s) => serde_json::Value::String(text(s)),
            serde_json::Value::Array(a) => {
                serde_json::Value::Array(a.into_iter().map(|v| rename(v, names)).collect())
            }
            serde_json::Value::Object(m) => serde_json::Value::Object(
                m.into_iter()
                    .map(|(k, v)| (text(k), rename(v, names)))
                    .collect(),
            ),
            v => v,
        }
    }
    rename(value, &names)
}

/// Paths where two Loro values differ.
fn diff_values(at: &str, a: &loro::LoroValue, b: &loro::LoroValue, out: &mut Vec<String>) {
    use loro::LoroValue::{List, Map};
    match (a, b) {
        (List(x), List(y)) => {
            if x.len() != y.len() {
                out.push(format!("{at}: lengths {} != {}", x.len(), y.len()));
            }
            for (i, (a, b)) in x.iter().zip(y.iter()).enumerate() {
                diff_values(&format!("{at}/{i}"), a, b, out);
            }
        }
        (Map(x), Map(y)) => {
            let keys: std::collections::BTreeSet<&String> = x.keys().chain(y.keys()).collect();
            for k in keys {
                match (x.get(k), y.get(k)) {
                    (Some(p), Some(q)) => diff_values(&format!("{at}/{k}"), p, q, out),
                    (p, q) => out.push(format!("{at}/{k}: {p:?} vs {q:?}")),
                }
            }
        }
        _ if a != b => out.push(format!("{at}: {a:?} vs {b:?}")),
        _ => {}
    }
}

#[test]
fn imported_points_can_follow_the_usual_retention() {
    let old = build_v3(true);
    let new = new_library();
    let mut o = options(&old, &new, Accept::NOTHING);
    o.history_retention = LabelRetention::Thinned;
    let r = imported(run::import(&old.db, &new.root, &o).unwrap().0);
    assert_eq!(r.history_retention, "thinned");
    let lib = open_library(&new.root, LibraryOptions::new("0.2.0-test"));
    let labels = lib.history(&format!("body:{CHAPTER}/mod-prose")).unwrap();
    // The 0.1 points are older than 30 days: thinned away at once. The
    // import's own point is new (and dr-store's close label).
    assert!(
        labels.iter().all(|l| l.label != "periodic" && !l.keep),
        "{labels:?}"
    );
    assert!(labels.iter().any(|l| l.label == "import"));
    lib.close().unwrap();
}

#[test]
fn an_interrupted_import_carries_on_without_doubling_history() {
    let old = build_v3(true);
    let new = new_library();
    imported(
        run::import(&old.db, &new.root, &options(&old, &new, Accept::NOTHING))
            .unwrap()
            .0,
    );
    let book_before = {
        let lib = open_library(&new.root, LibraryOptions::new("0.2.0-test"));
        let v = lib
            .load_copy(&format!("book:{BOOK}"))
            .unwrap()
            .get_deep_value();
        lib.close().unwrap();
        v
    };
    // As if the run had stopped in the middle of the book: its receipt row
    // still says `importing`.
    {
        let conn = rusqlite::Connection::open(dr_store::LibraryPaths::new(&new.root).db).unwrap();
        conn.execute("UPDATE import_book SET status = 'importing'", [])
            .unwrap();
    }
    let again = imported(
        run::import(&old.db, &new.root, &options(&old, &new, Accept::NOTHING))
            .unwrap()
            .0,
    );
    assert_eq!(again.books[0].status, "imported");
    assert!(
        again.books[0]
            .notes
            .0
            .contains_key("resumed-after-interruption")
    );
    let lib = open_library(&new.root, LibraryOptions::new("0.2.0-test"));
    let labels = lib.history(&format!("body:{CHAPTER}/mod-prose")).unwrap();
    let count = |l: &str| labels.iter().filter(|x| x.label == l).count();
    assert_eq!(
        (count("periodic"), count("import")),
        (2, 1),
        "no point doubled"
    );
    let got = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .get_deep_value();
    let mut differ = Vec::new();
    diff_values("", &got, &book_before, &mut differ);
    assert!(differ.is_empty(), "resumed book differs: {differ:#?}");
    lib.close().unwrap();
}

#[test]
fn a_book_already_in_the_library_without_a_receipt_is_left_alone() {
    let old = build_v3(true);
    let new = new_library();
    imported(
        run::import(&old.db, &new.root, &options(&old, &new, Accept::NOTHING))
            .unwrap()
            .0,
    );
    // As if the book had come from another device (synced): no receipt here.
    {
        let conn = rusqlite::Connection::open(dr_store::LibraryPaths::new(&new.root).db).unwrap();
        conn.execute_batch(
            "DELETE FROM import_book; DELETE FROM import_doc; DELETE FROM import_anchor; DELETE FROM import_original; DELETE FROM import_run;",
        )
        .unwrap();
    }
    let again = imported(
        run::import(&old.db, &new.root, &options(&old, &new, Accept::NOTHING))
            .unwrap()
            .0,
    );
    assert_eq!(again.books[0].status, "already-in-library");
    assert!(again.docs.is_empty());
}

/// The app's path: the import writes into the library the app has open (with
/// dr-index's deriver, as F3 opens it), which stays open; the indexes are
/// built on it; the gate stops it with nothing left behind.
#[test]
fn an_open_library_with_a_deriver_is_rejected_before_staging() {
    let new = new_library();
    let mut o = LibraryOptions::new("0.2.0-test");
    dr_index::attach(&mut o);
    let lib = Library::open(&new.root, o).unwrap();
    let old = build(true);
    let before = sha_of(&old.db);
    assert!(matches!(
        run::import_into_library(
            &old.db,
            &lib,
            &options(&old, &new, Accept::NOTHING),
            &mut |_| {}
        ),
        Err(dr_import_v1::ImportError::Blocked(_))
    ));
    assert!(lib.docs(None, None).unwrap().is_empty());
    assert!(!receipt::directory(&new.root).exists());
    assert_eq!(sha_of(&old.db), before);
    lib.close().unwrap();
}

/// The app opens its library with this device's identity (F7): importing
/// into it, the device takes over the 0.1 library's installation id, so the
/// writing days it records from now on continue under the 0.1 device key;
/// the library, reopened, is the same device (no new epoch).
#[test]
fn the_apps_device_takes_over_the_0_1_identity() {
    let new = new_library();
    let open = || {
        let mut o = LibraryOptions::new("0.2.0-test");
        o.rebuild_indexes_on_open = false;
        o.device = Some(dr_store::Device::open(&new.device).unwrap());
        open_library(&new.root, o)
    };
    let lib = open();
    let fresh = lib.options().device.as_ref().unwrap().writing_device_key();
    let old = build_v3(true);
    let old_id = format!("install-{}", "ab".repeat(32));
    let mut opts = options(&old, &new, Accept::NOTHING);
    opts.device_dir = None;
    let (outcome, _) = run::import_into_library(&old.db, &lib, &opts, &mut |_| {}).unwrap();
    assert!(imported(outcome).installation_id_adopted);
    let key = lib.options().device.as_ref().unwrap().writing_device_key();
    assert_eq!(key, dr_store::identity::writing_device_key(&old_id));
    assert_ne!(key, fresh);
    let epoch = lib.epoch();
    lib.close().unwrap();
    let lib = open();
    assert_eq!(lib.epoch_change(), None);
    assert_eq!(lib.epoch(), epoch);
    assert_eq!(
        lib.options().device.as_ref().unwrap().installation_id(),
        old_id
    );
    lib.close().unwrap();
}

/// A second, empty book in the synthetic library, created after the first.
fn add_second_book(old: &Old) -> &'static str {
    const SECOND: &str = "01900000-0000-7000-8000-000000000002";
    let conn = rusqlite::Connection::open(&old.db).unwrap();
    conn.execute(
        "INSERT INTO project (id, name, summary, kv_json, storyline_template_kv_json, user_id, created_at, updated_at, deleted_at)
         VALUES (?1, '第二本', '', '[]', '[]', 'local', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z', NULL)",
        [SECOND],
    )
    .unwrap();
    SECOND
}

/// 「取消」: asked before anything is written, nothing is; asked while the
/// first book is written, that book is finished and the second left out;
/// the library is usable and the second book imports later.
#[test]
fn cancelling_finishes_the_book_being_written_and_leaves_the_rest() {
    let old = build_v3(true);
    let second = add_second_book(&old);

    let new = new_library();
    let opts = options(&old, &new, Accept::NOTHING);
    opts.cancel.after_book();
    let (outcome, _) = run::import(&old.db, &new.root, &opts).unwrap();
    assert!(matches!(outcome, Outcome::Cancelled));
    assert!(!new.root.join("library.sqlite").exists(), "nothing written");

    let new = new_library();
    let opts = options(&old, &new, Accept::NOTHING);
    let cancel = opts.cancel.clone();
    let (outcome, _) = run::import_with(&old.db, &new.root, &opts, &mut |p| {
        if p.step == Step::Bodies && p.book == 1 {
            cancel.after_book();
        }
    })
    .unwrap();
    let receipt = imported(outcome);
    assert!(receipt.cancelled);
    let status: Vec<(&str, &str)> = receipt
        .books
        .iter()
        .map(|b| (b.book_id.as_str(), b.status.as_str()))
        .collect();
    assert_eq!(status, [(BOOK, "imported"), (second, "cancelled")]);
    let lib = open_library(&new.root, LibraryOptions::new("0.2.0-test"));
    assert!(lib.doc_info(&format!("book:{BOOK}")).unwrap().is_some());
    assert!(lib.doc_info(&format!("book:{second}")).unwrap().is_none());
    lib.close().unwrap();

    // Later, the same library again: the first is done, the second comes.
    let opts = options(&old, &new, Accept::NOTHING);
    let receipt = imported(run::import(&old.db, &new.root, &opts).unwrap().0);
    let status: Vec<&str> = receipt.books.iter().map(|b| b.status.as_str()).collect();
    assert_eq!(status, ["already-imported", "imported"]);
}

/// Stopped now (the app quitting) while bodies are written: the book stays
/// "importing" and no book document exists yet, so nothing half-made is on
/// the bookshelf; the next import carries it on to the same result as an
/// import that was never stopped.
#[test]
fn stopping_now_leaves_the_book_to_carry_on() {
    let old = build_v3(true);
    let new = new_library();
    let opts = options(&old, &new, Accept::NOTHING);
    let cancel = opts.cancel.clone();
    let (outcome, _) = run::import_with(&old.db, &new.root, &opts, &mut |p| {
        if p.step == Step::Bodies && p.done == 1 {
            cancel.now();
        }
    })
    .unwrap();
    let receipt = imported(outcome);
    assert!(receipt.cancelled);
    assert_eq!(receipt.books[0].status, "importing");
    let lib = open_library(&new.root, LibraryOptions::new("0.2.0-test"));
    assert!(lib.doc_info(&format!("book:{BOOK}")).unwrap().is_none());
    // The receipt says which book is unfinished and where its 0.1 library
    // is, for the app's reminder to carry it on.
    let unfinished = lib.local_read(|c| Ok(receipt::unfinished(c)?)).unwrap();
    assert_eq!(
        unfinished,
        vec![receipt::Unfinished {
            book_id: BOOK.to_owned(),
            name: receipt.books[0].name.clone(),
            database: Some(old.db.clone()),
            root: Some(old.root.clone()),
        }]
    );
    lib.close().unwrap();

    let opts = options(&old, &new, Accept::NOTHING);
    let receipt = imported(run::import(&old.db, &new.root, &opts).unwrap().0);
    assert_eq!(receipt.books[0].status, "imported");
    let lib = open_library(&new.root, LibraryOptions::new("0.2.0-test"));
    let carried = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .get_deep_value();
    assert!(
        lib.local_read(|c| Ok(receipt::unfinished(c)?))
            .unwrap()
            .is_empty()
    );
    // The run's summary keeps the source next to what the end added.
    let summary: String = lib
        .local_read(|c| {
            Ok(c.query_row(
                "SELECT summary_json FROM import_run ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    let summary: serde_json::Value = serde_json::from_str(&summary).unwrap();
    assert_eq!(
        summary["source"]["database"].as_str(),
        Some(old.db.to_string_lossy().as_ref())
    );
    assert_eq!(summary["cancelled"], serde_json::json!(false));
    lib.close().unwrap();

    let clean = new_library();
    let opts = options(&old, &clean, Accept::NOTHING);
    imported(run::import(&old.db, &clean.root, &opts).unwrap().0);
    let lib = open_library(&clean.root, LibraryOptions::new("0.2.0-test"));
    let whole = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .get_deep_value();
    lib.close().unwrap();
    assert_ne!(
        carried, whole,
        "independent targets allocate fresh catalog roots"
    );
    assert_eq!(catalog_state(&new), catalog_state(&clean));
}

#[test]
fn original_dangling_source_relation_is_pending_before_any_target_or_identity_write() {
    let old = build(true);
    let new = new_library();
    let before = sha_of(&old.db);
    let error = run::import(&old.db, &new.root, &options(&old, &new, Accept::NOTHING)).unwrap_err();
    assert!(
        matches!(error,dr_import_v1::ImportError::V3Pending(items) if items.iter().any(|p|p.code=="invalid-or-duplicate-source-relation"))
    );
    assert_eq!(sha_of(&old.db), before);
    assert!(!dr_store::LibraryPaths::new(&new.root).db.exists());
    assert!(!new.device.exists());
}

#[test]
fn explicit_new_root_references_resolve_once_and_resume_the_same_allocated_roots() {
    let old = build_v3(true);
    let new = new_library();
    let before = sha_of(&old.db);
    let mut opts = options(&old, &new, Accept::NOTHING);
    let alias = EntryId::parse("chosen-manuscript-root").unwrap();
    opts.v3
        .root_references
        .insert(alias.clone(), dr_import_v1::v3::RootReference::Manuscript);
    let choice = opts.v3.unaffiliated.as_mut().unwrap();
    choice.parent = None;
    choice.template.settings.home = Some(Some(alias));
    let template = choice.template.id.clone();
    imported(run::import(&old.db, &new.root, &opts).unwrap().0);
    let lib = open_library(&new.root, LibraryOptions::new("0.2.0-test"));
    let b = book_doc(&lib);
    let v = b.view();
    let root = v
        .root_entry_by_template(&EntryTemplateId::parse(TPL_MANUSCRIPT).unwrap())
        .unwrap()
        .id;
    let lane = v
        .entries()
        .into_iter()
        .find(|e| e.template.as_ref() == Some(&template))
        .unwrap();
    assert_eq!(lane.parent, None);
    assert_eq!(
        v.template(&template).unwrap().settings.home,
        Some(Some(root))
    );
    drop(b);
    let raw = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .get_deep_value();
    lib.close().unwrap();
    let conn = rusqlite::Connection::open(dr_store::LibraryPaths::new(&new.root).db).unwrap();
    conn.execute("UPDATE import_book SET status='importing'", [])
        .unwrap();
    drop(conn);
    imported(run::import(&old.db, &new.root, &opts).unwrap().0);
    let lib = open_library(&new.root, LibraryOptions::new("0.2.0-test"));
    assert_eq!(
        lib.load_copy(&format!("book:{BOOK}"))
            .unwrap()
            .get_deep_value(),
        raw
    );
    lib.close().unwrap();
    assert_eq!(sha_of(&old.db), before);
}
