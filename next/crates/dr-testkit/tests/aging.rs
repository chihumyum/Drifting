//! The aging steps: deterministic, on target, and true to what they say.

use dr_doc::prose::ProseDoc;
use dr_doc::v3::novel::TPL_CHAPTER;
use dr_model::DocId;
use dr_testkit::aging::book::{self, BookAging, Commit, Kind};
use dr_testkit::aging::chapter::{self, ChapterAging, Mix};
use dr_testkit::aging::{self, HistoryShape};
use dr_testkit::seed::{self, DEFAULT_SEED, Preset, SeededBookV3};

fn tiny() -> SeededBookV3 {
    seed::generate_v3(Preset::Tiny, DEFAULT_SEED)
        .expect("the tiny seed")
        .books
        .remove(0)
}

fn a_chapter(book: &SeededBookV3) -> &ProseDoc {
    let chapters: Vec<String> = book
        .book
        .view()
        .entries()
        .into_iter()
        .filter(|e| {
            e.template
                .as_ref()
                .is_some_and(|t| t.as_str() == TPL_CHAPTER)
        })
        .map(|e| e.id.to_string())
        .collect();
    book.prose
        .iter()
        .filter(
            |p| matches!(p.doc_id(), DocId::Body(b) if chapters.contains(&b.entry().to_string())),
        )
        .max_by_key(|p| p.view().len())
        .expect("a chapter")
}

#[test]
fn a_chapter_ages_to_its_target_and_keeps_its_length() {
    let book = tiny();
    let base = a_chapter(&book);
    let before = base.export_snapshot().unwrap();
    let plan = ChapterAging::revision(6_000);
    let aged = chapter::age(base, &plan).unwrap();
    let again = chapter::age(base, &plan).unwrap();
    assert_eq!(
        aged.doc.export_snapshot().unwrap(),
        again.doc.export_snapshot().unwrap(),
        "the same plan gives the same bytes"
    );
    assert_eq!(
        base.export_snapshot().unwrap(),
        before,
        "the seed is left alone"
    );

    let s = aged.stats;
    assert!(s.ops >= plan.target_ops, "{s:?}");
    // One action past the target at most: a rewritten paragraph.
    assert!(s.ops < plan.target_ops + 1_500, "{s:?}");
    assert_eq!(s.ops, aging::ops(&aged.doc.version()));
    assert!(s.sessions >= 1 && s.commits > 500, "{s:?}");
    let drift = s.chars_after.abs_diff(s.chars_before);
    assert!(
        drift * 20 <= s.chars_before,
        "the visible length stays: {s:?}"
    );
    assert_eq!(s.chars_after, aged.doc.view().len());
    // The text still ends with its newline and reads as paragraphs.
    assert!(aged.doc.view().plain_text().ends_with('\n'));
    assert!(aged.doc.view().paragraph_count() > 1);

    let shape = HistoryShape::of(&aged.doc.export_snapshot().unwrap()).unwrap();
    assert_eq!(shape.ops, s.ops);
    // The genesis, the seed's import and one device.
    assert_eq!(shape.peers, 3);
    // Far more pieces than the seed's one import, far fewer than operations.
    let seeded = HistoryShape::of(&before).unwrap();
    assert!(
        shape.op_runs > 3 * seeded.op_runs && shape.op_runs < shape.ops / 4,
        "{shape:?} from {seeded:?}"
    );
    assert!(
        shape.changes >= s.sessions,
        "a session is at least one change: {shape:?}"
    );
    assert!(shape.state_bytes > 0);
}

#[test]
fn scattered_fixes_leave_more_pieces_than_rewrites() {
    let book = tiny();
    let base = a_chapter(&book);
    let runs = |mix: Mix| {
        let aged = chapter::age(
            base,
            &ChapterAging {
                mix,
                ..ChapterAging::revision(5_000)
            },
        )
        .unwrap();
        HistoryShape::of(&aged.doc.export_snapshot().unwrap())
            .unwrap()
            .op_runs
    };
    assert!(runs(Mix::SCATTERED) > 2 * runs(Mix::REVISION));
}

#[test]
fn several_devices_meet_on_one_text() {
    let book = tiny();
    let base = a_chapter(&book);
    let plan = ChapterAging {
        // Every session that can be is written offline.
        concurrent_one_in: 1,
        ..ChapterAging::devices(12_000)
    };
    let aged = chapter::age(base, &plan).unwrap();
    assert!(aged.stats.sessions >= 3, "{:?}", aged.stats);
    assert!(aged.stats.concurrent_sessions >= 1, "{:?}", aged.stats);
    let snapshot = aged.doc.export_snapshot().unwrap();
    let shape = HistoryShape::of(&snapshot).unwrap();
    // The genesis, the seed's import and at least two of the three devices.
    assert!(shape.peers >= 4, "{shape:?}");
    // A reader of the snapshot sees what the first device sees.
    let copy = ProseDoc::load(
        aged.doc.doc_id().clone(),
        dr_doc::peer::random_device_peer(),
        &[snapshot],
    )
    .unwrap();
    assert_eq!(copy.view().plain_text(), aged.doc.view().plain_text());
    assert!(!copy.view().blocks().iter().any(|b| b.id.is_none()));
}

