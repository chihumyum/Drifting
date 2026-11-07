//! The benchmark convention.
//!
//! A **suite** is a function from a [`Mode`] to a [`Bench`]: named cases,
//! each with a *shape* (counts and sizes: how many writes, how many events,
//! how many characters) and timing *samples*.
//!
//! - In [`Mode::Quick`] a suite runs on the tiny seed with few repetitions.
//!   CI runs every suite this way (`bench --check`, and the tests) and
//!   checks only the shape: that the benchmark still does what it says.
//! - In [`Mode::Full`] it runs on the heavy seed, on the author's machine,
//!   in release. Timings are recorded, never asserted; with `--milestone`
//!   the result becomes measured evidence ([`crate::evidence`]).
//!
//! ```text
//! cargo run --release -p dr-testkit --bin bench -- store [--milestone f8-m1] [--out FILE]
//! cargo run -p dr-testkit --bin bench -- --check
//! cargo run -p dr-testkit --bin bench -- --compare a.json b.json
//! ```

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

use serde_json::{Map, Value, json};

use crate::evidence::Summary;
use crate::seed::Preset;

/// How a suite runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// CI: the tiny seed, a few repetitions, shapes only.
    Quick,
    /// The author's machine: the heavy seed, full repetitions.
    Full,
}

impl Mode {
    /// The seed preset a suite builds its data from.
    pub fn preset(self) -> Preset {
        match self {
            Mode::Quick => Preset::Tiny,
            Mode::Full => Preset::Heavy,
        }
    }

    /// `full` repetitions in full mode, `quick` in quick mode.
    pub fn reps(self, quick: usize, full: usize) -> usize {
        match self {
            Mode::Quick => quick,
            Mode::Full => full,
        }
    }
}

/// One case: what it did and how long it took.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Case {
    pub what: String,
    pub shape: Map<String, Value>,
    pub samples_ms: BTreeMap<String, Vec<f64>>,
}

/// A suite's results.
#[derive(Clone, Debug, PartialEq)]
pub struct Bench {
    pub suite: String,
    pub mode: Mode,
    pub corpus: Value,
    pub cases: BTreeMap<String, Case>,
}

impl Bench {
    pub fn new(suite: &str, mode: Mode) -> Self {
        Self {
            suite: suite.into(),
            mode,
            corpus: Value::Null,
            cases: BTreeMap::new(),
        }
    }

    pub fn case(&mut self, name: &str, what: &str) -> &mut Case {
        let c = self.cases.entry(name.into()).or_default();
        c.what = what.into();
        c
    }

    /// The shape alone: what CI compares.
    pub fn shape(&self) -> Value {
        Value::Object(
            self.cases
                .iter()
                .map(|(k, c)| (k.clone(), Value::Object(c.shape.clone())))
                .collect(),
        )
    }

    pub fn to_json(&self) -> Value {
        let cases: Map<String, Value> = self
            .cases
            .iter()
            .map(|(k, c)| {
                let ms: Map<String, Value> = c
                    .samples_ms
                    .iter()
                    .map(|(m, s)| (m.clone(), json!(Summary::of(s))))
                    .collect();
                (
                    k.clone(),
                    json!({ "what": c.what, "shape": c.shape, "ms": ms }),
                )
            })
            .collect();
        json!({
            "suite": self.suite,
            "mode": match self.mode { Mode::Quick => "quick", Mode::Full => "full" },
            "cases": cases,
        })
    }
}

impl Case {
    /// Record a count or size.
    pub fn set(&mut self, key: &str, v: impl Into<Value>) -> &mut Self {
        self.shape.insert(key.into(), v.into());
        self
    }

    /// Time `f` once under `metric`.
    pub fn time<R>(&mut self, metric: &str, f: impl FnOnce() -> R) -> R {
        let t = Instant::now();
        let r = f();
        self.sample(metric, t.elapsed().as_secs_f64() * 1e3);
        r
    }

    pub fn sample(&mut self, metric: &str, ms: f64) {
        self.samples_ms.entry(metric.into()).or_default().push(ms);
    }
}

/// A benchmark suite.
pub struct Suite {
    pub name: &'static str,
    pub about: &'static str,
    /// The crates under test, relative to `next/`; the evidence fingerprint
    /// adds [`COMMON_INPUTS`] (the bench and the corpus generator).
    pub inputs: &'static [&'static str],
    pub run: fn(Mode) -> Result<Bench, String>,
    /// The shape quick mode must produce.
    pub expect_quick: fn() -> Value,
}

