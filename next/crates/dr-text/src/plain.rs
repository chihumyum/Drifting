//! Plain text: what search indexes, what export and the Agent read.
//!
//! - A paragraph's text is its runs without the embed placeholder (U+FFFC).
//!   Soft line breaks (U+2028) are kept, so one paragraph stays one line.
//! - A paragraph that is a lone embed reads as the embed's text: a table's
//!   cells, a tab between cells and U+2028 between rows (rows and columns in
//!   their stored order); a material embed has no text of its own.
//! - A document is its paragraphs' texts joined by `\n`, one line per
//!   paragraph, with no newline after the last.

use dr_doc::prose::{EmbedView, Paragraph, ProseView};
use dr_model::prose::{LINE_BREAK, OBJECT_CHAR};

/// A paragraph's runs, without embed placeholders.
pub fn paragraph_text(p: &Paragraph) -> String {
    let mut out = String::with_capacity(p.runs.iter().map(|r| r.text.len()).sum());
    for r in &p.runs {
        out.extend(r.text.chars().filter(|c| *c != OBJECT_CHAR));
    }
    out
}

/// A table's cells: a tab between the cells of a row, U+2028 between rows.
/// Anything but a table has no text.
pub fn table_text(embed: &EmbedView) -> String {
    let EmbedView::Table {
        cols, rows, cells, ..
    } = embed
    else {
        return String::new();
    };
    let mut out = String::new();
    for (i, row) in rows.iter().enumerate() {
        if i > 0 {
            out.push(LINE_BREAK);
        }
        for (j, col) in cols.iter().enumerate() {
            if j > 0 {
                out.push('\t');
            }
            if let Some(text) = cells.get(&(row.id.clone(), col.id.clone())) {
                out.push_str(text);
            }
        }
    }
    out
}

/// The plain text of one paragraph of `view`: an embed's text for a lone
/// embed placeholder, the runs otherwise.
pub fn block_text(view: &ProseView<'_>, p: &Paragraph) -> String {
    match p.embed() {
        Some(id) => view.embed(id).map(|e| table_text(&e)).unwrap_or_default(),
        None => paragraph_text(p),
    }
}

/// The whole document, one line per paragraph.
pub fn plain_text(view: &ProseView<'_>) -> String {
    let mut out = String::with_capacity(view.len_utf8());
    for (i, p) in view.paragraphs().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&block_text(view, &p));
    }
    out
}
