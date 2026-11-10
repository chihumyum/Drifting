//! Predicates the command layer (F3) runs before a write — the "命令层预防"
//! half of the invariant checklist. Pure functions on records; they cannot
//! stop a merge from breaking a rule (readers and repairs handle that), only
//! a local write.

use std::fmt;

use crate::kind::{AssetKind, MaterialKind};
use crate::shared::{Asset, PLOT_CELL_H, PLOT_CELL_W, is_sha256_hex};

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
    #[test]
    fn shared_payload_and_size_checks() {
        assert!(non_empty_name("  ").is_err());
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
