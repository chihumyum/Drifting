//! Type for the cover of characters (字海): glyph outlines from the faces
//! dr-ui ships (Drifting Serif for characters, Sarasa Mono for Latin
//! letters), read with ttf-parser and laid as tiny-skia paths, so a cover
//! is drawn off the main thread without GPUI's text system. Without the
//! fonts (a test machine that has not built them) no type is set.

use std::sync::OnceLock;

use tiny_skia::{Path, PathBuilder};

/// One face, mapped for the life of the process.
pub struct Face {
    face: ttf_parser::Face<'static>,
}

/// The faces the cover of characters sets.
pub struct Faces {
    pub serif: Face,
    pub serif_bold: Face,
    pub mono: Face,
}

fn open(dir: &std::path::Path, file: &str) -> Option<Face> {
    let file = std::fs::File::open(dir.join(file)).ok()?;
    // SAFETY: the fonts are build products nothing writes while the app
    // runs (as dr-ui maps them).
    let mapped = unsafe { memmap2::Mmap::map(&file) }.ok()?;
    let mapped: &'static memmap2::Mmap = Box::leak(Box::new(mapped));
    let face = ttf_parser::Face::parse(&mapped[..], 0).ok()?;
    Some(Face { face })
}

/// The faces, found where dr-ui finds its fonts; `None` without them.
pub fn faces() -> Option<&'static Faces> {
    static FACES: OnceLock<Option<Faces>> = OnceLock::new();
    FACES
        .get_or_init(|| {
            let dir = dr_ui::fonts::locate().ok()?;
            Some(Faces {
                serif: open(&dir, "DriftingSerif-Regular.ttf")?,
                serif_bold: open(&dir, "DriftingSerif-Bold.ttf")?,
                mono: open(&dir, "SarasaMonoSC-Regular.ttf")?,
            })
        })
        .as_ref()
}

struct Outline<'a> {
    builder: &'a mut PathBuilder,
    scale: f32,
    x: f32,
    y: f32,
}

impl Outline<'_> {
    fn at(&self, x: f32, y: f32) -> (f32, f32) {
        (self.x + x * self.scale, self.y - y * self.scale)
    }
}

impl ttf_parser::OutlineBuilder for Outline<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.at(x, y);
        self.builder.move_to(x, y);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.at(x, y);
        self.builder.line_to(x, y);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (x1, y1) = self.at(x1, y1);
        let (x, y) = self.at(x, y);
        self.builder.quad_to(x1, y1, x, y);
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (x1, y1) = self.at(x1, y1);
        let (x2, y2) = self.at(x2, y2);
        let (x, y) = self.at(x, y);
        self.builder.cubic_to(x1, y1, x2, y2, x, y);
    }

    fn close(&mut self) {
        self.builder.close();
    }
}

impl Face {
    /// `text` at `size` px centred on (`x`, `y`): across by its advance,
    /// down on the middle of the em square (the canvas's `textAlign:
    /// center`, `textBaseline: middle`).
    pub fn text_path(&self, text: &str, x: f32, y: f32, size: f32) -> Option<Path> {
        let face = &self.face;
        let scale = size / f32::from(face.units_per_em());
        let glyphs: Vec<ttf_parser::GlyphId> =
            text.chars().filter_map(|c| face.glyph_index(c)).collect();
        let advance: f32 = glyphs
            .iter()
            .map(|&g| f32::from(face.glyph_hor_advance(g).unwrap_or(0)) * scale)
            .sum();
        let baseline = y + (f32::from(face.ascender()) + f32::from(face.descender())) / 2.0 * scale;
        let mut builder = PathBuilder::new();
        let mut pen = x - advance / 2.0;
        for g in glyphs {
            let mut outline = Outline {
                builder: &mut builder,
                scale,
                x: pen,
                y: baseline,
            };
            face.outline_glyph(g, &mut outline);
            pen += f32::from(face.glyph_hor_advance(g).unwrap_or(0)) * scale;
        }
        builder.finish()
    }
}
