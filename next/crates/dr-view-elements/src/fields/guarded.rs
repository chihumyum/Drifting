//! Apply only the edited parts of a two-field record to a guarded, complete read.
//! UI baselines stay unchanged while drafts are focused or a save is refused.
use dr_workspace::{
    Actor, Workspace, WritePreconditions, WsError,
    commands::v3::{
        content::PatchIn,
        module::{In, KvPutIn, ModuleRead},
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

pub(crate) fn patch(
    lib: &Workspace,
    target: In,
    id: String,
    base: Pair,
    edited: Pair,
    retry: bool,
) -> Result<Prepared, WsError> {
    // Observe BEFORE reading: a write between these steps or before commit must
    // fail CAS. Never authorize old UI values with a newly observed version.
    let observed = lib.observe(&format!("book:{}", target.book))?;
    let data = lib.run::<ModuleRead>(&Actor::User, target.clone())?.output;
    let current = data
        .patches
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| WsError::Conflict("patch was removed".into()))?;
    let pair = merge(
        &base,
        &edited,
        (current.title.clone().unwrap_or_default(), current.body),
        retry,
    )?;
    let input = PatchIn {
        target,
        id: Some(id),
        // Keep a missing title missing when that field was not edited.
        title: if edited.0 == base.0 {
            current.title
        } else {
            Some(pair.0.clone())
        },
        body: pair.1.clone(),
        pos: None,
    };
    Ok(Prepared {
        command: "module.put_patch",
        input: serde_json::to_value(input).map_err(|e| WsError::Internal(e.to_string()))?,
        guard: WritePreconditions::from_observations([observed]),
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
    let observed = lib.observe(&format!("book:{}", target.book))?;
    let data = lib.run::<ModuleRead>(&Actor::User, target.clone())?.output;
    let current = data.kv.iter().find(|p| p.id == id);
    let (pair, pos) = match (base, current) {
        (Some(base), Some(current)) => (
            merge(
                &base,
                &edited,
                (current.key.clone(), current.value.clone()),
                retry,
            )?,
            current.pos.clone(),
        ),
        (None, None) => {
            let pos = data
                .kv
                .iter()
                .filter_map(|r| r.pos.as_deref())
                .filter_map(|p| dr_model::pos::PosKey::parse(p).ok())
                .max()
                .map_or_else(dr_model::pos::PosKey::first, |p| p.after());
            (edited, Some(pos.to_string()))
        }
        _ => {
            return Err(WsError::Conflict(
                "key/value row changed while editing".into(),
            ));
        }
    };
    let input = KvPutIn {
        target,
        row: KvEntry {
            id,
            key: pair.0.clone(),
            value: pair.1.clone(),
            pos,
        },
    };
    Ok(Prepared {
        command: "module.put_kv",
        input: serde_json::to_value(input).map_err(|e| WsError::Internal(e.to_string()))?,
        guard: WritePreconditions::from_observations([observed]),
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
    let observed = lib.observe(&format!("book:{}", target.book))?;
    let data = lib.run::<ModuleRead>(&Actor::User, target.clone())?.output;
    let current = data
        .kv
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| WsError::Conflict("key/value row was removed".into()))?;
    if !retry && (current.key.clone(), current.value.clone()) != base {
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
        WritePreconditions::from_observations([observed]),
    )?;
    Ok(())
}
