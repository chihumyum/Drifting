//! An entity link's hover card (M12): what the linked thing is, at a
//! glance, when the pointer rests on its name in the prose.
//!
//! The 0.1 client's card (`features/entities/hover/EntityHoverCard.tsx`,
//! `entity-hover-card-model.ts`), on dr-ui's one hover card (`CardBody`):
//!
//! - an element: its mark in its category's colour, its name; the
//!   category (or 「未分类」), its group, `AKA` and up to three aliases
//!   (`+N` for the rest); its synopsis; its facts as key and value;
//! - a chapter: its title and words; its status, its primary storyline (or
//!   「未归属故事线」) and the others; its synopsis;
//! - an idea (构想): its title, its group; its synopsis;
//! - a storyline: its name, 「N 章 · x.xk 字」, its synopsis;
//! - a category: its name, 「N 要素」.
//!
//! A target in the trash or gone has no card (and a click on its link does
//! nothing); neither has a link that reads as text (an automatic one whose
//! entry's 「自动链接」 is off, `kernel-v5.md` §16). An entry's card ends
//! with 「建关系」 and its 「自动链接」. Timing and placement are the
//! assist's ([`crate::assist`]).

use std::path::PathBuf;

use dr_model::kind::{AssetKind, EntityKind};
use dr_store::asset::Variant;
use dr_text::autolink::LinkTarget;
use dr_ui::components::hover_card::CardBody;
use dr_ui::components::menu::{float_shadow, slab_edge};
use dr_ui::fonts::{Role, weight};
use dr_ui::glass::{self, Ground};
use dr_ui::sand::{self, Icon};
use dr_ui::style::DrStyled as _;
use dr_ui::theme::Theme;
use dr_ui::tokens::{Rgb, radius};
use dr_workspace::Workspace;
use gpui::{
    AnyElement, App, IntoElement, ObjectFit, ParentElement, SharedString, Styled, StyledImage as _,
    Window, div, img, px,
};

/// File-link preview metadata for the 248px `.pcard` (`v5-tracks.md` §T5).
#[derive(Clone, Debug, PartialEq)]
pub struct AssetCardMeta {
    pub is_pdf: bool,
    pub picture: Option<PathBuf>,
    pub dimensions: Option<(i64, i64)>,
    pub pages: Option<usize>,
}

/// What a link's card shows.
#[derive(Clone, Debug, PartialEq)]
pub struct CardFacts {
    pub target: LinkTarget,
    pub title: String,
    pub mark: sand::Kind,
    /// The mark's colour (`#rrggbb`), for an element's category or a
    /// storyline.
    pub color: Option<String>,
    /// Beside the title: 「1,234 字」 for a chapter.
    pub count: Option<String>,
    /// The tags line, in order.
    pub tags: Vec<String>,
    /// 「AKA a · b · c +N」 for an element with aliases.
    pub aka: Option<String>,
    pub summary: String,
    /// An element's facts, key and value.
    pub facts: Vec<(String, String)>,
    /// Present when `target` is a live asset-library file.
    pub asset: Option<AssetCardMeta>,
    /// An entry's custom modules, each drawn as its 一行 under the synopsis
    /// (`custom-modules.md` §4 「一行」), in its template's order. A copy
    /// this build cannot read has no line.
    pub lines: Vec<ModuleLine>,
    /// An entry's own 「自动链接」 (`kernel-v5.md` §16), for the card's row.
    pub auto_link: bool,
}

/// One custom module of an entry, as its hover card draws it.
#[derive(Clone, Debug, PartialEq)]
pub struct ModuleLine {
    /// The entry template's module.
    pub module: String,
    pub value: std::sync::Arc<dr_model::custom_module::ModuleValue>,
    pub values: std::sync::Arc<dr_view_module_look::Scope>,
}

/// The card of `target` in `book`, or `None` when it is in the trash, gone,
/// or of a kind without a card.
pub fn card_facts(ws: &Workspace, book: &str, target: &LinkTarget) -> Option<CardFacts> {
    card_facts_v3(ws, book, target)
}

/// `#rrggbb` as dr-ui's colour.
fn rgb(hex: &str) -> Option<Rgb> {
    let v = u32::from_str_radix(hex.trim_start_matches('#'), 16).ok()?;
    (hex.trim_start_matches('#').len() == 6).then(|| Rgb::hex(v))
}

/// The card, as dr-ui draws hover cards.
pub fn card_element(facts: &CardFacts) -> AnyElement {
    card_body(facts, Vec::new())
}

/// [`card_element_in`] with `actions` as the card's last rows (an entry
/// link's 「建关系」, `kernel-v5.md` §19). A file link's card has none.
pub fn card_element_with(
    facts: &CardFacts,
    actions: Vec<AnyElement>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    if facts.asset.is_some() || actions.is_empty() {
        return card_element_in(facts, window, cx);
    }
    card_body(facts, actions)
}

