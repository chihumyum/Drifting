//! Time pins (时间钉): marks on the narrative axis of the bottom timeline,
//! each with a label and optionally bound to an idea (the 0.1 client's
//! `timeline_marker`, `useTimelineMarkers`).
//!
//! - A pin without an idea needs a label; a pin bound to an idea may have
//!   none (the idea's title captions it).
//! - An idea is bound to at most one pin (the bind picker offers only
//!   unbound ideas), and only a live idea can be bound. An idea in the
//!   trash reads as unbound; purging it writes its title into the label of
//!   the pins it was bound to and unbinds them (`idea.purge`).
//! - Deleting a pin deletes it (there is no trash for pins); its undo
//!   recreates it with the same id.

use dr_doc::book::Collection;
use dr_model::book::TimePin;
use dr_model::id::{NodeId, TimePinId};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::cx::{EffectAction, Invocation};
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<TimePinList>()
        .add::<TimePinCreate>()
        .add::<TimePinUpdate>()
        .add::<TimePinDelete>();
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema)]
pub struct TimePinInfo {
    pub id: String,
    pub narrative_order: f64,
    pub label: String,
    /// The idea it is bound to, when that idea is live.
    pub idea: Option<String>,
    /// That idea's title.
    pub idea_title: Option<String>,
}

fn live_idea(slot: &BookSlot, id: &NodeId) -> Option<Node> {
    nodes(slot)
        .get(id)
        .filter(|n| n.is_drift() && !n.is_trashed())
        .cloned()
}

fn info(slot: &BookSlot, p: &TimePin) -> TimePinInfo {
    let idea = p.drift.as_ref().and_then(|d| live_idea(slot, d));
    TimePinInfo {
        id: p.id.to_string(),
        narrative_order: p.narrative_order,
        label: p.label.clone(),
        idea: idea.as_ref().map(|n| n.id.to_string()),
        idea_title: idea.map(|n| n.title),
    }
}

op! {
    TimePinList = "time_pin.list", Read, Shared,
    "List the book's time pins along the narrative axis, with the ideas bound to them.",
    fn(cx, input: BookIn) -> Vec<TimePinInfo> {
        let slot = cx.book(&input.book)?;
        Ok(time_pins(&slot).iter().map(|p| info(&slot, p)).collect())
    }
}

fn find(slot: &BookSlot, id: &str) -> Result<TimePin> {
    time_pins(slot)
        .iter()
        .find(|p| p.id.as_str() == id)
        .cloned()
        .ok_or_else(|| WsError::not_found("time pin", id))
}

/// The idea to bind: live, and not bound to another pin.
fn bindable(slot: &BookSlot, idea: &str, pin: Option<&TimePinId>) -> Result<NodeId> {
    let id: NodeId = pid("idea", idea)?;
    if live_idea(slot, &id).is_none() {
        return Err(WsError::not_found("idea", idea));
    }
    if let Some(other) = time_pins(slot)
        .iter()
        .find(|p| p.drift.as_ref() == Some(&id) && Some(&p.id) != pin)
    {
        return Err(WsError::Conflict(format!(
            "idea {idea} is bound to time pin {}",
            other.id
        )));
    }
    Ok(id)
}

