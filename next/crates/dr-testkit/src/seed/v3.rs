//! Universal kernel v3 seed generator (`dr_testkit::seed::v3`).
//!
//! Mirrors the four v2.2 presets (`tiny` / `lite` / `heavy` / `showcase`) at
//! the exact same corpus scale and fingerprint while storing books in the v3
//! schema (`BookDocV3` + `body:<entry_id>/<module_id>` / `body:<entry_id>/mod-description`
//! / `material:<id>` prose documents).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use dr_corpus::para::{self, Para};
use dr_doc::loro_types::VersionVector;
use dr_doc::peer::import_peer;
use dr_doc::prose::ProseDoc;
use dr_doc::side::{CheckpointsDoc, LayoutDoc, LayoutTxn, StatsDoc, StatsTxn};
use dr_doc::v3::novel::{
    MOD_DESCRIPTION, MOD_FIELDS, MOD_KV, MOD_MEDIA, MOD_PATCHES, MOD_PLOT_GRID, MOD_PROSE,
    NovelRootEntries, TPL_CATEGORY, TPL_CHAPTER, TPL_CHARACTER, TPL_ELEMENTS, TPL_GROUP, TPL_IDEA,
    TPL_IDEA_GROUP, TPL_IDEAS, TPL_MANUSCRIPT, TPL_NOTE, TPL_STORYLINE, TPL_STORYLINES,
    novel_project_template_with, novel_project_templates,
};
use dr_doc::v3::{BookDocV3, BookTxnV3, BookViewV3, book_genesis};
use dr_doc::{DocError, Result};
use dr_model::id::*;
use dr_model::import_v1::{MaterialKind, StorylineId};
use dr_model::kind::*;
use dr_model::pos::PosKey;
use dr_model::prose::{BlockAttrs, EntityLink, InlineStyle};
use dr_model::shared::{
    Asset, BlockSnapshot, EntityRef, KvEntry, MaterialRegion, canonical_symmetric,
};
use dr_model::v3::*;
use dr_model::{DocId, Origin, Timestamp};
use dr_samples::WriteError;
use dr_samples::build::{Counters, SeededBook, T0, format_paras, positions};
use serde_json::{Value, json};

use super::Preset;
use super::plan::{self, Plan};
use super::shape::Shape;

fn tid(s: &str) -> EntryTemplateId {
    EntryTemplateId::parse(s).expect("valid template id")
}

fn mid(s: &str) -> ModuleId {
    ModuleId::parse(s).expect("valid module id")
}

fn eid(s: &str) -> EntryId {
    EntryId::parse(s).expect("valid entry id")
}

fn body_doc_id(entry: &str, module: &str) -> DocId {
    DocId::Body(BodyDocId::new(eid(entry), mid(module)))
}

fn entry_field_str<'a>(e: &'a Entry, module: &ModuleId, key: &str) -> Option<&'a str> {
    e.fields.get(module)?.get(key)?.as_str()
}

fn map_entity_kind_v3(k: &EntityKind) -> EntityKind {
    match k {
        EntityKind::Comment => EntityKind::Comment,
        EntityKind::Patch => EntityKind::Patch,
        EntityKind::Asset => EntityKind::Asset,
        EntityKind::Node
        | EntityKind::Element
        | EntityKind::Storyline
        | EntityKind::Category
        | EntityKind::Material
        | EntityKind::Entry => EntityKind::Entry,
        EntityKind::Other(o) => EntityKind::Other(o.clone()),
    }
}

fn map_entity_ref_v3(r: &EntityRef) -> EntityRef {
    EntityRef::new(map_entity_kind_v3(&r.kind), r.id.clone())
}

/// One written v3 book: its v3 book document, its prose documents and the
/// two documents beside it.
pub struct SeededBookV3 {
    pub book: BookDocV3,
    /// Every prose document (`body:<entry>/<module>`, `body:<entry>/mod-description` (the 「说明」),
    /// `material:<id>`), in creation order.
    pub prose: Vec<ProseDoc>,
    /// `stats:<book>`: the writing days.
    pub stats: StatsDoc,
    /// `checkpoints:<book>`: no seed saves a checkpoint.
    pub checkpoints: CheckpointsDoc,
    /// `layout:<book>`: board positions.
    pub layout: LayoutDoc,
    /// The bytes of the files in the book's asset library (synthetic, from
    /// [`crate::media`]), written into the library's store with the book.
    pub files: Vec<SeedFile>,
    groups: BTreeMap<&'static str, Vec<String>>,
    counters: Counters,
}

/// One file of a seeded book's asset library: its id and the synthetic bytes
/// it is stored with (`kernel-v5.md` §6 素材库).
#[derive(Clone, Debug)]
pub struct SeedFile {
    pub id: AssetId,
    pub kind: AssetKind,
    pub mime: &'static str,
    pub ext: &'static str,
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
}

impl SeedFile {
    /// A drawn map of `w` × `h` ([`crate::media::png`]).
    pub fn image(id: &str, w: u32, h: u32) -> Self {
        Self {
            id: AssetId::parse(id).expect("valid asset id"),
            kind: AssetKind::Image,
            mime: "image/png",
            ext: "png",
            width: w,
            height: h,
            bytes: crate::media::png(w, h),
        }
    }

    /// The three-page field notebook ([`crate::media::sample_pdf`]).
    pub fn pdf(id: &str) -> Self {
        let (w, h) = crate::media::A5;
        Self {
            id: AssetId::parse(id).expect("valid asset id"),
            kind: AssetKind::Pdf,
            mime: "application/pdf",
            ext: "pdf",
            width: w as u32,
            height: h as u32,
            bytes: crate::media::sample_pdf(),
        }
    }

    /// Its record in the book's asset library.
    pub fn record(&self, name: &str, deleted_at: Option<Timestamp>) -> Asset {
        use sha2::{Digest, Sha256};
        let image = self.kind == AssetKind::Image;
        Asset {
            id: self.id.clone(),
            name: name.into(),
            kind: self.kind.clone(),
            mime: self.mime.into(),
            size: self.bytes.len() as i64,
            sha256: Sha256::digest(&self.bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
            width: image.then_some(i64::from(self.width)),
            height: image.then_some(i64::from(self.height)),
            created_at: Some(Timestamp(T0)),
            folder: None,
            deleted_at,
        }
    }
}

/// Store the bytes of `b`'s files in `lib`'s asset store (the documents are
/// [`write_book_v3`]'s). A library a person or a window opens wants both;
/// a test of documents alone (sync counts, digests) writes only those, and
/// the book's file records then read as "not on this device yet".
pub fn write_book_files_v3(
    lib: &dr_store::Library,
    b: &SeededBookV3,
) -> std::result::Result<usize, WriteError> {
    store_files(lib, b.book_id(), &b.files)?;
    Ok(b.files.len())
}

/// Store the source bytes of `files` for `book` (skipping one already there).
fn store_files(
    lib: &dr_store::Library,
    book: &BookId,
    files: &[SeedFile],
) -> std::result::Result<(), WriteError> {
    use dr_store::asset::{Variant, VariantBytes};
    for f in files {
        if lib.asset(f.id.as_str(), Variant::Source)?.is_some() {
            continue;
        }
        let mut import = lib.begin_asset_import(book.as_str(), f.id.as_str())?;
        let written = import.write_variant(
            Variant::Source,
            &VariantBytes {
                bytes: f.bytes.clone(),
                mime: f.mime.into(),
                ext: f.ext.into(),
                width: f.width,
                height: f.height,
            },
        );
        if let Err(e) = written {
            let _ = import.abandon();
            return Err(e.into());
        }
        import.commit()?;
    }
    Ok(())
}

impl SeededBookV3 {
    pub fn book_id(&self) -> &BookId {
        self.book.book_id()
    }

    pub fn groups(&self) -> &BTreeMap<&'static str, Vec<String>> {
        &self.groups
    }

    pub fn counters(&self) -> Counters {
        self.counters
    }
}

/// What [`generate_v3`] made.
pub struct SeededV3 {
    pub preset: Preset,
    pub seed: u64,
    pub books: Vec<SeededBookV3>,
}

impl SeededV3 {
    /// Counts, sizes and the corpus fingerprint of every v3 book together.
    pub fn shape(&self) -> Shape {
        Shape::of_v3(self.preset.name(), self.seed, &self.books)
    }

    /// Store every v3 document in `lib` (origin `import`): prose documents
    /// first (`V3-CROSS-DOC-WRITE-ORDER`), then the v3 book document.
    pub fn write_to(&self, lib: &dr_store::Library) -> std::result::Result<usize, WriteError> {
        let mut written = 0;
        for b in &self.books {
            written += write_book_v3(lib, b)?;
        }
        Ok(written)
    }

    /// Store the bytes of every book's files ([`write_book_files_v3`]).
    pub fn write_files_to(
        &self,
        lib: &dr_store::Library,
    ) -> std::result::Result<usize, WriteError> {
        let mut written = 0;
        for b in &self.books {
            written += write_book_files_v3(lib, b)?;
        }
        Ok(written)
    }
}

/// Build a v3 preset (`Tiny`, `Lite`, `Heavy`, or `Showcase`).
pub fn generate_v3(preset: Preset, seed: u64) -> Result<SeededV3> {
    let books = match preset.spec() {
        Some(spec) => vec![write_direct_v3(&plan::synthetic(
            &spec,
            preset.name(),
            seed,
        ))?],
        None => crate::samples::showcase_v3(seed)?,
    };
    Ok(SeededV3 {
        preset,
        seed,
        books,
    })
}

