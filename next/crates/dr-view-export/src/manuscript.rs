//! 「导出成稿」: the 0.1 client's `ManuscriptExportDialog`, section by
//! section. Reading the chapters and laying the file out happen off the
//! main thread; the dialog only holds the choices.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::SystemTime;

use base64::Engine as _;
use dr_export::{Cover, Format, Labels, Options, Outline};
use dr_i18n::{I18n, keys};
use dr_ui::components::{Button, Dialog, Loading, SandCell, Segmented, Switch};
use dr_ui::input::{FieldEvent, TextField};
use dr_ui::sand::{self, Icon};
use dr_ui::style::DrStyled;
use dr_ui::tokens::space;
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

/// The dialog's width (the 0.1 card's).
pub const WIDTH: f32 = 520.0;
/// The chapter list scrolls past this.
const CHAPTERS_MAX_HEIGHT: f32 = 240.0;

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
    /// Opened from this chapter: 「选中章节」 starts with it alone.
    from_chapter: Option<String>,
    pub outline: Option<Outline>,
    pub load_failed: bool,
    pub format: Format,
    pub whole_book: bool,
    pub selected: BTreeSet<String>,
    pub act_titles: bool,
    pub chapter_titles: bool,
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
        chapter: Option<String>,
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
            whole_book: chapter.is_none(),
            selected: chapter.iter().cloned().collect(),
            from_chapter: chapter,
            outline: None,
            load_failed: false,
            format: mine.format,
            act_titles: mine.act_titles,
            chapter_titles: mine.chapter_titles,
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

    /// Reads the acts and chapters (again, after a failure).
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
                .spawn(async move { dr_export::outline(&lib, &book) })
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
                if self.from_chapter.is_none() {
                    self.selected = dr_export::default_chapters(&outline).into_iter().collect();
                }
                self.outline = Some(outline);
            }
            Err(error) => {
                log::warn!("export: reading the chapters: {error}");
                self.load_failed = true;
            }
        }
    }

    pub fn is_busy(&self) -> bool {
        self.busy.is_some()
    }

    /// The chapters the export takes, in book order.
    pub fn chapters(&self) -> Vec<String> {
        let Some(o) = &self.outline else {
            return Vec::new();
        };
        if self.whole_book {
            dr_export::default_chapters(o)
        } else {
            o.chapters
                .iter()
                .filter(|c| self.selected.contains(&c.id))
                .map(|c| c.id.clone())
                .collect()
        }
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
            && !self.chapters().is_empty()
            && !self.title(cx).trim().is_empty()
            && !self.is_busy()
    }

    pub fn toggle(&mut self, id: &str) {
        if !self.selected.remove(id) {
            self.selected.insert(id.to_owned());
        }
    }

    pub fn all_selected(&self) -> bool {
        self.outline
            .as_ref()
            .is_some_and(|o| o.chapters.iter().all(|c| self.selected.contains(&c.id)))
    }

    pub fn select_all(&mut self, on: bool) {
        self.selected = match (&self.outline, on) {
            (Some(o), true) => o.chapters.iter().map(|c| c.id.clone()).collect(),
            _ => BTreeSet::new(),
        };
    }

    /// What the export would write: the manuscript's options and labels.
    pub fn options(&self, cx: &gpui::App) -> (Options, Labels) {
        let has_acts = self.outline.as_ref().is_some_and(Outline::has_acts);
        (
            Options {
                chapters: (!self.whole_book).then(|| self.chapters()),
                act_titles: has_acts && self.act_titles,
                chapter_titles: self.chapter_titles,
                title: self.title(cx).trim().to_owned(),
                author: self.author.read(cx).text().trim().to_owned(),
                cover: self.cover.clone(),
            },
            Labels {
                untitled_chapter: self.i18n.t(mx::UNTITLED_CHAPTER).to_owned(),
                untitled_act: self.i18n.t(mx::UNTITLED_ACT).to_owned(),
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
                act_titles: self.act_titles,
                chapter_titles: self.chapter_titles,
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

/// The round seal of a chapter's id, as the shell picks it.
fn seal_of(id: &str) -> u8 {
    let mut hash: i32 = 0;
    for unit in id.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    ((hash as i64).abs() % 6) as u8
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
    // Runs `f` on the state unless a file is being written.
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

            let set_scope = this.clone();
            let mut scope = section(&theme, t(mx::SCOPE)).child(
                Segmented::new(
                    "export-scope",
                    [t(mx::WHOLE_BOOK), t(mx::SELECTED_CHAPTERS)],
                    usize::from(!m.whole_book),
                )
                .disabled(running)
                .on_change(move |i, _, cx| {
                    set_scope.update(cx, |d, cx| {
                        if let Some(m) = d.manuscript_mut() {
                            m.whole_book = i == 0;
                        }
                        cx.notify();
                    })
                }),
            );
            if !m.whole_book {
                let all = m.all_selected();
                let flip = this.clone();
                let head = div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .font_role(Role::Index)
                            .type_px(s.caption, s.line_caption)
                            .text_color(p.muted().solid())
                            .child(i18n.plural(mx::CHAPTER_COUNT, m.chapters().len() as u64, &[])),
                    )
                    .child(
                        Button::new(
                            "export-select-all",
                            t(if all { mx::SELECT_NONE } else { mx::SELECT_ALL }),
                        )
                        .text()
                        .small()
                        .disabled(running)
                        .on_click(move |_, _, cx| {
                            flip.update(cx, |d, cx| {
                                if let Some(m) = d.manuscript_mut() {
                                    m.select_all(!all);
                                }
                                cx.notify();
                            })
                        }),
                    );
                let mut list = div()
                    .id("export-chapters")
                    .max_h(px(CHAPTERS_MAX_HEIGHT))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col();
                let mut act: Option<&str> = None;
                for c in &outline.chapters {
                    if c.act.as_deref() != act {
                        act = c.act.as_deref();
                        if let Some(a) = act {
                            let name = outline
                                .act_name(a)
                                .filter(|n| !n.trim().is_empty())
                                .map(str::to_owned)
                                .unwrap_or_else(|| i18n.t(mx::UNTITLED_ACT).to_owned());
                            list = list.child(
                                div()
                                    .pt(px(space::S3))
                                    .pb(px(space::S1))
                                    .px(px(space::S4))
                                    .font_role(Role::Index)
                                    .type_px(s.caption, s.line_caption)
                                    .text_color(p.muted().solid())
                                    .child(name),
                            );
                        }
                    }
                    let chosen = m.selected.contains(&c.id);
                    let label = if c.title.trim().is_empty() {
                        i18n.t(mx::UNTITLED_CHAPTER).to_owned()
                    } else {
                        c.title.clone()
                    };
                    let (toggle, id) = (this.clone(), c.id.clone());
                    list = list.child(
                        SandCell::new(
                            gpui::ElementId::Name(format!("export-chapter-{}", c.id).into()),
                            label,
                        )
                        .mark(sand::Kind::Chapter(seal_of(&c.id)))
                        .disabled(running)
                        .child(div().flex_none().w(px(14.0)).when(chosen, |el| {
                            el.child(sand::icon(Icon::Check, 14.0, p.ink(1).solid()))
                        }))
                        .on_click(move |_, _, cx| {
                            toggle.update(cx, |d, cx| {
                                if let Some(m) = d.manuscript_mut() {
                                    m.toggle(&id);
                                }
                                cx.notify();
                            })
                        }),
                    );
                }
                scope = scope.child(head).child(list);
            }

            let mut contents = section(&theme, t(mx::CONTENTS));
            if outline.has_acts() {
                let flip = this.clone();
                contents = contents.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .child(t(mx::ACT_TITLES))
                        .child(
                            Switch::new("export-act-titles", m.act_titles)
                                .disabled(running)
                                .on_change(move |on, _, cx| {
                                    flip.update(cx, |d, cx| {
                                        if let Some(m) = d.manuscript_mut() {
                                            m.act_titles = on;
                                        }
                                        cx.notify();
                                    })
                                }),
                        ),
                );
            }
            let flip = this.clone();
            contents = contents.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(t(mx::CHAPTER_TITLES))
                    .child(
                        Switch::new("export-chapter-titles", m.chapter_titles)
                            .disabled(running)
                            .on_change(move |on, _, cx| {
                                flip.update(cx, |d, cx| {
                                    if let Some(m) = d.manuscript_mut() {
                                        m.chapter_titles = on;
                                    }
                                    cx.notify();
                                })
                            }),
                    ),
            );
            let contents = contents
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
            Button::new("export-close", t(keys::common::CLOSE))
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
