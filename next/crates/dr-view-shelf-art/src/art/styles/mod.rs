//! The shelf's cover styles, in the order the shelf's button turns through
//! them (the 0.1 client's `lib/shelf-cover/styles.ts`). Sand is drawn as
//! masks coloured when shown ([`crate::art::sand`]); every other style
//! paints the whole cover.

pub mod bauhaus;
pub mod chars;
pub mod cutout;
pub mod cyanotype;
pub mod field;
pub mod quipu;
pub mod ridge;
pub mod rings;
pub mod riso;
pub mod stars;
pub mod strata;
pub mod topo;
pub mod weave;

use super::book::ArtStyle;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CoverStyle {
    Sand,
    Ridge,
    Quipu,
    Weave,
    Topo,
    Cyanotype,
    Rings,
    Field,
    Cutout,
    Riso,
    Stars,
    Strata,
    Bauhaus,
    Chars,
}

impl CoverStyle {
    /// In the order the button turns through them.
    pub const ALL: [CoverStyle; 14] = [
        CoverStyle::Sand,
        CoverStyle::Ridge,
        CoverStyle::Quipu,
        CoverStyle::Weave,
        CoverStyle::Topo,
        CoverStyle::Cyanotype,
        CoverStyle::Rings,
        CoverStyle::Field,
        CoverStyle::Cutout,
        CoverStyle::Riso,
        CoverStyle::Stars,
        CoverStyle::Strata,
        CoverStyle::Bauhaus,
        CoverStyle::Chars,
    ];

    pub const DEFAULT: CoverStyle = CoverStyle::Topo;

    /// The 0.1 client's id (`shelf:cover-style`, the strings' names).
    pub const fn slug(self) -> &'static str {
        match self {
            CoverStyle::Sand => "sand",
            CoverStyle::Ridge => "ridge",
            CoverStyle::Quipu => "quipu",
            CoverStyle::Weave => "weave",
            CoverStyle::Topo => "topo",
            CoverStyle::Cyanotype => "cyanotype",
            CoverStyle::Rings => "rings",
            CoverStyle::Field => "field",
            CoverStyle::Cutout => "cutout",
            CoverStyle::Riso => "riso",
            CoverStyle::Stars => "stars",
            CoverStyle::Strata => "strata",
            CoverStyle::Bauhaus => "bauhaus",
            CoverStyle::Chars => "chars",
        }
    }

    pub fn from_slug(slug: &str) -> Option<CoverStyle> {
        CoverStyle::ALL.into_iter().find(|s| s.slug() == slug)
    }

    /// The style the button turns to next.
    pub fn next(self) -> CoverStyle {
        let i = CoverStyle::ALL.iter().position(|&s| s == self).unwrap_or(0);
        CoverStyle::ALL[(i + 1) % CoverStyle::ALL.len()]
    }

    /// What paints the whole cover; `None` for sand.
    pub fn art(self) -> Option<ArtStyle> {
        Some(match self {
            CoverStyle::Sand => return None,
            CoverStyle::Ridge => ridge::draw,
            CoverStyle::Quipu => quipu::draw,
            CoverStyle::Weave => weave::draw,
            CoverStyle::Topo => topo::draw,
            CoverStyle::Cyanotype => cyanotype::draw,
            CoverStyle::Rings => rings::draw,
            CoverStyle::Field => field::draw,
            CoverStyle::Cutout => cutout::draw,
            CoverStyle::Riso => riso::draw,
            CoverStyle::Stars => stars::draw,
            CoverStyle::Strata => strata::draw,
            CoverStyle::Bauhaus => bauhaus::draw,
            CoverStyle::Chars => chars::draw,
        })
    }
}
