//! The fonts and the role each one plays (typography.md).
//!
//! GPUI on macOS cannot fall back to a font it loaded from memory, and it
//! picks weights among static faces only. So every family here is a set of
//! static faces that carry both their Latin and their Chinese glyphs, and
//! no text in the interface relies on fallback (Zed's Chinese fallback
//! breaks italics and every weight but 400).
//!
//! | Role | Family | Built from | Faces |
//! | --- | --- | --- | --- |
//! | Interface, entities | Drifting Sans | Source Sans 3 + Noto Sans SC | 400 500 600 |
//! | Structure, prose | Drifting Serif | Newsreader 16pt + Noto Serif SC | 400 700 |
//! | Index | Sarasa Mono SC | unchanged | 400 |
//!
//! The fonts are a build product and never in git: `script/build-fonts.py`
//! downloads the pinned sources in `assets/fonts/provenance.json`, checks
//! them and writes the faces to `next/.cache/fonts`. At start [`register`]
//! finds them (see [`locate`]), maps them into memory and hands them to GPUI;
//! a release bundle carries them in its resources. Without them nothing is
//! drawn in a fallback face: [`register`] fails and says what to run.
//!
//! All three are under the SIL Open Font License 1.1 (`assets/fonts/OFL-1.1.txt`),
//! not the client's AGPL.

use std::{
    borrow::Cow,
    fmt,
    path::{Path, PathBuf},
};

use gpui::{App, Font, FontFeatures, FontStyle, FontWeight, SharedString, font};

pub const SANS: &str = "Drifting Sans";
pub const SERIF: &str = "Drifting Serif";
pub const MONO: &str = "Sarasa Mono SC";

/// Every face dr-ui loads, by file name.
pub const FACES: [&str; 6] = [
    "DriftingSans-Regular.ttf",
    "DriftingSans-Medium.ttf",
    "DriftingSans-SemiBold.ttf",
    "DriftingSerif-Regular.ttf",
    "DriftingSerif-Bold.ttf",
    "SarasaMonoSC-Regular.ttf",
];

/// Points dr-ui at a folder of fonts, before anything else is tried.
pub const DIR_ENV: &str = "DRIFTING_FONTS_DIR";

/// What to run when the fonts are missing.
pub const BUILD_COMMAND: &str = "python3 crates/dr-ui/script/build-fonts.py";

/// The fonts were not found or could not be read.
#[derive(Debug)]
pub struct FontsMissing {
    /// Every folder that was tried, in order.
    pub looked_in: Vec<PathBuf>,
    /// What went wrong in the folder that had some of them, if any.
    pub problem: Option<String>,
}

impl fmt::Display for FontsMissing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            f,
            "dr-ui: the interface fonts are missing, so nothing would be drawn in the right face."
        )?;
        if let Some(problem) = &self.problem {
            writeln!(f, "  {problem}")?;
        }
        writeln!(
            f,
            "  Build them once (needs fontTools 4.60.1: python3 -m pip install fonttools==4.60.1):"
        )?;
        writeln!(f, "    cd next && {BUILD_COMMAND}")?;
        writeln!(
            f,
            "  or point {DIR_ENV} at a folder that holds them. Looked in:"
        )?;
        for dir in &self.looked_in {
            writeln!(f, "    {}", dir.display())?;
        }
        Ok(())
    }
}

impl std::error::Error for FontsMissing {}

/// The folders fonts are looked for in, in order: `DRIFTING_FONTS_DIR`; a
/// macOS bundle's `Contents/Resources/fonts`; `fonts` next to the
/// executable (an installed Windows app); then, for anything built in a
/// workspace's `target/` (the app, examples, tests), the workspace's
/// `.cache/fonts`.
pub fn candidates() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = std::env::var_os(DIR_ENV).filter(|d| !d.is_empty()) {
        dirs.push(PathBuf::from(dir));
    }
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        dirs.push(exe_dir.join("../Resources/fonts"));
        dirs.push(exe_dir.join("fonts"));
        // Built in a workspace: next/target/<profile>/… → next/.cache/fonts.
        if let Some(workspace) = exe_dir
            .ancestors()
            .find(|a| a.file_name().is_some_and(|n| n == "target"))
            .and_then(Path::parent)
        {
            dirs.push(workspace.join(".cache/fonts"));
        }
    }
    dirs
}

/// The first folder that holds every face.
pub fn locate() -> Result<PathBuf, FontsMissing> {
    let looked_in = candidates();
    for dir in &looked_in {
        if FACES.iter().all(|face| dir.join(face).is_file()) {
            return Ok(dir.clone());
        }
    }
    let problem = looked_in.iter().find_map(|dir| {
        let missing: Vec<&str> = FACES
            .iter()
            .copied()
            .filter(|face| !dir.join(face).is_file())
            .collect();
        (missing.len() < FACES.len()).then(|| {
            format!(
                "{} holds only some of them; missing: {}",
                dir.display(),
                missing.join(", ")
            )
        })
    });
    Err(FontsMissing { looked_in, problem })
}

