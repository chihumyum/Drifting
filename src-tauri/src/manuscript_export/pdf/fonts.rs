//! Font choice for the PDF: installed system faces whose licence allows
//! embedding, a serif chain per script, and bold/italic siblings (synthesised
//! when a family has none).
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use fontdb::{Database, Family, Query, Source, Stretch, Style, Weight};
use krilla::text::Font;
use rustybuzz::ttf_parser::{self, Permissions};

use super::super::text::{is_han, Language};

const HANS_SERIF: &[&str] = &[
    "Songti SC",
    "STSong",
    "Source Han Serif SC",
    "Source Han Serif CN",
    "Noto Serif CJK SC",
    "Noto Serif SC",
    "SimSun",
    "NSimSun",
    "AR PL UMing CN",
    "Source Han Sans SC",
    "Noto Sans CJK SC",
    "PingFang SC",
    "Hiragino Sans GB",
    "Microsoft YaHei",
    "WenQuanYi Zen Hei",
    "WenQuanYi Micro Hei",
];
const HANT_SERIF: &[&str] = &[
    "Songti TC",
    "Source Han Serif TC",
    "Source Han Serif TW",
    "Noto Serif CJK TC",
    "Noto Serif TC",
    "PMingLiU",
    "MingLiU",
    "LiSong Pro",
    "AR PL UMing TW",
    "PingFang TC",
    "Microsoft JhengHei",
];
const JA_SERIF: &[&str] = &[
    "Hiragino Mincho ProN",
    "Hiragino Mincho Pro",
    "Yu Mincho",
    "YuMincho",
    "Source Han Serif",
    "Source Han Serif JP",
    "Noto Serif CJK JP",
    "Noto Serif JP",
    "MS Mincho",
    "IPAexMincho",
    "Hiragino Sans",
];
const KO_SERIF: &[&str] = &[
    "AppleMyungjo",
    "Source Han Serif K",
    "Source Han Serif KR",
    "Noto Serif CJK KR",
    "Noto Serif KR",
    "Batang",
    "NanumMyeongjo",
    "Apple SD Gothic Neo",
    "Malgun Gothic",
];
const LATIN_SERIF: &[&str] = &[
    "Times New Roman",
    "Georgia",
    "Charter",
    "Iowan Old Style",
    "Palatino",
    "Book Antiqua",
    "Cambria",
    "Liberation Serif",
    "Tinos",
    "Noto Serif",
    "DejaVu Serif",
];
const SYMBOL_FALLBACK: &[&str] = &[
    "Apple Symbols",
    "Segoe UI Symbol",
    "Noto Sans Symbols",
    "Noto Sans Symbols 2",
    "Arial Unicode MS",
    "DejaVu Sans",
    "Apple Color Emoji",
    "Segoe UI Emoji",
    "Noto Color Emoji",
];

/// Installed fonts, scanned once per process.
pub(crate) fn system_fonts() -> &'static Database {
    static DATABASE: OnceLock<Database> = OnceLock::new();
    DATABASE.get_or_init(|| {
        let mut database = Database::new();
        database.load_system_fonts();
        database
    })
}

/// One loaded face. `synthetic_*` mark a regular face standing in for a
/// missing bold or italic.
pub(crate) struct Face {
    pub data: Arc<Vec<u8>>,
    pub index: u32,
    pub font: Font,
    pub units_per_em: f32,
    pub ascender: f32,
    pub descender: f32,
    pub synthetic_bold: bool,
    pub synthetic_italic: bool,
    pub family: String,
    pub post_script_name: String,
}

impl Face {
    pub(crate) fn has_glyph(&self, c: char) -> bool {
        ttf_parser::Face::parse(&self.data, self.index)
            .ok()
            .and_then(|face| face.glyph_index(c))
            .is_some()
    }
}

/// The faces of one PDF. Index 0 of `chain` is the body face.
pub(crate) struct FontSet {
    pub faces: Vec<Face>,
    /// Regular faces in fallback order.
    pub chain: Vec<usize>,
    /// The face for Latin letters and digits in a CJK book.
    pub latin: Option<usize>,
    variants: HashMap<(usize, bool, bool), usize>,
    files: HashMap<PathBuf, Arc<Vec<u8>>>,
    loaded: HashMap<fontdb::ID, usize>,
    /// Per-face coverage cache: `(face, char) -> has glyph`.
    coverage: HashMap<(usize, char), bool>,
}

fn chain_names(language: Language) -> Vec<&'static str> {
    let cjk: &[&str] = match language {
        Language::SimplifiedChinese | Language::Latin(_) => HANS_SERIF,
        Language::TraditionalChinese => HANT_SERIF,
        Language::Japanese => JA_SERIF,
        Language::Korean => KO_SERIF,
    };
    let mut names: Vec<&'static str> = Vec::new();
    if language.is_cjk() {
        names.extend(cjk);
        names.extend(LATIN_SERIF);
    } else {
        names.extend(LATIN_SERIF);
        names.extend(cjk);
    }
    // Other CJK scripts last, so stray characters still find a glyph.
    for list in [HANS_SERIF, HANT_SERIF, JA_SERIF, KO_SERIF] {
        for name in list {
            if !names.contains(name) {
                names.push(name);
            }
        }
    }
    names.extend(SYMBOL_FALLBACK);
    names
}

