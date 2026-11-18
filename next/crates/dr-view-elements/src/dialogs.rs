//! Canonical v3 level surface.
pub mod v3 {
    use dr_i18n::keys;
    use dr_shell::{actions::Dismiss, pages::PageViewHost, strings::t};
    use dr_ui::{
        components::{Button, Dialog, MenuItem},
        sand::Icon,
    };
    use gpui::{prelude::*, *};
    use serde_json::{Value, json};

    fn background_edit(
        lib: dr_workspace::Workspace,
        edit: crate::data::v3::Mutation,
        cx: &App,
    ) -> futures::channel::oneshot::Receiver<Result<Value, dr_workspace::WsError>> {
        let (tx, rx) = futures::channel::oneshot::channel();
        cx.background_executor()
            .spawn(async move {
                let _ = tx.send(edit.commit(&lib));
            })
            .detach();
        rx
    }
    struct Choice {
        label: SharedString,
        value: Value,
        checked: bool,
    }
    pub struct Picker {
        host: PageViewHost,
        level: String,
        key: &'static str,
        focus: FocusHandle,
        busy: bool,
        error: bool,
        _workspace: Option<Subscription>,
    }
    pub fn open_setting(
        host: PageViewHost,
        level: String,
        key: &'static str,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(host) = crate::data::v3::fresh(&host, cx) else {
            return;
        };
        if !host
            .book
            .v3()
            .is_some_and(|v| v.levels.contains_key(&level))
        {
            return;
        }
        let view = cx.new(|cx| Picker::new(host, level, key, cx));
        window.focus(&view.read(cx).focus.clone(), cx);
        dr_shell::dialogs::show(cx, view.into());
    }
    pub fn restore(
        host: PageViewHost,
        level: String,
        key: &'static str,
        window: &mut Window,
        cx: &mut App,
    ) {
        if crate::data::v3::fresh(&host, cx).is_none() {
            return;
        }
        let book = host.book.clone();
        let view = cx.new(|cx| Picker::new(host, level, key, cx));
        window.focus(&view.read(cx).focus.clone(), cx);
        dr_shell::dialogs::show(cx, view.clone().into());
        view.update(cx, |this, cx| this.apply(None, book, window, cx));
    }
    impl Picker {
        fn new(
            host: PageViewHost,
            level: String,
            key: &'static str,
            cx: &mut Context<Self>,
        ) -> Self {
            cx.spawn(async move |this, cx| {
                let _ = this.update(cx, |this, cx| this.follow(cx));
            })
            .detach();
            Self {
                host,
                level,
                key,
                focus: cx.focus_handle(),
                busy: false,
                error: false,
                _workspace: None,
            }
        }
        fn follow(&mut self, cx: &mut Context<Self>) {
            if let Some(ws) = self.host.workspace.upgrade() {
                self._workspace = Some(cx.observe(&ws, |this, ws, cx| {
                    let book = ws.read(cx).book.clone();
                    if book.id == this.host.book_id {
                        this.host.book = book;
                        cx.notify();
                    }
                }));
            }
        }
        fn close(&self, cx: &mut Context<Self>) {
            let id = cx.entity_id();
            dr_shell::dialogs::hide(cx, id);
        }
        fn apply(
            &mut self,
            value: Option<Value>,
            book: std::rc::Rc<dr_shell::book::Book>,
            window: &mut Window,
            cx: &mut Context<Self>,
        ) {
            if self.busy {
                return;
            }
            if crate::data::v3::fresh(&self.host, cx).is_none() {
                self.close(cx);
                return;
            }
            let host = PageViewHost {
                book,
                ..self.host.clone()
            };
            if !host
                .book
                .v3()
                .is_some_and(|v| v.levels.contains_key(&self.level))
            {
                self.close(cx);
                return;
            }
            self.busy = true;
            self.error = false;
            let (id, key) = (self.level.clone(), self.key);
            let edit = match crate::data::v3::prepare_override(&host.book, &id, key, value) {
                Ok(edit) => edit,
                Err(error) => {
                    log::warn!("v3 level setting: {error}");
                    self.busy = false;
                    self.error = true;
                    cx.notify();
                    return;
                }
            };
            let lib = host.library;
            // Admit the write now; closing the window cannot cancel its database job.
            let job = background_edit(lib, edit, cx);
            cx.spawn_in(window, async move |this, cx| {
                let result = job.await.unwrap_or_else(|_| {
                    Err(dr_workspace::WsError::Internal(
                        "level write worker stopped".into(),
                    ))
                });
                let _ = this.update(cx, |this, cx| {
                    this.busy = false;
                    this.error = result.is_err();
                    if let Err(error) = &result {
                        log::warn!("v3 level setting: {error}");
                    }
                    if result.is_ok() {
                        this.close(cx);
                    } else {
                        cx.notify();
                    }
                });
            })
            .detach();
            cx.notify();
        }
        fn choices(&self, cx: &App) -> Vec<Choice> {
            let Some(v) = self.host.book.v3() else {
                return vec![];
            };
            let Some(l) = v.levels.get(&self.level) else {
                return vec![];
            };
            let s = &l.settings;
            let choice = |label: SharedString, value: Value, current: Value| Choice {
                label,
                checked: value == current,
                value,
            };
            match self.key {
                "display" => ["list", "grid", "board", "island"]
                    .into_iter()
                    .map(|value| {
                        choice(
                            dr_shell::v3::page::display_name(value, cx),
                            json!(value),
                            json!(s.display),
                        )
                    })
                    .collect(),
                "auto_link" | "accept" => {
                    let current = match self.key {
                        "auto_link" => s.auto_link,
                        _ => s.accept,
                    };
                    [true, false]
                        .into_iter()
                        .map(|value| {
                            choice(
                                t(
                                    cx,
                                    if value {
                                        keys::v3_levels::ON
                                    } else {
                                        keys::v3_levels::OFF
                                    },
                                ),
                                json!(value),
                                json!(current),
                            )
                        })
                        .collect()
                }
                "default_template" => std::iter::once(choice(
                    t(cx, keys::v3_levels::NONE),
                    Value::Null,
                    json!(s.default_template),
                ))
                .chain(
                    v.templates
                        .iter()
                        .filter(|t| t.deleted_at.is_none())
                        .map(|t| {
                            choice(
                                t.name.clone().into(),
                                json!(t.id),
                                json!(s.default_template),
                            )
                        }),
                )
                .collect(),
                "home" => std::iter::once(choice(
                    t(cx, keys::v3_levels::THIS_LEVEL),
                    Value::Null,
                    json!(s.home),
                ))
                .chain(
                    v.entries
                        .iter()
                        .filter(|e| e.id != self.level && v.levels.contains_key(&e.id))
                        .map(|e| choice(e.title.clone().into(), json!(e.id), json!(s.home))),
                )
                .collect(),
                "format_shortcuts" => [
                    ("full", keys::v3_levels::FORMAT_FULL),
                    ("notes", keys::v3_levels::FORMAT_NOTES),
                    ("plain", keys::v3_levels::FORMAT_PLAIN),
                ]
                .into_iter()
                .map(|(value, label)| choice(t(cx, label), json!(value), json!(s.format_shortcuts)))
                .collect(),
                _ => vec![],
            }
        }
    }
    impl Render for Picker {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let weak = cx.entity().downgrade();
            let close = weak.clone();
            let mut list = div()
                .id("g2-setting-options")
                .max_h(px(360.0))
                .overflow_y_scroll()
                .flex()
                .flex_col();
            for (index, choice) in self.choices(cx).into_iter().enumerate() {
                let weak = weak.clone();
                let value = choice.value;
                let book = self.host.book.clone();
                list = list.child(
                    MenuItem::new(
                        SharedString::from(format!("g2-setting-choice-{index}")),
                        Icon::Check,
                        choice.label,
                    )
                    .checked(choice.checked)
                    .disabled(self.busy)
                    .on_click(move |_, window, cx| {
                        let _ = weak.update(cx, |this, cx| {
                            this.apply(Some(value.clone()), book.clone(), window, cx)
                        });
                    }),
                );
            }
            if self.error {
                let error = t(cx, keys::common::SAVE_FAILED);
                list = list.child(
                    div()
                        .id("g2-setting-error")
                        .role(gpui::Role::Alert)
                        .aria_label(error.clone())
                        .child(error),
                );
            }
            let dialog = Dialog::new(
                "g2-setting-dialog",
                crate::category::v3::label(self.key, cx),
            )
            .width(420.0)
            .body(list)
            .action(
                Button::new("g2-setting-close", t(cx, keys::common::CLOSE))
                    .text()
                    .disabled(self.busy)
                    .on_click(move |_, _, cx| {
                        let _ = close.update(cx, |this, cx| this.close(cx));
                    }),
            )
            .on_close(move |_, cx| {
                let _ = weak.update(cx, |this, cx| {
                    if !this.busy {
                        this.close(cx);
                    }
                });
            });
            div()
                .track_focus(&self.focus)
                .key_context("G2LevelPicker")
                .on_action(cx.listener(|this, _: &Dismiss, _, cx| {
                    if !this.busy {
                        this.close(cx);
                    }
                }))
                .child(dialog)
        }
    }
    #[derive(Clone, Copy)]
    pub enum EntryMode {
        Template,
        Membership,
    }
    pub struct EntryPicker {
        host: PageViewHost,
        origin: String,
        mode: EntryMode,
        focus: FocusHandle,
        busy: bool,
        error: bool,
        _workspace: Option<Subscription>,
    }
    pub fn open_entry(
        host: PageViewHost,
        origin: String,
        mode: EntryMode,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(host) = crate::data::v3::fresh(&host, cx) else {
            return;
        };
        if !host.book.v3().is_some_and(|v| v.entry(&origin).is_some()) {
            return;
        }
        let view = cx.new(|cx| EntryPicker::new(host, origin, mode, cx));
        window.focus(&view.read(cx).focus.clone(), cx);
        dr_shell::dialogs::show(cx, view.into());
    }
    impl EntryPicker {
        fn new(
            host: PageViewHost,
            origin: String,
            mode: EntryMode,
            cx: &mut Context<Self>,
        ) -> Self {
            cx.spawn(async move |this, cx| {
                let _ = this.update(cx, |this, cx| this.follow(cx));
            })
            .detach();
            Self {
                host,
                origin,
                mode,
                focus: cx.focus_handle(),
                busy: false,
                error: false,
                _workspace: None,
            }
        }
        fn follow(&mut self, cx: &mut Context<Self>) {
            if let Some(ws) = self.host.workspace.upgrade() {
                self._workspace = Some(cx.observe(&ws, |this, ws, cx| {
                    let book = ws.read(cx).book.clone();
                    if book.id == this.host.book_id {
                        this.host.book = book;
                        cx.notify();
                    }
                }));
            }
        }
        fn close(&self, cx: &mut Context<Self>) {
            let id = cx.entity_id();
            dr_shell::dialogs::hide(cx, id);
        }
        fn host(&self, book: std::rc::Rc<dr_shell::book::Book>, cx: &App) -> Option<PageViewHost> {
            let current = crate::data::v3::fresh(&self.host, cx)?;
            current.book.v3()?.entry(&self.origin)?;
            Some(PageViewHost {
                book,
                ..self.host.clone()
            })
        }
        fn change_template(
            &mut self,
            template: &str,
            book: std::rc::Rc<dr_shell::book::Book>,
            window: &mut Window,
            cx: &mut Context<Self>,
        ) {
            if self.busy {
                return;
            }
            let Some(host) = self.host(book, cx) else {
                self.close(cx);
                return;
            };
            if !crate::data::v3::switch_templates(&host.book, &self.origin)
                .iter()
                .any(|id| id == template)
            {
                return;
            }
            let input = json!({"book":host.book_id,"id":self.origin,"template":template});
            self.submit(host, "entry.update", input, true, window, cx);
        }
        fn membership(
            &mut self,
            host_id: &str,
            primary: bool,
            book: std::rc::Rc<dr_shell::book::Book>,
            window: &mut Window,
            cx: &mut Context<Self>,
        ) {
            if self.busy {
                return;
            }
            let Some(host) = self.host(book, cx) else {
                self.close(cx);
                return;
            };
            let Some(v) = host.book.v3() else { return };
            if !crate::data::v3::membership_hosts(&host.book, &self.origin)
                .iter()
                .any(|id| id == host_id)
            {
                return;
            }
            let contains = v
                .memberships
                .iter()
                .any(|m| m.host == host_id && m.member == self.origin);
            let name = if primary {
                "membership.primary"
            } else if contains {
                "membership.remove"
            } else {
                "membership.add"
            };
            let primary_host =
                if v.entry(&self.origin).and_then(|e| e.primary.as_deref()) == Some(host_id) {
                    None
                } else {
                    Some(host_id)
                };
            let input = if primary {
                json!({"book":host.book_id,"member":self.origin,"host":primary_host})
            } else {
                json!({"book":host.book_id,"member":self.origin,"host":host_id})
            };
            self.submit(host, name, input, false, window, cx);
        }
        fn submit(
            &mut self,
            host: PageViewHost,
            name: &'static str,
            input: Value,
            close: bool,
            window: &mut Window,
            cx: &mut Context<Self>,
        ) {
            let edit = match crate::data::v3::prepare(&host.book, name, input) {
                Ok(edit) => edit,
                Err(error) => {
                    log::warn!("v3 entry selector: {error}");
                    self.error = true;
                    cx.notify();
                    return;
                }
            };
            self.busy = true;
            self.error = false;
            cx.notify();
            // Changing the template offers 「撤销」 once it is done.
            let offer = (name == "entry.update").then(|| host.clone());
            let origin = self.origin.clone();
            let lib = host.library;
            let (tx, job) = futures::channel::oneshot::channel();
            cx.background_executor()
                .spawn(async move {
                    let _ = tx.send(edit.commit_answer(&lib));
                })
                .detach();
            cx.spawn_in(window, async move |this, cx| {
                let answer = job.await.unwrap_or_else(|_| {
                    Err(dr_workspace::WsError::Internal(
                        "entry write worker stopped".into(),
                    ))
                });
                let _ = this.update(cx, |this, cx| {
                    if let (Some(host), Ok(answer)) = (&offer, &answer) {
                        let label = t(cx, keys::v3_shell::CHANGE_TEMPLATE);
                        dr_shell::workspace::toast::offer_undo_after(
                            host, label, &origin, answer, cx,
                        );
                    }
                    this.busy = false;
                    this.error = answer.is_err();
                    match answer {
                        Ok(_) if close => this.close(cx),
                        Ok(_) => {}
                        Err(error) => log::warn!("v3 entry selector: {error}"),
                    }
                    cx.notify();
                });
            })
            .detach();
        }
    }
    impl Render for EntryPicker {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let book = self.host.book.clone();
            let Some(v) = book.v3() else {
                return div().into_any_element();
            };
            let Some(entry) = v.entry(&self.origin) else {
                return div().into_any_element();
            };
            let weak = cx.entity().downgrade();
            let title = t(
                cx,
                match self.mode {
                    EntryMode::Template => keys::v3_shell::CHANGE_TEMPLATE,
                    EntryMode::Membership => keys::v3_shell::BELONG_TO,
                },
            );
            let mut body = div()
                .id("g2-entry-options")
                .role(gpui::Role::Group)
                .aria_label(title.clone())
                .flex()
                .flex_col()
                .gap_2();
            let mut list = div()
                .id("g2-entry-choices")
                .max_h(px(320.0))
                .overflow_y_scroll()
                .flex()
                .flex_col();
            if matches!(self.mode, EntryMode::Membership) {
                for id in crate::data::v3::membership_hosts(&book, &self.origin) {
                    let Some(host) = v.entry(&id) else { continue };
                    let Some(target) = dr_shell::v3::entry_target(&id) else {
                        continue;
                    };
                    let (mark, color) = book.mark(&target);
                    let contains = v
                        .memberships
                        .iter()
                        .any(|m| m.host == id && m.member == self.origin);
                    let select = weak.clone();
                    let host_id = id.clone();
                    let primary = weak.clone();
                    let primary_id = id.clone();
                    let selected_book = book.clone();
                    let primary_book = book.clone();
                    let mut row = div()
                        .id(SharedString::from(format!("g2-membership-row-{id}")))
                        .role(gpui::Role::Group)
                        .aria_label(host.title.clone())
                        .flex()
                        .items_center()
                        .min_w_0()
                        .child(
                            div().flex_1().min_w_0().child(
                                MenuItem::new(
                                    SharedString::from(format!("g2-membership-{id}")),
                                    dr_ui::components::menu::RowIcon::Mark(mark, color),
                                    host.title.clone(),
                                )
                                .checked(contains)
                                .disabled(self.busy)
                                .on_click(move |_, window, cx| {
                                    let _ = select.update(cx, |this, cx| {
                                        this.membership(
                                            &host_id,
                                            false,
                                            selected_book.clone(),
                                            window,
                                            cx,
                                        )
                                    });
                                }),
                            ),
                        );
                    if contains {
                        row = row.child(
                            Button::new(
                                SharedString::from(format!("g2-primary-{id}")),
                                t(cx, keys::v3_levels::PRIMARY),
                            )
                            .small()
                            .when(entry.primary.as_deref() == Some(id.as_str()), |button| {
                                button.primary()
                            })
                            .when(entry.primary.as_deref() != Some(id.as_str()), |button| {
                                button.text()
                            })
                            .disabled(self.busy)
                            .on_click(move |_, window, cx| {
                                let _ = primary.update(cx, |this, cx| {
                                    this.membership(
                                        &primary_id,
                                        true,
                                        primary_book.clone(),
                                        window,
                                        cx,
                                    )
                                });
                            }),
                        );
                    }
                    list = list.child(row);
                }
            } else {
                for id in crate::data::v3::switch_templates(&book, &self.origin) {
                    let Some(template) = v.template(&id) else {
                        continue;
                    };
                    let Ok(template_id) = id.parse() else {
                        continue;
                    };
                    let (mark, color) = book.mark(&dr_shell::nav::Target::Template(template_id));
                    let change = weak.clone();
                    let selected_book = book.clone();
                    let checked = entry.template.as_ref() == Some(&id);
                    list = list.child(
                        MenuItem::new(
                            SharedString::from(format!("g2-template-choice-{id}")),
                            dr_ui::components::menu::RowIcon::Mark(mark, color),
                            template.name.clone(),
                        )
                        .checked(checked)
                        .disabled(self.busy || checked)
                        .on_click(move |_, window, cx| {
                            let _ = change.update(cx, |this, cx| {
                                this.change_template(&id, selected_book.clone(), window, cx);
                            });
                        }),
                    );
                }
            }
            body = body.child(list);
            if self.error {
                let error = t(cx, keys::common::SAVE_FAILED);
                body = body.child(
                    div()
                        .id("g2-entry-error")
                        .role(gpui::Role::Alert)
                        .aria_label(error.clone())
                        .child(error),
                );
            }
            let cancel = weak.clone();
            let close = weak.clone();
            let dialog = Dialog::new("g2-entry-dialog", title.clone())
                .width(420.0)
                .body(body)
                .action(
                    Button::new("g2-entry-cancel", t(cx, keys::common::CLOSE))
                        .text()
                        .disabled(self.busy)
                        .on_click(move |_, _, cx| {
                            let _ = cancel.update(cx, |this, cx| this.close(cx));
                        }),
                )
                .on_close(move |_, cx| {
                    let _ = close.update(cx, |this, cx| {
                        if !this.busy {
                            this.close(cx);
                        }
                    });
                });
            div()
                .id("g2-entry-picker")
                .track_focus(&self.focus)
                .key_context("G2EntryPicker")
                .on_action(cx.listener(|this, _: &Dismiss, _, cx| {
                    if !this.busy {
                        this.close(cx);
                    }
                }))
                .child(dialog)
                .into_any_element()
        }
    }
}
