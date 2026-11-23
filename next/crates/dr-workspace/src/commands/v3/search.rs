//! Finding text in a book: `entry.search` (a word or phrase anywhere in the
//! entries' text) and `entry.mentions` (the prose that links to an entry).
//!
//! Both read the derived index (dr-index's paragraph rows and references,
//! dr-store's search), never open the prose documents, and follow the
//! search view's rules (`dr-view-search`'s `v3::search`): the same entries
//! (live ones, unless the trash is asked for), the same order (the entry
//! tree depth first; in an entry its title, then its modules in template
//! order, then retained ones), the same fields and the same matching
//! (dr-store's trigram full-text search from three characters, a substring
//! scan below; a case-insensitive literal match in the short texts).
//! Templates, comments and the asset library are not searched. A hit is
//! not a read: write guards still need the prose or the module read.
use super::*;
use dr_store::index::RefKind;

pub(crate) fn register(r: &mut Registry) {
    r.add::<EntrySearch>().add::<EntryMentions>();
}

/// Hits or places per page when `limit` is not given.
pub const DEFAULT_LIMIT: usize = 20;
/// At most this many per page.
pub const MAX_LIMIT: usize = 50;
/// Characters of text kept on each side of a match.
const CONTEXT: usize = 24;

fn page_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn is_caseless_singleton(c: char) -> bool {
    matches!(
        c,
        '0'..='9'
            | '\u{3000}'..='\u{303F}'
            | '\u{3400}'..='\u{4DBF}'
            | '\u{4E00}'..='\u{9FFF}'
            | '\u{F900}'..='\u{FAFF}'
    )
}

/// Where `query` first occurs in `text`, in characters: a literal match
/// under simple case folding (the search view's rule).
pub fn find(text: &str, query: &str) -> Option<std::ops::Range<usize>> {
    if query.is_empty() {
        return None;
    }
    if text.is_ascii() && query.is_ascii() {
        if query.len() > text.len() {
            return None;
        }
        let qb = query.as_bytes();
        let at = text
            .as_bytes()
            .windows(qb.len())
            .position(|part| part.eq_ignore_ascii_case(qb))?;
        return Some(at..at + qb.len());
    }
    if query.chars().all(is_caseless_singleton) {
        let byte_at = text.find(query)?;
        let start = text[..byte_at].chars().count();
        let len = query.chars().count();
        return Some(start..start + len);
    }
    let hay: Vec<char> = text.chars().collect();
    let needle: Vec<char> = query.chars().collect();
    if needle.len() > hay.len() {
        return None;
    }
    let fold = |c: char| c.to_lowercase().next().unwrap_or(c);
    let at = hay
        .windows(needle.len())
        .position(|part| part.iter().zip(&needle).all(|(a, b)| fold(*a) == fold(*b)))?;
    Some(at..at + needle.len())
}

