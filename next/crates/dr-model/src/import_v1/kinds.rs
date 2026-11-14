//! The 0.1 source format's per-kind vocabularies: what a node is, a node's
//! writing status and a category's layout. Canonical entries take these
//! from their template instead; only the source replay reads them.

use crate::kind::open_enum;

open_enum!(
    /// Chapter or idea. Readers go by `kind`: a chapter without a primary
    /// storyline is still a chapter.
    NodeKind {
        Chapter = "chapter",
        /// An idea (构想, English "Ideas"; internal name drift).
        Drift = "drift",
    }
);

open_enum!(
    /// Writing status. Chapters use `draft` / `finished` / `discarded`
    /// (`discarded` keeps the chapter on the timeline, styled as set aside);
    /// ideas use `drifting` / `resting`. One field, disambiguated by
    /// [`NodeKind`], as in the old `writing_status` column.
    NodeStatus {
        Draft = "draft",
        Finished = "finished",
        Discarded = "discarded",
        Drifting = "drifting",
        Resting = "resting",
    }
);

impl NodeStatus {
    /// The status a new node of `kind` starts with.
    pub fn default_for(kind: &NodeKind) -> Self {
        match kind {
            NodeKind::Drift => NodeStatus::Drifting,
            _ => NodeStatus::Draft,
        }
    }

    /// Whether this status belongs to `kind` (a chapter status on an idea,
    /// for example, is shown as the kind's default).
    pub fn fits(&self, kind: &NodeKind) -> bool {
        match kind {
            NodeKind::Chapter => matches!(
                self,
                NodeStatus::Draft | NodeStatus::Finished | NodeStatus::Discarded
            ),
            NodeKind::Drift => matches!(self, NodeStatus::Drifting | NodeStatus::Resting),
            NodeKind::Other(_) => true,
        }
    }
}

open_enum!(
    /// How a category's elements are laid out in the element overview.
    CategoryLayout {
        Auto = "auto",
        Pinned = "pinned",
    }
);

open_enum!(
    /// What a 0.1 material is. URL materials were retired (old migration 0011);
    /// an old `url` value reads as `Other`.
    MaterialKind {
        Image = "image",
        Pdf = "pdf",
        /// A text material: the author's note (its 0.1 body is a `material:` prose
        /// document).
        Text = "text",
    }
);

impl MaterialKind {
    /// Image and PDF materials have asset bytes; text materials do not.
    pub fn needs_asset(&self) -> bool {
        matches!(self, MaterialKind::Image | MaterialKind::Pdf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_status_fits_its_kind() {
        assert!(NodeStatus::Draft.fits(&NodeKind::Chapter));
        assert!(!NodeStatus::Draft.fits(&NodeKind::Drift));
        assert_eq!(
            NodeStatus::default_for(&NodeKind::Drift),
            NodeStatus::Drifting
        );
    }
}
