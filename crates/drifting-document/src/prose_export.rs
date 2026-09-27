//! Book export of a body's ProseMirror projection as Markdown or plain text.
//! Headings are shifted below the book's own chapter headings; unknown marks
//! export as their text, and entity links too unless a resolver maps them to
//! `[[path|text]]` wiki links.
use serde_json::Value;

fn children(node: &Value) -> &[Value] {
    node.get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn kind(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}

/// Escapes characters that would otherwise start Markdown syntax.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(
            c,
            '\\' | '*' | '_' | '`' | '[' | ']' | '#' | '<' | '>' | '~'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Maps an entity link's `(targetKind, targetId)` to an archive path.
pub type LinkResolver<'a> = &'a dyn Fn(&str, &str) -> Option<String>;

fn inline_markdown(node: &Value, out: &mut String, links: Option<LinkResolver>) {
    for child in children(node) {
        match kind(child) {
            "text" => {
                let text = child.get("text").and_then(Value::as_str).unwrap_or("");
                let mut open = String::new();
                let mut close = String::new();
                let mut link = None;
                let mut wiki = None;
                for mark in child
                    .get("marks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let delimiter = match kind(mark) {
                        "bold" => "**",
                        "italic" => "*",
                        "strike" => "~~",
                        "code" => "`",
                        "link" => {
                            link = mark.pointer("/attrs/href").and_then(Value::as_str);
                            continue;
                        }
                        "entityLink" => {
                            wiki = links.and_then(|resolve| {
                                resolve(
                                    mark.pointer("/attrs/targetKind")
                                        .and_then(Value::as_str)
                                        .unwrap_or(""),
                                    mark.pointer("/attrs/targetId")
                                        .and_then(Value::as_str)
                                        .unwrap_or(""),
                                )
                            });
                            continue;
                        }
                        _ => continue,
                    };
                    open.push_str(delimiter);
                    close.insert_str(0, delimiter);
                }
                let inner = match wiki {
                    Some(path) => format!("[[{path}|{}]]", escape(text)),
                    None => escape(text),
                };
                let body = format!("{open}{inner}{close}");
                match link {
                    Some(href) => out.push_str(&format!("[{body}]({href})")),
                    None => out.push_str(&body),
                }
            }
            "hardBreak" => out.push_str("  \n"),
            _ => inline_markdown(child, out, links),
        }
    }
}

fn block_markdown(
    node: &Value,
    shift: usize,
    prefix: &str,
    out: &mut Vec<String>,
    links: Option<LinkResolver>,
) {
    match kind(node) {
        "heading" => {
            let level = node
                .pointer("/attrs/level")
                .and_then(Value::as_u64)
                .unwrap_or(1) as usize;
            let mut line = format!("{prefix}{} ", "#".repeat((level + shift).min(6)));
            inline_markdown(node, &mut line, links);
            out.push(line);
        }
        "blockquote" => {
            for child in children(node) {
                block_markdown(child, shift, &format!("{prefix}> "), out, links);
            }
        }
        "bulletList" | "orderedList" => {
            let mut list = Vec::new();
            for (index, item) in children(node).iter().enumerate() {
                let marker = if kind(node) == "bulletList" {
                    "- ".to_string()
                } else {
                    format!("{}. ", index + 1)
                };
                let mut lines = Vec::new();
                for child in children(item) {
                    block_markdown(child, shift, "", &mut lines, links);
                }
                for (i, line) in lines.join("\n").split('\n').enumerate() {
                    list.push(format!(
                        "{prefix}{}{line}",
                        if i == 0 { marker.clone() } else { "   ".into() }
                    ));
                }
            }
            out.push(list.join("\n"));
        }
        "codeBlock" => {
            let mut code = String::new();
            for child in children(node) {
                code.push_str(child.get("text").and_then(Value::as_str).unwrap_or(""));
            }
            out.push(format!("{prefix}```\n{code}\n{prefix}```"));
        }
        "horizontalRule" => out.push(format!("{prefix}---")),
        _ => {
            let mut line = prefix.to_string();
            inline_markdown(node, &mut line, links);
            out.push(line);
        }
    }
}

/// The body as Markdown, its headings `shift` levels deeper, blocks
/// separated by blank lines; empty paragraphs are dropped.
pub fn prose_markdown(document: &Value, shift: usize) -> String {
    prose_markdown_linked(document, shift, None)
}

/// As [`prose_markdown`], with entity links the resolver knows written as
/// `[[path|text]]`.
pub fn prose_markdown_linked(
    document: &Value,
    shift: usize,
    links: Option<LinkResolver>,
) -> String {
    let mut blocks = Vec::new();
    for block in children(document) {
        block_markdown(block, shift, "", &mut blocks, links);
    }
    blocks.retain(|block| !block.trim().is_empty());
    blocks.join("\n\n")
}

fn plain(node: &Value, out: &mut String) {
    match kind(node) {
        "text" => out.push_str(node.get("text").and_then(Value::as_str).unwrap_or("")),
        "hardBreak" => out.push('\n'),
        _ => {
            for child in children(node) {
                plain(child, out);
            }
        }
    }
}

/// The body as plain text, one line per block.
pub fn prose_plain_text(document: &Value) -> String {
    children(document)
        .iter()
        .map(|block| {
            let mut line = String::new();
            plain(block, &mut line);
            line
        })
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prose_export_writes_markdown_and_text() {
        let document = json!({"type":"doc","content":[
            {"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"雨夜"}]},
            {"type":"paragraph","content":[
                {"type":"text","text":"她说 "},
                {"type":"text","text":"快走","marks":[{"type":"bold","attrs":{}},{"type":"italic","attrs":{}}]},
                {"type":"text","text":"，去*北塔*"},
                {"type":"hardBreak"},
                {"type":"text","text":"钟楼","marks":[{"type":"link","attrs":{"href":"https://example.invalid"}},{"type":"entityLink","attrs":{}}]}]},
            {"type":"paragraph"},
            {"type":"blockquote","content":[{"type":"paragraph","content":[{"type":"text","text":"引文"}]}]},
            {"type":"bulletList","content":[
                {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"甲"}]}]},
                {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"乙"}]}]}]},
            {"type":"codeBlock","content":[{"type":"text","text":"a < b"}]}
        ]});
        assert_eq!(
            prose_markdown(&document, 2),
            "### 雨夜\n\n她说 ***快走***，去\\*北塔\\*  \n[钟楼](https://example.invalid)\n\n> 引文\n\n- 甲\n- 乙\n\n```\na < b\n```"
        );
        assert_eq!(
            prose_plain_text(&document),
            "雨夜\n她说 快走，去*北塔*\n钟楼\n引文\n甲乙\na < b"
        );
    }

    #[test]
    fn resolved_marks_become_wiki_links() {
        let doc = serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"林岚","marks":[{"type":"bold"},{"type":"entityLink","attrs":{"targetKind":"element","targetId":"e1"}}]},
            {"type":"text","text":"走向"},
            {"type":"text","text":"北塔","marks":[{"type":"entityLink","attrs":{"targetKind":"element","targetId":"gone"}}]}]}]});
        let resolve = |kind: &str, id: &str| {
            (kind == "element" && id == "e1").then(|| "elements/林岚-e1".to_string())
        };
        assert_eq!(
            prose_markdown_linked(&doc, 0, Some(&resolve)),
            "**[[elements/林岚-e1|林岚]]**走向北塔"
        );
        assert_eq!(prose_markdown(&doc, 0), "**林岚**走向北塔");
    }
}
