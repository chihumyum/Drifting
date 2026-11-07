//! Old lines → schema v2 paragraphs (decision D3, `loro-schema.md`
//! "正文文档"): what a prose document must contain after the import, as
//! dr-doc reads it back. Writing ([`super::write`]) makes a document equal
//! to a plan; reading ([`super::read`]) gives the same shape back, so "zero
//! errors" means `plan == read back`.
//!
//! D3 is flatter than the old editor's tree. What does not survive as is is
//! counted in [`Notes`] (each key documented in `m10-import.md`):
//!
//! - containers (block quote, list, list item, task item, callout) become
//!   paragraph attributes; their own block ids are not paragraph ids. A
//!   reference to one (comment, link, patch, memory) is remapped to the
//!   container's first and last paragraph ([`DocBlocks::span`]); when the
//!   container's first paragraph has no id of its own it takes the
//!   container's;
//! - a table becomes one embed (cells as plain text, U+2028 between the
//!   cell's paragraphs); a material embed and a horizontal rule are their own
//!   paragraphs; a code block becomes one paragraph per line;
//! - an unknown inline node is dropped from the text (its JSON is kept in the
//!   receipt), an unknown mark or block type falls back to plain text.

use std::collections::{BTreeMap, HashMap, HashSet};

use dr_doc::prose::{EmbedView, Run, TableLine};
use dr_model::ProseProfile;
use dr_model::id::{BlockId, CommentId, EmbedId, MaterialId};
use dr_model::kind::ListKind;
use dr_model::pos::{PosKey, keys_between};
use dr_model::prose::{
    Align, BlockAttrs, EntityLink, Heading, InlineMarks, LINE_BREAK, MAX_INDENT, OBJECT_CHAR,
};
use serde_json::Value;

use super::pm::{Container, HARD_BREAK, INLINE_OBJECT, Line, Prose};

/// Counters of what the mapping changed, by key.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(transparent)]
pub struct Notes(pub BTreeMap<String, usize>);

impl Notes {
    pub fn add(&mut self, key: impl Into<String>) {
        *self.0.entry(key.into()).or_default() += 1;
    }