/// Maps one face into memory for the life of the process. GPUI reads it in
/// place: pages come in as glyphs are drawn, so starting costs nothing
/// like reading 72 MB.
fn map(path: &Path) -> Result<&'static [u8], String> {
    let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    // SAFETY: the fonts are build products in a cache or a bundle; nothing
    // writes them while the app runs. A face that changed underneath would
    // only draw wrong glyphs.
    let mapped =
        unsafe { memmap2::Mmap::map(&file) }.map_err(|e| format!("{}: {e}", path.display()))?;
    if mapped.len() < 4 || mapped[..4] != [0, 1, 0, 0] {
        return Err(format!("{} is not a TrueType font", path.display()));
    }
    let mapped: &'static memmap2::Mmap = Box::leak(Box::new(mapped));
    Ok(&mapped[..])
}

/// Finds the faces, maps them and hands them to GPUI's text system.
pub fn register(cx: &App) -> Result<PathBuf, FontsMissing> {
    let dir = locate()?;
    let mut faces = Vec::with_capacity(FACES.len());
    for face in FACES {
        let bytes = map(&dir.join(face)).map_err(|problem| FontsMissing {
            looked_in: vec![dir.clone()],
            problem: Some(problem),
        })?;
        faces.push(Cow::Borrowed(bytes));
    }
    cx.text_system()
        .add_fonts(faces)
        .map_err(|e| FontsMissing {
            looked_in: vec![dir.clone()],
            problem: Some(format!("GPUI could not load them: {e:#}")),
        })?;
    Ok(dir)
}

/// What a piece of text is (typography.md, 「字体按信息角色分工」).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Role {
    /// Controls, entity names, comments: Drifting Sans.
    Ui,
    /// Places and the things that organise others: panel tabs, storylines,
    /// categories, acts, section titles. Drifting Serif, regular weight.
    Structure,
    /// Counts, filters, states, metadata: Sarasa Mono SC.
    Index,
    /// The manuscript's default face: Drifting Serif.
    Prose,
}

impl Role {
    pub const fn family(self) -> &'static str {
        match self {
            Role::Ui => SANS,
            Role::Structure | Role::Prose => SERIF,
            Role::Index => MONO,
        }
    }

    pub fn shared_family(self) -> SharedString {
        SharedString::new_static(self.family())
    }

    /// A GPUI font for this role at `weight`.
    pub fn font(self, weight: FontWeight) -> Font {
        let mut f = font(self.family());
        f.weight = weight;
        f.style = FontStyle::Normal;
        f.features = FontFeatures::default();
        f
    }
}

/// The weights the bundle carries. Asking for another snaps to the nearest
/// of these the way CSS does (600 and up → the heaviest).
pub mod weight {
    use gpui::FontWeight;

    pub const REGULAR: FontWeight = FontWeight::NORMAL;
    pub const MEDIUM: FontWeight = FontWeight::MEDIUM;
    /// Drifting Sans' heaviest face: hover-card titles, emphasis.
    pub const SEMIBOLD: FontWeight = FontWeight::SEMIBOLD;
    /// Drifting Serif's bold (prose emphasis and headings).
    pub const BOLD: FontWeight = FontWeight::BOLD;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CI builds the fonts first and sets `DR_UI_REQUIRE_FONTS=1`; elsewhere
    /// a checkout without them skips this check.
    #[test]
    fn the_built_faces_are_where_the_loader_looks() {
        match locate() {
            Ok(dir) => {
                for face in FACES {
                    let bytes = std::fs::read(dir.join(face)).expect("readable");
                    assert_eq!(&bytes[..4], &[0, 1, 0, 0], "{face} is not TrueType");
                    assert!(bytes.len() > 1_000_000, "{face} is suspiciously small");
                }
            }
            Err(missing) if std::env::var_os("DR_UI_REQUIRE_FONTS").is_some() => {
                panic!("{missing}")
            }
            Err(_) => eprintln!("fonts not built here; skipped (run {BUILD_COMMAND})"),
        }
    }

    #[test]
    fn the_error_says_what_to_run() {
        let text = FontsMissing {
            looked_in: vec![PathBuf::from("nowhere/fonts")],
            problem: None,
        }
        .to_string();
        assert!(text.contains(BUILD_COMMAND));
        assert!(text.contains(DIR_ENV));
        assert!(text.contains("nowhere/fonts"));
    }
}
