//! 「导出成稿」: format, residence-tree scope with 「只导成书正文」, single
//! 「条目标题」 switch, and book info. Reading entries and laying the file out
//! happen off the main thread; the dialog only holds the choices.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::SystemTime;

use base64::Engine as _;
use dr_export::v3::{Outline, TreeNode};
use dr_export::{Cover, Format, Labels, Options};
use dr_i18n::{I18n, keys};
use dr_ui::components::{Button, Dialog, Loading, SandCell, Segmented, Switch};
use dr_ui::input::{FieldEvent, TextField};
use dr_ui::sand::{self, Icon};
use dr_ui::style::DrStyled;
use dr_ui::tokens::{Rgb, space};
use dr_ui::{Theme, fonts::Role};
use dr_workspace::Workspace;
use gpui::{
    AnyElement, AppContext as _, Context, Entity, ImageFormat, InteractiveElement, IntoElement,
    ParentElement, PathPromptOptions, SharedString, StatefulInteractiveElement, Styled, Task,
    Window, div, img, prelude::FluentBuilder as _, px,
};

use crate::ExportDialog;
use crate::prefs::{BookPrefs, Prefs};

use keys::manuscript_export as mx;

/// The dialog's width.
pub const WIDTH: f32 = 520.0;
/// The residence tree scrolls past this height (the prototype's 360).
const TREE_MAX_HEIGHT: f32 = 360.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Busy {
    Cover,
    Export,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Feedback {
    Saved,
    Failed(String),
    CoverFailed(String),
}

pub struct ManuscriptState {
    lib: Option<Workspace>,
    book: String,
    i18n: I18n,
    pub outline: Option<Outline>,
    pub load_failed: bool,
    pub format: Format,
    /// Active only when `outline.has_book` is true; defaults on when `has_book` is true.
    pub only_book_prose: bool,
    /// Manually ticked entry IDs in the residence tree.
    pub selected: BTreeSet<String>,
    /// Manually ticked rows of entries hung on another, `(host, member)`:
    /// only that place of the entry, not where it lives.
    pub selected_hung: BTreeSet<(String, String)>,
    /// Collapsed level IDs in the residence tree (all expanded on open).
    pub collapsed: BTreeSet<String>,
    /// Single 「条目标题」 switch (`kernel-v5` §3).
    pub entry_titles: bool,
    title: Entity<TextField>,
    author: Entity<TextField>,
    pub cover: Option<Cover>,
    thumb: Option<Arc<gpui::Image>>,
    pub busy: Option<Busy>,
    pub feedback: Option<Feedback>,
    task: Option<Task<()>>,
}

impl ManuscriptState {
    pub(crate) fn new(
        lib: Option<Workspace>,
        book: String,
        i18n: I18n,
        window: &mut Window,
        cx: &mut Context<ExportDialog>,
    ) -> ManuscriptState {
        let prefs = Prefs::get(cx);
        let mine = prefs.books.get(&book).cloned().unwrap_or_default();
        let title = cx.new(|cx| TextField::new("export-title", window, cx).small());
        let author = cx.new(|cx| {
            TextField::new("export-author", window, cx)
                .small()
                .with_text(prefs.author.clone())
        });
        for field in [&title, &author] {
            cx.subscribe(field, |_, _, _: &FieldEvent, cx| cx.notify())
                .detach();
        }
        let mut state = ManuscriptState {
            lib,
            book,
            i18n,
            outline: None,
            load_failed: false,
            format: mine.format,
            only_book_prose: false,
            selected: BTreeSet::new(),
            selected_hung: BTreeSet::new(),
            collapsed: BTreeSet::new(),
            entry_titles: mine.entry_titles,
            title,
            author,
            cover: None,
            thumb: None,
            busy: None,
            feedback: None,
            task: None,
        };
        state.load(cx);
        state
    }

    /// Reads the project's book sequence and residence tree (again, after a failure).
    pub fn load(&mut self, cx: &mut Context<ExportDialog>) {
        let Some(lib) = self.lib.clone() else {
            self.load_failed = true;
            return;
        };
        self.load_failed = false;
        let book = self.book.clone();
        self.task = Some(cx.spawn(async move |this, cx| {
            let read = cx
                .background_executor()
                .spawn(async move { dr_export::v3::outline(&lib, &book) })
                .await;
            this.update(cx, |d, cx| {
                let titled = Prefs::get(cx);
                if let Some(m) = d.manuscript_mut() {
                    m.loaded(read, &titled, cx);
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn loaded(
        &mut self,
        read: dr_export::Result<Outline>,
        prefs: &Prefs,
        cx: &mut Context<ExportDialog>,
    ) {
        match read {
            Ok(outline) => {
                let title = prefs
                    .books
                    .get(&self.book)
                    .and_then(|b| b.title.clone())
                    .unwrap_or_else(|| outline.title.clone());
                self.title.update(cx, |f, cx| {
                    if f.text().is_empty() {
                        f.set_text(title, cx)
                    }
                });
                if outline.has_book {
                    self.only_book_prose = true;
                    self.selected.clear();
                    self.selected_hung.clear();
                } else {
                    self.only_book_prose = false;
                    self.selected = outline.tree_ids().into_iter().collect();
                    self.selected_hung = outline.hung_rows().into_iter().collect();
                }
                self.collapsed.clear();
                self.outline = Some(outline);
            }
            Err(error) => {
                log::warn!("export: reading the project outline: {error}");
                self.load_failed = true;
            }
        }
    }

    pub fn is_busy(&self) -> bool {
        self.busy.is_some()
    }

    /// Sets 「只导成书正文」 (ignored when the project has `成书` disabled).
    pub fn set_only_book_prose(&mut self, on: bool) {
        let has_book = self.outline.as_ref().is_some_and(|o| o.has_book);
        self.only_book_prose = on && has_book;
    }

    /// Whether `node`, everything living under it and every entry hung on
    /// it or on what lives under it are ticked.
    pub fn is_full(&self, node: &TreeNode) -> bool {
        self.selected.contains(&node.id)
            && node.children.iter().all(|c| self.is_full(c))
            && node.hung.iter().all(|h| self.is_hung(&node.id, &h.id))
    }

    /// Whether `node`, anything living under it or anything hung on it
    /// (or below) is ticked.
    pub fn is_some(&self, node: &TreeNode) -> bool {
        self.selected.contains(&node.id)
            || node.children.iter().any(|c| self.is_some(c))
            || node.hung.iter().any(|h| self.is_hung(&node.id, &h.id))
    }

    /// Looks up `id` in the loaded residence tree.
    pub fn node(&self, id: &str) -> Option<&TreeNode> {
        fn find<'a>(nodes: &'a [TreeNode], id: &str) -> Option<&'a TreeNode> {
            for node in nodes {
                if node.id == id {
                    return Some(node);
                }
                if let Some(hit) = find(&node.children, id) {
                    return Some(hit);
                }
            }
            None
        }
        find(&self.outline.as_ref()?.tree, id)
    }

    /// Whether the row of `member` hung on `host` is ticked.
    pub fn is_hung(&self, host: &str, member: &str) -> bool {
        self.selected_hung
            .contains(&(host.to_owned(), member.to_owned()))
    }

    /// Toggles `id` in the residence tree: clicking a level ticks itself,
    /// all its descendants and every entry hung on them; clicking a fully
    /// ticked level unticks all of it; clicking a single entry toggles that
    /// entry (and what is hung on it).
    pub fn toggle_tree_entry(&mut self, id: &str) {
        if self.only_book_prose {
            return;
        }
        let Some(node) = self.node(id) else {
            return;
        };
        let was_full = self.is_full(node);
        let mut ids = Vec::new();
        let mut hung = Vec::new();
        collect_subtree(node, &mut ids, &mut hung);
        if was_full {
            for item in ids {
                self.selected.remove(&item);
            }
            for pick in hung {
                self.selected_hung.remove(&pick);
            }
        } else {
            self.selected.extend(ids);
            self.selected_hung.extend(hung);
        }
    }

    /// Toggles the row of `member` hung on `host`: only this place of it,
    /// not where it lives.
    pub fn toggle_hung(&mut self, host: &str, member: &str) {
        if self.only_book_prose {
            return;
        }
        let pick = (host.to_owned(), member.to_owned());
        if !self.selected_hung.remove(&pick) {
            self.selected_hung.insert(pick);
        }
    }

    /// Expands or collapses a tree node's child rows without changing ticks.
    pub fn toggle_collapse(&mut self, id: &str) {
        if !self.collapsed.remove(id) {
            self.collapsed.insert(id.to_owned());
        }
    }

    /// Selects or clears the entire residence tree (when manual tree selection is active).
    pub fn select_all(&mut self, on: bool) {
        if self.only_book_prose {
            return;
        }
        self.selected = match (&self.outline, on) {
            (Some(o), true) => o.tree_ids().into_iter().collect(),
            _ => BTreeSet::new(),
        };
        self.selected_hung = match (&self.outline, on) {
            (Some(o), true) => o.hung_rows().into_iter().collect(),
            _ => BTreeSet::new(),
        };
    }

    /// The entries the export takes, in export order:
    /// book-sequence order when `only_book_prose` is on, or residence-tree
    /// preorder when manual tree selection is active.
    pub fn chapters(&self) -> Vec<String> {
        let Some(o) = &self.outline else {
            return Vec::new();
        };
        if self.only_book_prose {
            o.entries.iter().map(|e| e.id.clone()).collect()
        } else {
            o.tree_ids()
                .into_iter()
                .filter(|id| self.selected.contains(id))
                .collect()
        }
    }

    /// The ticked rows of entries hung on another, in tree order (with
    /// 「只导成书正文」 on: none).
    pub fn hung(&self) -> Vec<(String, String)> {
        match &self.outline {
            Some(o) if !self.only_book_prose => o
                .hung_rows()
                .into_iter()
                .filter(|row| self.selected_hung.contains(row))
                .collect(),
            _ => Vec::new(),
        }
    }

    /// With 「成书」 on and 「只导成书正文」 on, the book has no text to export.
    pub fn book_is_empty(&self) -> bool {
        self.only_book_prose && self.outline.as_ref().is_some_and(|o| o.entries.is_empty())
    }

    pub fn title(&self, cx: &gpui::App) -> String {
        self.title.read(cx).text()
    }

    pub fn set_title(&mut self, text: &str, cx: &mut Context<ExportDialog>) {
        self.title
            .update(cx, |f, cx| f.set_text(text.to_owned(), cx));
    }

    pub fn can_export(&self, cx: &gpui::App) -> bool {
        self.outline.is_some()
            && !(self.chapters().is_empty() && self.hung().is_empty())
            && !self.title(cx).trim().is_empty()
            && !self.is_busy()
    }

    /// What the export writes: `chapters: None` for 「只导成书正文」 (book-prose
    /// mode), or `chapters: Some(ids)` for manual tree selection (all-content
    /// mode with residence-tree hierarchy).
    pub fn options(&self, cx: &gpui::App) -> (Options, Labels) {
        (
            Options {
                chapters: (!self.only_book_prose).then(|| self.chapters()),
                hung: self.hung(),
                act_titles: false,
                chapter_titles: self.entry_titles,
                title: self.title(cx).trim().to_owned(),
                author: self.author.read(cx).text().trim().to_owned(),
                cover: self.cover.clone(),
            },
            Labels {
                untitled_chapter: self.i18n.t(keys::k4_book::UNTITLED_ENTRY).to_owned(),
                untitled_act: self.i18n.t(mx::UNTITLED_ACT).to_owned(),
                options: option_labels(&self.i18n),
            },
        )
    }

    fn remember(&self, cx: &mut gpui::App) {
        let mut prefs = Prefs::get(cx);
        let title = self.title(cx).trim().to_owned();
        let named = self.outline.as_ref().map(|o| o.title.clone());
        prefs.author = self.author.read(cx).text().trim().to_owned();
        prefs.books.insert(
            self.book.clone(),
            BookPrefs {
                format: self.format,
                entry_titles: self.entry_titles,
                title: (!title.is_empty() && Some(&title) != named.as_ref()).then_some(title),
            },
        );
        Prefs::set(prefs, cx);
    }

    /// Asks where to save, then reads, lays out and writes the file.
    pub fn export(&mut self, cx: &mut Context<ExportDialog>) {
        if !self.can_export(cx) {
            return;
        }
        let Some(lib) = self.lib.clone() else {
            return;
        };
        self.remember(cx);
        let (options, labels) = self.options(cx);
        let format = self.format;
        let filename = dr_export::manuscript_filename(&options.title, format);
        let path = cx.prompt_for_new_path(&crate::start_dir(), Some(&filename));
        let (book, locale) = (self.book.clone(), self.i18n.locale().code().to_owned());
        self.busy = Some(Busy::Export);
        self.feedback = None;
        self.task = Some(cx.spawn(async move |this, cx| {
            let path = match path.await {
                Ok(Ok(Some(path))) => Some(Ok(path)),
                Ok(Err(error)) => Some(Err(error.to_string())),
                _ => None,
            };
            let result = match path {
                None => None,
                Some(Err(error)) => Some(Err(error)),
                Some(Ok(path)) => Some(
                    cx.background_executor()
                        .spawn(async move {
                            write(&lib, &book, &options, &labels, &locale, format, &path)
                        })
                        .await,
                ),
            };
            this.update(cx, |d, cx| {
                if let Some(m) = d.manuscript_mut() {
                    m.busy = None;
                    m.feedback = match result {
                        None => None,
                        Some(Ok(())) => Some(Feedback::Saved),
                        Some(Err(error)) => {
                            log::warn!("export: {error}");
                            Some(Feedback::Failed(error))
                        }
                    };
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// Picks an image for the cover (bounded and re-encoded off the main
    /// thread).
    pub fn pick_cover(&mut self, cx: &mut Context<ExportDialog>) {
        if self.is_busy() {
            return;
        }
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: None,
        });
        self.busy = Some(Busy::Cover);
        self.feedback = None;
        self.task = Some(cx.spawn(async move |this, cx| {
            let path = match paths.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                _ => None,
            };
            let read = match path {
                Some(path) => Some(
                    cx.background_executor()
                        .spawn(async move { dr_export::cover_from_path(&path) })
                        .await,
                ),
                None => None,
            };
            this.update(cx, |d, cx| {
                if let Some(m) = d.manuscript_mut() {
                    m.busy = None;
                    match read {
                        Some(Ok(cover)) => m.set_cover(Some(cover)),
                        Some(Err(error)) => m.feedback = Some(Feedback::CoverFailed(error)),
                        None => {}
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn set_cover(&mut self, cover: Option<Cover>) {
        self.thumb = cover.as_ref().and_then(thumbnail);
        self.cover = cover;
    }
}

/// `node`, what lives under it and the rows hung on any of them.
fn collect_subtree(node: &TreeNode, ids: &mut Vec<String>, hung: &mut Vec<(String, String)>) {
    ids.push(node.id.clone());
    for child in &node.children {
        collect_subtree(child, ids, hung);
    }
    hung.extend(node.hung.iter().map(|h| (node.id.clone(), h.id.clone())));
}

/// The built-in option values of the field editor's choices
/// (`dr_view_elements::fields::v3::option_label`), as the export prints them.
fn option_labels(i18n: &I18n) -> std::collections::BTreeMap<String, String> {
    use keys::editor_top_bar::status as st;
    [
        ("draft", st::DRAFT),
        ("finished", st::FINISHED),
        ("discarded", st::DISCARDED),
        ("drifting", st::DRIFTING),
        ("resting", st::RESTING),
    ]
    .into_iter()
    .map(|(value, key)| (value.to_owned(), i18n.t(key).to_owned()))
    .collect()
}

/// Reads, lays out and writes the manuscript (off the main thread).
fn write(
    lib: &Workspace,
    book: &str,
    options: &Options,
    labels: &Labels,
    locale: &str,
    format: Format,
    path: &std::path::Path,
) -> Result<(), String> {
    let manuscript =
        dr_export::read_manuscript(lib, book, options, labels, locale, None, SystemTime::now())
            .map_err(|e| e.to_string())?;
    let bytes = dr_export::render(&manuscript, format)?;
    dr_export::write_file(path, &bytes).map_err(|e| e.to_string())
}

fn thumbnail(cover: &Cover) -> Option<Arc<gpui::Image>> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cover.data.as_bytes())
        .ok()?;
    let format = if cover.media_type == "image/png" {
        ImageFormat::Png
    } else {
        ImageFormat::Jpeg
    };
    Some(Arc::new(gpui::Image::from_bytes(format, bytes)))
}

/// The round seal of an entry's id, as the shell picks it.
fn seal_of(id: &str) -> u8 {
    let mut hash: i32 = 0;
    for unit in id.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    ((hash as i64).abs() % 6) as u8
}

fn color_of(hex: &str) -> Option<Rgb> {
    let digits = hex.trim().strip_prefix('#')?;
    if digits.len() != 6 {
        return None;
    }
    u32::from_str_radix(digits, 16).ok().map(Rgb::hex)
}

fn is_glyph_mark(mark: &str) -> bool {
    if mark.is_empty() || mark.len() > 32 || mark.chars().any(char::is_control) {
        return false;
    }
    let ascii_name = mark
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    !ascii_name || mark.len() == 1
}

fn entry_mark(mark: Option<&str>, id: &str) -> sand::Kind {
    match mark {
        Some("book") => sand::Kind::All,
        Some("file-text") => sand::Kind::Chapter(seal_of(id)),
        Some("lightbulb" | "sparkles") => sand::Kind::Drift { loose: false },
        Some("folder" | "tag") => sand::Kind::Category,
        Some("compass" | "route") => sand::Kind::Storyline,
        Some("git-branch") => sand::Kind::DriftGroup,
        Some(text) if is_glyph_mark(text) => sand::Kind::Glyph(sand::Glyph::new(text)),
        _ => sand::Kind::Element,
    }
}

/// A row of the scope tree: an entry where it lives, or an entry hung on
/// `host` (listed after the ones living there, as the left sidebar's tree
/// lists them, kernel-v5 §16 「层级的列表」).
enum VisibleRow<'a> {
    Node {
        node: &'a TreeNode,
        depth: usize,
        full: bool,
        some: bool,
    },
    Hung {
        host: &'a str,
        node: &'a TreeNode,
        depth: usize,
        on: bool,
    },
}

fn flatten_visible<'a>(
    nodes: &'a [TreeNode],
    depth: usize,
    state: &ManuscriptState,
    out: &mut Vec<VisibleRow<'a>>,
) {
    for node in nodes {
        out.push(VisibleRow::Node {
            node,
            depth,
            full: state.is_full(node),
            some: state.is_some(node),
        });
        if state.collapsed.contains(&node.id) {
            continue;
        }
        flatten_visible(&node.children, depth + 1, state, out);
        for member in &node.hung {
            out.push(VisibleRow::Hung {
                host: &node.id,
                node: member,
                depth: depth + 1,
                on: state.is_hung(&node.id, &member.id),
            });
        }
    }
}

/// The dotted rule in the indent of a hung row, as structure's 「挂在上面」
/// (not told apart by colour): a grain every 3 px down the row.
fn hung_rule(color: Rgb) -> impl IntoElement {
    let color = color.solid();
    gpui::canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let h = f32::from(bounds.size.height);
            let mut y = 0.0;
            while y < h {
                window.paint_quad(gpui::fill(
                    gpui::Bounds {
                        origin: bounds.origin + gpui::point(px(0.0), px(y)),
                        size: gpui::size(px(1.5), px(1.5)),
                    },
                    color,
                ));
                y += 3.0;
            }
        },
    )
    .w(px(1.5))
    .h_full()
}

/// A section of the dialog: its label in index type, then its controls.
fn section(theme: &Theme, label: SharedString) -> gpui::Div {
    let s = theme.scale;
    div().flex().flex_col().gap(px(space::S2)).child(
        div()
            .font_role(Role::Index)
            .type_px(s.caption, s.line_caption)
            .text_color(theme.palette.muted().solid())
            .child(label),
    )
}

/// A label and a control on one line.
fn line(theme: &Theme, label: SharedString, control: impl IntoElement) -> gpui::Div {
    let s = theme.scale;
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(space::S5))
        .child(
            div()
                .flex_none()
                .w(px(64.0))
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(theme.palette.ink(2).solid())
                .child(label),
        )
        .child(div().flex_1().min_w_0().child(control))
}

pub(crate) fn render(
    dialog: &mut ExportDialog,
    window: &mut Window,
    cx: &mut Context<ExportDialog>,
) -> AnyElement {
    let theme = Theme::of(window, cx);
    let (p, s) = (theme.palette, theme.scale);
    let this = cx.entity();
    let Some(m) = dialog.manuscript() else {
        return div().into_any_element();
    };
    let i18n = &m.i18n;
    let t = |key| -> SharedString { i18n.t(key).into() };
    let running = m.is_busy();
    let on = |f: fn(&mut ManuscriptState, &mut Context<ExportDialog>)| {
        let this = this.clone();
        move |cx: &mut gpui::App| {
            this.update(cx, |d, cx| {
                if let Some(m) = d.manuscript_mut()
                    && !m.is_busy()
                {
                    f(m, cx);
                }
                cx.notify();
            })
        }
    };

    let body: AnyElement = match &m.outline {
        None if m.load_failed => {
            let retry = on(|m, cx| m.load(cx));
            div()
                .flex()
                .flex_col()
                .items_start()
                .gap(px(space::S3))
                .child(
                    div()
                        .font_role(Role::Ui)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.ink(2).solid())
                        .child(t(mx::LOAD_FAILED)),
                )
                .child(
                    Button::new("export-retry", t(mx::RETRY))
                        .icon(Icon::Rotate)
                        .on_click(move |_, _, cx| retry(cx)),
                )
                .into_any_element()
        }
        None => Loading::new("export-loading")
            .label(t(mx::LOADING))
            .into_any_element(),
        Some(outline) => {
            let format_index = Format::ALL.iter().position(|f| *f == m.format).unwrap_or(0);
            let set_format = this.clone();
            let format = section(&theme, t(mx::FORMAT)).child(
                Segmented::new(
                    "export-format",
                    Format::ALL.iter().map(|f| f.label()),
                    format_index,
                )
                .disabled(running)
                .on_change(move |i, _, cx| {
                    set_format.update(cx, |d, cx| {
                        if let Some(m) = d.manuscript_mut() {
                            m.format = Format::ALL[i.min(Format::ALL.len() - 1)];
                        }
                        cx.notify();
                    })
                }),
            );

            let mut scope = section(&theme, t(mx::SCOPE));
            if outline.has_book {
                let flip_only = this.clone();
                let only_label = t(keys::k4_book::ONLY_BOOK_PROSE);
                let only_on = m.only_book_prose;
                scope = scope.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .py(px(space::S1))
                        .font_role(Role::Ui)
                        .type_px(s.secondary, s.line_body)
                        .text_color(p.ink(1).solid())
                        .child(only_label.clone())
                        .child(
                            div()
                                .id("export-only-book-prose-toggle")
                                .role(gpui::Role::CheckBox)
                                .aria_label(only_label)
                                .aria_toggled(if only_on {
                                    gpui::Toggled::True
                                } else {
                                    gpui::Toggled::False
                                })
                                .child(
                                    Switch::new("export-only-book-prose", only_on)
                                        .disabled(running)
                                        .on_change(move |on, _, cx| {
                                            flip_only.update(cx, |d, cx| {
                                                if let Some(m) = d.manuscript_mut() {
                                                    m.set_only_book_prose(on);
                                                }
                                                cx.notify();
                                            })
                                        }),
                                ),
                        ),
                );
                if m.book_is_empty() {
                    scope = scope.child(
                        div()
                            .id("export-book-empty")
                            .debug_selector(|| "export-book-empty".into())
                            .role(gpui::Role::Label)
                            .aria_label(t(keys::k4_book::BOOK_PROSE_EMPTY))
                            .font_role(Role::Ui)
                            .type_px(s.secondary, s.line_body)
                            .text_color(p.ink(3).solid())
                            .child(t(keys::k4_book::BOOK_PROSE_EMPTY)),
                    );
                }
            }

            let tree_disabled = running || m.only_book_prose;
            let mut rows = Vec::new();
            flatten_visible(&outline.tree, 0, m, &mut rows);
            let mut tree = div()
                .id("export-tree")
                .role(gpui::Role::Group)
                .aria_label(t(mx::SCOPE))
                .max_h(px(TREE_MAX_HEIGHT))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .when(m.only_book_prose, |el| el.opacity(0.45));
            for row in rows {
                tree = tree.child(match row {
                    VisibleRow::Node {
                        node,
                        depth,
                        full,
                        some,
                    } => node_row(
                        &this,
                        m,
                        i18n,
                        p,
                        node,
                        depth,
                        if full {
                            gpui::Toggled::True
                        } else if some {
                            gpui::Toggled::Mixed
                        } else {
                            gpui::Toggled::False
                        },
                        tree_disabled,
                    ),
                    VisibleRow::Hung {
                        host,
                        node,
                        depth,
                        on,
                    } => hung_row(&this, i18n, p, host, node, depth, on, tree_disabled),
                });
            }
            scope = scope.child(tree);

            let flip_titles = this.clone();
            let titles_label = t(keys::k4_book::ENTRY_TITLES);
            let titles_on = m.entry_titles;
            let contents = section(&theme, t(mx::CONTENTS))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .child(titles_label.clone())
                        .child(
                            div()
                                .id("export-entry-titles-toggle")
                                .role(gpui::Role::CheckBox)
                                .aria_label(titles_label)
                                .aria_toggled(if titles_on {
                                    gpui::Toggled::True
                                } else {
                                    gpui::Toggled::False
                                })
                                .child(
                                    Switch::new("export-entry-titles", titles_on)
                                        .disabled(running)
                                        .on_change(move |on, _, cx| {
                                            flip_titles.update(cx, |d, cx| {
                                                if let Some(m) = d.manuscript_mut() {
                                                    m.entry_titles = on;
                                                }
                                                cx.notify();
                                            })
                                        }),
                                ),
                        ),
                )
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(p.ink(1).solid());

            let pick = on(|m, cx| m.pick_cover(cx));
            let remove = on(|m, _| m.set_cover(None));
            let mut cover = div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(space::S3))
                .children(m.thumb.clone().map(|image| {
                    img(image)
                        .h(px(48.0))
                        .max_w(px(48.0))
                        .rounded(px(2.0))
                        .into_any_element()
                }))
                .child(
                    Button::new(
                        "export-cover",
                        t(if m.cover.is_some() {
                            mx::CHANGE_COVER
                        } else {
                            mx::CHOOSE_COVER
                        }),
                    )
                    .icon(Icon::Image)
                    .small()
                    .busy(m.busy == Some(Busy::Cover))
                    .disabled(running)
                    .on_click(move |_, _, cx| pick(cx)),
                );
            if m.cover.is_some() {
                cover = cover.child(
                    Button::new("export-cover-remove", t(mx::REMOVE_COVER))
                        .text()
                        .small()
                        .disabled(running)
                        .on_click(move |_, _, cx| remove(cx)),
                );
            }
            let info = section(&theme, t(mx::BOOK_INFO))
                .child(line(&theme, t(mx::BOOK_TITLE), m.title.clone()))
                .child(line(&theme, t(mx::AUTHOR), m.author.clone()))
                .child(line(&theme, t(mx::COVER), cover));

            div()
                .flex()
                .flex_col()
                .gap(px(space::S6))
                .child(format)
                .child(scope)
                .child(contents)
                .child(info)
                .into_any_element()
        }
    };

    let status = match (&m.busy, &m.feedback) {
        (Some(Busy::Export), _) => Some((t(mx::EXPORTING), p.ink(2))),
        (_, Some(Feedback::Saved)) => Some((t(mx::SAVED), p.ink(2))),
        (_, Some(Feedback::Failed(_))) => Some((t(mx::FAILED), p.danger)),
        (_, Some(Feedback::CoverFailed(_))) => Some((t(mx::COVER_FAILED), p.danger)),
        _ => None,
    };
    let close = this.clone();
    let go = on(|m, cx| m.export(cx));
    let dismiss = this.clone();
    let mut d = Dialog::new("manuscript-export", t(mx::TITLE))
        .width(WIDTH)
        .body(body)
        .action(
            Button::new("export-close", t(keys::common::CANCEL))
                .disabled(running)
                .on_click(move |_, _, cx| close.update(cx, |d, cx| d.close(cx))),
        )
        .action(
            Button::new(
                "export-go",
                i18n.fmt(mx::EXPORT, &[("format", &m.format.label())]),
            )
            .primary()
            .icon(Icon::CaseRise)
            .busy(m.busy == Some(Busy::Export))
            .disabled(!m.can_export(cx))
            .on_click(move |_, _, cx| go(cx)),
        )
        .on_close(move |_, cx| dismiss.update(cx, |d, cx| d.close(cx)));
    if let Some((text, color)) = status {
        d = d.status(
            div()
                .font_role(Role::Ui)
                .type_px(s.secondary, s.line_body)
                .text_color(color.solid())
                .child(text),
        );
    }
    d.into_any_element()
}

/// What an entry's row is called: its title, or 「未命名条目」.
fn row_label(node: &TreeNode, i18n: &I18n) -> String {
    if node.title.trim().is_empty() {
        i18n.t(keys::k4_book::UNTITLED_ENTRY).to_owned()
    } else {
        node.title.clone()
    }
}

/// The tick at a row's end: a check when all of it is ticked, a short bar
/// when part of it is. It is the row's checkbox for assistive technology.
fn tick(
    id: String,
    label: String,
    state: gpui::Toggled,
    p: &dr_ui::tokens::Palette,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(gpui::ElementId::Name(id.into()))
        .role(gpui::Role::CheckBox)
        .aria_label(SharedString::from(label))
        .aria_toggled(state)
        .flex_none()
        .size(px(14.0))
        .flex()
        .items_center()
        .justify_center()
        .when(state == gpui::Toggled::True, |el| {
            el.child(sand::icon(Icon::Check, 14.0, p.ink(1).solid()))
        })
        .when(state == gpui::Toggled::Mixed, |el| {
            el.child(
                div()
                    .w(px(9.0))
                    .h(px(2.0))
                    .rounded(px(1.0))
                    .bg(p.ink(1).solid()),
            )
        })
}

/// An entry where it lives: the arrow that folds what is below it, its
/// mark and title, and its tick.
#[allow(clippy::too_many_arguments)]
fn node_row(
    this: &Entity<ExportDialog>,
    m: &ManuscriptState,
    i18n: &I18n,
    p: &dr_ui::tokens::Palette,
    node: &TreeNode,
    depth: usize,
    state: gpui::Toggled,
    tree_disabled: bool,
) -> AnyElement {
    let has_below = !node.children.is_empty() || !node.hung.is_empty();
    let is_collapsed = m.collapsed.contains(&node.id);
    let label = row_label(node, i18n);
    let disc: AnyElement = if has_below {
        let (fold, id) = (this.clone(), node.id.clone());
        let chevron = if is_collapsed {
            Icon::ChevronRight
        } else {
            Icon::ChevronDown
        };
        div()
            .id(gpui::ElementId::Name(
                format!("export-fold-{}", node.id).into(),
            ))
            .role(gpui::Role::Button)
            .aria_expanded(!is_collapsed)
            .aria_label(SharedString::from(i18n.fmt(
                if is_collapsed {
                    keys::v3_levels::EXPAND
                } else {
                    keys::v3_levels::COLLAPSE
                },
                &[("name", &label)],
            )))
            .flex_none()
            .size(px(16.0))
            .flex()
            .items_center()
            .justify_center()
            .when(!tree_disabled, |el| {
                el.cursor_pointer().on_click(move |_, _, cx| {
                    fold.update(cx, |d, cx| {
                        if let Some(m) = d.manuscript_mut()
                            && !m.is_busy()
                            && !m.only_book_prose
                        {
                            m.toggle_collapse(&id);
                        }
                        cx.notify();
                    })
                })
            })
            .child(sand::icon(chevron, 11.0, p.muted().solid()))
            .into_any_element()
    } else {
        div().flex_none().size(px(16.0)).into_any_element()
    };
    let (toggle, id) = (this.clone(), node.id.clone());
    let cell = SandCell::new(
        gpui::ElementId::Name(format!("export-entry-{}", node.id).into()),
        label.clone(),
    )
    .mark(entry_mark(node.mark.as_deref(), &node.id))
    .color_opt(node.color.as_deref().and_then(color_of))
    .disabled(tree_disabled)
    .child(tick(format!("export-tick-{}", node.id), label, state, p))
    .on_click(move |_, _, cx| {
        toggle.update(cx, |d, cx| {
            if let Some(m) = d.manuscript_mut() {
                m.toggle_tree_entry(&id);
            }
            cx.notify();
        })
    });
    let selector = format!("export-row-{}", node.id);
    div()
        .debug_selector(move || selector)
        .pl(px(depth as f32 * 16.0))
        .flex()
        .flex_row()
        .items_center()
        .child(disc)
        .child(div().flex_1().min_w_0().child(cell))
        .into_any_element()
}

/// An entry hung on `host`, listed after what lives under it: a dotted rule
/// in its indent (as the left sidebar's tree draws it, not told apart by
/// colour), no arrow, its own tick for this place of it.
#[allow(clippy::too_many_arguments)]
fn hung_row(
    this: &Entity<ExportDialog>,
    i18n: &I18n,
    p: &dr_ui::tokens::Palette,
    host: &str,
    node: &TreeNode,
    depth: usize,
    on: bool,
    tree_disabled: bool,
) -> AnyElement {
    let label = row_label(node, i18n);
    let (toggle, host_id, member) = (this.clone(), host.to_owned(), node.id.clone());
    let cell = SandCell::new(
        gpui::ElementId::Name(format!("export-hung-{host}-{}", node.id).into()),
        label.clone(),
    )
    .mark(entry_mark(node.mark.as_deref(), &node.id))
    .color_opt(node.color.as_deref().and_then(color_of))
    .disabled(tree_disabled)
    .child(tick(
        format!("export-hung-tick-{host}-{}", node.id),
        label,
        if on {
            gpui::Toggled::True
        } else {
            gpui::Toggled::False
        },
        p,
    ))
    .on_click(move |_, _, cx| {
        toggle.update(cx, |d, cx| {
            if let Some(m) = d.manuscript_mut() {
                m.toggle_hung(&host_id, &member);
            }
            cx.notify();
        })
    });
    let selector = format!("export-hung-row-{host}-{}", node.id);
    let rule = format!("export-hung-rule-{host}-{}", node.id);
    div()
        .debug_selector(move || selector)
        .relative()
        .pl(px(depth as f32 * 16.0))
        .flex()
        .flex_row()
        .items_center()
        .child(
            div()
                .debug_selector(move || rule)
                .absolute()
                .left(px((depth as f32 * 16.0 - 4.0).max(0.0)))
                .top(px(3.0))
                .bottom(px(3.0))
                .child(hung_rule(p.ink(4))),
        )
        .child(div().flex_none().size(px(16.0)))
        .child(div().flex_1().min_w_0().child(cell))
        .into_any_element()
}
