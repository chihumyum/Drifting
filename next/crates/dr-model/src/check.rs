//! Predicates the command layer (F3) runs before a write — the "命令层预防"
//! half of the invariant checklist. Pure functions on records; they cannot
//! stop a merge from breaking a rule (readers and repairs handle that), only
//! a local write.

use std::fmt;

use crate::book::{
    Asset, EntityRef, PLOT_CELL_H, PLOT_CELL_W, RelationType, canonical_symmetric, is_sha256_hex,
};
use crate::id::{BlockId, NodeId};
use crate::kind::{AssetKind, EntityKind, MaterialKind, RelationOrientation};

/// Which rule a write breaks, by invariant id (`crate::invariant`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Violation {
    pub invariant: &'static str,
    pub detail: String,
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.invariant, self.detail)
    }
}

impl std::error::Error for Violation {}

fn fail<T>(invariant: &'static str, detail: impl Into<String>) -> Result<T, Violation> {
    Err(Violation {
        invariant,
        detail: detail.into(),
    })
}

/// Names and titles must not be empty after trimming.
pub fn non_empty_name(name: &str) -> Result<(), Violation> {
    if name.trim().is_empty() {
        return fail("NAME-NONEMPTY", "empty name");
    }
    Ok(())
}

/// A relation type definition (old `normalizeRelationTypeDefinition`):
/// non-empty name; at least one source and one target kind; sources from the
/// relation-start kinds, targets structural; a directed type has both role
/// labels; a symmetric type is structural on both sides with the same kinds.
pub fn relation_type_definition(t: &RelationType) -> Result<(), Violation> {
    non_empty_name(&t.name)?;
    if t.source_kinds.is_empty() || t.target_kinds.is_empty() {
        return fail(
            "RT-DEFINITION",
            "needs at least one source and one target kind",
        );
    }
    if let Some(k) = t.source_kinds.iter().find(|k| !k.may_start_relation()) {
        return fail("RT-DEFINITION", format!("{k} cannot start a relation"));
    }
    if let Some(k) = t.target_kinds.iter().find(|k| !k.is_structural()) {
        return fail("RT-DEFINITION", format!("{k} cannot end a relation"));
    }
    match t.orientation {
        RelationOrientation::Directed => {
            if t.source_role.trim().is_empty() || t.target_role.trim().is_empty() {
                return fail("RT-DEFINITION", "a directed type needs both role labels");
            }
        }
        RelationOrientation::Symmetric => {
            if t.source_kinds.iter().any(|k| !k.is_structural()) {
                return fail(
                    "RT-DEFINITION",
                    "a symmetric type joins structural kinds only",
                );
            }
            let mut a = t.source_kinds.clone();
            let mut b = t.target_kinds.clone();
            a.sort();
            a.dedup();
            b.sort();
            b.dedup();
            if a != b {
                return fail(
                    "RT-DEFINITION",
                    "a symmetric type has the same kinds on both sides",
                );
            }
        }
        RelationOrientation::Other(_) => {
            return fail("RT-DEFINITION", "unknown orientation");
        }
    }
    Ok(())
}

/// Ends of a new relation of type `t`; returns them in stored order
/// (canonical for a symmetric type).
pub fn relation_ends(
    t: &RelationType,
    from: EntityRef,
    to: EntityRef,
) -> Result<(EntityRef, EntityRef), Violation> {
    if from == to {
        return fail("REL-NO-SELF", "a relation cannot join an entity to itself");
    }
    if !from.kind.may_start_relation() || !to.kind.is_structural() {
        return fail(
            "REL-KINDS",
            format!("{} → {} is not a relation", from.kind, to.kind),
        );
    }
    let allowed = |kinds: &[EntityKind], k: &EntityKind| kinds.is_empty() || kinds.contains(k);
    match t.orientation {
        RelationOrientation::Symmetric => {
            if !allowed(&t.source_kinds, &from.kind) || !allowed(&t.source_kinds, &to.kind) {
                return fail("REL-KINDS-BY-TYPE", "kinds not allowed by the type");
            }
            Ok(canonical_symmetric(from, to))
        }
        _ => {
            if !allowed(&t.source_kinds, &from.kind) || !allowed(&t.target_kinds, &to.kind) {
                return fail("REL-KINDS-BY-TYPE", "kinds not allowed by the type");
            }
            Ok((from, to))
        }
    }
}

