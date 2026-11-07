//! Crash recovery evidence for dr-store.
//!
//! - **Editing**: a writer process edits one document through a real
//!   document holder (every edit appended before it is reported durable) and
//!   compacts every 25 edits, holding the compaction transaction open 20 ms
//!   so kills land inside it. The parent kills it at random moments
//!   (SIGKILL / TerminateProcess), reopens the library and compares the
//!   document with a deterministic replay of edits `0..=k`, where `k` is the
//!   last edit found. Every edit the writer reported durable must be there.
//! - **Migrations** (`--migration-kills`): for every migration stage, a child
//!   opens a seeded library with a later build's migrations and is killed
//!   while paused at that stage. Before the replacement the library must be
//!   byte-for-byte unchanged and open in the old build; after it, the new
//!   build must open it without migrating again. Either way the next new
//!   build ends up migrated with the text intact.
//!
//! ```text
//! cargo run --release -p dr-store --bin f2-crash -- run [--kills 60] [--migration-kills] [--out FILE]
//! cargo run --release -p dr-store --bin f2-crash -- --check [FILE]
//! ```

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dr_store::evidence::{check, machine, source_fingerprint, summarize};
use dr_store::migrate::{FaultMode, MigrationFault};
use dr_store::synthetic::{self, Rng};
use dr_store::{Library, LibraryOptions, MIGRATIONS, Migration, MigrationStage, OpenDoc, Origin};
use loro::{LoroDoc, ToJson};
use serde_json::json;

const DOC: &str = "node:crash-probe";
const COMPACT_EVERY: i64 = 25;
const VERSION: &str = "0.2.0-crash";
const DEFAULT_OUT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../docs/rust-rewrite/acceptance/f2-crash-recovery.json"
);

/// What a later build appends.
const LATER: Migration = Migration {
    name: "0001_crash_probe",
    sql: "CREATE TABLE crash_probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL) STRICT;
          INSERT INTO crash_probe (note) SELECT doc_id FROM loro_doc;",
};

type Fallible<T> = Result<T, Box<dyn std::error::Error>>;

/// A child process, the lines it printed so far, and the thread reading them.
type Spawned = (Child, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>);

fn options() -> LibraryOptions {
    let mut o = LibraryOptions::new(VERSION);
    o.configure_doc = Some(Arc::new(synthetic::configure));
    o.compaction.max_updates = usize::MAX;
    o.compaction.max_bytes = usize::MAX;
    o.compaction.on_close_min_updates = usize::MAX;
    o
}

fn genesis(doc: &LoroDoc) {
    doc.set_peer_id((1 << 63) | 0xC2A5).expect("genesis peer");
    doc.set_next_commit_timestamp(0);
}

fn create_how() -> OpenDoc<'static> {
    OpenDoc::CreateIfMissing {
        kind: "node",
        book_id: Some("book-crash"),
        genesis: &genesis,
    }
}

fn writer(root: &Path) -> Fallible<()> {
    let mut o = options();
    o.compaction_pause = Some(Duration::from_millis(20));
    let lib = Library::open(root, o)?;
    let h = lib.open_doc(DOC, create_how())?;
    let mut k = h.read(synthetic::last_crash_edit)? + 1;
    let mut out = std::io::stdout().lock();
    loop {
        h.write(Origin::User, move |doc| synthetic::crash_edit(doc, k))?;
        writeln!(out, "durable {k}")?;
        out.flush()?;
        if k % COMPACT_EVERY == 0 {
            writeln!(out, "compacting {k}")?;
            out.flush()?;
            h.compact_now()?;
            writeln!(out, "compacted {k}")?;
            out.flush()?;
        }
        k += 1;
        std::thread::sleep(Duration::from_micros(300));
    }
}

fn replay(upto: i64) -> LoroDoc {
    let doc = LoroDoc::new();
    synthetic::configure(&doc);
    doc.set_peer_id(1).expect("peer");
    for k in 0..=upto {
        synthetic::crash_edit(&doc, k);
        doc.commit();
    }
    doc
}

fn content_json(doc: &LoroDoc) -> String {
    doc.get_text(synthetic::BODY).get_richtext_value().to_json()
}

/// Spawn a child and collect its stdout lines.
fn spawn(args: &[&str]) -> Fallible<Spawned> {
    let mut child = Command::new(std::env::current_exe()?)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let reader = {
        let lines = lines.clone();
        let stdout = child.stdout.take().ok_or("no stdout")?;
        std::thread::spawn(move || {
            for l in BufReader::new(stdout).lines().map_while(Result::ok) {
                lines.lock().unwrap_or_else(|e| e.into_inner()).push(l);
            }
        })
    };
    Ok((child, lines, reader))
}

