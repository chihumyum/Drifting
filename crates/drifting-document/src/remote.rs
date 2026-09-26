//! Pure remote planning lets the persistence owner commit derived repairs before
//! publishing the same prepared bytes into its live, history-bearing document.
use super::*;

pub struct PreparedRemoteUpdate {
    pub(crate) combined: Vec<u8>,
    pub(crate) repair: Option<Vec<u8>>,
    revision: u64,
    vector: StateVector,
}

impl PreparedRemoteUpdate {
    pub fn update(&self) -> &[u8] {
        &self.combined
    }
    pub fn repair_update(&self) -> Option<&[u8]> {
        self.repair.as_deref()
    }
}

impl DocumentSession {
    /// Independent staging state, with the same writer clock and anchor basis.
    /// It has no local undo stack, input queues or authored observer; its bytes
    /// may be published only by the owner that forked it after durable commit.
    pub fn fork_for_remote_replay(&self) -> Result<Self, String> {
        let mut staged = Self::from_options(Options::with_client_id(self.doc.client_id()));
        let snapshot = self.update(None, 1)?;
        staged
            .doc
            .transact_mut_with(REMOTE)
            .apply_update(Update::decode_v1(&snapshot).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        staged.comments = self.comments.clone();
        staged.comment_epoch = self.comment_epoch;
        staged.selections = self.selections.clone();
        staged.revision = self.revision;
        Ok(staged)
    }

    pub fn prepare_remote(
        &self,
        bytes: &[u8],
        encoding: u8,
    ) -> Result<PreparedRemoteUpdate, String> {
        let normalized = Self::normalize_update(bytes, encoding)?;
        let update = Update::decode_v1(&normalized).map_err(|e| e.to_string())?;
        // Reuse the raw-only loss result while this immutable basis is held.
        // Rechecking the repaired packet below is still necessary: it contains
        // different bytes and must not conceal any unmapped source text.
        let loss = retention::loss_spans(self, &update)?;
        let (combined, repair) = if loss.is_empty() {
            (normalized, None)
        } else {
            let translated = relocation_alias::plan(self, &update, &loss)?.ok_or_else(|| {
                format!(
                    "{}: unseen remote text would be deleted during integration",
                    retention::REMOTE_TEXT_RETENTION_REQUIRED
                )
            })?;
            let verified = Self::normalize_update(&translated.combined_update, 1)?;
            let combined = Update::decode_v1(&verified).map_err(|e| e.to_string())?;
            retention::validate(self, &combined)?;
            (verified, Some(translated.repair_update))
        };
        Ok(PreparedRemoteUpdate {
            combined,
            repair,
            revision: self.revision,
            vector: self.doc.transact().state_vector(),
        })
    }

    /// Prepare a dependency closure without integrating any member first.
    /// Validate each stored v1 envelope before merge: merging must never conceal
    /// an invalid member behind a later full-state or overlapping packet.
    pub fn prepare_remote_batch(&self, updates: &[&[u8]]) -> Result<PreparedRemoteUpdate, String> {
        if updates.is_empty() {
            return Err("A remote dependency closure requires stored updates".into());
        }
        let normalized = updates
            .iter()
            .enumerate()
            .map(|(index, bytes)| {
                Self::normalize_update(bytes, 1)
                    .map_err(|error| format!("Stored closure member {index} is invalid: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let merged = yrs::merge_updates_v1(normalized.iter().map(Vec::as_slice))
            .map_err(|error| format!("Remote dependency closure cannot merge: {error}"))?;
        self.prepare_remote(&merged, 1)
    }

    pub fn apply_prepared_remote(&mut self, prepared: &PreparedRemoteUpdate) -> Result<(), String> {
        // StateVector wire order follows a HashMap and can differ after a
        // staging clone. Compare clocks, not serialization order.
        if prepared.revision != self.revision
            || prepared.vector != self.doc.transact().state_vector()
        {
            return Err("Prepared remote update has a stale document basis".into());
        }
        let update = Update::decode_v1(&prepared.combined).map_err(|e| e.to_string())?;
        self.doc
            .transact_mut_with(REMOTE)
            .apply_update(update)
            .map_err(|e| e.to_string())?;
        self.revision += 1;
        self.refresh_comments(None);
        self.refresh_selections(None);
        Ok(())
    }

    pub fn apply_remote(&mut self, bytes: &[u8], encoding: u8) -> Result<(), String> {
        let prepared = self.prepare_remote(bytes, encoding)?;
        self.apply_prepared_remote(&prepared)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_remote_is_pure_and_cannot_apply_after_local_change() {
        let mut live = DocumentSession::new();
        live.edit(Edit::AppendParagraph {
            id: "p".into(),
            text: "潮汐".into(),
        })
        .unwrap();
        let mut peer = DocumentSession::new();
        peer.apply_remote(&live.update(None, 1).unwrap(), 1)
            .unwrap();
        let events = peer.capture_authored_updates().unwrap();
        peer.edit(Edit::Insert {
            block: "p".into(),
            offset: 0,
            text: "远".into(),
        })
        .unwrap();
        let update = events.drain().remove(0);
        let baseline = live.update(None, 1).unwrap();
        let prepared = live.prepare_remote(&update, 1).unwrap();
        assert_eq!(baseline, live.update(None, 1).unwrap());
        assert!(prepared.repair_update().is_none());
        let mut stage = live.fork_for_remote_replay().unwrap();
        stage.apply_prepared_remote(&prepared).unwrap();
        assert_eq!(stage.native_projection().unwrap().text, "远潮汐");
        assert_eq!(live.native_projection().unwrap().text, "潮汐");
        live.edit(Edit::Insert {
            block: "p".into(),
            offset: 0,
            text: "本".into(),
        })
        .unwrap();
        assert!(live
            .apply_prepared_remote(&prepared)
            .unwrap_err()
            .contains("stale"));
        assert_eq!(live.native_projection().unwrap().text, "本潮汐");
    }

    #[test]
    fn staging_replay_accepts_the_same_clocks_after_many_independent_writers() {
        let mut live = DocumentSession::with_test_client_id(19001).unwrap();
        live.edit(Edit::AppendParagraph {
            id: "p".into(),
            text: "潮汐".into(),
        })
        .unwrap();
        let base = live.update(None, 1).unwrap();
        for client in 19002..19034 {
            let mut peer = DocumentSession::with_test_client_id(client).unwrap();
            peer.apply_remote(&base, 1).unwrap();
            let log = peer.capture_authored_updates().unwrap();
            peer.edit(Edit::Insert {
                block: "p".into(),
                offset: 0,
                text: "远".into(),
            })
            .unwrap();
            let bytes = log.drain().remove(0);
            let mut staged = live.fork_for_remote_replay().unwrap();
            let prepared = staged.prepare_remote(&bytes, 1).unwrap();
            staged.apply_prepared_remote(&prepared).unwrap();
            live.apply_prepared_remote(&prepared).unwrap();
            assert_eq!(live.semantic().unwrap(), staged.semantic().unwrap());
        }
        assert_eq!(
            live.native_projection().unwrap().text.matches('远').count(),
            32
        );
    }
}
