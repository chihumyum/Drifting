//! Completeness of the timeline projection, at the read's guarded book version.
//! This records evidence only; it neither reveals hidden data nor merges it into
//! an Agent write. F3 remains the only writer and decides valid local operations.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::{Error, Result};

pub(super) struct Coverage {
    incomplete: HashSet<String>,
    incomplete_pins: HashSet<(String, String)>,
}

impl Coverage {
    pub(super) fn from_read(book: &Value, output: &Value) -> Result<Self> {
        let empty = serde_json::Map::new();
        let raw = match &book["timeline_views"] {
            Value::Null => &empty,
            Value::Object(views) => views,
            _ => {
                return Err(Error::Invalid(
                    "invalid timeline collection in observation".into(),
                ));
            }
        };
        let rows = output
            .as_array()
            .ok_or_else(|| Error::Invalid("invalid timeline list output".into()))?;
        let mut shown = HashMap::new();
        for row in rows {
            let id = row["id"]
                .as_str()
                .ok_or_else(|| Error::Invalid("timeline list row needs id".into()))?;
            if !raw.contains_key(id) || shown.insert(id, row).is_some() {
                return Err(Error::Invalid("inconsistent timeline list output".into()));
            }
        }
        let incomplete = raw
            .iter()
            .filter(|(id, stored)| {
                !shown.get(id.as_str()).is_some_and(|row| {
                    [("lanes", "entry"), ("placements", "entry"), ("pins", "id")]
                        .iter()
                        .all(|(field, key)| complete_collection(&stored[field], &row[field], key))
                })
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut incomplete_pins = HashSet::new();
        for (view_id, stored) in raw {
            for (pin_id, pin) in stored["pins"].as_object().into_iter().flatten() {
                let visible = shown.get(view_id.as_str()).and_then(|view| {
                    view["pins"]
                        .as_array()?
                        .iter()
                        .find(|row| row["id"] == *pin_id)
                });
                if !visible.is_some_and(|row| complete_record(pin, row, "id")) {
                    incomplete_pins.insert((view_id.clone(), pin_id.clone()));
                }
            }
        }
        Ok(Self {
            incomplete,
            incomplete_pins,
        })
    }

    pub(super) fn require_complete(&self, id: &str) -> Result<()> {
        if self.incomplete.contains(id) {
            return Err(Error::ReadRequired(format!(
                "timeline view {id} contains hidden lanes, placements or pin data; whole-view replacement is unavailable; use supported item commands"
            )));
        }
        // An absent id is new in this observed collection. The same book CAS
        // also prevents overwriting a view created after this observation.
        Ok(())
    }

    /// The current F3 membership-removal cascade scans raw views and can
    /// remove placements whose remaining lane is hidden. A book CAS does not
    /// prove those affected records were shown. Until F3 preserves them, fail
    /// closed if any view in this exact collection read is incomplete.
    pub(super) fn require_membership_removal(&self) -> Result<()> {
        if !self.incomplete.is_empty() {
            return Err(Error::ReadRequired(
                "membership removal is unavailable while timeline views contain hidden lanes, placements or pin data".into(),
            ));
        }
        Ok(())
    }

    pub(super) fn require_pin(&self, view: &str, pin: &str) -> Result<()> {
        if self.incomplete_pins.contains(&(view.into(), pin.into())) {
            return Err(Error::ReadRequired(format!(
                "timeline view {view}, pin {pin} contains hidden pin data; replacement or removal is unavailable"
            )));
        }
        Ok(())
    }
}

fn complete_collection(raw: &Value, shown: &Value, key: &str) -> bool {
    let Some(rows) = shown.as_array() else {
        return false;
    };
    let Some(stored) = raw.as_object() else {
        return raw.is_null() && rows.is_empty();
    };
    if rows.len() != stored.len() {
        return false;
    }
    let mut seen = HashSet::new();
    rows.iter().all(|row| {
        let Some(id) = row[key].as_str() else {
            return false;
        };
        let Some(original) = stored.get(id) else {
            return false;
        };
        seen.insert(id) && complete_record(original, row, key)
    })
}

fn complete_record(raw: &Value, shown: &Value, key: &str) -> bool {
    let Some(original) = raw.as_object() else {
        return false;
    };
    shown.as_object().is_some_and(|fields| {
        fields.iter().all(|(field, value)| {
            field == key || original.get(field).unwrap_or(&Value::Null) == value
        })
    })
}
