//! 「导入文件」: Markdown, text and Word files into the open book (on
//! `dr_export::import`).
//!
//! The target selector lists every live entry whose level switch is on, as its
//! path in the tree; each imported file becomes a new entry under that level
//! using its resolved default template. Files come from the file panel or a
//! whole folder (only `.md`, `.markdown`, `.txt`, `.docx`, in natural name
//! order); each is read on its own thread as it is added, its title (an
//! opening H1, else the file name) can be changed, and 「开始导入」 writes
//! them in that order. Each file stands alone: one that fails says why and the
//! rest go in.

use std::collections::BTreeSet;
use std::path::PathBuf;

use dr_export::import::{
    IMPORT_EXTENSIONS, ImportTarget, ImportWarning, ImportedItem, ParsedDoc, files_in_folder,
    import_docs, order_import_files, parse_file,
};
use dr_i18n::{I18n, Key, keys};
use dr_ui::components::{Button, Choice, Dialog, RowIcon, Select};
use dr_ui::input::{FieldEvent, TextField};
use dr_ui::sand::{self, Icon};
use dr_ui::style::DrStyled;
use dr_ui::tokens::space;
use dr_ui::{Theme, fonts::Role};
use dr_workspace::{Actor, Workspace};
use gpui::{
    App, AppContext as _, Context, Entity, InteractiveElement, IntoElement, ParentElement,
    PathPromptOptions, Render, SharedString, StatefulInteractiveElement, Styled, Task, Window, div,
    px,
};

use keys::import_dialog as k;

/// The dialog's width (the 0.1 card's).
pub const WIDTH: f32 = 560.0;
const LIST_MAX_HEIGHT: f32 = 280.0;

/// One live entry whose level switch is on, in effective tree order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LevelOption {
    pub id: String,
    pub path: String,
    pub mark: sand::Kind,
    pub color: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    Parsing,
    Ready,
    Committed,
    Error(String),
}

/// What the file held that the import leaves out or changed, in words.
pub fn warning(i18n: &I18n, w: &ImportWarning) -> String {
    match w {
        ImportWarning::ImagesDropped(n) => i18n.plural(k::warnings::IMAGES_DROPPED, *n as u64, &[]),
        ImportWarning::NotUtf8 => i18n.t(k::warnings::NOT_UTF8).to_owned(),
    }
}

pub struct Item {
    pub path: PathBuf,
    pub filename: String,
    pub status: Status,
    pub parsed: Option<ParsedDoc>,
    pub warnings: Vec<String>,
    title: Entity<TextField>,
}

impl Item {
    pub fn title(&self, cx: &App) -> String {
        self.title.read(cx).text()
    }
}

pub struct DocumentsDialog {
    lib: Workspace,
    book: String,
    i18n: I18n,
    pub levels: Vec<LevelOption>,
    pub level: usize,
    pub items: Vec<Item>,
    pub running: bool,
    /// After an import: how many went in and how many did not.
    pub summary: Option<(usize, usize)>,
    next: usize,
    tasks: Vec<Task<()>>,
}

fn collect_levels(b: &dr_shell::book::v3::BookV3, i18n: &I18n) -> Vec<LevelOption> {
    fn walk<'a>(
        b: &'a dr_shell::book::v3::BookV3,
        ids: &'a [String],
        ancestors: &mut Vec<String>,
        seen: &mut BTreeSet<&'a str>,
        untitled: &str,
        out: &mut Vec<LevelOption>,
    ) {
        for id in ids {
            let Some(level) = b.levels.get(id.as_str()) else {
                continue;
            };
            if !seen.insert(id.as_str()) {
                continue;
            };
            let title = b
                .entry(id)
                .map(|e| e.title.trim())
                .filter(|t| !t.is_empty())
                .unwrap_or(untitled);
            ancestors.push(title.to_owned());
            let appearance = b.appearance(id);
            out.push(LevelOption {
                id: id.clone(),
                path: ancestors.join(" / "),
                mark: appearance.as_ref().map_or(sand::Kind::Element, |a| a.sand),
                color: appearance.and_then(|a| a.color),
            });
            walk(b, &level.children, ancestors, seen, untitled, out);
            ancestors.pop();
        }
    }
    let mut out = Vec::new();
    let mut ancestors = Vec::new();
    let mut seen = BTreeSet::new();
    let untitled = i18n.t(keys::k4_book::UNTITLED_ENTRY);
    walk(b, &b.roots, &mut ancestors, &mut seen, untitled, &mut out);
    out
}

