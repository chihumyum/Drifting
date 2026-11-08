//! Importing Word, Markdown and plain-text files into a book (M41): the
//! 0.1 client's `services/import/*` and the commit half of its
//! `ImportDialog`.
//!
//! - [`parse_file`] / [`parse_bytes`] read one file into a [`ParsedDoc`]:
//!   the manuscript [`Block`]s the editor can hold (H1–H3 headings,
//!   paragraphs with a centre or right alignment, quotes, rules; bold,
//!   italic, underline, strike, web and mail links, line breaks) and a
//!   title ([`take_title`]). What the editor cannot hold degrades as it did
//!   in 0.1: lists and code become paragraphs, images are dropped with a
//!   warning.
//! - [`order_import_files`] puts picked files in natural order (`2` before
//!   `10`), as the 0.1 dialog did; [`files_in_folder`] lists a folder's
//!   importable files that way.
//! - [`import_docs`] creates one chapter, idea or element per file through
//!   F3 and writes its text (`write.rs`).
//!
//! Parsing is pure and blocking; run it off the main thread.

mod docx;
mod markdown;
mod write;

use std::cmp::Ordering;
use std::fmt;
use std::path::{Path, PathBuf};

use crate::manuscript::{Block, Run};

pub use write::{ImportTarget, ImportedEntity, ImportedItem, import_docs};

/// The longest file read (Word, Markdown or text), in bytes.
pub const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;
/// The longest title taken from a file (the 0.1 `MAX_TITLE`), in characters.
pub const MAX_TITLE: usize = 80;
/// File extensions the import reads.
pub const IMPORT_EXTENSIONS: &[&str] = &["md", "markdown", "txt", "docx"];

/// What a file is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ImportFormat {
    Markdown,
    Txt,
    Docx,
}

impl ImportFormat {
    /// By extension (`.md`, `.markdown`, `.txt`, `.docx`, any case).
    pub fn of(name: &str) -> Option<ImportFormat> {
        let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "md" | "markdown" => Some(ImportFormat::Markdown),
            "txt" => Some(ImportFormat::Txt),
            "docx" => Some(ImportFormat::Docx),
            _ => None,
        }
    }
}

/// Something a file held that the import left out or changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportWarning {
    /// Pictures (Word drawings, Markdown images) are not imported.
    ImagesDropped(usize),
    /// The text was not UTF-8; undecodable bytes became U+FFFD.
    NotUtf8,
}

impl fmt::Display for ImportWarning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ImportWarning::ImagesDropped(n) => write!(
                f,
                "{n} image(s) were not imported: the editor does not hold embedded images yet"
            ),
            ImportWarning::NotUtf8 => {
                write!(
                    f,
                    "the file is not UTF-8 text; some characters were replaced"
                )
            }
        }
    }
}

/// Why a file could not be read.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ImportError {
    /// Not `.md`, `.markdown`, `.txt` or `.docx`.
    #[error("unsupported file type: {0}")]
    Unsupported(String),
    #[error("the file is larger than {MAX_IMPORT_BYTES} bytes")]
    TooLarge,
    #[error("could not read the file: {0}")]
    Io(String),
    /// Not a Word document (or a damaged one).
    #[error("not a Word document: {0}")]
    NotDocx(String),
}

/// One file, read.
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedDoc {
    /// The title [`take_title`] found (the dialog lets the author change it).
    pub title: String,
    /// The body, without the title.
    pub blocks: Vec<Block>,
    pub format: ImportFormat,
    /// The file's name, for messages and as the last-resort title.
    pub filename: String,
    pub warnings: Vec<ImportWarning>,
}

/// Read one file.
pub fn parse_file(path: &Path) -> Result<ParsedDoc, ImportError> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_owned();
    let format = ImportFormat::of(&name).ok_or_else(|| ImportError::Unsupported(name.clone()))?;
    let meta = std::fs::metadata(path).map_err(|e| ImportError::Io(e.to_string()))?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(ImportError::TooLarge);
    }
    let bytes = std::fs::read(path).map_err(|e| ImportError::Io(e.to_string()))?;
    parse_as(&name, &bytes, format)
}

