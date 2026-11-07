//! Measurements of common queries and commands (F3's milestone evidence).
//!
//! ```bash
//! cargo test --release -p dr-workspace --test measure -- --ignored --nocapture
//! DR_WRITE_MEASURE=1 cargo test --release -p dr-workspace --test measure -- --ignored
//! ```
//!
//! The second writes `docs/rust-rewrite/acceptance/f3-workspace-measure.json`
//! (once per milestone, per simplifications.md §5). The data is synthetic:
//! 100 chapters of about 2 000 characters, 200 ideas, 300 elements, 400
//! relations, 120 comments, like F1's book measurement.

mod common;

use std::time::Instant;

use common::*;
use dr_workspace::commands::ListIn;
use dr_workspace::commands::chapter::ChapterList;
use dr_workspace::{Actor, registry};
use serde_json::{Value, json};

fn pct(mut v: Vec<f64>, p: f64) -> f64 {
    v.sort_by(|a, b| a.total_cmp(b));
    let i = ((v.len() as f64 - 1.0) * p).round() as usize;
    v[i]
}

fn stats(samples: Vec<f64>) -> Value {
    json!({
        "n": samples.len(),
        "p50Ms": (pct(samples.clone(), 0.5) * 1000.0).round() / 1000.0,
        "p95Ms": (pct(samples.clone(), 0.95) * 1000.0).round() / 1000.0,
        "maxMs": (samples.iter().copied().fold(0.0, f64::max) * 1000.0).round() / 1000.0,
    })
}

fn time(mut f: impl FnMut()) -> f64 {
    let t = Instant::now();
    f();
    t.elapsed().as_secs_f64() * 1000.0
}

fn repeat(n: usize, mut f: impl FnMut(usize)) -> Value {
    stats((0..n).map(|i| time(|| f(i))).collect())
}

/// Deterministic synthetic prose (no manuscript text).
fn prose(seed: usize, chars: usize) -> String {
    const POOL: &[char] = &[
        '风', '雨', '山', '河', '城', '门', '灯', '夜', '人', '走', '看', '说', '在', '了', '的',
        '是',
    ];
    let mut s = String::new();
    let mut x = seed as u64 * 2654435761 + 1;
    for i in 0..chars {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.push(POOL[(x % POOL.len() as u64) as usize]);
        if i % 97 == 96 {
            s.push('\n');
        } else if i % 23 == 22 {
            s.push('。');
        }
    }
    s
}

fn fnv(bytes: &[u8], mut h: u64) -> u64 {
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// FNV-1a over this crate's sources and this file (the measured code and the
/// workload generator). A different value means the evidence is stale.
fn source_fingerprint() -> String {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    fn walk(d: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, out)
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p)
            }
        }
    }
    walk(&root.join("src"), &mut files);
    files.push(root.join("tests/measure.rs"));
    files.sort();
    let mut h = 0xcbf29ce484222325u64;
    for f in files {
        h = fnv(
            f.strip_prefix(root).unwrap().to_string_lossy().as_bytes(),
            h,
        );
        h = fnv(&std::fs::read(&f).unwrap(), h);
    }
    format!("{h:016x}")
}

