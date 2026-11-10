//! Tables on the clipboard.
//!
//! GPUI's clipboard carries text (and JSON metadata alongside it), not
//! HTML, so a table travels as tab-separated text, which spreadsheets read
//! and write: a field holding a tab, a line break or a quote is quoted, its
//! quotes doubled, a cell's U+2028 written as a line break inside the
//! quotes. Drifting's own copy also puts the cells in the metadata
//! ([`TABLE_KEY`]), so a table copied from a note pastes as a table even if
//! a cell holds a tab, and each cell's inline marks ([`MARKS_KEY`]: bold,
//! a highlight, a link …), so they come back with it. Text from elsewhere
//! pastes plain.
//!
//! When text is a table: [`parse_grid`] reads any tab-separated text; the
//! note decides by size (a grid pasted into a cell fills from there; into
//! the text, only a rectangle of at least 2 × 2 becomes a table, so a line
//! with a tab in it stays text).

use gpui::ClipboardItem;
use loro::LoroValue;
use serde_json::json;

use super::CELL_BREAK;

/// The metadata key of a copied table: `{"drifting_table": [[cell, …], …]}`.
pub const TABLE_KEY: &str = "drifting_table";

/// The metadata key of its cells' marks, shaped as the cells: each cell's
/// `[[start, end, key, value], …]` (characters of the cell).
pub const MARKS_KEY: &str = "drifting_table_marks";

/// One inline mark of a cell: its characters (start, end), key and value.
pub type CellMark = (usize, usize, String, LoroValue);

/// Each cell's marks, row by row, as the cells are laid out (a missing row
/// or cell has none).
pub type GridMarks = Vec<Vec<Vec<CellMark>>>;

/// The marks of cell (`row`, `col`) of `marks`.
pub fn marks_at(marks: &GridMarks, row: usize, col: usize) -> &[CellMark] {
    marks
        .get(row)
        .and_then(|r| r.get(col))
        .map_or(&[], Vec::as_slice)
}

fn quote(field: &str) -> String {
    let field = field.replace(CELL_BREAK, "\n");
    if field.contains(['\t', '\n', '\r', '"']) {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field
    }
}

