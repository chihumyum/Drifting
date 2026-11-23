//! M27's request-size estimate (`dr_agent::context`, LM hand-back in
//! `m28-model-providers.md`): one rate for each kind of text, the same for
//! the four hosted services and local servers. Chinese and English prose
//! come from dr-testkit's sample books, the JSON from the Agent's own tool
//! schemas and book structure; no model or tokenizer is called.

use dr_agent::ToolExecutor;
use dr_agent::context::{Contribution, Prepared, estimate_text_tokens, estimate_tokens, prepare};
use dr_agent::long_task::{ChainSnapshot, ManifestState};
use dr_agent::{ModelCapabilities, Provider, RunConfig};
use dr_agent_tools::AgentTools;
use dr_agent_tools::catalog::Catalog;
use dr_model::conversation::{ConversationEntry, ConversationEntryKind};
use dr_model::id::{BookId, ConversationId};
use dr_testkit::samples;
use dr_testkit::seed::{self, SeededBookV3};
use dr_workspace::Workspace;
use serde_json::{Value, json};

fn prose(book: &SeededBookV3) -> Vec<String> {
    book.prose
        .iter()
        .map(|doc| doc.view().plain_text())
        .filter(|text| !text.trim().is_empty())
        .collect()
}

fn bytes(value: &impl serde::Serialize) -> u64 {
    serde_json::to_vec(value).unwrap().len() as u64
}

fn per_token(bytes: usize, tokens: u64) -> f64 {
    bytes as f64 / tokens as f64
}

/// Chinese (《慢钟》 and 《阿Q正传》): a token and a half a character, about
/// two bytes a token. Some tokenizers (Anthropic's, Llama 3's) often take
/// more than one for a common character; this is half the old one-a-byte
/// bound.
#[test]
fn chinese_prose_is_a_token_and_a_half_a_character() {
    let mut paragraphs = prose(&samples::slow_clock_v3().unwrap());
    paragraphs.extend(prose(&samples::a_q_v3().unwrap()));
    let text = paragraphs.join("\n");
    let characters = text.chars().filter(|c| !c.is_ascii()).count() as u64;
    assert!(characters > 10_000, "{characters}");
    let tokens = estimate_text_tokens(&text);
    assert!(
        tokens * 2 >= characters * 3,
        "{tokens} < 1.5 × {characters}"
    );
    let rate = per_token(text.len(), tokens);
    assert!((1.85..=2.05).contains(&rate), "{rate} bytes a token");
}

/// English: a token for every four letters of a word or part of them,
/// about three and a half bytes a token, never less than a token a word.
#[test]
fn english_prose_is_about_four_letters_a_token() {
    let text = prose(&samples::pride_and_prejudice_v3().unwrap()).join("\n");
    let words = text.split_whitespace().count() as u64;
    assert!(words > 50_000, "{words}");
    let tokens = estimate_text_tokens(&text);
    assert!(tokens >= words, "{tokens} < {words}");
    let rate = per_token(text.len(), tokens);
    assert!((3.0..=4.2).contains(&rate), "{rate} bytes a token");
}

/// JSON: the Agent's tool schemas and the book structure it reads first,
/// counted as the model reads them: the schemas between two and three bytes
/// a token, the structure (with its Chinese names) about two.
#[test]
fn tool_schemas_and_the_book_structure_are_counted_as_json() {
    let catalog = Catalog::new();
    let schemas: Vec<Value> = catalog
        .entries()
        .iter()
        .map(|entry| json!({"name": entry.name, "description": entry.description, "input_schema": entry.input_schema}))
        .collect();
    let tokens = estimate_tokens(&schemas).unwrap();
    let rate = per_token(bytes(&schemas) as usize, tokens);
    assert!((2.0..=3.2).contains(&rate), "{rate} bytes a token");

    let tools = AgentTools::new();
    let descriptors = tools.descriptors();
    let tokens = estimate_tokens(&descriptors).unwrap();
    assert!(tokens <= bytes(&descriptors));
    let rate = per_token(bytes(&descriptors) as usize, tokens);
    assert!((2.0..=3.2).contains(&rate), "{rate} bytes a token");

    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "m27-estimate").unwrap();
    let book = samples::slow_clock_v3().unwrap();
    seed::write_book_v3(ws.library(), &book).unwrap();
    let context = tools.context(&ws, book.book_id(), "estimate").unwrap();
    let structure = &context[0].text;
    let tokens = estimate_text_tokens(structure);
    let rate = per_token(structure.len(), tokens);
    assert!((1.7..=2.4).contains(&rate), "{rate} bytes a token");
    // Text holding JSON is counted once: escaping it again adds little.
    let escaped = estimate_tokens(structure).unwrap();
    assert!(escaped <= tokens + 1, "{escaped} > {tokens} + 1");
    ws.close();
}

