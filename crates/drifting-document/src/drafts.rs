//! Ephemeral authored edits against the CRDT state visible at composition start.
//! Marked text is never inserted into the live document before commit.
use super::*;
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeDraftStart {
    pub key: String,
    pub revision: u64,
    pub range: NativeRange,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeDraftSelection {
    pub view_id: String,
    pub epoch: u64,
    /// In the native draft after replacement, before concurrent changes appear.
    pub range: NativeRange,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeDraftCommit {
    pub key: String,
    pub text: String,
    pub selection: Option<NativeDraftSelection>,
}

#[derive(Clone)]
pub(crate) struct Draft {
    bytes: Vec<u8>,
    snapshot: yrs::Snapshot,
    range: NativeRange,
    block: String,
    cross_block: bool,
    code_block: bool,
}
pub(crate) type DraftSet = HashMap<String, Draft>;

impl DocumentSession {
    pub fn begin_draft(&mut self, start: NativeDraftStart) -> Result<(), String> {
        if start.key.is_empty() || start.key.len() > 128 || self.drafts.contains_key(&start.key) {
            return Err("Draft identity is missing, too long or already active".into());
        }
        if start.revision != self.revision {
            return Err("Draft projection is stale".into());
        }
        let view = self.native_projection()?;
        validate_range(&view.text, start.range.location, start.range.length)?;
        let block_at = |at| {
            view.blocks
                .iter()
                .position(|b| b.range.location <= at && at <= b.range.location + b.range.length)
        };
        let first = block_at(start.range.location).ok_or("Draft start is outside text")?;
        let last = block_at(start.range.location + start.range.length)
            .ok_or("Draft end is outside text")?;
        if view.blocks[first..=last].iter().any(|b| !b.editable) {
            return Err("Draft contains unsupported text".into());
        }
        let block = view.blocks[first]
            .id
            .clone()
            .ok_or("Missing draft block identity")?;
        let draft = Draft {
            bytes: self.update(None, 1)?,
            snapshot: self.doc.transact().snapshot(),
            range: start.range,
            block,
            cross_block: first != last,
            code_block: view.blocks[first].kind == "codeBlock",
        };
        self.drafts.insert(start.key, draft);
        Ok(())
    }

    pub(crate) fn take_draft(&mut self, key: &str) -> Option<Draft> {
        self.drafts.remove(key)
    }

    pub fn cancel_draft(&mut self, key: &str) {
        self.drafts.remove(key);
    }
    pub fn active_drafts(&self) -> usize {
        self.drafts.len()
    }

    pub fn commit_draft(&mut self, commit: NativeDraftCommit) -> Result<(), String> {
        let draft = self
            .drafts
            .get(&commit.key)
            .cloned()
            .ok_or("Unknown or already committed draft")?;
        let command = self
            .authored_capture
            .as_ref()
            .map(crate::native_command::NativeCommandScope::begin)
            .transpose()?;
        self.commit_captured_draft(draft, commit.text, commit.selection, None, command.as_ref())?;
        self.drafts.remove(&commit.key);
        if let Some(command) = command {
            command.complete();
        }
        Ok(())
    }

    /// An input branch can keep authoring against the state still visible in a
    /// native control while the owner integrates concurrent updates.
    pub(crate) fn commit_captured_draft(
        &mut self,
        draft: Draft,
        text: String,
        selection: Option<NativeDraftSelection>,
        client: Option<yrs::ClientID>,
        command: Option<&crate::native_command::NativeCommandScope>,
    ) -> Result<DocumentSession, String> {
        let current = self.doc.transact().snapshot() == draft.snapshot;
        let structural =
            draft.cross_block || (!draft.code_block && text.contains(['\n', '\r', '\u{2029}']));
        self.editable_block(&self.doc.transact(), &draft.block)
            .map_err(|_| "Draft context was removed or became ambiguous; draft retained")?;

        // Build and validate in an isolated author identity. Replacing only the
        // items present in this snapshot cannot delete a concurrent insertion.
        // A rejected commit never mutates the retained snapshot or live prose.
        let mut author = client
            .map(|id| DocumentSession::from_options(Options::with_client_id(id)))
            .unwrap_or_default();
        author.apply_remote(&draft.bytes, 1)?;
        let concurrent = if !current && structural {
            Some(self.disjoint_structural_range(&author, &draft.range, &text)?)
        } else {
            None
        };
        let deletion =
            command.and_then(|command| command.select_draft(&author, &draft.range, &text));
        let vector = author.state_vector();
        let author_revision = author.revision;
        let inserted_end = draft.range.location + text.encode_utf16().count() as u32;
        let (mut mapping, mut lineage) = author.replace_native_prose(NativeReplacement {
            revision: author_revision,
            range: draft.range.clone(),
            text: text.clone(),
        })?;
        if let Some(selection) = &selection {
            if self
                .selections
                .get(&selection.view_id)
                .is_some_and(|old| old.epoch > selection.epoch)
            {
                return Err("Draft selection epoch is stale; draft retained".into());
            }
            author.set_selection(NativeSelectionRequest {
                view_id: selection.view_id.clone(),
                epoch: selection.epoch,
                revision: author.revision,
                range: selection.range.clone(),
            })?;
            if selection.range.length == 0 && selection.range.location == inserted_end {
                // A committed composition caret belongs immediately after its
                // authored text (or at its deletion boundary), not after remote
                // text inserted before the next pre-existing character.
                let position = author.selections[&selection.view_id].start.clone();
                let bytes = author.anchor(&position.block, position.offset, true)?;
                let tracked = author.selections.get_mut(&selection.view_id).unwrap();
                tracked.start.bytes = bytes;
                tracked.end = tracked.start.clone();
            }
        }
        let update =
            Update::decode_v1(&author.update(Some(&vector), 1)?).map_err(|e| e.to_string())?;
        let comments = self.comments.clone();
        let selections = self.selections.clone();
        let undo_count = self.undo.undo_stack().len();
        if author.revision != author_revision {
            {
                let capture = command.filter(|_| deletion.is_some());
                let origin =
                    capture.map_or_else(|| yrs::Origin::from(LOCAL), |command| command.origin());
                let _tracked = capture.map(|_| {
                    crate::native_command::TrackedCommandOrigin::new(&mut self.undo, origin.clone())
                });
                let mut txn = self.doc.transact_mut_with(origin);
                if let (Some(command), Some(deletion)) = (capture, deletion.as_ref()) {
                    command.prepare_draft(&mut txn, deletion);
                }
                txn.apply_update(update).map_err(|e| e.to_string())?;
            }
            self.undo.reset();
            self.revision += 1;
        }
        if let Some(concurrent) = concurrent {
            // Remote prefix input can shift offsets inside an affected block.
            // Both the operation map and identity tapes must use the live basis;
            // the author itself remains unchanged for already queued input.
            let before = concurrent.before;
            let after = self.native_projection()?;
            let affected_start = before.blocks[concurrent.first].range.location;
            let last = &before.blocks[concurrent.last].range;
            let affected_end = last.location + last.length - concurrent.range.length
                + text.encode_utf16().count() as u32;
            mapping = NativeEditMap::new(
                &before,
                &after,
                &NativeReplacement {
                    revision: before.revision,
                    range: concurrent.range,
                    text,
                },
            );
            if let Some(lineage) = &mut lineage {
                let blocks: Vec<_> = after
                    .blocks
                    .into_iter()
                    .filter(|block| {
                        block.range.location >= affected_start
                            && block.range.location <= affected_end
                    })
                    .collect();
                lineage.before = concurrent.lineage_before;
                lineage.after = self.capture_lineage(&blocks)?;
                lineage.forward = mapping.clone();
            }
        }
        let mapped = current || structural;
        self.finish_local_edit(
            comments,
            selections,
            undo_count,
            mapped.then_some(&mapping),
            if mapped { lineage } else { None },
        );
        // These positions reference authored item IDs and resolve directly in
        // the merged document, even when its UTF-16 offsets differ from the UI.
        if let Some(selection) = selection {
            if let Some(position) = author.selections.remove(&selection.view_id) {
                self.selections.insert(selection.view_id, position);
                self.refresh_selections(None);
            }
        }
        Ok(author)
    }
}
