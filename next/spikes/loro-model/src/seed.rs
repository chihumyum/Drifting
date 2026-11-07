//! Deterministic synthetic seed: the heavy workload of
//! `docs/rust-rewrite/benchmarks.md`, generated straight into Loro documents.
//!
//! "字" here is a Unicode scalar of body text, newlines excluded. All ids,
//! peers and timestamps derive from the seed number, so two runs produce
//! byte-identical documents (asserted in tests).

use std::fmt::Write as _;

use loro::{CommitOptions, LoroDoc, LoroValue};
use sha2::{Digest, Sha256};

use crate::anchor::Anchor;
use crate::book::{self, Book};
use crate::ids::{Rng, fnv1a64};
use crate::prose::ProseDoc;
use crate::schema::{self, block};

/// Common Han characters for synthetic prose. No real text is used.
const HAN: &str = "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处理南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞";
const SURNAMES: &str = "林沈顾陆苏叶许程韩唐宋萧白江秦温";

pub const SEED: u64 = 0x5EED_0C01;
/// Seed clock start (seconds) and step.
const T0: i64 = 1_762_000_000;

#[derive(Clone, Debug)]
pub struct SeedConfig {
    pub chapters: usize,
    pub chapter_chars: usize,
    pub chapter_min: usize,
    pub chapter_max: usize,
    pub elements: usize,
    pub element_chars: usize,
    pub element_min: usize,
    pub element_max: usize,
    pub drifts: usize,
    pub drift_chars: usize,
    pub drift_min: usize,
    pub drift_max: usize,
    pub notes: usize,
    pub note_chars: usize,
    pub note_min: usize,
    pub note_max: usize,
    pub storylines: usize,
    pub storyline_chars: usize,
    pub categories: usize,
    pub category_chars: usize,
    pub comments: usize,
    pub comment_chars: usize,
    pub todos: usize,
    pub todo_chars: usize,
    pub relations: usize,
    pub images: usize,
    pub pdfs: usize,
    /// One entity link per this many characters of chapter text.
    pub chars_per_link: usize,
}

impl SeedConfig {
    /// The heavy seed of benchmarks.md / seed-presets.json (stress preset).
    pub fn heavy() -> Self {
        Self {
            chapters: 100,
            chapter_chars: 1_500_000,
            chapter_min: 2_000,
            chapter_max: 20_000,
            elements: 300,
            element_chars: 500_000,
            element_min: 100,
            element_max: 10_000,
            drifts: 200,
            drift_chars: 1_000_000,
            drift_min: 1_000,
            drift_max: 50_000,
            notes: 60,
            note_chars: 500_000,
            note_min: 500,
            note_max: 10_000,
            storylines: 3,
            storyline_chars: 60_000,
            categories: 16,
            category_chars: 16_000,
            comments: 80,
            comment_chars: 40_000,
            todos: 120,
            todo_chars: 30_000,
            relations: 400,
            images: 24,
            pdfs: 12,
            chars_per_link: 150,
        }
    }

    /// A small seed with the same shape, for tests.
    pub fn tiny() -> Self {
        Self {
            chapters: 6,
            chapter_chars: 6_000,
            chapter_min: 200,
            chapter_max: 2_000,
            elements: 12,
            element_chars: 1_200,
            element_min: 50,
            element_max: 200,
            drifts: 5,
            drift_chars: 2_000,
            drift_min: 100,
            drift_max: 1_000,
            notes: 3,
            note_chars: 900,
            note_min: 100,
            note_max: 500,
            storylines: 2,
            storyline_chars: 400,
            categories: 3,
            category_chars: 300,
            comments: 6,
            comment_chars: 300,
            todos: 6,
            todo_chars: 200,
            relations: 10,
            images: 2,
            pdfs: 1,
            chars_per_link: 80,
        }
    }
}

/// How chapter bodies get their history.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum History {
    /// One insert per body: the shape right after importing an old library.
    Bulk,
    /// Simulated typing: chunks of 1–6 characters per commit, typos that are
    /// backspaced, occasional revisions earlier in the text, Enter per paragraph.
    Typed,
}

pub struct ProseEntry {
    pub doc_id: String,
    pub kind: &'static str,
    pub prose: ProseDoc,
    pub chars: usize,
}

#[derive(Debug, Default, Clone)]
pub struct SeedStats {
    pub chapters: usize,
    pub chapter_chars: usize,
    pub chapter_min: usize,
    pub chapter_max: usize,
    pub chapter_median: usize,
    pub elements: usize,
    pub element_chars: usize,
    pub drifts: usize,
    pub drift_chars: usize,
    pub drift_max: usize,
    pub notes: usize,
    pub note_chars: usize,
    pub storylines: usize,
    pub storyline_chars: usize,
    pub categories: usize,
    pub category_chars: usize,
    pub comments: usize,
    pub comment_chars: usize,
    pub todos: usize,
    pub todo_chars: usize,
    pub anchored_comments: usize,
    pub patches: usize,
    pub paragraphs: usize,
    pub headings: usize,
    pub links: usize,
    pub overlapping_links: usize,
    pub embeds: usize,
    pub relations: usize,
    pub commits: usize,
    /// Every body text, in document-id order: identical for Bulk and Typed.
    pub corpus_sha256: String,
    /// The book document's value (cursor bytes differ with the history).
    pub book_sha256: String,
}

pub struct Seed {
    pub book_id: String,
    pub book: Book,
    pub prose: Vec<ProseEntry>,
    pub stats: SeedStats,
}

