//! Exact local transaction bytes for the SQLite/journal owner. A state-vector
//! diff also includes historical delete sets, so it is not an authored log.
use super::{DocumentSession, HISTORY_REPAIR, LOCAL};
use crate::native_command::{validate_event, CapturedAuthoredUpdate, CommandState};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(crate) struct CaptureState {
    pub(crate) ready: Vec<CapturedAuthoredUpdate>,
    pub(crate) group: Option<Vec<Vec<u8>>>,
    pub(crate) command: Option<CommandState>,
}

pub struct AuthoredUpdateLog(Arc<Mutex<CaptureState>>);

impl AuthoredUpdateLog {
    /// The persistence owner must retain these bytes until its transaction has
    /// committed. Retrying a failed write never repeats the native edit.
    pub fn drain(&self) -> Vec<Vec<u8>> {
        self.drain_records()
            .into_iter()
            .map(|record| record.update)
            .collect()
    }

    /// The caller must retain each complete record until its journal write commits.
    pub fn drain_records(&self) -> Vec<CapturedAuthoredUpdate> {
        std::mem::take(&mut self.0.lock().unwrap().ready)
    }

    pub fn is_empty(&self) -> bool {
        let state = self.0.lock().unwrap();
        state.ready.is_empty()
            && state.group.as_ref().is_none_or(Vec::is_empty)
            && state
                .command
                .as_ref()
                .is_none_or(|command| command.records.is_empty())
    }
}

impl DocumentSession {
    /// One log per document owner; remote replay, loading and selections never
    /// enter it. Undo and redo use the UndoManager's own transaction origin.
    pub fn capture_authored_updates(&mut self) -> Result<AuthoredUpdateLog, String> {
        if self.authored_capture.is_some() {
            return Err("An authored update log already owns this document".into());
        }
        let buffer = Arc::new(Mutex::new(CaptureState::default()));
        let output = buffer.clone();
        let local: yrs::Origin = LOCAL.into();
        let history = self.undo.as_origin();
        let history_repair: yrs::Origin = HISTORY_REPAIR.into();
        self.doc
            .observe_update_v1("native-durable-author", move |txn, event| {
                let mut state = output.lock().unwrap();
                // Count ALL update events during the public command, including
                // foreign-origin/observer events that do not enter authored storage.
                if let Some(command) = &mut state.command {
                    command.observed_events += 1;
                }
                let command_origin = state
                    .command
                    .as_ref()
                    .is_some_and(|command| txn.origin() == Some(&command.origin));
                let authored = command_origin
                    || txn.origin().is_some_and(|origin| {
                        origin == &local || origin == &history || origin == &history_repair
                    });
                if authored {
                    if let Some(command) = &mut state.command {
                        let deletion = validate_event(command, txn, &event.update);
                        command.records.push(CapturedAuthoredUpdate {
                            update: event.update.clone(),
                            deletion,
                        });
                    } else if let Some(group) = &mut state.group {
                        group.push(event.update.clone());
                    } else {
                        state
                            .ready
                            .push(CapturedAuthoredUpdate::raw(event.update.clone()));
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        self.authored_capture = Some(buffer.clone());
        Ok(AuthoredUpdateLog(buffer))
    }

    /// A structural history action may dematerialize, undo and materialize.
    /// Publish its exact event union as one update so peers never see the
    /// temporary empty presentation. This is not a full-state/vector diff.
    pub(crate) fn begin_authored_group(&self) -> Result<(), String> {
        if let Some(capture) = &self.authored_capture {
            let mut state = capture.lock().unwrap();
            if state.group.is_some() || state.command.is_some() {
                return Err("Nested authored action group".into());
            }
            state.group = Some(Vec::new());
        }
        Ok(())
    }

    pub(crate) fn finish_authored_group(&self) -> Result<(), String> {
        if let Some(capture) = &self.authored_capture {
            let mut state = capture.lock().unwrap();
            let mut group = state.group.take().ok_or("Missing authored action group")?;
            if group.len() == 1 {
                state
                    .ready
                    .push(CapturedAuthoredUpdate::raw(group.remove(0)));
            } else if !group.is_empty() {
                match yrs::merge_updates_v1(group.iter()) {
                    Ok(merged) => state.ready.push(CapturedAuthoredUpdate::raw(merged)),
                    Err(error) => {
                        state
                            .ready
                            .extend(group.into_iter().map(CapturedAuthoredUpdate::raw));
                        return Err(format!(
                            "Cannot group authored action; raw events retained: {error}"
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// Normalize accepted v1/v2 input to the published v1 storage contract,
    /// retaining missing-dependency structs without reconstructing a document.
    pub fn normalize_update(bytes: &[u8], encoding: u8) -> Result<Vec<u8>, String> {
        use yrs::updates::{decoder::Decode, encoder::Encode};
        let update = match encoding {
            1 => yrs::Update::decode_v1(bytes),
            2 => yrs::Update::decode_v2(bytes),
            _ => return Err("Unsupported update encoding".into()),
        }
        .map_err(|error| format!("Invalid CRDT update: {error}"))?;
        super::wire::validate_update(&update)?;
        let mut encoder = super::wire::CheckedEncoder::new();
        update.encode(&mut encoder);
        encoder.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Edit;

    #[test]
    fn capture_is_exact_local_history_and_never_remote_echo() {
        let mut source = DocumentSession::new();
        source
            .edit(Edit::AppendParagraph {
                id: "block".into(),
                text: "abc".into(),
            })
            .unwrap();
        let base = source.update(None, 1).unwrap();
        let mut live = DocumentSession::new();
        let log = live.capture_authored_updates().unwrap();
        assert!(live.capture_authored_updates().is_err());
        live.apply_remote(&base, 1).unwrap();
        assert!(log.is_empty());
        source
            .edit(Edit::Delete {
                block: "block".into(),
                offset: 0,
                length: 1,
            })
            .unwrap();
        live.apply_remote(&source.update(None, 1).unwrap(), 1)
            .unwrap();
        assert!(log.is_empty());
        live.edit(Edit::Insert {
            block: "block".into(),
            offset: 0,
            text: "local".into(),
        })
        .unwrap();
        let local = log.drain();
        assert_eq!(local.len(), 1);
        // A genuine insert event does not re-emit the earlier remote deletion.
        let mut replica = DocumentSession::new();
        replica.apply_remote(&base, 1).unwrap();
        replica.apply_remote(&local[0], 1).unwrap();
        assert!(replica.native_projection().unwrap().text.contains('a'));
        assert!(live.undo());
        let undo = log.drain();
        assert_eq!(undo.len(), 1);
        replica.apply_remote(&undo[0], 1).unwrap();
        assert!(!replica.native_projection().unwrap().text.contains("local"));
        assert!(live.redo());
        assert_eq!(log.drain().len(), 1);
        assert!(log.is_empty());
    }
}