/// Store one v3 book in `lib`: its prose documents first, then its v3 book document.
pub fn write_book_v3(
    lib: &dr_store::Library,
    b: &SeededBookV3,
) -> std::result::Result<usize, WriteError> {
    let all = VersionVector::default();
    let mut written = 0;
    for p in &b.prose {
        written += store_doc(
            lib,
            b.book_id(),
            p.doc_id(),
            dr_doc::prose::genesis(p.doc_id()),
            p.export_updates_since(&all)?,
        )?;
    }
    written += store_doc(
        lib,
        b.book_id(),
        b.stats.doc_id(),
        dr_doc::side::stats_genesis(b.book_id()),
        b.stats.export_updates_since(&all)?,
    )?;
    written += store_doc(
        lib,
        b.book_id(),
        b.checkpoints.doc_id(),
        dr_doc::side::checkpoints_genesis(b.book_id()),
        b.checkpoints.export_updates_since(&all)?,
    )?;
    written += store_doc(
        lib,
        b.book_id(),
        b.layout.doc_id(),
        dr_doc::side::layout_genesis(b.book_id()),
        b.layout.export_updates_since(&all)?,
    )?;
    written += store_doc(
        lib,
        b.book_id(),
        b.book.doc_id(),
        book_genesis(b.book_id()),
        b.book.export_updates_since(&all)?,
    )?;
    Ok(written)
}

fn store_doc(
    lib: &dr_store::Library,
    book_id: &BookId,
    doc_id: &DocId,
    genesis: Vec<u8>,
    bytes: Vec<u8>,
) -> std::result::Result<usize, WriteError> {
    let id = doc_id.to_string();
    if lib.doc_info(&id)?.is_some() {
        return Ok(0);
    }
    let h = lib.open_doc(
        &id,
        dr_store::OpenDoc::CreateIfMissing {
            kind: doc_id.kind().prefix(),
            book_id: Some(book_id.as_str()),
            genesis: &move |d: &loro::LoroDoc| {
                d.import(&genesis)
                    .expect("dr-doc's genesis imports into an empty document");
            },
        },
    )?;
    h.import(bytes, dr_store::Origin::Import)?;
    h.compact_now()?;
    h.close();
    Ok(1)
}

/// Builds one v3 book: the `BookDocV3` plus prose documents.
pub struct BuilderV3 {
    pub book: BookDocV3,
    pub prose: Vec<ProseDoc>,
    pub stats: StatsDoc,
    pub checkpoints: CheckpointsDoc,
    pub layout: LayoutDoc,
    /// The bytes of the book's files (see [`SeededBookV3::files`]).
    pub files: Vec<SeedFile>,
    groups: BTreeMap<&'static str, Vec<String>>,
    counters: Counters,
    clock: i64,
}

impl BuilderV3 {
    pub fn new(book_id: BookId) -> Result<Self> {
        let doc_id = DocId::Book(book_id.clone()).to_string();
        let stats_id = DocId::Stats(book_id.clone()).to_string();
        let points_id = DocId::Checkpoints(book_id.clone()).to_string();
        let layout_id = DocId::Layout(book_id.clone()).to_string();
        Ok(Self {
            stats: StatsDoc::create(book_id.clone(), import_peer(&stats_id))?,
            checkpoints: CheckpointsDoc::create(book_id.clone(), import_peer(&points_id))?,
            layout: LayoutDoc::create(book_id.clone(), import_peer(&layout_id))?,
            book: BookDocV3::create(book_id, import_peer(&doc_id))?,
            prose: Vec::new(),
            files: Vec::new(),
            groups: BTreeMap::new(),
            counters: Counters::default(),
            clock: T0,
        })
    }

    pub fn tick(&mut self) -> i64 {
        self.clock += 1;
        self.clock
    }