/// Peer used to write a seed (or an import) of `doc_id`: deterministic, so
/// two devices importing the same library write identical changes that
/// Loro dedupes. Top bit clear, distinct from genesis peers.
pub fn import_peer(doc_id: &str) -> u64 {
    (fnv1a64(format!("import:{doc_id}").as_bytes()) & !(1 << 63)) | 1
}

/// Split `total` into `n` lengths within `[min, max]`, skewed long like the
/// old stress seed, summing exactly to `total`.
pub fn lengths(rng: &mut Rng, n: usize, total: usize, min: usize, max: usize) -> Vec<usize> {
    assert!(n * min <= total && total <= n * max, "infeasible lengths");
    let mut v: Vec<f64> = (0..n)
        .map(|_| {
            let u = rng.unit();
            min as f64 + (max - min) as f64 * (1.0 - u * u * u)
        })
        .collect();
    let sum: f64 = v.iter().sum();
    let scale = total as f64 / sum;
    for x in &mut v {
        *x = (*x * scale).clamp(min as f64, max as f64);
    }
    let mut out: Vec<usize> = v.iter().map(|x| x.round() as usize).collect();
    // Fix the residual within bounds.
    let mut diff = total as i64 - out.iter().sum::<usize>() as i64;
    let mut i = 0;
    while diff != 0 {
        let j = i % n;
        if diff > 0 && out[j] < max {
            let add = ((max - out[j]) as i64).min(diff);
            out[j] += add as usize;
            diff -= add;
        } else if diff < 0 && out[j] > min {
            let sub = ((out[j] - min) as i64).min(-diff);
            out[j] -= sub as usize;
            diff += sub;
        }
        i += 1;
    }
    out
}

/// Make the longest length exactly `max`, taking the difference from the
/// others (never below `min`), like the old seed's longest bodies.
pub fn force_max(lens: &mut [usize], min: usize, max: usize) {
    let Some((imax, _)) = lens.iter().enumerate().max_by_key(|(_, l)| **l) else {
        return;
    };
    let mut left = max - lens[imax];
    lens[imax] = max;
    for (j, l) in lens.iter_mut().enumerate() {
        if j == imax || left == 0 {
            continue;
        }
        let take = (*l - min).min(left);
        *l -= take;
        left -= take;
    }
}

/// One generated paragraph.
#[derive(Clone, Debug)]
pub struct GenPara {
    pub text: String,
    pub heading: Option<i64>,
    /// `(offset, len, target index)` in characters within the paragraph.
    pub links: Vec<(usize, usize, usize)>,
}

pub struct TextGen {
    han: Vec<char>,
    pub names: Vec<String>,
}

impl TextGen {
    pub fn new(rng: &mut Rng, names: usize) -> Self {
        let han: Vec<char> = HAN.chars().collect();
        let surnames: Vec<char> = SURNAMES.chars().collect();
        let mut seen = std::collections::BTreeSet::new();
        let mut out = Vec::new();
        while out.len() < names {
            let mut s = String::new();
            s.push(*rng.pick(&surnames));
            for _ in 0..rng.range(1, 2) {
                s.push(*rng.pick(&han));
            }
            if seen.insert(s.clone()) {
                out.push(s);
            }
        }
        Self { han, names: out }
    }

    fn sentence(&self, rng: &mut Rng, len: usize, out: &mut Vec<char>) {
        for _ in 0..len.saturating_sub(1) {
            out.push(*rng.pick(&self.han));
        }
        out.push(if rng.chance(0.7) { '，' } else { '。' });
    }

    /// Paragraphs totalling exactly `chars` characters (newlines excluded).
    pub fn body(
        &self,
        rng: &mut Rng,
        chars: usize,
        link_every: usize,
        headings: bool,
    ) -> Vec<GenPara> {
        let mut out = Vec::new();
        let mut remaining = chars;
        let mut since_heading = 0usize;
        while remaining > 0 {
            if headings && since_heading > 18 && remaining > 40 && rng.chance(0.2) {
                let len = rng.range(6, 14).min(remaining);
                let mut t = Vec::new();
                for _ in 0..len {
                    t.push(*rng.pick(&self.han));
                }
                let level = if rng.chance(0.1) {
                    1
                } else if rng.chance(0.7) {
                    2
                } else {
                    3
                };
                out.push(GenPara {
                    text: t.into_iter().collect(),
                    heading: Some(level),
                    links: Vec::new(),
                });
                remaining -= len;
                since_heading = 0;
                continue;
            }
            let mut len = rng.range(40, 360).min(remaining);
            if remaining - len < 20 {
                len = remaining;
            }
            let mut t: Vec<char> = Vec::with_capacity(len + 8);
            let mut links = Vec::new();
            while t.len() < len {
                if link_every > 0 && !self.names.is_empty() && rng.chance(18.0 / link_every as f64)
                {
                    let target = rng.below(self.names.len() as u64) as usize;
                    let name: Vec<char> = self.names[target].chars().collect();
                    if t.len() + name.len() <= len {
                        links.push((t.len(), name.len(), target));
                        t.extend(name);
                    }
                }
                let s = rng.range(6, 28);
                self.sentence(rng, s, &mut t);
            }
            t.truncate(len);
            links.retain(|(o, l, _)| o + l <= len);
            out.push(GenPara {
                text: t.into_iter().collect(),
                heading: None,
                links,
            });
            remaining -= len;
            since_heading += 1;
        }
        out
    }
}

