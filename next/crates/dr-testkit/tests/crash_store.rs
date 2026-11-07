//! The crash harness on dr-store (F2's case, moved onto `dr_testkit::crash`):
//! a writer edits one document through a real document holder, compacting
//! every 25 edits with the compaction transaction held open 20 ms so kills
//! land inside it; after each kill the library is reopened and the document
//! compared with a deterministic replay of edits `0..=k`.

use std::path::Path;
use std::time::Duration;

use dr_store::{Library, LibraryOptions, OpenDoc, Origin};
use dr_testkit::crash::{self, Harness, Recovered, Reporter};
use dr_testkit::rng::Rng;
use dr_testkit::text;
use loro::{LoroDoc, LoroValue, ToJson, ValueOrContainer};

const DOC: &str = "node:crash-probe";
const BODY: &str = "body";
const COMPACT_EVERY: u64 = 25;

fn options() -> LibraryOptions {
    let mut o = LibraryOptions::new("0.2.0-crash");
    o.compaction.max_updates = usize::MAX;
    o.compaction.max_bytes = usize::MAX;
    o.compaction.on_close_min_updates = usize::MAX;
    o
}

fn genesis(doc: &LoroDoc) {
    doc.set_peer_id((1 << 63) | 0xF8C4).expect("genesis peer");
}

/// Edit `k`: a pure function of `k` and the document, so replaying
/// `0..=k` reproduces the document exactly.
fn edit(doc: &LoroDoc, k: u64) {
    let mut r = Rng::stream(0xC4A5, "crash-edit", k);
    let t = doc.get_text(BODY);
    if k == 0 {
        let paras = text::body(&mut r, 20_000, text::BodyShape::default());
        t.insert(0, &text::plain(&paras)).expect("insert");
    } else {
        let len = t.len_unicode();
        match r.below(10) {
            0..=6 => {
                let s: String = ["潮", "灯", "记", "录"][r.below(4) as usize].repeat(r.range(1, 6));
                t.insert(r.range(0, len), &s).expect("insert");
            }
            7 | 8 if len > 40 => {
                let at = r.range(0, len - 31);
                t.delete(at, r.range(1, 30)).expect("delete");
            }
            _ => t.insert(r.range(0, len), "\n").expect("split"),
        }
    }
    doc.get_map("meta").insert("k", k as i64).expect("meta");
}

fn last_edit(doc: &LoroDoc) -> i64 {
    match doc.get_map("meta").get("k") {
        Some(ValueOrContainer::Value(LoroValue::I64(k))) => k,
        _ => -1,
    }
}

fn replay(upto: i64) -> LoroDoc {
    let doc = LoroDoc::new();
    doc.set_peer_id(1).expect("peer");
    for k in 0..=upto {
        edit(&doc, k as u64);
        doc.commit();
    }
    doc
}

fn body_json(doc: &LoroDoc) -> String {
    doc.get_text(BODY).get_richtext_value().to_json()
}

/// The writer: runs only in the child process the harness starts.
#[test]
fn store_writer() {
    let Some(root) = crash::child_root() else {
        return;
    };
    let mut o = options();
    o.compaction_pause = Some(Duration::from_millis(20));
    let lib = Library::open(&root, o).expect("open");
    let h = lib
        .open_doc(
            DOC,
            OpenDoc::CreateIfMissing {
                kind: "node",
                book_id: Some("book-crash"),
                genesis: &genesis,
            },
        )
        .expect("open doc");
    let mut report = Reporter::new();
    let mut k = (h.read(last_edit).expect("read") + 1) as u64;
    loop {
        h.write(Origin::User, move |doc| edit(doc, k))
            .expect("write");
        report.durable(k);
        if k.is_multiple_of(COMPACT_EVERY) {
            report.phase("compacting");
            h.compact_now().expect("compact");
            report.phase("compacted");
        }
        k += 1;
        std::thread::sleep(Duration::from_micros(300));
    }
}

fn verify(root: &Path) -> Result<Recovered, String> {
    let lib = Library::open(root, options()).map_err(|e| e.to_string())?;
    let got = lib.load_copy(DOC).map_err(|e| e.to_string())?;
    let k = last_edit(&got);
    if body_json(&got) != body_json(&replay(k)) {
        return Err(format!(
            "the reopened document differs from a replay of 0..={k}"
        ));
    }
    let (upto, _) = lib
        .snapshot_info(DOC)
        .map_err(|e| e.to_string())?
        .unwrap_or((0, 0));
    let rows = lib.updates_since(DOC, 0).map_err(|e| e.to_string())?;
    if rows.iter().any(|u| u.seq <= upto) {
        return Err("updates the snapshot covers survived compaction".into());
    }
    if rows.windows(2).any(|w| w[1].seq != w[0].seq + 1) {
        return Err("the update log has a gap".into());
    }
    Ok(Recovered { step: k })
}

#[test]
fn killed_store_writer_loses_nothing_it_reported() {
    let dir = tempfile::tempdir().unwrap();
    let report = Harness::for_test("store_writer")
        .kills(8)
        .delay_ms(20, 300)
        .run(dir.path(), |_, root| verify(root))
        .unwrap();
    assert_eq!(report.kills, 8);
    assert!(report.last_step > 0, "the writer got going: {report:?}");
    eprintln!("{}", report.to_json());
}
