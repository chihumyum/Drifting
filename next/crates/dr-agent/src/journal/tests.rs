use super::*;
use crate::Usage;
use dr_testkit::seed::{self, Preset};
use dr_workspace::library_options;

struct Fixture {
    _dir: tempfile::TempDir,
    lib: Library,
    book: String,
    text: String,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path(), library_options("m27-journal")).unwrap();
        let seeded = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        seeded.write_to(&lib).unwrap();
        let book = seeded.books[0].book_id().to_string();
        let text = seeded.books[0].prose[0]
            .view()
            .paragraphs()
            .nth(1)
            .unwrap()
            .text();
        Self {
            _dir: dir,
            lib,
            book,
            text,
        }
    }

    /// A new session with only its `Started` event, as `Runtime::start`
    /// creates one.
    fn session(&self, session: &str, conversation: &ConversationId) -> Journal {
        let doc = DocId::Conversation(conversation.clone()).to_string();
        self.lib
            .local_write(|tx| {
                tx.agent_create_session(session, &doc, &self.book)?;
                tx.agent_append_event(&AgentEventAppend {
                    session: session.into(),
                    expected_seq: 0,
                    event_json:
                        json!({"turn": 1, "event": Event::Started { version: PROTOCOL_VERSION }})
                            .to_string(),
                })?;
                Ok(())
            })
            .unwrap();
        Journal::open(self.lib.clone(), session).unwrap()
    }

    fn rows(&self, session: &str) -> Vec<(u32, Event)> {
        events(&self.lib, session, 0)
            .unwrap()
            .into_iter()
            .skip(1)
            .map(|row| (row.turn, row.event))
            .collect()
    }
}

/// Appending and replaying parse the conversation's entries a bounded
/// number of times: appends of new events none, a replay of M events the M
/// stored entries once to build the index and each replayed one once to
/// compare it (2M; before, every append read the whole list: M(M+1)/2).
#[test]
fn appending_and_replaying_parse_each_entry_a_bounded_number_of_times() {
    const M: usize = 400;
    let f = Fixture::new();
    let conversation = ConversationId::new_v7();
    let mut journal = f.session("parse-first", &conversation);
    for _ in 0..M {
        journal
            .append(Event::UserMessage {
                text: f.text.clone(),
            })
            .unwrap();
    }
    assert_eq!(journal.entries_parsed(), 0);
    drop(journal);

    let replayed = Journal::open(f.lib.clone(), "parse-first").unwrap();
    assert_eq!(replayed.entries_parsed(), 2 * M);
    assert_eq!(replayed.transcript().unwrap().len(), M);
    drop(replayed);

    // A later session of the same conversation reads its list once.
    let mut next = f.session("parse-second", &conversation);
    assert_eq!(next.entries_parsed(), 0);
    for _ in 0..M {
        next.append(Event::UserMessage {
            text: f.text.clone(),
        })
        .unwrap();
    }
    assert_eq!(next.entries_parsed(), M);
    assert_eq!(next.transcript().unwrap().len(), 2 * M);
}

/// Consecutive deltas of one block and turn are joined into one row, written
/// when the block's buffer is as old as the interval, as large as the size
/// limit, when another block or turn starts, or ahead of any other event in
/// that event's transaction. An interval of zero writes every delta.
#[test]
fn streamed_deltas_are_joined_by_block_and_written_by_age_size_or_the_next_event() {
    let f = Fixture::new();
    let mut journal = f.session("stream", &ConversationId::new_v7());
    let interval = Duration::from_millis(100);
    let ms = |n: u64| Duration::from_millis(n);
    let t0 = Instant::now();
    let piece = |n: usize| f.text.chars().skip(n).take(1).collect::<String>();
    let (a, b, c, x, y, w, z) = (
        piece(0),
        piece(1),
        piece(2),
        piece(3),
        piece(4),
        piece(5),
        piece(6),
    );

    journal.stream(false, 0, &a, interval, t0).unwrap();
    journal.stream(false, 0, &b, interval, t0 + ms(50)).unwrap();
    assert!(f.rows("stream").is_empty(), "younger than the interval");
    assert_eq!(journal.flush_due(interval), Some(t0 + interval));
    journal
        .stream(false, 0, &c, interval, t0 + ms(100))
        .unwrap();
    assert_eq!(journal.flush_due(interval), None);

    journal.stream(true, 1, &x, interval, t0 + ms(110)).unwrap();
    journal
        .stream(false, 0, &y, interval, t0 + ms(120))
        .unwrap();
    assert_eq!(journal.flush_due(interval), Some(t0 + ms(220)));
    let usage = Usage {
        output_tokens: 3,
        ..Usage::default()
    };
    journal.append(Event::Usage { usage }).unwrap();

    journal
        .stream(false, 0, &w, interval, t0 + ms(300))
        .unwrap();
    journal.turn = 2;
    journal
        .stream(false, 0, &z, interval, t0 + ms(310))
        .unwrap();
    journal.flush().unwrap();

    let large = f.text.repeat(MAX_UNFLUSHED_BYTES / f.text.len() + 1);
    journal
        .stream(false, 0, &large, interval, t0 + ms(400))
        .unwrap();
    assert_eq!(journal.flush_due(interval), None, "as large as the limit");

    journal
        .stream(false, 0, &a, Duration::ZERO, t0 + ms(500))
        .unwrap();
    journal
        .stream(false, 0, &b, Duration::ZERO, t0 + ms(500))
        .unwrap();

    let text = |index, text: &str| Event::TextDelta {
        index,
        text: text.into(),
    };
    let rows = f.rows("stream");
    let expected = vec![
        (1, text(0, &format!("{a}{b}{c}"))),
        (
            1,
            Event::ThinkingDelta {
                index: 1,
                text: x.clone(),
            },
        ),
        (1, text(0, &y)),
        (1, Event::Usage { usage }),
        (1, text(0, &w)),
        (2, text(0, &z)),
        (2, text(0, &large)),
        (2, text(0, &a)),
        (2, text(0, &b)),
    ];
    assert_eq!(
        serde_json::to_value(&rows).unwrap(),
        serde_json::to_value(&expected).unwrap()
    );
}