/// `cells` (rows of cell texts) as tab-separated text.
pub fn to_tsv(cells: &[Vec<String>]) -> String {
    cells
        .iter()
        .map(|row| row.iter().map(|c| quote(c)).collect::<Vec<_>>().join("\t"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The clipboard item for a copied table: the text, the cells and their
/// marks.
pub fn table_item(cells: &[Vec<String>], marks: &GridMarks) -> Result<ClipboardItem, String> {
    for (r, row) in marks.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            let text = cells
                .get(r)
                .and_then(|r| r.get(c))
                .ok_or("table marks outside cells")?;
            crate::clipboard::validate(text, cell)?;
        }
    }
    let marks = marks
        .iter()
        .map(|row| {
            row.iter()
                .map(|cell| crate::clipboard::encode_marks(cell))
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ClipboardItem::new_string_with_json_metadata(
        to_tsv(cells),
        json!({ TABLE_KEY: cells, "drifting_table_marks_v3": marks }),
    ))
}

pub fn table_from_clipboard(item: &ClipboardItem) -> Option<Vec<Vec<String>>> {
    serde_json::from_value(crate::clipboard::metadata(item)?.get(TABLE_KEY)?.clone()).ok()
}

/// A malformed rich item is an error, never permission to discard its marks.
pub fn marks_from_clipboard(item: &ClipboardItem) -> Result<GridMarks, String> {
    let Some(m) = crate::clipboard::metadata_checked(item)? else {
        return Ok(Vec::new());
    };
    let marks = if let Some(typed) = m.get("drifting_table_marks_v3") {
        typed
            .as_array()
            .ok_or("invalid table marks")?
            .iter()
            .map(|r| {
                r.as_array()
                    .ok_or_else(|| "invalid table row marks".to_owned())?
                    .iter()
                    .map(crate::clipboard::decode_marks)
                    .collect::<Result<Vec<_>, _>>()
            })
            .collect::<Result<Vec<_>, _>>()?
    } else if let Some(legacy) = m.get(MARKS_KEY) {
        serde_json::from_value(legacy.clone()).map_err(|e| e.to_string())?
    } else {
        return Ok(Vec::new());
    };
    if let Some(cells) = table_from_clipboard(item) {
        for (r, row) in marks.iter().enumerate() {
            for (c, cell) in row.iter().enumerate() {
                let text = cells
                    .get(r)
                    .and_then(|r| r.get(c))
                    .ok_or("table marks outside cells")?;
                crate::clipboard::validate(text, cell)?;
            }
        }
    }
    Ok(marks)
}

/// Tab-separated text as rows of cells (quoted fields as spreadsheets
/// write them; a trailing line break ends the last row). `None` without a
/// tab: plain lines are text, not a table.
pub fn parse_grid(text: &str) -> Option<Vec<Vec<String>>> {
    if !text.contains('\t') {
        return None;
    }
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut chars = text.chars().peekable();
    let mut at_field_start = true;
    while let Some(c) = chars.next() {
        match c {
            '"' if at_field_start => {
                // A quoted field: up to the lone closing quote.
                while let Some(q) = chars.next() {
                    if q == '"' {
                        if chars.peek() == Some(&'"') {
                            chars.next();
                            field.push('"');
                        } else {
                            break;
                        }
                    } else {
                        field.push(q);
                    }
                }
                at_field_start = false;
            }
            '\t' => {
                row.push(std::mem::take(&mut field));
                at_field_start = true;
            }
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                at_field_start = true;
            }
            c => {
                field.push(c);
                at_field_start = false;
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    (!rows.is_empty()).then_some(rows)
}

/// Whether pasted text should become a new table in a note's text: a
/// rectangle of at least 2 × 2.
pub fn is_table(grid: &[Vec<String>]) -> bool {
    grid.len() >= 2 && grid[0].len() >= 2 && grid.iter().all(|r| r.len() == grid[0].len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(rows: &[&[&str]]) -> Vec<Vec<String>> {
        rows.iter()
            .map(|r| r.iter().map(|c| c.to_string()).collect())
            .collect()
    }

    #[test]
    fn tsv_round_trips_with_breaks_tabs_and_quotes() {
        let cells = grid(&[
            &["人物", "年龄"],
            &["阿Q\u{2028}未庄", "说\"不知道\""],
            &["", "a\tb"],
        ]);
        let text = to_tsv(&cells);
        assert_eq!(
            text,
            "人物\t年龄\n\"阿Q\n未庄\"\t\"说\"\"不知道\"\"\"\n\t\"a\tb\""
        );
        let back = parse_grid(&text).unwrap();
        assert_eq!(
            back[1][0], "阿Q\n未庄",
            "a cell's break comes back as a line"
        );
        assert_eq!(back[1][1], "说\"不知道\"");
        assert_eq!(back[2], ["", "a\tb"]);
    }

    #[test]
    fn plain_lines_are_not_a_table() {
        assert_eq!(parse_grid("一\n二"), None);
        let one = parse_grid("甲\t乙\n").unwrap();
        assert_eq!(one, grid(&[&["甲", "乙"]]));
        assert!(!is_table(&one), "one row stays text in the note");
        assert!(is_table(&parse_grid("甲\t乙\n丙\t丁").unwrap()));
        assert!(!is_table(&parse_grid("甲\t乙\n丙").unwrap()), "ragged");
    }

    #[test]
    fn a_copied_table_carries_its_cells_and_marks() {
        let cells = grid(&[&["a\tb", "约格"]]);
        let marks: GridMarks = vec![vec![
            vec![(0, 1, "bold".into(), LoroValue::Bool(true))],
            vec![
                (0, 2, "highlight".into(), LoroValue::String("".into())),
                (
                    0,
                    2,
                    "entity:e1".into(),
                    LoroValue::Map(
                        [("target".to_owned(), LoroValue::String("e1".into()))]
                            .into_iter()
                            .collect::<std::collections::HashMap<_, _>>()
                            .into(),
                    ),
                ),
            ],
        ]];
        let item = table_item(&cells, &marks).unwrap();
        assert_eq!(table_from_clipboard(&item), Some(cells));
        assert_eq!(marks_from_clipboard(&item).unwrap(), marks);
        assert_eq!(marks_at(&marks, 0, 1).len(), 2);
        assert_eq!(marks_at(&marks, 3, 0), &[] as &[CellMark]);
        let plain = ClipboardItem::new_string("x".into());
        assert_eq!(table_from_clipboard(&plain), None);
        assert_eq!(marks_from_clipboard(&plain).unwrap(), GridMarks::new());
    }
}
