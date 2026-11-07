//! Typed TODO markers: a paragraph that starts with `TODO` or `待办`.
//!
//! The rule of the 0.1 client (`useTodoAutoParse.ts`), kept: leading
//! whitespace, then `TODO` (any case) or `待办`, then at least one space,
//! `:` or `：`; the rest of the paragraph is the task. Only at the start of a
//! paragraph, so a "todo" in mid-sentence is not one. A paragraph is
//! identified by its block id, which is what a projected TODO points at
//! (`CommentId::for_projection`, kind `marker`).
//!
//! The editor finds them; writing the projected TODOs is the workspace's job
//! (see f4-editor.md, 待协调).

use std::ops::Range;

/// A TODO marker in a paragraph.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TodoMarker {
    /// The paragraph's index.
    pub paragraph: usize,
    /// Its block id (a marker in a paragraph without one cannot be projected).
    pub block: Option<String>,
    /// The marker and its separator, in characters of the paragraph.
    pub marker: Range<usize>,
    /// The task text, trimmed (empty when only the marker was typed).
    pub task: String,
}

/// The marker in `text`, if it starts with one: `(marker range, task)`.
pub fn parse(text: &str) -> Option<(Range<usize>, String)> {
    let lead = text.chars().take_while(|c| c.is_whitespace()).count();
    let rest: String = text.chars().skip(lead).collect();
    let word =
        if rest.len() >= 4 && rest.is_char_boundary(4) && rest[..4].eq_ignore_ascii_case("todo") {
            4
        } else if rest.starts_with("待办") {
            2
        } else {
            return None;
        };
    let after: Vec<char> = rest.chars().skip(word).collect();
    let sep = after
        .iter()
        .take_while(|c| c.is_whitespace() || **c == ':' || **c == '：')
        .count();
    if sep == 0 {
        return None;
    }
    let task: String = after[sep..].iter().collect();
    Some((lead..lead + word + sep, task.trim().to_owned()))
}

/// Every marker among `paragraphs` (`(text, block id)` in order).
pub fn markers<'a>(
    paragraphs: impl IntoIterator<Item = (&'a str, Option<&'a str>)>,
) -> Vec<TodoMarker> {
    paragraphs
        .into_iter()
        .enumerate()
        .filter_map(|(paragraph, (text, block))| {
            let (marker, task) = parse(text)?;
            Some(TodoMarker {
                paragraph,
                block: block.map(str::to_owned),
                marker,
                task,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_at_the_start_of_a_paragraph() {
        assert_eq!(
            parse("TODO 查一下钟楼的年代"),
            Some((0..5, "查一下钟楼的年代".into()))
        );
        assert_eq!(parse("todo: 改名"), Some((0..6, "改名".into())));
        assert_eq!(parse("待办：补一场雨"), Some((0..3, "补一场雨".into())));
        assert_eq!(parse("  ToDo：  "), Some((2..9, String::new())));
        assert_eq!(parse("待办 "), Some((0..3, String::new())));
    }

    #[test]
    fn not_markers() {
        assert_eq!(parse("他说 TODO 是个词"), None);
        assert_eq!(parse("TODOS 不算"), None);
        assert_eq!(parse("todo"), None, "a separator is needed");
        assert_eq!(parse("待办事项"), None);
        assert_eq!(parse(""), None);
    }

    #[test]
    fn markers_keep_their_paragraph_and_block() {
        let found = markers([
            ("正文", Some("a")),
            ("TODO 改", Some("b")),
            ("待办：雨", None),
        ]);
        assert_eq!(found.len(), 2);
        assert_eq!(
            (found[0].paragraph, found[0].block.as_deref()),
            (1, Some("b"))
        );
        assert_eq!((found[1].paragraph, found[1].block.as_deref()), (2, None));
    }
}