struct Clock(i64);
impl Clock {
    fn tick(&mut self, s: i64) -> i64 {
        self.0 += s;
        self.0
    }
}

fn commit(doc: &LoroDoc, clock: &mut Clock, step: i64, commits: &mut usize) {
    doc.commit_with(CommitOptions::new().timestamp(clock.tick(step)));
    *commits += 1;
}

/// Write `paras` into an empty prose document in one insert.
fn write_bulk(
    prose: &ProseDoc,
    paras: &[GenPara],
    targets: &[(String, &'static str)],
) -> (usize, usize) {
    let text = prose.text();
    let mut joined = String::new();
    for (i, p) in paras.iter().enumerate() {
        if i > 0 {
            joined.push('\n');
        }
        joined.push_str(&p.text);
    }
    text.insert(0, &joined).expect("insert body");
    // Mark block ids and headings.
    let mut pos = 0usize;
    let mut links = 0;
    for (i, p) in paras.iter().enumerate() {
        let n = p.text.chars().count();
        let nl = pos + n;
        if i + 1 < paras.len() {
            let id = prose.fresh_block_id(nl);
            text.mark(nl..nl + 1, block::ID, id).expect("bid");
        }
        if let Some(h) = p.heading {
            text.mark(nl..nl + 1, block::HEADING, h).expect("heading");
        }
        for (o, l, t) in &p.links {
            let (id, kind) = &targets[*t % targets.len()];
            prose.link_entity(pos + o..pos + o + l, id, kind);
            links += 1;
        }
        pos = nl + 1;
    }
    (links, 0)
}

/// Type `paras` into an empty prose document commit by commit.
fn write_typed(
    prose: &ProseDoc,
    paras: &[GenPara],
    targets: &[(String, &'static str)],
    rng: &mut Rng,
    clock: &mut Clock,
    commits: &mut usize,
) -> usize {
    let doc = &prose.doc;
    let text = prose.text();
    let han: Vec<char> = HAN.chars().collect();
    let mut links = 0;
    for (i, p) in paras.iter().enumerate() {
        let para_start = text.len_unicode() - 1;
        let chars: Vec<char> = p.text.chars().collect();
        let mut k = 0;
        while k < chars.len() {
            let caret = text.len_unicode() - 1;
            if rng.chance(0.06) {
                // A typo, then backspace it.
                let n = rng.range(1, 3);
                let typo: String = (0..n).map(|_| *rng.pick(&han)).collect();
                text.insert(caret, &typo).unwrap();
                commit(doc, clock, 1, commits);
                text.delete(caret, n).unwrap();
                commit(doc, clock, 1, commits);
            }
            let n = rng.range(1, 6).min(chars.len() - k);
            let chunk: String = chars[k..k + n].iter().collect();
            text.insert(caret, &chunk).unwrap();
            commit(doc, clock, 1, commits);
            k += n;
        }
        if let Some(h) = p.heading {
            let nl = text.len_unicode() - 1;
            text.mark(nl..nl + 1, block::HEADING, h).unwrap();
        }
        for (o, l, t) in &p.links {
            let (id, kind) = &targets[*t % targets.len()];
            prose.link_entity(para_start + o..para_start + o + l, id, kind);
            links += 1;
        }
        if !p.links.is_empty() || p.heading.is_some() {
            commit(doc, clock, 1, commits);
        }
        // A revision somewhere earlier: insert a few characters, then remove them.
        if rng.chance(0.03) && para_start > 10 {
            let at = rng.range(0, para_start - 1);
            let n = rng.range(2, 10);
            let s: String = (0..n).map(|_| *rng.pick(&han)).collect();
            text.insert(at, &s).unwrap();
            commit(doc, clock, 5, commits);
            text.delete(at, n).unwrap();
            commit(doc, clock, 2, commits);
        }
        if i + 1 < paras.len() {
            let caret = text.len_unicode() - 1;
            prose.split(caret);
            commit(doc, clock, 1, commits);
        }
    }
    links
}

fn add_note_blocks(
    prose: &ProseDoc,
    rng: &mut Rng,
    idx: usize,
    todo_ids: &[String],
    material_ids: &[String],
) -> usize {
    // Turn some paragraphs into list items, task items, a code block and a
    // callout; add a table and a material embed.
    let paras = prose.paragraphs();
    let text = prose.text();
    for (j, p) in paras.iter().enumerate() {
        let nl = p.newline;
        match j % 9 {
            1 | 2 => {
                text.mark(nl..nl + 1, block::LIST, "bullet").unwrap();
            }
            3 => {
                text.mark(nl..nl + 1, block::LIST, "task").unwrap();
                text.mark(nl..nl + 1, block::CHECKED, rng.chance(0.4))
                    .unwrap();
                if !todo_ids.is_empty() && rng.chance(0.5) {
                    let t = rng.pick(todo_ids);
                    text.mark(nl..nl + 1, block::TODO, t.as_str()).unwrap();
                }
            }
            5 => {
                text.mark(nl..nl + 1, block::CODE_BLOCK, "").unwrap();
            }
            7 => {
                text.mark(nl..nl + 1, block::CALLOUT, "note").unwrap();
            }
            _ => {}
        }
    }
    let mut embeds = 0;
    if let Some(p) = paras.get(paras.len() / 2) {
        let table = prose.insert_embed(p.range.start, &format!("tbl-{idx}"), "table");
        let cols = table.ensure_mergeable_map("cols").unwrap();
        let rows = table.ensure_mergeable_map("rows").unwrap();
        for c in 0..3 {
            let col = cols.ensure_mergeable_map(&format!("c{c}")).unwrap();
            col.insert("order", c as f64).unwrap();
        }
        for r in 0..4 {
            let row = rows.ensure_mergeable_map(&format!("r{r}")).unwrap();
            row.insert("order", r as f64).unwrap();
            let cells = row.ensure_mergeable_map("cells").unwrap();
            for c in 0..3 {
                let cell = cells.ensure_mergeable_text(&format!("c{c}")).unwrap();
                cell.insert(0, &format!("格{r}{c}")).unwrap();
            }
        }
        embeds += 1;
    }
    if !material_ids.is_empty() {
        let p = prose.paragraphs()[1.min(prose.paragraphs().len() - 1)].clone();
        let m = prose.insert_embed(p.range.start, &format!("mat-{idx}"), "material");
        m.insert("material", rng.pick(material_ids).as_str())
            .unwrap();
        embeds += 1;
    }
    embeds
}

fn median(v: &[usize]) -> usize {
    let mut s = v.to_vec();
    s.sort();
    if s.is_empty() { 0 } else { s[s.len() / 2] }
}

/// Generate the seed.
pub fn generate(cfg: &SeedConfig, history: History) -> Seed {
    let mut rng = Rng::new(SEED);
    let mut clock = Clock(T0);
    let mut ms = (T0 as u64) * 1000;
    let mut next_id = |rng: &mut Rng| {
        ms += 997;
        rng.uuid7(ms)
    };
    let book_id = next_id(&mut rng);
    let book = Book::create(&book_id, import_peer(&format!("book:{book_id}")));
    let gen_text = TextGen::new(&mut rng, cfg.elements);
    let mut stats = SeedStats::default();
    let mut prose = Vec::new();

    // Ids first, so bodies can link to elements.
    let category_ids: Vec<String> = (0..cfg.categories).map(|_| next_id(&mut rng)).collect();
    let element_ids: Vec<String> = (0..cfg.elements).map(|_| next_id(&mut rng)).collect();
    let storyline_ids: Vec<String> = (0..cfg.storylines).map(|_| next_id(&mut rng)).collect();
    let chapter_ids: Vec<String> = (0..cfg.chapters).map(|_| next_id(&mut rng)).collect();
    let drift_ids: Vec<String> = (0..cfg.drifts).map(|_| next_id(&mut rng)).collect();
    let note_ids: Vec<String> = (0..cfg.notes).map(|_| next_id(&mut rng)).collect();
    let todo_ids: Vec<String> = (0..cfg.todos).map(|_| next_id(&mut rng)).collect();
    let targets: Vec<(String, &'static str)> = element_ids
        .iter()
        .map(|id| (id.clone(), "element"))
        .collect();

    let meta = book.doc.get_map(schema::book::META);
    meta.insert("name", "合成重型种子").unwrap();
    meta.insert("summary", "P0-C 探针用的合成书").unwrap();
    meta.insert("created_at", T0).unwrap();

    // Categories.
    let cat_lens = lengths(
        &mut rng,
        cfg.categories,
        cfg.category_chars,
        cfg.category_chars / cfg.categories / 4,
        cfg.category_chars,
    );
    for (i, id) in category_ids.iter().enumerate() {
        let m = book.put(
            schema::book::CATEGORIES,
            id,
            vec![
                ("name", format!("分类{i}").into()),
                ("color", format!("#{:06x}", rng.below(0xFFFFFF)).into()),
                ("layout", "auto".into()),
            ],
        );
        for f in 0..3 {
            Book::kv_add(
                &m,
                "template_fields",
                &format!("{id}-f{f}"),
                &format!("字段{f}"),
                "",
                f as f64,
            );
        }
        let doc_id = format!("category:{id}");
        let p = ProseDoc::create(&doc_id, import_peer(&doc_id));
        let paras = gen_text.body(&mut rng, cat_lens[i], 0, false);
        write_bulk(&p, &paras, &targets);
        p.doc
            .commit_with(CommitOptions::new().timestamp(clock.tick(1)));
        stats.category_chars += cat_lens[i];
        prose.push(ProseEntry {
            doc_id,
            kind: "category",
            prose: p,
            chars: cat_lens[i],
        });
    }
    stats.categories = cfg.categories;

    // Assets and materials.
    let mut asset_ids = Vec::new();
    for i in 0..cfg.images + cfg.pdfs {
        let id = next_id(&mut rng);
        let image = i < cfg.images;
        let mut sha = String::new();
        for _ in 0..4 {
            write!(sha, "{:016x}", rng.next_u64()).unwrap();
        }
        let mut fields: book::Fields = vec![
            ("kind", if image { "image" } else { "pdf" }.into()),
            (
                "mime",
                if image {
                    "image/png"
                } else {
                    "application/pdf"
                }
                .into(),
            ),
            ("size", (rng.range(20_000, 80_000) as i64).into()),
            ("sha256", sha.into()),
        ];
        if image {
            fields.push(("width", 1200i64.into()));
            fields.push(("height", 800i64.into()));
        }
        book.put(schema::book::ASSETS, &id, fields);
        asset_ids.push(id);
    }
    let folder_tree_ids: Vec<(String, loro::TreeID)> = {
        let mut v: Vec<(String, loro::TreeID)> = Vec::new();
        for i in 0..8 {
            let id = next_id(&mut rng);
            let parent = if i >= 3 {
                Some(v[i % 3].1)
            } else {
                None::<loro::TreeID>
            };
            let t = book.tree_add(
                schema::book::MATERIAL_FOLDERS,
                parent,
                &id,
                &format!("素材夹{i}"),
            );
            v.push((id, t));
        }
        v
    };
    let mut material_ids = Vec::new();
    for (i, aid) in asset_ids.iter().enumerate() {
        let id = next_id(&mut rng);
        book.put(
            schema::book::MATERIALS,
            &id,
            vec![
                ("title", format!("素材{i}").into()),
                ("kind", if i < cfg.images { "image" } else { "pdf" }.into()),
                ("asset", aid.as_str().into()),
                (
                    "folder",
                    folder_tree_ids[i % folder_tree_ids.len()].0.as_str().into(),
                ),
                ("order", ((i as f64) * 5.0).into()),
            ],
        );
        material_ids.push(id);
    }

    // Elements.
    let el_lens = lengths(
        &mut rng,
        cfg.elements,
        cfg.element_chars,
        cfg.element_min,
        cfg.element_max,
    );
    for (i, id) in element_ids.iter().enumerate() {
        let mut fields: book::Fields = vec![
            ("name", gen_text.names[i].as_str().into()),
            ("summary", format!("{}的摘要", gen_text.names[i]).into()),
            (
                "category",
                category_ids[i % category_ids.len()].as_str().into(),
            ),
            ("created_at", T0.into()),
        ];
        if i < cfg.images {
            fields.push(("portrait", asset_ids[i].as_str().into()));
        }
        let m = book.put(schema::book::ELEMENTS, id, fields);
        for a in 0..(i % 3) {
            Book::set_add(&m, "aliases", &format!("{}{a}", gen_text.names[i]));
        }
        for f in 0..(2 + i % 4) {
            Book::kv_add(
                &m,
                "facts",
                &format!("{id}-k{f}"),
                &format!("字段{f}"),
                &format!("值{f}"),
                f as f64,
            );
        }
        let doc_id = format!("element:{id}");
        let p = ProseDoc::create(&doc_id, import_peer(&doc_id));
        let paras = gen_text.body(&mut rng, el_lens[i], cfg.chars_per_link * 4, false);
        let (links, _) = write_bulk(&p, &paras, &targets);
        stats.links += links;
        p.doc
            .commit_with(CommitOptions::new().timestamp(clock.tick(1)));
        stats.element_chars += el_lens[i];
        prose.push(ProseEntry {
            doc_id,
            kind: "element",
            prose: p,
            chars: el_lens[i],
        });
    }
    stats.elements = cfg.elements;

    // Storylines.
    let sl_lens = lengths(
        &mut rng,
        cfg.storylines,
        cfg.storyline_chars,
        cfg.storyline_chars / cfg.storylines / 4,
        cfg.storyline_chars,
    );
    for (i, id) in storyline_ids.iter().enumerate() {
        let m = book.put(
            schema::book::STORYLINES,
            id,
            vec![
                ("name", format!("故事线{i}").into()),
                ("color", format!("#{:06x}", rng.below(0xFFFFFF)).into()),
                ("order", ((i + 1) as f64).into()),
            ],
        );
        Book::kv_add(&m, "facts", &format!("{id}-k0"), "主题", "合成", 0.0);
        let doc_id = format!("storyline:{id}");
        let p = ProseDoc::create(&doc_id, import_peer(&doc_id));
        let paras = gen_text.body(&mut rng, sl_lens[i], 0, true);
        write_bulk(&p, &paras, &targets);
        p.doc
            .commit_with(CommitOptions::new().timestamp(clock.tick(1)));
        stats.storyline_chars += sl_lens[i];
        prose.push(ProseEntry {
            doc_id,
            kind: "storyline",
            prose: p,
            chars: sl_lens[i],
        });
    }
    stats.storylines = cfg.storylines;

    // Chapters.
    let mut ch_lens = lengths(
        &mut rng,
        cfg.chapters,
        cfg.chapter_chars,
        cfg.chapter_min,
        cfg.chapter_max,
    );
    force_max(&mut ch_lens, cfg.chapter_min, cfg.chapter_max);
    for (i, id) in chapter_ids.iter().enumerate() {
        let m = book.put(
            schema::book::NODES,
            id,
            vec![
                ("kind", "chapter".into()),
                ("title", format!("第{}章", i + 1).into()),
                ("summary", format!("第{}章的梗概", i + 1).into()),
                ("book_order", (((i + 1) * 5) as f64).into()),
                ("narrative_order", (((cfg.chapters - i) * 5) as f64).into()),
                ("status", "draft".into()),
                ("created_at", T0.into()),
            ],
        );
        let sl = &storyline_ids[i % storyline_ids.len()];
        Book::set_add(&m, "storylines", sl);
        m.insert("primary_storyline", sl.as_str()).unwrap();
        if i % 4 == 0 && storyline_ids.len() > 1 {
            Book::set_add(
                &m,
                "storylines",
                &storyline_ids[(i + 1) % storyline_ids.len()],
            );
        }
        let doc_id = format!("node:{id}");
        let p = ProseDoc::create(&doc_id, import_peer(&doc_id));
        let paras = gen_text.body(&mut rng, ch_lens[i], cfg.chars_per_link, true);
        stats.headings += paras.iter().filter(|p| p.heading.is_some()).count();
        let links = match history {
            History::Bulk => {
                let (l, _) = write_bulk(&p, &paras, &targets);
                p.doc
                    .commit_with(CommitOptions::new().timestamp(clock.tick(1)));
                stats.commits += 1;
                l
            }
            History::Typed => {
                // Its own generator, so the corpus is the same as Bulk's.
                let mut typing = Rng::new(fnv1a64(doc_id.as_bytes()));
                write_typed(
                    &p,
                    &paras,
                    &targets,
                    &mut typing,
                    &mut clock,
                    &mut stats.commits,
                )
            }
        };
        stats.links += links;
        // A few overlapping links: a second element linked over part of an
        // existing link.
        for (r, target) in prose_overlaps(&p, &mut rng) {
            p.link_entity(r, &element_ids[target % element_ids.len()], "element");
            stats.overlapping_links += 1;
        }
        p.doc
            .commit_with(CommitOptions::new().timestamp(clock.tick(1)));
        stats.chapter_chars += ch_lens[i];
        prose.push(ProseEntry {
            doc_id,
            kind: "chapter",
            prose: p,
            chars: ch_lens[i],
        });
    }
    stats.chapters = cfg.chapters;
    stats.chapter_min = *ch_lens.iter().min().unwrap_or(&0);
    stats.chapter_max = *ch_lens.iter().max().unwrap_or(&0);
    stats.chapter_median = median(&ch_lens);

    // Acts: boundaries on the book-order axis (head-anchored first act).
    for (a, start) in [None, Some(0.3), Some(0.6), Some(0.85)].iter().enumerate() {
        let id = next_id(&mut rng);
        let start_order = start.map(|f| ((cfg.chapters as f64 * f) as usize * 5) as f64 + 2.5);
        book.put(
            schema::book::ACTS,
            &id,
            vec![
                ("name", format!("第{}幕", a + 1).into()),
                (
                    "start_order",
                    start_order.map(LoroValue::from).unwrap_or(LoroValue::Null),
                ),
            ],
        );
    }

    // Drift groups and drifts (构想).
    let mut groups: Vec<(String, loro::TreeID)> = Vec::new();
    for i in 0..12 {
        let id = next_id(&mut rng);
        let parent = if i >= 4 { Some(groups[i % 4].1) } else { None };
        let t = book.tree_add(
            schema::book::DRIFT_GROUPS,
            parent,
            &id,
            &format!("构想组{i}"),
        );
        groups.push((id, t));
    }
    let mut dr_lens = lengths(
        &mut rng,
        cfg.drifts,
        cfg.drift_chars,
        cfg.drift_min,
        cfg.drift_max,
    );
    // The longest drift is exactly the maximum, like the old seed.
    force_max(&mut dr_lens, cfg.drift_min, cfg.drift_max);
    for (i, id) in drift_ids.iter().enumerate() {
        let mut fields: book::Fields = vec![
            ("kind", "drift".into()),
            ("title", format!("构想{i}").into()),
            ("summary", "".into()),
            ("status", "drifting".into()),
            ("x", ((i % 20) as f64 * 40.0).into()),
            ("y", ((i / 20) as f64 * 40.0).into()),
        ];
        if i % 3 != 0 {
            fields.push(("group", groups[i % groups.len()].0.as_str().into()));
        }
        if i % 5 == 0 {
            fields.push(("narrative_order", ((i * 3) as f64 + 1.5).into()));
        }
        book.put(schema::book::NODES, id, fields);
        let doc_id = format!("node:{id}");
        let p = ProseDoc::create(&doc_id, import_peer(&doc_id));
        let paras = gen_text.body(&mut rng, dr_lens[i], cfg.chars_per_link * 2, true);
        let (links, _) = write_bulk(&p, &paras, &targets);
        stats.links += links;
        p.doc
            .commit_with(CommitOptions::new().timestamp(clock.tick(1)));
        stats.drift_chars += dr_lens[i];
        prose.push(ProseEntry {
            doc_id,
            kind: "drift",
            prose: p,
            chars: dr_lens[i],
        });
    }
    stats.drifts = cfg.drifts;
    stats.drift_max = *dr_lens.iter().max().unwrap_or(&0);

    // Time pins on the narrative axis, some bound to a drift.
    for i in 0..12 {
        let id = next_id(&mut rng);
        let mut fields: book::Fields = vec![
            ("narrative_order", ((i * 40) as f64 + 2.5).into()),
            ("label", format!("{}年", 1900 + i * 3).into()),
        ];
        if i % 3 == 0 && !drift_ids.is_empty() {
            fields.push(("drift", drift_ids[i % drift_ids.len()].as_str().into()));
        }
        book.put(schema::book::TIME_PINS, &id, fields);
    }

    // Material notes.
    let note_lens = lengths(
        &mut rng,
        cfg.notes,
        cfg.note_chars,
        cfg.note_min,
        cfg.note_max,
    );
    for (i, id) in note_ids.iter().enumerate() {
        book.put(
            schema::book::MATERIALS,
            id,
            vec![
                ("title", format!("笔记{i}").into()),
                ("kind", "text".into()),
                (
                    "folder",
                    folder_tree_ids[i % folder_tree_ids.len()].0.as_str().into(),
                ),
                ("order", ((i + material_ids.len()) as f64 * 5.0).into()),
                ("task_todos", true.into()),
            ],
        );
        let doc_id = format!("material:{id}");
        let p = ProseDoc::create(&doc_id, import_peer(&doc_id));
        let paras = gen_text.body(&mut rng, note_lens[i], 0, true);
        write_bulk(&p, &paras, &targets);
        stats.embeds += add_note_blocks(&p, &mut rng, i, &todo_ids, &material_ids);
        p.doc
            .commit_with(CommitOptions::new().timestamp(clock.tick(1)));
        stats.note_chars += note_lens[i];
        prose.push(ProseEntry {
            doc_id,
            kind: "material",
            prose: p,
            chars: note_lens[i],
        });
    }
    stats.notes = cfg.notes;

    // Relation types and relations.
    let mut rt_ids = vec![book::generic_relation_type_id(&book_id)];
    for (i, (name, src, dst)) in [
        ("师徒", "师父", "徒弟"),
        ("宿敌", "", ""),
        ("出现于", "要素", "章节"),
        ("父子", "父", "子"),
        ("同盟", "", ""),
    ]
    .iter()
    .enumerate()
    {
        let id = next_id(&mut rng);
        book.put(
            schema::book::RELATION_TYPES,
            &id,
            vec![
                ("name", (*name).into()),
                (
                    "orientation",
                    if src.is_empty() {
                        "symmetric"
                    } else {
                        "directed"
                    }
                    .into(),
                ),
                ("source_role", (*src).into()),
                ("target_role", (*dst).into()),
                ("locked", false.into()),
                ("source_kinds", book::list_of(&["element", "node"])),
                (
                    "target_kinds",
                    book::list_of(if i == 2 { &["node"] } else { &["element"] }),
                ),
            ],
        );
        rt_ids.push(id);
    }
    for _ in 0..cfg.relations {
        let id = next_id(&mut rng);
        let a = rng.below(element_ids.len() as u64) as usize;
        let mut b = rng.below(element_ids.len() as u64) as usize;
        if a == b {
            b = (b + 1) % element_ids.len();
        }
        book.put(
            schema::book::RELATIONS,
            &id,
            vec![
                ("from_kind", "element".into()),
                ("from", element_ids[a].as_str().into()),
                ("to_kind", "element".into()),
                ("to", element_ids[b].as_str().into()),
                ("type", rng.pick(&rt_ids).as_str().into()),
            ],
        );
    }
    stats.relations = cfg.relations;

    // Plot grids for the first 20 chapters.
    for ch in chapter_ids.iter().take(20) {
        let g = book.put(
            schema::book::PLOT_GRIDS,
            ch,
            vec![("cell_w", 184.0.into()), ("cell_h", 96.0.into())],
        );
        let rows = g.ensure_mergeable_map("rows").unwrap();
        let cols = g.ensure_mergeable_map("cols").unwrap();
        let cells = g.ensure_mergeable_map("cells").unwrap();
        for r in 0..4 {
            let row = rows.ensure_mergeable_map(&format!("r{r}")).unwrap();
            row.insert("pos", format!("a{r}")).unwrap();
            row.insert("label", format!("行{r}")).unwrap();
        }
        for c in 0..5 {
            let col = cols.ensure_mergeable_map(&format!("c{c}")).unwrap();
            col.insert("pos", format!("a{c}")).unwrap();
            col.insert("label", format!("列{c}")).unwrap();
            for r in 0..4 {
                cells
                    .insert(&format!("r{r}/c{c}"), format!("纸条{r}{c}"))
                    .unwrap();
            }
        }
    }

    // Comments and TODOs, most anchored in chapter text.
    let chapter_prose: Vec<usize> = prose
        .iter()
        .enumerate()
        .filter(|(_, e)| e.kind == "chapter")
        .map(|(i, _)| i)
        .collect();
    let com_lens = lengths(
        &mut rng,
        cfg.comments,
        cfg.comment_chars,
        (cfg.comment_chars / cfg.comments / 10).max(1),
        cfg.comment_chars,
    );
    let todo_lens = lengths(
        &mut rng,
        cfg.todos,
        cfg.todo_chars,
        (cfg.todo_chars / cfg.todos / 5).max(1),
        cfg.todo_chars,
    );
    let make_comment =
        |rng: &mut Rng, id: &str, kind: &str, len: usize, anchored: bool, stats: &mut SeedStats| {
            let m = book.put(
                schema::book::COMMENTS,
                id,
                vec![
                    ("kind", kind.into()),
                    (
                        "status",
                        if rng.chance(0.2) { "resolved" } else { "open" }.into(),
                    ),
                    ("author_kind", "user".into()),
                    ("source", "manual".into()),
                    ("created_at", T0.into()),
                ],
            );
            let body = Book::text_field(&m, "body");
            let mut s = String::new();
            for p in gen_text.body(rng, len, 0, false) {
                if !s.is_empty() {
                    s.push('\n');
                }
                s.push_str(&p.text);
            }
            s.push('\n');
            body.insert(0, &s).unwrap();
            if anchored && !chapter_prose.is_empty() {
                let e = &prose[*rng.pick(&chapter_prose)];
                let len = e.prose.len();
                let start = rng.range(0, len.saturating_sub(60));
                let end = (start + rng.range(4, 50)).min(len - 1);
                if let Some(a) = Anchor::new(&e.prose.text(), start..end) {
                    let (s, en) = a.encode();
                    m.insert("target_kind", "node").unwrap();
                    m.insert("target", &e.doc_id["node:".len()..]).unwrap();
                    Book::put_anchor(&m, "anchor", s, en);
                    stats.anchored_comments += 1;
                }
            }
        };
    for (i, len) in com_lens.iter().enumerate() {
        let id = next_id(&mut rng);
        make_comment(&mut rng, &id, "note", *len, true, &mut stats);
        stats.comment_chars += len;
        let _ = i;
    }
    for (i, len) in todo_lens.iter().enumerate() {
        make_comment(&mut rng, &todo_ids[i], "todo", *len, i % 2 == 0, &mut stats);
        stats.todo_chars += len;
    }
    stats.comments = cfg.comments;
    stats.todos = cfg.todos;

    // Element patches anchored in chapters.
    for (i, element_id) in element_ids.iter().enumerate().take(40) {
        let id = next_id(&mut rng);
        let e = &prose[*rng.pick(&chapter_prose)];
        let len = e.prose.len();
        let start = rng.range(0, len.saturating_sub(40));
        let m = book.put(
            schema::book::PATCHES,
            &id,
            vec![
                ("element", element_id.as_str().into()),
                ("source_node", e.doc_id["node:".len()..].into()),
                ("order", (i as f64).into()),
            ],
        );
        if let Some(a) = Anchor::new(&e.prose.text(), start..(start + 20).min(len - 1)) {
            let (s, en) = a.encode();
            Book::put_anchor(&m, "anchor", s, en);
        }
        Book::text_field(&m, "body")
            .insert(0, "补丁正文。\n")
            .unwrap();
        stats.patches += 1;
    }

    // Project facts, Project Memory, writing days.
    let facts = book.doc.get_map(schema::book::FACTS);
    for f in 0..20 {
        let e = facts.ensure_mergeable_map(&format!("fact-{f}")).unwrap();
        e.insert("key", format!("设定{f}")).unwrap();
        e.insert("value", format!("值{f}")).unwrap();
        e.insert("order", f as f64).unwrap();
    }
    for _ in 0..50 {
        let id = next_id(&mut rng);
        book.put(
            schema::book::MEMORY,
            &id,
            vec![
                ("kind", "note".into()),
                ("body", "合成的项目记忆条目。".into()),
                ("source", "agent".into()),
                ("status", "active".into()),
            ],
        );
    }
    let days = book.doc.get_map(schema::book::WRITING_DAYS);
    for device in ["dev-a", "dev-b"] {
        for d in 0..365 {
            days.insert(
                &format!("{device}|2026-{:03}", d + 1),
                rng.range(0, 3000) as i64,
            )
            .unwrap();
        }
    }
    book.doc
        .commit_with(CommitOptions::new().timestamp(clock.tick(1)));

    // Paragraph count and fingerprint.
    let mut h = Sha256::new();
    let mut entries: Vec<&ProseEntry> = prose.iter().collect();
    entries.sort_by(|a, b| a.doc_id.cmp(&b.doc_id));
    for e in entries {
        stats.paragraphs += e.prose.paragraphs().len();
        h.update(e.doc_id.as_bytes());
        h.update([0]);
        h.update(e.prose.text().to_string().as_bytes());
        h.update([0]);
    }
    stats.corpus_sha256 = format!("{:x}", h.finalize());
    let mut h = Sha256::new();
    h.update(
        book.doc
            .get_deep_value()
            .to_json_value()
            .to_string()
            .as_bytes(),
    );
    stats.book_sha256 = format!("{:x}", h.finalize());

    Seed {
        book_id,
        book,
        prose,
        stats,
    }
}

/// Up to two overlap ranges per chapter: half of an existing link.
fn prose_overlaps(p: &ProseDoc, rng: &mut Rng) -> Vec<(std::ops::Range<usize>, usize)> {
    let links = crate::prose::entity_links(&p.text());
    let mut out = Vec::new();
    for (r, _) in links.iter().filter(|(r, _)| r.len() >= 3).take(2) {
        out.push((r.start + 1..r.end, rng.below(1 << 20) as usize));
    }
    out
}

use loro::ToJson as _;

/// One chapter written and then rewritten: `chars` characters typed, then
/// `rounds` passes that each delete about half of the paragraphs and type
/// new ones of the same length. The history ends up several times the size
/// of the text, like a chapter after months of revision.
pub fn churned_chapter(doc_id: &str, chars: usize, rounds: usize) -> (ProseDoc, usize) {
    let mut rng = Rng::new(fnv1a64(doc_id.as_bytes()) ^ 0xC4u64);
    let gen_text = TextGen::new(&mut rng, 20);
    let p = ProseDoc::create(doc_id, import_peer(doc_id));
    let mut clock = Clock(T0);
    let mut commits = 0;
    let paras = gen_text.body(&mut rng, chars, 0, true);
    write_typed(
        &p,
        &paras,
        &[("el".to_string(), "element")],
        &mut rng,
        &mut clock,
        &mut commits,
    );
    let han: Vec<char> = HAN.chars().collect();
    let mut typed = chars;
    for _ in 0..rounds {
        let count = p.paragraphs().len();
        for _ in 0..count / 2 {
            let paras = p.paragraphs();
            let target = &paras[rng.below(paras.len() as u64) as usize];
            let n = target.range.len();
            if n == 0 {
                continue;
            }
            p.delete(target.range.clone());
            commit(&p.doc, &mut clock, 3, &mut commits);
            let mut at = target.range.start;
            let mut left = n;
            while left > 0 {
                let k = rng.range(1, 6).min(left);
                let chunk: String = (0..k).map(|_| *rng.pick(&han)).collect();
                p.insert_text(at, &chunk);
                commit(&p.doc, &mut clock, 1, &mut commits);
                at += k;
                left -= k;
            }
            typed += n;
        }
    }
    (p, typed)
}