/// Read one file's bytes; `name` gives its type and its fallback title.
pub fn parse_bytes(name: &str, bytes: &[u8]) -> Result<ParsedDoc, ImportError> {
    let format = ImportFormat::of(name).ok_or_else(|| ImportError::Unsupported(name.to_owned()))?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(ImportError::TooLarge);
    }
    parse_as(name, bytes, format)
}

fn parse_as(name: &str, bytes: &[u8], format: ImportFormat) -> Result<ParsedDoc, ImportError> {
    let mut warnings = Vec::new();
    let blocks = match format {
        ImportFormat::Docx => docx::parse(bytes, &mut warnings)?,
        ImportFormat::Markdown => {
            let text = decode_text(bytes, &mut warnings);
            markdown::parse(&text, &mut warnings)
        }
        ImportFormat::Txt => {
            let text = decode_text(bytes, &mut warnings);
            parse_txt(&text)
        }
    };
    let (title, blocks) = take_title(blocks, name);
    Ok(ParsedDoc {
        title,
        blocks,
        format,
        filename: name.to_owned(),
        warnings,
    })
}

/// Markdown text as manuscript blocks, by the same reader as a `.md` file
/// (no title taken off). M40's Markdown folder reads the paragraphs an
/// author changed with it.
pub fn markdown_blocks(text: &str) -> Vec<Block> {
    markdown::parse(text, &mut Vec::new())
}