/// `text` around `found` (characters), control characters as spaces.
fn around(text: &str, found: std::ops::Range<usize>) -> String {
    let start = found.start.saturating_sub(CONTEXT);
    text.chars()
        .skip(start)
        .take(found.end + CONTEXT - start)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// What part of an entry a hit is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FoundIn {
    /// The entry's title.
    Title,
    /// A field of a fields module.
    Field,
    /// A row of a key/value module (its key and value).
    Row,
    /// A record of a patches module (its title and text).
    Patch,
    /// A row or column label or a cell of a plot module.
    Plot,
    /// A paragraph of a prose module.
    Prose,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SearchIn {
    pub book: String,
    /// A word or phrase, matched as written (case-insensitive), not split
    /// into words.
    pub query: String,
    /// Also search entries in Recently Deleted.
    #[serde(default)]
    pub trashed: bool,
    /// The first hit to return (0-based), from a previous page's `next`.
    #[serde(default)]
    pub from: usize,
    /// At most this many hits (default 20, at most 50).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

/// One place the query was found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct SearchHit {
    pub entry: String,
    /// The entry's title.
    pub title: String,
    /// The module the text is in; absent for a hit in the title.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    /// The module's name in the entry's template (absent for a module the
    /// template no longer has).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_name: Option<String>,
    #[serde(rename = "in")]
    pub found_in: FoundIn,
    /// A field hit's field id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// A field hit's field name in the template.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_name: Option<String>,
    /// A prose hit's document (`body:<entry>/<module>`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    /// A prose hit's paragraph (0-based, as prose.read numbers them).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paragraph: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    /// The match with the text around it.
    pub snippet: String,
    /// The entry is in Recently Deleted.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trashed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct SearchOut {
    pub hits: Vec<SearchHit>,
    /// The `from` of the next page; absent on the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<usize>,
}

/// The entries searched, in order, with their modules in order and the
/// prose documents that are stored.
struct Scope {
    entries: Vec<m::Entry>,
    templates: BTreeMap<EntryTemplateId, m::EntryTemplate>,
    modules: BTreeMap<EntryId, Vec<String>>,
    /// The stored prose documents of those modules, in the same order.
    docs: Vec<String>,
    trashed: BTreeSet<EntryId>,
}

fn scope(
    cx: &Cx<'_>,
    slot: &BookSlot,
    v: &BookViewV3<'_>,
    patches: &[m::PatchV3],
    grids: &[m::PlotGridV3],
    trashed: bool,
) -> Result<Scope> {
    let entries = v.entries_raw();
    let templates = v.templates_map();
    let map: BTreeMap<_, _> = entries.iter().map(|e| (e.id.clone(), e.clone())).collect();
    let stored = cx
        .workspace()
        .library()
        .docs(Some(slot.book.as_str()), None)?;
    let stored_ids: BTreeSet<&str> = stored.iter().map(|d| d.doc_id.as_str()).collect();
    let mut bodies: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for info in &stored {
        if let Ok(DocId::Body(body)) = DocId::parse(&info.doc_id) {
            bodies
                .entry(body.entry().to_string())
                .or_default()
                .insert(body.module().to_string());
        }
    }
    let mut extra: BTreeMap<&EntryId, BTreeSet<String>> = BTreeMap::new();
    for (entry, module) in patches
        .iter()
        .map(|p| (&p.entry, &p.module))
        .chain(grids.iter().map(|g| (&g.entry, &g.module)))
    {
        extra.entry(entry).or_default().insert(module.to_string());
    }
    let mut out = Scope {
        entries: Vec::new(),
        templates,
        modules: BTreeMap::new(),
        docs: Vec::new(),
        trashed: BTreeSet::new(),
    };
    for entry in entries {
        let in_trash = entry.is_trashed()
            || m::effective_ancestors(&map, &entry.id)
                .iter()
                .any(|a| map.get(a).is_none_or(m::Entry::is_trashed));
        if in_trash && !trashed {
            continue;
        }
        let mut modules: Vec<String> = entry
            .effective_template(&out.templates)
            .map(|t| t.modules.iter().map(|m| m.id.to_string()).collect())
            .unwrap_or_default();
        let mut retained = bodies.get(entry.id.as_str()).cloned().unwrap_or_default();
        retained.extend(
            entry
                .fields
                .keys()
                .chain(entry.kv.keys())
                .map(ToString::to_string),
        );
        if let Some(mods) = extra.get(&entry.id) {
            retained.extend(mods.iter().cloned());
        }
        for id in retained {
            if !modules.contains(&id) {
                modules.push(id);
            }
        }
        for module in &modules {
            let doc = format!("body:{}/{module}", entry.id);
            if stored_ids.contains(doc.as_str()) {
                out.docs.push(doc);
            }
        }
        if in_trash {
            out.trashed.insert(entry.id.clone());
        }
        out.modules.insert(entry.id.clone(), modules);
        out.entries.push(entry);
    }
    Ok(out)
}

/// The hits of `query` in the book, in order, until `want` of them.
fn search(cx: &Cx<'_>, input: &SearchIn, want: usize) -> Result<Vec<SearchHit>> {
    let query = input.query.trim();
    if query.is_empty() || want == 0 {
        return Ok(Vec::new());
    }
    let slot = cx.book_v3(&input.book)?;
    let v = slot.reader_v3.view();
    let patches = v.patches();
    let grids = v.plot_grids();
    let scope = scope(cx, &slot, &v, &patches, &grids, input.trashed)?;
    let mut patches_by: BTreeMap<(&EntryId, String), Vec<&m::PatchV3>> = BTreeMap::new();
    for p in &patches {
        patches_by
            .entry((&p.entry, p.module.to_string()))
            .or_default()
            .push(p);
    }
    let mut grids_by: BTreeMap<(&EntryId, String), Vec<&m::PlotGridV3>> = BTreeMap::new();
    for g in &grids {
        grids_by
            .entry((&g.entry, g.module.to_string()))
            .or_default()
            .push(g);
    }
    // Prose: dr-store ranks the hits in these documents' order and cuts at
    // `want`; hits elsewhere (trashed entries, templates) come after them
    // and are dropped. Fresh first, so the Agent finds what it just wrote.
    let mut prose: BTreeMap<String, Vec<(u32, Option<String>, String)>> = BTreeMap::new();
    if !scope.docs.is_empty() {
        cx.workspace().flush_book_prose_indices(&slot.book)?;
        let order: Vec<&str> = scope.docs.iter().map(String::as_str).collect();
        let eligible: BTreeSet<&str> = order.iter().copied().collect();
        for hit in cx.workspace().library().search_in_order(
            Some(slot.book.as_str()),
            query,
            want,
            &order,
        )? {
            if !eligible.contains(hit.doc_id.as_str()) {
                continue;
            }
            if let Some(found) = find(&hit.snippet, query) {
                prose.entry(hit.doc_id).or_default().push((
                    hit.ord,
                    hit.block_id,
                    around(&hit.snippet, found),
                ));
            }
        }
    }
    let mut out: Vec<SearchHit> = Vec::new();
    let mut scratch = String::new();
    for entry in &scope.entries {
        if out.len() >= want {
            break;
        }
        let trashed = scope.trashed.contains(&entry.id);
        let hit = |module: Option<(&str, Option<&str>)>, found_in, snippet| SearchHit {
            entry: entry.id.to_string(),
            title: entry.title.clone(),
            module: module.map(|(id, _)| id.to_owned()),
            module_name: module.and_then(|(_, name)| name.map(str::to_owned)),
            found_in,
            field: None,
            field_name: None,
            doc: None,
            paragraph: None,
            block_id: None,
            snippet,
            trashed,
        };
        if let Some(found) = find(&entry.title, query) {
            out.push(hit(None, FoundIn::Title, around(&entry.title, found)));
        }
        let template = entry.effective_template(&scope.templates);
        for module in scope.modules.get(&entry.id).into_iter().flatten() {
            if out.len() >= want {
                break;
            }
            let definition =
                template.and_then(|t| t.modules.iter().find(|m| m.id.as_str() == module));
            let at = Some((module.as_str(), definition.map(|m| m.name.as_str())));
            let text = |s: &str, found_in: FoundIn, out: &mut Vec<SearchHit>| {
                if out.len() < want
                    && let Some(found) = find(s, query)
                {
                    out.push(hit(at, found_in, around(s, found)));
                    true
                } else {
                    false
                }
            };
            if let Some(fields) = entry
                .fields
                .iter()
                .find(|(id, _)| id.as_str() == module)
                .map(|(_, f)| f)
            {
                for (key, value) in fields {
                    let def = definition.and_then(|m| m.config.defs.iter().find(|f| &f.id == key));
                    // Ids stored in image and reference fields are not text.
                    if def.is_some_and(|f| {
                        matches!(f.field_type, m::FieldType::Image | m::FieldType::EntityRef)
                    }) {
                        continue;
                    }
                    let values: Vec<&str> = match value {
                        m::FieldValue::Text(s) => vec![s.as_str()],
                        m::FieldValue::List(xs) => xs.iter().map(String::as_str).collect(),
                        _ => Vec::new(),
                    };
                    for s in values {
                        if text(s, FoundIn::Field, &mut out)
                            && let Some(last) = out.last_mut()
                        {
                            last.field = Some(key.clone());
                            last.field_name = def.map(|f| f.name.clone());
                        }
                    }
                }
            }
            if let Some(kv) = entry
                .kv
                .iter()
                .find(|(id, _)| id.as_str() == module)
                .map(|(_, kv)| kv)
            {
                for item in kv {
                    scratch.clear();
                    scratch.push_str(&item.key);
                    scratch.push(' ');
                    scratch.push_str(&item.value);
                    text(&scratch, FoundIn::Row, &mut out);
                }
            }
            for patch in patches_by
                .get(&(&entry.id, module.clone()))
                .into_iter()
                .flatten()
            {
                scratch.clear();
                scratch.push_str(patch.title.as_deref().unwrap_or_default());
                scratch.push(' ');
                scratch.push_str(&patch.body);
                text(&scratch, FoundIn::Patch, &mut out);
            }
            for grid in grids_by
                .get(&(&entry.id, module.clone()))
                .into_iter()
                .flatten()
            {
                for s in grid
                    .rows
                    .iter()
                    .map(|l| &l.label)
                    .chain(grid.cols.iter().map(|l| &l.label))
                    .chain(grid.cells.values())
                {
                    text(s, FoundIn::Plot, &mut out);
                }
            }
            let doc = format!("body:{}/{module}", entry.id);
            for (paragraph, block_id, snippet) in prose.remove(&doc).unwrap_or_default() {
                if out.len() >= want {
                    break;
                }
                let mut h = hit(at, FoundIn::Prose, snippet);
                h.doc = Some(doc.clone());
                h.paragraph = Some(paragraph);
                h.block_id = block_id;
                out.push(h);
            }
        }
    }
    Ok(out)
}

op! {
    EntrySearch = "entry.search", Read, Shared,
    "Search the book's entries for a word or phrase, matched as written (case-insensitive, not split into words): titles, field values, key/value rows, patches, plot cells and prose, not templates or comments. Hits come in manuscript order, each with its entry, its module and the text around the match; a prose hit (one per paragraph) also gives its document, paragraph number and block ID. At most `limit` hits (default 20, at most 50) from `from`; `next` is the `from` of the next page. Entries in Recently Deleted only with `trashed: true`. A hit is not a read of the prose.",
    fn(cx, input: SearchIn) -> SearchOut {
        let limit = page_limit(input.limit);
        let end = input.from.saturating_add(limit);
        let mut hits = search(cx, &input, end.saturating_add(1))?;
        let next = (hits.len() > end).then_some(end);
        hits.truncate(end);
        let hits = hits.into_iter().skip(input.from).collect();
        Ok(SearchOut { hits, next })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MentionsIn {
    pub book: String,
    /// The entry linked to.
    pub entry: String,
    /// Also list paragraphs of entries in Recently Deleted.
    #[serde(default)]
    pub trashed: bool,
    /// The first paragraph to return (0-based), from a previous page's `next`.
    #[serde(default)]
    pub from: usize,
    /// At most this many paragraphs (default 20, at most 50).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

/// One paragraph that links to the entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct Mention {
    /// The entry whose prose it is.
    pub entry: String,
    pub title: String,
    pub module: String,
    /// The module's name in the entry's template (absent for a module the
    /// template no longer has).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_name: Option<String>,
    /// The prose document (`body:<entry>/<module>`).
    pub doc: String,
    /// The paragraph (0-based, as prose.read numbers them); absent when
    /// the index cannot place it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paragraph: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<String>,
    /// Separate links to the entry in the paragraph.
    pub links: u32,
    /// The paragraph's text around the entry's name (from its start when
    /// the linked text is not one of the entry's names).
    pub snippet: String,
    /// The entry the prose belongs to is in Recently Deleted.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trashed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct MentionsOut {
    /// The entry linked to and its title.
    pub entry: String,
    pub title: String,
    /// Paragraphs in all (every page).
    pub total: usize,
    /// Links in all (a paragraph can hold several).
    pub links: u64,
    pub mentions: Vec<Mention>,
    /// The `from` of the next page; absent on the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<usize>,
}

op! {
    EntryMentions = "entry.mentions", Read, Shared,
    "List the paragraphs of the book's prose that link to an entry (its name or an alias linked automatically, counted while the entry's own automatic linking and the author's setting are on, or a link the author picked with @, always counted), in manuscript order, each with the entry and module it is in, its document, paragraph number and block ID, how many links to the entry it holds and the text around the entry's name. `total` counts the paragraphs, `links` the links. At most `limit` paragraphs (default 20, at most 50) from `from`; `next` is the `from` of the next page. Paragraphs in entries in Recently Deleted only with `trashed: true`. Text that names the entry without a link is found with entry.search.",
    fn(cx, input: MentionsIn) -> MentionsOut {
        let limit = page_limit(input.limit);
        let slot = cx.book_v3(&input.book)?;
        let v = slot.reader_v3.view();
        let target = v
            .entry_raw(&pid("entry", &input.entry)?)
            .ok_or_else(|| WsError::not_found("entry", &input.entry))?;
        let scope = scope(cx, &slot, &v, &v.patches(), &v.plot_grids(), input.trashed)?;
        let rank: BTreeMap<&str, usize> = scope
            .docs
            .iter()
            .enumerate()
            .map(|(i, d)| (d.as_str(), i))
            .collect();
        cx.workspace().flush_book_prose_indices(&slot.book)?;
        // The links that read as links (`kernel-v5.md` §16): one picked with
        // @ always, an automatic one while the entry's own 「自动链接」 and
        // the author's setting are on.
        let automatic_shown = cx.workspace().auto_links() && target.auto_link;
        // (rank, block) -> links, one place per paragraph.
        let mut places: BTreeMap<usize, BTreeMap<Option<String>, u32>> = BTreeMap::new();
        for r in cx.workspace().library().references_to(target.id.as_str())? {
            let shown = match r.kind {
                RefKind::Link => automatic_shown,
                RefKind::Mention => true,
                RefKind::Embed => false,
            };
            if r.book_id.as_deref() != Some(slot.book.as_str())
                || !shown
                || r.target_kind == "asset"
                || r.count == 0
            {
                continue;
            }
            let Some(&n) = rank.get(r.source_doc.as_str()) else {
                continue;
            };
            let block = r.source_block.filter(|b| !b.is_empty());
            *places.entry(n).or_default().entry(block).or_default() += r.count;
        }
        let total = places.values().map(BTreeMap::len).sum();
        let links = places.values().flat_map(BTreeMap::values).map(|n| u64::from(*n)).sum();
        let names: Vec<String> = std::iter::once(target.title.clone())
            .chain(target.aliases(&scope.templates))
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty())
            .collect();
        let snippet = |text: &str| {
            let found = names
                .iter()
                .filter_map(|n| find(text, n))
                .min_by_key(|r| (r.start, std::cmp::Reverse(r.end)));
            around(text, found.unwrap_or(0..CONTEXT))
        };
        let owners: BTreeMap<String, &m::Entry> = scope
            .entries
            .iter()
            .map(|e| (e.id.to_string(), e))
            .collect();
        let end = input.from.saturating_add(limit);
        let mut mentions = Vec::new();
        let mut seen = 0usize;
        for (n, blocks) in &places {
            if seen >= end {
                break;
            }
            if seen + blocks.len() <= input.from {
                seen += blocks.len();
                continue;
            }
            let doc = &scope.docs[*n];
            let Ok(DocId::Body(body)) = DocId::parse(doc) else {
                continue;
            };
            let Some(owner) = owners.get(body.entry().as_str()) else {
                continue;
            };
            let module = body.module().to_string();
            let module_name = owner
                .effective_template(&scope.templates)
                .and_then(|t| t.modules.iter().find(|m| m.id.as_str() == module))
                .map(|m| m.name.clone());
            let ids: Vec<&str> = blocks.keys().flatten().map(String::as_str).collect();
            let found = cx.workspace().library().paragraphs_by_block(doc, &ids)?;
            let by_block: BTreeMap<&str, (u32, String)> = ids
                .iter()
                .zip(found)
                .filter_map(|(id, p)| p.map(|p| (*id, p)))
                .collect();
            let mut here: Vec<Mention> = blocks
                .iter()
                .map(|(block, count)| {
                    let paragraph = block.as_deref().and_then(|b| by_block.get(b));
                    Mention {
                        entry: owner.id.to_string(),
                        title: owner.title.clone(),
                        module: module.clone(),
                        module_name: module_name.clone(),
                        doc: doc.clone(),
                        paragraph: paragraph.map(|p| p.0),
                        block_id: block.clone(),
                        links: *count,
                        snippet: paragraph.map(|p| snippet(&p.1)).unwrap_or_default(),
                        trashed: scope.trashed.contains(&owner.id),
                    }
                })
                .collect();
            here.sort_by_key(|p| (p.paragraph.is_none(), p.paragraph));
            for place in here {
                if seen >= input.from && seen < end {
                    mentions.push(place);
                }
                seen += 1;
            }
        }
        Ok(MentionsOut {
            entry: target.id.to_string(),
            title: target.title.clone(),
            total,
            links,
            mentions,
            next: (end < total).then_some(end),
        })
    }
}