#[test]
fn a_book_ages_the_same_way_twice_and_says_what_it_did() {
    let seeded = tiny();
    let plan = BookAging::days(40);
    let aged = book::age(&seeded.book, &plan).unwrap();
    let again = book::age(&seeded.book, &plan).unwrap();
    assert_eq!(
        aged.doc.export_snapshot().unwrap(),
        again.doc.export_snapshot().unwrap()
    );
    let s = aged.stats;
    assert_eq!(s.commits, aged.commits.len());
    assert!(aged.commits.windows(2).all(|w| w[0].ts <= w[1].ts));
    let of = |kind: Kind| aged.commits.iter().filter(|c| c.kind == kind).count();
    assert_eq!(of(Kind::WritingDay), s.writing_day_writes);
    assert_eq!(of(Kind::Checkpoint), s.checkpoints_saved);
    assert!(s.writing_day_writes > 500, "{s:?}");
    assert!(
        s.checkpoints_saved > 50 && s.checkpoints_thinned > 0,
        "{s:?}"
    );

    let view = aged.doc.view();
    // One key per device and day, each device's own.
    let days = view.writing_days();
    assert!(days.len() as u32 >= s.working_days, "{s:?}");
    assert!(days.len() as u32 <= 2 * s.working_days + 5, "{s:?}");
    assert_eq!(
        view.entry_checkpoints().len(),
        s.checkpoints_saved - s.checkpoints_thinned
    );
    assert!(view.comments().len() >= s.comments);
    assert!(!view.needs_repair());
}

#[test]
fn leaving_one_kind_out_leaves_the_rest_alone() {
    let seeded = tiny();
    let all = book::age(&seeded.book, &BookAging::days(25)).unwrap();
    let without = book::age(
        &seeded.book,
        &BookAging {
            without_writing_days: true,
            without_checkpoints: true,
            ..BookAging::days(25)
        },
    )
    .unwrap();
    assert!(without.doc.view().entry_checkpoints().is_empty());
    assert_eq!(
        without.doc.view().writing_days(),
        seeded.book.view().writing_days(),
        "only the seed's own writing days"
    );
    let rest = |commits: &[Commit]| -> Vec<(i64, u8, Kind)> {
        commits
            .iter()
            .filter(|c| !matches!(c.kind, Kind::WritingDay | Kind::Checkpoint))
            .map(|c| (c.ts, c.device, c.kind))
            .collect()
    };
    assert_eq!(rest(&all.commits), rest(&without.commits));
    assert_eq!(without.stats.writing_day_writes, 0);
    assert_eq!(without.stats.checkpoints_saved, 0);
    assert!(
        without.doc.export_snapshot().unwrap().len() < all.doc.export_snapshot().unwrap().len()
    );
}

