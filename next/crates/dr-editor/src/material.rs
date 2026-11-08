//! A material embedded in a note (M19's note profile): an image shown
//! whole, a PDF as a card; opening it is the host's
//! ([`crate::NoteEvent::OpenMaterial`]).
//!
//! The 0.1 client's look (`features/library/MaterialEmbedView.tsx`):
//!
//! - an image: its `display` variant, at most 520 px high, centred, radius
//!   4; its title as a small caption under it. A click selects the embed
//!   (Backspace then deletes it); a double click, or a click on the caption,
//!   opens the material. While the image is not on this device: 「加载中…」
//!   in a dashed box.
//! - a PDF: a card the width of the text, its first page's 48 px thumbnail
//!   (or the kind's mark) beside the title and 「PDF」; a click opens it.
//! - a material that is gone: 「这条素材已被删除。」.

use std::path::PathBuf;
use std::rc::Rc;

use dr_model::id::MaterialId;
use dr_store::asset::Variant;
use dr_ui::sand::{self, Icon};
use gpui::{
    Context, FontWeight, InteractiveElement, IntoElement, ObjectFit, ParentElement, Render,
    StatefulInteractiveElement as _, Styled, StyledImage as _, Window, div, img,
    prelude::FluentBuilder as _, px,
};
use serde_json::json;

use crate::embeds::NoteHost;

/// What an embedded material shows.
#[derive(Clone, Debug, PartialEq)]
pub struct MaterialFacts {
    pub title: String,
    /// `image` or `pdf` (a text material shows as a card too).
    pub kind: String,
    /// The image to show: an image's `display` variant (else its source),
    /// a PDF's `thumbnail`.
    pub picture: Option<PathBuf>,
}

/// Material `id`'s title, if it is in the book.
pub(crate) fn title_of(host: &NoteHost, id: &str) -> Option<String> {
    let list = host
        .ws
        .call(
            &dr_workspace::Actor::User,
            "material.list",
            json!({ "book": host.book }),
        )
        .ok()?;
    list["output"]
        .as_array()?
        .iter()
        .find(|m| m["id"].as_str() == Some(id))
        .and_then(|m| m["title"].as_str().map(str::to_owned))
}

/// One embedded material.
pub struct MaterialBlock {
    host: Rc<NoteHost>,
    embed: String,
    material: Option<MaterialId>,
    facts: Option<Option<MaterialFacts>>,
    pub(crate) selected: bool,
}

impl MaterialBlock {
    pub(crate) fn new(host: Rc<NoteHost>, embed: &str, material: Option<MaterialId>) -> Self {
        MaterialBlock {
            host,
            embed: embed.to_owned(),
            material,
            facts: None,
            selected: false,
        }
    }

    /// Looks the material up again (the book changed).
    pub(crate) fn reload(&mut self, cx: &mut Context<Self>) {
        self.facts = None;
        cx.notify();
    }

    /// The material's facts; `None` when it is gone.
    pub fn facts(&mut self) -> Option<&MaterialFacts> {
        if self.facts.is_none() {
            self.facts = Some(self.look_up());
        }
        self.facts.as_ref().and_then(Option::as_ref)
    }

    fn look_up(&self) -> Option<MaterialFacts> {
        let id = self.material.as_ref()?;
        let list = self
            .host
            .ws
            .call(
                &dr_workspace::Actor::User,
                "material.list",
                json!({ "book": self.host.book }),
            )
            .ok()?;
        let m = list["output"]
            .as_array()?
            .iter()
            .find(|m| m["id"].as_str() == Some(id.as_str()))?
            .clone();
        let kind = m["kind"].as_str().unwrap_or("image").to_owned();
        let asset = m["asset"].as_str();
        let path = |variant: Variant| {
            let record = self.host.ws.library().asset(asset?, variant).ok()??;
            record.path.exists().then_some(record.path)
        };
        let picture = if kind == "pdf" {
            path(Variant::Thumbnail)
        } else {
            path(Variant::Display).or_else(|| path(Variant::Source))
        };
        Some(MaterialFacts {
            title: m["title"].as_str().unwrap_or_default().to_owned(),
            kind,
            picture,
        })
    }