fn card_body(facts: &CardFacts, actions: Vec<AnyElement>) -> AnyElement {
    let id = SharedString::from(format!("dr-editor-link-card-{}", facts.target.id));
    let mut body = CardBody::new(id, facts.title.clone())
        .mark(facts.mark, facts.color.as_deref().and_then(rgb));
    if let Some(count) = &facts.count {
        body = body.count(count.clone());
    }
    let mut tags = facts.tags.join(" · ");
    if let Some(aka) = &facts.aka {
        if !tags.is_empty() {
            tags.push('　');
        }
        tags.push_str(aka);
    }
    if !tags.is_empty() {
        body = body.meta(div().child(tags));
    }
    if !facts.summary.is_empty() {
        body = body.summary(facts.summary.clone());
    }
    if !facts.lines.is_empty() {
        let lines = facts
            .lines
            .iter()
            .map(|line| {
                // Inset as the synopsis above it.
                div()
                    .px(px(dr_ui::tokens::menu::HOVER_CARD_PAD))
                    .py(px(4.0))
                    .child(dr_view_module_look::Line::new(
                        SharedString::from(format!(
                            "dr-editor-link-card-{}-line-{}",
                            facts.target.id, line.module
                        )),
                        line.value.clone(),
                        line.values.clone(),
                    ))
                    .into_any_element()
            })
            .collect();
        body = body.section(lines);
    }
    if !facts.facts.is_empty() {
        let rows = facts
            .facts
            .iter()
            .map(|(k, v)| {
                div()
                    .flex()
                    .gap_2()
                    .child(div().flex_none().child(k.clone()))
                    .child(div().child(v.clone()))
                    .into_any_element()
            })
            .collect();
        body = body.section(rows);
    }
    if !actions.is_empty() {
        body = body.section(actions);
    }
    body.into_any_element()
}

