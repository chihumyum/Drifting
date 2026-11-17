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

            /// The path `svg()` loads it by with a circular cutout on its left
            /// (`hx = 1px` in an 18px box) or right (`hx = 17px` in an 18px
            /// box), used when overlapping moons sit `8px` apart (`W25Final`).
            pub const fn cut_left_path(self) -> &'static str {
                match self {
                    $($ty::$variant => concat!("dr-ui/", $prefix, "-cut-left/", $name, ".svg")),*
                }
            }

            pub const fn cut_right_path(self) -> &'static str {
                match self {
                    $($ty::$variant => concat!("dr-ui/", $prefix, "-cut-right/", $name, ".svg")),*
                }
            }

            pub fn cut_shared_path(self, cut_on_right: bool) -> gpui::SharedString {
                gpui::SharedString::new_static(if cut_on_right {
                    self.cut_right_path()
                } else {
                    self.cut_left_path()
                })
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

/// Carves a circular hole (`hole = 18 * 0.345`, `0.6px` soft ramp in an `18px`
/// glyph box) out of `png`'s alpha around a front glyph centered `8px` to the
/// left (`cut_on_right == false`) or right (`cut_on_right == true`) (`W25Final`).
fn cutout_png(png: &[u8], cut_on_right: bool) -> Option<Vec<u8>> {
    let mut img = image::load_from_memory(png).ok()?.into_rgba8();
    let (w, h) = img.dimensions();
    let scale_x = w as f32 / 18.0;
    let scale_y = h as f32 / 18.0;
    let hx = (if cut_on_right { 9.0 + 8.0 } else { 9.0 - 8.0 }) * scale_x;
    let hy = 9.0 * scale_y;
    let hole = (18.0 * 0.345) * scale_x;
    let soft = 0.6 * scale_x;
    for (x, y, px) in img.enumerate_pixels_mut() {
        let dist = (x as f32 + 0.5 - hx).hypot(y as f32 + 0.5 - hy);
        let keep = ((dist - hole) / soft).clamp(0.0, 1.0);
        px[3] = (px[3] as f32 * keep).round() as u8;
    }
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(out)
}

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
                // Icons are square, except the 68-frame thinking strip.
                Some(embed_svg(png, 96.0 * (w as f32 / h as f32), 96.0))
            }
            "icon-cut-left" | "icon-cut-right" => {
                let icon = crate::sand::Icon::from_name(name)?;
                let cut = cutout_png(icon.png(), kind == "icon-cut-right")?;
                let (w, h) = png_size(&cut);
                Some(embed_svg(&cut, 96.0 * (w as f32 / h as f32), 96.0))
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
        assert_eq!(png_size(Icon::Thinking.png()).0, 96 * 68);
        assert_eq!(png_size(GLASS_TILE_PNG), (320, 320));
    }

    #[test]
    fn moon_cutout_paths_carve_transparent_holes_on_requested_side() {
        for icon in [
            Icon::MoonBlackLeft,
            Icon::MoonBlackRight,
            Icon::MoonHollowfullLeft,
            Icon::MoonHollowfullRight,
            Icon::MoonLeft,
            Icon::MoonRight,
        ] {
            assert!(Assets::svg(icon.cut_left_path()).is_some());
            assert!(Assets::svg(icon.cut_right_path()).is_some());
        }
        let left_cut = cutout_png(Icon::MoonBlackLeft.png(), false).expect("left cutout");
        let left_img = image::load_from_memory(&left_cut).unwrap().into_rgba8();
        // Hole center on left: x ~ 5.33, y = 48 -> pixel (5, 48) is fully carved out; far right stays opaque.
        assert_eq!(left_img.get_pixel(5, 48)[3], 0);
        assert!(left_img.get_pixel(64, 48)[3] > 200);

        let right_cut = cutout_png(Icon::MoonBlackRight.png(), true).expect("right cutout");
        let right_img = image::load_from_memory(&right_cut).unwrap().into_rgba8();
        // Hole center on right: x ~ 90.67, y = 48 -> pixel (90, 48) is fully carved out; far left stays opaque.
        assert_eq!(right_img.get_pixel(90, 48)[3], 0);
        assert!(right_img.get_pixel(32, 48)[3] > 200);
    }
}
