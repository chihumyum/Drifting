//! The design assets dr-ui embeds, and the [`AssetSource`] that hands them
//! to GPUI.
//!
//! Brush icons, sand masks and the glass texture are the project's own white
//! alpha masks (`assets/`, copied from `src/assets/design/`; see
//! ASSET_PROVENANCE.md). GPUI's `svg()` rasterises an SVG and keeps only its
//! alpha, then tints it at draw time, so an SVG that holds nothing but the
//! PNG draws the mask in any colour, cached on the GPU (P0-D, 「砂笔图标」).
//! The SVGs are built the first time GPUI asks for a path.
//!
//! An app passes [`Assets`] to `Application::with_assets`; its own assets go
//! through [`Assets::with_fallback`].

use std::{borrow::Cow, sync::Arc};

use anyhow::Result;
use base64::Engine as _;
use gpui::{AssetSource, SharedString};

/// Declares an enum of embedded masks: its variants, names, PNG bytes and
/// the asset path GPUI loads them by.
macro_rules! masks {
    ($(#[$doc:meta])* $ty:ident, $dir:literal, $prefix:literal, $($variant:ident => $name:literal),* $(,)?) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $ty {
            $($variant),*
        }

        impl $ty {
            pub const ALL: &'static [$ty] = &[$($ty::$variant),*];

            /// The file's stem, as the renderer names it.
            pub const fn name(self) -> &'static str {
                match self {
                    $($ty::$variant => $name),*
                }
            }

            pub fn from_name(name: &str) -> Option<$ty> {
                match name {
                    $($name => Some($ty::$variant),)*
                    _ => None,
                }
            }

            /// The PNG as stored.
            pub const fn png(self) -> &'static [u8] {
                match self {
                    $($ty::$variant => include_bytes!(concat!(
                        env!("CARGO_MANIFEST_DIR"), "/assets/", $dir, "/", $name, ".png"
                    ))),*
                }
            }

            /// The path `svg()` loads it by.
            pub const fn path(self) -> &'static str {
                match self {
                    $($ty::$variant => concat!("dr-ui/", $prefix, "/", $name, ".svg")),*
                }
            }

            pub fn shared_path(self) -> gpui::SharedString {
                gpui::SharedString::new_static(self.path())
            }

            /// The folder the masks come from, for the consistency test.
            pub const DIR: &'static str = $dir;
        }
    };
}

pub(crate) use masks;

/// The PNG's pixel size, read from its header.
pub fn png_size(png: &[u8]) -> (u32, u32) {
    if png.len() < 24 {
        return (1, 1);
    }
    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    (w, h)
}

/// An SVG whose only content is `png`, `view_w` × `view_h` logical px.
pub fn embed_svg(png: &[u8], view_w: f32, view_h: f32) -> Vec<u8> {
    let data = base64::engine::general_purpose::STANDARD.encode(png);
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{view_w}" height="{view_h}" viewBox="0 0 {view_w} {view_h}"><image width="{view_w}" height="{view_h}" preserveAspectRatio="none" xlink:href="data:image/png;base64,{data}"/></svg>"#
    )
    .into_bytes()
}

/// The glass texture `glass-thick.png`: one 150px tile (`mask-size`).
pub const GLASS_TILE_PNG: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/glass/glass-thick.png"
));
/// The same texture pre-tinted as the resting line, for a menu's rim
/// (`ringgen.py`), light and dark.
pub const GLASS_RING_PNG: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/glass/glass-ring.png"
));
pub const GLASS_RING_DARK_PNG: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/glass/glass-ring-dark.png"
));
pub const GLASS_TILE_PATH: &str = "dr-ui/glass/thick.svg";

/// dr-ui's asset source.
#[derive(Clone, Default)]
pub struct Assets {
    fallback: Option<Arc<dyn AssetSource>>,
}

impl Assets {
    pub fn new() -> Assets {
        Assets::default()
    }

    /// Serves everything outside `dr-ui/` from `source`.
    pub fn with_fallback(source: impl AssetSource) -> Assets {
        Assets {
            fallback: Some(Arc::new(source)),
        }
    }

    /// The SVG for a dr-ui path, if it is one.
    pub fn svg(path: &str) -> Option<Vec<u8>> {
        let rest = path.strip_prefix("dr-ui/")?;
        let (kind, file) = rest.split_once('/')?;
        let name = file.strip_suffix(".svg")?;
        match kind {
            "icon" => {
                let icon = crate::sand::Icon::from_name(name)?;
                let png = icon.png();
                let (w, h) = png_size(png);
                // Icons are square, except the six-frame thinking strip.
                Some(embed_svg(png, 96.0 * (w as f32 / h as f32), 96.0))
            }
            "sand" => {
                let mask = crate::sand::SandMask::from_name(name)?;
                let png = mask.png();
                let (w, h) = png_size(png);
                Some(embed_svg(png, w as f32, h as f32))
            }
            "glass" if name == "thick" => Some(embed_svg(
                GLASS_TILE_PNG,
                crate::glass::TILE,
                crate::glass::TILE,
            )),
            _ => None,
        }
    }
}

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if path.starts_with("dr-ui/") {
            return Ok(Assets::svg(path).map(Cow::Owned));
        }
        match &self.fallback {
            Some(source) => source.load(path),
            None => Ok(None),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut out: Vec<SharedString> = Vec::new();
        if "dr-ui/".starts_with(path) || path.starts_with("dr-ui/") {
            out.extend(
                crate::sand::Icon::ALL
                    .iter()
                    .map(|i| i.shared_path())
                    .chain(crate::sand::SandMask::ALL.iter().map(|m| m.shared_path()))
                    .chain(std::iter::once(SharedString::new_static(GLASS_TILE_PATH)))
                    .filter(|p| p.starts_with(path)),
            );
        }
        if let Some(source) = &self.fallback {
            out.extend(source.list(path)?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sand::{Icon, SandMask};

    fn stems(dir: &str) -> Vec<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("assets")
            .join(dir);
        let mut names: Vec<String> = std::fs::read_dir(path)
            .expect("assets folder")
            .filter_map(|e| {
                let p = e.ok()?.path();
                (p.extension()? == "png").then(|| p.file_stem()?.to_str().map(str::to_string))?
            })
            .collect();
        names.sort();
        names
    }

    #[test]
    fn every_icon_file_has_a_variant() {
        let mut ours: Vec<String> = Icon::ALL.iter().map(|i| i.name().to_string()).collect();
        ours.sort();
        assert_eq!(ours, stems(Icon::DIR));
        let mut sand: Vec<String> = SandMask::ALL.iter().map(|m| m.name().to_string()).collect();
        sand.sort();
        assert_eq!(sand, stems(SandMask::DIR));
    }

    #[test]
    fn paths_round_trip_to_svgs() {
        for icon in Icon::ALL {
            let svg = Assets::svg(icon.path()).expect("an svg for every icon");
            assert!(svg.starts_with(b"<svg"));
        }
        assert!(Assets::svg(GLASS_TILE_PATH).is_some());
        assert!(Assets::svg("dr-ui/icon/not-an-icon.svg").is_none());
    }

    #[test]
    fn png_sizes_read_from_the_header() {
        assert_eq!(png_size(Icon::Close.png()), (96, 96));
        assert_eq!(png_size(Icon::Thinking.png()).0, 96 * 6);
        assert_eq!(png_size(GLASS_TILE_PNG), (320, 320));
    }
}
