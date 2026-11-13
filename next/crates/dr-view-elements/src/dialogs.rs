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
                "auto_link" | "accept" | "is_manuscript" | "lane" => {
                    let current = match self.key {
                        "auto_link" => s.auto_link,
                        "accept" => s.accept,
                        "is_manuscript" => s.is_manuscript,
                        _ => s.lane,
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
        New,
        Template,
        Membership,
    }
    pub struct EntryPicker {
        host: PageViewHost,
        shown: std::rc::Rc<dr_shell::book::Book>,
        origin: String,
        mode: EntryMode,
        focus: FocusHandle,
        name: Entity<dr_ui::input::TextField>,
        template: Option<String>,
        busy: bool,
        error: bool,
        pending_new: Option<String>,
        _name: Subscription,
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
        let view = cx.new(|cx| EntryPicker::new(host, origin, mode, window, cx));
        let focus = if matches!(mode, EntryMode::New) {
            gpui::Focusable::focus_handle(view.read(cx).name.read(cx), cx)
        } else {
            view.read(cx).focus.clone()
        };
        window.focus(&focus, cx);
        dr_shell::dialogs::show(cx, view.into());
    }
    impl EntryPicker {
        fn new(
            host: PageViewHost,
            origin: String,
            mode: EntryMode,
            window: &mut Window,
            cx: &mut Context<Self>,
        ) -> Self {
            let name = cx.new(|cx| {
                dr_ui::input::TextField::new("g2-new-entry-title", window, cx)
                    .placeholder(t(cx, keys::v3_levels::TITLE))
            });
            let sub = cx.subscribe_in(&name, window, |this, _, event, window, cx| match event {
                dr_ui::input::FieldEvent::Submitted(_) => this.create(window, cx),
                dr_ui::input::FieldEvent::Cancelled => {
                    if !this.busy || this.pending_new.is_some() {
                        this.close(cx)
                    }
                }
                _ => cx.notify(),
            });
            let template = crate::data::v3::creation(&host.book, &origin).and_then(|c| c.default);
            cx.spawn(async move |this, cx| {
                let _ = this.update(cx, |this, cx| this.follow(cx));
            })
            .detach();
            let shown = host.book.clone();
            Self {
                host,
                shown,
                origin,
                mode,
                focus: cx.focus_handle(),
                name,
                template,
                busy: false,
                error: false,
                pending_new: None,
                _name: sub,
                _workspace: None,
            }
        }
        fn follow(&mut self, cx: &mut Context<Self>) {
            if let Some(ws) = self.host.workspace.upgrade() {
                self._workspace = Some(cx.observe(&ws, |this, ws, cx| {
                    let book = ws.read(cx).book.clone();
                    if book.id == this.host.book_id {
                        this.host.book = book;
                        this.finish_created(cx);
                        cx.notify();
                    }
                }));
            }
        }
        fn finish_created(&mut self, cx: &mut Context<Self>) {
            let Some(id) = self.pending_new.clone() else {
                return;
            };
            let Some(current) = crate::data::v3::fresh(&self.host, cx) else {
                self.pending_new = None;
                self.busy = false;
                self.close(cx);
                return;
            };
            if !current.book.v3().is_some_and(|v| v.entry(&id).is_some()) {
                return;
            }
            self.pending_new = None;
            self.busy = false;
            self.name
                .update(cx, |field, cx| field.set_disabled(false, cx));
            self.close(cx);
            if let Some(target) = dr_shell::v3::entry_target(&id)
                && let Some(ws) = current.workspace.upgrade()
            {
                ws.update(cx, |ws, cx| ws.open(target, dr_shell::nav::Open::KEEP, cx));
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
        fn create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
            if self.busy || !matches!(self.mode, EntryMode::New) {
                return;
            }
            let Some(host) = self.host(self.shown.clone(), cx) else {
                self.error = true;
                cx.notify();
                return;
            };
            let Some(context) = crate::data::v3::creation(&host.book, &self.origin) else {
                return;
            };
            let title = self.name.read(cx).text().trim().to_owned();
            let template = self.template.clone();
            if !template
                .as_ref()
                .map_or(context.blank, |id| context.templates.contains(id))
            {
                return;
            }
            if title.is_empty() {
                return;
            }
            let input = json!({"book":host.book_id,"parent":context.context,"template":template,"title":title});
            self.submit(host, "entry.create", input, true, true, window, cx);
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
            self.submit(host, "entry.update", input, true, false, window, cx);
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
            self.submit(host, name, input, false, false, window, cx);
        }
        #[allow(clippy::too_many_arguments)]
        fn submit(
            &mut self,
            host: PageViewHost,
            name: &'static str,
            input: Value,
            close: bool,
            open: bool,
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
            self.name
                .update(cx, |field, cx| field.set_disabled(true, cx));
            self.error = false;
            cx.notify();
            let lib = host.library;
            let job = background_edit(lib, edit, cx);
            cx.spawn_in(window, async move |this, cx| {
                let result = job.await.unwrap_or_else(|_| {
                    Err(dr_workspace::WsError::Internal(
                        "entry write worker stopped".into(),
                    ))
                });
                let _ = this.update(cx, |this, cx| {
                    this.busy = false;
                    this.name
                        .update(cx, |field, cx| field.set_disabled(false, cx));
                    this.error = result.is_err();
                    match result {
                        Ok(value) => {
                            if open {
                                this.pending_new = value["id"].as_str().map(str::to_owned);
                                this.busy = this.pending_new.is_some();
                                this.name
                                    .update(cx, |field, cx| field.set_disabled(this.busy, cx));
                                this.finish_created(cx);
                            } else if close {
                                this.close(cx);
                            }
                        }
                        Err(error) => {
                            log::warn!("v3 entry selector: {error}");
                            cx.notify();
                        }
                    }
                    cx.notify();
                });
            })
            .detach();
        }
    }
    impl Render for EntryPicker {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let book = if matches!(self.mode, EntryMode::New) {
                self.shown.clone()
            } else {
                self.host.book.clone()
            };
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
                    EntryMode::New => keys::v3_shell::NEW_ENTRY,
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
            let templates = match self.mode {
                EntryMode::New => crate::data::v3::creation(&book, &self.origin)
                    .map(|c| c.templates)
                    .unwrap_or_default(),
                EntryMode::Template => crate::data::v3::switch_templates(&book, &self.origin),
                EntryMode::Membership => vec![],
            };
            if matches!(self.mode, EntryMode::New) {
                body = body.child(self.name.clone());
                if let Some(home) = crate::data::v3::creation(&book, &self.origin)
                    .and_then(|c| c.home)
                    .and_then(|id| v.entry(&id))
                {
                    body = body.child(
                        div()
                            .id("g2-new-home")
                            .role(gpui::Role::Group)
                            .aria_label(t(cx, keys::v3_levels::HOME))
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .child(t(cx, keys::v3_levels::HOME))
                            .child(
                                div()
                                    .id("g2-new-home-value")
                                    .role(gpui::Role::Note)
                                    .aria_label(home.title.clone())
                                    .child(home.title.clone()),
                            ),
                    );
                }
            }
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
                for id in &templates {
                    let Some(template) = v.template(id) else {
                        continue;
                    };
                    let Ok(template_id) = id.parse() else {
                        continue;
                    };
                    let (mark, color) = book.mark(&dr_shell::nav::Target::Template(template_id));
                    let target = id.clone();
                    let change = weak.clone();
                    let selected_book = book.clone();
                    let checked = if matches!(self.mode, EntryMode::New) {
                        self.template.as_ref() == Some(id)
                    } else {
                        entry.template.as_ref() == Some(id)
                    };
                    list = list.child(
                        MenuItem::new(
                            SharedString::from(format!("g2-template-choice-{id}")),
                            dr_ui::components::menu::RowIcon::Mark(mark, color),
                            template.name.clone(),
                        )
                        .checked(checked)
                        .disabled(self.busy || matches!(self.mode, EntryMode::Template) && checked)
                        .on_click(move |_, window, cx| {
                            let _ = change.update(cx, |this, cx| {
                                if matches!(this.mode, EntryMode::New) {
                                    this.template = Some(target.clone());
                                    cx.notify();
                                } else {
                                    this.change_template(
                                        &target,
                                        selected_book.clone(),
                                        window,
                                        cx,
                                    );
                                }
                            });
                        }),
                    );
                }
            }
            if matches!(self.mode, EntryMode::New)
                && crate::data::v3::creation(&book, &self.origin).is_some_and(|c| c.blank)
            {
                let weak = weak.clone();
                list = list.child(
                    MenuItem::new(
                        "g2-blank-template",
                        Icon::Check,
                        t(cx, keys::v3_levels::NONE),
                    )
                    .checked(self.template.is_none())
                    .disabled(self.busy)
                    .on_click(move |_, _, cx| {
                        let _ = weak.update(cx, |this, cx| {
                            this.template = None;
                            cx.notify();
                        });
                    }),
                );
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
            let retry = weak.clone();
            let mut dialog = Dialog::new("g2-entry-dialog", title.clone())
                .width(420.0)
                .body(body)
                .action(
                    Button::new("g2-entry-cancel", t(cx, keys::common::CLOSE))
                        .text()
                        .disabled(self.busy && self.pending_new.is_none())
                        .on_click(move |_, _, cx| {
                            let _ = cancel.update(cx, |this, cx| this.close(cx));
                        }),
                )
                .on_close(move |_, cx| {
                    let _ = close.update(cx, |this, cx| {
                        if !this.busy || this.pending_new.is_some() {
                            this.close(cx);
                        }
                    });
                });
            if self.error && matches!(self.mode, EntryMode::New) {
                dialog = dialog.action(
                    Button::new("g2-entry-retry", t(cx, keys::markdown_share::RETRY))
                        .text()
                        .on_click(move |_, _, cx| {
                            let _ = retry.update(cx, |this, cx| {
                                if let Some(host) = crate::data::v3::fresh(&this.host, cx)
                                    && host
                                        .book
                                        .v3()
                                        .is_some_and(|v| v.entry(&this.origin).is_some())
                                {
                                    this.shown = host.book.clone();
                                    this.host = host;
                                    this.error = false;
                                    cx.notify();
                                }
                            });
                        }),
                );
            }
            if matches!(self.mode, EntryMode::New) {
                dialog = dialog.action(
                    Button::new("g2-entry-create", t(cx, keys::v3_levels::CREATE))
                        .primary()
                        .busy(self.busy)
                        .disabled(
                            self.busy
                                || self.name.read(cx).text().trim().is_empty()
                                || !self.template.as_ref().map_or_else(
                                    || {
                                        crate::data::v3::creation(&book, &self.origin)
                                            .is_some_and(|c| c.blank)
                                    },
                                    |id| templates.contains(id),
                                ),
                        )
                        .on_click(move |_, window, cx| {
                            let _ = weak.update(cx, |this, cx| this.create(window, cx));
                        }),
                );
            }
            div()
                .id("g2-entry-picker")
                .track_focus(&self.focus)
                .key_context("G2EntryPicker")
                .on_action(cx.listener(|this, _: &Dismiss, _, cx| {
                    if !this.busy || this.pending_new.is_some() {
                        this.close(cx);
                    }
                }))
                .child(dialog)
                .into_any_element()
        }
    }
}