/// Every suite. A module's benchmark joins by adding one here.
pub fn suites() -> Vec<Suite> {
    vec![
        doc::suite(),
        index::suite(),
        store::suite(),
        workspace::suite(),
    ]
}

pub mod doc;
pub mod index;

/// Inputs every suite's fingerprint includes: this convention and the seed.
pub const COMMON_INPUTS: &[&str] = &[
    "crates/dr-testkit/src/bench.rs",
    "crates/dr-testkit/src/bin/bench.rs",
    "crates/dr-testkit/src/rng.rs",
    "crates/dr-testkit/src/seed",
    "crates/dr-testkit/src/text.rs",
];

/// Run every suite quick and compare shapes: CI's part of benchmarking.
pub fn check_all() -> Result<usize, String> {
    let mut n = 0;
    for s in suites() {
        let got = (s.run)(Mode::Quick)?.shape();
        let want = (s.expect_quick)();
        if got != want {
            return Err(format!(
                "bench {}: quick shape changed\n want {want}\n  got {got}",
                s.name
            ));
        }
        n += 1;
    }
    Ok(n)
}

/// A side-by-side of two results' p50s: `case metric a b ratio`.
pub fn compare(a: &Value, b: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let empty = Map::new();
    let cases = |v: &Value| -> Map<String, Value> {
        v.pointer("/results/cases")
            .or_else(|| v.get("cases"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    };
    let (ca, cb) = (cases(a), cases(b));
    for (name, x) in &ca {
        let Some(y) = cb.get(name) else { continue };
        let xm = x.get("ms").and_then(Value::as_object).unwrap_or(&empty);
        let ym = y.get("ms").and_then(Value::as_object).unwrap_or(&empty);
        for (metric, xs) in xm {
            let (Some(p), Some(q)) = (
                xs.get("p50").and_then(Value::as_f64),
                ym.get(metric)
                    .and_then(|s| s.get("p50"))
                    .and_then(Value::as_f64),
            ) else {
                continue;
            };
            let ratio = if p > 0.0 { q / p } else { f64::NAN };
            out.push(format!(
                "{name:24} {metric:28} {p:>10.3} {q:>10.3} {ratio:>6.2}×"
            ));
        }
    }
    out
}

/// A scratch directory under the system temp dir, removed on drop.
pub struct Scratch(std::path::PathBuf);

impl Scratch {
    pub fn new(label: &str) -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!(
            "dr-bench-{label}-{}-{}",
            std::process::id(),
            dr_store::now_ms()
        ));
        std::fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The dr-store suite, moved from `dr-store`'s `f2-bench` onto the seed:
/// one keystroke through a document holder, and the whole book's chapters
/// loaded cold and opened as holders.
pub mod store {
    use super::*;
    use crate::rng::Rng;
    use crate::seed::{self, DEFAULT_SEED};
    use dr_store::{Durability, Library, OpenDoc, Origin};

    pub fn suite() -> Suite {
        Suite {
            name: "store",
            about: "dr-store: keystroke writes through a document holder; the book's chapters loaded cold and opened",
            inputs: &["crates/dr-store"],
            run,
            expect_quick,
        }
    }

    fn err(e: impl std::fmt::Display) -> String {
        e.to_string()
    }

    fn expect_quick() -> Value {
        json!({
            "fullBook": { "chapters": 4, "chapterWords": 3000, "holdersOpened": 4, "loads": 3 },
            "keystrokeWrite": { "chapterWords": 1200, "durability": "normal", "eventsDelivered": 50, "writes": 50 },
        })
    }

    pub fn run(mode: Mode) -> Result<Bench, String> {
        let mut bench = Bench::new("store", mode);
        let seeded = seed::generate(mode.preset(), DEFAULT_SEED).map_err(err)?;
        let shape = seeded.shape();
        bench.corpus = json!({
            "preset": shape.preset,
            "seed": shape.seed,
            "corpusFingerprint": shape.corpus_fingerprint,
        });
        let book = &seeded.books[0];
        let chapters: Vec<&dr_doc::prose::ProseDoc> =
            book.prose.iter().filter(|p| is_chapter(book, p)).collect();
        let scratch = Scratch::new("store").map_err(err)?;

        // Keystrokes into the longest chapter.
        let longest = chapters
            .iter()
            .max_by_key(|p| p.view().len())
            .ok_or("the seed has no chapters")?;
        for (label, durability) in [("normal", Durability::Normal), ("full", Durability::Full)] {
            if mode == Mode::Quick && durability == Durability::Full {
                continue;
            }
            let mut o = seed::library_options("0.2.0-bench");
            o.durability = durability;
            o.compaction.max_updates = usize::MAX;
            o.compaction.max_bytes = usize::MAX;
            o.compaction.on_close_min_updates = usize::MAX;
            let lib =
                Library::open(scratch.path().join(format!("keys-{label}")), o).map_err(err)?;
            seed::write_book(&lib, book).map_err(err)?;
            let id = longest.doc_id().to_string();
            let h = lib.open_doc(&id, OpenDoc::Existing).map_err(err)?;
            let events = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let _sub = {
                let events = events.clone();
                h.subscribe(move |_| {
                    events.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                })
            };
            let name = if label == "normal" {
                "keystrokeWrite".to_string()
            } else {
                "keystrokeWriteFull".to_string()
            };
            let case = bench.case(
                &name,
                "DocHandle::write of a one-character insert mid-chapter: commit, export, append to SQLite, deliver the event",
            );
            let writes = mode.reps(50, 2_000);
            let mut rng = Rng::new(7);
            let len = longest.view().len();
            for _ in 0..writes {
                let at = rng.range(0, len.saturating_sub(2));
                case.time("write", || {
                    h.write(Origin::User, move |doc| {
                        doc.get_text(dr_doc::schema::prose::BODY)
                            .insert(at, "字")
                            .expect("insert");
                    })
                })
                .map_err(err)?;
            }
            h.close();
            case.set("writes", writes)
                .set(
                    "eventsDelivered",
                    events.load(std::sync::atomic::Ordering::Relaxed),
                )
                .set(
                    "chapterWords",
                    crate::text::words(&longest.view().plain_text()),
                )
                .set("durability", label);
            lib.close().map_err(err)?;
        }

        // The whole book's chapters.
        let lib = Library::open(
            scratch.path().join("book"),
            seed::library_options("0.2.0-bench"),
        )
        .map_err(err)?;
        seed::write_book(&lib, book).map_err(err)?;
        let ids: Vec<String> = chapters.iter().map(|p| p.doc_id().to_string()).collect();
        let case = bench.case(
            "fullBook",
            "every chapter: load_copy cold, read all text, start a holder each, close them",
        );
        let loads = mode.reps(3, 5);
        let mut words = 0;
        for _ in 0..loads {
            let docs: Vec<loro::LoroDoc> = case
                .time("coldLoadAll", || {
                    ids.iter()
                        .map(|id| lib.load_copy(id))
                        .collect::<Result<_, _>>()
                })
                .map_err(err)?;
            words = case.time("readAllText", || {
                docs.iter()
                    .map(|d| {
                        crate::text::words(&d.get_text(dr_doc::schema::prose::BODY).to_string())
                    })
                    .sum::<usize>()
            });
            drop(docs);
            let handles: Vec<dr_store::DocHandle> = case
                .time("openAllHolders", || {
                    ids.iter()
                        .map(|id| lib.open_doc(id, OpenDoc::Existing))
                        .collect::<Result<_, _>>()
                })
                .map_err(err)?;
            case.time("closeAllHolders", || {
                for h in handles {
                    h.close();
                }
            });
        }
        case.set("chapters", ids.len())
            .set("chapterWords", words)
            .set("loads", loads)
            .set("holdersOpened", ids.len());
        if mode == Mode::Full {
            case.set("librarySqliteBytes", lib.size_bytes().map_err(err)?);
        }
        lib.close().map_err(err)?;
        Ok(bench)
    }

    fn is_chapter(book: &seed::SeededBook, p: &dr_doc::prose::ProseDoc) -> bool {
        match p.doc_id() {
            dr_model::DocId::Node(n) => book
                .book
                .view()
                .node(n)
                .is_some_and(|n| n.kind == dr_model::kind::NodeKind::Chapter),
            _ => false,
        }
    }
}

/// The dr-workspace suite, moved from F3's `tests/measure.rs`
/// (`f3-workspace-measure.json`) onto the seed: the book is written through
/// the commands (the heavy seed has the workload F3 measured: 100 chapters,
/// 300 elements, 200 ideas, 400 relations, 200 comments and TODOs), then
/// queries cold and warm, queries after an event, single commands, search
/// and undoing an Agent turn.
pub mod workspace {
    use super::*;
    use crate::seed::{self, DEFAULT_SEED};
    use dr_workspace::commands::ListIn;
    use dr_workspace::commands::chapter::ChapterList;
    use dr_workspace::{Actor, Workspace};

    pub fn suite() -> Suite {
        Suite {
            name: "workspace",
            about: "dr-workspace: the seed written through the commands; queries cold, warm and after events; commands; search; an Agent turn undone",
            inputs: &["crates/dr-workspace", "crates/dr-testkit/src/seed"],
            run,
            expect_quick,
        }
    }

    fn err(e: impl std::fmt::Display) -> String {
        e.to_string()
    }

    fn expect_quick() -> Value {
        json!({
            "agentUndo": { "writes": 3 },
            "coldQueries": { "chapters": 4, "comments": 6, "elements": 6, "relations": 6 },
            "commands": { "each": 3 },
            "queriesAfterEvents": { "each": 3 },
            "search": { "each": 3 },
            "seedViaCommands": { "books": 1, "commands": 49, "proseEdits": 19 },
            "warmQueries": { "each": 3 },
        })
    }

    /// A call by name as the author; the output.
    fn out(ws: &Workspace, name: &str, input: Value) -> Result<Value, String> {
        ws.call(&Actor::User, name, input)
            .map(|o| o["output"].clone())
            .map_err(|e| format!("{name}: {e}"))
    }

    fn ids(v: &Value) -> Vec<String> {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x["id"].as_str().map(str::to_string))
            .collect()
    }

    pub fn run(mode: Mode) -> Result<Bench, String> {
        let mut bench = Bench::new("workspace", mode);
        let scratch = Scratch::new("workspace").map_err(err)?;
        let dir = scratch.path().join("library");
        let shape = seed::generate(mode.preset(), DEFAULT_SEED)
            .map_err(err)?
            .shape();
        bench.corpus = json!({
            "preset": shape.preset,
            "seed": shape.seed,
            "corpusFingerprint": shape.corpus_fingerprint,
        });

        let ws = Workspace::open_dir(&dir, "0.2.0-bench").map_err(err)?;
        let case = bench.case(
            "seedViaCommands",
            "the whole preset written through Workspace::call and editing sessions",
        );
        let made = case.time("seed", || {
            seed::generate_via_commands(mode.preset(), DEFAULT_SEED, &ws, &Actor::Import)
        })?;
        case.set("books", made.len())
            .set("commands", made[0].commands)
            .set("proseEdits", made[0].prose_edits);
        let b = made[0].book.clone();
        ws.shutdown().map_err(err)?;

        // Cold: a fresh workspace over the reopened library.
        let ws = Workspace::open_dir(&dir, "0.2.0-bench").map_err(err)?;
        let case = bench.case(
            "coldQueries",
            "the first chapter, element, relation and comment lists after reopening",
        );
        let chapters = case.time("chapterList", || {
            out(&ws, "chapter.list", json!({ "book": b }))
        })?;
        let elements = case.time("elementList", || {
            out(&ws, "element.list", json!({ "book": b }))
        })?;
        let relations = case.time("relationList", || {
            out(&ws, "relation.list", json!({ "book": b }))
        })?;
        let comments = case.time("commentList", || {
            out(&ws, "comment.list", json!({ "book": b }))
        })?;
        let (chapters, elements) = (ids(&chapters), ids(&elements));
        case.set("chapters", chapters.len())
            .set("elements", elements.len())
            .set("relations", relations.as_array().map_or(0, Vec::len))
            .set("comments", comments.as_array().map_or(0, Vec::len));

        let n = mode.reps(3, 300);
        let case = bench.case("warmQueries", "the same lists again, by name and typed");
        for _ in 0..n {
            case.time("chapterList", || {
                out(&ws, "chapter.list", json!({ "book": b }))
            })?;
            case.time("chapterListTyped", || {
                ws.run::<ChapterList>(
                    &Actor::User,
                    ListIn {
                        book: b.clone(),
                        trashed: false,
                    },
                )
                .map_err(err)
            })?;
            case.time("elementList", || {
                out(&ws, "element.list", json!({ "book": b }))
            })?;
            case.time("relationList", || {
                out(&ws, "relation.list", json!({ "book": b }))
            })?;
        }
        case.set("each", n);

        let rt = out(&ws, "relation_type.list", json!({ "book": b }))?
            .as_array()
            .into_iter()
            .flatten()
            .find(|t| t["locked"] != json!(true))
            .and_then(|t| t["id"].as_str().map(str::to_string))
            .ok_or("the seed has no relation type of its own")?;
        let n = mode.reps(3, 100);
        let case = bench.case(
            "queriesAfterEvents",
            "a list right after a change it shows: a chapter summary, a new relation",
        );
        for i in 0..n {
            let c = &chapters[i % chapters.len()];
            out(
                &ws,
                "chapter.update",
                json!({ "book": b, "id": c, "summary": format!("s{i}") }),
            )?;
            case.time("chapterListAfterUpdate", || {
                out(&ws, "chapter.list", json!({ "book": b }))
            })?;
            out(
                &ws,
                "relation.create",
                json!({
                    "book": b, "relation_type": rt,
                    // The seed's own type relates elements to elements.
                    "from": { "kind": "element", "id": elements[(2 * i + 1) % elements.len()] },
                    "to": { "kind": "element", "id": elements[(2 * i) % elements.len()] },
                }),
            )?;
            case.time("relationListAfterCreate", || {
                out(&ws, "relation.list", json!({ "book": b }))
            })?;
        }
        case.set("each", n);

        let n = mode.reps(3, 100);
        let long = crate::text::plain(&crate::text::body(
            &mut crate::rng::Rng::new(7),
            2_000,
            crate::text::BodyShape::default(),
        ));
        let case = bench.case("commands", "single commands as the author");
        for i in 0..n {
            let c = &chapters[i % chapters.len()];
            case.time("chapterCreate", || {
                out(
                    &ws,
                    "chapter.create",
                    json!({ "book": b, "title": format!("新章{i}") }),
                )
            })?;
            case.time("chapterCreateWith2000Words", || {
                out(
                    &ws,
                    "chapter.create",
                    json!({ "book": b, "title": format!("带字{i}"), "text": long }),
                )
            })?;
            case.time("chapterRename", || {
                out(
                    &ws,
                    "chapter.update",
                    json!({ "book": b, "id": c, "title": format!("改名{i}") }),
                )
            })?;
            case.time("chapterMove", || {
                out(
                    &ws,
                    "chapter.move",
                    json!({ "book": b, "id": c, "place": "last" }),
                )
            })?;
            case.time("elementCreate", || {
                out(
                    &ws,
                    "element.create",
                    json!({ "book": b, "name": format!("新要素{i}") }),
                )
            })?;
            case.time("commentCreate", || {
                out(
                    &ws,
                    "comment.create",
                    json!({ "book": b, "target": { "kind": "node", "id": c }, "body": "x" }),
                )
            })?;
            case.time("chapterTrashThenRestore", || -> Result<(), String> {
                out(&ws, "chapter.trash", json!({ "book": b, "id": c }))?;
                out(&ws, "chapter.restore", json!({ "book": b, "id": c }))?;
                Ok(())
            })?;
            let doc = format!("node:{c}");
            let p = out(&ws, "prose.read", json!({ "doc": doc, "limit": 2 }))?;
            let para = &p["paragraphs"][1];
            let find: String = para["text"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(6)
                .collect();
            case.time("proseReplace", || {
                out(&ws, "prose.replace", json!({ "doc": doc, "find": find, "replace": "替换", "block_id": para["block_id"] }))
            })?;
            case.time("objectUndo", || ws.undo(&Actor::User).map_err(err))?;
        }
        case.set("each", n);

        for d in ws.library().docs(Some(&b), None).map_err(err)? {
            ws.library().reindex_doc(&d.doc_id).map_err(err)?;
        }
        let n = mode.reps(3, 50);
        let case = bench.case("search", "book.search over the derived index");
        for _ in 0..n {
            case.time("threeCharacters", || {
                out(&ws, "book.search", json!({ "book": b, "query": "灯塔亮" }))
            })?;
            case.time("oneCharacter", || {
                out(&ws, "book.search", json!({ "book": b, "query": "灯" }))
            })?;
        }
        case.set("each", n);

        let writes = mode.reps(3, 10);
        let agent = Actor::agent("bench", 1, "c");
        for (i, c) in chapters.iter().take(writes).enumerate() {
            ws.call(
                &agent,
                "chapter.update",
                json!({ "book": b, "id": c, "title": format!("代笔{i}") }),
            )
            .map_err(err)?;
        }
        let case = bench.case(
            "agentUndo",
            "history.undo_agent of one turn of title changes",
        );
        case.time("undoTurn", || {
            out(
                &ws,
                "history.undo_agent",
                json!({ "session": "bench", "turn": 1 }),
            )
        })?;
        case.set("writes", writes);
        ws.shutdown().map_err(err)?;
        Ok(bench)
    }
}