/// The menu row's action: the dialog over the open book.
pub fn open(cx: &mut App) {
    dr_shell::workspace::with_workspace(cx, |ws, _, cx| {
        let Some(lib) = ws.library.clone() else {
            return;
        };
        if ws.book_id.is_empty() {
            return;
        }
        let book = ws.book_id.clone();
        dr_shell::menus::after_dispatch(cx, move |cx| {
            show(lib, book, cx);
        });
    });
}

/// The dialog for `book`, shown over the workspace.
pub fn show(lib: Workspace, book: String, cx: &mut App) -> Entity<DocumentsDialog> {
    let dialog = cx.new(|cx| DocumentsDialog::new(lib, book, cx));
    dr_shell::dialogs::show(cx, dialog.clone().into());
    dialog
}

impl DocumentsDialog {
    pub fn new(lib: Workspace, book: String, cx: &mut Context<Self>) -> DocumentsDialog {
        let strings = dr_shell::Strings::get(cx);
        let i18n = I18n::new(strings.locale(), strings.platform());
        let levels = dr_shell::book::Book::load(&lib, &book)
            .ok()
            .and_then(|b| b.v3().map(|v3| collect_levels(v3, &i18n)))
            .unwrap_or_default();
        DocumentsDialog {
            lib,
            book,
            i18n,
            levels,
            level: 0,
            items: Vec::new(),
            running: false,
            summary: None,
            next: 0,
            tasks: Vec::new(),
        }
    }

    /// Adds files (only those of the kinds read, in natural name order) and
    /// reads each on its own thread.
    pub fn add(&mut self, mut paths: Vec<PathBuf>, window: &mut Window, cx: &mut Context<Self>) {
        if self.running {
            return;
        }
        paths.retain(|p| {
            p.extension()
                .is_some_and(|e| IMPORT_EXTENSIONS.iter().any(|x| e.eq_ignore_ascii_case(x)))
        });
        order_import_files(&mut paths);
        self.summary = None;
        for path in paths {
            let filename = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            self.next += 1;
            let title = cx.new(|cx| {
                TextField::new(
                    gpui::ElementId::Name(format!("import-title-{}", self.next).into()),
                    window,
                    cx,
                )
                .small()
            });
            cx.subscribe(&title, |_, _, _: &FieldEvent, cx| cx.notify())
                .detach();
            let index = self.items.len();
            self.items.push(Item {
                path: path.clone(),
                filename,
                status: Status::Parsing,
                parsed: None,
                warnings: Vec::new(),
                title,
            });
            let job = cx
                .background_executor()
                .spawn(async move { parse_file(&path) });
            self.tasks.push(cx.spawn(async move |this, cx| {
                let parsed = job.await;
                this.update(cx, |d, cx| d.parsed(index, parsed, cx)).ok();
            }));
        }
        cx.notify();
    }

    fn parsed(
        &mut self,
        index: usize,
        parsed: Result<ParsedDoc, dr_export::import::ImportError>,
        cx: &mut Context<Self>,
    ) {
        let warnings: Vec<String> = parsed.as_ref().map_or_else(
            |_| Vec::new(),
            |doc| {
                doc.warnings
                    .iter()
                    .map(|w| warning(&self.i18n, w))
                    .collect()
            },
        );
        let Some(item) = self.items.get_mut(index) else {
            return;
        };
        match parsed {
            Ok(doc) => {
                item.warnings = warnings;
                let title = doc.title.clone();
                item.title.update(cx, |f, cx| f.set_text(title, cx));
                item.parsed = Some(doc);
                item.status = Status::Ready;
            }
            Err(e) => item.status = Status::Error(e.to_string()),
        }
        cx.notify();
    }

    pub fn ready(&self) -> usize {
        self.items
            .iter()
            .filter(|i| i.status == Status::Ready)
            .count()
    }

    pub fn can_start(&self) -> bool {
        !self.running && self.ready() > 0 && self.levels.get(self.level).is_some()
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        if !self.running {
            self.items.clear();
            self.summary = None;
            cx.notify();
        }
    }

    fn target(&self) -> Option<ImportTarget> {
        self.levels
            .get(self.level)
            .map(|l| ImportTarget::new(l.id.clone()))
    }

