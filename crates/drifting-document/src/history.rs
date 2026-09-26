//! Shared local history metadata for durable comment anchors and transient views.
use super::*;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(crate) struct HistoryState {
    comments_before: comments::CommentSet,
    comments_after: comments::CommentSet,
    selections_before: selections::SelectionSet,
    selections_after: selections::SelectionSet,
    lineage: Option<crate::lineage::Lineage>,
}

#[derive(Clone, Default)]
pub(crate) struct HistoryMeta(pub Arc<Mutex<Option<HistoryState>>>);

impl DocumentSession {
    pub(crate) fn relocation_history_handle(
        &self,
        redo: bool,
    ) -> Option<crate::relocation_history::HistoryHandle> {
        let stack = if redo {
            self.undo.redo_stack()
        } else {
            self.undo.undo_stack()
        };
        stack
            .last()?
            .meta
            .0
            .lock()
            .unwrap()
            .as_ref()?
            .lineage
            .as_ref()?
            .relocation
            .clone()
    }
    pub(crate) fn finish_local_edit(
        &mut self,
        comments_before: comments::CommentSet,
        selections_before: selections::SelectionSet,
        undo_count: usize,
        map: Option<&NativeEditMap>,
        lineage: Option<crate::lineage::Lineage>,
    ) {
        self.refresh_comments(map);
        self.refresh_selections(map);
        if self.undo.undo_stack().len() > undo_count {
            if let Some(item) = self.undo.undo_stack().last() {
                *item.meta.0.lock().unwrap() = Some(HistoryState {
                    lineage,
                    comments_before,
                    comments_after: self.comments.clone(),
                    selections_before,
                    selections_after: self.selections.clone(),
                });
            }
        }
    }

    // Capture newer manual positions while both the source side and its
    // reconstructed item identities are still live. Matching epochs already
    // have their exact before/after anchors and must not be recomputed.
    pub(crate) fn prepare_selection_history(&self, redo: bool) {
        let stack = if redo {
            self.undo.redo_stack()
        } else {
            self.undo.undo_stack()
        };
        let Some(item) = stack.last() else {
            return;
        };
        let mut guard = item.meta.0.lock().unwrap();
        let Some(history) = guard.as_mut() else {
            return;
        };
        let Some(lineage) = &history.lineage else {
            return;
        };
        let (source, target) = if redo {
            (
                &mut history.selections_before,
                &mut history.selections_after,
            )
        } else {
            (
                &mut history.selections_after,
                &mut history.selections_before,
            )
        };
        for (id, current) in &self.selections {
            if target
                .get(id)
                .is_some_and(|saved| saved.epoch == current.epoch)
            {
                continue;
            }
            source.insert(id.clone(), current.clone());
            target.insert(
                id.clone(),
                self.map_selection_lineage(current, lineage, redo),
            );
        }
    }

    pub(crate) fn restore_local_history(&mut self, redo: bool) {
        let popped = self.popped_history.lock().unwrap().take();
        if let Some(meta) = popped {
            let history = meta.0.lock().unwrap().clone();
            if let Some(history) = history {
                let (comments, selections) = if redo {
                    (&history.comments_after, &history.selections_after)
                } else {
                    (&history.comments_before, &history.selections_before)
                };
                for (id, saved) in comments {
                    if self
                        .comments
                        .get(id)
                        .is_some_and(|current| current.epoch == saved.epoch)
                    {
                        self.comments.insert(id.clone(), saved.clone());
                    }
                }
                for (id, saved) in selections {
                    if self
                        .selections
                        .get(id)
                        .is_some_and(|current| current.epoch == saved.epoch)
                    {
                        self.selections.insert(id.clone(), saved.clone());
                    }
                }
                let opposite = if redo {
                    self.undo.undo_stack()
                } else {
                    self.undo.redo_stack()
                };
                if let Some(item) = opposite.last() {
                    *item.meta.0.lock().unwrap() = Some(history);
                }
            }
        }
        self.refresh_comments(None);
        self.refresh_selections(None);
    }
}
