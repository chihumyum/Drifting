//! Ephemeral input branches preserve the CRDT basis of queued native input.
//! They contain committed text only; marked text remains inside TextKit.
use super::*;
use std::collections::HashMap;

pub(crate) struct InputBranch {
    document: DocumentSession,
    sequence: u64,
    composition: bool,
}
pub(crate) type InputSet = HashMap<String, InputBranch>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeInputEdit {
    pub key: String,
    pub sequence: u64,
    pub range: NativeRange,
    pub text: String,
    pub selection: Option<NativeDraftSelection>,
}

impl DocumentSession {
    /// `source` names the optimistic branch seen by a composing view. None
    /// captures the merged owner. Returning its projection in the same call
    /// lets the host adopt a new basis without an asynchronous read/write race.
    pub fn fork_input(
        &mut self,
        key: String,
        source: Option<&str>,
    ) -> Result<NativeProjection, String> {
        if key.is_empty()
            || key.len() > 128
            || self.inputs.contains_key(&key)
            || self.inputs.len() >= 128
        {
            return Err("Invalid, duplicate or excessive input branch".into());
        }
        let composition = source.is_some();
        let source = match source {
            Some(key) => &self.inputs.get(key).ok_or("Unknown input basis")?.document,
            None => self,
        };
        let mut document = DocumentSession::new();
        document.apply_remote(&source.update(None, 1)?, 1)?;
        document.comments = source.comments.clone();
        document.selections = source.selections.clone();
        let projection = source.native_projection()?;
        self.inputs.insert(
            key,
            InputBranch {
                document,
                sequence: 0,
                composition,
            },
        );
        Ok(projection)
    }

    pub fn drop_input(&mut self, key: &str) {
        self.inputs.remove(key);
    }
    pub fn active_inputs(&self) -> usize {
        self.inputs.len()
    }
    pub fn active_input_compositions(&self) -> usize {
        self.inputs
            .values()
            .filter(|input| input.composition)
            .count()
    }

    /// The sequence is consumed exactly once, even if the host's subsequent
    /// persistence fails. A retry must save, never replay a successful edit.
    pub fn replace_input(&mut self, edit: NativeInputEdit) -> Result<NativeProjection, String> {
        let command = self
            .authored_capture
            .as_ref()
            .map(crate::native_command::NativeCommandScope::begin)
            .transpose()?;
        let mut branch = self.inputs.remove(&edit.key).ok_or("Unknown input basis")?;
        let result = (|| {
            if edit.sequence != branch.sequence {
                return Err("Stale input sequence".into());
            }
            branch.document.begin_draft(NativeDraftStart {
                key: "input".into(),
                revision: branch.document.revision,
                range: edit.range,
            })?;
            let draft = branch.document.take_draft("input").unwrap();
            let author = self.commit_captured_draft(
                draft,
                edit.text,
                edit.selection,
                Some(branch.document.doc.client_id()),
                command.as_ref(),
            )?;
            branch.document = author;
            branch.sequence += 1;
            branch.composition = false;
            branch.document.native_projection()
        })();
        self.inputs.insert(edit.key, branch);
        if result.is_ok() {
            if let Some(command) = command {
                command.complete();
            }
        }
        result
    }
}
