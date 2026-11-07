//! Memory and per-commit cost of the open documents, printed only (the
//! timed suite with evidence is dr-testkit's `bench workspace`). Two ignored
//! tests, run as two processes so the measured one starts clean:
//!
//! ```text
//! DR_FOOTPRINT_DIR=<empty dir> cargo test --release -p dr-workspace --test footprint -- --ignored --exact build
//! DR_FOOTPRINT_DIR=<same dir>  cargo test --release -p dr-workspace --test footprint -- --ignored --exact measure --nocapture
//! ```
//!
//! The book is synthetic: 100 chapters of about 3,000 characters in 30
//! paragraphs, 300 elements.

use std::path::PathBuf;
use std::time::Instant;

use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use serde_json::{Value, json};

const CHAPTERS: usize = 100;
const ELEMENTS: usize = 300;

fn dir() -> PathBuf {
    PathBuf::from(std::env::var("DR_FOOTPRINT_DIR").expect("set DR_FOOTPRINT_DIR"))
}

fn open(max_open_prose: usize) -> Workspace {
    let lib = Library::open(dir().join("library"), library_options("0.2.0-footprint")).unwrap();
    let options = WorkspaceOptions {
        max_open_prose,
        ..WorkspaceOptions::default()
    };
    Workspace::open(lib, options).unwrap()
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

/// Made-up text: characters from a fixed list, paragraphs of 100.
fn prose(seed: usize) -> String {
    const CHARS: &str = "潮水退去码头只剩木桩钟楼停在三点十七分她沿着防波堤往东走风从背后推着远处灯塔的影子云遮住月亮小屋亮着一盏灯窗台上摆着玻璃瓶装的是沙颜色都不一样";
    let chars: Vec<char> = CHARS.chars().collect();
    (0..30)
        .map(|p| {
            (0..100)
                .map(|i| chars[(seed * 31 + p * 7 + i * 13) % chars.len()])
                .collect::<String>()
                + "。"
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Resident memory of this process, in MiB (`ps`).
fn rss_mib() -> f64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps");
    let kib: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
    kib / 1024.0
}

fn pct(mut v: Vec<f64>, p: f64) -> f64 {
    v.sort_by(f64::total_cmp);
    v[((v.len() - 1) as f64 * p).round() as usize]
}

fn report(what: &str, v: Vec<f64>) {
    println!(
        "{what:<32} p50 {:>7.3} ms   p95 {:>7.3} ms   n {}",
        pct(v.clone(), 0.5),
        pct(v.clone(), 0.95),
        v.len()
    );
}

#[test]
#[ignore = "builds the footprint library; see the module docs"]
fn build() {
    let ws = open(16);
    let book = out(&ws, "book.create", json!({ "name": "Footprint" }))["id"]
        .as_str()
        .unwrap()
        .to_string();
    for i in 0..CHAPTERS {
        out(
            &ws,
            "chapter.create",
            json!({ "book": book, "title": format!("第{i}章"), "text": format!("〔记号{i}〕{}", prose(i)) }),
        );
    }
    for i in 0..ELEMENTS {
        out(
            &ws,
            "element.create",
            json!({ "book": book, "name": format!("要素{i}") }),
        );
    }
    std::fs::write(dir().join("book.txt"), &book).unwrap();
    ws.shutdown().unwrap();
}

#[test]
#[ignore = "measures the footprint library; see the module docs"]
fn measure() {
    let book = std::fs::read_to_string(dir().join("book.txt")).unwrap();
    let start = rss_mib();
    let ws = open(CHAPTERS + 10);
    let chapters: Vec<String> = out(&ws, "chapter.list", json!({ "book": book }))
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(chapters.len(), CHAPTERS);
    let book_open = rss_mib();
    for c in &chapters {
        out(
            &ws,
            "prose.read",
            json!({ "doc": format!("node:{c}"), "limit": 1 }),
        );
    }
    let all_open = rss_mib();
    println!(
        "memory: book open +{:.1} MiB; {CHAPTERS} chapters open +{:.1} MiB ({:.2} MiB each)",
        book_open - start,
        all_open - book_open,
        (all_open - book_open) / CHAPTERS as f64
    );

    // A keystroke-sized commit through an editing session.
    let sessions: Vec<_> = chapters
        .iter()
        .take(10)
        .map(|c| ws.prose_session(&format!("node:{c}")).unwrap())
        .collect();
    let mut keystroke = Vec::new();
    for i in 0..500 {
        let s = &sessions[i % sessions.len()];
        let t = Instant::now();
        s.edit(|txn| txn.insert_text(0, "字")).unwrap();
        keystroke.push(t.elapsed().as_secs_f64() * 1e3);
    }
    report("keystroke (session edit)", keystroke);

    let mut summary = Vec::new();
    for i in 0..300 {
        let c = &chapters[i % chapters.len()];
        let t = Instant::now();
        out(
            &ws,
            "chapter.update",
            json!({ "book": book, "id": c, "summary": format!("s{i}") }),
        );
        summary.push(t.elapsed().as_secs_f64() * 1e3);
    }
    report("book commit (chapter.update)", summary);

    let mut replace = Vec::new();
    for (i, c) in chapters.iter().enumerate().take(100) {
        let t = Instant::now();
        out(
            &ws,
            "prose.replace",
            json!({ "doc": format!("node:{c}"), "find": format!("〔记号{i}〕"), "replace": "〔改〕" }),
        );
        replace.push(t.elapsed().as_secs_f64() * 1e3);
    }
    report("prose commit (prose.replace)", replace);
    println!(
        "memory after the edits: +{:.1} MiB over the start",
        rss_mib() - start
    );
    drop(sessions);
    ws.shutdown().unwrap();
}