    /// Opens the material (the host's tab).
    pub fn open(&self, cx: &mut gpui::App) {
        if let Some(id) = &self.material {
            self.host.open_material(id.as_str(), cx);
        }
    }

    fn select(&self, window: &mut Window, cx: &mut gpui::App) {
        let Some((line, _)) = self.host.embed_line(&self.embed, cx) else {
            return;
        };
        let chapter = self.host.chapter;
        if let Some(body) = self.host.body.upgrade() {
            body.update(cx, |e, cx| e.select_embed(chapter, line, window, cx));
        }
    }
}

impl Render for MaterialBlock {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let style = self.host.style.borrow().clone();
        let (ink, muted) = (style.text, style.muted);
        let ring = style.cursor.opacity(0.5);
        let selected = self.selected;
        let this = cx.entity();
        let facts = self.facts().cloned();
        let id = gpui::SharedString::from(format!("dr-editor-material-{}", self.embed));
        let Some(facts) = facts else {
            return div()
                .id(id)
                .flex()
                .items_center()
                .gap(px(6.))
                .py(px(6.))
                .text_size(px(13.))
                .text_color(muted)
                .child(sand::icon(Icon::StatusWarning, 14., muted))
                .child("这条素材已被删除。")
                .into_any_element();
        };
        if facts.kind == "image" {
            let picture = match facts.picture.clone() {
                Some(path) => {
                    let (open, pick) = (this.clone(), this.clone());
                    div()
                        .id("picture")
                        .rounded(px(4.))
                        .when(selected, |d| d.border_2().border_color(ring))
                        .cursor_pointer()
                        .on_click(move |event, window, cx| {
                            if event.click_count() >= 2 {
                                open.update(cx, |b, cx| b.open(cx));
                            } else {
                                pick.update(cx, |b, cx| b.select(window, cx));
                            }
                        })
                        .child(
                            img(path)
                                .max_h(px(520.))
                                .max_w_full()
                                .rounded(px(4.))
                                .object_fit(ObjectFit::Contain),
                        )
                        .into_any_element()
                }
                None => div()
                    .w_full()
                    .h(px(120.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(4.))
                    .border_1()
                    .border_dashed()
                    .border_color(muted.opacity(0.5))
                    .text_size(px(12.))
                    .text_color(muted)
                    .child("加载中…")
                    .into_any_element(),
            };
            let open = this.clone();
            return div()
                .id(id)
                .w_full()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(4.))
                .child(picture)
                .child(
                    div()
                        .id("caption")
                        .text_size(px(12.))
                        .text_color(muted)
                        .hover(|s| s.text_color(ink))
                        .cursor_pointer()
                        .on_click(move |_, _, cx| open.update(cx, |b, cx| b.open(cx)))
                        .child(facts.title.clone()),
                )
                .into_any_element();
        }
        // A PDF (or a text material): a card.
        let thumb = match facts.picture.clone() {
            Some(path) => img(path)
                .size(px(48.))
                .rounded(px(4.))
                .object_fit(ObjectFit::Cover)
                .into_any_element(),
            None => div()
                .size(px(48.))
                .flex()
                .items_center()
                .justify_center()
                .child(sand::icon(Icon::FileText, 24., muted))
                .into_any_element(),
        };
        let label = if facts.kind == "pdf" { "PDF" } else { "文本" };
        let open = this.clone();
        div()
            .id(id)
            .w_full()
            .flex()
            .items_center()
            .gap(px(12.))
            .p(px(4.))
            .rounded(px(8.))
            .when(selected, |d| d.border_2().border_color(ring))
            .hover(|s| s.bg(muted.opacity(0.08)))
            .cursor_pointer()
            .on_click(move |_, _, cx| open.update(cx, |b, cx| b.open(cx)))
            .child(thumb)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        div()
                            .text_size(px(14.))
                            .text_color(ink)
                            .font_weight(FontWeight::NORMAL)
                            .child(facts.title.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(10.))
                            .text_color(muted)
                            .font_family("Menlo")
                            .child(label),
                    ),
            )
            .into_any_element()
    }
}
