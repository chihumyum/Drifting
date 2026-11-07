//! The project's own design assets (white alpha masks in `src/assets/design/`,
//! see `ASSET_PROVENANCE.md`), read where they are in the repository, and the
//! SVGs the prototype serves to GPUI's `svg()` element.

use std::{borrow::Cow, collections::HashMap, path::PathBuf, sync::Arc, time::Instant};

use anyhow::{Context as _, Result};
use base64::Engine as _;
use gpui::{AssetSource, SharedString};

/// A white alpha mask: one byte per pixel, row by row.
#[derive(Clone)]
pub struct Mask {
    pub width: u32,
    pub height: u32,
    pub alpha: Vec<u8>,
    /// The PNG as stored, for SVG wrappers.
    pub png: Arc<Vec<u8>>,
}

impl Mask {
    pub fn decode(png: Vec<u8>) -> Result<Mask> {
        let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png)?.to_rgba8();
        let (width, height) = image.dimensions();
        let alpha = image.pixels().map(|p| p.0[3]).collect();
        Ok(Mask {
            width,
            height,
            alpha,
            png: Arc::new(png),
        })
    }

    /// Bilinear sample at (x, y) in mask pixels, wrapping (for tiled textures).
    pub fn sample_wrapped(&self, x: f32, y: f32) -> f32 {
        let w = self.width as i32;
        let h = self.height as i32;
        let x0 = x.floor();
        let y0 = y.floor();
        let tx = x - x0;
        let ty = y - y0;
        let at = |xi: i32, yi: i32| {
            let xi = xi.rem_euclid(w);
            let yi = yi.rem_euclid(h);
            self.alpha[(yi * w + xi) as usize] as f32 / 255.0
        };
        let (xi, yi) = (x0 as i32, y0 as i32);
        let a = at(xi, yi) * (1.0 - tx) + at(xi + 1, yi) * tx;
        let b = at(xi, yi + 1) * (1.0 - tx) + at(xi + 1, yi + 1) * tx;
        a * (1.0 - ty) + b * ty
    }

    pub fn mean(&self) -> f32 {
        self.alpha.iter().map(|&a| a as f32).sum::<f32>() / (255.0 * self.alpha.len() as f32)
    }
}

/// Where the renderer keeps its design assets, from this crate's manifest.
pub fn design_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../src/assets/design")
}

pub struct Assets {
    pub glass_thick: Mask,
    pub glass_ring: Mask,
    pub glass_ring_dark: Mask,
    /// Icon names, sorted, and their masks.
    pub icon_names: Vec<String>,
    pub icons: HashMap<String, Mask>,
    pub sand: HashMap<String, Mask>,
    /// How long reading and decoding all the PNGs took.
    pub load_ms: f64,
}

impl Assets {
    pub fn load() -> Result<Assets> {
        let started = Instant::now();
        let dir = design_dir();
        let read = |path: PathBuf| -> Result<Mask> {
            let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            Mask::decode(bytes)
        };
        let folder = |name: &str| -> Result<HashMap<String, Mask>> {
            let mut out = HashMap::new();
            for entry in std::fs::read_dir(dir.join(name))? {
                let path = entry?.path();
                if path.extension().and_then(|e| e.to_str()) != Some("png") {
                    continue;
                }
                let stem = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string();
                out.insert(stem, read(path)?);
            }
            Ok(out)
        };
        let icons = folder("icons")?;
        let mut icon_names: Vec<String> = icons.keys().cloned().collect();
        icon_names.sort();
        let assets = Assets {
            glass_thick: read(dir.join("glass-thick.png"))?,
            glass_ring: read(dir.join("glass-ring.png"))?,
            glass_ring_dark: read(dir.join("glass-ring-dark.png"))?,
            icon_names,
            icons,
            sand: folder("sand")?,
            load_ms: 0.0,
        };
        Ok(Assets {
            load_ms: started.elapsed().as_secs_f64() * 1000.0,
            ..assets
        })
    }

    pub fn icon(&self, name: &str) -> &Mask {
        self.icons
            .get(name)
            .or_else(|| self.icons.get("close"))
            .expect("the icon set has a close icon")
    }

    pub fn sand(&self, name: &str) -> &Mask {
        self.sand
            .get(name)
            .or_else(|| self.sand.get("blob-0"))
            .expect("the sand set has blob-0")
    }
}

/// An SVG whose only content is the PNG, so GPUI's `svg()` (resvg, then the
/// alpha channel as a monochrome sprite) draws the bitmap mask in any colour.
pub fn embed_svg(mask: &Mask, view_w: f32, view_h: f32) -> Vec<u8> {
    let data = base64::engine::general_purpose::STANDARD.encode(mask.png.as_slice());
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{view_w}" height="{view_h}" viewBox="0 0 {view_w} {view_h}"><image width="{view_w}" height="{view_h}" preserveAspectRatio="none" xlink:href="data:image/png;base64,{data}"/></svg>"#
    )
    .into_bytes()
}

/// The SVGs GPUI's `svg()` asks for, built once before the app starts.
pub struct SvgAssets {
    files: HashMap<String, Cow<'static, [u8]>>,
}

impl SvgAssets {
    pub fn new(files: HashMap<String, Vec<u8>>) -> SvgAssets {
        SvgAssets {
            files: files.into_iter().map(|(k, v)| (k, Cow::Owned(v))).collect(),
        }
    }
}

impl AssetSource for SvgAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(self.files.get(path).cloned())
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(self
            .files
            .keys()
            .filter(|k| k.starts_with(path))
            .map(|k| SharedString::from(k.clone()))
            .collect())
    }
}

/// Paths of the generated SVGs.
pub fn icon_embed_path(name: &str) -> SharedString {
    format!("icon/embed/{name}.svg").into()
}

pub fn icon_vector_path(name: &str) -> SharedString {
    format!("icon/vector/{name}.svg").into()
}

pub fn sand_embed_path(name: &str) -> SharedString {
    format!("sand/{name}.svg").into()
}

pub const GLASS_TILE_PATH: &str = "glass/thick.svg";
pub const GLASS_RING_TILE_PATH: &str = "glass/ring.svg";