/// UTF-8 (a BOM dropped), or UTF-16 with its BOM; anything else is read as
/// UTF-8 with replacements, and says so.
fn decode_text(bytes: &[u8], warnings: &mut Vec<ImportWarning>) -> String {
    let utf16 = |bytes: &[u8], le: bool| {
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| {
                if le {
                    u16::from_le_bytes(*c)
                } else {
                    u16::from_be_bytes(*c)
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
    let text = match bytes {
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        [0xFF, 0xFE, rest @ ..] => utf16(rest, true),
        [0xFE, 0xFF, rest @ ..] => utf16(rest, false),
        _ => match std::str::from_utf8(bytes) {
            Ok(s) => s.to_owned(),
            Err(_) => {
                warnings.push(ImportWarning::NotUtf8);
                String::from_utf8_lossy(bytes).into_owned()
            }
        },
    };
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// JavaScript's `\s` (what the 0.1 `trim` and `\s+` removed).
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Plain text: paragraphs are separated by blank lines; a single newline
/// stays a line break inside its paragraph (0.1 `parseTxt`).
fn parse_txt(text: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut chunk: Vec<&str> = Vec::new();
    let flush = |chunk: &mut Vec<&str>, out: &mut Vec<Block>| {
        let joined = chunk.join("\n");
        chunk.clear();
        let trimmed = joined.trim_matches(is_js_space);
        if !trimmed.is_empty() {
            out.push(Block::Paragraph {
                runs: vec![Run {
                    text: trimmed.to_owned(),
                    ..Run::default()
                }],
                align: crate::manuscript::Align::Justify,
                indent: 0,
            });
        }
    };
    for line in text.split('\n') {
        if line.trim_matches(is_js_space).is_empty() {
            flush(&mut chunk, &mut out);
        } else {
            chunk.push(line);
        }
    }
    flush(&mut chunk, &mut out);
    out
}

/// A block's plain text, line breaks as spaces (0.1 `plainText`).
fn plain(block: &Block) -> String {
    match block {
        Block::Heading { runs, .. } | Block::Paragraph { runs, .. } => runs
            .iter()
            .map(|r| r.text.replace('\n', " "))
            .collect::<String>(),
        Block::Quote { blocks } => blocks.iter().map(plain).collect(),
        Block::Break => String::new(),
    }
}

/// Whitespace runs as one space, trimmed (0.1 `normalize`).
fn normalize(s: &str) -> String {
    s.split(is_js_space)
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The file name without its extension or a short number that only orders
/// the files (`01 `, `2_`, `03-`, `4. `); years (`2024-…`) stay (0.1
/// `titleFromFilename`).
pub fn title_from_filename(filename: &str) -> String {
    let stem = match filename.rfind('.') {
        Some(dot) if dot > 0 => &filename[..dot],
        _ => filename,
    };
    let stem = match stem.trim_matches(is_js_space) {
        "" => filename,
        s => s,
    };
    let digits = stem.chars().take_while(|c| c.is_ascii_digit()).count();
    if (1..=3).contains(&digits) {
        let rest = &stem[digits..];
        let seps = rest
            .chars()
            .take_while(|c| is_js_space(*c) || matches!(c, '.' | '_' | '-'))
            .map(char::len_utf8)
            .sum::<usize>();
        let after = &rest[seps..];
        if seps > 0 && after.chars().next().is_some_and(|c| !is_js_space(c)) {
            let t = after.trim_matches(is_js_space);
            if !t.is_empty() {
                return t.to_owned();
            }
        }
    }
    stem.trim_matches(is_js_space).to_owned()
}

/// The title and the body (0.1 `takeTitle`): an opening H1 is the title and
/// leaves the body; otherwise the title is the file's name
/// ([`title_from_filename`]), and an opening paragraph or heading that only
/// repeats it leaves the body. Headings further down stay.
pub fn take_title(mut blocks: Vec<Block>, filename: &str) -> (String, Vec<Block>) {
    let first = blocks.first().map(|b| (b, normalize(&plain(b))));
    if let Some((Block::Heading { level: 1, .. }, text)) = &first
        && !text.is_empty()
    {
        let title: String = text.chars().take(MAX_TITLE).collect();
        blocks.remove(0);
        return (title, blocks);
    }
    let title = title_from_filename(filename);
    let repeats = first.is_some_and(|(b, text)| {
        matches!(b, Block::Paragraph { .. } | Block::Heading { .. }) && text == normalize(&title)
    });
    if repeats {
        blocks.remove(0);
    }
    (title, blocks)
}

/// Natural order of two names (`2` before `10`, case after letters), as the
/// 0.1 dialog's `Intl.Collator` with `numeric: true`, then byte order.
pub fn import_order(a: &str, b: &str) -> Ordering {
    fn chunks(s: &str) -> Vec<(bool, &str)> {
        let mut out = Vec::new();
        let mut start = 0;
        let mut digit = None;
        for (i, c) in s.char_indices() {
            let d = c.is_ascii_digit();
            if digit.is_some_and(|x| x != d) {
                out.push((digit.unwrap_or(false), &s[start..i]));
                start = i;
            }
            digit = Some(d);
        }
        if start < s.len() {
            out.push((digit.unwrap_or(false), &s[start..]));
        }
        out
    }
    let (ca, cb) = (chunks(a), chunks(b));
    for (x, y) in ca.iter().zip(&cb) {
        let o = match (x, y) {
            ((true, x), (true, y)) => {
                let (tx, ty) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                tx.len().cmp(&ty.len()).then_with(|| tx.cmp(ty))
            }
            ((_, x), (_, y)) => x.to_lowercase().cmp(&y.to_lowercase()),
        };
        if o != Ordering::Equal {
            return o;
        }
    }
    ca.len()
        .cmp(&cb.len())
        .then_with(|| a.to_lowercase().cmp(&b.to_lowercase()))
        .then_with(|| a.cmp(b))
}

/// Put picked files in the order they are imported: by path, naturally.
pub fn order_import_files(paths: &mut [PathBuf]) {
    paths.sort_by(|a, b| import_order(&a.to_string_lossy(), &b.to_string_lossy()));
}

/// The importable files under `dir` (its subfolders too; hidden files and
/// symbolic links skipped), in import order of their paths below `dir`.
pub fn files_in_folder(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d)? {
            let entry = entry?;
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() && ImportFormat::of(&name.to_string_lossy()).is_some() {
                found.push(entry.path());
            }
        }
    }
    found.sort_by(|a, b| {
        let rel = |p: &PathBuf| {
            p.strip_prefix(dir)
                .unwrap_or(p)
                .to_string_lossy()
                .into_owned()
        };
        import_order(&rel(a), &rel(b))
    });
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manuscript::Align;

    fn para(text: &str) -> Block {
        Block::Paragraph {
            runs: vec![Run {
                text: text.into(),
                ..Run::default()
            }],
            align: Align::Justify,
            indent: 0,
        }
    }

    fn heading(level: u8, text: &str) -> Block {
        Block::Heading {
            level,
            runs: vec![Run {
                text: text.into(),
                ..Run::default()
            }],
            align: Align::Justify,
        }
    }

    #[test]
    fn formats_come_from_the_extension() {
        assert_eq!(ImportFormat::of("a.MD"), Some(ImportFormat::Markdown));
        assert_eq!(ImportFormat::of("a.markdown"), Some(ImportFormat::Markdown));
        assert_eq!(ImportFormat::of("草稿.txt"), Some(ImportFormat::Txt));
        assert_eq!(ImportFormat::of("b.docx"), Some(ImportFormat::Docx));
        assert_eq!(ImportFormat::of("b.doc"), None);
        assert_eq!(ImportFormat::of("docx"), None);
        assert!(matches!(
            parse_bytes("a.pages", b"x"),
            Err(ImportError::Unsupported(_))
        ));
    }

    #[test]
    fn titles_come_from_file_names_without_ordering_numbers() {
        assert_eq!(title_from_filename("01 第一章.md"), "第一章");
        assert_eq!(title_from_filename("2_Arrival.docx"), "Arrival");
        assert_eq!(title_from_filename("03-雨.txt"), "雨");
        assert_eq!(title_from_filename("4. 尾声.md"), "尾声");
        assert_eq!(title_from_filename("2024-年记.md"), "2024-年记");
        assert_eq!(title_from_filename("12.md"), "12");
        assert_eq!(title_from_filename(".md"), ".md");
        assert_eq!(title_from_filename("README"), "README");
    }

    #[test]
    fn an_opening_h1_is_the_title() {
        let (title, body) = take_title(vec![heading(1, " 第一章  雨夜 "), para("正文")], "x.md");
        assert_eq!(title, "第一章 雨夜");
        assert_eq!(body, vec![para("正文")]);
        // A long one is cut at 80 characters.
        let long = "字".repeat(100);
        assert_eq!(
            take_title(vec![heading(1, &long)], "x.md")
                .0
                .chars()
                .count(),
            80
        );
        // A heading further down stays; the file's name is the title.
        let (title, body) = take_title(vec![para("开头"), heading(1, "中间")], "05 雨.md");
        assert_eq!(title, "雨");
        assert_eq!(body.len(), 2);
        // An opening line that repeats the name leaves.
        let (title, body) = take_title(vec![heading(2, "雨"), para("正文")], "05 雨.md");
        assert_eq!((title.as_str(), body), ("雨", vec![para("正文")]));
    }

    #[test]
    fn text_paragraphs_split_on_blank_lines() {
        let parsed = parse_bytes(
            "notes.txt",
            "第一段\n第一段的第二行\n\n  \n第二段\r\n\r\n\r\n".as_bytes(),
        )
        .unwrap();
        assert_eq!(parsed.title, "notes");
        assert_eq!(
            parsed.blocks,
            vec![para("第一段\n第一段的第二行"), para("第二段")]
        );
        assert!(parsed.warnings.is_empty());
        // UTF-16 with its BOM, and bytes that are not UTF-8.
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend("你好".encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(
            parse_bytes("a.txt", &utf16).unwrap().blocks,
            vec![para("你好")]
        );
        let latin = parse_bytes("a.txt", &[b'a', 0xE9, b'b']).unwrap();
        assert_eq!(latin.warnings, vec![ImportWarning::NotUtf8]);
    }

    #[test]
    fn files_import_in_natural_order() {
        let mut v: Vec<PathBuf> = ["10 尾声.md", "2 雨.md", "1 序.md", "B.md", "a.md"]
            .iter()
            .map(PathBuf::from)
            .collect();
        order_import_files(&mut v);
        let names: Vec<_> = v.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["1 序.md", "2 雨.md", "10 尾声.md", "a.md", "B.md"]);
    }

    #[test]
    fn a_folder_lists_its_importable_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::create_dir(p.join("卷二")).unwrap();
        for f in ["10.md", "2.txt", "卷二/1.docx", ".hidden.md", "cover.png"] {
            std::fs::write(p.join(f), b"x").unwrap();
        }
        let got: Vec<String> = files_in_folder(p)
            .unwrap()
            .iter()
            .map(|f| f.strip_prefix(p).unwrap().to_string_lossy().into_owned())
            .collect();
        let want = ["2.txt", "10.md", "卷二/1.docx"]
            .map(|s| s.replace('/', std::path::MAIN_SEPARATOR_STR));
        assert_eq!(got, want);
    }
}
