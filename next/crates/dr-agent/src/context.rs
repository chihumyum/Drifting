//! Deterministic bounded provider projections. Canonical history and evidence
//! stay intact; this is not a literary summary and makes no fidelity claim.
use dr_model::conversation::{ConversationEntry, ConversationEntryKind};
use dr_store::Library;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    Error, Result, RunConfig, ToolDescriptor,
    evidence::hash,
    long_task::{CHECKPOINT_ENTRY_KIND, CONTINUATION_ENTRY_KIND, ChainSnapshot},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contribution {
    pub source: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Checkpoint {
    pub version: u32,
    pub chain: String,
    pub covered_count: usize,
    pub first: Option<String>,
    pub last: Option<String>,
    pub source_hash: String,
    pub pins_hash: String,
    pub projection_hash: String,
    pub estimated_input_tokens: u64,
    pub input_budget: u64,
}

#[derive(Clone, Debug)]
pub enum Prepared {
    Ready {
        conversation: Vec<ConversationEntry>,
        checkpoint: Checkpoint,
    },
    TooLarge {
        required: u64,
        available: u64,
    },
}

/// Internal entity identities never enter these product pins. Plan/step/proof
/// handles are opaque application records, accessible through the host plan API.
pub fn plan_projection(snapshot: &ChainSnapshot, from: usize, limit: usize) -> Value {
    let plan=snapshot.plan.as_ref().map(|plan| {
        let steps=plan.steps.iter().skip(from).take(limit.min(100)).map(|step|json!({"id":step.id,"target":{"kind":step.target.kind,"name":step.target.name},"status":step.status,"note":step.note,"evidence":step.evidence,"review":step.review})).collect::<Vec<_>>();
        json!({"id":plan.id,"objective":plan.objective,"scope":plan.scope,"work_kind":plan.work_kind,"status":plan.status,"revision":plan.revision,"steps":steps,"from":from,"total_steps":plan.steps.len(),"completed":plan.steps.iter().filter(|step|step.status==crate::long_task::StepStatus::Completed).count(),"manifest":plan.manifest.iter().map(|entry|json!({"name":entry.target.name,"ordinal":entry.ordinal})).collect::<Vec<_>>()})
    });
    json!({"plan":plan,"constraints":snapshot.constraints,"manifest_state":snapshot.manifest_state})
}

pub fn pins(snapshot: &ChainSnapshot, contributions: &[Contribution]) -> Result<String> {
    let current = snapshot
        .plan
        .as_ref()
        .and_then(|plan| {
            plan.steps.iter().position(|step| {
                matches!(
                    step.status,
                    crate::long_task::StepStatus::InProgress
                        | crate::long_task::StepStatus::Pending
                )
            })
        })
        .unwrap_or(0);
    Ok(serde_json::to_string(&json!({
        "source":"Drifting durable request state; these are product facts, not model summaries",
        "original_author_request":snapshot.original_request,
        "author_steering":snapshot.steering.iter().map(|input|&input.text).collect::<Vec<_>>(),
        "task":plan_projection(snapshot,current,1),
        "other_steps":"The host retains all other steps and accepted evidence; inspect them with read_task_plan when available, and never infer completion from a summary.",
        "local_context":contributions
    }))?)
}

fn entry(snapshot: &ChainSnapshot, id: &str, text: String) -> ConversationEntry {
    ConversationEntry {
        id: format!("context:{}:{id}", snapshot.chain),
        session: snapshot.chain.clone(),
        turn: 1,
        kind: ConversationEntryKind::Other(CONTINUATION_ENTRY_KIND.into()),
        payload: json!({"version":1,"text":text}),
    }
}

/// About how many tokens `value` takes as model input: a planning bound,
/// never a generation ceiling. One estimate for every provider, the four
/// hosted services and local model servers alike. Tokenizers differ, so
/// each kind of text is counted near the rate of the least efficient
/// tokenizer among them; that stays above most real counts without the old
/// bound of one token a byte (three for every Chinese character):
///
/// - Chinese and other non-ASCII text: a token and a half a character,
///   rounded up over each run (about two bytes a token for Chinese; on some
///   tokenizers, Anthropic's and Llama 3's among them, a common Chinese
///   character often takes more than one); characters outside the Basic
///   Multilingual Plane (emoji, rare ideographs) two each.
/// - English: a token for every four letters of a word or part of them
///   (about three and a half bytes a token; a short word is a whole token).
/// - Digits: a token each (several local tokenizers split numbers into
///   digits).
/// - Punctuation: a token for every two marks in a row (JSON's `":"` and
///   `","`).
/// - Whitespace: a single space or tab goes with the word after it; any
///   other run of whitespace is a token.
///
/// JSON is counted as the model reads it: each string by its text and a
/// token for its quotes, each key likewise and a token for its colon and
/// comma, and a token for each bracket and separator; a string holding JSON
/// (`BOOK_STRUCTURE.json`) is text like any other, so its escapes are not
/// counted twice. The estimate never exceeds the value's size in JSON bytes,
/// the old bound: whatever fitted before still fits.
pub fn estimate_tokens(value: &impl Serialize) -> Result<u64> {
    Ok(value_tokens(&serde_json::to_value(value)?))
}

fn value_tokens(value: &Value) -> u64 {
    match value {
        Value::Null | Value::Bool(_) => 1,
        Value::Number(number) => estimate_text_tokens(&number.to_string()),
        Value::String(text) => 1 + estimate_text_tokens(text),
        Value::Array(items) => items
            .iter()
            .fold(1, |sum, item| sum + 1 + value_tokens(item)),
        Value::Object(map) => map.iter().fold(1, |sum, (key, item)| {
            sum + 2 + estimate_text_tokens(key) + value_tokens(item)
        }),
    }
}

/// About how many tokens `text` takes as model input ([`estimate_tokens`]
/// gives the rates). Never more than its length in bytes.
pub fn estimate_text_tokens(text: &str) -> u64 {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Run {
        Letters,
        Marks,
        Space {
            breaks: bool,
        },
        /// Non-ASCII characters of the Basic Multilingual Plane.
        Wide,
        /// A digit or a character outside the Basic Multilingual Plane,
        /// each counted on its own.
        Other,
    }
    fn close(run: Run, len: u64) -> u64 {
        match run {
            Run::Letters => len.div_ceil(4),
            Run::Marks => len.div_ceil(2),
            Run::Space { breaks } => u64::from(breaks || len > 1),
            // Each is two or three bytes, so this stays within the bytes.
            Run::Wide => (len * 3).div_ceil(2),
            Run::Other => 0,
        }
    }
    let mut tokens = 0;
    let mut run = Run::Other;
    let mut len = 0;
    for c in text.chars() {
        let kind = match c {
            'a'..='z' | 'A'..='Z' => Run::Letters,
            '\n' | '\r' => Run::Space { breaks: true },
            ' ' | '\t' | '\x0b' | '\x0c' => Run::Space { breaks: false },
            '0'..='9' => Run::Other,
            _ if c.is_ascii() => Run::Marks,
            _ if c.len_utf8() < 4 => Run::Wide,
            _ => Run::Other,
        };
        let same = match (run, kind) {
            (Run::Space { breaks }, Run::Space { breaks: more }) => {
                run = Run::Space {
                    breaks: breaks || more,
                };
                true
            }
            (a, b) => a == b && a != Run::Other,
        };
        if !same {
            tokens += close(run, len);
            run = kind;
            len = 0;
        }
        if kind == Run::Other {
            // A digit, or a character of four bytes.
            tokens += if c.len_utf8() == 4 { 2 } else { 1 };
        } else {
            len += 1;
        }
    }
    tokens + close(run, len)
}

fn cost(value: &impl Serialize) -> Result<u64> {
    estimate_tokens(value)
}

/// Most a single image is counted at. Anthropic downsizes an image to at
/// most 4 784 visual tokens; OpenAI's newer models read up to 10 000
/// patches of one at the detail this client asks for (the default).
const MAX_IMAGE_TOKENS: u64 = 10_000;

/// About how many tokens the images of `conversation` take as model input
/// (CM4a): a token for every 28 × 28 pixel patch (Anthropic's visual
/// tokens, OpenAI's patches), at most [`MAX_IMAGE_TOKENS`] an image, for
/// the newest images a request carries. Nothing when the model cannot see
/// images: each is then a line of text, counted with its message.
pub fn image_tokens(config: &RunConfig, conversation: &[ConversationEntry]) -> u64 {
    if !config.sees_images() {
        return 0;
    }
    conversation
        .iter()
        .rev()
        .filter(|entry| entry.kind == ConversationEntryKind::User)
        .flat_map(|entry| crate::images::payload_images(&entry.payload))
        .flatten()
        .take(crate::images::MAX_IMAGES_PER_REQUEST)
        .map(|image| {
            (u64::from(image.width).div_ceil(28) * u64::from(image.height).div_ceil(28))
                .min(MAX_IMAGE_TOKENS)
        })
        .sum()
}

/// The model's context, or 32 768 when it told none.
pub(crate) fn context_window(config: &RunConfig) -> u64 {
    config
        .capabilities
        .as_ref()
        .and_then(|c| c.context_window)
        .unwrap_or(32_768)
}

/// Room kept for the answer: the output limit the author or the model gives,
/// otherwise an eighth of the context up to 8 192 (a small local context
/// keeps less: 5 120 of 40 960, 4 096 of the 32 768 fallback); never less
/// than 4 096.
pub(crate) fn output_reserve(config: &RunConfig, window: u64) -> u64 {
    config
        .max_output_tokens
        .or_else(|| {
            config
                .capabilities
                .as_ref()
                .and_then(|c| c.max_output_tokens)
        })
        .map(u64::from)
        .unwrap_or_else(|| (window / 8).min(8_192))
        .max(4_096)
}

struct Unit {
    entries: Vec<ConversationEntry>,
    complete: bool,
}
fn units(history: Vec<ConversationEntry>) -> Vec<Unit> {
    let mut units: Vec<Unit> = Vec::new();
    for row in history {
        if row.kind == ConversationEntryKind::ToolResult
            && let Some(last) = units.last_mut()
        {
            last.entries.push(row);
            continue;
        }
        units.push(Unit {
            entries: vec![row],
            complete: true,
        });
    }
    for unit in &mut units {
        let required: Vec<_> = unit
            .entries
            .iter()
            .filter(|entry| entry.kind == ConversationEntryKind::Assistant)
            .flat_map(|entry| entry.payload["blocks"].as_array().into_iter().flatten())
            .filter_map(|block| {
                block
                    .get("call")
                    .and_then(|call| call.get("id"))
                    .and_then(Value::as_str)
            })
            .collect();
        unit.complete = required.iter().all(|call| {
            unit.entries.iter().any(|entry| {
                entry.kind == ConversationEntryKind::ToolResult
                    && entry.payload["call"].as_str() == Some(call)
            })
        });
    }
    units
}

pub fn prepare(
    config: &RunConfig,
    snapshot: &ChainSnapshot,
    history: Vec<ConversationEntry>,
    tools: &[ToolDescriptor],
    contributions: Vec<Contribution>,
) -> Result<Prepared> {
    let window = context_window(config);
    let reserve = output_reserve(config, window);
    let fixed = cost(&config.system_prompt)?
        .saturating_add(cost(&tools)?)
        .saturating_add(512)
        .saturating_add(tools.len() as u64 * 8);
    let available = window
        .saturating_sub(reserve)
        .saturating_sub(window / 10)
        .saturating_sub(fixed);
    let pins = pins(snapshot, &contributions)?;
    let pinned = entry(snapshot, "pins", pins.clone());
    let required = cost(&pinned)?;
    if required > available {
        return Ok(Prepared::TooLarge {
            required,
            available,
        });
    }
    let history: Vec<_> = history
        .into_iter()
        .filter(|entry| entry.kind.as_str() != CHECKPOINT_ENTRY_KIND)
        .collect();
    let mut units = units(history);
    let mut covered = Vec::new();
    loop {
        let mut conversation = vec![pinned.clone()];
        if !covered.is_empty() {
            conversation.push(entry(snapshot,"earlier",serde_json::to_string(&json!({
                "notice":"Earlier ordinary messages and whole call/result groups are omitted from this bounded projection. This is an index, not a summary of their contents. Reread exact source before relying on omitted details.",
                "count":covered.len(),"first":covered.first().map(|e:&ConversationEntry|&e.id),"last":covered.last().map(|e|&e.id),"source_hash":hash(serde_json::to_vec(&covered)?),
                "read_again":"The host retains exact history. Reread project sources with available tools; ask the author when omitted conversational details are required."
            }))?));
        }
        conversation.extend(units.iter().flat_map(|unit| unit.entries.iter().cloned()));
        let input = cost(&conversation)?.saturating_add(image_tokens(config, &conversation));
        if input <= available {
            let checkpoint = Checkpoint {
                version: 1,
                chain: snapshot.chain.clone(),
                covered_count: covered.len(),
                first: covered.first().map(|e: &ConversationEntry| e.id.clone()),
                last: covered.last().map(|e| e.id.clone()),
                source_hash: hash(serde_json::to_vec(&covered)?),
                pins_hash: hash(pins),
                projection_hash: hash(serde_json::to_vec(&conversation)?),
                estimated_input_tokens: input + fixed,
                input_budget: available + fixed,
            };
            return Ok(Prepared::Ready {
                conversation,
                checkpoint,
            });
        }
        // Never split an assistant's calls from their results. An incomplete
        // provider replay group cannot be safely summarized away.
        if units.first().is_none_or(|unit| !unit.complete) {
            return Ok(Prepared::TooLarge {
                required: input,
                available,
            });
        }
        covered.extend(units.remove(0).entries);
    }
}

pub fn save_checkpoint(
    lib: &Library,
    snapshot: &ChainSnapshot,
    checkpoint: &Checkpoint,
) -> Result<()> {
    lib.local_write(|tx| {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM loro_doc WHERE doc_id=?1 AND kind='book')",
            [format!("book:{}", snapshot.book)],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(dr_store::StoreError::NotFound(snapshot.book.to_string()));
        }
        tx.set_state(
            "agent.context",
            &snapshot.chain,
            &serde_json::to_string(checkpoint).map_err(|_| dr_store::StoreError::Invalid {
                what: "context checkpoint",
                value: "invalid checkpoint".into(),
            })?,
            Some(snapshot.book.as_str()),
        )
    })?;
    Ok(())
}

