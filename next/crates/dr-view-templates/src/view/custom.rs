//! Custom modules in the entry template editor (`custom-modules.md` §7,
//! §9, CM3; 原型第三页):
//!
//! - the 「添加模块」 menu: the built-in kinds as before, a line, 「我的模块」
//!   one row a module (those the template has not got yet), a line,
//!   「新建模块…」 (an empty module of mine, put into the template and opened
//!   in its workbench). 「社区」 comes with the community (second phase).
//! - a `custom` module's row: 「我的模块」 and 「改」 (its workbench) when my
//!   modules have it; 「模块」 and 「存进我的模块」 when it came with someone
//!   else's template or book (no 「改」 until it is kept).

use dr_i18n::keys::module_bench as mb;
use dr_model::custom_module::ModuleValue;
use dr_workspace::{
    Actor,
    commands::v3::custom_module::{
        AdoptIn, CreateIn, CustomModuleAdopt, CustomModuleCreate, CustomModuleList, ListIn,
        ModuleSummary, is_my_module_store_event,
    },
};

use super::*;

impl TemplateEditor {
    /// Reads my modules now and whenever they change.
    pub(super) fn listen_my_modules(&mut self, cx: &mut Context<Self>) {
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<()>();
        self._my_modules = Some(self.host.library.library().subscribe(move |event| {
            if is_my_module_store_event(event) {
                let _ = tx.unbounded_send(());
            }
        }));
        cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while rx.next().await.is_some() {
                while rx.try_recv().is_ok() {}
                if this.update(cx, |t, cx| t.load_my_modules(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        self.load_my_modules(cx);
    }

    fn load_my_modules(&mut self, cx: &mut Context<Self>) {
        let lib = self.host.library.clone();
        let job = cx.background_spawn(async move {
            lib.run::<CustomModuleList>(&Actor::User, ListIn {})
                .map(|o| o.output)
        });
        cx.spawn(async move |this, cx| {
            if let Ok(list) = job.await {
                this.update(cx, |t, cx| {
                    t.my_modules = Some(list);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    /// My modules as last read (tests).
    pub fn my_modules(&self) -> Option<&[ModuleSummary]> {
        self.my_modules.as_deref()
    }

    /// Whether the module a `custom` row draws is one of mine (`None`:
    /// not known yet).
    fn follows(&self, module: &ModuleSpec) -> Option<bool> {
        let id = module.config.module.as_deref()?;
        Some(self.my_modules.as_ref()?.iter().any(|m| m.id == id))
    }

    /// What a `custom` row says it is: 「我的模块」 or 「模块」.
    pub(super) fn custom_kind(&self, module: &ModuleSpec, cx: &App) -> SharedString {
        match self.follows(module) {
            Some(true) => t(cx, mb::MY_MODULE),
            _ => type_label(&module.kind, cx),
        }
    }

    /// A `custom` row's link: 「改」 (my module's workbench) or
    /// 「存进我的模块」.
    pub(super) fn custom_link(
        &self,
        module: &ModuleSpec,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let id = module.config.module.clone()?;
        let follows = self.follows(module)?;
        let mid = module.id.clone();
        let label = t(cx, if follows { mb::EDIT } else { mb::ADOPT });
        let button = Button::new(
            SharedString::from(format!(
                "k5-custom-{}-{mid}",
                if follows { "edit" } else { "adopt" }
            )),
            label,
        )
        .small()
        .text();
        Some(if follows {
            let ws = self.host.workspace.clone();
            button
                .on_click(move |_, _, cx| {
                    let Ok(id) = id.parse() else {
                        return;
                    };
                    ws.update(cx, |ws, cx| ws.open(Target::Module(id), Open::KEEP, cx))
                        .ok();
                })
                .into_any_element()
        } else {
            button
                .on_click(cx.listener(move |this, _, _, cx| this.adopt(id.clone(), cx)))
                .into_any_element()
        })
    }

    /// 「存进我的模块」: the module this book's templates use goes into my
    /// modules with a new id, and they use that one from now on (the
    /// command writes the stored templates; the draft follows them).
    fn adopt(&mut self, module: String, cx: &mut Context<Self>) {
        let lib = self.host.library.clone();
        let book = self.host.book_id.clone();
        let job = cx.background_spawn(async move {
            lib.run::<CustomModuleAdopt>(&Actor::User, AdoptIn { book, module })
        });
        let ws = self.host.workspace.clone();
        cx.spawn(async move |this, cx| {
            let done = job.await;
            this.update(cx, |t, cx| {
                if let Err(error) = done {
                    log::warn!("a module could not be kept in my modules: {error}");
                    ws.update(cx, |ws, cx| {
                        ws.toast_error(dr_shell::t(cx, common::SAVE_FAILED), cx)
                    })
                    .ok();
                }
                t.load_my_modules(cx);
            })
            .ok();
        })
        .detach();
    }

    /// Puts my module `summary` into the draft.
    fn add_my_module(&mut self, summary: &ModuleSummary) {
        let mut spec = model::module("custom", summary.name.clone());
        spec.config.module = Some(summary.id.clone());
        model::add_module(&mut self.draft, spec);
    }

    /// 「新建模块…」: an empty module of mine, in the draft, open in its
    /// workbench.
    fn new_module(&mut self, cx: &mut Context<Self>) {
        let name = t(cx, mb::UNTITLED).to_string();
        let lib = self.host.library.clone();
        let value = ModuleValue::empty(&name);
        let job = cx.background_spawn(async move {
            let value = serde_json::to_value(&value)
                .map_err(|e| dr_workspace::WsError::Internal(e.to_string()))?;
            lib.run::<CustomModuleCreate>(&Actor::User, CreateIn { value })
                .map(|o| o.output)
        });
        let ws = self.host.workspace.clone();
        cx.spawn(async move |this, cx| {
            let made = job.await;
            this.update(cx, |t, cx| match made {
                Ok(summary) => {
                    t.add_my_module(&summary);
                    t.my_modules
                        .get_or_insert_with(Vec::new)
                        .push(summary.clone());
                    cx.notify();
                    if let Ok(id) = summary.id.parse() {
                        cx.defer(move |cx| {
                            ws.update(cx, |ws, cx| ws.open(Target::Module(id), Open::KEEP, cx))
                                .ok();
                        });
                    }
                }
                Err(error) => {
                    log::warn!("a new module could not be made: {error}");
                    ws.update(cx, |ws, cx| {
                        ws.toast_error(dr_shell::t(cx, common::SAVE_FAILED), cx)
                    })
                    .ok();
                }
            })
            .ok();
        })
        .detach();
    }

    /// The menu's part for custom modules (§9): a line, 「我的模块」 and its
    /// rows, a line, 「新建模块…」.
    pub(super) fn my_modules_menu(
        &self,
        mut menu: Menu,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> Menu {
        let placed: Vec<&str> = self
            .draft
            .modules
            .iter()
            .filter(|m| m.kind == "custom")
            .filter_map(|m| m.config.module.as_deref())
            .collect();
        let mine: Vec<ModuleSummary> = self
            .my_modules
            .iter()
            .flatten()
            .filter(|m| !placed.contains(&m.id.as_str()))
            .cloned()
            .collect();
        if !mine.is_empty() {
            menu = menu.separator(theme).section(t(cx, mb::MY_MODULES), theme);
            for summary in mine {
                let id = summary.id.clone();
                menu = menu.item(
                    MenuItem::new(
                        SharedString::from(format!("k5-pick-module-{id}")),
                        Icon::Plus,
                        summary.name.clone(),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.add_my_module(&summary);
                        this.picker = None;
                        cx.notify();
                    })),
                );
            }
        }
        // A new template's dialog stays over the window: a module of its own
        // is made once the template is (its workbench is a pill of the
        // project).
        if !self.in_dialog() {
            menu = menu.separator(theme).item(
                MenuItem::new("k5-new-module", Icon::Plus, t(cx, mb::NEW_MODULE)).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.picker = None;
                        this.new_module(cx);
                        cx.notify();
                    }),
                ),
            );
        }
        menu
    }
}
