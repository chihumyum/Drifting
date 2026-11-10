//! Local installation for the new atomic author-text path. Importing its
//! staged updates would transform earlier author Undo items as remote edits.
//! Instead persist the exact operations produced by a deterministic text
//! replay, then repeat that replay on the still-reserved live document.
use super::*;
use loro::{ContainerType, JsonOpContent, TextDelta};

pub(super) fn copy(lib: &Inner, source: &LoroDoc) -> Result<LoroDoc> {
    let doc = lib.new_doc();
    doc.import(&source.export(ExportMode::Snapshot)?)?;
    doc.set_peer_id(source.peer_id())?;
    Ok(doc)
}

pub(super) struct LocalText {
    deltas: Vec<(ContainerID, Vec<TextDelta>)>,
    options: CommitOptions,
    before: VersionVector,
    after: VersionVector,
    frontiers: Frontiers,
}

impl LocalText {
    pub(super) fn prepare(
        lib: &Inner,
        base: &LoroDoc,
        staged: &LoroDoc,
    ) -> Result<(LoroDoc, Self)> {
        let unsupported = || StoreError::invalid("atomic author text", "cannot replay faithfully");
        let before = base.oplog_vv();
        if staged.peer_id() != base.peer_id() || staged.state_vv() != staged.oplog_vv() {
            return Err(unsupported());
        }
        // Inspect typed ops, never a JSON serialization of LoroValue (which
        // loses Binary). Hidden/non-text mutations cannot slip past a visible
        // state diff. No container is created, reparented or remapped here.
        let ops =
            staged.export_json_updates_without_peer_compression(&before, &staged.oplog_vv())?;
        let roots = base.get_value();
        let existing = |id: &ContainerID| match id {
            ContainerID::Root { name, .. } => roots
                .as_map()
                .is_some_and(|m| m.get(name.as_str()) == Some(&LoroValue::Container(id.clone()))),
            ContainerID::Normal { .. } => base.has_container(id),
        };
        if ops.changes.iter().any(|change| {
            change.id.peer != base.peer_id()
                || change.ops.iter().any(|op| {
                    op.container.container_type() != ContainerType::Text
                        || !existing(&op.container)
                        || !matches!(op.content, JsonOpContent::Text(_))
                })
        }) {
            return Err(unsupported());
        }
        let diff = staged.diff(&base.state_frontiers(), &staged.state_frontiers())?;
        let mut deltas = Vec::new();
        for (id, diff) in diff.iter() {
            let Diff::Text(delta) = diff else {
                return Err(unsupported());
            };
            if !existing(id) {
                return Err(unsupported());
            }
            deltas.push((id.clone(), delta.clone()));
        }
        if deltas.is_empty() {
            return Err(unsupported());
        }
        deltas.sort_by_key(|(id, _)| id.to_string());
        let mut plan = Self {
            deltas,
            options: CommitOptions::new()
                .origin(&Origin::User.to_string())
                .timestamp(now_ms() / 1000),
            before,
            after: VersionVector::default(),
            frontiers: Frontiers::default(),
        };
        let replay = copy(lib, base)?;
        plan.apply(&replay)?;
        // Plain deep values do not include text marks. Compare both directly
        // as typed Loro values; retain Binary and exact nested raw attributes.
        if replay.get_deep_value_with_id() != staged.get_deep_value_with_id()
            || plan.deltas.iter().any(|(id, _)| {
                !same_delta(
                    &replay.get_text(id.clone()).to_delta(),
                    &staged.get_text(id.clone()).to_delta(),
                )
            })
        {
            return Err(unsupported());
        }
        plan.after = replay.oplog_vv();
        plan.frontiers = replay.oplog_frontiers();
        let bytes = replay.export(ExportMode::updates(&plan.before))?;
        let witness = copy(lib, base)?;
        plan.apply(&witness)?;
        if witness.oplog_vv() != plan.after
            || witness.oplog_frontiers() != plan.frontiers
            || witness.export(ExportMode::updates(&plan.before))? != bytes
        {
            return Err(unsupported());
        }
        Ok((replay, plan))
    }

    fn apply(&self, doc: &LoroDoc) -> Result<()> {
        doc.set_next_commit_options(self.options.clone());
        for (id, delta) in &self.deltas {
            doc.get_text(id.clone()).apply_delta(delta)?;
        }
        doc.commit_with(self.options.clone());
        Ok(())
    }

    pub(super) fn install(self, doc: &LoroDoc, bytes: &[u8]) {
        assert_eq!(doc.oplog_vv(), self.before, "reserved author text base");
        self.apply(doc)
            .expect("text replay validated twice on the identical reserved base");
        assert_eq!(doc.oplog_vv(), self.after, "author replay operation ids");
        assert_eq!(doc.oplog_frontiers(), self.frontiers, "author replay head");
        assert_eq!(
            doc.export(ExportMode::updates(&self.before))
                .expect("validated author replay export"),
            bytes,
            "durable and live author operations must be identical"
        );
    }
}

fn same_delta(a: &[TextDelta], b: &[TextDelta]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(a, b)| match (a, b) {
            (
                TextDelta::Insert {
                    insert: a,
                    attributes: x,
                },
                TextDelta::Insert {
                    insert: b,
                    attributes: y,
                },
            ) => a == b && x == y,
            _ => false, // to_delta() contains inserts only.
        })
}
