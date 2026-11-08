//! Kill the real F3 Agent write while F2 has inserted Loro's update but has
//! not yet inserted its settlement or committed the SQLite transaction.

use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use dr_doc::prose::ProseReader;
use dr_model::DocId;
use dr_store::{Library, LibraryOptions};
use dr_testkit::crash::{self, Harness, Recovered, Reporter};
use dr_testkit::seed::{self, Preset, Seeded};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use serde_json::json;

const SESSION: &str = "m27-crash";

fn options() -> LibraryOptions {
    let mut options = library_options("m27-crash-test");
    options.rebuild_indexes_on_open = false;
    options.derive_idle = Duration::from_secs(60);
    options.compaction.max_updates = usize::MAX;
    options.compaction.max_bytes = usize::MAX;
    options.compaction.on_close_min_updates = usize::MAX;
    options.compaction.idle = Duration::from_secs(60);
    options
}

fn fixture() -> (Seeded, DocId, String, Vec<String>) {
    let seeded = seed::generate(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
    let prose = seeded.books[0]
        .prose
        .iter()
        .find(|p| matches!(p.doc_id(), DocId::Node(_)))
        .unwrap();
    let doc = prose.doc_id().clone();
    let block = prose
        .view()
        .paragraphs()
        .nth(1)
        .unwrap()
        .id
        .unwrap()
        .to_string();
    let text = prose.view().paragraphs().map(|p| p.text()).collect();
    (seeded, doc, block, text)
}

fn expected(base: &[String], step: i64) -> Vec<String> {
    let mut text = base.to_vec();
    if step >= 0 {
        // The counter is crash-test state; all manuscript content is seed data.
        text[1] = format!("{} [{step}]", base[1]);
    }
    text
}

fn paragraphs(doc_id: &DocId, doc: &loro::LoroDoc) -> Vec<String> {
    ProseReader::from_loro(doc_id.clone(), doc)
        .unwrap()
        .view()
        .paragraphs()
        .map(|p| p.text())
        .collect()
}

#[test]
fn agent_writer() {
    let Some(root) = crash::child_root() else {
        return;
    };
    let (_, doc, block, base) = fixture();
    let mut options = options();
    let enabled = Arc::new(AtomicBool::new(false));
    let checkpoint_enabled = enabled.clone();
    options.append_checkpoint = Some(Arc::new(move || {
        if checkpoint_enabled.load(Ordering::Relaxed) {
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "dr-crash phase append_transaction").unwrap();
            stdout.flush().unwrap();
        }
    }));
    options.append_pause = Some(Duration::from_millis(25));
    let lib = Library::open(root, options).unwrap();
    let mut step = lib
        .settlements(Some(SESSION), Some(&doc.to_string()))
        .unwrap()
        .len() as i64;
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    ws.set_auto_links(false);
    // Open/repair documents before reporting ready; only the tested writes
    // subsequently enter the checkpoint and get counted by the harness.
    ws.call(&Actor::User, "prose.read", json!({"doc": doc.to_string()}))
        .unwrap();
    let mut reporter = Reporter::new();
    enabled.store(true, Ordering::Relaxed);
    loop {
        ws.call(
            &Actor::agent(SESSION, step as u32, format!("step-{step}")),
            "prose.replace",
            json!({
                "doc": doc.to_string(),
                "block_id": block,
                "find": expected(&base, step - 1)[1],
                "replace": expected(&base, step)[1],
            }),
        )
        .unwrap();
        reporter.durable(step as u64);
        step += 1;
    }
}

fn verify(root: &Path) -> Result<Recovered, String> {
    let (_, doc, _, base) = fixture();
    let lib = Library::open(root, options()).map_err(|e| e.to_string())?;
    let doc_id = doc.to_string();
    let receipts = lib
        .settlements(Some(SESSION), Some(&doc_id))
        .map_err(|e| e.to_string())?;
    let step = receipts.len() as i64 - 1;
    let current = lib.load_copy(&doc_id).map_err(|e| e.to_string())?;
    if paragraphs(&doc, &current) != expected(&base, step) {
        return Err(
            "book contains a write without its settlement (or a settlement without its write)"
                .into(),
        );
    }
    let updates = lib.updates_since(&doc_id, 0).map_err(|e| e.to_string())?;
    let agent_updates: Vec<_> = updates
        .iter()
        .filter(|u| u.origin.starts_with("agent:"))
        .collect();
    if agent_updates.len() != receipts.len() {
        return Err("Agent update/settlement count differs".into());
    }
    for (index, (update, receipt)) in agent_updates.iter().zip(&receipts).enumerate() {
        if update.seq != receipt.seq
            || receipt.turn != index.to_string()
            || receipt.call != format!("step-{index}")
        {
            return Err("settlement lost its exact update, turn or call identity".into());
        }
        let before = lib
            .load_copy_at(&doc_id, &receipt.before)
            .map_err(|e| e.to_string())?;
        let after = lib
            .load_copy_at(&doc_id, &receipt.after)
            .map_err(|e| e.to_string())?;
        if paragraphs(&doc, &before) != expected(&base, index as i64 - 1)
            || paragraphs(&doc, &after) != expected(&base, index as i64)
        {
            return Err("settlement frontiers do not describe exactly the committed write".into());
        }
    }
    lib.close().map_err(|e| e.to_string())?;
    Ok(Recovered { step })
}

#[test]
fn killing_mid_agent_transaction_recovers_book_and_settlement_together() {
    let dir = tempfile::tempdir().unwrap();
    let (seed, _, _, _) = fixture();
    let lib = Library::open(dir.path(), options()).unwrap();
    seed.write_to(&lib).unwrap();
    lib.close().unwrap();
    let report = Harness::for_test("agent_writer")
        .kills(6)
        .delay_ms(80, 180)
        .run(dir.path(), |_, root| verify(root))
        .unwrap();
    assert_eq!(report.kills, 6);
    assert!(
        report.last_step > 0,
        "writer made durable progress: {report:?}"
    );
    assert!(
        report
            .by_phase
            .get("append_transaction")
            .copied()
            .unwrap_or(0)
            > 0,
        "at least one kill must land between the Loro row and receipt: {report:?}"
    );
}
