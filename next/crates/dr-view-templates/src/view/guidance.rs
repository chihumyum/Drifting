use super::*;

impl TemplateEditor {
    pub(super) fn preview_request(&self) -> Option<crate::preview::Request> {
        (self.host.book.id == self.host.book_id).then_some(())?;
        let frontier = self.host.book.v3()?.revision.clone();
        Some(crate::preview::Request {
            book: self.host.book_id.clone(),
            frontier,
            draft: self.draft.clone(),
        })
    }

    pub(super) fn guidance(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut section = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .mt(px(12.))
            .child(t(cx, k::FOR_AGENT));
        for (binding, key, multiline) in [
            (Binding::AgentName, k::NAME, false),
            (Binding::AgentDescription, k::DESCRIPTION, false),
            (Binding::AgentInstructions, k::INSTRUCTIONS, true),
        ] {
            let field = self.field(binding, t(cx, key), multiline, window, cx);
            section = section.child(
                div()
                    .flex()
                    .gap(px(16.))
                    .items_start()
                    .child(div().w(px(120.)).child(t(cx, key)))
                    .child(field),
            );
        }
        for module in self.draft.modules.clone() {
            let field = self.field(
                Binding::ModuleInstructions(module.id),
                format!("{} · {}", t(cx, k::MODULE_INSTRUCTIONS), module.name).into(),
                false,
                window,
                cx,
            );
            section = section.child(
                div()
                    .flex()
                    .gap(px(16.))
                    .items_start()
                    .child(div().w(px(120.)).child(module.name))
                    .child(field),
            );
        }
        section = section.child(
            Button::new("k5-agent-preview", t(cx, k::AGENT_PREVIEW))
                .text()
                .small()
                .icon(if self.preview_open {
                    Icon::ChevronDown
                } else {
                    Icon::ChevronRight
                })
                .on_click(cx.listener(|this, _, _, cx| {
                    this.preview_open = !this.preview_open;
                    if !this.preview_open {
                        this.preview_task = None;
                        this.preview_cache = crate::preview::Cache::default();
                    }
                    cx.notify();
                })),
        );
        if self.preview_open {
            self.ensure_preview(cx);
            let body = match &self.preview_cache.text {
                Some(Ok(text)) => div()
                    .id("k5-preview-text")
                    .role(gpui::Role::Label)
                    .aria_label(text.clone())
                    .child(dr_ui::text::wrapped(text.clone()))
                    .into_any_element(),
                Some(Err(())) => t(cx, k::PREVIEW_FAILED).into_any_element(),
                None if self.preview_request().is_some() => {
                    dr_ui::components::Loading::new("k5-preview-loading")
                        .inline()
                        .immediate()
                        .label(t(cx, k::PREVIEW_LOADING))
                        .into_any_element()
                }
                None => t(cx, k::PREVIEW_FAILED).into_any_element(),
            };
            section = section.child(
                div()
                    .id("k5-preview")
                    .role(gpui::Role::Group)
                    .aria_label(t(cx, k::AGENT_PREVIEW))
                    .p(px(16.))
                    .font_role(Role::Index)
                    .type_px(13., 21.)
                    .child(body),
            );
        }
        section.into_any_element()
    }

    fn ensure_preview(&mut self, cx: &mut Context<Self>) {
        let Some(request) = self.preview_request() else {
            self.preview_task = None;
            self.preview_cache = crate::preview::Cache::default();
            return;
        };
        if !self.preview_cache.start(request.clone()) {
            return;
        }
        let submitted = request.clone();
        let library = self.host.library.clone();
        let executor = cx.background_executor().clone();
        // Replacing the owning task cancels an old pending timer. Fast typing
        // keeps the real text input focused and does not queue a fork per key.
        let job = cx.background_spawn(async move {
            executor.timer(std::time::Duration::from_millis(150)).await;
            crate::preview::project(&library, &request)
                .and_then(|preview| {
                    serde_json::to_string_pretty(&preview)
                        .map_err(|e| dr_workspace::WsError::Internal(e.to_string()))
                })
                .map_err(|_| ())
        });
        self.preview_task = Some(cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |this, cx| {
                this.finish_preview(&submitted, result, cx);
            });
        }));
    }

    pub(super) fn finish_preview(
        &mut self,
        request: &crate::preview::Request,
        result: Result<String, ()>,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.preview_open || self.preview_request().as_ref() != Some(request) {
            return false;
        }
        if self.preview_cache.publish(request, result) {
            cx.notify();
            return true;
        }
        false
    }
}