/// The estimate is never more than the bytes it replaces, for text and for
/// JSON: whatever fitted under the old bound fits now.
#[test]
fn the_estimate_never_exceeds_the_old_byte_bound() {
    let mut texts: Vec<String> = Vec::new();
    for book in [
        samples::slow_clock_v3().unwrap(),
        samples::pride_and_prejudice_v3().unwrap(),
        samples::a_q_v3().unwrap(),
    ] {
        texts.extend(prose(&book));
    }
    texts.extend(
        [
            "", " ", "\n", "\t\t", "a", "1", "😀", "第1章", "\"\\\"", "  x  ", "abc def",
        ]
        .map(str::to_owned),
    );
    for text in &texts {
        assert!(estimate_text_tokens(text) <= text.len() as u64, "{text:?}");
        let value = json!({"text": text, "list": [text, null, true, 12.5, []], "": {}});
        assert!(
            estimate_tokens(&value).unwrap() <= bytes(&value),
            "{text:?}"
        );
    }
    let catalog = Catalog::new();
    for entry in catalog.entries() {
        assert!(estimate_tokens(&entry.input_schema).unwrap() <= bytes(&entry.input_schema));
    }
}

fn snapshot(config: &RunConfig) -> ChainSnapshot {
    ChainSnapshot {
        chain: "chain".into(),
        book: BookId::new_v7(),
        conversation: ConversationId::new_v7(),
        original_request: "通读全书".into(),
        steering: Vec::new(),
        config: config.clone(),
        plan: None,
        constraints: Vec::new(),
        manifest_state: ManifestState::default(),
    }
}

/// Every sample chapter as one message of an earlier conversation, `times`
/// over.
fn history(times: usize) -> Vec<ConversationEntry> {
    let mut chapters = Vec::new();
    for book in [
        samples::slow_clock_v3().unwrap(),
        samples::pride_and_prejudice_v3().unwrap(),
        samples::a_q_v3().unwrap(),
    ] {
        chapters.extend(prose(&book));
    }
    let mut rows = Vec::new();
    for round in 0..times {
        // A message a book's worth of chapters, so trimming takes few steps.
        for (n, part) in chapters.chunks(8).enumerate() {
            rows.push(ConversationEntry {
                id: format!("{round}-{n}"),
                session: "session".into(),
                turn: 1,
                kind: ConversationEntryKind::User,
                payload: json!({"text": part.join("\n")}),
            });
        }
    }
    rows
}

/// The pinned record every request starts with carries BOOK_STRUCTURE.json
/// as JSON, byte for byte, not as a string holding it: the model reads no
/// backslash before every quote, and the record counts about what the
/// structure counts on its own. Other local context (PROJECT_MEMORY.md)
/// stays text, even when it starts with a brace.
#[test]
fn the_book_structure_is_pinned_as_json_not_as_an_escaped_string() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "cx-pins").unwrap();
    let book = samples::slow_clock_v3().unwrap();
    seed::write_book_v3(ws.library(), &book).unwrap();
    let mut context = AgentTools::new()
        .context(&ws, book.book_id(), "pins")
        .unwrap();
    let structure = context[0].text.clone();
    let memory = "{不是 JSON}\n# PROJECT_MEMORY.md\n\n人名以要素为准。";
    context.push(Contribution {
        source: "PROJECT_MEMORY.md".into(),
        text: memory.into(),
    });
    let config = RunConfig::new(Provider::Local, "synthetic-model");
    let snapshot = snapshot(&config);
    let pins = dr_agent::context::pins(&snapshot, &context).unwrap();

    assert!(
        pins.contains(&structure),
        "the structure is set in verbatim"
    );
    let read: Value = serde_json::from_str(&pins).unwrap();
    assert_eq!(
        read["local_context"][0]["text"],
        serde_json::from_str::<Value>(&structure).unwrap()
    );
    assert_eq!(read["local_context"][1]["text"], memory);
    let escaped = serde_json::to_string(&structure).unwrap();
    assert!(!pins.contains(&escaped));

    // The record counts the structure once, as itself: no more than the
    // structure on its own and the record around an empty object (give or
    // take the punctuation meeting at its two seams).
    let structure_tokens = estimate_text_tokens(&structure);
    let pins_tokens = estimate_text_tokens(&pins);
    let mut bare = context.clone();
    bare[0].text = "{}".into();
    let around = estimate_text_tokens(&dr_agent::context::pins(&snapshot, &bare).unwrap());
    assert!(
        pins_tokens <= structure_tokens + around + 2,
        "{pins_tokens} > {structure_tokens} + {around} + 2"
    );
    // Escaped, as it used to be set in, it counts at least 5 % more.
    assert!(estimate_text_tokens(&escaped) * 20 >= structure_tokens * 21);
    ws.close();
}

