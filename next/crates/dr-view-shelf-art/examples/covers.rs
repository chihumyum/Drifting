//! Every cover style for a set of books, as PNGs: the port's side of the
//! comparison with the 0.1 client's covers (drawn from the same requests).
//!
//! ```text
//! cargo run -p dr-view-shelf-art --example covers -- books.json out/ [style …]
//! ```
//!
//! `books.json` is a list of `{ "name", "seed", "chapters", "storylines":
//! [{ "color", "chapters" }], "words", "latin" }`; each cover is written as
//! `<name>-<style>.png`, sand on the paper colour.

use std::path::PathBuf;

use anyhow::{Context as _, Result};
use dr_view_shelf_art::art::{self, CoverRequest, CoverStyle, paint};

#[derive(serde::Deserialize)]
struct Book {
    name: String,
    #[serde(flatten)]
    request: CoverRequest,
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let books: Vec<Book> = serde_json::from_str(&std::fs::read_to_string(
        args.next().context("books.json")?,
    )?)?;
    let out = PathBuf::from(args.next().context("an output folder")?);
    let only: Vec<CoverStyle> = args.filter_map(|s| CoverStyle::from_slug(&s)).collect();
    std::fs::create_dir_all(&out)?;
    let (w, h) = art::SIZE;
    for book in &books {
        for style in CoverStyle::ALL {
            if !only.is_empty() && !only.contains(&style) {
                continue;
            }
            let started = std::time::Instant::now();
            let drawn = art::draw(style, &book.request);
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            let dark = matches!(drawn, art::Drawn::Art { dark: true, .. });
            let rgba = art::flatten(&drawn, paint::PAPER, [85, 82, 78]);
            let image = image::RgbaImage::from_raw(w as u32, h as u32, rgba).context("size")?;
            image.save(out.join(format!("{}-{}.png", book.name, style.slug())))?;
            println!(
                "{} {} {} {ms:.1} ms",
                book.name,
                style.slug(),
                if dark { "dark" } else { "light" }
            );
        }
    }
    Ok(())
}
