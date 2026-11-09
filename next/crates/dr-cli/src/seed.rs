//! Entry points only: all corpora and generation remain in dr-testkit.
use dr_testkit::seed::{self, Preset};
#[derive(Clone, Copy)]
pub struct Choice {
    pub preset: Preset,
    pub v3: bool,
}
pub struct Report {
    pub documents: usize,
    pub books: usize,
    pub fingerprint: String,
}
impl Choice {
    pub fn parse(name: &str) -> Option<Self> {
        let (name, v3) = name
            .strip_prefix("v3-")
            .map_or((name, false), |name| (name, true));
        Some(Self {
            preset: Preset::parse(name)?,
            v3,
        })
    }
    pub fn write_to(self, library: &dr_store::Library) -> Result<Report, String> {
        if self.v3 {
            let made =
                seed::generate_v3(self.preset, seed::DEFAULT_SEED).map_err(|e| e.to_string())?;
            Ok(Report {
                documents: made.write_to(library).map_err(|e| e.to_string())?,
                books: made.books.len(),
                fingerprint: made.shape().corpus_fingerprint,
            })
        } else {
            let made =
                seed::generate(self.preset, seed::DEFAULT_SEED).map_err(|e| e.to_string())?;
            Ok(Report {
                documents: made.write_to(library).map_err(|e| e.to_string())?,
                books: made.books.len(),
                fingerprint: made.shape().corpus_fingerprint,
            })
        }
    }
}