/// A conversation record's own id and session are never sent to a model;
/// they count a token a byte, so two requests that differ only in the
/// digits of their random ids count the same, and never less than the text
/// rules counted them.
#[test]
fn random_record_ids_count_the_same_whatever_their_digits() {
    let config = RunConfig::new(Provider::Local, "synthetic-model");
    let counted = |id: &str| {
        let mut snapshot = snapshot(&config);
        snapshot.chain = id.to_owned();
        let history = vec![ConversationEntry {
            id: format!("{id}:3"),
            session: id.to_owned(),
            turn: 1,
            kind: ConversationEntryKind::User,
            payload: json!({"text": "你好，本地模型"}),
        }];
        let Prepared::Ready {
            conversation,
            checkpoint,
        } = prepare(&config, &snapshot, history, &[], Vec::new()).unwrap()
        else {
            panic!("a short message fits");
        };
        // 514 is the fixed part (512, an empty system prompt and an empty
        // tool list).
        let records = checkpoint.estimated_input_tokens - 514;
        assert!(records >= estimate_tokens(&conversation).unwrap());
        assert!(records <= bytes(&conversation));
        records
    };
    let digits = counted("01993726-1185-7012-8324-350617426951");
    let letters = counted("0bacdefa-cdef-7abc-bdef-abcdefabcdef");
    assert_eq!(digits, letters);
}

/// A 1M-context service: a conversation the old bound would have cut is
/// sent whole, and one past the window is still cut to fit; what is sent is
/// never estimated above its bytes.
#[test]
fn a_million_token_context_keeps_at_least_what_it_kept_and_still_cuts_to_fit() {
    let mut config = RunConfig::new(Provider::Anthropic, "synthetic-model");
    config.capabilities = Some(ModelCapabilities {
        context_window: Some(1_000_000),
        max_output_tokens: Some(64_000),
        ..Default::default()
    });
    let snapshot = snapshot(&config);

    let whole = history(2);
    let whole_bytes = bytes(&whole);
    assert!(whole_bytes > 1_000_000, "{whole_bytes}");
    let Prepared::Ready {
        conversation,
        checkpoint,
    } = prepare(&config, &snapshot, whole.clone(), &[], Vec::new()).unwrap()
    else {
        panic!("a conversation of {whole_bytes} bytes fits a million tokens");
    };
    assert_eq!(checkpoint.covered_count, 0);
    assert_eq!(conversation.len(), whole.len() + 1);
    assert!(checkpoint.estimated_input_tokens <= checkpoint.input_budget);
    // The conversation's estimate is at most its bytes; 514 is the fixed
    // part (512, an empty system prompt and an empty tool list).
    assert!(checkpoint.estimated_input_tokens <= bytes(&conversation) + 514);

    let past = history(5);
    let Prepared::Ready {
        conversation,
        checkpoint,
    } = prepare(&config, &snapshot, past.clone(), &[], Vec::new()).unwrap()
    else {
        panic!("earlier messages are left out to fit");
    };
    assert!(checkpoint.covered_count > 0);
    assert!(conversation.len() < past.len());
    assert!(checkpoint.estimated_input_tokens <= checkpoint.input_budget);
    assert!(checkpoint.input_budget < 1_000_000);
}