fn wait_for(lines: &Mutex<Vec<String>>, what: impl Fn(&[String]) -> bool) -> Fallible<()> {
    let start = Instant::now();
    while !what(&lines.lock().unwrap_or_else(|e| e.into_inner())) {
        if start.elapsed() > Duration::from_secs(60) {
            return Err("child did not report in time".into());
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

struct EditResults {
    phases: BTreeMap<String, usize>,
    ahead: usize,
    max_k: i64,
    recover_ms: Vec<f64>,
    verify_ms: Vec<f64>,
}

fn edit_kills(dir: &Path, kills: usize) -> Fallible<EditResults> {
    let root = dir.join("edits");
    let root_s = root.to_str().ok_or("path")?.to_string();
    let mut rng = Rng::new(0x5EED);
    let mut r = EditResults {
        phases: BTreeMap::new(),
        ahead: 0,
        max_k: 0,
        recover_ms: Vec::new(),
        verify_ms: Vec::new(),
    };
    for i in 0..kills {
        let (mut child, lines, reader) = spawn(&["writer", &root_s])?;
        wait_for(&lines, |l| !l.is_empty())?;
        std::thread::sleep(Duration::from_millis(rng.range(5, 250) as u64));
        child.kill()?;
        child.wait()?;
        reader.join().map_err(|_| "reader")?;
        let lines = lines.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let durable: i64 = lines
            .iter()
            .rev()
            .find_map(|l| l.strip_prefix("durable ").and_then(|k| k.parse().ok()))
            .ok_or("writer reported nothing")?;
        let phase = match lines.last().map(|l| l.split(' ').next().unwrap_or("")) {
            Some("compacting") => "during compaction",
            Some("compacted") => "right after compaction",
            _ => "between edits",
        };
        *r.phases.entry(phase.into()).or_default() += 1;

        let t = Instant::now();
        let lib = Library::open(&root, options())?;
        let got = lib.load_copy(DOC)?;
        let got_json = content_json(&got);
        r.recover_ms.push(t.elapsed().as_secs_f64() * 1000.0);

        let t = Instant::now();
        let k = synthetic::last_crash_edit(&got);
        if k < durable {
            return Err(format!("kill {i}: lost durable edit {durable} (recovered {k})").into());
        }
        if k > durable + 1 {
            return Err(format!("kill {i}: recovered {k} beyond reported {durable}").into());
        }
        if k > durable {
            r.ahead += 1;
        }
        if got_json != content_json(&replay(k)) {
            return Err(format!("kill {i}: recovered state differs from replay of 0..={k}").into());
        }
        let (upto, _) = lib.snapshot_info(DOC)?.unwrap_or((0, 0));
        let rows = lib.updates_since(DOC, 0)?;
        if rows.iter().any(|u| u.seq <= upto) {
            return Err(format!("kill {i}: updates covered by the snapshot survived").into());
        }
        if rows.windows(2).any(|w| w[1].seq != w[0].seq + 1)
            || rows
                .iter()
                .any(|u| u.origin != "user" && u.origin != "genesis")
        {
            return Err(format!("kill {i}: update log is not contiguous user edits").into());
        }
        r.verify_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        r.max_k = r.max_k.max(k);
        eprintln!(
            "kill {i:3}: {phase:24} durable={durable} recovered={k} pending={}",
            rows.len()
        );
    }
    Ok(r)
}

fn later() -> Vec<Migration> {
    let mut m = MIGRATIONS.to_vec();
    m.push(LATER);
    m
}

fn seed_library(root: &Path) -> Fallible<String> {
    let lib = Library::open(root, options())?;
    let h = lib.open_doc(DOC, create_how())?;
    for k in 0..40 {
        h.write(Origin::User, move |doc| synthetic::crash_edit(doc, k))?;
    }
    h.compact_now()?;
    let text = h.read(content_json)?;
    // The child process opens it next: release it completely.
    h.close();
    lib.close()?;
    Ok(text)
}

fn migrating_child(root: &Path, stage: &str) -> Fallible<()> {
    let stage = MigrationStage::parse(stage).ok_or("unknown stage")?;
    let mut o = options();
    o.migration_fault = Some(MigrationFault {
        stage,
        mode: FaultMode::Pause,
    });
    Library::open_with_migrations(root, o, &later())?;
    Err("the migration did not pause".into())
}

fn shadows(root: &Path) -> Fallible<usize> {
    Ok(std::fs::read_dir(root)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
        .count())
}

fn migration_kills(dir: &Path) -> Fallible<serde_json::Value> {
    let mut stages = serde_json::Map::new();
    for stage in MigrationStage::ALL {
        let root = dir.join(format!("migrate-{stage}"));
        let text = seed_library(&root)?;
        let db = root.join("library.sqlite");
        let before = dr_store::file_io::file_sha256(&db)?.0;
        let root_s = root.to_str().ok_or("path")?.to_string();
        let (mut child, lines, reader) = spawn(&["migrate", &root_s, stage.as_str()])?;
        let marker = format!("MIGRATION_STAGE:{stage}");
        wait_for(&lines, |l| l.contains(&marker))?;
        child.kill()?;
        child.wait()?;
        reader.join().map_err(|_| "reader")?;
        let unchanged = dr_store::file_io::file_sha256(&db)?.0 == before;
        let shadow_left = shadows(&root)?;
        // An old build opens it again when the replacement had not happened.
        let old_build = Library::open(&root, options()).map(|lib| {
            let ok = lib
                .load_copy(DOC)
                .map(|d| content_json(&d) == text)
                .unwrap_or(false);
            (ok, shadows(&root).unwrap_or(usize::MAX) == 0)
        });
        let new_build = Library::open_with_migrations(&root, options(), &later())?;
        let migrated_now = new_build.open_report().migrations_applied;
        let intact = content_json(&new_build.load_copy(DOC)?) == text;
        drop(new_build);
        let replaced = stage == MigrationStage::Reopen;
        let ok = if replaced {
            !unchanged && old_build.is_err() && migrated_now == 0 && intact
        } else {
            unchanged && matches!(old_build, Ok((true, true))) && migrated_now == 1 && intact
        };
        eprintln!(
            "migration killed at {stage:9}: unchanged={unchanged} shadow_left={shadow_left} migrated_on_retry={migrated_now} intact={intact}"
        );
        if !ok {
            return Err(format!("migration kill at {stage} did not recover").into());
        }
        stages.insert(
            stage.as_str().into(),
            json!({
                "libraryBytesUnchanged": unchanged,
                "shadowFilesLeftByKill": shadow_left,
                "oldBuildOpensIt": old_build.as_ref().map(|(t, _)| *t).unwrap_or(false),
                "staleShadowRemovedOnOpen": old_build.as_ref().map(|(_, s)| *s).unwrap_or(true),
                "migrationsAppliedByNextOpen": migrated_now,
                "textIntact": intact,
            }),
        );
    }
    Ok(serde_json::Value::Object(stages))
}

fn run(kills: usize, with_migrations: bool, out: &Path) -> Fallible<()> {
    let dir = tempfile_dir()?;
    let edits = edit_kills(&dir, kills)?;
    let migrations = if with_migrations {
        migration_kills(&dir)?
    } else {
        serde_json::Value::Null
    };
    let doc = json!({
        "schemaVersion": 1,
        "probe": "F2 dr-store crash recovery",
        "generatedBy": "cargo run --release -p dr-store --bin f2-crash -- run",
        "sourceFingerprint": source_fingerprint(),
        "loro": "1.17.1",
        "machine": machine(),
        "method": "kill the writer at random moments (SIGKILL / TerminateProcess); reopen; compare with a deterministic replay of edits 0..=k; kill migrations paused at each stage",
        "compactEvery": COMPACT_EVERY,
        "compactionHeldOpenMs": 20,
        "results": {
            "kills": kills,
            "killsByPhase": edits.phases,
            "lostDurableEdits": 0,
            "mismatches": 0,
            "recoveredOneEditBeyondLastReport": edits.ahead,
            "editsAtEnd": edits.max_k + 1,
            "recoverOpenAndLoadMs": summarize(&edits.recover_ms).json(),
            "verifyByReplayMs": summarize(&edits.verify_ms).json(),
            "migrationKills": migrations,
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

fn tempfile_dir() -> Fallible<PathBuf> {
    let dir = std::env::temp_dir().join(format!(
        "f2-crash-{}-{}",
        std::process::id(),
        dr_store::now_ms()
    ));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn main() -> Fallible<()> {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    match args.get(1).map(String::as_str) {
        Some("writer") => writer(Path::new(args.get(2).ok_or("root")?)),
        Some("migrate") => migrating_child(
            Path::new(args.get(2).ok_or("root")?),
            args.get(3).ok_or("stage")?,
        ),
        Some("run") => {
            let kills = flag("--kills").and_then(|k| k.parse().ok()).unwrap_or(60);
            let out = PathBuf::from(flag("--out").unwrap_or_else(|| DEFAULT_OUT.to_string()));
            run(kills, args.iter().any(|a| a == "--migration-kills"), &out)
        }
        Some("--check") => {
            let path = args.get(2).cloned().unwrap_or_else(|| DEFAULT_OUT.to_string());
            check(Path::new(&path), &["results", "machine"])?;
            eprintln!("{path}: matches this build");
            Ok(())
        }
        _ => Err("usage: f2-crash run [--kills N] [--migration-kills] [--out FILE] | f2-crash --check [FILE]".into()),
    }
}
