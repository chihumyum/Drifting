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
        "other_steps":"The host retains all other steps and accepted evidence. Do not infer completion from a summary or call unavailable plan tools.",
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

fn cost(value: &impl Serialize) -> Result<u64> {
    // One unit per UTF-8 byte is a conservative, provider-neutral estimate;
    // it is explicitly a planning bound, never a generation token ceiling.
    Ok(serde_json::to_vec(value)?.len() as u64)
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
    let window = config
        .capabilities
        .as_ref()
        .and_then(|c| c.context_window)
        .unwrap_or(32_768);
    let reserve = config
        .max_output_tokens
        .or_else(|| {
            config
                .capabilities
                .as_ref()
                .and_then(|c| c.max_output_tokens)
        })
        .map(u64::from)
        .unwrap_or(8_192)
        .max(4_096);
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
        let input = cost(&conversation)?;
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
