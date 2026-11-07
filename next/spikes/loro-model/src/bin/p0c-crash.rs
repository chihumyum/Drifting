//! Crash recovery: a writer process edits one document, appending every
//! commit and compacting every 25 updates (snapshot + delete covered updates
//! in one transaction, held open 20 ms so kills land inside it). The parent
//! kills it with SIGKILL at random moments,
//! reopens the database, and checks the recovered document against a
//! deterministic replay of edits 0..=k, where k is the last edit recorded in
//! the document. Every edit the writer reported durable must be present.
//!
//! ```text
//! cargo run --release -p loro-model-spike --bin p0c-crash -- run [--kills 60] [--out <json>]
//! ```

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use loro::{LoroValue, ToJson, ValueOrContainer};
use loro_model_spike::evidence::{machine, source_fingerprint};
use loro_model_spike::ids::Rng;
use loro_model_spike::prose::ProseDoc;
use loro_model_spike::schema::block;
use loro_model_spike::store::{Durability, Holder, Store};
use serde_json::json;

const DOC: &str = "node:crash-probe";
const COMPACT_EVERY: i64 = 25;
const DEFAULT_OUT: &str = "../docs/rust-rewrite/acceptance/p0-c-crash-recovery.json";

/// Edit number `k`, a pure function of `k` and the current document.
fn edit(prose: &ProseDoc, k: i64) {
    let mut r = Rng::new(0xC0FF_EE00 ^ k as u64);
    let han: Vec<char> = "春夏秋冬风花雪月山川河流日月星辰".chars().collect();
    if k == 0 {
        // A large first edit so snapshots (and compactions) take real time.
        let s: String = (0..40_000).map(|_| *r.pick(&han)).collect();
        prose.insert_text(0, &s);
        let mut pos = 0;
        for _ in 0..200 {
            pos += r.range(60, 300);
            if pos >= prose.len() - 1 {
                break;
            }
            prose.split(pos);
            pos += 1;
        }
    } else {
        let len = prose.len();
        match r.below(10) {
            0..=5 => {
                let s: String = (0..r.range(1, 12)).map(|_| *r.pick(&han)).collect();
                prose.insert_text(r.range(0, len - 1), &s);
            }
            6 | 7 => {
                let at = r.range(0, len - 1);
                prose.delete(at..at + r.range(1, 30));
            }
            8 => {
                prose.split(r.range(0, len - 1));
            }
            _ => {
                let nl = prose.next_newline(r.range(0, len - 1));
                let level = r.range(0, 3) as i64;
                prose.set_block_attr(
                    nl,
                    block::HEADING,
                    if level == 0 { None } else { Some(level.into()) },
                );
            }
        }
    }
    prose.doc.get_map("meta").insert("k", k).unwrap();
}

fn last_k(prose: &ProseDoc) -> i64 {
    match prose.doc.get_map("meta").get("k") {
        Some(ValueOrContainer::Value(LoroValue::I64(k))) => k,
        _ => -1,
    }
}

fn writer(db: &Path) -> Result<()> {
    let store = Store::open(db, Durability::Normal)?;
    store.register(DOC, "chapter")?;
    let peer = store.peer_for(DOC)?;
    let (prose, mut holder) = match store.load_for_edit(DOC)? {
        Some(doc) => (ProseDoc::from_doc(doc.clone()), Holder::loaded(DOC, doc)),
        None => {
            let p = ProseDoc::create(DOC, peer);
            let h = Holder::new(DOC, p.doc.clone());
            (p, h)
        }
    };
    let mut out = std::io::stdout().lock();
    let mut k = last_k(&prose) + 1;
    loop {
        edit(&prose, k);
        holder.commit(&store, "user")?;
        writeln!(out, "durable {k}")?;
        out.flush()?;
        if k % COMPACT_EVERY == 0 {
            writeln!(out, "compacting {k}")?;
            out.flush()?;
            // Hold the transaction open (snapshot written, covered updates
            // not yet deleted) so some kills land inside it.
            store.compact_with(DOC, &prose.doc, &|| {
                std::thread::sleep(Duration::from_millis(20));
            })?;
            writeln!(out, "compacted {k}")?;
            out.flush()?;
        }
        k += 1;
        std::thread::sleep(Duration::from_micros(300));
    }
}

fn replay(peer: u64, upto: i64) -> ProseDoc {
    let p = ProseDoc::create(DOC, peer);
    for k in 0..=upto {
        edit(&p, k);
        p.doc.commit();
    }
    p
}

