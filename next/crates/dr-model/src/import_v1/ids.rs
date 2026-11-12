//! The 0.1 source format's per-kind ids.
//!
//! The canonical model has one [`EntryId`](crate::id::EntryId) for
//! everything in the entry tree. These name the fixed kinds an old library
//! stores (chapter or idea, act, storyline, category, element, idea group),
//! for the source replay only.

use crate::id::{DocId, PlotColId, PlotRowId, TemplateId, default_plot_line, id_type};

id_type!(
    /// A chapter or an idea (构想, internal name drift): the old `book_node`.
    NodeId
);
id_type!(
    /// An act (幕): a boundary on the book-order axis.
    ActId
);
id_type!(StorylineId);
id_type!(
    /// An element category (分类).
    CategoryId
);
id_type!(
    /// An element (要素).
    ElementId
);
id_type!(
    /// An idea group (构想分组): a node of the `drift_groups` tree.
    DriftGroupId
);

impl From<NodeId> for DocId {
    fn from(id: NodeId) -> Self {
        DocId::Node(id)
    }
}
impl From<ElementId> for DocId {
    fn from(id: ElementId) -> Self {
        DocId::Element(id)
    }
}
impl From<StorylineId> for DocId {
    fn from(id: StorylineId) -> Self {
        DocId::Storyline(id)
    }
}
impl From<CategoryId> for DocId {
    fn from(id: CategoryId) -> Self {
        DocId::Category(id)
    }
}

/// Default row `n` (1-based) of `chapter`'s plot grid: `<chapter>:r<n>`.
/// Every device that creates the grid writes these same lines (`dr_doc`'s
/// source `BookTxn::create_plot_grid`).
pub fn default_plot_row(chapter: &NodeId, n: usize) -> PlotRowId {
    PlotRowId::parse(&default_plot_line(chapter.as_str(), 'r', n)).expect("valid id")
}

/// Default column `n` (1-based) of `chapter`'s plot grid: `<chapter>:c<n>`.
pub fn default_plot_col(chapter: &NodeId, n: usize) -> PlotColId {
    PlotColId::parse(&default_plot_line(chapter.as_str(), 'c', n)).expect("valid id")
}

/// What a source-format body template belongs to. One template per owner,
/// so the template's id is derived from it and two devices creating the
/// same template write one document.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum TemplateOwner {
    /// The template new elements of this category start from (the old
    /// `element_category.element_template`): `template:category:<id>`.
    Category(CategoryId),
    /// The template new chapters of this storyline start from (the old
    /// `storylines.chapter_template`): `template:storyline:<id>`.
    Storyline(StorylineId),
}

impl TemplateOwner {
    /// Whose template `id` is; `None` when it is not a source-format
    /// template id (a v3 `<book>/<template>/<module>` id, or one this
    /// version does not know).
    pub fn of(id: &TemplateId) -> Option<TemplateOwner> {
        let (kind, id) = id.as_str().split_once(':')?;
        match kind {
            "category" => CategoryId::parse(id).ok().map(TemplateOwner::Category),
            "storyline" => StorylineId::parse(id).ok().map(TemplateOwner::Storyline),
            _ => None,
        }
    }

    /// The template's id: `category:<id>` or `storyline:<id>`.
    pub fn template_id(&self) -> TemplateId {
        let id = match self {
            TemplateOwner::Category(c) => format!("category:{c}"),
            TemplateOwner::Storyline(s) => format!("storyline:{s}"),
        };
        TemplateId::parse(&id).expect("valid id")
    }

    /// The template document's id.
    pub fn doc_id(&self) -> DocId {
        DocId::Template(self.template_id())
    }
}