    pub fn merge(&mut self, other: &Notes) {
        for (k, v) in &other.0 {
            *self.0.entry(k.clone()).or_default() += v;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// One paragraph of a prose document as dr-doc reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct Para {
    /// As stored on the paragraph's newline (`Paragraph::stored_id`).
    pub id: Option<BlockId>,
    pub attrs: BlockAttrs,
    /// Maximal runs of equal marks; empty for an empty paragraph.
    pub runs: Vec<Run>,
    /// The embed a lone U+FFFC paragraph stands for, as read.
    pub embed: Option<EmbedView>,
}

impl Para {
    pub fn text(&self) -> String {
        self.runs.iter().map(|r| r.text.as_str()).collect()
    }

    pub fn len(&self) -> usize {
        self.runs.iter().map(|r| r.text.chars().count()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }

    pub(crate) fn plain(id: Option<BlockId>) -> Self {
        Self {
            id,
            attrs: BlockAttrs::default(),
            runs: Vec::new(),
            embed: None,
        }
    }
}

/// The first and last paragraph id an old block id now covers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockSpan {
    pub first: Option<BlockId>,
    pub last: Option<BlockId>,
}

/// One document's block ids: the paragraph id each old line gets, and where
/// every old block id (leaf or container) went.
#[derive(Clone, Debug, Default)]
pub struct DocBlocks {
    /// Per old line: the paragraph id it gets (a table line: the table's).
    pub line_ids: Vec<Option<BlockId>>,
    /// Old block id → its first and last line.
    pub ranges: BTreeMap<String, (usize, usize)>,
    /// Old ids that are now paragraph ids.
    pub kept: HashSet<String>,
    pub notes: Notes,
}

impl DocBlocks {
    /// Where an old block id went: itself if it is a paragraph id now, the
    /// first and last paragraph of a container otherwise.
    pub fn span(&self, old: &str) -> Option<BlockSpan> {
        let (a, b) = *self.ranges.get(old)?;
        Some(BlockSpan {
            first: self.line_ids.get(a).cloned().flatten(),
            last: self.line_ids.get(b).cloned().flatten(),
        })
    }
}

fn table_depth(line: &Line) -> Option<usize> {
    line.path.iter().position(|c| c.kind == "table")
}

fn container_id(c: &Container) -> Option<&str> {
    c.attrs.get("id").and_then(Value::as_str)
}

/// Decide every line's paragraph id (doc-local; see the module doc).
pub fn doc_blocks(prose: &Prose) -> DocBlocks {
    let ranges = prose.block_ranges();
    let mut notes = Notes::default();
    let leaf_ids: HashSet<&str> = prose.lines.iter().filter_map(Line::id).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut taken: HashSet<String> = HashSet::new();
    let mut line_ids = Vec::with_capacity(prose.lines.len());
    let mut table_ids: HashMap<String, Option<BlockId>> = HashMap::new();
    for (index, line) in prose.lines.iter().enumerate() {
        if let Some(depth) = table_depth(line) {
            // Every line of a table is the table's one embed paragraph.
            let key = table_key(line, depth);
            let id = table_ids
                .entry(key)
                .or_insert_with(|| {
                    container_id(&line.path[depth])
                        .filter(|id| !leaf_ids.contains(id) && taken.insert(id.to_string()))
                        .and_then(|id| BlockId::parse(id).ok())
                })
                .clone();
            line_ids.push(id);
            continue;
        }
        let own = line.id().filter(|id| !id.is_empty());
        let id = match own {
            Some(id) => match BlockId::parse(id) {
                Ok(b) => {
                    if !seen.insert(id.to_string()) {
                        notes.add("duplicate-block-id");
                    }
                    taken.insert(id.to_string());
                    Some(b)
                }
                Err(_) => {
                    notes.add("invalid-block-id");
                    None
                }
            },
            None => line
                .path
                .iter()
                .rev()
                .filter_map(container_id)
                .find(|cid| {
                    ranges.get(*cid).is_some_and(|r| r.0 == index)
                        && !leaf_ids.contains(cid)
                        && !taken.contains(*cid)
                })
                .and_then(|cid| {
                    let b = BlockId::parse(cid).ok()?;
                    taken.insert(cid.to_string());
                    notes.add("container-id-on-paragraph");
                    Some(b)
                }),
        };
        line_ids.push(id);
    }
    let kept = taken;
    for id in ranges.keys() {
        if !kept.contains(id) {
            notes.add("container-id-remapped");
        }
    }
    DocBlocks {
        line_ids,
        ranges,
        kept,
        notes,
    }
}

fn table_key(line: &Line, depth: usize) -> String {
    let path: Vec<String> = line.path[..=depth]
        .iter()
        .map(|c| format!("{}#{}", c.kind, c.ordinal))
        .collect();
    path.join("/")
}

/// Where one old line went.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LineAt {
    /// Text paragraph(s) from `para` on (a code block is one per line); the
    /// old line's characters at `dropped` (inline objects) are gone.
    Body { para: usize, dropped: Vec<usize> },
    /// Inside the embed paragraph `para` (a table).
    Embed { para: usize },
}

/// A prose document's plan.
#[derive(Clone, Debug)]
pub struct Plan {
    pub profile: ProseProfile,
    pub paras: Vec<Para>,
    /// Per old line.
    pub lines: Vec<LineAt>,
    pub notes: Notes,
    /// JSON of dropped inline nodes, kept in the receipt.
    pub dropped_inline: Vec<String>,
}

impl Plan {
    /// Start of each paragraph in the body (Unicode scalars).
    pub fn starts(&self) -> Vec<usize> {
        let mut at = 0;
        self.paras
            .iter()
            .map(|p| {
                let s = at;
                at += p.len() + 1;
                s
            })
            .collect()
    }

    /// Body position of old line `line`, character `ch` (a position may be
    /// the line's end). `starts` from [`Self::starts`].
    pub fn body_pos(&self, starts: &[usize], line: usize, ch: usize) -> Option<usize> {
        match self.lines.get(line)? {
            LineAt::Embed { para } => Some(starts[*para]),
            LineAt::Body { para, dropped } => {
                let gone = dropped.iter().filter(|d| **d < ch).count();
                Some(starts[*para] + ch - gone)
            }
        }
    }

