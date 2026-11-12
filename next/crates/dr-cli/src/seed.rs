//! Entry points only: all corpora and generation remain in dr-testkit.
use dr_testkit::seed::{self, Preset};
#[derive(Clone, Copy)]
pub struct Choice {
    pub preset: Preset,
}
pub struct Report {
    pub documents: usize,
    pub books: usize,
    pub fingerprint: String,
}
impl Choice {
    pub fn parse(name: &str) -> Option<Self> {
        Some(Self {
            preset: Preset::parse(name)?,
        })
    }
    pub fn write_to(self, library: &dr_store::Library) -> Result<Report, String> {
        let made = seed::generate_v3(self.preset, seed::DEFAULT_SEED).map_err(|e| e.to_string())?;
        Ok(Report {
            documents: made.write_to(library).map_err(|e| e.to_string())?,
            books: made.books.len(),
            fingerprint: made.shape().corpus_fingerprint,
        })
    }
}