/// A comment target: none (floating), or a kind a comment may target.
pub fn comment_target(
    target: Option<&EntityRef>,
    block: Option<&BlockId>,
) -> Result<(), Violation> {
    match target {
        None if block.is_some() => fail("CMT-TARGET", "a block without a target"),
        None => Ok(()),
        Some(t) if !t.kind.may_be_commented() => {
            fail("CMT-TARGET", format!("{} cannot be commented", t.kind))
        }
        Some(_) => Ok(()),
    }
}

/// A patch's source: a block needs its chapter.
pub fn patch_source(node: Option<&NodeId>, block: Option<&BlockId>) -> Result<(), Violation> {
    if block.is_some() && node.is_none() {
        return fail(
            "PATCH-BLOCK-NEEDS-NODE",
            "source block without source chapter",
        );
    }
    Ok(())
}

/// A material's payload: image and PDF materials have an asset of the same
/// kind; text materials have none.
pub fn material_payload(kind: &MaterialKind, asset: Option<&Asset>) -> Result<(), Violation> {
    match (kind, asset) {
        (MaterialKind::Image, Some(a)) if a.kind == AssetKind::Image => Ok(()),
        (MaterialKind::Pdf, Some(a)) if a.kind == AssetKind::Pdf => Ok(()),
        (MaterialKind::Text, None) => Ok(()),
        (MaterialKind::Other(k), _) => fail("MAT-KIND", format!("unsupported material kind {k:?}")),
        _ => fail("MAT-PAYLOAD", "asset missing or of the wrong kind"),
    }
}

/// An asset's metadata shape (old `project_asset` checks): size > 0; sha256
/// lowercase hex; images `image/*` with positive size, PDFs
/// `application/pdf` without dimensions.
pub fn asset_shape(a: &Asset) -> Result<(), Violation> {
    if a.size <= 0 {
        return fail("AST-SHAPE", "size must be positive");
    }
    if !is_sha256_hex(&a.sha256) {
        return fail("AST-SHAPE", "sha256 must be 64 lowercase hex digits");
    }
    match a.kind {
        AssetKind::Image => {
            if !a.mime.starts_with("image/") {
                return fail("AST-SHAPE", "an image needs an image/* type");
            }
            if !matches!((a.width, a.height), (Some(w), Some(h)) if w > 0 && h > 0) {
                return fail("AST-SHAPE", "an image needs its size");
            }
        }
        AssetKind::Pdf => {
            if a.mime != "application/pdf" || a.width.is_some() || a.height.is_some() {
                return fail("AST-SHAPE", "a PDF is application/pdf without dimensions");
            }
        }
        AssetKind::Other(_) => return fail("AST-SHAPE", "unknown asset kind"),
    }
    Ok(())
}