    /// 「开始导入」: every ready file, in order, off the main thread.
    pub fn start(&mut self, cx: &mut Context<Self>) {
        if !self.can_start() {
            return;
        }
        let Some(target) = self.target() else {
            return;
        };
        let picked: Vec<usize> = (0..self.items.len())
            .filter(|i| self.items[*i].status == Status::Ready)
            .collect();
        let docs: Vec<(String, ParsedDoc)> = picked
            .iter()
            .map(|i| {
                let item = &self.items[*i];
                (
                    item.title(cx).trim().to_owned(),
                    item.parsed.clone().expect("ready means parsed"),
                )
            })
            .collect();
        let (lib, book) = (self.lib.clone(), self.book.clone());
        self.running = true;
        cx.notify();
        let job = cx
            .background_executor()
            .spawn(async move { import_docs(&lib, &Actor::User, &book, &target, &docs, None) });
        self.tasks.push(cx.spawn(async move |this, cx| {
            let result = job.await;
            this.update(cx, |d, cx| d.finished(picked, result, cx)).ok();
        }));
    }

    fn finished(
        &mut self,
        picked: Vec<usize>,
        result: dr_export::Result<Vec<ImportedItem>>,
        cx: &mut Context<Self>,
    ) {
        self.running = false;
        let (mut ok, mut failed) = (0, 0);
        match result {
            Ok(items) => {
                for (i, done) in picked.iter().zip(items) {
                    let item = &mut self.items[*i];
                    match done.result {
                        Ok(_) => {
                            item.status = Status::Committed;
                            ok += 1;
                        }
                        Err(e) => {
                            item.status = Status::Error(e);
                            failed += 1;
                        }
                    }
                }
            }
            Err(e) => {
                for i in &picked {
                    self.items[*i].status = Status::Error(e.to_string());
                }
                failed = picked.len();
            }
        }
        self.summary = Some((ok, failed));
        cx.notify();
    }

    /// Closes the dialog (not while it writes).
    pub fn close(&mut self, cx: &mut Context<Self>) {
        if !self.running {
            let id = cx.entity_id();
            // Once the click or key that closes it is over (see
            // `TransferDialog::close`).
            cx.defer(move |cx| dr_shell::dialogs::hide(cx, id));
        }
    }

    fn pick(&mut self, folder: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.running {
            return;
        }
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: !folder,
            directories: folder,
            multiple: !folder,
            prompt: Some(
                self.i18n
                    .t(if folder {
                        k::CHOOSE_FOLDER
                    } else {
                        k::CHOOSE_FILES
                    })
                    .into(),
            ),
        });
        self.tasks.push(cx.spawn_in(window, async move |this, cx| {
            let picked = match paths.await {
                Ok(Ok(Some(paths))) => paths,
                _ => return,
            };
            let files = if folder {
                let dir = picked.into_iter().next();
                cx.background_executor()
                    .spawn(async move { dir.map(|d| files_in_folder(&d).unwrap_or_default()) })
                    .await
                    .unwrap_or_default()
            } else {
                picked
            };
            this.update_in(cx, |d, window, cx| d.add(files, window, cx))
                .ok();
        }));
    }
}

