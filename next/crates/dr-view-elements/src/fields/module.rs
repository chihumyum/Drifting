//! V3 key/value rows keep their read baseline until a guarded save succeeds.
use super::{Fields, Owner, guarded};
use dr_view_page::settlement;
use dr_workspace::{
    Actor,
    commands::v3::module::{In, ModuleRead},
    dto::FieldInfo,
};
use gpui::{AppContext as _, Context, Window};

impl Fields {
    fn module_target(&self) -> Option<In> {
        let Owner::Module { entry, module } = &self.owner;
        Some(In {
            book: self.book.id.clone(),
            entry: entry.clone(),
            module: module.clone(),
        })
    }
    pub(super) fn reload_module(&mut self, cx: &mut Context<Self>) {
        if !settlement::accepts(cx) {
            return;
        }
        let (Some(target), Some(lib)) = (self.module_target(), self.lib.clone()) else {
            return;
        };
        if self.module_reading {
            self.module_stale = true;
            return;
        }
        self.module_reading = true;
        let epoch = self.module_epoch;
        let job = cx.background_spawn(async move { lib.run::<ModuleRead>(&Actor::User, target) });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |v, cx| {
                v.module_reading = false;
                if epoch != v.module_epoch {
                    v.module_stale = true;
                } else {
                    match result {
                        Ok(data) => {
                            for row in &mut v.rows {
                                if !row.pending {
                                    row.awaiting = false;
                                }
                            }
                            v.module_rows = data
                                .output
                                .kv
                                .into_iter()
                                .map(|r| FieldInfo {
                                    id: r.id,
                                    key: r.key,
                                    value: r.value,
                                    pos: r.pos,
                                })
                                .collect()
                        }
                        Err(e) => log::warn!("key/value read: {e}"),
                    }
                }
                if v.module_stale {
                    v.module_stale = false;
                    v.reload_module(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
    pub(super) fn commit_module(
        &mut self,
        n: usize,
        retry: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !settlement::accepts(cx) {
            return;
        }
        let Some(ix) = self.row_ix(n) else {
            return;
        };
        let row = &self.rows[ix];
        if row.pending {
            self.rows[ix].queued = true;
            return;
        }
        if row.failed && !retry {
            return;
        }
        if row.removing {
            self.remove_module(ix, retry, cx);
            return;
        }
        let now = row.draft.clone();
        if now.0.trim().is_empty() && now.1.trim().is_empty() {
            if !Self::row_focused(row, window, cx) {
                self.remove_module(ix, retry, cx);
            }
            return;
        }
        if now == row.stored && !row.failed {
            return;
        }
        let (Some(target), Some(lib)) = (self.module_target(), self.lib.clone()) else {
            return;
        };
        let row = &mut self.rows[ix];
        let id = row
            .id
            .get_or_insert_with(|| dr_model::id::KvEntryId::new_v7().to_string())
            .clone();
        let base = (!row.module_new).then(|| row.stored.clone());
        row.pending = true;
        row.failed = false;
        row.queued = false;
        let sent = now.clone();
        let worker = lib.clone();
        let (job, ticket) = settlement::write(&lib, cx, async move {
            guarded::kv(&worker, target, id, base, now, retry)?.commit(&worker)
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            if this
                .update(cx, |v, cx| {
                    if let Some(ix) = v.row_ix(n) {
                        let row = &mut v.rows[ix];
                        row.pending = false;
                        match result {
                            Ok(saved) => {
                                let baseline =
                                    guarded::acknowledged_base(&sent, saved.clone(), &row.draft);
                                if sent.0 != saved.0 && row.draft.0 == sent.0 {
                                    row.draft.0 = saved.0.clone();
                                    row.key.update(cx, |f, cx| f.set_text(saved.0.clone(), cx));
                                }
                                if sent.1 != saved.1 && row.draft.1 == sent.1 {
                                    row.draft.1 = saved.1.clone();
                                    row.value
                                        .update(cx, |f, cx| f.set_text(saved.1.clone(), cx));
                                }
                                row.stored = baseline;
                                row.module_new = false;
                                row.awaiting = true;
                                v.module_epoch += 1;
                            }
                            Err(e) => {
                                log::warn!("key/value write: {e}");
                                row.failed = true;
                            }
                        }
                    }
                    v.reload_module(cx);
                    cx.notify();
                })
                .is_ok()
            {
                ticket.acknowledge();
            }
        })
        .detach();
        cx.notify();
    }
    pub(super) fn remove_module(&mut self, ix: usize, retry: bool, cx: &mut Context<Self>) {
        if !settlement::accepts(cx) {
            return;
        }
        let row = &self.rows[ix];
        if row.pending {
            return;
        }
        if row.module_new {
            self.rows.remove(ix);
            cx.notify();
            return;
        }
        if row.failed && !retry {
            return;
        }
        let (Some(target), Some(lib), Some(id)) =
            (self.module_target(), self.lib.clone(), row.id.clone())
        else {
            return;
        };
        let (n, base) = (row.n, row.stored.clone());
        let row = &mut self.rows[ix];
        row.pending = true;
        row.removing = true;
        row.failed = false;
        let worker = lib.clone();
        let (job, ticket) = settlement::write(&lib, cx, async move {
            guarded::remove_kv(&worker, target, id, base, retry)
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            if this
                .update(cx, |v, cx| {
                    if let Some(ix) = v.row_ix(n) {
                        match result {
                            Ok(()) => {
                                v.rows.remove(ix);
                                v.module_epoch += 1;
                            }
                            Err(e) => {
                                log::warn!("key/value remove: {e}");
                                v.rows[ix].pending = false;
                                v.rows[ix].failed = true;
                            }
                        }
                    }
                    v.reload_module(cx);
                    cx.notify();
                })
                .is_ok()
            {
                ticket.acknowledge();
            }
        })
        .detach();
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::Fields;
    use crate::fields::guarded::tests::{Fixture, draw, pair, wait};
    use gpui::{EntityInputHandler, Focusable, TestAppContext, VisualTestContext, px, size};
    use serde_json::json;

    fn edit_case(cx: &mut TestAppContext, value: bool, conflict: bool) {
        cx.executor().allow_parking();
        let f = Fixture::new("kv");
        f.put_kv(pair("old key", "old value"));
        let host = f.host(cx);
        let window = cx.add_window(|_, cx| Fields::for_module(host, cx));
        let view = window.root(cx).unwrap();
        let mut cx = VisualTestContext::from_window(window.into(), cx);
        cx.update(|w, _| w.activate_window());
        cx.simulate_resize(size(px(1000.), px(800.)));
        wait(&mut cx, |cx| view.read_with(cx, |v, _| !v.rows.is_empty()));
        let (key, val) =
            view.read_with(&cx, |v, _| (v.rows[0].key.clone(), v.rows[0].value.clone()));
        let edit = |cx: &mut VisualTestContext, text: &str| {
            if value {
                val.update_in(cx, |f, w, cx| {
                    f.focus_handle(cx).focus(w, cx);
                    f.select_all_text(cx);
                    f.replace_text_in_range(None, text, w, cx);
                });
            } else {
                key.update_in(cx, |f, w, cx| {
                    f.focus_handle(cx).focus(w, cx);
                    f.select_all_text(cx);
                    f.replace_text_in_range(None, text, w, cx);
                });
            }
        };
        edit(&mut cx, "author draft");
        draw(&mut cx);
        let remote = if value != conflict {
            pair("external key", "old value")
        } else {
            pair("old key", "external value")
        };
        f.put_kv(remote.clone());
        view.update(&mut cx, |v, cx| v.reload_module(cx));
        wait(&mut cx, |cx| view.read_with(cx, |v, _| !v.module_reading));
        cx.update(|w, cx| w.blur(cx));
        if conflict {
            wait(&mut cx, |cx| view.read_with(cx, |v, _| v.rows[0].failed));
            assert_eq!(f.pair(false), remote);
            edit(&mut cx, "revised draft");
            cx.update(|w, cx| w.blur(cx));
            draw(&mut cx);
            assert_eq!(
                f.pair(false),
                remote,
                "a refused row must not silently retry on blur"
            );
            f.put_kv(pair("latest external key", "latest external value"));
            view.update(&mut cx, |v, cx| v.reload_module(cx));
            wait(&mut cx, |cx| view.read_with(cx, |v, _| !v.module_reading));
            assert_eq!(
                if value {
                    val.read_with(&cx, |f, _| f.text())
                } else {
                    key.read_with(&cx, |f, _| f.text())
                },
                "revised draft"
            );
            view.update_in(&mut cx, |v, w, cx| {
                v.commit_module(v.rows[0].n, true, w, cx)
            });
        }
        wait(&mut cx, |cx| {
            view.read_with(cx, |v, _| !v.rows[0].pending && !v.module_reading)
        });
        assert!(!view.read_with(&cx, |v, _| v.rows[0].failed));
        assert_eq!(
            f.pair(false),
            match (value, conflict) {
                (false, false) => pair("author draft", "external value"),
                (true, false) => pair("external key", "author draft"),
                (false, true) => pair("revised draft", "latest external value"),
                (true, true) => pair("latest external key", "revised draft"),
            }
        );
    }
    #[gpui::test]
    fn editing_key_keeps_external_value(cx: &mut TestAppContext) {
        edit_case(cx, false, false);
    }
    #[gpui::test]
    fn editing_value_keeps_external_key(cx: &mut TestAppContext) {
        edit_case(cx, true, false);
    }
    #[gpui::test]
    fn conflicting_key_requires_explicit_retry(cx: &mut TestAppContext) {
        edit_case(cx, false, true);
    }
    #[gpui::test]
    fn conflicting_value_requires_explicit_retry(cx: &mut TestAppContext) {
        edit_case(cx, true, true);
    }
    #[gpui::test]
    fn a_removed_row_cannot_be_recreated_by_a_focused_draft(cx: &mut TestAppContext) {
        cx.executor().allow_parking();
        let f = Fixture::new("kv");
        f.put_kv(pair("old key", "old value"));
        let host = f.host(cx);
        let window = cx.add_window(|_, cx| Fields::for_module(host, cx));
        let view = window.root(cx).unwrap();
        let mut cx = VisualTestContext::from_window(window.into(), cx);
        cx.update(|w, _| w.activate_window());
        wait(&mut cx, |cx| view.read_with(cx, |v, _| !v.rows.is_empty()));
        let key = view.read_with(&cx, |v, _| v.rows[0].key.clone());
        key.update_in(&mut cx, |f, w, cx| {
            f.focus_handle(cx).focus(w, cx);
            f.replace_text_in_range(None, " draft", w, cx);
        });
        f.call("module.remove_kv", json!({"row":"g1-record"}));
        view.update(&mut cx, |v, cx| v.reload_module(cx));
        wait(&mut cx, |cx| view.read_with(cx, |v, _| !v.module_reading));
        cx.update(|w, cx| w.blur(cx));
        wait(&mut cx, |cx| view.read_with(cx, |v, _| v.rows[0].failed));
        let draft = key.read_with(&cx, |f, _| f.text());
        view.update_in(&mut cx, |v, w, cx| {
            v.commit_module(v.rows[0].n, true, w, cx)
        });
        wait(&mut cx, |cx| view.read_with(cx, |v, _| !v.rows[0].pending));
        assert_eq!(key.read_with(&cx, |f, _| f.text()), draft);
        assert!(view.read_with(&cx, |v, _| v.rows[0].failed));
        assert!(
            f.call("module.read", json!({}))["kv"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