fn run(kills: usize, out: &Path) -> Result<()> {
    let dir = std::env::temp_dir().join(format!("p0c-crash-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let db = dir.join("crash.sqlite");
    let exe = std::env::current_exe()?;
    let mut rng = Rng::new(0x5EED);
    let mut phases = std::collections::BTreeMap::<String, usize>::new();
    let mut recovered_ahead = 0usize;
    let mut max_k = 0;
    let mut checked_bytes = 0usize;
    let mut verify_ms = Vec::new();
    let mut recover_ms = Vec::new();
    for i in 0..kills {
        let mut child = Command::new(&exe)
            .arg("writer")
            .arg(&db)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let reader = {
            let lines = lines.clone();
            let stdout = child.stdout.take().unwrap();
            std::thread::spawn(move || {
                for l in BufReader::new(stdout).lines().map_while(Result::ok) {
                    lines.lock().unwrap().push(l);
                }
            })
        };
        // Wait until the writer is running, then kill at a random moment.
        let start = Instant::now();
        while lines.lock().unwrap().is_empty() && start.elapsed() < Duration::from_secs(30) {
            std::thread::sleep(Duration::from_millis(2));
        }
        std::thread::sleep(Duration::from_millis(rng.range(5, 250) as u64));
        child.kill()?; // SIGKILL
        child.wait()?;
        reader.join().unwrap();
        let lines = lines.lock().unwrap().clone();
        let durable: i64 = lines
            .iter()
            .rev()
            .find_map(|l| l.strip_prefix("durable ").and_then(|k| k.parse().ok()))
            .context("writer reported nothing")?;
        let phase = match lines.last().map(|l| l.split(' ').next().unwrap_or("")) {
            Some("compacting") => "during compaction",
            Some("compacted") => "right after compaction",
            _ => "between edits",
        };
        *phases.entry(phase.into()).or_default() += 1;

        let t = Instant::now();
        let store = Store::open(&db, Durability::Normal)?;
        let doc = store.load(DOC)?.context("document missing after crash")?;
        let got = ProseDoc::from_doc(doc);
        got.text().len_unicode();
        recover_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        let t = Instant::now();
        let k = last_k(&got);
        if k < durable {
            bail!("kill {i}: lost durable edit {durable} (recovered {k})");
        }
        if k > durable + 1 {
            bail!("kill {i}: recovered {k} beyond reported {durable}");
        }
        if k > durable {
            recovered_ahead += 1;
        }
        let want = replay(store.peer_for(DOC)?, k);
        let a = got.text().get_richtext_value().to_json();
        let b = want.text().get_richtext_value().to_json();
        if a != b {
            bail!("kill {i}: recovered state differs from replay of 0..={k}");
        }
        checked_bytes = a.len();
        if got.repair_block_ids() != 0 {
            bail!("kill {i}: block ids not unique after recovery");
        }
        verify_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        max_k = max_k.max(k);
        let (pending, _) = store.pending(DOC)?;
        eprintln!("kill {i:3}: {phase:24} durable={durable} recovered={k} pending={pending}");
    }
    let doc = json!({
        "schemaVersion": 1,
        "probe": "P0-C crash recovery",
        "generatedBy": "cargo run --release -p loro-model-spike --bin p0c-crash -- run",
        "sourceFingerprint": source_fingerprint(),
        "loro": "1.17.1",
        "machine": machine(),
        "method": "SIGKILL the writer at random moments; reopen; compare with a deterministic replay of edits 0..=k",
        "compactEvery": COMPACT_EVERY,
        "results": {
            "kills": kills,
            "killsByPhase": phases,
            "lostDurableEdits": 0,
            "mismatches": 0,
            "recoveredOneEditBeyondLastReport": recovered_ahead,
            "editsAtEnd": max_k + 1,
            "finalRichTextJsonBytes": checked_bytes,
            "recoverOpenAndLoadMs": loro_model_spike::evidence::summarize(&recover_ms).json(),
            "verifyByReplayMs": loro_model_spike::evidence::summarize(&verify_ms).json(),
        }
    });
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(out, serde_json::to_string_pretty(&doc)? + "\n")?;
    eprintln!("wrote {}", out.display());
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    match args.get(1).map(String::as_str) {
        Some("writer") => writer(Path::new(args.get(2).context("db path")?)),
        Some("run") => {
            let kills = flag("--kills").and_then(|k| k.parse().ok()).unwrap_or(60);
            let out = PathBuf::from(flag("--out").unwrap_or_else(|| DEFAULT_OUT.to_string()));
            run(kills, &out)
        }
        _ => bail!("usage: p0c-crash run [--kills N] [--out FILE] | p0c-crash writer DB"),
    }
}