#[test]
fn siblings_earn_no_checkpoint_unless_the_plan_asks_for_the_old_rule() {
    let seeded = tiny();
    let now = book::age(&seeded.book, &BookAging::days(40)).unwrap();
    let before = book::age(
        &seeded.book,
        &BookAging {
            sibling_checkpoints: true,
            ..BookAging::days(40)
        },
    )
    .unwrap();
    assert_eq!(now.stats.checkpoints_for_siblings, 0);
    assert!(
        before.stats.checkpoints_for_siblings > 0,
        "{:?}",
        before.stats
    );
    // The entries that changed themselves earn the same checkpoints either
    // way; the old rule only adds the siblings'.
    assert_eq!(
        now.stats.checkpoints_saved,
        before.stats.checkpoints_saved - before.stats.checkpoints_for_siblings
    );
    assert!(now.stats.checkpoints_saved > 50, "{:?}", now.stats);
    // A created idea and a moved chapter still earn theirs.
    assert!(now.stats.entries_created > 0, "{:?}", now.stats);
    let view = now.doc.view();
    let pointed: std::collections::BTreeSet<String> = view
        .entry_checkpoints()
        .iter()
        .map(|(_, manifest)| {
            serde_json::from_str::<serde_json::Value>(manifest).unwrap()["entry"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    let seeded_ids: std::collections::BTreeSet<String> = seeded
        .book
        .view()
        .entries_raw()
        .into_iter()
        .map(|e| e.id.to_string())
        .collect();
    for e in view.entries_raw() {
        if !seeded_ids.contains(e.id.as_str()) {
            assert!(pointed.contains(e.id.as_str()), "a new entry: {}", e.title);
        }
    }
    // Everything else the author did is the same, commit for commit.
    let rest = |commits: &[Commit]| -> Vec<(i64, u8, Kind)> {
        commits
            .iter()
            .filter(|c| c.kind != Kind::Checkpoint)
            .map(|c| (c.ts, c.device, c.kind))
            .collect()
    };
    assert_eq!(rest(&now.commits), rest(&before.commits));
    let stats = |s: book::BookStats| book::BookStats {
        commits: 0,
        checkpoints_saved: 0,
        checkpoints_thinned: 0,
        checkpoints_for_siblings: 0,
        ops: 0,
        ..s
    };
    assert_eq!(stats(now.stats), stats(before.stats));
    assert!(now.doc.export_snapshot().unwrap().len() < before.doc.export_snapshot().unwrap().len());
}

#[test]
fn every_entry_fingerprint_read_at_once_is_the_one_read_by_itself() {
    let seeded = tiny();
    let aged = book::age(&seeded.book, &BookAging::days(40)).unwrap();
    for doc in [&seeded.book, &aged.doc] {
        let view = doc.view();
        let entries = view.entries_raw();
        let all = view.entry_change_states();
        assert!(entries.len() >= 20);
        assert_eq!(
            all.iter().map(|(id, _)| id).collect::<Vec<_>>(),
            entries.iter().map(|e| &e.id).collect::<Vec<_>>()
        );
        let mut records = 0;
        for ((id, state), e) in all.iter().zip(&entries) {
            assert_eq!(view.entry_change_state(id).as_ref(), Some(state), "{id}");
            // What the entry owns is what a preview shows of it; its place
            // is its own position key, where the preview lists its siblings.
            let raw = view.entry_owned_raw_state(id).unwrap();
            for key in ["metadata", "records", "parent"] {
                assert_eq!(state[key], raw[key], "{id} {key}");
            }
            assert_eq!(state["position"], e.pos.as_str(), "{id}");
            assert_eq!(state.as_object().unwrap().len(), 4, "{id}");
            records += state["records"]
                .as_object()
                .unwrap()
                .values()
                .map(|rows| rows.as_object().unwrap().len())
                .sum::<usize>();
        }
        assert!(records > 0, "the seed's entries own records");
    }
}

#[test]
fn uploads_group_commits_by_device_and_cycle() {
    let c = |ts, device, kind| Commit {
        ts,
        device,
        kind,
        bytes: 100,
    };
    let commits = [
        c(1_000, 0, Kind::WritingDay),
        c(1_003, 0, Kind::Field),
        c(1_004, 1, Kind::WritingDay),
        c(1_060, 0, Kind::WritingDay),
        c(1_000 + 86_400, 0, Kind::WritingDay),
    ];
    let each = book::uploads(&commits, 0);
    assert_eq!((each.batches, each.writing_day_only), (5, 4));
    assert_eq!((each.bytes, each.writing_day_bytes), (500, 400));
    assert_eq!(each.per_working_day, 2.5);
    // Cycles of 8 s: the first device's field edit shares one with its
    // writing day; the other device has its own.
    let cycles = book::uploads(&commits, 8);
    assert_eq!((cycles.batches, cycles.writing_day_only), (4, 3));
    let slow = book::uploads(&commits, 300);
    assert_eq!((slow.batches, slow.writing_day_only), (3, 2));
}

#[test]
fn an_aged_document_is_stored_like_a_seeded_one() {
    let seeded = tiny();
    let base = a_chapter(&seeded);
    let aged = chapter::age(base, &ChapterAging::revision(4_000)).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let ws = dr_testkit::bench::aging::open_workspace(dir.path()).unwrap();
    let all = Default::default();
    let id = aged.doc.doc_id().to_string();
    aging::store(
        ws.library(),
        seeded.book.book_id(),
        aged.doc.doc_id(),
        dr_doc::prose::genesis(aged.doc.doc_id()),
        aged.doc.export_updates_since(&all).unwrap(),
    )
    .unwrap();
    aging::store(
        ws.library(),
        seeded.book.book_id(),
        seeded.book.doc_id(),
        dr_doc::v3::genesis_v3(seeded.book.book_id()),
        seeded.book.export_updates_since(&all).unwrap(),
    )
    .unwrap();
    // Stored once: a second time is refused, not merged.
    assert!(
        aging::store(
            ws.library(),
            seeded.book.book_id(),
            aged.doc.doc_id(),
            dr_doc::prose::genesis(aged.doc.doc_id()),
            Vec::new(),
        )
        .is_err()
    );
    // One snapshot, no loose updates, and the workspace edits and undoes it.
    assert_eq!(ws.library().pending_updates(&id).unwrap().0, 0);
    let session = ws.prose_session(&id).unwrap();
    let text = session.reader().view().plain_text();
    assert_eq!(text, aged.doc.view().plain_text());
    session.edit(|t| t.insert_text(0, "字")).unwrap();
    assert_ne!(session.reader().view().plain_text(), text);
    assert!(session.undo().unwrap());
    assert_eq!(session.reader().view().plain_text(), text);
    drop(session);
    ws.shutdown().unwrap();
}
