//! Adopt renderer-owned editors without creating another session or view.
use super::{Workspace, editors::*};
use crate::nav::Target;
use gpui::{Context, Focusable as _, Subscription, Window};

pub(super) struct MountedEditor {
    pub view: PageView,
    prose: gpui::EntityId,
    _events: Vec<Subscription>,
}

impl Workspace {
    pub(super) fn sync_mounted_editors(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.book.v3().is_none() {
            return;
        }
        let Some(library) = &self.library else {
            return;
        };
        let owner = cx.entity_id();
        let mut pages = Vec::new();
        for (key, page) in &self.editors {
            let Some(target) = Target::from_key(key) else {
                continue;
            };
            let roots = if let Some(composition) = &page.v3 {
                composition.read(cx).editor_views()
            } else if let Some(module) = &page.module {
                vec![(String::new(), module.view.entity_id())]
            } else {
                continue;
            };
            let views: Vec<_> = roots
                .into_iter()
                .filter_map(|(module, root)| {
                    let view =
                        crate::v3::registered_editor(root, owner, library, &self.book_id, cx)?;
                    let valid = match (&target, &view) {
                        (Target::Entry { id, .. }, PageView::Doc(e)) => {
                            e.read(cx).book_id() == self.book_id
                                && e.read(cx).doc_id() == format!("body:{id}/{module}")
                        }
                        (Target::Material(id), PageView::Doc(e)) => {
                            e.read(cx).book_id() == self.book_id
                                && e.read(cx).doc_id() == format!("material:{id}")
                        }
                        (Target::Book, PageView::Book(e)) => e.read(cx).book_id() == self.book_id,
                        _ => false,
                    };
                    valid.then_some((module, view))
                })
                .collect();
            pages.push((key.clone(), target, views));
        }
        for (key, target, views) in pages {
            let mut added = false;
            for (module, view) in &views {
                let prose = view.prose(cx).entity_id();
                let old = self.editors[&key].mounted.get(module);
                if old
                    .is_some_and(|old| old.view.identity() == view.identity() && old.prose == prose)
                {
                    continue;
                }
                // A whole-book reload replaces ProseEditor inside the same
                // BookEditor. Rebind events, but don't restore an old position.
                let new_instance = old.is_none_or(|old| old.view.identity() != view.identity());
                let binding = self.bind_mounted_editor(view.clone(), window, cx);
                if new_instance
                    && let PageView::Book(editor) = view
                    && let Some(at) = &self.book_position
                {
                    editor.update(cx, |e, cx| e.restore(&at.into(), cx));
                }
                self.editors
                    .get_mut(&key)
                    .unwrap()
                    .mounted
                    .insert(module.clone(), binding);
                added = true;
            }
            let page = self.editors.get_mut(&key).unwrap();
            page.mounted
                .retain(|module, _| views.iter().any(|(id, _)| id == module));
            let requested = match &target {
                Target::Entry { module, .. } => module.as_ref().map(|m| m.as_str()),
                _ => None,
            };
            let previous = page.view.as_ref().map(PageView::identity);
            let selected = if requested.is_some_and(|m| !views.iter().any(|(id, _)| id == m)) {
                None
            } else {
                views
                    .iter()
                    .find(|(_, v)| v.prose(cx).focus_handle(cx).contains_focused(window, cx))
                    .or_else(|| views.iter().find(|(_, v)| Some(v.identity()) == previous))
                    .or_else(|| match requested {
                        Some(module) => views.iter().find(|(id, _)| id == module),
                        None => views.first(),
                    })
                    .map(|(_, v)| v.clone())
            };
            page.doc = selected.as_ref().and_then(|v| match v {
                PageView::Doc(e) => Some(e.read(cx).doc_id().to_owned()),
                PageView::Book(_) => None,
            });
            page.view = selected;
            if added {
                self.report_words(&key, None, cx);
            }
        }
    }

    fn bind_mounted_editor(
        &mut self,
        view: PageView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> MountedEditor {
        let theme = dr_ui::Theme::of(window, cx);
        let base = base_style(&theme);
        let settings = editor_settings(cx);
        view.restyle(Some(&base), Some(&settings), cx);
        let looks = decor_looks(&theme, &base);
        let mut events = Vec::new();
        match &view {
            PageView::Doc(editor) => {
                events.extend(link_events(editor, cx));
                events.push(cx.subscribe(
                    editor,
                    |ws, _, event: &dr_editor::MaterialOpened, cx| {
                        if let Some(target) =
                            Target::from_key(&format!("material:{}", event.material))
                            && ws.book.exists(&target)
                        {
                            ws.open(target, crate::nav::Open::PREVIEW, cx);
                        }
                    },
                ));
                editor.update(cx, |e, cx| e.set_decor_looks(looks, cx));
                events.push(
                    cx.subscribe(editor, |ws, e, event, cx| ws.on_editor_event(&e, event, cx)),
                );
                events.push(cx.subscribe_in(
                    editor,
                    window,
                    |ws, e, req: &dr_editor::CommentRequested, window, cx| {
                        ws.on_comment_requested(req, e.read(cx).editor().clone(), 0, window, cx);
                    },
                ));
                events.push(
                    cx.subscribe(editor, |ws, _, _: &dr_editor::WritingTyped, cx| {
                        ws.author_wrote(cx)
                    }),
                );
            }
            PageView::Book(editor) => {
                events.extend(link_events(editor, cx));
                editor.update(cx, |e, cx| e.set_decor_looks(looks, cx));
                events.push(cx.subscribe(editor, |ws, _, event, cx| {
                    ws.on_book_event(event, cx);
                    // Reload can replace ProseEditor without replacing the
                    // renderer entity; refresh its focus/selection bindings.
                    cx.notify();
                }));
                events.push(cx.subscribe_in(
                    editor,
                    window,
                    |ws, e, req: &dr_editor::CommentRequested, window, cx| {
                        let book = e.read(cx);
                        if let Some(chapter) = book.chapter_of(&req.doc) {
                            ws.on_comment_requested(
                                req,
                                book.editor().clone(),
                                chapter,
                                window,
                                cx,
                            );
                        }
                    },
                ));
                events.push(
                    cx.subscribe(editor, |ws, _, _: &dr_editor::WritingTyped, cx| {
                        ws.author_wrote(cx)
                    }),
                );
            }
        }
        let prose = view.prose(cx);
        prose.update(cx, |p, cx| {
            p.set_block_style(block_style(&theme), cx);
            p.set_reduce_motion(theme.reduce_motion, cx);
        });
        events.push(cx.subscribe(&prose, |ws, prose, event, cx| {
            if matches!(event, gpui_prose::EditorEvent::SelectionChanged) {
                report_selection(&prose, cx);
                ws.caret_moved(&prose, cx);
            }
        }));
        events.push(cx.on_focus(&prose.focus_handle(cx), window, |_, _, cx| cx.notify()));
        MountedEditor {
            prose: prose.entity_id(),
            view,
            _events: events,
        }
    }
}