fn order_ok(o: f64) -> Result<()> {
    if o.is_finite() {
        Ok(())
    } else {
        Err(WsError::invalid("narrative order must be finite"))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TimePinCreateIn {
    pub book: String,
    pub narrative_order: f64,
    /// Trimmed; may be empty only with `idea`.
    #[serde(default)]
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idea: Option<String>,
    /// An exact id (undo uses it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

op! {
    TimePinCreate = "time_pin.create", Write, Book,
    "Put a time pin on the narrative axis, with a label or bound to an idea.",
    fn(cx, input: TimePinCreateIn) -> Named {
        let slot = cx.book(&input.book)?;
        order_ok(input.narrative_order)?;
        let label = input.label.trim().to_string();
        let idea = input.idea.as_deref().map(|i| bindable(&slot, i, None)).transpose()?;
        if label.is_empty() && idea.is_none() {
            return Err(WsError::invalid("a time pin needs a label or an idea"));
        }
        let id: TimePinId = match &input.id {
            Some(i) => {
                let id: TimePinId = pid("time pin", i)?;
                if time_pins(&slot).iter().any(|p| p.id == id) {
                    return Err(WsError::Conflict(format!("time pin {i} exists")));
                }
                id
            }
            None => TimePinId::new_v7(),
        };
        let (i2, l2, d2, o) = (id.clone(), label.clone(), idea.clone(), input.narrative_order);
        cx.write_book(&slot, move |txn| {
            txn.time_pin(&i2)?.narrative_order(o)?.label(&l2)?.drift(d2.as_ref())?;
            Ok(())
        })?;
        cx.effect(EffectAction::Created, "time_pin", id.as_str(), Some(&label));
        cx.undo_with(Invocation::new("time_pin.delete", EntityIn { book: input.book.clone(), id: id.to_string() }));
        Ok(Named { id: id.to_string(), name: label })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TimePinUpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrative_order: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// An idea to bind; `null` unbinds.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub idea: Option<Option<String>>,
}

op! {
    TimePinUpdate = "time_pin.update", Write, Book,
    "Move a time pin, change its label, or bind it to an idea or unbind it.",
    fn(cx, input: TimePinUpdateIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = find(&slot, &input.id)?;
        if let Some(o) = input.narrative_order { order_ok(o)?; }
        let idea: Option<Option<NodeId>> = match &input.idea {
            Some(Some(i)) => Some(Some(bindable(&slot, i, Some(&old.id))?)),
            Some(None) => Some(None),
            None => None,
        };
        let label = input.label.as_ref().map(|l| l.trim().to_string());
        let will_label = label.clone().unwrap_or_else(|| old.label.clone());
        let will_idea = match &idea {
            Some(i) => i.clone(),
            None => old.drift.clone().filter(|d| live_idea(&slot, d).is_some()),
        };
        if will_label.is_empty() && will_idea.is_none() {
            return Err(WsError::invalid("a time pin needs a label or an idea"));
        }
        let (id, o, l, d) = (old.id.clone(), input.narrative_order, label.clone(), idea.clone());
        cx.write_book(&slot, move |txn| {
            let w = txn.time_pin(&id)?;
            if let Some(o) = o { w.narrative_order(o)?; }
            if let Some(l) = &l { w.label(l)?; }
            if let Some(d) = &d { w.drift(d.as_ref())?; }
            Ok(())
        })?;
        cx.effect(EffectAction::Updated, "time_pin", &input.id, Some(&will_label));
        cx.undo_with(Invocation::new("time_pin.update", TimePinUpdateIn {
            book: input.book.clone(),
            id: input.id.clone(),
            narrative_order: input.narrative_order.map(|_| old.narrative_order),
            label: label.as_ref().map(|_| old.label.clone()),
            idea: idea.as_ref().map(|_| old.drift.as_ref().map(|d| d.to_string())),
        }));
        Ok(Done { id: input.id })
    }
}

op! {
    TimePinDelete = "time_pin.delete", Write, Book,
    "Delete a time pin.",
    fn(cx, input: EntityIn) -> Done {
        let slot = cx.book(&input.book)?;
        let old = find(&slot, &input.id)?;
        let id = old.id.clone();
        cx.write_book(&slot, move |txn| { txn.purge(Collection::TimePins, id.as_str())?; Ok(()) })?;
        cx.effect(EffectAction::Purged, "time_pin", &input.id, Some(&old.label));
        // The idea it was bound to may be gone by the time of the undo: the
        // label carries its title then, as a purge would.
        let idea = old.drift.as_ref().and_then(|d| live_idea(&slot, d));
        let label = if old.label.trim().is_empty() {
            // The idea's title even when it is in the trash; 0.1's fallback
            // when there is none.
            old.drift.as_ref().and_then(|d| nodes(&slot).get(d).map(|n| n.title.clone()))
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| "Marker".to_string())
        } else {
            old.label.clone()
        };
        cx.undo_with(Invocation::new("time_pin.create", TimePinCreateIn {
            book: input.book.clone(),
            narrative_order: old.narrative_order,
            label,
            idea: idea.map(|n| n.id.to_string()),
            id: Some(input.id.clone()),
        }));
        Ok(Done { id: input.id })
    }
}
