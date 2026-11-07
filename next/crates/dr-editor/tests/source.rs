//! The text source on the workspace passes gpui-prose's conformance suite
//! and behaves like gpui-prose's own `LoroSource`; the two style tables
//! agree key by key.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use dr_editor::SessionSource;
use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui_prose::text::{BlockKind, LoroSource, ProseDoc, ProseSource, conformance};
use loro::ExpandType;
use serde_json::{Value, json};

struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
}

fn env() -> &'static Env {
    static ENV: OnceLock<Env> = OnceLock::new();
    ENV.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("test")).unwrap();
        let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
        let book = call(&ws, "book.create", json!({"name": "Conformance"}))["id"]
            .as_str()
            .unwrap()
            .to_owned();
        Env {
            _dir: dir,
            ws,
            book,
        }
    })
}

/// A command's output.
fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

/// A chapter holding `paragraphs`, opened as the author's source (its undo
/// stack starts empty: the seed is written before the session opens).
fn session_source(paragraphs: &[(BlockKind, &str)]) -> Box<dyn ProseSource> {
    static N: AtomicUsize = AtomicUsize::new(0);
    let e = env();
    let text = paragraphs
        .iter()
        .map(|(_, t)| *t)
        .collect::<Vec<_>>()
        .join("\n");
    let title = format!("c{}", N.fetch_add(1, Ordering::Relaxed));
    let id = call(
        &e.ws,
        "chapter.create",
        json!({"book": e.book, "title": title, "text": text}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("node:{id}");
    if paragraphs.iter().any(|(k, _)| *k != BlockKind::Body) {
        let seed = e.ws.prose_session(&doc).unwrap();
        let mut at = 0;
        let mut headings = Vec::new();
        for (kind, t) in paragraphs {
            at += t.chars().count();
            if let Some(level) = kind.level() {
                headings.push((at, level));
            }
            at += 1;
        }
        seed.edit(move |txn| {
            for (nl, level) in headings {
                txn.set_heading(nl, dr_model::prose::Heading::from_level(level))?;
            }
            Ok(())
        })
        .unwrap();
    }
    Box::new(
        SessionSource::open(&e.ws, &doc)
            .unwrap()
            .with_foreign_writes(),
    )
}

fn loro_source(paragraphs: &[(BlockKind, &str)]) -> Box<dyn ProseSource> {
    Box::new(LoroSource::from_paragraphs(paragraphs.iter().copied()))
}

#[test]
fn the_session_source_passes_the_conformance_suite() {
    conformance::run_all(&session_source).unwrap();
}

#[test]
fn the_session_source_behaves_like_the_built_in_one() {
    conformance::same_behaviour(&loro_source, &session_source, 16, 120).unwrap();
}

/// An Agent's command lands in the open document: the editor sees it as
/// someone else's change, and the author's undo leaves it alone.
#[test]
fn an_agents_command_reaches_the_editor_as_someone_elses_change() {
    let e = env();
    let id = call(
        &e.ws,
        "chapter.create",
        json!({"book": e.book, "title": "agent", "text": "开头。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc_id = format!("node:{id}");
    let mut doc = ProseDoc::open(Box::new(SessionSource::open(&e.ws, &doc_id).unwrap()));
    doc.replace(0..0, "作者", gpui_prose::text::ORIGIN_USER);
    e.ws.call(
        &Actor::agent("s", 1, "c"),
        "prose.replace",
        json!({"doc": doc_id, "find": "开头", "replace": "起首"}),
    )
    .unwrap();
    doc.drain();
    assert_eq!(doc.plain_text(), "作者起首。\n");
    assert_eq!(doc.mirror_snapshot(), doc.reread());
    let changes = doc.take_changes();
    assert!(changes.iter().any(|c| c.origin.starts_with("agent:")));
    assert!(doc.undo().is_some());
    doc.drain();
    assert_eq!(
        doc.plain_text(),
        "起首。\n",
        "the author's text undone, the Agent's kept"
    );
    assert_eq!(doc.mirror_snapshot(), doc.reread());
}

/// Reads on the holder see whole commits; a read that saw a commit the
/// editor had not taken makes the editor rebuild its mirror.
#[test]
fn a_commit_between_events_and_a_read_resyncs_the_mirror() {
    let e = env();
    let id = call(
        &e.ws,
        "chapter.create",
        json!({"book": e.book, "title": "resync", "text": "一\n二\n三"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc_id = format!("node:{id}");
    let mut source = SessionSource::open(&e.ws, &doc_id).unwrap();
    let opened = source.resync();
    assert_eq!(opened.len(), 4);
    e.ws.call(
        &Actor::agent("s", 1, "c"),
        "prose.replace",
        json!({"doc": doc_id, "find": "二", "replace": "贰"}),
    )
    .unwrap();
    // The editor reads before taking the Agent's event.
    let _ = source.read_all();
    assert!(source.needs_resync());
    let fresh = source.resync();
    assert_eq!(fresh[1].text, "贰");
    assert!(
        source.take_events().is_empty(),
        "the resync dropped the event it read"
    );
    assert!(!source.needs_resync());
}

/// `dr-doc` configures every Drifting document; gpui-prose's table (used by
/// `LoroSource` and the conformance runs) must be the same, key by key.
#[test]
fn the_style_tables_agree_key_by_key() {
    let mismatches = dr_doc::schema::style_table_mismatches(
        gpui_prose::schema::STYLE_TABLE,
        Some(gpui_prose::schema::DEFAULT_EXPAND),
    );
    assert!(mismatches.is_empty(), "{mismatches:#?}");
    let config = gpui_prose::schema::style_config();
    for (key, want) in dr_doc::schema::STYLE_TABLE {
        let got = config.get(&(*key).into()).map(|c| c.expand);
        assert_eq!(got, Some(*want), "{key}");
    }
    // The prefix rule: an entity link gets the `entity` entry.
    assert_eq!(
        config.get(&"entity".into()).map(|c| c.expand),
        Some(ExpandType::None)
    );
}