impl Render for DocumentsDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window, cx);
        let (p, s) = (theme.palette, theme.scale);
        let this = cx.entity();
        let i18n = &self.i18n;
        let t = |key: Key| -> SharedString { i18n.t(key).into() };
        let label = |text: SharedString| {
            div()
                .font_role(Role::Index)
                .type_px(s.caption, s.line_caption)
                .text_color(p.muted().solid())
                .child(text)
        };
        let section = |title: SharedString| {
            div()
                .flex()
                .flex_col()
                .gap(px(space::S2))
                .child(label(title))
        };
        let running = self.running;

        let choices: Vec<Choice> = self
            .levels
            .iter()
            .map(|opt| {
                let rgb = opt
                    .color
                    .as_deref()
                    .and_then(|c| c.strip_prefix('#'))
                    .and_then(|c| u32::from_str_radix(c, 16).ok())
                    .map(dr_ui::tokens::Rgb::hex);
                Choice::new(RowIcon::Mark(opt.mark, rgb), opt.path.clone())
            })
            .collect();
        let set_level = this.clone();
        let target = section(t(keys::v3_transfer::TARGET_TITLE)).child(
            Select::new("import-target", choices, self.level)
                .in_dialog()
                .max_menu_height(LIST_MAX_HEIGHT)
                .disabled(running || self.levels.is_empty())
                .on_change(move |i, _, cx| {
                    set_level.update(cx, |d, cx| {
                        if i < d.levels.len() {
                            d.level = i;
                            cx.notify();
                        }
                    })
                }),
        );

        let (files_btn, folder_btn, clear_btn) = (this.clone(), this.clone(), this.clone());
        let mut pickers = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(space::S3))
            .child(
                Button::new("import-files", t(k::CHOOSE_FILES))
                    .icon(Icon::FileText)
                    .small()
                    .disabled(running)
                    .on_click(move |_, window, cx| {
                        files_btn.update(cx, |d, cx| d.pick(false, window, cx))
                    }),
            )
            .child(
                Button::new("import-folder", t(k::CHOOSE_FOLDER))
                    .icon(Icon::Folder)
                    .small()
                    .disabled(running)
                    .on_click(move |_, window, cx| {
                        folder_btn.update(cx, |d, cx| d.pick(true, window, cx))
                    }),
            )
            .child(div().flex_1());
        if !self.items.is_empty() {
            pickers = pickers.child(
                Button::new("import-clear", t(k::CLEAR))
                    .text()
                    .small()
                    .disabled(running)
                    .on_click(move |_, _, cx| clear_btn.update(cx, |d, cx| d.clear(cx))),
            );
        }
        let mut list = div()
            .id("import-files-list")
            .max_h(px(LIST_MAX_HEIGHT))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(space::S2));
        for item in &self.items {
            let (status, color) = match &item.status {
                Status::Parsing => (t(k::status::PARSING), p.muted()),
                Status::Ready => (t(k::status::READY), p.ink(2)),
                Status::Committed => (t(k::status::COMMITTED), p.ink(1)),
                Status::Error(_) => (t(k::status::ERROR), p.danger),
            };
            let detail = match &item.status {
                Status::Error(e) => Some((e.clone(), p.danger)),
                _ if !item.warnings.is_empty() => Some((item.warnings.join(" "), p.muted())),
                _ => None,
            };
            list = list.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::S1))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(space::S3))
                            .child(
                                label(item.filename.clone().into())
                                    .flex_none()
                                    .w(px(150.0))
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis(),
                            )
                            .child(div().flex_1().min_w_0().child(item.title.clone()))
                            .child(label(status).flex_none().text_color(color.solid())),
                    )
                    .children(
                        detail.map(|(text, color)| label(text.into()).text_color(color.solid())),
                    ),
            );
        }
        let files = section(t(keys::v3_transfer::FILES_TITLE))
            .child(pickers)
            .children((!self.items.is_empty()).then_some(list));

        let body = div()
            .flex()
            .flex_col()
            .gap(px(space::S6))
            .child(target)
            .child(files);

        let status = if running {
            Some(t(k::IMPORTING))
        } else {
            self.summary.map(|(ok, failed)| {
                format!(
                    "{} · {} {ok} · {} {failed}",
                    i18n.t(k::summary::DONE),
                    i18n.t(k::summary::OK),
                    i18n.t(k::summary::FAILED)
                )
                .into()
            })
        };
        let (close, go, dismiss) = (this.clone(), this.clone(), this.clone());
        let mut dialog = Dialog::new("import-documents", t(k::TITLE))
            .width(WIDTH)
            .body(body)
            .action(
                Button::new("import-close", t(keys::common::CLOSE))
                    .disabled(running)
                    .on_click(move |_, _, cx| close.update(cx, |d, cx| d.close(cx))),
            )
            .action(
                Button::new(
                    "import-start",
                    i18n.fmt(k::START, &[("count", &self.ready())]),
                )
                .primary()
                .icon(Icon::CaseDew)
                .busy(running)
                .disabled(!self.can_start())
                .on_click(move |_, _, cx| go.update(cx, |d, cx| d.start(cx))),
            )
            .on_close(move |_, cx| dismiss.update(cx, |d, cx| d.close(cx)));
        if let Some(status) = status {
            dialog = dialog.status(
                div()
                    .font_role(Role::Ui)
                    .type_px(s.secondary, s.line_body)
                    .text_color(p.ink(2).solid())
                    .child(status),
            );
        }
        div().child(dialog)
    }
}