    pub fn edit_book(&mut self, f: impl FnOnce(&mut BookTxnV3<'_>) -> Result<()>) -> Result<()> {
        let ts = self.tick();
        let (r, _) = self.book.edit_at(Origin::Import, Some(ts), f);
        r
    }

    pub fn prose(
        &mut self,
        group: &'static str,
        doc_id: DocId,
        paras: &[Para],
        targets: &[EntityRef],
    ) -> Result<usize> {
        let ts = self.tick();
        let (doc, counters) = write_prose_v3(doc_id, paras, targets, ts)?;
        self.counters.entity_links += counters.entity_links;
        for (a, b) in self.counters.headings.iter_mut().zip(counters.headings) {
            *a += b;
        }
        self.counters.tasks += counters.tasks;
        self.groups
            .entry(group)
            .or_default()
            .push(para::plain(paras));
        self.prose.push(doc);
        Ok(self.prose.len() - 1)
    }

    pub fn record(&mut self, group: &'static str, body: String) {
        self.groups.entry(group).or_default().push(body);
    }

    /// One commit on `stats:<book>` at the next tick.
    pub fn edit_stats(&mut self, f: impl FnOnce(&mut StatsTxn<'_>) -> Result<()>) -> Result<()> {
        let ts = self.tick();
        let (r, _) = self.stats.edit_at(Origin::Import, Some(ts), f);
        r
    }

    /// One commit on `layout:<book>` at the next tick.
    pub fn edit_layout(&mut self, f: impl FnOnce(&mut LayoutTxn<'_>) -> Result<()>) -> Result<()> {
        let ts = self.tick();
        let (r, _) = self.layout.edit_at(Origin::Import, Some(ts), f);
        r
    }

    pub fn finish(self) -> SeededBookV3 {
        SeededBookV3 {
            book: self.book,
            prose: self.prose,
            stats: self.stats,
            checkpoints: self.checkpoints,
            layout: self.layout,
            files: self.files,
            groups: self.groups,
            counters: self.counters,
        }
    }
}

fn write_prose_v3(
    doc_id: DocId,
    paras: &[Para],
    targets: &[EntityRef],
    ts: i64,
) -> Result<(ProseDoc, Counters)> {
    let peer = import_peer(&doc_id.to_string());
    let mut doc = ProseDoc::create(doc_id, peer)?;
    let body = para::plain(paras);
    let (r, _) = doc.edit_at(Origin::Import, Some(ts), |t| {
        if body.is_empty() {
            return Ok(Counters::default());
        }
        t.insert_paragraphs(0, &body)?;
        format_paras(t, paras, targets)
    });
    let counters = r?;
    Ok((doc, counters))
}

fn deterministic_novel_roots(book: &BookId) -> NovelRootEntries {
    let b = book.as_str();
    let gen_entry =
        |idx: usize| EntryId::parse(&super::build::id(0, b, "v3-root", idx)).expect("valid id");
    let gen_tab =
        |idx: usize| TabId::parse(&super::build::id(0, b, "v3-tab", idx)).expect("valid id");
    let narrative_view =
        TimelineViewId::parse(&super::build::id(0, b, "v3-view", 0)).expect("valid id");
    NovelRootEntries {
        manuscript: gen_entry(0),
        ideas: gen_entry(1),
        elements: gen_entry(2),
        storylines: gen_entry(3),
        cat_character: gen_entry(4),
        cat_location: gen_entry(5),
        cat_item: gen_entry(6),
        cat_organization: gen_entry(7),
        narrative_view,
        tab_manuscript: gen_tab(0),
        tab_ideas: gen_tab(1),
        tab_elements: gen_tab(2),
        tab_storylines: gen_tab(3),
    }
}

fn deterministic_text_materials_root(book: &BookId) -> EntryId {
    EntryId::parse(&super::build::id(0, book.as_str(), "v3-root", 8)).expect("valid id")
}

/// Initialize the novel project definition, templates, root level entries
/// (`书稿`, `构想`, `要素`, `故事线`), and default narrative timeline view
/// (`叙事时间线`), leaving category creation to the seed plan or sample book.
fn init_novel_roots(txn: &mut BookTxnV3<'_>, ids: &NovelRootEntries) -> Result<()> {
    let pt = novel_project_template_with(ids);
    txn.project().set_full(&pt.project)?;
    for mut tpl in novel_project_templates() {
        if tpl.id.as_str() == TPL_STORYLINE {
            tpl.settings.home = Some(Some(ids.manuscript.clone()));
        }
        txn.template(&tpl.id)?.set_full(&tpl)?;
    }
    txn.entries().create(
        &ids.manuscript,
        None,
        "书稿",
        Some(&tid(TPL_MANUSCRIPT)),
        true,
    )?;
    txn.entries()
        .create(&ids.ideas, None, "构想", Some(&tid(TPL_IDEAS)), true)?;
    txn.entries()
        .create(&ids.elements, None, "要素", Some(&tid(TPL_ELEMENTS)), true)?;
    txn.entries().create(
        &ids.storylines,
        None,
        "故事线",
        Some(&tid(TPL_STORYLINES)),
        true,
    )?;
    txn.timeline_view(&ids.narrative_view)?
        .name("叙事时间线")?
        .pos(Some(&PosKey::first()))?;
    Ok(())
}

fn init_text_materials_root(txn: &mut BookTxnV3<'_>, id: &EntryId) -> Result<()> {
    let w = txn
        .entries()
        .create(id, None, "文本素材", Some(&tid(TPL_GROUP)), true)?;
    w.overrides(Some(&LevelSettingsOverride {
        default_template: Some(Some(tid(TPL_NOTE))),
        format_shortcuts: Some(FormatShortcuts::Notes),
        accept: Some(false),
        ..Default::default()
    }))?;
    // A left-bar tab of its own, as the import gives it.
    let tab = TabId::parse(dr_samples::v3::TEXT_MATERIALS_TAB).expect("valid tab id");
    let project = txn.view().project();
    if !project.tabs.iter().any(|t| t.id == tab) {
        let last = project
            .tabs
            .iter()
            .filter_map(|t| t.pos.as_ref())
            .max()
            .cloned();
        txn.project().put_tab(&ProjectTab {
            id: tab,
            name: "文本素材".into(),
            pos: Some(last.map_or_else(PosKey::first, |p| p.after())),
            mount: TabMount::Entry { entry: id.clone() },
        })?;
    }
    Ok(())
}

fn ensure_plain_note_template(txn: &mut BookTxnV3<'_>) -> Result<EntryTemplateId> {
    let id = dr_samples::v3::plain_note_template();
    if txn.view().template(&id).is_none() {
        let mut tpl = txn
            .view()
            .template(&tid(TPL_NOTE))
            .expect("tpl-note initialized");
        tpl.id = id.clone();
        tpl.modules
            .iter_mut()
            .find(|m| m.id.as_str() == MOD_PROSE)
            .expect("mod-prose on tpl-note")
            .config
            .task_todos = false;
        txn.template(&id)?.set_full(&tpl)?;
    }
    Ok(id)
}

/// The template of the showcase's picture book: one media module.
pub const TPL_SHOWCASE_GALLERY: &str = "tpl-showcase-gallery";

/// Give the showcase's first book a filled asset library (`kernel-v5.md` §6,
/// §7): a file nobody uses, one in Recently Deleted, two in a media module of
/// an entry under 构想 (a map and the field notebook), a picture and the
/// notebook embedded in the first two chapters, and comments on them: a
/// region on the media module's map, a region on a PDF page, a region
/// straight on the unused file, and one on the embedded picture. Synthetic
/// bytes only ([`crate::media`]); T5 and T6 accept against it.
pub fn with_showcase_files(b: &mut SeededBookV3) -> Result<()> {
    use dr_doc::prose::EmbedKind;
    let book = b.book_id().clone();
    let id = |kind: &str, i: usize| super::build::id(0, book.as_str(), kind, i);
    let unused = SeedFile::image(&id("showcase-asset", 0), 360, 360);
    let trashed = SeedFile::image(&id("showcase-asset", 1), 240, 140);
    let map = SeedFile::image(&id("showcase-asset", 2), 640, 420);
    let notebook = SeedFile::pdf(&id("showcase-asset", 3));
    let plan = SeedFile::image(&id("showcase-asset", 4), 480, 320);
    let (gallery, media_map, media_notes) = (
        EntryId::parse(&id("showcase-gallery", 0)).expect("id"),
        MediaItemId::parse(&id("showcase-media", 0)).expect("id"),
        MediaItemId::parse(&id("showcase-media", 1)).expect("id"),
    );
    let (embed_plan, embed_notes) = (
        EmbedId::parse(&id("showcase-embed", 0)).expect("id"),
        EmbedId::parse(&id("showcase-embed", 1)).expect("id"),
    );
    let view = b.book.view();
    let ideas = view
        .root_entry_by_template(&tid(TPL_IDEAS))
        .ok_or(DocError::NotInProfile("the showcase book has no 构想"))?
        .id;
    let structure = view.structure_snapshot();
    let chapters: Vec<EntryId> = structure
        .book_sequence()
        .into_iter()
        .map(|f| f.entry.id.clone())
        .filter(|e| {
            view.entry(e)
                .is_some_and(|x| x.template.as_ref() == Some(&tid(TPL_CHAPTER)))
        })
        .take(2)
        .collect();
    if chapters.len() < 2 {
        return Err(DocError::NotInProfile(
            "the showcase book has fewer than two chapters",
        ));
    }
    let embed_in =
        |prose: &mut Vec<ProseDoc>, chapter: &EntryId, embed: &EmbedId, asset: &AssetId| {
            let doc_id = body_doc_id(chapter.as_str(), MOD_PROSE);
            let p = prose
                .iter_mut()
                .find(|p| p.doc_id() == &doc_id)
                .ok_or(DocError::NotInProfile("a showcase chapter has no prose"))?;
            let kind = EmbedKind::Asset(asset.clone());
            let (r, _) = p.edit_at(Origin::Import, Some(T0), |t| {
                t.insert_embed(0, embed, &kind).map(|_| ())
            });
            r
        };
    embed_in(&mut b.prose, &chapters[0], &embed_plan, &plan.id)?;
    embed_in(&mut b.prose, &chapters[1], &embed_notes, &notebook.id)?;
    let records = [
        unused.record("海边参考.png", None),
        trashed.record("旧草图.png", Some(Timestamp(T0))),
        map.record("东岸全图.png", None),
        notebook.record("潮汐笔记.pdf", None),
        plan.record("钟楼平面.png", None),
    ];
    let (r, _) = b.book.edit_at(Origin::Import, Some(T0), |t| {
        for a in &records {
            t.put_asset(a)?;
        }
        t.template(&tid(TPL_SHOWCASE_GALLERY))?
            .set_full(&EntryTemplate {
                id: tid(TPL_SHOWCASE_GALLERY),
                name: "图集".into(),
                mark: Some("image".into()),
                color: None,
                agent: None,
                modules: vec![ModuleSpec::media(mid(MOD_MEDIA), "图")],
                level: false,
                linkable: false,
                settings: LevelSettingsOverride::default(),
                verbs: Vec::new(),
                deleted_at: None,
            })?;
        let w = t.entries().create(
            &gallery,
            Some(&ideas),
            "东岸图集",
            Some(&tid(TPL_SHOWCASE_GALLERY)),
            false,
        )?;
        let items = [
            (&media_map, &map.id, "东岸全貌"),
            (&media_notes, &notebook.id, "第四章用的潮汐表"),
        ];
        let pos = positions(items.len());
        for (i, (item, asset, caption)) in items.iter().enumerate() {
            w.put_media(
                &mid(MOD_MEDIA),
                &MediaItem {
                    id: (*item).clone(),
                    asset: (*asset).clone(),
                    caption: (*caption).into(),
                    pos: Some(pos[i].clone()),
                },
            )?;
        }
        let on = |t: &mut BookTxnV3<'_>,
                  i: usize,
                  target: EntityRef,
                  module: Option<ModuleId>,
                  part: CommentPart,
                  body: &str|
         -> Result<()> {
            let c = CommentId::parse(&id("showcase-comment", i)).expect("id");
            t.comment(&c)?
                .origin(&CommentOrigin::Manual)?
                .target(Some(&target))?
                .module(module.as_ref())?
                .part(Some(&part))?
                .body(body)?
                .status(&CommentStatus::Open)?
                .created_at(Some(Timestamp(T0)))?;
            Ok(())
        };
        let region = |page, x, y| MaterialRegion::new(page, x, y, 0.2, 0.15).expect("region");
        on(
            t,
            0,
            EntityRef::new(EntityKind::Entry, gallery.as_str()),
            Some(mid(MOD_MEDIA)),
            CommentPart::Media {
                item: media_map.clone(),
                region: Some(region(None, 0.55, 0.3)),
            },
            "灯塔应该在北岬，不在这里",
        )?;
        on(
            t,
            1,
            EntityRef::new(EntityKind::Entry, gallery.as_str()),
            Some(mid(MOD_MEDIA)),
            CommentPart::Media {
                item: media_notes.clone(),
                region: Some(region(Some(2), 0.1, 0.2)),
            },
            "这张潮汐表和第四章对不上",
        )?;
        on(
            t,
            2,
            EntityRef::new(EntityKind::Asset, unused.id.as_str()),
            None,
            CommentPart::Region {
                region: region(None, 0.3, 0.4),
            },
            "这块礁石可以写进第七章",
        )?;
        on(
            t,
            3,
            EntityRef::new(EntityKind::Entry, chapters[0].as_str()),
            Some(mid(MOD_PROSE)),
            CommentPart::Embed {
                embed: embed_plan.clone(),
                region: None,
            },
            "平面图的门开错了方向",
        )?;
        Ok(())
    });
    r?;
    b.files.extend([unused, trashed, map, notebook, plan]);
    Ok(())
}

/// Write a synthetic [`Plan`] directly as v3 documents.
pub(crate) fn write_direct_v3(p: &Plan) -> Result<SeededBookV3> {
    let mut b = BuilderV3::new(p.book.clone())?;
    let roots = deterministic_novel_roots(&p.book);
    let element_refs: Vec<EntityRef> = p
        .elements
        .iter()
        .map(|e| EntityRef::new(EntityKind::Entry, e.id.as_str()))
        .collect();
    let storyline_pos = positions(p.storylines.len());
    let fmod = mid(MOD_FIELDS);
    let kvmod = mid(MOD_KV);
    let prose_mod = mid(MOD_PROSE);

    b.edit_book(|t| {
        init_novel_roots(t, &roots)?;
        t.meta()
            .name(&p.name)?
            .summary(plan::BOOK_SUMMARY)?
            .created_at(Some(Timestamp(T0)))?;
        t.project().book(Some(&ProjectBook {
            root: BookRoot::Entry {
                entry: roots.manuscript.clone(),
            },
            word_target_set: Some(p.word_target),
            daily_word_target_set: Some(p.daily_word_target),
        }))?;
        for (i, (id, s)) in p.storylines.iter().enumerate() {
            let entry_id = eid(id.as_str());
            t.entries()
                .create(
                    &entry_id,
                    Some(&roots.storylines),
                    &s.name,
                    Some(&tid(TPL_STORYLINE)),
                    false,
                )?
                .set_field(&fmod, "color", Some(&FieldValue::Text(s.color.clone())))?
                .set_field(&fmod, "summary", Some(&FieldValue::Text(s.summary.clone())))?;
            t.timeline_view(&roots.narrative_view)?
                .put_lane(&entry_id, Some(&storyline_pos[i]))?;
        }
        for (id, c) in &p.categories {
            let entry_id = eid(id.as_str());
            t.entries()
                .create(
                    &entry_id,
                    Some(&roots.elements),
                    &c.name,
                    Some(&tid(TPL_CATEGORY)),
                    true,
                )?
                .set_field(&fmod, "color", Some(&FieldValue::Text(c.color.clone())))?;
        }
        for (i, e) in p.elements.iter().enumerate() {
            let cat_id = eid(p.categories[e.category].0.as_str());
            let entry_id = eid(e.id.as_str());
            let w = t.entries().create(
                &entry_id,
                Some(&cat_id),
                &e.name,
                Some(&tid(TPL_CHARACTER)),
                false,
            )?;
            w.created_at(Some(Timestamp(T0 + i as i64)))?.set_field(
                &fmod,
                "summary",
                Some(&FieldValue::Text(e.summary.clone())),
            )?;
            if !e.aliases.is_empty() {
                w.set_field(&fmod, "aliases", Some(&FieldValue::List(e.aliases.clone())))?;
            }
            for (key, value) in &e.facts {
                w.put_kv(
                    &kvmod,
                    &KvEntry {
                        id: KvEntryId::parse(&format!("fact-{i}")).expect("valid id"),
                        key: key.clone(),
                        value: value.clone(),
                        pos: Some(PosKey::first()),
                    },
                )?;
            }
        }
        for (key, value) in &p.facts {
            t.put_fact(&KvEntry {
                id: KvEntryId::parse("fact-book-setting").expect("valid id"),
                key: key.clone(),
                value: value.clone(),
                pos: Some(PosKey::first()),
            })?;
        }
        Ok(())
    })?;

    for (id, s) in &p.storylines {
        b.prose(
            "storylines",
            body_doc_id(id.as_str(), MOD_DESCRIPTION),
            &s.body,
            &[],
        )?;
    }
    for (id, c) in &p.categories {
        b.prose(
            "categories",
            body_doc_id(id.as_str(), MOD_DESCRIPTION),
            &c.body,
            &[],
        )?;
    }
    for e in &p.elements {
        b.prose(
            "elements",
            body_doc_id(e.id.as_str(), MOD_PROSE),
            &e.body,
            &[],
        )?;
    }

    let (rt_name, source_role, target_role) = plan::RELATION_TYPE;
    b.edit_book(|t| {
        t.relation_type(&p.relation_type)?
            .name(rt_name)?
            .orientation(&RelationOrientation::Directed)?
            .source_role(source_role)?
            .target_role(target_role)?
            .source_kinds(&[EntityKind::Entry])?
            .target_kinds(&[EntityKind::Entry])?
            .source_templates(&[tid(TPL_CHARACTER)])?
            .target_templates(&[tid(TPL_CHARACTER)])?;
        for (k, (id, a, z)) in p.relations.iter().enumerate() {
            t.relation(id)?
                .ends(&element_refs[*a], &element_refs[*z])?
                .relation_type(&p.relation_type)?
                .created_at(Some(Timestamp(T0 + k as i64)))?;
        }
        Ok(())
    })?;

    b.edit_book(|t| {
        for (id, name, _) in &p.acts {
            let act_entry = eid(id.as_str());
            t.entries().create(
                &act_entry,
                Some(&roots.manuscript),
                name,
                Some(&tid(TPL_GROUP)),
                true,
            )?;
        }
        for (i, c) in p.chapters.iter().enumerate() {
            let order = Plan::order(i);
            let parent_id = p
                .acts
                .iter()
                .rfind(|(_, _, first)| *first <= i)
                .map(|(id, _, _)| eid(id.as_str()))
                .unwrap_or_else(|| roots.manuscript.clone());
            let chap_id = eid(c.id.as_str());
            let primary_sl = c
                .storylines
                .first()
                .map(|&idx| eid(p.storylines[idx].0.as_str()));
            {
                let w = t.entries().create(
                    &chap_id,
                    Some(&parent_id),
                    &c.title,
                    Some(&tid(TPL_CHAPTER)),
                    false,
                )?;
                w.created_at(Some(Timestamp(T0 + i as i64)))?
                    .primary(primary_sl.as_ref())?
                    .set_field(
                        &fmod,
                        "summary",
                        Some(&FieldValue::Text(plan::CHAPTER_SUMMARY.into())),
                    )?
                    .set_field(
                        &fmod,
                        "status",
                        Some(&FieldValue::Text(c.status.as_str().into())),
                    )?;
            }
            for &s_idx in &c.storylines {
                let sl_id = eid(p.storylines[s_idx].0.as_str());
                t.put_membership(&sl_id, &chap_id, None, None)?;
            }
            if !c.storylines.is_empty() {
                t.timeline_view(&roots.narrative_view)?
                    .put_placement(&chap_id, order, None)?;
            }
        }
        for (id, at, label) in &p.time_pins {
            t.timeline_view(&roots.narrative_view)?
                .put_pin(&TimelinePin {
                    id: id.clone(),
                    at: *at,
                    label: label.clone(),
                    color: None,
                    entry: None,
                })?;
        }
        Ok(())
    })?;

    let first_chapter = b.prose.len();
    for c in &p.chapters {
        b.prose(
            "chapters",
            body_doc_id(c.id.as_str(), MOD_PROSE),
            &c.body,
            &element_refs,
        )?;
    }

    b.edit_book(|t| {
        for (id, name) in &p.idea_groups {
            let group_id = eid(id.as_str());
            t.entries().create(
                &group_id,
                Some(&roots.ideas),
                name,
                Some(&tid(TPL_IDEA_GROUP)),
                true,
            )?;
        }
        for (i, idea) in p.ideas.iter().enumerate() {
            let parent_id = idea
                .group
                .map(|g| eid(p.idea_groups[g].0.as_str()))
                .unwrap_or_else(|| roots.ideas.clone());
            let idea_id = eid(idea.id.as_str());
            let w = t.entries().create(
                &idea_id,
                Some(&parent_id),
                &idea.title,
                Some(&tid(TPL_IDEA)),
                false,
            )?;
            w.created_at(Some(Timestamp(T0 + i as i64)))?.set_field(
                &fmod,
                "status",
                Some(&FieldValue::Text(idea.status.as_str().into())),
            )?;
        }
        Ok(())
    })?;

    for idea in &p.ideas {
        b.prose(
            "ideas",
            body_doc_id(idea.id.as_str(), MOD_PROSE),
            &idea.body,
            &element_refs,
        )?;
    }

    if !p.materials.is_empty() {
        let text_materials_root = deterministic_text_materials_root(&p.book);
        let used_folders: std::collections::BTreeSet<usize> =
            p.materials.iter().filter_map(|m| m.folder).collect();
        b.edit_book(|t| {
            init_text_materials_root(t, &text_materials_root)?;
            for (idx, (id, name)) in p.folders.iter().enumerate() {
                if !used_folders.contains(&idx) {
                    continue;
                }
                let fw = t.entries().create(
                    &eid(id.as_str()),
                    Some(&text_materials_root),
                    name,
                    Some(&tid(TPL_GROUP)),
                    true,
                )?;
                fw.overrides(Some(&LevelSettingsOverride {
                    accept: Some(false),
                    ..Default::default()
                }))?;
            }
            let plain_tpl = if p.materials.iter().any(|m| !m.task_todos) {
                Some(ensure_plain_note_template(t)?)
            } else {
                None
            };
            for m in &p.materials {
                let parent_id = m
                    .folder
                    .map(|f| eid(p.folders[f].0.as_str()))
                    .unwrap_or_else(|| text_materials_root.clone());
                let tpl = if m.task_todos {
                    tid(TPL_NOTE)
                } else {
                    plain_tpl.clone().expect("plain note template")
                };
                t.entries().create(
                    &eid(m.id.as_str()),
                    Some(&parent_id),
                    &m.title,
                    Some(&tpl),
                    false,
                )?;
            }
            Ok(())
        })?;
    }

    for m in &p.materials {
        b.prose(
            "materialNotes",
            body_doc_id(m.id.as_str(), MOD_PROSE),
            &m.body,
            &[],
        )?;
    }

    // Comments and TODOs anchored on chapter prose.
    let mut placed = Vec::new();
    for c in &p.comments {
        let view = b.prose[first_chapter + c.chapter].view();
        let block = view.blocks().get(c.para).and_then(|bl| bl.id.clone());
        let quote = view.text_in(c.range.0..c.range.1)?;
        if quote != c.quote {
            return Err(DocError::Missing {
                collection: "planned quotation",
                id: c.quote.clone(),
            });
        }
        placed.push((block, view.anchor(c.range.0..c.range.1)));
    }
    b.edit_book(|t| {
        for (k, (c, (block, anchor))) in p.comments.iter().zip(&placed).enumerate() {
            let w = t.comment(&c.id)?;
            w.origin(&CommentOrigin::Manual)?
                .author_kind(&CommentAuthorKind::User)?
                .status(if c.resolved {
                    &CommentStatus::Resolved
                } else {
                    &CommentStatus::Open
                })?
                .source(&CommentSource::Manual)?
                .target(Some(&EntityRef::new(
                    EntityKind::Entry,
                    p.chapters[c.chapter].id.as_str(),
                )))?
                .module(Some(&prose_mod))?
                .target_block(block.as_ref())?
                .anchor(anchor.as_ref())?
                .quote(Some(&c.quote))?
                .snapshots(&[BlockSnapshot {
                    block: block.clone(),
                    text: c.snapshot.clone(),
                }])?
                .body(&c.body)?
                .created_at(Some(Timestamp(T0 + k as i64)))?
                .updated_at(Some(Timestamp(T0 + k as i64)))?
                .resolved_at(c.resolved.then_some(Timestamp(T0 + k as i64 + 60)))?;
            if let Some(pr) = c.priority {
                w.priority(Some(&CommentPriority::parse(pr)))?;
            }
        }
        Ok(())
    })?;
    for c in &p.comments {
        b.record(if c.todo { "todos" } else { "comments" }, c.body.clone());
    }

    b.edit_book(|t| {
        for (id, body) in &p.memory {
            t.memory(id)?
                .kind(&MemoryKind::Preference)?
                .body(body)?
                .source(&MemorySource::Author)?
                .status(&MemoryStatus::Active)?;
        }
        Ok(())
    })?;

    b.edit_stats(|t| {
        for (day, words) in &p.writing_days {
            t.writing_day(&p.device, day, *words)?;
        }
        Ok(())
    })?;

    if !p.ideas.is_empty() {
        b.edit_layout(|t| {
            for idea in &p.ideas {
                let parent_id = idea
                    .group
                    .map(|g| eid(p.idea_groups[g].0.as_str()))
                    .unwrap_or_else(|| roots.ideas.clone());
                let idea_id = eid(idea.id.as_str());
                t.put_position(&format!("{parent_id}/board"), &idea_id, idea.x, idea.y)?;
            }
            Ok(())
        })?;
    }

    reference_file(&mut b)?;
    Ok(b.finish())
}

/// One file in the asset library, used nowhere: every seeded book has it
/// (the direct presets and the books converted from v2 alike, so the
/// smallest one has a file too; `kernel-v5.md` §6 素材库).
fn reference_file(b: &mut BuilderV3) -> Result<()> {
    let book = b.book.book_id().clone();
    let file = SeedFile::image(&super::build::id(0, book.as_str(), "v3-asset", 0), 320, 200);
    let record = file.record("参考图", None);
    b.files.push(file);
    b.edit_book(|t| t.put_asset(&record))
}

/// Convert a v2.2 [`SeededBook`] (such as the sample books and showcase shelf)
/// into a [`SeededBookV3`] with identical content, groups and counters.
pub fn book_to_v3(src: &SeededBook) -> Result<SeededBookV3> {
    let v = src.book.view();
    let mut b = BuilderV3::new(src.book_id().clone())?;
    let fmod = mid(MOD_FIELDS);
    let kvmod = mid(MOD_KV);
    let prose_mod = mid(MOD_PROSE);
    let patches_mod = mid(MOD_PATCHES);
    let grid_mod = mid(MOD_PLOT_GRID);

    let meta = v.meta();
    let storylines = v.storylines();
    let categories = v.categories();
    let elements = v.elements();
    let acts = v.acts();
    let chapters = v.chapters();
    let drift_groups = v.drift_groups();
    let drifts = v.drifts();
    let time_pins = v.time_pins();
    let relation_types = v.relation_types();
    let relations = v.relations();
    let material_folders = v.material_folders();
    let materials = v.materials();
    let facts = v.facts();
    let memory = v.memory();
    let writing_days = v.writing_days();
    let comments = v.comments();
    let patches = v.patches();

    let roots = deterministic_novel_roots(src.book_id());
    b.edit_book(|t| {
        init_novel_roots(t, &roots)?;
        let m = t.meta();
        m.name(&meta.name)?
            .summary(&meta.summary)?
            .created_at(meta.created_at)?;
        t.project().book(Some(&ProjectBook {
            root: BookRoot::Entry {
                entry: roots.manuscript.clone(),
            },
            word_target_set: meta.word_target_set,
            daily_word_target_set: meta.daily_word_target_set,
        }))?;
        for f in &facts {
            t.put_fact(f)?;
        }
        let default_sl_pos = positions(storylines.len());
        for (i, s) in storylines.iter().enumerate() {
            let entry_id = eid(s.id.as_str());
            let w = t.entries().create(
                &entry_id,
                Some(&roots.storylines),
                &s.name,
                Some(&tid(TPL_STORYLINE)),
                false,
            )?;
            w.set_field(&fmod, "color", Some(&FieldValue::Text(s.color.clone())))?
                .set_field(&fmod, "summary", Some(&FieldValue::Text(s.summary.clone())))?;
            for kv in &s.facts {
                w.put_kv(&kvmod, kv)?;
            }
            t.timeline_view(&roots.narrative_view)?.put_lane(
                &entry_id,
                Some(s.pos.as_ref().unwrap_or(&default_sl_pos[i])),
            )?;
        }
        for c in &categories {
            let entry_id = eid(c.id.as_str());
            t.entries()
                .create(
                    &entry_id,
                    Some(&roots.elements),
                    &c.name,
                    Some(&tid(TPL_CATEGORY)),
                    true,
                )?
                .set_field(&fmod, "color", Some(&FieldValue::Text(c.color.clone())))?;
        }
        for e in &elements {
            let parent_id = e
                .category
                .as_ref()
                .map(|c| eid(c.as_str()))
                .or_else(|| categories.first().map(|c| eid(c.id.as_str())))
                .unwrap_or_else(|| roots.elements.clone());
            let entry_id = eid(e.id.as_str());
            let w = t.entries().create(
                &entry_id,
                Some(&parent_id),
                &e.name,
                Some(&tid(TPL_CHARACTER)),
                false,
            )?;
            w.created_at(e.created_at)?.set_field(
                &fmod,
                "summary",
                Some(&FieldValue::Text(e.summary.clone())),
            )?;
            if !e.aliases.is_empty() {
                w.set_field(
                    &fmod,
                    "aliases",
                    Some(&FieldValue::List(e.aliases.iter().cloned().collect())),
                )?;
            }
            if let Some(p) = &e.portrait {
                w.set_field(
                    &fmod,
                    "portrait",
                    Some(&FieldValue::Text(p.as_str().to_string())),
                )?;
            }
            for kv in &e.facts {
                w.put_kv(&kvmod, kv)?;
            }
        }
        for a in &acts {
            let act_id = eid(a.id.as_str());
            t.entries().create(
                &act_id,
                Some(&roots.manuscript),
                &a.name,
                Some(&tid(TPL_GROUP)),
                true,
            )?;
        }
        for c in &chapters {
            let parent_id = acts
                .iter()
                .rfind(|a| {
                    a.start_order
                        .is_none_or(|s| c.book_order.is_some_and(|o| o >= s))
                })
                .map(|a| eid(a.id.as_str()))
                .unwrap_or_else(|| roots.manuscript.clone());
            let chap_id = eid(c.id.as_str());
            let mut ordered_sl: Vec<&StorylineId> = Vec::new();
            if let Some(primary) = &c.primary_storyline {
                ordered_sl.push(primary);
            }
            for s in &c.storylines {
                if !ordered_sl.contains(&s) {
                    ordered_sl.push(s);
                }
            }
            let primary_host = c
                .primary_storyline
                .as_ref()
                .or_else(|| ordered_sl.first().copied())
                .map(|s| eid(s.as_str()));
            {
                let w = t.entries().create(
                    &chap_id,
                    Some(&parent_id),
                    &c.title,
                    Some(&tid(TPL_CHAPTER)),
                    false,
                )?;
                w.created_at(c.created_at)?
                    .primary(primary_host.as_ref())?
                    .set_field(&fmod, "summary", Some(&FieldValue::Text(c.summary.clone())))?
                    .set_field(
                        &fmod,
                        "status",
                        Some(&FieldValue::Text(c.status.as_str().into())),
                    )?;
            }
            for sl in &ordered_sl {
                t.put_membership(&eid(sl.as_str()), &chap_id, None, None)?;
            }
            if !ordered_sl.is_empty() {
                let at = match c.narrative_order {
                    Some(no) => no,
                    None => t
                        .view()
                        .timeline_views_raw()
                        .into_iter()
                        .find(|tv| tv.id == roots.narrative_view)
                        .map(|tv| dr_model::v3::timeline_scale_end(&tv.placements))
                        .unwrap_or(0.0),
                };
                t.timeline_view(&roots.narrative_view)?
                    .put_placement(&chap_id, at, None)?;
            }
            if let Some(grid) = v.plot_grid(&c.id) {
                let gw = t.plot_grid(&chap_id, &grid_mod)?;
                for col in &grid.cols {
                    gw.col(
                        &col.id,
                        col.pos.as_ref().map_or("a0", PosKey::as_str),
                        &col.label,
                    )?;
                }
                for row in &grid.rows {
                    gw.row(
                        &row.id,
                        row.pos.as_ref().map_or("a0", PosKey::as_str),
                        &row.label,
                    )?;
                }
                for ((row_id, col_id), body) in &grid.cells {
                    if !body.is_empty() {
                        gw.cell(row_id, col_id, Some(body))?;
                    }
                }
            }
        }
        for pin in &time_pins {
            t.timeline_view(&roots.narrative_view)?
                .put_pin(&TimelinePin {
                    id: pin.id.clone(),
                    at: pin.narrative_order,
                    label: pin.label.clone(),
                    color: None,
                    entry: pin.drift.as_ref().map(|d| eid(d.as_str())),
                })?;
        }
        for g in &drift_groups {
            let parent_id = g
                .parent
                .as_ref()
                .map(|p| eid(p.as_str()))
                .unwrap_or_else(|| roots.ideas.clone());
            t.entries().create(
                &eid(g.id.as_str()),
                Some(&parent_id),
                &g.name,
                Some(&tid(TPL_IDEA_GROUP)),
                true,
            )?;
        }
        for d in &drifts {
            let parent_id = d
                .group
                .as_ref()
                .map(|g| eid(g.as_str()))
                .unwrap_or_else(|| roots.ideas.clone());
            let idea_id = eid(d.id.as_str());
            let w = t.entries().create(
                &idea_id,
                Some(&parent_id),
                &d.title,
                Some(&tid(TPL_IDEA)),
                false,
            )?;
            w.created_at(d.created_at)?
                .set_field(&fmod, "summary", Some(&FieldValue::Text(d.summary.clone())))?
                .set_field(
                    &fmod,
                    "status",
                    Some(&FieldValue::Text(d.status.as_str().into())),
                )?;
        }
        let non_text_assets: BTreeMap<&str, Option<&AssetId>> = materials
            .iter()
            .filter(|m| m.kind != MaterialKind::Text)
            .map(|m| (m.id.as_str(), m.asset.as_ref()))
            .collect();
        let map_endpoint = |r: &EntityRef| -> Option<EntityRef> {
            if r.kind == EntityKind::Material
                && let Some(asset) = non_text_assets.get(r.id.as_str())
            {
                return asset
                    .as_ref()
                    .map(|a| EntityRef::new(EntityKind::Asset, a.as_str()));
            }
            Some(map_entity_ref_v3(r))
        };
        let map_kinds = |kinds: &[EntityKind]| -> Vec<EntityKind> {
            let mut out = std::collections::BTreeSet::new();
            for k in kinds {
                if *k == EntityKind::Material {
                    out.insert(EntityKind::Entry);
                    out.insert(EntityKind::Asset);
                } else {
                    out.insert(map_entity_kind_v3(k));
                }
            }
            out.into_iter().collect()
        };
        let symmetric_types: std::collections::HashSet<RelationTypeId> = relation_types
            .iter()
            .filter(|rt| rt.orientation == RelationOrientation::Symmetric)
            .map(|rt| rt.id.clone())
            .collect();
        for rt in &relation_types {
            if rt.locked || rt.system_key.is_some() {
                continue;
            }
            let src_kinds = map_kinds(&rt.source_kinds);
            let tgt_kinds = map_kinds(&rt.target_kinds);
            let w = t.relation_type(&rt.id)?;
            w.name(&rt.name)?
                .description(&rt.description)?
                .orientation(&rt.orientation)?
                .source_role(&rt.source_role)?
                .target_role(&rt.target_role)?
                .source_kinds(&src_kinds)?
                .target_kinds(&tgt_kinds)?;
        }
        let mut seen_relations = std::collections::BTreeSet::new();
        for r in &relations {
            let (Some(from), Some(to)) = (map_endpoint(&r.from), map_endpoint(&r.to)) else {
                continue;
            };
            let (a, z) = if symmetric_types.contains(&r.relation_type) {
                canonical_symmetric(from, to)
            } else {
                (from, to)
            };
            if a == z || !seen_relations.insert((r.relation_type.clone(), a.clone(), z.clone())) {
                continue;
            }
            t.relation(&r.id)?
                .ends(&a, &z)?
                .relation_type(&r.relation_type)?
                .created_at(r.created_at)?;
        }
        let note_folder_ids =
            dr_samples::v3::note_material_folder_ids(&material_folders, &materials);
        let text_materials_root = if materials.iter().any(|m| m.kind == MaterialKind::Text) {
            let id = deterministic_text_materials_root(src.book_id());
            init_text_materials_root(t, &id)?;
            Some(id)
        } else {
            None
        };
        if let Some(root_id) = &text_materials_root {
            for f in &material_folders {
                if !note_folder_ids.contains(&f.id) {
                    continue;
                }
                let parent_id = f
                    .parent
                    .as_ref()
                    .filter(|p| note_folder_ids.contains(*p))
                    .map(|p| eid(p.as_str()))
                    .unwrap_or_else(|| root_id.clone());
                let fw = t.entries().create(
                    &eid(f.id.as_str()),
                    Some(&parent_id),
                    &f.name,
                    Some(&tid(TPL_GROUP)),
                    true,
                )?;
                fw.overrides(Some(&LevelSettingsOverride {
                    accept: Some(false),
                    ..Default::default()
                }))?;
            }
        }
        let plain_tpl = if materials
            .iter()
            .any(|m| m.kind == MaterialKind::Text && !m.task_todos)
        {
            Some(ensure_plain_note_template(t)?)
        } else {
            None
        };
        let mut first_title_by_asset: BTreeMap<&AssetId, &str> = BTreeMap::new();
        let mut first_folder_by_asset: BTreeMap<&AssetId, String> = BTreeMap::new();
        for m in &materials {
            if let Some(asset) = &m.asset {
                first_title_by_asset
                    .entry(asset)
                    .or_insert(m.title.as_str());
                if !first_folder_by_asset.contains_key(asset)
                    && let Some(fid) = &m.folder
                    && let Some(path) = dr_samples::v3::material_folder_path(&material_folders, fid)
                {
                    first_folder_by_asset.insert(asset, path);
                }
            }
            if m.kind == MaterialKind::Text {
                let root_id = text_materials_root
                    .as_ref()
                    .expect("text materials root created");
                let parent_id = m
                    .folder
                    .as_ref()
                    .filter(|f| note_folder_ids.contains(*f))
                    .map(|f| eid(f.as_str()))
                    .unwrap_or_else(|| root_id.clone());
                let tpl = if m.task_todos {
                    tid(TPL_NOTE)
                } else {
                    plain_tpl.clone().expect("plain note template")
                };
                t.entries().create(
                    &eid(m.id.as_str()),
                    Some(&parent_id),
                    &m.title,
                    Some(&tpl),
                    false,
                )?;
            }
        }
        for mut asset in v.assets() {
            if asset.name.is_empty() {
                asset.name = first_title_by_asset
                    .get(&asset.id)
                    .copied()
                    .unwrap_or_default()
                    .to_string();
            }
            if asset.folder.is_none() {
                asset.folder = first_folder_by_asset.get(&asset.id).cloned();
            }
            t.put_asset(&asset)?;
        }
        for mem in &memory {
            let w = t.memory(&mem.id)?;
            w.kind(&mem.kind)?
                .body(&mem.body)?
                .source(&mem.source)?
                .status(&mem.status)?
                .origin_ref(mem.origin_ref.as_deref())?;
            if let Some(target) = &mem.target
                && let Some(mapped) = map_endpoint(target)
            {
                w.target(Some(&mapped))?;
                if mapped.kind == EntityKind::Entry
                    && let Some(block) = &mem.target_block
                {
                    w.target_block(Some(block))?;
                }
            }
        }
        Ok(())
    })?;

    // Convert prose documents in creation order.
    let non_text_material_ids: std::collections::BTreeSet<String> = materials
        .iter()
        .filter(|m| m.kind != MaterialKind::Text)
        .map(|m| m.id.to_string())
        .collect();
    let mut chapter_prose_by_id: HashMap<String, usize> = HashMap::new();
    for p in &src.prose {
        if let DocId::Material(id) = p.doc_id()
            && non_text_material_ids.contains(id.as_str())
        {
            continue;
        }
        let new_id = match p.doc_id() {
            DocId::Storyline(id) => body_doc_id(id.as_str(), MOD_DESCRIPTION),
            DocId::Category(id) => body_doc_id(id.as_str(), MOD_DESCRIPTION),
            DocId::Element(id) => body_doc_id(id.as_str(), MOD_PROSE),
            DocId::Node(id) => body_doc_id(id.as_str(), MOD_PROSE),
            DocId::Material(id) => body_doc_id(id.as_str(), MOD_PROSE),
            other => other.clone(),
        };
        let ts = b.tick();
        let doc = clone_prose_to_v3(p, new_id, ts, &non_text_material_ids)?;
        if let DocId::Node(id) = p.doc_id() {
            chapter_prose_by_id.insert(id.to_string(), b.prose.len());
        }
        b.prose.push(doc);
    }

    // Re-locate quotation anchors in converted chapter prose documents.
    let locate_quote = |prose_docs: &[ProseDoc], node_id: &str, quote: &str| {
        let &idx = chapter_prose_by_id.get(node_id)?;
        let view = prose_docs[idx].view();
        let text = view.plain_text();
        let at = text.find(quote)?;
        let from = text[..at].chars().count();
        let to = from + quote.chars().count();
        let block = view.blocks().into_iter().find(|bl| bl.newline >= to)?;
        let start = view.paragraph_start(block.newline);
        Some((
            view.anchor(from..to),
            block.id,
            view.text_in(start..block.newline).ok()?,
        ))
    };

    let mut located_comments = Vec::with_capacity(comments.len());
    for c in &comments {
        let placed = match (&c.target, &c.quote) {
            (Some(t), Some(q)) => locate_quote(&b.prose, &t.id, q),
            _ => None,
        };
        located_comments.push(placed);
    }

    let mut located_patches = Vec::with_capacity(patches.len());
    for p in &patches {
        let placed = match (&p.source_node, &p.source_text) {
            (Some(n), Some(q)) => locate_quote(&b.prose, n.as_str(), q),
            _ => None,
        };
        located_patches.push(placed);
    }

    b.edit_book(|t| {
        let materials_by_id: BTreeMap<&str, &dr_model::import_v1::Material> =
            materials.iter().map(|m| (m.id.as_str(), m)).collect();
        for (c, placed) in comments.iter().zip(&located_comments) {
            let origin = match &c.projection {
                Some(p) => match &p.kind {
                    ProjectionKind::Marker => CommentOrigin::Marker,
                    ProjectionKind::NoteTask => CommentOrigin::Task,
                    ProjectionKind::Other(o) => CommentOrigin::parse(o),
                },
                None => match c.author_kind {
                    CommentAuthorKind::Ai => CommentOrigin::Agent,
                    CommentAuthorKind::External => CommentOrigin::Reader,
                    _ => CommentOrigin::Manual,
                },
            };
            let (mapped_target, module, part) = match &c.target {
                Some(tgt) if tgt.kind == EntityKind::Material => {
                    match materials_by_id.get(tgt.id.as_str()) {
                        Some(m) if m.kind != MaterialKind::Text => {
                            let asset_id =
                                m.asset.as_ref().map_or(tgt.id.as_str(), AssetId::as_str);
                            (
                                Some(EntityRef::new(EntityKind::Asset, asset_id)),
                                None,
                                c.region.map(|region| CommentPart::Region { region }),
                            )
                        }
                        _ => (Some(map_entity_ref_v3(tgt)), Some(prose_mod.clone()), None),
                    }
                }
                Some(tgt) if map_entity_kind_v3(&tgt.kind) == EntityKind::Entry => {
                    (Some(map_entity_ref_v3(tgt)), Some(prose_mod.clone()), None)
                }
                Some(tgt) => (Some(map_entity_ref_v3(tgt)), None, None),
                None => (None, None, None),
            };
            let w = t.comment(&c.id)?;
            w.origin(&origin)?
                .part(part.as_ref())?
                .author_kind(&c.author_kind)?
                .status(&c.status)?
                .source(&c.source)?
                .priority(c.priority.as_ref())?
                .body(&c.body)?
                .created_at(c.created_at)?
                .updated_at(c.updated_at)?
                .resolved_at(c.resolved_at)?;
            if let Some(mapped) = &mapped_target {
                w.target(Some(mapped))?;
                if let Some(m) = &module {
                    w.module(Some(m))?;
                }
            }
            if let Some((anchor, block, para)) = placed {
                w.anchor(anchor.as_ref())?
                    .target_block(block.as_ref())?
                    .quote(c.quote.as_deref())?
                    .snapshots(&[BlockSnapshot {
                        block: block.clone(),
                        text: para.clone(),
                    }])?;
            } else {
                w.target_block(c.target_block.as_ref())?
                    .quote(c.quote.as_deref())?
                    .snapshots(&c.snapshots)?;
            }
        }
        for (p, placed) in patches.iter().zip(&located_patches) {
            let elem_id = eid(p.element.as_str());
            let pw = t.patch(&p.id)?;
            pw.entry(&elem_id)?
                .module(&patches_mod)?
                .source_entry(p.source_node.as_ref().map(|n| eid(n.as_str())).as_ref())?
                .source_module(p.source_node.as_ref().map(|_| &prose_mod))?
                .source_text(p.source_text.as_deref())?
                .title(p.title.as_deref())?
                .body(&p.body)?;
            if let Some(pos) = &p.pos {
                pw.pos(pos)?;
            }
            if let Some((anchor, block, _)) = placed {
                pw.source_block(block.as_ref())?.anchor(anchor.as_ref())?;
            } else {
                pw.source_block(p.source_block.as_ref())?;
            }
        }
        Ok(())
    })?;

    b.groups = src.groups().clone();
    b.counters = src.counters();
    b.edit_stats(|t| {
        for wd in &writing_days {
            t.writing_day(&wd.device, &wd.day, wd.words)?;
        }
        Ok(())
    })?;
    if !drifts.is_empty() {
        b.edit_layout(|t| {
            for d in &drifts {
                let parent_id = d
                    .group
                    .as_ref()
                    .map(|g| eid(g.as_str()))
                    .unwrap_or_else(|| roots.ideas.clone());
                let idea_id = eid(d.id.as_str());
                t.put_position(&format!("{parent_id}/board"), &idea_id, d.x, d.y)?;
            }
            Ok(())
        })?;
    }
    reference_file(&mut b)?;
    Ok(b.finish())
}

fn clone_prose_to_v3(
    src: &ProseDoc,
    new_doc_id: DocId,
    ts: i64,
    non_text_materials: &std::collections::BTreeSet<String>,
) -> Result<ProseDoc> {
    let v = src.view();
    let paras: Vec<_> = v.paragraphs().collect();
    let links = v.entity_links();
    let plain = paras
        .iter()
        .map(|p| p.text())
        .collect::<Vec<_>>()
        .join("\n");
    let peer = import_peer(&new_doc_id.to_string());
    let mut doc = ProseDoc::create(new_doc_id, peer)?;
    let (r, _) = doc.edit_at(Origin::Import, Some(ts), |t| {
        if plain.is_empty() && paras.len() <= 1 {
            return Ok(());
        }
        t.insert_paragraphs(0, &plain)?;
        let blocks = t.view().blocks();
        let mut start = 0usize;
        for (p, b) in paras.iter().zip(&blocks) {
            if p.attrs != BlockAttrs::default() {
                t.set_block_attrs(b.newline, &p.attrs)?;
            }
            let mut offset = start;
            for r in &p.runs {
                let len = r.text.chars().count();
                if len > 0 {
                    if r.marks.bold {
                        t.set_style(offset..offset + len, &InlineStyle::Bold)?;
                    }
                    if r.marks.italic {
                        t.set_style(offset..offset + len, &InlineStyle::Italic)?;
                    }
                    if r.marks.underline {
                        t.set_style(offset..offset + len, &InlineStyle::Underline)?;
                    }
                    if r.marks.strike {
                        t.set_style(offset..offset + len, &InlineStyle::Strike)?;
                    }
                    if r.marks.code {
                        t.set_style(offset..offset + len, &InlineStyle::Code)?;
                    }
                }
                offset += len;
            }
            start += p.text().chars().count() + 1;
        }
        for (range, l) in &links {
            if l.kind == EntityKind::Material && non_text_materials.contains(l.target.as_str()) {
                continue;
            }
            t.link_entity(
                range.clone(),
                &EntityLink {
                    target: l.target.clone(),
                    kind: map_entity_kind_v3(&l.kind),
                    block: l.block.clone(),
                    end_block: l.end_block.clone(),
                },
            )?;
        }
        Ok(())
    });
    r?;
    Ok(doc)
}

// ---- Canonical digest for v3 books ----------------------------------------

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn load_snapshot(lib: &dr_store::Library, id: &str) -> std::result::Result<Vec<u8>, String> {
    lib.load_copy(id)
        .map_err(err)?
        .export(loro::ExportMode::Snapshot)
        .map_err(err)
}

fn sorted<T: Ord>(mut v: Vec<T>) -> Vec<T> {
    v.sort();
    v
}

/// Canonical digest of a v3 book stored in `lib`, independent of internal IDs,
/// peers and timestamps.
pub fn digest_v3(lib: &dr_store::Library, book: &str) -> std::result::Result<Value, String> {
    let book_id = BookId::parse(book).map_err(err)?;
    let doc = BookDocV3::load(
        book_id.clone(),
        1,
        &[load_snapshot(lib, &format!("book:{book}"))?],
    )
    .map_err(err)?;
    let layout_positions = if lib
        .doc_info(&format!("layout:{book}"))
        .map_err(err)?
        .is_some()
    {
        LayoutDoc::load(
            book_id,
            1,
            &[load_snapshot(lib, &format!("layout:{book}"))?],
        )
        .map_err(err)?
        .view()
        .all_positions()
    } else {
        BTreeMap::new()
    };
    let v = doc.view();
    let names = NamesV3::of(&v);
    let prose = |d: DocId| -> std::result::Result<Value, String> {
        let id = d.to_string();
        if lib.doc_info(&id).map_err(err)?.is_none() {
            return Ok(Value::Null);
        }
        let p = ProseDoc::load(d, 1, &[load_snapshot(lib, &id)?]).map_err(err)?;
        Ok(prose_digest_v3(&p, &names))
    };

    let meta = v.meta();
    let mut facts: Vec<(String, String)> =
        v.facts().into_iter().map(|f| (f.key, f.value)).collect();
    facts.sort();

    let entries = v.entries();
    let fmod = mid(MOD_FIELDS);
    let kvmod = mid(MOD_KV);
    let ms_root = v.root_entry_by_template(&tid(TPL_MANUSCRIPT)).map(|e| e.id);
    let narrative = v.timeline_views().into_iter().next();

    let lane_positions: BTreeMap<EntryId, Option<PosKey>> = narrative
        .as_ref()
        .map(|tv| {
            tv.lanes
                .iter()
                .map(|l| (l.entry.clone(), l.pos.clone()))
                .collect()
        })
        .unwrap_or_default();
    let placements: BTreeMap<EntryId, f64> = narrative
        .as_ref()
        .map(|tv| {
            tv.placements
                .iter()
                .map(|p| (p.entry.clone(), p.at))
                .collect()
        })
        .unwrap_or_default();

    let mut storyline_entries: Vec<&Entry> = entries
        .iter()
        .filter(|e| !e.is_trashed() && e.template.as_ref() == Some(&tid(TPL_STORYLINE)))
        .collect();
    storyline_entries.sort_by(|a, b| {
        let pa = lane_positions.get(&a.id).and_then(|p| p.as_ref());
        let pb = lane_positions.get(&b.id).and_then(|p| p.as_ref());
        pa.cmp(&pb).then_with(|| a.id.cmp(&b.id))
    });
    let storylines: Vec<Value> = storyline_entries
        .into_iter()
        .map(|s| {
            let color = entry_field_str(s, &fmod, "color").unwrap_or("").to_string();
            let summary = entry_field_str(s, &fmod, "summary")
                .unwrap_or("")
                .to_string();
            Ok(json!([
                s.title,
                color,
                summary,
                prose(body_doc_id(s.id.as_str(), MOD_DESCRIPTION))?
            ]))
        })
        .collect::<std::result::Result<_, String>>()?;

    let mut categories: Vec<Value> = entries
        .iter()
        .filter(|e| !e.is_trashed() && e.template.as_ref() == Some(&tid(TPL_CATEGORY)))
        .map(|c| {
            let color = entry_field_str(c, &fmod, "color").unwrap_or("").to_string();
            Ok(json!([
                c.title,
                color,
                prose(body_doc_id(c.id.as_str(), MOD_DESCRIPTION))?
            ]))
        })
        .collect::<std::result::Result<_, String>>()?;
    categories.sort_by_key(|c| c.to_string());

    let mut elements: Vec<Value> = entries
        .iter()
        .filter(|e| !e.is_trashed() && e.template.as_ref() == Some(&tid(TPL_CHARACTER)))
        .map(|e| {
            let summary = entry_field_str(e, &fmod, "summary")
                .unwrap_or("")
                .to_string();
            let aliases: Vec<String> = e
                .fields
                .get(&fmod)
                .and_then(|m| m.get("aliases"))
                .and_then(FieldValue::as_list)
                .map(ToOwned::to_owned)
                .unwrap_or_default();
            let mut efacts: Vec<(String, String)> =
                e.kv.get(&kvmod)
                    .into_iter()
                    .flatten()
                    .map(|f| (f.key.clone(), f.value.clone()))
                    .collect();
            efacts.sort();
            Ok(json!({
                "name": e.title,
                "category": e.parent.as_ref().map(|p| names.entry(p.as_str())),
                "summary": summary,
                "aliases": aliases,
                "facts": efacts,
                "body": prose(body_doc_id(e.id.as_str(), MOD_PROSE))?,
            }))
        })
        .collect::<std::result::Result<_, String>>()?;
    elements.sort_by_key(|e| e["name"].to_string());

    let mut relation_types: Vec<Value> = v
        .relation_types()
        .into_iter()
        .filter(|t| t.system_key.is_none())
        .map(|t| {
            json!([
                t.name,
                t.orientation.as_str(),
                t.source_role,
                t.target_role,
                t.source_kinds
                    .iter()
                    .map(|k| k.as_str())
                    .collect::<Vec<_>>(),
                t.target_kinds
                    .iter()
                    .map(|k| k.as_str())
                    .collect::<Vec<_>>(),
            ])
        })
        .collect();
    relation_types.sort_by_key(|t| t.to_string());

    let type_names: BTreeMap<String, String> = v
        .relation_types()
        .into_iter()
        .map(|t| (t.id.to_string(), t.name))
        .collect();
    let mut relations: Vec<Value> = v
        .relations()
        .into_iter()
        .map(|r| {
            json!([
                type_names.get(r.relation_type.as_str()),
                names.entity(&r.from),
                names.entity(&r.to),
            ])
        })
        .collect();
    relations.sort_by_key(|r| r.to_string());

    let acts: Vec<Value> = entries
        .iter()
        .filter(|e| {
            !e.is_trashed()
                && e.template.as_ref() == Some(&tid(TPL_GROUP))
                && ms_root.is_some()
                && e.parent == ms_root
        })
        .map(|a| {
            let first = entries.iter().find(|c| {
                !c.is_trashed()
                    && c.template.as_ref() == Some(&tid(TPL_CHAPTER))
                    && c.parent.as_ref() == Some(&a.id)
            });
            json!([a.title, first.map(|c| c.title.clone())])
        })
        .collect();

    let chapters: Vec<Value> = entries
        .iter()
        .filter(|e| !e.is_trashed() && e.template.as_ref() == Some(&tid(TPL_CHAPTER)))
        .map(|c| {
            let summary = entry_field_str(c, &fmod, "summary")
                .unwrap_or("")
                .to_string();
            let status = entry_field_str(c, &fmod, "status")
                .unwrap_or("draft")
                .to_string();
            let mems = v.memberships_of_member(&c.id);
            let valid_hosts: std::collections::BTreeSet<EntryId> =
                mems.iter().map(|m| m.host.clone()).collect();
            let lines: Vec<&str> = mems.iter().map(|m| names.entry(m.host.as_str())).collect();
            let primary = c
                .effective_primary(&valid_hosts)
                .map(|h| names.entry(h.as_str()));
            Ok(json!({
                "title": c.title,
                "summary": summary,
                "status": status,
                "narrativeOrder": placements.get(&c.id).copied(),
                "storylines": sorted(lines),
                "primary": primary,
                "body": prose(body_doc_id(c.id.as_str(), MOD_PROSE))?,
            }))
        })
        .collect::<std::result::Result<_, String>>()?;

    let idea_groups: BTreeMap<String, String> = entries
        .iter()
        .filter(|e| !e.is_trashed() && e.template.as_ref() == Some(&tid(TPL_IDEA_GROUP)))
        .map(|g| (g.id.to_string(), g.title.clone()))
        .collect();
    let mut ideas: Vec<Value> = entries
        .iter()
        .filter(|e| !e.is_trashed() && e.template.as_ref() == Some(&tid(TPL_IDEA)))
        .map(|n| {
            let status = entry_field_str(n, &fmod, "status")
                .unwrap_or("drifting")
                .to_string();
            let group = n.parent.as_ref().and_then(|g| idea_groups.get(g.as_str()));
            let scope = n.parent.as_ref().map(|p| p.as_str()).unwrap_or("root");
            let pos = layout_positions
                .get(&format!("{scope}/board"))
                .and_then(|m| m.get(&n.id))
                .copied();
            let (x, y) = match pos {
                Some((bx, by)) => (Some(bx), Some(by)),
                None => (None, None),
            };
            Ok(json!({
                "title": n.title,
                "status": status,
                "group": group,
                "position": [x, y],
                "body": prose(body_doc_id(n.id.as_str(), MOD_PROSE))?,
            }))
        })
        .collect::<std::result::Result<_, String>>()?;
    ideas.sort_by_key(|i| i["title"].to_string());

    let mat_root = entries
        .iter()
        .find(|e| {
            !e.is_trashed()
                && e.parent.is_none()
                && e.template.as_ref() == Some(&tid(TPL_GROUP))
                && e.title == "文本素材"
        })
        .map(|e| e.id.clone());
    let parent_by_id: BTreeMap<&str, Option<&str>> = entries
        .iter()
        .map(|e| (e.id.as_str(), e.parent.as_ref().map(EntryId::as_str)))
        .collect();
    let under_materials = |start: Option<&EntryId>| -> bool {
        let Some(root) = &mat_root else {
            return false;
        };
        let mut cur = start.map(EntryId::as_str);
        let mut hops = 0usize;
        while let Some(id) = cur {
            if id == root.as_str() {
                return true;
            }
            hops += 1;
            if hops > parent_by_id.len() {
                break;
            }
            cur = parent_by_id.get(id).copied().flatten();
        }
        false
    };
    let templates_map = v.templates_map();
    let folders: BTreeMap<String, String> = entries
        .iter()
        .filter(|e| !e.is_trashed() && e.is_level() && under_materials(e.parent.as_ref()))
        .map(|f| (f.id.to_string(), f.title.clone()))
        .collect();
    // The notes in their order on the tree (the order is part of what is
    // compared, not a title sort), then the files in id order.
    let structure = v.structure_snapshot();
    let mut in_order: Vec<&Entry> = Vec::new();
    let mut seen_notes: BTreeSet<EntryId> = BTreeSet::new();
    let mut stack: Vec<EntryId> = Vec::new();
    if let Some(root) = &mat_root {
        stack.extend(
            structure
                .children_of(Some(root))
                .iter()
                .rev()
                .map(|c| c.id.clone()),
        );
    }
    // Pre-order: an entry, then what lives under it, siblings in their order.
    while let Some(at) = stack.pop() {
        if !seen_notes.insert(at.clone()) {
            continue;
        }
        if let Some(e) = entries.iter().find(|e| e.id == at) {
            in_order.push(e);
        }
        stack.extend(
            structure
                .children_of(Some(&at))
                .iter()
                .rev()
                .map(|c| c.id.clone()),
        );
    }
    let mut materials: Vec<Value> = in_order
        .into_iter()
        .filter(|e| !e.is_trashed() && !e.is_level() && under_materials(e.parent.as_ref()))
        .map(|m| {
            let folder = m.parent.as_ref().and_then(|f| folders.get(f.as_str()));
            let task_todos = m
                .template
                .as_ref()
                .and_then(|t| templates_map.get(t))
                .and_then(|t| t.modules.iter().find(|md| md.id.as_str() == MOD_PROSE))
                .is_none_or(|md| md.config.task_todos);
            Ok(json!({
                "title": m.title,
                "kind": "text",
                "folder": folder,
                "taskTodos": task_todos,
                "body": prose(body_doc_id(m.id.as_str(), MOD_PROSE))?,
            }))
        })
        .collect::<std::result::Result<_, String>>()?;
    let mut files = v.assets();
    files.sort_by(|a, b| a.id.cmp(&b.id));
    for a in files {
        materials.push(json!({
            "title": a.name,
            "kind": a.kind.as_str(),
            "folder": a.folder,
            "taskTodos": false,
            "body": Value::Null,
        }));
    }

    let mut comments: Vec<Value> = v
        .comments()
        .into_iter()
        .map(|c| {
            json!({
                "origin": c.origin.as_str(),
                "status": c.status.as_str(),
                "priority": c.priority.as_ref().map(|p| p.as_str().to_string()),
                "target": c.target.as_ref().map(|t| names.entity(t)),
                "quote": c.quote,
                "snapshots": c.snapshots.iter().map(|s| s.text.clone()).collect::<Vec<_>>(),
                "anchored": c.anchor.is_some(),
                "body": c.body,
            })
        })
        .collect();
    comments.sort_by_key(|c| c.to_string());

    let memory: Vec<String> = sorted(
        v.memory()
            .into_iter()
            .filter(|m| m.deleted_at.is_none())
            .map(|m| m.body)
            .collect(),
    );

    let project = v.project();
    Ok(json!({
        "meta": {
            "name": meta.name,
            "summary": meta.summary,
            "wordTarget": project.book.as_ref().is_some_and(|b| b.word_target_set.is_some()),
            "dailyWordTarget": project.book.as_ref().is_some_and(|b| b.daily_word_target_set.is_some()),
        },
        "facts": facts,
        "storylines": storylines,
        "categories": categories,
        "elements": elements,
        "relationTypes": relation_types,
        "relations": relations,
        "acts": acts,
        "chapters": chapters,
        "ideaGroups": sorted(idea_groups.into_values().collect()),
        "ideas": ideas,
        "materialFolders": sorted(folders.into_values().collect()),
        "materials": materials,
        "comments": comments,
        "memory": memory,
    }))
}

struct NamesV3 {
    map: BTreeMap<(String, String), String>,
}

impl NamesV3 {
    fn of(v: &BookViewV3<'_>) -> Self {
        let mut map = BTreeMap::new();
        for e in v.entries() {
            map.insert(
                (EntityKind::Entry.as_str().to_string(), e.id.to_string()),
                e.title,
            );
        }
        for a in v.assets() {
            map.insert(
                (EntityKind::Asset.as_str().to_string(), a.id.to_string()),
                a.name,
            );
        }
        Self { map }
    }

    fn get(&self, kind: &str, id: &str) -> &str {
        self.map
            .get(&(kind.to_string(), id.to_string()))
            .map_or("?", String::as_str)
    }

    fn entity(&self, r: &EntityRef) -> String {
        format!("{}:{}", r.kind.as_str(), self.get(r.kind.as_str(), &r.id))
    }

    fn entry(&self, id: &str) -> &str {
        self.get("entry", id)
    }
}

fn prose_digest_v3(p: &ProseDoc, names: &NamesV3) -> Value {
    let v = p.view();
    let paragraphs: Vec<Value> = v
        .paragraphs()
        .map(|para| {
            let a = &para.attrs;
            let styles: Vec<Value> = {
                let mut out = Vec::new();
                let mut at = 0usize;
                for r in &para.runs {
                    let n = r.text.chars().count();
                    if r.marks.bold || r.marks.italic {
                        out.push(json!([at, at + n, r.marks.bold, r.marks.italic]));
                    }
                    at += n;
                }
                out
            };
            json!([
                a.heading.map(|h| h.level()),
                a.list.as_ref().map(|l| l.as_str().to_string()),
                a.checked,
                a.quote,
                para.text(),
                styles,
            ])
        })
        .collect();
    let links: Vec<Value> = v
        .entity_links()
        .into_iter()
        .map(|(r, l)| json!([r.start, r.end, names.get(l.kind.as_str(), &l.target)]))
        .collect();
    json!({ "paragraphs": paragraphs, "links": links })
}

pub use super::acceptance::novel_entry;
