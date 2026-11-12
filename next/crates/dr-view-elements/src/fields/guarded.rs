//! Apply only the edited parts of a two-field record to a guarded, complete read.
//! UI baselines stay unchanged while drafts are focused or a save is refused.
use dr_workspace::{
    Actor, RecordKey, RecordObservation, Workspace, WritePreconditions, WsError,
    commands::v3::{
        content::PatchEditIn,
        module::{In, KvEditIn, KvPutIn},
        types::KvEntry,
    },
};

pub(crate) type Pair = (String, String);

#[cfg(test)]
pub(crate) mod tests;

/// Typing during a save was based on the submitted text, not on an external
/// value merged by the worker. Keep that baseline so the next save can conflict.
pub(crate) fn acknowledged_base(sent: &Pair, saved: Pair, current: &Pair) -> Pair {
    (
        if current.0 == sent.0 {
            saved.0
        } else {
            sent.0.clone()
        },
        if current.1 == sent.1 {
            saved.1
        } else {
            sent.1.clone()
        },
    )
}

fn merge(base: &Pair, edited: &Pair, current: Pair, retry: bool) -> Result<Pair, WsError> {
    fn field(base: &str, edited: &str, current: String, retry: bool) -> Result<String, WsError> {
        if edited == base {
            return Ok(current);
        }
        if !retry && current != base && current != edited {
            return Err(WsError::Conflict("field changed while editing".into()));
        }
        Ok(edited.to_owned())
    }
    Ok((
        field(&base.0, &edited.0, current.0, retry)?,
        field(&base.1, &edited.1, current.1, retry)?,
    ))
}

/// An edit prepared from one observation of the record it changes. Only the
/// edited fields are written, and the write is held to the record as it was
/// observed: a change to it after that refuses the write, while any other
/// change to the book does not.
pub(crate) struct Prepared {
    command: &'static str,
    input: serde_json::Value,
    guard: WritePreconditions,
    pub pair: Pair,
}
impl Prepared {
    pub fn commit(self, lib: &Workspace) -> Result<Pair, WsError> {
        lib.call_guarded(&Actor::User, self.command, self.input, self.guard)?;
        Ok(self.pair)
    }
}

fn observe(lib: &Workspace, book: &str, key: RecordKey) -> Result<RecordObservation, WsError> {
    Ok(lib
        .observe_records(&format!("book:{book}"), &[key])?
        .remove(0))
}

fn internal(e: serde_json::Error) -> WsError {
    WsError::Internal(e.to_string())
}

fn text(value: &serde_json::Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

/// The stored patch, if it is still this module's.
fn stored_patch(lib: &Workspace, target: &In, id: &str) -> Result<RecordObservation, WsError> {
    let seen = observe(lib, &target.book, RecordKey::patch(id))?;
    if seen.value["entry"] != target.entry.as_str()
        || seen.value["module"] != target.module.as_str()
    {
        return Err(WsError::Conflict("patch was removed".into()));
    }
    Ok(seen)
}

fn kv_rows(target: &In) -> RecordKey {
    RecordKey::entry(&target.entry).at([format!("kv:{}", target.module)])
}

pub(crate) fn patch(
    lib: &Workspace,
    target: In,
    id: String,
    base: Pair,
    edited: Pair,
    retry: bool,
) -> Result<Prepared, WsError> {
    // Observe once: the value is what the draft is merged with, the digest is
    // what the write is held to. Never authorize old UI values with a record
    // observed after they were shown.
    let seen = stored_patch(lib, &target, &id)?;
    let pair = merge(
        &base,
        &edited,
        (text(&seen.value["title"]), text(&seen.value["body"])),
        retry,
    )?;
    let input = PatchEditIn {
        target,
        id,
        // A field that was not edited is not written: a missing title stays
        // missing, and the other field keeps whatever is stored.
        title: (edited.0 != base.0).then(|| Some(pair.0.clone())),
        body: (edited.1 != base.1).then(|| pair.1.clone()),
    };
    Ok(Prepared {
        command: "module.edit_patch",
        input: serde_json::to_value(input).map_err(internal)?,
        guard: WritePreconditions::from_records([seen]),
        pair,
    })
}

pub(crate) fn kv(
    lib: &Workspace,
    target: In,
    id: String,
    base: Option<Pair>,
    edited: Pair,
    retry: bool,
) -> Result<Prepared, WsError> {
    let rows = kv_rows(&target);
    let mut seen = lib.observe_records(
        &format!("book:{}", target.book),
        &[rows.clone().at([id.as_str()]), rows],
    )?;
    let (row, rows) = (seen.remove(0), seen.remove(0));
    let (command, input, pair) = match (base, row.value.is_null()) {
        (Some(base), false) => {
            let pair = merge(
                &base,
                &edited,
                (text(&row.value["key"]), text(&row.value["value"])),
                retry,
            )?;
            let input = KvEditIn {
                target,
                row: id,
                key: (edited.0 != base.0).then(|| pair.0.clone()),
                value: (edited.1 != base.1).then(|| pair.1.clone()),
            };
            (
                "module.edit_kv",
                serde_json::to_value(input).map_err(internal)?,
                pair,
            )
        }
        (None, true) => {
            let pos = rows
                .value
                .as_object()
                .into_iter()
                .flat_map(|rows| rows.values())
                .filter_map(|r| r["pos"].as_str())
                .filter_map(|p| dr_model::pos::PosKey::parse(p).ok())
                .max()
                .map_or_else(dr_model::pos::PosKey::first, |p| p.after());
            let input = KvPutIn {
                target,
                row: KvEntry {
                    id,
                    key: edited.0.clone(),
                    value: edited.1.clone(),
                    pos: Some(pos.to_string()),
                },
            };
            (
                "module.put_kv",
                serde_json::to_value(input).map_err(internal)?,
                edited,
            )
        }
        _ => {
            return Err(WsError::Conflict(
                "key/value row changed while editing".into(),
            ));
        }
    };
    Ok(Prepared {
        command,
        input,
        // The row as it was observed, or its absence for a new one.
        guard: WritePreconditions::from_records([row]),
        pair,
    })
}

pub(super) fn remove_kv(
    lib: &Workspace,
    target: In,
    id: String,
    base: Pair,
    retry: bool,
) -> Result<(), WsError> {
    let row = observe(lib, &target.book, kv_rows(&target).at([id.as_str()]))?;
    if row.value.is_null() {
        return Err(WsError::Conflict("key/value row was removed".into()));
    }
    if !retry && (text(&row.value["key"]), text(&row.value["value"])) != base {
        return Err(WsError::Conflict(
            "key/value row changed before removal".into(),
        ));
    }
    lib.call_guarded(
        &Actor::User,
        "module.remove_kv",
        serde_json::json!({
            "book": target.book, "entry": target.entry, "module": target.module, "row": id
        }),
        WritePreconditions::from_records([row]),
    )?;
    Ok(())
}

pub(crate) fn remove_patch(
    lib: &Workspace,
    target: In,
    id: String,
    base: Pair,
    retry: bool,
) -> Result<(), WsError> {
    let seen = stored_patch(lib, &target, &id)?;
    if !retry && (text(&seen.value["title"]), text(&seen.value["body"])) != base {
        return Err(WsError::Conflict("patch changed before removal".into()));
    }
    lib.call_guarded(
        &Actor::User,
        "module.remove_patch",
        serde_json::json!({
            "book": target.book, "entry":target.entry, "module":target.module, "id":id
        }),
        WritePreconditions::from_records([seen]),
    )?;
    Ok(())
}