/// Draws a link hover card in `window`: a 248px `.pcard` preview card for live
/// file links (`v5-tracks.md` §T5), or [`card_element`] for entry links.
pub fn card_element_in(facts: &CardFacts, window: &Window, cx: &App) -> AnyElement {
    let Some(asset) = &facts.asset else {
        return card_element(facts);
    };
    let theme = Theme::of(window, cx);
    let p = theme.palette;
    let strings = crate::file_host::strings(cx);
    let mut meta_parts = vec![if asset.is_pdf {
        strings.kind_pdf.to_string()
    } else {
        strings.kind_image.to_string()
    }];
    if asset.is_pdf {
        if let Some(pages) = asset.pages {
            meta_parts.push(crate::file_host::format_page_count(pages, cx));
        }
    } else if let Some((w, h)) = asset.dimensions {
        meta_parts.push(format!("{w} × {h}"));
    }
    let thumb = match &asset.picture {
        Some(path) => img(path.clone())
            .size_full()
            .object_fit(ObjectFit::Cover)
            .into_any_element(),
        None => div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(sand::icon(
                if asset.is_pdf {
                    Icon::FileText
                } else {
                    Icon::Image
                },
                28.,
                p.ink(3).solid(),
            ))
            .into_any_element(),
    };
    glass::surface(
        Ground::flat(p.desk),
        div()
            .w(px(248.))
            .relative()
            .rounded(px(radius::SHEET))
            .shadow(float_shadow(p))
            .p(px(10.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(slab_edge(p, radius::SHEET))
            .child(
                div()
                    .w_full()
                    .h(px(156.))
                    .rounded(px(6.))
                    .overflow_hidden()
                    .bg(p.ink(4).alpha(0.08))
                    .child(thumb),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .px(px(2.))
                    .child(
                        div()
                            .font_role(Role::Ui)
                            .type_px(12.5, 17.)
                            .weight(weight::MEDIUM)
                            .text_color(p.ink(1).solid())
                            .truncate()
                            .child(facts.title.clone()),
                    )
                    .child(
                        div()
                            .font_role(Role::Index)
                            .type_px(11., 15.)
                            .text_color(p.ink(3).solid())
                            .truncate()
                            .child(meta_parts.join(" · ")),
                    ),
            ),
    )
    .into_any_element()
}

/// The 一行 of each custom module of `entry`'s template whose copy this
/// build can read, with the entry's values (entries named by their titles;
/// an entry since deleted is left out).
fn module_lines(
    v: &dr_doc::v3::BookViewV3<'_>,
    entry: &dr_model::v3::Entry,
    modules: &[dr_model::v3::ModuleSpec],
) -> Vec<ModuleLine> {
    use dr_model::custom_module::values::read_scope;
    let custom: Vec<_> = modules
        .iter()
        .filter(|m| m.kind == dr_model::v3::ModuleKind::Custom)
        .collect();
    if custom.is_empty() {
        return Vec::new();
    }
    struct Titles(std::collections::BTreeMap<String, String>);
    impl dr_view_module_look::Names for Titles {
        fn entry(&self, id: &str) -> Option<String> {
            self.0.get(id).cloned()
        }
        fn image(&self, id: &str) -> Option<dr_view_module_look::Picture> {
            let _ = id;
            None
        }
    }
    let titles = Titles(
        v.entries()
            .into_iter()
            .filter(|e| !e.is_trashed())
            .map(|e| (e.id.to_string(), e.title.clone()))
            .collect(),
    );
    custom
        .into_iter()
        .filter_map(|m| {
            let copy = v.module_copy(m.config.module.as_ref()?)?;
            let module = copy.module()?.clone();
            let stored = v.custom_values(&entry.id, &m.id);
            let read = read_scope(&module, None, &stored);
            Some(ModuleLine {
                module: m.id.to_string(),
                values: std::sync::Arc::new(dr_view_module_look::Scope::read(&read, &titles)),
                value: std::sync::Arc::new(module),
            })
        })
        .collect()
}

fn card_facts_v3(ws: &Workspace, book: &str, target: &LinkTarget) -> Option<CardFacts> {
    let target = target.clone();
    if matches!(target.kind, EntityKind::Asset | EntityKind::Material) {
        let asset_id = target.id.clone();
        let asset = crate::v3::read(ws, book, move |v| {
            v.assets().into_iter().find(|a| a.id.as_str() == asset_id)
        })
        .ok()
        .flatten()?;
        let is_pdf = asset.kind == AssetKind::Pdf;
        let path_of = |variant: Variant| {
            let rec = ws.library().asset(asset.id.as_str(), variant).ok()??;
            rec.path.exists().then_some(rec.path)
        };
        let picture = if is_pdf {
            path_of(Variant::Thumbnail)
        } else {
            path_of(Variant::Display)
                .or_else(|| path_of(Variant::Thumbnail))
                .or_else(|| path_of(Variant::Source))
        };
        let dimensions = match (asset.width, asset.height) {
            (Some(w), Some(h)) if w > 0 && h > 0 => Some((w, h)),
            _ => None,
        };
        let pages = is_pdf
            .then(|| crate::file_host::pdf_pages_cached(ws, asset.id.as_str()))
            .flatten();
        let mut tags = vec![if is_pdf {
            "PDF".into()
        } else {
            "图片".into()
        }];
        if let Some(n) = pages {
            tags.push(format!("{n} 页"));
        } else if let Some((w, h)) = dimensions {
            tags.push(format!("{w} × {h}"));
        }
        return Some(CardFacts {
            target,
            title: asset.name,
            mark: sand::Kind::Material,
            color: None,
            count: None,
            tags,
            aka: None,
            summary: String::new(),
            facts: Vec::new(),
            asset: Some(AssetCardMeta {
                is_pdf,
                picture,
                dimensions,
                pages,
            }),
            lines: Vec::new(),
            auto_link: false,
        });
    }
    crate::v3::read(ws, book, move |v| {
        let mut card = CardFacts {
            target: target.clone(),
            title: String::new(),
            mark: sand::Kind::Category,
            color: None,
            count: None,
            tags: Vec::new(),
            aka: None,
            summary: String::new(),
            facts: Vec::new(),
            asset: None,
            lines: Vec::new(),
            auto_link: false,
        };
        match target.kind {
            EntityKind::Entry => {
                let e = v
                    .entries()
                    .into_iter()
                    .find(|e| e.id.as_str() == target.id && !e.is_trashed())?;
                let templates = v.templates_map();
                let t = e.effective_template(&templates)?;
                card.title = e.title.clone();
                card.auto_link = e.auto_link;
                card.color = t.color.clone();
                card.tags.push(t.name.clone());
                let aliases = e.aliases(&templates);
                if !aliases.is_empty() {
                    card.aka = Some(aliases.into_iter().collect::<Vec<_>>().join(" · "));
                }
                for m in &t.modules {
                    if let Some(key) = &m.config.summary_field {
                        card.summary = e
                            .fields
                            .get(&m.id)
                            .and_then(|f| f.get(key))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_owned();
                    }
                    if let Some(rows) = e.kv.get(&m.id) {
                        card.facts
                            .extend(rows.iter().map(|r| (r.key.clone(), r.value.clone())));
                    }
                }
                card.lines = module_lines(&v, &e, &t.modules);
            }
            _ => return None,
        }
        Some(card)
    })
    .ok()
    .flatten()
}