    /// The body text dr-doc stores (every paragraph ends with `\n`).
    pub fn body_text(&self) -> String {
        let mut s = String::new();
        for p in &self.paras {
            s.push_str(&p.text());
            s.push('\n');
        }
        s
    }
}

/// What a plan needs from outside its own document.
pub struct Context<'a> {
    pub profile: ProseProfile,
    /// Where an old block id of any document went (for entity links into
    /// other chapters).
    pub span: &'a dyn Fn(&str) -> Option<BlockSpan>,
    /// The new id of a TODO a task item links to (projected TODOs get
    /// deterministic ids).
    pub todo: &'a dyn Fn(&str) -> Option<CommentId>,
}

#[derive(Default)]
struct MarkState {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    link: Option<String>,
    highlight: Option<String>,
    code: bool,
    entities: Vec<EntityLink>,
}

fn entity_link(attrs: &str, ctx: &Context<'_>, notes: &mut Notes) -> Option<EntityLink> {
    let v: Value = serde_json::from_str(attrs).unwrap_or(Value::Null);
    let target = v
        .get("targetId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let Some(target) = target else {
        notes.add("entity-link-without-target");
        return None;
    };
    let kind = dr_model::legacy::entity_kind(
        v.get("targetKind")
            .and_then(Value::as_str)
            .unwrap_or("element"),
    );
    if !kind.may_be_linked() {
        notes.add(format!("entity-link-to-{}", kind.as_str()));
        return None;
    }
    let mut block = |key: &str, last: bool| -> Option<BlockId> {
        let old = v
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())?;
        match (ctx.span)(old) {
            Some(span) => {
                let b = if last { span.last } else { span.first };
                if b.as_ref().map(|b| b.as_str()) != Some(old) {
                    notes.add("entity-link-block-remapped");
                }
                b.or_else(|| BlockId::parse(old).ok())
            }
            None => BlockId::parse(old).ok(),
        }
    };
    Some(EntityLink {
        target: target.to_string(),
        kind,
        block: block("targetBlockId", false),
        end_block: block("targetEndBlockId", true),
    })
}