fn load_avg() -> Option<String> {
    std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

#[test]
#[ignore = "measurement; run with --release --ignored"]
fn measure() {
    let mut e = env();
    let b = e.book();
    let u = Actor::User;
    let seed_start = Instant::now();
    let mut chapters = Vec::new();
    for i in 0..100 {
        chapters.push(
            e.out(
                "chapter.create",
                json!({"book": b, "title": format!("第{i}章"), "text": prose(i, 2000)}),
            )["id"]
                .as_str()
                .unwrap()
                .to_string(),
        );
    }
    for i in 0..200 {
        e.call(
            "idea.create",
            json!({"book": b, "title": format!("构想{i}")}),
        );
    }
    let mut elements = Vec::new();
    for i in 0..300 {
        elements.push(
            e.out(
                "element.create",
                json!({"book": b, "name": format!("要素{i}")}),
            )["id"]
                .as_str()
                .unwrap()
                .to_string(),
        );
    }
    let t = e.out(
        "relation_type.create",
        json!({"book": b, "name": "相识", "orientation": "symmetric",
        "source_kinds": ["element", "node"], "target_kinds": ["element", "node"]}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    for i in 0..400 {
        let a = &elements[i % 300];
        let z = &elements[(i * 7 + 1) % 300];
        if a != z {
            e.call("relation.create", json!({"book": b, "from": {"kind": "element", "id": a}, "to": {"kind": "element", "id": z}, "relation_type": t}));
        }
    }
    for i in 0..120 {
        e.call("comment.create", json!({"book": b, "kind": if i % 2 == 0 { "todo" } else { "note" }, "target": {"kind": "node", "id": chapters[i % 100]}, "body": "批注"}));
    }
    let seed_ms = seed_start.elapsed().as_secs_f64() * 1000.0;
    // Settle the derived index for search.
    for d in e.ws().library().docs(Some(&b), None).unwrap() {
        e.ws().library().reindex_doc(&d.doc_id).unwrap();
    }
    let mut m = serde_json::Map::new();
    // Cold: a fresh workspace over the reopened library.
    e.reopen();
    m.insert(
        "openBookAndListChaptersColdMs".into(),
        json!(time(|| {
            e.out("chapter.list", json!({"book": b}));
        })),
    );
    m.insert(
        "elementListColdMs".into(),
        json!(time(|| {
            e.out("element.list", json!({"book": b}));
        })),
    );
    m.insert(
        "relationListColdMs".into(),
        json!(time(|| {
            e.out("relation.list", json!({"book": b}));
        })),
    );
    m.insert(
        "commentListColdMs".into(),
        json!(time(|| {
            e.out("comment.list", json!({"book": b}));
        })),
    );
    m.insert(
        "chapterListWarm".into(),
        repeat(300, |_| {
            e.out("chapter.list", json!({"book": b}));
        }),
    );
    m.insert(
        "chapterListTypedWarm".into(),
        repeat(300, |_| {
            e.ws()
                .run::<ChapterList>(
                    &u,
                    ListIn {
                        book: b.clone(),
                        trashed: false,
                    },
                )
                .unwrap();
        }),
    );
    m.insert(
        "relationListWarm".into(),
        repeat(300, |_| {
            e.out("relation.list", json!({"book": b}));
        }),
    );
    m.insert(
        "elementListWarm".into(),
        repeat(300, |_| {
            e.out("element.list", json!({"book": b}));
        }),
    );
    // After an event: a rename patches one node; a relation change refills.
    m.insert(
        "chapterListAfterRename".into(),
        stats(
            (0..100)
                .map(|i| {
                    e.call(
                        "chapter.update",
                        json!({"book": b, "id": chapters[i], "summary": format!("s{i}")}),
                    );
                    time(|| {
                        e.out("chapter.list", json!({"book": b}));
                    })
                })
                .collect(),
        ),
    );
    m.insert("relationListAfterChange".into(), stats((0..50).map(|i| {
        e.call("relation.create", json!({"book": b, "from": {"kind": "node", "id": chapters[i]}, "to": {"kind": "element", "id": elements[i]}, "relation_type": t}));
        time(|| { e.out("relation.list", json!({"book": b})); })
    }).collect()));
    // Commands.
    m.insert(
        "chapterCreate".into(),
        repeat(100, |i| {
            e.call(
                "chapter.create",
                json!({"book": b, "title": format!("新章{i}")}),
            );
        }),
    );
    m.insert(
        "chapterCreateWith2000Chars".into(),
        repeat(50, |i| {
            e.call(
                "chapter.create",
                json!({"book": b, "title": format!("带字{i}"), "text": prose(1000 + i, 2000)}),
            );
        }),
    );
    m.insert(
        "chapterRename".into(),
        repeat(100, |i| {
            e.call(
                "chapter.update",
                json!({"book": b, "id": chapters[i % 100], "title": format!("改名{i}")}),
            );
        }),
    );
    m.insert(
        "chapterMove".into(),
        repeat(100, |i| {
            e.call(
                "chapter.move",
                json!({"book": b, "id": chapters[i % 100], "place": "last"}),
            );
        }),
    );
    m.insert(
        "elementCreate".into(),
        repeat(100, |i| {
            e.call(
                "element.create",
                json!({"book": b, "name": format!("新要素{i}")}),
            );
        }),
    );
    m.insert("relationCreate".into(), repeat(100, |i| {
        e.call("relation.create", json!({"book": b, "from": {"kind": "element", "id": elements[(i * 3) % 300]}, "to": {"kind": "node", "id": chapters[(i * 5) % 100]}, "relation_type": t}));
    }));
    m.insert(
        "chapterTrashThenRestore".into(),
        repeat(50, |i| {
            e.call("chapter.trash", json!({"book": b, "id": chapters[i]}));
            e.call("chapter.restore", json!({"book": b, "id": chapters[i]}));
        }),
    );
    m.insert("commentCreate".into(), repeat(100, |i| { e.call("comment.create", json!({"book": b, "target": {"kind": "node", "id": chapters[i % 100]}, "body": "x"})); }));
    m.insert("proseReplace".into(), repeat(100, |i| {
        let doc = format!("node:{}", chapters[i % 100]);
        let p = e.out("prose.read", json!({"doc": doc, "limit": 1}));
        let text = p["paragraphs"][0]["text"].as_str().unwrap().to_string();
        let find: String = text.chars().take(6).collect();
        let _ = e.try_call("prose.replace", json!({"doc": doc, "find": find, "replace": "替换", "block_id": p["paragraphs"][0]["block_id"]}));
    }));
    m.insert(
        "objectUndo".into(),
        repeat(50, |_| {
            e.ws().undo(&u).unwrap();
        }),
    );
    for d in e.ws().library().docs(Some(&b), None).unwrap() {
        e.ws().library().reindex_doc(&d.doc_id).unwrap();
    }
    m.insert(
        "search3Chars".into(),
        repeat(50, |_| {
            e.out("book.search", json!({"book": b, "query": "风雨山"}));
        }),
    );
    m.insert(
        "search1Char".into(),
        repeat(50, |_| {
            e.out("book.search", json!({"book": b, "query": "灯"}));
        }),
    );
    // An Agent turn of 10 writes, undone.
    let agent = Actor::agent("bench", 1, "c");
    for (i, ch) in chapters.iter().take(10).enumerate() {
        call(
            e.ws(),
            &agent,
            "chapter.update",
            json!({"book": b, "id": ch, "title": format!("代笔{i}")}),
        );
    }
    m.insert(
        "undoAgentTurnOf10WritesMs".into(),
        json!(time(|| {
            e.call("history.undo_agent", json!({"session": "bench", "turn": 1}));
        })),
    );
    let doc = json!({
        "milestone": "F3 milestone 1",
        "date": "2026-11-07",
        "machine": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "loadAvg": load_avg() },
        "build": if cfg!(debug_assertions) { "debug" } else { "release" },
        "sourceFingerprint": source_fingerprint(),
        "workload": { "chapters": 100, "charsPerChapter": 2000, "ideas": 200, "elements": 300, "relations": 400, "comments": 120, "synthetic": true },
        "registryEntries": registry().len(),
        "seedMs": seed_ms.round(),
        "results": m,
    });
    let s = serde_json::to_string_pretty(&doc).unwrap();
    println!("{s}");
    if std::env::var("DR_WRITE_MEASURE").is_ok() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/rust-rewrite/acceptance/f3-workspace-measure.json");
        std::fs::write(path, s + "\n").unwrap();
    }
}

#[test]
fn measure_evidence_has_its_shape() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/rust-rewrite/acceptance/f3-workspace-measure.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let v: Value = serde_json::from_str(&text).unwrap();
    for k in ["milestone", "sourceFingerprint", "workload", "results"] {
        assert!(v.get(k).is_some(), "{k}");
    }
    if v["sourceFingerprint"] != json!(source_fingerprint()) {
        // Measurements are not refreshed after every change (simplifications.md §5).
        eprintln!("f3-workspace-measure.json is stale (sources changed since it was taken)");
    }
}