pub fn validate_checkpoint(
    checkpoint: &Checkpoint,
    snapshot: &ChainSnapshot,
    history: &[ConversationEntry],
    contributions: &[Contribution],
) -> Result<bool> {
    if checkpoint.version != 1 || checkpoint.chain != snapshot.chain {
        return Ok(false);
    }
    let eligible: Vec<_> = history
        .iter()
        .filter(|row| row.kind.as_str() != CHECKPOINT_ENTRY_KIND)
        .take(checkpoint.covered_count)
        .cloned()
        .collect();
    Ok(eligible.len() == checkpoint.covered_count
        && hash(serde_json::to_vec(&eligible)?) == checkpoint.source_hash
        && hash(pins(snapshot, contributions)?) == checkpoint.pins_hash)
}

pub fn read_history(
    lib: &Library,
    snapshot: &ChainSnapshot,
    source: &str,
    offset: usize,
    limit: usize,
) -> Result<Value> {
    let history = crate::conversation(lib, &snapshot.conversation)?;
    let entry = history
        .iter()
        .find(|entry| entry.id == source)
        .ok_or_else(|| Error::Tool("context source is not in this conversation".into()))?;
    let raw = serde_json::to_string(entry)?;
    let total = raw.chars().count();
    let text: String = raw
        .chars()
        .skip(offset)
        .take(limit.clamp(1, 8192))
        .collect();
    let next = offset.saturating_add(text.chars().count());
    Ok(
        json!({"source":source,"source_hash":hash(&raw),"offset":offset,"total":total,"text":text,"next":(next<total).then_some(next)}),
    )
}