/// Build the runs of one old line's text, without dropped characters.
fn runs_of(
    line: &Line,
    profile: ProseProfile,
    ctx: &Context<'_>,
    notes: &mut Notes,
    dropped_inline: &mut Vec<String>,
) -> (Vec<(char, InlineMarks)>, Vec<usize>) {
    let chars: Vec<char> = line.text.chars().collect();
    let mut states: Vec<MarkState> = chars.iter().map(|_| MarkState::default()).collect();
    let mut dropped = Vec::new();
    for span in &line.marks {
        let range = span.start.min(chars.len())..span.end.min(chars.len());
        match span.mark.as_str() {
            "inline" => {
                for i in range {
                    if chars[i] == INLINE_OBJECT {
                        dropped.push(i);
                    }
                }
                let kind = serde_json::from_str::<Value>(&span.attrs)
                    .ok()
                    .and_then(|v| v.get("type").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_default();
                notes.add(format!("unknown-inline:{kind}"));
                dropped_inline.push(span.attrs.clone());
            }
            "bold" => range.for_each(|i| states[i].bold = true),
            "italic" => range.for_each(|i| states[i].italic = true),
            "underline" => range.for_each(|i| states[i].underline = true),
            "strike" => range.for_each(|i| states[i].strike = true),
            "link" => {
                let href = serde_json::from_str::<Value>(&span.attrs)
                    .ok()
                    .and_then(|v| v.get("href").and_then(Value::as_str).map(str::to_string));
                match href {
                    Some(h) => range.for_each(|i| states[i].link = Some(h.clone())),
                    None => notes.add("link-without-href"),
                }
            }
            "highlight" | "code" if profile == ProseProfile::Prose => {
                notes.add(format!("{}-in-prose", span.mark));
            }
            "highlight" => {
                let color = serde_json::from_str::<Value>(&span.attrs)
                    .ok()
                    .and_then(|v| v.get("color").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_default();
                range.for_each(|i| states[i].highlight = Some(color.clone()));
            }
            "code" => range.for_each(|i| states[i].code = true),
            "entityLink" => {
                if let Some(link) = entity_link(&span.attrs, ctx, notes) {
                    for i in range {
                        let have = &mut states[i].entities;
                        if let Some(other) = have.iter_mut().find(|l| l.target == link.target) {
                            if *other != link {
                                // One key per target: the later span wins.
                                notes.add("entity-link-same-target-overlap");
                                *other = link.clone();
                            }
                        } else {
                            have.push(link.clone());
                        }
                    }
                }
            }
            other => notes.add(format!("unknown-mark:{other}")),
        }
    }
    let mut out = Vec::with_capacity(chars.len());
    for (i, (c, st)) in chars.iter().zip(states).enumerate() {
        if dropped.contains(&i) {
            continue;
        }
        let mut entities = st.entities;
        entities.sort();
        // A run never carries a block or embed key; `\n` (code blocks) is
        // split off by the caller.
        out.push((
            if *c == HARD_BREAK { LINE_BREAK } else { *c },
            InlineMarks {
                bold: st.bold,
                italic: st.italic,
                underline: st.underline,
                strike: st.strike,
                link: st.link,
                entities,
                highlight: st.highlight,
                code: st.code,
                embed: None,
            },
        ));
    }
    dropped.sort_unstable();
    dropped.dedup();
    (out, dropped)
}

fn push_char(runs: &mut Vec<Run>, c: char, marks: &InlineMarks) {
    if let Some(last) = runs.last_mut()
        && &last.marks == marks
    {
        last.text.push(c);
        return;
    }
    runs.push(Run {
        text: c.to_string(),
        marks: marks.clone(),
    });
}

fn int(v: Option<&Value>) -> Option<i64> {
    v.and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

/// Block attributes of a text line, from the leaf and its containers.
fn line_attrs(line: &Line, ctx: &Context<'_>, notes: &mut Notes) -> BlockAttrs {
    let mut a = BlockAttrs::default();
    match line.kind.as_str() {
        "heading" => {
            let level = int(line.attrs.get("level")).unwrap_or(1);
            a.heading = Heading::from_level(level.clamp(1, 3));
            if !(1..=3).contains(&level) {
                notes.add("heading-level-clamped");
            }
        }
        "codeBlock" => {
            a.code_block = Some(
                line.attrs
                    .get("language")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            );
        }
        "paragraph" => {}
        other => notes.add(format!("unknown-block:{other}")),
    }
    let indent = int(line.attrs.get("indent")).unwrap_or(0);
    if indent > MAX_INDENT as i64 || indent < 0 {
        notes.add("indent-clamped");
    }
    a.indent = indent.clamp(0, MAX_INDENT as i64) as u8;
    match line.attrs.get("textAlign").and_then(Value::as_str) {
        None | Some("left") => {}
        Some("center") => a.align = Align::Center,
        Some("right") => a.align = Align::Right,
        Some(_) => notes.add("align-unsupported"),
    }
    let lists: Vec<&Container> = line
        .path
        .iter()
        .filter(|c| matches!(c.kind.as_str(), "bulletList" | "orderedList" | "taskList"))
        .collect();
    if let Some(inner) = lists.last() {
        a.list = Some(match inner.kind.as_str() {
            "orderedList" => ListKind::Ordered,
            "taskList" => ListKind::Task,
            _ => ListKind::Bullet,
        });
        a.list_level = (lists.len() - 1) as u32;
        if inner.kind == "orderedList" && int(inner.attrs.get("start")).is_some_and(|s| s != 1) {
            notes.add("ordered-list-start");
        }
    }
    // Only the innermost list item says whether this line is a task line.
    let item = line
        .path
        .iter()
        .rposition(|c| matches!(c.kind.as_str(), "listItem" | "taskItem"));
    for (depth, c) in line.path.iter().enumerate() {
        match c.kind.as_str() {
            "blockquote" => {
                a.quote = true;
                let qi = int(c.attrs.get("indent")).unwrap_or(0);
                if qi > 0 && a.indent == 0 {
                    a.indent = qi.clamp(0, MAX_INDENT as i64) as u8;
                    notes.add("quote-indent-on-paragraph");
                }
            }
            "callout" => a.callout = Some("note".into()),
            "taskItem" if Some(depth) == item => {
                let todo = c
                    .attrs
                    .get("todoId")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty());
                match todo {
                    Some(t) => {
                        a.todo = (ctx.todo)(t).or_else(|| CommentId::parse(t).ok());
                    }
                    None => {
                        a.checked = c.attrs.get("checked").and_then(Value::as_bool) == Some(true);
                    }
                }
            }
            "bulletList" | "orderedList" | "taskList" | "listItem" | "taskItem" => {}
            other => notes.add(format!("unknown-container:{other}")),
        }
    }
    if a.todo.is_some() {
        a.checked = false;
    }
    let restricted = a.clone().restricted_to(ctx.profile);
    if restricted != a {
        notes.add("note-attribute-in-prose");
    }
    restricted
}

/// Plan one document: `prose` parsed from its cache, `blocks` from
/// [`doc_blocks`].
pub fn plan(prose: &Prose, blocks: &DocBlocks, ctx: &Context<'_>) -> Plan {
    let mut notes = blocks.notes.clone();
    let mut dropped_inline = Vec::new();
    let mut paras: Vec<Para> = Vec::new();
    let mut lines: Vec<LineAt> = Vec::with_capacity(prose.lines.len());
    let mut embed_n = 0usize;
    let mut i = 0;
    while i < prose.lines.len() {
        let line = &prose.lines[i];
        let id = blocks.line_ids[i].clone();
        if let Some(depth) = table_depth(line) {
            let key = table_key(line, depth);
            let mut j = i;
            while j < prose.lines.len()
                && table_depth(&prose.lines[j])
                    .is_some_and(|d| table_key(&prose.lines[j], d) == key)
            {
                j += 1;
            }
            let para = paras.len();
            paras.push(table_para(
                &prose.lines[i..j],
                depth,
                id,
                &mut embed_n,
                &mut notes,
            ));
            for _ in i..j {
                lines.push(LineAt::Embed { para });
            }
            i = j;
            continue;
        }
        match line.kind.as_str() {
            "horizontalRule" => {
                let mut attrs = line_attrs(
                    &Line {
                        kind: "paragraph".into(),
                        ..line.clone()
                    },
                    ctx,
                    &mut notes,
                );
                attrs.rule = true;
                lines.push(LineAt::Body {
                    para: paras.len(),
                    dropped: Vec::new(),
                });
                paras.push(Para {
                    id,
                    attrs,
                    runs: Vec::new(),
                    embed: None,
                });
            }
            "materialEmbed" => {
                let material = line
                    .attrs
                    .get("libraryItemId")
                    .and_then(Value::as_str)
                    .and_then(|m| MaterialId::parse(m).ok());
                lines.push(LineAt::Body {
                    para: paras.len(),
                    dropped: Vec::new(),
                });
                match material {
                    Some(m) if ctx.profile == ProseProfile::Note => {
                        let eid = embed_id(id.as_ref(), &mut embed_n);
                        paras.push(embed_para(
                            id,
                            eid.clone(),
                            EmbedView::Material {
                                id: eid,
                                material: Some(m),
                            },
                        ));
                    }
                    _ => {
                        notes.add("material-embed-dropped");
                        paras.push(Para::plain(id));
                    }
                }
            }
            _ => {
                if line.atom && !matches!(line.kind.as_str(), "paragraph" | "heading" | "codeBlock")
                {
                    notes.add(format!("unknown-atom:{}", line.kind));
                }
                let attrs = line_attrs(line, ctx, &mut notes);
                // D3 lists are one paragraph per item: a later paragraph of
                // the same item becomes an item of its own.
                if line.ordinal > 0
                    && line
                        .path
                        .last()
                        .is_some_and(|c| matches!(c.kind.as_str(), "listItem" | "taskItem"))
                {
                    notes.add("list-item-extra-paragraph");
                }
                let (chars, dropped) =
                    runs_of(line, ctx.profile, ctx, &mut notes, &mut dropped_inline);
                lines.push(LineAt::Body {
                    para: paras.len(),
                    dropped,
                });
                // A code block's `\n` ends a paragraph; the first keeps the id.
                let mut current = Para {
                    id,
                    attrs: attrs.clone(),
                    runs: Vec::new(),
                    embed: None,
                };
                for (c, marks) in chars {
                    if c == '\n' {
                        paras.push(std::mem::replace(
                            &mut current,
                            Para {
                                id: None,
                                attrs: attrs.clone(),
                                runs: Vec::new(),
                                embed: None,
                            },
                        ));
                        notes.add("code-block-line");
                        continue;
                    }
                    push_char(&mut current.runs, c, &marks);
                }
                paras.push(current);
            }
        }
        i += 1;
    }
    // The body always ends with a paragraph of text (the genesis newline):
    // an embed cannot be last.
    if paras.last().is_none_or(|p| p.embed.is_some()) {
        if !paras.is_empty() {
            notes.add("paragraph-after-final-embed");
        }
        paras.push(Para::plain(None));
    }
    Plan {
        profile: ctx.profile,
        paras,
        lines,
        notes,
        dropped_inline,
    }
}

fn embed_id(id: Option<&BlockId>, n: &mut usize) -> EmbedId {
    *n += 1;
    match id {
        Some(b) => EmbedId::parse(b.as_str()).expect("a block id is a valid embed id"),
        None => EmbedId::parse(&format!("embed-{n}")).expect("valid id"),
    }
}

fn embed_para(id: Option<BlockId>, eid: EmbedId, view: EmbedView) -> Para {
    Para {
        id,
        attrs: BlockAttrs::default(),
        runs: vec![Run {
            text: OBJECT_CHAR.to_string(),
            marks: InlineMarks {
                embed: Some(eid),
                ..InlineMarks::default()
            },
        }],
        embed: Some(view),
    }
}

/// Row and column ids of an imported table.
pub(crate) fn line_ids(prefix: char, n: usize) -> Vec<TableLine> {
    let keys = keys_between(None, None, n).unwrap_or_default();
    (0..n)
        .map(|i| TableLine {
            id: format!("{prefix}{i}"),
            pos: keys.get(i).and_then(|k| PosKey::parse(k).ok()),
        })
        .collect()
}

fn table_para(
    lines: &[Line],
    depth: usize,
    id: Option<BlockId>,
    n: &mut usize,
    notes: &mut Notes,
) -> Para {
    // (row ordinal, cell ordinal) → paragraphs' text.
    let mut cells: BTreeMap<(usize, usize), Vec<String>> = BTreeMap::new();
    for line in lines {
        let path = &line.path[depth + 1..];
        let row = path.first().map_or(0, |c| c.ordinal);
        let cell = path.get(1);
        let col = cell.map_or(0, |c| c.ordinal);
        if let Some(c) = cell {
            if c.kind == "tableHeader" {
                notes.add("table-header-cell");
            }
            let span = |k: &str| int(c.attrs.get(k)).is_some_and(|v| v != 1);
            if span("colspan") || span("rowspan") || c.attrs.contains_key("colwidth") {
                notes.add("table-cell-span");
            }
        }
        if !line.marks.is_empty() {
            notes.add("table-cell-marks");
        }
        cells
            .entry((row, col))
            .or_default()
            .push(line.text.replace(INLINE_OBJECT, ""));
    }
    let rows_n = cells.keys().map(|k| k.0 + 1).max().unwrap_or(0);
    let cols_n = cells.keys().map(|k| k.1 + 1).max().unwrap_or(0);
    let rows = line_ids('r', rows_n);
    let cols = line_ids('c', cols_n);
    let mut out = BTreeMap::new();
    for ((r, c), texts) in cells {
        if texts.len() > 1 {
            notes.add("table-cell-paragraphs-joined");
        }
        out.insert(
            (rows[r].id.clone(), cols[c].id.clone()),
            texts.join(&LINE_BREAK.to_string()),
        );
    }
    let eid = embed_id(id.as_ref(), n);
    embed_para(
        id,
        eid.clone(),
        EmbedView::Table {
            id: eid,
            cols,
            rows,
            cells: out,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prose::pm::parse;
    use dr_model::kind::EntityKind;

    fn ctx(profile: ProseProfile) -> Context<'static> {
        Context {
            profile,
            span: &|_| None,
            todo: &|_| None,
        }
    }

    fn plan_of(json: &str, profile: ProseProfile) -> Plan {
        let prose = parse(json).unwrap();
        let blocks = doc_blocks(&prose);
        plan(&prose, &blocks, &ctx(profile))
    }

    #[test]
    fn chapter_paragraphs_marks_and_quotes() {
        let p = plan_of(
            r#"{"type":"doc","content":[
              {"type":"heading","attrs":{"id":"h1","level":2,"indent":0},"content":[{"type":"text","text":"第一章"}]},
              {"type":"paragraph","attrs":{"id":"p1","textAlign":"center","indent":2},"content":[
                {"type":"text","text":"我要给"},
                {"type":"text","text":"阿Q","marks":[{"type":"italic"},{"type":"entityLink","attrs":{"targetKind":"element","targetId":"e1","targetBlockId":null}}]},
                {"type":"text","text":"做正传"},{"type":"hardBreak"},{"type":"text","text":"第二行","marks":[{"type":"bold"}]}]},
              {"type":"blockquote","attrs":{"id":"q1"},"content":[
                {"type":"paragraph","attrs":{"id":"p2"},"content":[{"type":"text","text":"信"}]},
                {"type":"paragraph","content":[{"type":"text","text":"第二段"}]}]}
            ]}"#,
            ProseProfile::Prose,
        );
        assert_eq!(p.paras.len(), 4);
        assert_eq!(p.paras[0].attrs.heading, Some(Heading::H2));
        assert_eq!(p.paras[1].attrs.align, Align::Center);
        assert_eq!(p.paras[1].attrs.indent, 2);
        assert_eq!(
            p.paras[1].text(),
            format!("我要给阿Q做正传{LINE_BREAK}第二行")
        );
        let linked = &p.paras[1].runs[1];
        assert_eq!(linked.text, "阿Q");
        assert!(linked.marks.italic);
        assert_eq!(linked.marks.entities[0].target, "e1");
        assert_eq!(linked.marks.entities[0].kind, EntityKind::Element);
        assert!(p.paras[1].runs.last().unwrap().marks.bold);
        assert!(p.paras[2].attrs.quote && p.paras[3].attrs.quote);
        assert_eq!(p.paras[2].id.as_ref().unwrap().as_str(), "p2");
        assert_eq!(p.paras[3].id, None);
        assert_eq!(p.notes.0.get("container-id-remapped"), Some(&1));
        assert_eq!(
            p.body_text().chars().count(),
            3 + 1 + 12 + 1 + 1 + 1 + 3 + 1
        );
    }

    #[test]
    fn note_lists_tasks_tables_and_embeds() {
        let todo = |old: &str| {
            (old == "todo-1").then(|| CommentId::parse("todo:note_task:material:m#tp1").unwrap())
        };
        let c = Context {
            profile: ProseProfile::Note,
            span: &|_| None,
            todo: &todo,
        };
        let prose = parse(
            r#"{"type":"doc","content":[
              {"type":"taskList","attrs":{"id":"t"},"content":[
                {"type":"taskItem","attrs":{"id":"ti1","checked":true,"todoId":"todo-1"},"content":[{"type":"paragraph","attrs":{"id":"tp1"},"content":[{"type":"text","text":"核对"}]}]},
                {"type":"taskItem","attrs":{"id":"ti2","checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"补"}]},
                   {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","attrs":{"id":"n1"},"content":[{"type":"text","text":"深"}]}]}]}]}]},
              {"type":"table","attrs":{"id":"tb"},"content":[
                {"type":"tableRow","content":[{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"人物"}]}]},{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"年龄"}]}]}]},
                {"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"赵太爷"}]},{"type":"paragraph","content":[{"type":"text","text":"举人"}]}]}]}]},
              {"type":"codeBlock","attrs":{"id":"cb","language":"rust"},"content":[{"type":"text","text":"a\nb"}]},
              {"type":"materialEmbed","attrs":{"id":"me","libraryItemId":"lib-1"}}
            ]}"#,
        )
        .unwrap();
        let blocks = doc_blocks(&prose);
        // ti2's paragraph has no id: it takes the task item's.
        assert_eq!(blocks.line_ids[1].as_ref().unwrap().as_str(), "ti2");
        assert_eq!(
            blocks.span("t"),
            Some(BlockSpan {
                first: BlockId::parse("tp1").ok(),
                last: BlockId::parse("n1").ok()
            })
        );
        let p = plan(&prose, &blocks, &c);
        let a0 = &p.paras[0].attrs;
        assert_eq!(a0.list, Some(ListKind::Task));
        assert_eq!(
            a0.todo.as_ref().unwrap().as_str(),
            "todo:note_task:material:m#tp1"
        );
        assert!(!a0.checked, "a linked task has no state of its own");
        assert!(p.paras[1].attrs.checked);
        assert_eq!(p.paras[2].attrs.list, Some(ListKind::Bullet));
        assert_eq!(p.paras[2].attrs.list_level, 1);
        assert!(
            !p.paras[2].attrs.checked,
            "a nested bullet is not its task's line"
        );
        let Some(EmbedView::Table {
            cells, rows, cols, ..
        }) = &p.paras[3].embed
        else {
            panic!("table")
        };
        assert_eq!((rows.len(), cols.len()), (2, 2));
        assert_eq!(
            cells[&("r1".into(), "c0".into())],
            format!("赵太爷{LINE_BREAK}举人")
        );
        assert_eq!(p.paras[3].id.as_ref().unwrap().as_str(), "tb");
        // Code: one paragraph per line, the first keeps the id.
        assert_eq!(p.paras[4].text(), "a");
        assert_eq!(p.paras[5].text(), "b");
        assert_eq!(p.paras[5].attrs.code_block.as_deref(), Some("rust"));
        assert_eq!(p.paras[5].id, None);
        assert!(matches!(p.paras[6].embed, Some(EmbedView::Material { .. })));
        // An embed cannot be last.
        assert_eq!(p.paras.len(), 8);
        assert!(p.paras[7].embed.is_none());
        assert_eq!(p.notes.0["table-header-cell"], 1);
        assert_eq!(p.notes.0["table-cell-paragraphs-joined"], 1);
        assert_eq!(p.lines[3], LineAt::Embed { para: 3 });
    }

    #[test]
    fn note_attributes_and_marks_are_dropped_in_prose() {
        let p = plan_of(
            r#"{"type":"doc","content":[{"type":"bulletList","content":[{"type":"listItem","content":[
              {"type":"paragraph","attrs":{"id":"a"},"content":[{"type":"text","text":"x","marks":[{"type":"highlight"},{"type":"code"},{"type":"strange"}]},{"type":"mention","attrs":{"who":"z"}},{"type":"text","text":"y"}]}]}]}]}"#,
            ProseProfile::Prose,
        );
        assert_eq!(p.paras[0].attrs, BlockAttrs::default());
        assert_eq!(p.paras[0].text(), "xy");
        assert!(p.paras[0].runs[0].marks.is_plain());
        assert_eq!(p.notes.0["note-attribute-in-prose"], 1);
        assert_eq!(p.notes.0["highlight-in-prose"], 1);
        assert_eq!(p.notes.0["unknown-mark:strange"], 1);
        assert_eq!(p.notes.0["unknown-inline:mention"], 1);
        assert_eq!(
            p.lines[0],
            LineAt::Body {
                para: 0,
                dropped: vec![1]
            }
        );
        let starts = p.starts();
        assert_eq!(p.body_pos(&starts, 0, 2), Some(1));
        assert_eq!(p.dropped_inline.len(), 1);
    }

    #[test]
    fn empty_documents_are_one_empty_paragraph() {
        for json in ["{}", r#"{"type":"doc","content":[]}"#] {
            let p = plan_of(json, ProseProfile::Prose);
            assert_eq!(p.paras, vec![Para::plain(None)]);
            assert!(p.notes.is_empty());
        }
    }
}