impl FontSet {
    pub(crate) fn resolve(
        database: &Database,
        language: Language,
        preferred: Option<&str>,
    ) -> Result<Self, String> {
        let mut set = FontSet {
            faces: Vec::new(),
            chain: Vec::new(),
            latin: None,
            variants: HashMap::new(),
            files: HashMap::new(),
            loaded: HashMap::new(),
            coverage: HashMap::new(),
        };
        let preferred = preferred
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .and_then(|name| set.load_family(database, name));
        for name in chain_names(language) {
            if let Some(face) = set.load_family(database, name) {
                if !set.chain.contains(&face) {
                    set.chain.push(face);
                }
            }
        }
        if language.is_cjk() {
            let cjk_probe = match language {
                Language::Korean => '한',
                Language::Japanese => 'あ',
                _ => '永',
            };
            // The body face must actually cover the book's script.
            let body = preferred
                .filter(|&face| set.faces[face].has_glyph(cjk_probe))
                .or_else(|| {
                    set.chain
                        .iter()
                        .copied()
                        .find(|&face| set.faces[face].has_glyph(cjk_probe))
                })
                .ok_or_else(|| "no installed font can typeset this book's script".to_string())?;
            set.chain.retain(|&face| face != body);
            set.chain.insert(0, body);
            set.latin = preferred
                .filter(|&face| set.faces[face].has_glyph('a'))
                .or_else(|| {
                    LATIN_SERIF
                        .iter()
                        .find_map(|name| set.load_family(database, name))
                });
        } else {
            let body = preferred
                .filter(|&face| set.faces[face].has_glyph('a'))
                .or_else(|| {
                    set.chain
                        .iter()
                        .copied()
                        .find(|&face| set.faces[face].has_glyph('a'))
                })
                .or_else(|| {
                    let query = Query {
                        families: &[Family::Serif],
                        ..Query::default()
                    };
                    database
                        .query(&query)
                        .and_then(|id| set.load_id(database, id, false, false))
                })
                .ok_or_else(|| "no installed font can typeset this book".to_string())?;
            set.chain.retain(|&face| face != body);
            set.chain.insert(0, body);
        }
        Ok(set)
    }

    fn file(&mut self, database: &Database, id: fontdb::ID) -> Option<Arc<Vec<u8>>> {
        let face = database.face(id)?;
        match &face.source {
            Source::File(path) => {
                if let Some(data) = self.files.get(path) {
                    return Some(data.clone());
                }
                let data = Arc::new(std::fs::read(path).ok()?);
                self.files.insert(path.clone(), data.clone());
                Some(data)
            }
            _ => database.with_face_data(id, |data, _| Arc::new(data.to_vec())),
        }
    }

    fn load_id(
        &mut self,
        database: &Database,
        id: fontdb::ID,
        synthetic_bold: bool,
        synthetic_italic: bool,
    ) -> Option<usize> {
        if !synthetic_bold && !synthetic_italic {
            if let Some(&face) = self.loaded.get(&id) {
                return Some(face);
            }
        }
        let info = database.face(id)?;
        let data = self.file(database, id)?;
        let parsed = ttf_parser::Face::parse(&data, info.index).ok()?;
        // Respect the font's embedding licence (OS/2 fsType).
        if matches!(parsed.permissions(), Some(Permissions::Restricted))
            || !parsed.is_subsetting_allowed()
        {
            return None;
        }
        let units_per_em = f32::from(parsed.units_per_em());
        let ascender = f32::from(parsed.ascender()) / units_per_em;
        let descender = f32::from(parsed.descender()) / units_per_em;
        let font = Font::new(data.clone().into(), info.index)?;
        let face = Face {
            data,
            index: info.index,
            font,
            units_per_em,
            ascender,
            descender,
            synthetic_bold,
            synthetic_italic,
            family: info
                .families
                .first()
                .map(|(name, _)| name.clone())
                .unwrap_or_default(),
            post_script_name: info.post_script_name.clone(),
        };
        self.faces.push(face);
        let index = self.faces.len() - 1;
        if !synthetic_bold && !synthetic_italic {
            self.loaded.insert(id, index);
        }
        Some(index)
    }

    fn load_family(&mut self, database: &Database, name: &str) -> Option<usize> {
        let query = Query {
            families: &[Family::Name(name)],
            weight: Weight::NORMAL,
            stretch: Stretch::Normal,
            style: Style::Normal,
        };
        let id = database.query(&query)?;
        let info = database.face(id)?;
        // fontdb falls back to any face; only accept the family we asked for.
        if !info
            .families
            .iter()
            .any(|(family, _)| family.eq_ignore_ascii_case(name))
        {
            return None;
        }
        self.load_id(database, id, false, false)
    }

