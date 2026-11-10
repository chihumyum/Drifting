//! Convert the established prose line address into a paragraph index.
pub fn line_to_block(line: u32) -> u32 {
    line.saturating_sub(1) / 2
}