/// Plot-grid cell size bounds (rejected, not clamped, like the old kernel;
/// readers clamp what a merge or a newer version left out of range).
pub fn plot_cell_size(w: f64, h: f64) -> Result<(), Violation> {
    if !PLOT_CELL_W.contains(&w) || !PLOT_CELL_H.contains(&h) {
        return fail("PLOT-GRID", format!("cell {w}×{h} out of range"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::RelationTypeId;
    use crate::kind::SystemRelationKey;

    fn rt(
        orientation: RelationOrientation,
        src: &[EntityKind],
        dst: &[EntityKind],
    ) -> RelationType {
        RelationType {
            id: RelationTypeId::parse("t").unwrap(),
            name: "朋友".into(),
            normalized_name: "朋友".into(),
            description: String::new(),
            orientation,
            system_key: None::<SystemRelationKey>,
            locked: false,
            source_role: "甲".into(),
            target_role: "乙".into(),
            color: None,
            source_kinds: src.to_vec(),
            target_kinds: dst.to_vec(),
        }
    }

    #[test]
    fn command_checks_follow_the_old_rules() {
        use EntityKind::*;
        assert!(non_empty_name("  ").is_err());
        assert!(
            relation_type_definition(&rt(RelationOrientation::Directed, &[Element], &[Element]))
                .is_ok()
        );
        assert!(
            relation_type_definition(&rt(RelationOrientation::Directed, &[], &[Element])).is_err()
        );
        assert!(
            relation_type_definition(&rt(RelationOrientation::Directed, &[Element], &[Comment]))
                .is_err()
        );
        assert!(
            relation_type_definition(&rt(RelationOrientation::Symmetric, &[Comment], &[Comment]))
                .is_err()
        );
        assert!(
            relation_type_definition(&rt(RelationOrientation::Symmetric, &[Element], &[Node]))
                .is_err()
        );
        let mut no_roles = rt(RelationOrientation::Directed, &[Element], &[Element]);
        no_roles.target_role = " ".into();
        assert!(relation_type_definition(&no_roles).is_err());

        let sym = rt(RelationOrientation::Symmetric, &[Element], &[Element]);
        let (a, b) = relation_ends(
            &sym,
            EntityRef::new(Element, "z"),
            EntityRef::new(Element, "a"),
        )
        .unwrap();
        assert_eq!((a.id.as_str(), b.id.as_str()), ("a", "z"));
        assert_eq!(
            relation_ends(
                &sym,
                EntityRef::new(Element, "a"),
                EntityRef::new(Element, "a")
            )
            .unwrap_err()
            .invariant,
            "REL-NO-SELF"
        );
        let dir = rt(RelationOrientation::Directed, &[Comment], &[Element]);
        assert!(
            relation_ends(
                &dir,
                EntityRef::new(Comment, "c"),
                EntityRef::new(Element, "e")
            )
            .is_ok()
        );
        assert_eq!(
            relation_ends(
                &dir,
                EntityRef::new(Element, "e"),
                EntityRef::new(Comment, "c")
            )
            .unwrap_err()
            .invariant,
            "REL-KINDS"
        );

        let b = BlockId::parse("b").unwrap();
        assert!(comment_target(None, Some(&b)).is_err());
        assert!(comment_target(Some(&EntityRef::new(Material, "m")), None).is_ok());
        assert!(comment_target(Some(&EntityRef::new(Comment, "c")), None).is_err());
        assert!(patch_source(None, Some(&b)).is_err());

        let img = Asset {
            id: crate::id::AssetId::parse("a").unwrap(),
            kind: AssetKind::Image,
            mime: "image/png".into(),
            size: 1,
            sha256: "0".repeat(64),
            width: Some(1),
            height: Some(1),
        };
        assert!(asset_shape(&img).is_ok());
        assert!(material_payload(&MaterialKind::Image, Some(&img)).is_ok());
        assert!(material_payload(&MaterialKind::Pdf, Some(&img)).is_err());
        assert!(material_payload(&MaterialKind::Text, Some(&img)).is_err());
        assert!(material_payload(&MaterialKind::parse("url"), None).is_err());
        let mut pdf = img.clone();
        pdf.kind = AssetKind::Pdf;
        assert!(asset_shape(&pdf).is_err());
        pdf.mime = "application/pdf".into();
        pdf.width = None;
        pdf.height = None;
        assert!(asset_shape(&pdf).is_ok());
        assert!(plot_cell_size(184.0, 96.0).is_ok());
        assert!(plot_cell_size(100.0, 96.0).is_err());
    }
}