    pub(crate) fn has_glyph(&mut self, face: usize, c: char) -> bool {
        if let Some(&known) = self.coverage.get(&(face, c)) {
            return known;
        }
        let known = self.faces[face].has_glyph(c);
        self.coverage.insert((face, c), known);
        known
    }

    /// The regular face for one character of the book.
    pub(crate) fn face_for(&mut self, c: char, latin_context: bool, cjk_book: bool) -> usize {
        let body = self.chain[0];
        if cjk_book {
            if let Some(latin) = self.latin {
                if latin_context && self.has_glyph(latin, c) {
                    return latin;
                }
            }
        }
        if self.has_glyph(body, c) {
            return body;
        }
        let chain = self.chain.clone();
        chain
            .into_iter()
            .find(|&face| self.has_glyph(face, c))
            .unwrap_or(body)
    }

    /// The bold/italic sibling of a regular face, synthesised if missing.
    pub(crate) fn variant(
        &mut self,
        database: &Database,
        base: usize,
        bold: bool,
        italic: bool,
    ) -> usize {
        if !bold && !italic {
            return base;
        }
        if let Some(&face) = self.variants.get(&(base, bold, italic)) {
            return face;
        }
        let family = self.faces[base].family.clone();
        let query = Query {
            families: &[Family::Name(&family)],
            weight: if bold { Weight::BOLD } else { Weight::NORMAL },
            stretch: Stretch::Normal,
            style: if italic { Style::Italic } else { Style::Normal },
        };
        let real = database.query(&query).and_then(|id| {
            let info = database.face(id)?;
            let weight_ok = !bold || info.weight.0 >= 600;
            let style_ok = !italic || info.style != Style::Normal;
            let same_family = info.families.iter().any(|(name, _)| name == &family);
            (weight_ok
                && style_ok
                && same_family
                && info.post_script_name != self.faces[base].post_script_name)
                .then_some(id)
        });
        let face = match real.and_then(|id| self.load_id(database, id, false, false)) {
            Some(face) => {
                // A real bold face may still lack italics (and vice versa).
                let (bold_missing, italic_missing) = {
                    let info = real.and_then(|id| database.face(id));
                    (
                        bold && info.is_none_or(|info| info.weight.0 < 600),
                        italic && info.is_none_or(|info| info.style == Style::Normal),
                    )
                };
                if bold_missing || italic_missing {
                    self.synthetic(base, bold_missing, italic_missing)
                        .unwrap_or(face)
                } else {
                    face
                }
            }
            None => {
                // Try a real bold with a synthetic slant before faking both.
                let bold_face = if bold && italic {
                    Some(self.variant(database, base, true, false))
                        .filter(|&face| !self.faces[face].synthetic_bold)
                } else {
                    None
                };
                match bold_face {
                    Some(bold_face) => self.synthetic(bold_face, false, true).unwrap_or(base),
                    None => self.synthetic(base, bold, italic).unwrap_or(base),
                }
            }
        };
        self.variants.insert((base, bold, italic), face);
        face
    }

    fn synthetic(&mut self, base: usize, bold: bool, italic: bool) -> Option<usize> {
        let source = &self.faces[base];
        let face = Face {
            data: source.data.clone(),
            index: source.index,
            font: source.font.clone(),
            units_per_em: source.units_per_em,
            ascender: source.ascender,
            descender: source.descender,
            synthetic_bold: source.synthetic_bold || bold,
            synthetic_italic: source.synthetic_italic || italic,
            family: source.family.clone(),
            post_script_name: source.post_script_name.clone(),
        };
        self.faces.push(face);
        Some(self.faces.len() - 1)
    }

    /// Whether a character belongs to Latin-script text (letters and digits).
    pub(crate) fn is_latin_char(c: char) -> bool {
        c.is_ascii_alphanumeric()
            || matches!(c, '\u{00c0}'..='\u{024f}' | '\u{0370}'..='\u{03ff}' | '\u{0400}'..='\u{04ff}' | '\u{1e00}'..='\u{1eff}')
                && c.is_alphabetic()
    }

    /// Whether the character is CJK text or CJK punctuation.
    pub(crate) fn is_cjk_char(c: char) -> bool {
        is_han(c)
            || matches!(c,
                '\u{3000}'..='\u{303f}'
                | '\u{3040}'..='\u{30ff}'
                | '\u{31f0}'..='\u{31ff}'
                | '\u{ac00}'..='\u{d7af}'
                | '\u{1100}'..='\u{11ff}'
                | '\u{ff00}'..='\u{ffef}'
                | '\u{fe30}'..='\u{fe4f}')
    }
}
