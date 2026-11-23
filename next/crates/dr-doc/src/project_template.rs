//! Library-level project template documents (`project-template:<id>`), prose
//! paragraph round-tripping, project-to-template extraction, and materializing
//! a [`ProjectTemplateValue`] into a new book (`docs/rust-rewrite/project-templates.md`).

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use dr_model::id::{
    EmbedId, EntryId, EntryTemplateId, KvEntryId, ModuleId, ProjectTemplateDocId, RelationTypeId,
    TabId, TimePinId, TimelineViewId,
};
use dr_model::kind::EntityKind;
use dr_model::pos::PosKey;
use dr_model::project_template::{
    PROJECT_TEMPLATE_FORMAT, PROJECT_TEMPLATE_FORMAT_VERSION, ProjectTemplateCredit,
    ProjectTemplateError, ProjectTemplateValue, StoredTemplateOrigin, TemplateBlockAttrs,
    TemplateDisplayMode, TemplateEntityLink, TemplateEntry, TemplateEntryTemplate,
    TemplateFieldDef, TemplateFieldType, TemplateFormatShortcuts, TemplateKvRow,
    TemplateLevelSettings, TemplateMediaArrangement, TemplateMembership, TemplateModuleConfig,
    TemplateModuleKind, TemplateModuleSpec, TemplateParagraph, TemplateProject,
    TemplateProjectBook, TemplateRelationType, TemplateRun, TemplateTab, TemplateTabMount,
    TemplateTable, TemplateVerbSpec, TemplateView, TemplateViewLane, TemplateViewPin,
    TemplateViewPlacement, parse_project_template_json, rewrite_entity_ref_value,
    to_canonical_json, validate_project_template_value,
};
use dr_model::prose::{InlineMarks, InlineStyle};
use dr_model::shared::KvEntry;
use dr_model::v3::{
    EntityLinkV3, Entry, EntryTemplate, FieldType, FieldValue, LevelSettingsOverride, LinkedText,
    MediaArrangement, Membership, ModuleKind, ProjectBook, ProjectDefinition, ProjectTab,
    ProjectTemplate, ProjectTemplateRef, RelationDirection, TabMount, TimelineLane, TimelinePin,
    TimelinePlacement, TimelineView, check_timeline_placement_in_lane, effective_timeline_lanes,
    effective_timeline_placements, is_entry_live, sort_timeline_pins,
};
use dr_model::{DocId, Origin, Timestamp};
use loro::{
    CommitOptions, ExportMode, Frontiers, LoroDoc, LoroValue, ValueOrContainer, VersionVector,
};

use crate::core::{Committed, Core, Imported, check_borrowed, configured};
use crate::error::{DocError, Result};
use crate::peer::{PeerId, genesis_peer};
use crate::prose::{EmbedKind, EmbedView, ProseTxn, ProseView, Run};
use crate::schema::{self, PROJECT_TEMPLATE_GENESIS_VERSION, PROJECT_TEMPLATE_SCHEMA_VERSION};
use crate::v3::read::BookViewV3;
use crate::v3::write::BookTxnV3;

// ---- `project-template:<id>` Loro document -------------------------------

/// Deterministic genesis of `project-template:<id>`: `meta.v = 1` and
/// `meta.doc = "project-template:<id>"` committed at timestamp 0.
pub fn genesis(id: &ProjectTemplateDocId) -> Vec<u8> {
    let doc_id = DocId::ProjectTemplate(id.clone()).to_string();
    let doc = configured();
    doc.set_peer_id(genesis_peer(&doc_id, PROJECT_TEMPLATE_GENESIS_VERSION))
        .expect("genesis peer");
    let meta = doc.get_map(schema::project_template::META);
    meta.insert(schema::meta::VERSION, PROJECT_TEMPLATE_SCHEMA_VERSION)
        .expect("meta version");
    meta.insert(schema::meta::DOC, doc_id.as_str())
        .expect("meta doc");
    doc.commit_with(CommitOptions::new().timestamp(0));
    doc.export(ExportMode::all_updates())
        .expect("export project-template genesis")
}

/// Metadata stored in the `info` root map of `project-template:<id>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectTemplateInfo {
    pub name: String,
    pub description: String,
    pub origin: StoredTemplateOrigin,
    pub revision: i64,
    pub created_at: Option<Timestamp>,
    pub updated_at: Option<Timestamp>,
}

fn check_identity(doc: &LoroDoc, id: &ProjectTemplateDocId) -> Result<()> {
    let doc_id = DocId::ProjectTemplate(id.clone());
    check_borrowed(doc, &doc_id, schema::meta::DOC)?;
    match doc
        .get_map(schema::project_template::META)
        .get(schema::meta::VERSION)
    {
        Some(ValueOrContainer::Value(LoroValue::I64(v)))
            if v == PROJECT_TEMPLATE_SCHEMA_VERSION =>
        {
            Ok(())
        }
        Some(ValueOrContainer::Value(LoroValue::Double(v)))
            if v == PROJECT_TEMPLATE_SCHEMA_VERSION as f64 =>
        {
            Ok(())
        }
        _ => Err(DocError::NotInProfile(
            "unsupported project-template schema version",
        )),
    }
}

/// Validate an incoming Loro update's `meta` header (when present) and merged
/// `payload.value` (when present) before importing into `project-template:<id>`.
pub fn validate_import(
    id: &ProjectTemplateDocId,
    current: &LoroDoc,
    bytes: &[u8],
) -> std::result::Result<(), String> {
    let incoming = configured();
    incoming.import(bytes).map_err(|e| e.to_string())?;
    let meta = incoming.get_map(schema::project_template::META);
    if let Some(version) = meta.get(schema::meta::VERSION) {
        let valid = match version {
            ValueOrContainer::Value(LoroValue::I64(v)) => v == PROJECT_TEMPLATE_SCHEMA_VERSION,
            ValueOrContainer::Value(LoroValue::Double(v)) => {
                v == PROJECT_TEMPLATE_SCHEMA_VERSION as f64
            }
            _ => false,
        };
        if !valid {
            return Err("unsupported project-template schema version".into());
        }
    }
    let want_doc = DocId::ProjectTemplate(id.clone()).to_string();
    if let Some(doc_val) = meta.get(schema::meta::DOC)
        && !matches!(doc_val, ValueOrContainer::Value(LoroValue::String(ref s)) if s.as_str() == want_doc)
    {
        return Err("project-template identity mismatch".into());
    }

    let merged = configured();
    merged
        .import(
            &current
                .export(ExportMode::Snapshot)
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    if let Some(waiting) = current
        .export_pending_updates()
        .map_err(|e| e.to_string())?
    {
        merged.import(&waiting).map_err(|e| e.to_string())?;
    }
    merged.import(bytes).map_err(|e| e.to_string())?;
    if let Some(raw) = (ProjectTemplateView { doc: &merged }).raw_payload() {
        parse_project_template_json(raw.as_str()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Read-only view of a `project-template:<id>` Loro document.
#[derive(Clone, Copy)]
pub struct ProjectTemplateView<'a> {
    doc: &'a LoroDoc,
}

impl ProjectTemplateView<'_> {
    /// Read `info` metadata (`None` if the document only has genesis and no saved info yet).
    pub fn info(&self) -> Option<ProjectTemplateInfo> {
        let m = match self.record() {
            Some((info, _)) => info,
            None => match self
                .doc
                .get_map(schema::project_template::INFO)
                .get_deep_value()
            {
                LoroValue::Map(m) => m,
                _ => return None,
            },
        };
        let name = match m.get("name") {
            Some(LoroValue::String(s)) if !s.trim().is_empty() => s.to_string(),
            _ => return None,
        };
        let description = match m.get("description") {
            Some(LoroValue::String(s)) => s.to_string(),
            _ => String::new(),
        };
        let origin = match m.get("origin") {
            Some(LoroValue::String(s)) => StoredTemplateOrigin::parse(s)?,
            _ => StoredTemplateOrigin::Own,
        };
        let revision = match m.get("revision") {
            Some(LoroValue::I64(v)) if *v >= 1 => *v,
            _ => 1,
        };
        let ts = |key: &str| match m.get(key) {
            Some(LoroValue::I64(ms)) => Some(Timestamp(*ms)),
            _ => None,
        };
        Some(ProjectTemplateInfo {
            name,
            description,
            origin,
            revision,
            created_at: ts("created_at"),
            updated_at: ts("updated_at"),
        })
    }

    /// Raw canonical JSON string stored in `payload.value`.
    pub fn raw_payload(&self) -> Option<String> {
        if let Some((_, value)) = self.record() {
            return Some(value);
        }
        match self
            .doc
            .get_map(schema::project_template::PAYLOAD)
            .get(schema::project_template::VALUE)
        {
            Some(ValueOrContainer::Value(LoroValue::String(s))) => Some(s.to_string()),
            _ => None,
        }
    }

    /// `payload.record`: `info` and the canonical value saved as one value
    /// (`None` for a document saved before it, which keeps `info` and
    /// `payload.value` apart).
    fn record(&self) -> Option<(loro::LoroMapValue, String)> {
        let Some(ValueOrContainer::Value(LoroValue::Map(record))) = self
            .doc
            .get_map(schema::project_template::PAYLOAD)
            .get(schema::project_template::RECORD)
        else {
            return None;
        };
        let info = match record.get(schema::project_template::RECORD_INFO) {
            Some(LoroValue::Map(info)) => info.clone(),
            _ => return None,
        };
        let value = match record.get(schema::project_template::VALUE) {
            Some(LoroValue::String(value)) => value.to_string(),
            _ => return None,
        };
        Some((info, value))
    }

    /// Parse and validate `payload.value`, overlaying `info.name`, `info.description`
    /// and `info.revision` so `info`-only renames are reflected immediately.
    pub fn value(&self) -> std::result::Result<ProjectTemplateValue, ProjectTemplateError> {
        let raw = self.raw_payload().ok_or_else(|| {
            ProjectTemplateError::Invalid("missing project-template payload".into())
        })?;
        let mut val = parse_project_template_json(&raw)?;
        if let Some(info) = self.info() {
            val.name = info.name;
            val.description = info.description;
            val.revision = info.revision;
            validate_project_template_value(&val)?;
        }
        Ok(val)
    }
}

/// Write transaction on a `project-template:<id>` document. Does not commit.
pub struct ProjectTemplateTxn<'a> {
    doc: &'a LoroDoc,
}

impl<'a> ProjectTemplateTxn<'a> {
    pub fn view(&self) -> ProjectTemplateView<'a> {
        ProjectTemplateView { doc: self.doc }
    }

    /// Write `info` and atomically replace `payload.value` as one whole canonical
    /// JSON LWW register (`project-templates.md` §5: "整个换，不合并").
    pub fn save(
        &mut self,
        info: &ProjectTemplateInfo,
        value: &ProjectTemplateValue,
    ) -> std::result::Result<(), ProjectTemplateError> {
        let mut normalized = value.clone();
        normalized.name = info.name.trim().to_owned();
        normalized.description = info.description.clone();
        normalized.revision = info.revision;
        validate_project_template_value(&normalized)?;
        let json = to_canonical_json(&normalized)?;

        let mut info_value: std::collections::HashMap<String, LoroValue> = [
            ("name", LoroValue::from(normalized.name.as_str())),
            (
                "description",
                LoroValue::from(normalized.description.as_str()),
            ),
            ("origin", LoroValue::from(info.origin.as_str())),
            ("revision", LoroValue::from(info.revision)),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
        if let Some(created_at) = info.created_at {
            info_value.insert("created_at".into(), LoroValue::from(created_at.0));
        }
        if let Some(updated_at) = info.updated_at {
            info_value.insert("updated_at".into(), LoroValue::from(updated_at.0));
        }
        self.write_record(info_value, json)
            .map_err(|e| ProjectTemplateError::Invalid(e.to_string()))?;
        Ok(())
    }

    /// Update `name` and/or `description` in `info` only, leaving `payload` untouched
    /// (`project-templates.md` §5: "改名只动 `info`").
    pub fn update_info(
        &mut self,
        name: Option<&str>,
        description: Option<&str>,
        updated_at: Timestamp,
    ) -> Result<()> {
        // A rename writes the whole record again, so a rename and a save on
        // two devices at once keep one whole record, not one's name over the
        // other's content.
        let view = self.view();
        let (Some(current), Some(value)) = (view.info(), view.raw_payload()) else {
            return Err(crate::DocError::NotInProfile(
                "a project template is renamed only once it is saved",
            ));
        };
        let mut info: std::collections::HashMap<String, LoroValue> = [
            (
                "name",
                LoroValue::from(name.map(str::trim).unwrap_or(&current.name)),
            ),
            (
                "description",
                LoroValue::from(description.unwrap_or(&current.description)),
            ),
            ("origin", LoroValue::from(current.origin.as_str())),
            ("revision", LoroValue::from(current.revision)),
            ("updated_at", LoroValue::from(updated_at.0)),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
        if let Some(created_at) = current.created_at {
            info.insert("created_at".into(), LoroValue::from(created_at.0));
        }
        self.write_record(info, value)
    }

    /// Writes `payload.record` as one value: the last record written wins
    /// whole when two devices write at once.
    fn write_record(
        &mut self,
        info: std::collections::HashMap<String, LoroValue>,
        value: String,
    ) -> Result<()> {
        let record: std::collections::HashMap<String, LoroValue> = [
            (
                schema::project_template::RECORD_INFO.to_owned(),
                LoroValue::from(info),
            ),
            (
                schema::project_template::VALUE.to_owned(),
                LoroValue::from(value),
            ),
        ]
        .into_iter()
        .collect();
        self.doc
            .get_map(schema::project_template::PAYLOAD)
            .insert(schema::project_template::RECORD, LoroValue::from(record))?;
        Ok(())
    }
}

/// Borrowed wrapper over a store-held `LoroDoc` for `project-template:<id>`.
pub struct BorrowedProjectTemplate<'a> {
    doc: &'a LoroDoc,
}

impl<'a> BorrowedProjectTemplate<'a> {
    pub fn new(doc: &'a LoroDoc, id: &ProjectTemplateDocId) -> Result<Self> {
        check_identity(doc, id)?;
        Ok(Self { doc })
    }

    pub fn view(&self) -> ProjectTemplateView<'_> {
        ProjectTemplateView { doc: self.doc }
    }

    pub fn txn(&self) -> ProjectTemplateTxn<'_> {
        ProjectTemplateTxn { doc: self.doc }
    }
}

/// Standalone writer for a `project-template:<id>` Loro document.
pub struct ProjectTemplateDoc {
    core: Core,
    id: ProjectTemplateDocId,
}

impl ProjectTemplateDoc {
    pub fn create(id: ProjectTemplateDocId, peer: PeerId) -> Result<Self> {
        Self::load(id, peer, &[])
    }

    pub fn load(id: ProjectTemplateDocId, peer: PeerId, blobs: &[Vec<u8>]) -> Result<Self> {
        let doc_id = DocId::ProjectTemplate(id.clone());
        let core = Core::load(doc_id, &genesis(&id), blobs, Some(peer), schema::meta::DOC)?;
        check_identity(&core.doc, &id)?;
        Ok(Self { core, id })
    }

    pub fn id(&self) -> &ProjectTemplateDocId {
        &self.id
    }

    pub fn doc_id(&self) -> &DocId {
        &self.core.id
    }

    pub fn view(&self) -> ProjectTemplateView<'_> {
        ProjectTemplateView {
            doc: &self.core.doc,
        }
    }

    pub fn edit<R>(
        &mut self,
        origin: Origin,
        f: impl FnOnce(&mut ProjectTemplateTxn<'_>) -> Result<R>,
    ) -> (Result<R>, Option<Committed>) {
        let core = &self.core;
        core.transact(&origin, None, || {
            let mut txn = ProjectTemplateTxn { doc: &core.doc };
            f(&mut txn)
        })
    }

    pub fn import(&mut self, bytes: &[u8], origin: Origin) -> Result<Imported> {
        validate_import(&self.id, &self.core.doc, bytes)
            .map_err(|_| DocError::NotInProfile("invalid project-template update"))?;
        let pending = self.core.import(bytes, &origin)?;
        Ok(Imported {
            pending,
            repair: None,
        })
    }

    pub fn version(&self) -> VersionVector {
        self.core.version()
    }

    pub fn frontiers(&self) -> Frontiers {
        self.core.frontiers()
    }

    pub fn export_updates_since(&self, vv: &VersionVector) -> Result<Vec<u8>> {
        self.core.export_updates_since(vv)
    }

    pub fn export_snapshot(&self) -> Result<Vec<u8>> {
        self.core.export_snapshot()
    }
}

// ---- Prose <-> `Vec<TemplateParagraph>` round-trip -----------------------

/// Whether `paragraphs` has any authored content beyond the single empty plain
/// paragraph that `prose::genesis` starts with.
pub fn has_authored_paragraphs(paragraphs: &[TemplateParagraph]) -> bool {
    match paragraphs {
        [] => false,
        [only] => !only.attrs.is_plain() || !only.runs.is_empty() || only.table.is_some(),
        _ => true,
    }
}

/// Extract current-state paragraphs from `view`, rewriting inline entry links
/// targeting `entry_refs` into symbolic `e…` codes, degrading inline links to
/// non-included entries or assets into plain text (preserving styles), and
/// omitting `EmbedView::Asset` file-embed paragraphs.
pub fn extract_prose_paragraphs(
    view: &ProseView<'_>,
    entry_refs: &BTreeMap<EntryId, String>,
    live_templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    live_entries: &BTreeMap<EntryId, Entry>,
) -> std::result::Result<Vec<TemplateParagraph>, ProjectTemplateError> {
    let body_links = view.entity_links_v3();
    let mut out = Vec::new();
    for p in view.paragraphs() {
        if let Some(embed_id) = p.embed() {
            match view.embed(embed_id) {
                Some(EmbedView::Table { cols, rows, .. }) => {
                    if cols.is_empty() || rows.is_empty() {
                        continue;
                    }
                    let mut table_rows = Vec::with_capacity(rows.len());
                    for row in &rows {
                        let mut cell_vec = Vec::with_capacity(cols.len());
                        for col in &cols {
                            let runs = view
                                .table_cell(embed_id, &row.id, &col.id)
                                .unwrap_or_default();
                            let links = view
                                .table_cell_entity_links_v3(embed_id, &row.id, &col.id)
                                .unwrap_or_default();
                            cell_vec.push(slice_runs_with_links(
                                &runs,
                                0,
                                &links,
                                entry_refs,
                                live_templates,
                                live_entries,
                            ));
                        }
                        table_rows.push(cell_vec);
                    }
                    out.push(TemplateParagraph {
                        attrs: TemplateBlockAttrs::default(),
                        runs: Vec::new(),
                        table: Some(TemplateTable {
                            cols: cols.len() as u32,
                            rows: table_rows,
                        }),
                    });
                }
                // Phase 1 strips file embeds (`EmbedView::Asset`) and unknown embeds.
                Some(EmbedView::Asset { .. } | EmbedView::Other { .. }) | None => continue,
            }
            continue;
        }

        let attrs = TemplateBlockAttrs::from_block_attrs(&p.attrs)
            .map_err(ProjectTemplateError::Invalid)?;
        let runs = slice_runs_with_links(
            &p.runs,
            p.range.start,
            &body_links,
            entry_refs,
            live_templates,
            live_entries,
        );
        out.push(TemplateParagraph {
            attrs,
            runs,
            table: None,
        });
    }
    Ok(out)
}

fn rewrite_inline_link(
    link: &EntityLinkV3,
    entry_refs: &BTreeMap<EntryId, String>,
    live_templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    live_entries: &BTreeMap<EntryId, Entry>,
) -> Option<TemplateEntityLink> {
    if link.kind != EntityKind::Entry {
        return None;
    }
    let eid = EntryId::parse(&link.target).ok()?;
    let sym = entry_refs.get(&eid)?.clone();
    let module = link.module.as_ref().and_then(|mid| {
        let entry = live_entries.get(&eid)?;
        let tid = entry.template.as_ref()?;
        let tpl = live_templates.get(tid)?;
        let mspec = tpl.module(mid)?;
        (mspec.kind == ModuleKind::Prose).then(|| mid.to_string())
    });
    Some(TemplateEntityLink {
        entry: sym,
        module,
        manual: link.manual,
    })
}

fn slice_runs_with_links(
    runs: &[Run],
    base_offset: usize,
    raw_links: &[(Range<usize>, EntityLinkV3)],
    entry_refs: &BTreeMap<EntryId, String>,
    live_templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    live_entries: &BTreeMap<EntryId, Entry>,
) -> Vec<TemplateRun> {
    let full_text: String = runs.iter().map(|r| r.text.as_str()).collect();
    let chars: Vec<char> = full_text.chars().collect();
    let total_len = chars.len();
    if total_len == 0 {
        return Vec::new();
    }

    let mut boundaries = BTreeSet::from([0usize, total_len]);
    let mut run_spans: Vec<(Range<usize>, &InlineMarks)> = Vec::with_capacity(runs.len());
    let mut cursor = 0usize;
    for r in runs {
        let len = r.text.chars().count();
        if len > 0 {
            let end = cursor + len;
            boundaries.insert(cursor);
            boundaries.insert(end);
            run_spans.push((cursor..end, &r.marks));
            cursor = end;
        }
    }

    let mut kept_links: Vec<(Range<usize>, TemplateEntityLink)> = Vec::new();
    let global_end = base_offset + total_len;
    for (range, link) in raw_links {
        let start = range.start.max(base_offset);
        let end = range.end.min(global_end);
        if start >= end {
            continue;
        }
        if let Some(rewritten) = rewrite_inline_link(link, entry_refs, live_templates, live_entries)
        {
            let local = (start - base_offset)..(end - base_offset);
            boundaries.insert(local.start);
            boundaries.insert(local.end);
            kept_links.push((local, rewritten));
        }
    }

    let pts: Vec<usize> = boundaries.into_iter().collect();
    let mut out: Vec<TemplateRun> = Vec::new();
    for pair in pts.windows(2) {
        let (seg_start, seg_end) = (pair[0], pair[1]);
        if seg_start >= seg_end {
            continue;
        }
        let seg_text: String = chars[seg_start..seg_end]
            .iter()
            .copied()
            .filter(|&c| c == '\t' || !c.is_control())
            .collect();
        if seg_text.is_empty() {
            continue;
        }
        let marks = run_spans
            .iter()
            .find(|(r, _)| r.start <= seg_start && seg_end <= r.end)
            .map(|(_, m)| *m);
        let mut entities: BTreeSet<TemplateEntityLink> = BTreeSet::new();
        for (lr, tl) in &kept_links {
            if lr.start <= seg_start && seg_end <= lr.end {
                entities.insert(tl.clone());
            }
        }
        // Keep at most one link per target entry on a single run (`validate_runs`).
        let mut dedup_entities: Vec<TemplateEntityLink> = Vec::new();
        for el in entities {
            if !dedup_entities
                .iter()
                .any(|existing| existing.entry == el.entry)
            {
                dedup_entities.push(el);
            }
        }
        let tr = TemplateRun {
            text: seg_text,
            bold: marks.is_some_and(|m| m.bold),
            italic: marks.is_some_and(|m| m.italic),
            underline: marks.is_some_and(|m| m.underline),
            strike: marks.is_some_and(|m| m.strike),
            code: marks.is_some_and(|m| m.code),
            link: marks.and_then(|m| m.link.clone()),
            highlight: marks.and_then(|m| m.highlight.clone()),
            entities: dedup_entities,
        };
        if let Some(last) = out.last_mut()
            && last.same_marks(&tr)
        {
            last.text.push_str(&tr.text);
        } else {
            out.push(tr);
        }
    }
    out
}

fn styles_for_template_run(r: &TemplateRun) -> Vec<InlineStyle> {
    let mut out = Vec::new();
    if r.bold {
        out.push(InlineStyle::Bold);
    }
    if r.italic {
        out.push(InlineStyle::Italic);
    }
    if r.underline {
        out.push(InlineStyle::Underline);
    }
    if r.strike {
        out.push(InlineStyle::Strike);
    }
    if r.code {
        out.push(InlineStyle::Code);
    }
    if let Some(url) = &r.link {
        out.push(InlineStyle::Link(url.clone()));
    }
    if let Some(hl) = &r.highlight {
        out.push(InlineStyle::Highlight(hl.clone()));
    }
    out
}

type MaterializedRuns = (Vec<Run>, Vec<(Range<usize>, EntityLinkV3)>);

fn to_prose_runs_and_links(
    runs: &[TemplateRun],
    entry_map: &BTreeMap<String, EntryId>,
) -> Result<MaterializedRuns> {
    let mut prose_runs = Vec::with_capacity(runs.len());
    let mut links = Vec::new();
    let mut at = 0usize;
    for r in runs {
        let len = r.text.chars().count();
        let range = at..at + len;
        at = range.end;
        prose_runs.push(Run {
            text: r.text.clone(),
            marks: InlineMarks {
                bold: r.bold,
                italic: r.italic,
                underline: r.underline,
                strike: r.strike,
                code: r.code,
                link: r.link.clone(),
                highlight: r.highlight.clone(),
                entities: Vec::new(),
                embed: None,
            },
        });
        for el in &r.entities {
            let target = entry_map.get(&el.entry).ok_or(DocError::NotInProfile(
                "unknown symbolic entry ref in prose link",
            ))?;
            let module = el
                .module
                .as_deref()
                .map(ModuleId::parse)
                .transpose()
                .map_err(|_| DocError::NotInProfile("invalid module id in prose link"))?;
            links.push((
                range.clone(),
                EntityLinkV3 {
                    target: target.to_string(),
                    kind: EntityKind::Entry,
                    module,
                    block: None,
                    end_block: None,
                    manual: el.manual,
                },
            ));
        }
    }
    Ok((prose_runs, links))
}

/// Write `paragraphs` into a fresh (genesis) [`ProseTxn`], mapping symbolic
/// entry refs (`e1`, `e2`, …) to the new project's [`EntryId`]s.
pub fn write_prose_paragraphs(
    txn: &mut ProseTxn<'_>,
    paragraphs: &[TemplateParagraph],
    entry_map: &BTreeMap<String, EntryId>,
) -> Result<()> {
    if paragraphs.is_empty() {
        return Ok(());
    }
    let target = txn.view().paragraph_at(0)?;
    let replace_last = target.range.is_empty();
    let mut caret = 0usize;
    for (i, p) in paragraphs.iter().enumerate() {
        if let Some(table) = &p.table {
            let embed_id = EmbedId::new_v7();
            let col_ids: Vec<String> = (0..table.cols).map(|c| format!("c{}", c + 1)).collect();
            let row_ids: Vec<String> = (0..table.rows.len())
                .map(|r| format!("r{}", r + 1))
                .collect();
            {
                let writer = txn.insert_embed(caret, &embed_id, &EmbedKind::Table)?;
                let mut cpos = PosKey::first();
                for (ci, cid) in col_ids.iter().enumerate() {
                    if ci > 0 {
                        cpos = cpos.after();
                    }
                    writer.add_col(cid, &cpos)?;
                }
                let mut rpos = PosKey::first();
                for (ri, rid) in row_ids.iter().enumerate() {
                    if ri > 0 {
                        rpos = rpos.after();
                    }
                    writer.add_row(rid, &rpos)?;
                }
            }
            for (ri, row_cells) in table.rows.iter().enumerate() {
                for (ci, cell_runs) in row_cells.iter().enumerate() {
                    if cell_runs.is_empty() {
                        continue;
                    }
                    let (runs, links) = to_prose_runs_and_links(cell_runs, entry_map)?;
                    txn.set_table_cell_runs_v3(
                        &embed_id,
                        &row_ids[ri],
                        &col_ids[ci],
                        &runs,
                        &links,
                    )?;
                }
            }
            caret += 2;
            continue;
        }

        let start = caret;
        let full_text: String = p.runs.iter().map(|r| r.text.as_str()).collect();
        txn.insert_text(start, &full_text)?;
        let mut at = start;
        for r in &p.runs {
            let n = r.text.chars().count();
            let range = at..at + n;
            at = range.end;
            if range.is_empty() {
                continue;
            }
            for style in styles_for_template_run(r) {
                txn.set_style(range.clone(), &style)?;
            }
            for el in &r.entities {
                let target_id = entry_map.get(&el.entry).ok_or(DocError::NotInProfile(
                    "unknown symbolic entry ref in prose link",
                ))?;
                let module = el
                    .module
                    .as_deref()
                    .map(ModuleId::parse)
                    .transpose()
                    .map_err(|_| DocError::NotInProfile("invalid module id in prose link"))?;
                txn.link_entity_v3(
                    range.clone(),
                    &EntityLinkV3 {
                        target: target_id.to_string(),
                        kind: EntityKind::Entry,
                        module,
                        block: None,
                        end_block: None,
                        manual: el.manual,
                    },
                )?;
            }
        }
        caret = start + full_text.chars().count();
        if !(replace_last && i + 1 == paragraphs.len()) {
            caret = txn.split(caret)?;
        }
        let block_attrs = p
            .attrs
            .to_block_attrs()
            .map_err(|_| DocError::NotInProfile("invalid template paragraph block attrs"))?;
        txn.set_block_attrs(start, &block_attrs)?;
    }
    Ok(())
}

// ---- Project -> `ProjectTemplateValue` extraction ("另存") ----------------

/// Metadata options when extracting a [`ProjectTemplateValue`] from a book.
#[derive(Clone, Debug)]
pub struct ExtractTemplateMeta {
    pub name: String,
    pub description: String,
    pub locale: String,
    pub made_with: String,
    pub revision: i64,
    pub credit: Option<ProjectTemplateCredit>,
}

impl Default for ExtractTemplateMeta {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: String::new(),
            locale: String::new(),
            made_with: String::new(),
            revision: 1,
            credit: None,
        }
    }
}

/// Author selection for `project_template.save` (`project-templates.md` §2 & §7):
/// - Skeleton entries (`has_below`) are included by default; `exclude_skeleton`
///   deselects any unlocked skeleton entry (forced targets of `tabs[].mount`
///   and `home` cannot be deselected).
/// - `sample_entries` selects entries whose content (`fields`, `kv`, `arrangements`,
///   `prose`, `memberships`, `placements`) is carried as sample content.
/// - `view_pins` selects views whose time pins are carried.
#[derive(Clone, Debug, Default)]
pub struct ExtractSelection {
    pub exclude_skeleton: BTreeSet<EntryId>,
    pub sample_entries: BTreeSet<EntryId>,
    pub view_pins: BTreeSet<TimelineViewId>,
}

/// Compute the live entries in `book_view` that are forced-included as skeleton
/// targets (`project.tabs[].mount`, live `templates[].settings.home`, and
/// included entries' `overrides.home`), returning `entry_id -> reason`.
pub fn forced_skeleton_entries(book_view: &BookViewV3<'_>) -> BTreeMap<EntryId, &'static str> {
    let templates = book_view.templates_map();
    let live_templates: BTreeMap<EntryTemplateId, EntryTemplate> = templates
        .into_iter()
        .filter(|(_, t)| !t.is_trashed())
        .collect();
    let entries_map = book_view.entries_map();
    let proj = book_view.project();

    let mut forced: BTreeMap<EntryId, &'static str> = BTreeMap::new();
    for tab in &proj.tabs {
        if let TabMount::Entry { entry } = &tab.mount
            && is_entry_live(entry, &entries_map)
            && entries_map[entry].has_below(&live_templates)
        {
            forced.entry(entry.clone()).or_insert("project.tabs.mount");
        }
    }

    for tpl in live_templates.values() {
        if let Some(Some(home_id)) = &tpl.settings.home
            && is_entry_live(home_id, &entries_map)
            && entries_map[home_id].is_level()
        {
            forced
                .entry(home_id.clone())
                .or_insert("template.settings.home");
        }
    }

    forced
}

/// Extract a [`ProjectTemplateValue`] from a fixed [`BookViewV3`] snapshot and
/// a prose-document reader callback (`read_prose(doc_id, entry_refs, live_templates, live_entries)`).
pub fn extract_project_template<F>(
    book_view: &BookViewV3<'_>,
    meta: &ExtractTemplateMeta,
    selection: &ExtractSelection,
    mut read_prose: F,
) -> std::result::Result<ProjectTemplateValue, ProjectTemplateError>
where
    F: FnMut(
        &DocId,
        &BTreeMap<EntryId, String>,
        &BTreeMap<EntryTemplateId, EntryTemplate>,
        &BTreeMap<EntryId, Entry>,
    ) -> std::result::Result<Option<Vec<TemplateParagraph>>, ProjectTemplateError>,
{
    let live_templates: BTreeMap<EntryTemplateId, EntryTemplate> = book_view
        .templates()
        .into_iter()
        .filter(|t| !t.is_trashed())
        .map(|t| (t.id.clone(), t))
        .collect();
    let all_entries_ordered: Vec<Entry> = book_view.entries_raw();
    let entries_map: BTreeMap<EntryId, Entry> = all_entries_ordered
        .iter()
        .map(|e| (e.id.clone(), e.clone()))
        .collect();
    let live_entries_map: BTreeMap<EntryId, Entry> = all_entries_ordered
        .iter()
        .filter(|e| is_entry_live(&e.id, &entries_map))
        .map(|e| (e.id.clone(), e.clone()))
        .collect();
    let live_views: Vec<TimelineView> = book_view.timeline_views();

    // Check forced skeleton entries (`tabs[].mount`, `templates[].settings.home`).
    let mut forced = forced_skeleton_entries(book_view);
    for (eid, why) in &forced {
        if selection.exclude_skeleton.contains(eid) {
            return Err(ProjectTemplateError::Invalid(format!(
                "cannot exclude entry {eid} because it is referenced by {why}"
            )));
        }
    }

    // Validate `sample_entries`: every explicitly checked sample entry must exist and be live.
    for eid in &selection.sample_entries {
        if !live_entries_map.contains_key(eid) {
            return Err(ProjectTemplateError::Invalid(format!(
                "selected sample entry {eid} does not exist or is in trash"
            )));
        }
    }

    // Helper: whether an entry has an excluded skeleton ancestor.
    let has_excluded_ancestor = |eid: &EntryId| -> bool {
        let mut cur = entries_map.get(eid).and_then(|e| e.parent.clone());
        let mut seen = BTreeSet::new();
        while let Some(pid) = cur {
            if !seen.insert(pid.clone()) {
                break;
            }
            if selection.exclude_skeleton.contains(&pid) {
                return true;
            }
            cur = entries_map.get(&pid).and_then(|e| e.parent.clone());
        }
        false
    };

    // Determine included entries, propagating `overrides.home` forced targets to a fixed point.
    let mut included_set: BTreeSet<EntryId> = BTreeSet::new();
    for e in &all_entries_ordered {
        if !live_entries_map.contains_key(&e.id) {
            continue;
        }
        let is_forced = forced.contains_key(&e.id);
        let is_sampled = selection.sample_entries.contains(&e.id);
        let is_default_skeleton = e.has_below(&live_templates)
            && !selection.exclude_skeleton.contains(&e.id)
            && !has_excluded_ancestor(&e.id);
        if is_forced || is_sampled || is_default_skeleton {
            included_set.insert(e.id.clone());
        }
    }

    loop {
        let mut added = false;
        let snapshot: Vec<EntryId> = included_set.iter().cloned().collect();
        for eid in snapshot {
            if let Some(Some(home_id)) = live_entries_map
                .get(&eid)
                .and_then(|e| e.overrides.as_ref())
                .and_then(|ov| ov.home.as_ref())
                && live_entries_map.get(home_id).is_some_and(Entry::is_level)
            {
                if selection.exclude_skeleton.contains(home_id) {
                    return Err(ProjectTemplateError::Invalid(format!(
                        "cannot exclude entry {home_id} because included entry {eid} sets overrides.home to it"
                    )));
                }
                forced
                    .entry(home_id.clone())
                    .or_insert("entry.overrides.home");
                if included_set.insert(home_id.clone()) {
                    added = true;
                }
            }
        }
        if !added {
            break;
        }
    }

    // Order included entries in tree preorder traversal (sibling order by `(position, id)`),
    // re-homing under the nearest included `level == true` ancestor when an intermediate
    // ancestor was excluded.
    let nearest_included_level_parent_id = |entry: &Entry| -> Option<EntryId> {
        let mut cur = entry.parent.clone();
        let mut seen = BTreeSet::new();
        while let Some(pid) = cur {
            if !seen.insert(pid.clone()) {
                break;
            }
            if included_set.contains(&pid)
                && live_entries_map.get(&pid).is_some_and(Entry::is_level)
            {
                return Some(pid);
            }
            cur = entries_map.get(&pid).and_then(|e| e.parent.clone());
        }
        None
    };

    let mut eff_parents: BTreeMap<EntryId, Option<EntryId>> = BTreeMap::new();
    let mut children_by_parent: BTreeMap<Option<EntryId>, Vec<&Entry>> = BTreeMap::new();
    for e in &all_entries_ordered {
        if !included_set.contains(&e.id) {
            continue;
        }
        let eff_p = nearest_included_level_parent_id(e);
        eff_parents.insert(e.id.clone(), eff_p.clone());
        children_by_parent.entry(eff_p).or_default().push(e);
    }
    for kids in children_by_parent.values_mut() {
        kids.sort_by(|a, b| {
            a.pos
                .as_str()
                .cmp(b.pos.as_str())
                .then_with(|| a.id.as_str().cmp(b.id.as_str()))
        });
    }
    let mut included_ordered: Vec<&Entry> = Vec::with_capacity(included_set.len());
    fn push_preorder<'a>(
        parent: Option<EntryId>,
        children_by_parent: &BTreeMap<Option<EntryId>, Vec<&'a Entry>>,
        visited: &mut BTreeSet<EntryId>,
        out: &mut Vec<&'a Entry>,
    ) {
        let Some(kids) = children_by_parent.get(&parent) else {
            return;
        };
        for &e in kids {
            if visited.insert(e.id.clone()) {
                out.push(e);
                push_preorder(Some(e.id.clone()), children_by_parent, visited, out);
            }
        }
    }
    let mut visited_preorder = BTreeSet::new();
    push_preorder(
        None,
        &children_by_parent,
        &mut visited_preorder,
        &mut included_ordered,
    );

    // Assign deterministic symbolic codes `e1..eN` (preorder) and `v1..vM` (view order).
    let mut entry_refs: BTreeMap<EntryId, String> = BTreeMap::new();
    for (idx, e) in included_ordered.iter().enumerate() {
        entry_refs.insert(e.id.clone(), format!("e{}", idx + 1));
    }
    let mut view_refs: BTreeMap<TimelineViewId, String> = BTreeMap::new();
    for (idx, v) in live_views.iter().enumerate() {
        view_refs.insert(v.id.clone(), format!("v{}", idx + 1));
    }

    let proj = book_view.project();

    // Credit: only what the caller gives (the author's name); nothing is
    // derived from `project.source` (no 「改自」 since 2026-11-15 night).
    let credit = meta.credit.clone().filter(|c| !c.is_empty());

    // 1. Extract `project` (`agent`, `book`, `tabs`).
    let has_book = proj.book.is_some();
    let tpl_book = proj.book.as_ref().map(|b| TemplateProjectBook {
        word_target: b.word_target_set,
        daily_word_target: b.daily_word_target_set,
    });

    let mut tpl_tabs = Vec::with_capacity(proj.tabs.len());
    for tab in &proj.tabs {
        let mount = match &tab.mount {
            TabMount::Root => Some(TemplateTabMount::Root),
            TabMount::Book => has_book.then_some(TemplateTabMount::Book),
            TabMount::Entry { entry } => entry_refs
                .get(entry)
                .filter(|_| {
                    live_entries_map
                        .get(entry)
                        .is_some_and(|e| e.has_below(&live_templates))
                })
                .map(|sym| TemplateTabMount::Entry { entry: sym.clone() }),
            // A Tab cannot mount a view (DV, 2026-11-16); one a project
            // stored from before is not carried into the template.
            TabMount::View { .. } => None,
        };
        // A tab whose target is not in the template is left out: a tab is
        // called by what it shows and is never remounted (`kernel-v5.md` §5).
        if let Some(mount) = mount {
            tpl_tabs.push(TemplateTab { mount });
        }
    }

    let template_project = TemplateProject {
        agent: proj.agent.as_ref().map(Into::into),
        book: tpl_book,
        tabs: tpl_tabs,
    };

    // 2. Extract live `templates` and `template_prose`.
    let mut tpl_list = Vec::with_capacity(live_templates.len());
    let mut template_prose = BTreeMap::new();
    let book_id = book_view.book_id();
    for tpl in live_templates.values() {
        tpl_list.push(extract_entry_template(
            tpl,
            &live_templates,
            &live_entries_map,
            &entry_refs,
        )?);
        for m in tpl.prose_modules() {
            let doc_id = DocId::Template(dr_model::id::TemplateId::for_entry_module(
                book_id, &tpl.id, &m.id,
            ));
            if let Some(paragraphs) =
                read_prose(&doc_id, &entry_refs, &live_templates, &live_entries_map)?
                && has_authored_paragraphs(&paragraphs)
            {
                template_prose.insert(format!("{}/{}", tpl.id, m.id), paragraphs);
            }
        }
    }

    // 3. Carry names, descriptions and directions, in stable name order.
    // Links outside the selection keep their saved characters only.
    let mut stored_relations = book_view.relation_types_raw();
    stored_relations.sort_by(|a, b| a.normalized_name.cmp(&b.normalized_name));
    let relation_types = stored_relations
        .into_iter()
        .map(|rt| TemplateRelationType {
            name: rt.name,
            description: rt
                .description
                .remap_links(|id| EntryId::parse(entry_refs.get(id)?).ok()),
            direction: rt.direction,
        })
        .collect();

    // 4. Extract `entries` (skeleton-only vs checked sample entries).
    let mut extracted_entries = Vec::with_capacity(included_ordered.len());
    for entry in &included_ordered {
        let sym_ref = entry_refs[&entry.id].clone();
        let parent = eff_parents
            .get(&entry.id)
            .and_then(|p| p.as_ref())
            .and_then(|pid| entry_refs.get(pid).cloned());
        let is_sampled = selection.sample_entries.contains(&entry.id);
        let active_tpl = entry
            .template
            .as_ref()
            .and_then(|tid| live_templates.get(tid));
        let template = active_tpl.map(|t| t.id.to_string());

        let overrides = entry
            .overrides
            .as_ref()
            .map(|ov| extract_level_settings(ov, &live_templates, &live_entries_map, &entry_refs))
            .transpose()?
            .filter(|ov| !ov.is_empty());

        let mut fields = BTreeMap::new();
        let mut kv = BTreeMap::new();
        let mut arrangements = BTreeMap::new();
        let mut prose = BTreeMap::new();

        if let Some(tpl) = active_tpl {
            for mspec in &tpl.modules {
                match mspec.kind {
                    ModuleKind::Fields => {
                        let Some(raw_fmap) = entry.fields.get(&mspec.id) else {
                            continue;
                        };
                        let mut out_fmap = BTreeMap::new();
                        for def in &mspec.config.defs {
                            let is_color =
                                mspec.config.color_field.as_deref() == Some(def.id.as_str());
                            if !is_sampled && !is_color {
                                continue;
                            }
                            let Some(val) = raw_fmap.get(&def.id) else {
                                continue;
                            };
                            if let Some(cleaned) = extract_field_value(
                                &def.field_type,
                                &def.options,
                                def.target_template
                                    .as_ref()
                                    .filter(|tt| live_templates.contains_key(*tt)),
                                val,
                                &live_entries_map,
                                &entry_refs,
                            ) {
                                out_fmap.insert(def.id.clone(), cleaned);
                            }
                        }
                        if !out_fmap.is_empty() {
                            fields.insert(mspec.id.to_string(), out_fmap);
                        }
                    }
                    ModuleKind::KeyValue if is_sampled => {
                        if let Some(rows) = entry.kv.get(&mspec.id) {
                            let out_rows: Vec<TemplateKvRow> = rows
                                .iter()
                                .filter(|r| !r.key.trim().is_empty())
                                .map(|r| TemplateKvRow {
                                    key: r.key.clone(),
                                    value: r.value.clone(),
                                })
                                .collect();
                            if !out_rows.is_empty() {
                                kv.insert(mspec.id.to_string(), out_rows);
                            }
                        }
                    }
                    ModuleKind::Media if is_sampled => {
                        if let Some(arr) = entry.arrangements.get(&mspec.id) {
                            let tarr = TemplateMediaArrangement::try_from(arr)
                                .map_err(ProjectTemplateError::Invalid)?;
                            arrangements.insert(mspec.id.to_string(), tarr);
                        }
                    }
                    ModuleKind::Prose if is_sampled => {
                        let doc_id = DocId::Body(dr_model::id::BodyDocId::new(
                            entry.id.clone(),
                            mspec.id.clone(),
                        ));
                        if let Some(paragraphs) =
                            read_prose(&doc_id, &entry_refs, &live_templates, &live_entries_map)?
                            && has_authored_paragraphs(&paragraphs)
                        {
                            prose.insert(mspec.id.to_string(), paragraphs);
                        }
                    }
                    _ => {}
                }
            }
        }

        extracted_entries.push(TemplateEntry {
            sym_ref,
            parent,
            title: entry.title.clone(),
            template,
            level: entry.level,
            overrides,
            mark: entry.mark.clone(),
            fields,
            kv,
            arrangements,
            prose,
        });
    }

    // Build filtered domain entries & memberships to filter view placements accurately.
    let included_entries_map: BTreeMap<EntryId, Entry> = included_ordered
        .iter()
        .map(|e| {
            let mut copy = (*e).clone();
            copy.parent = eff_parents.get(&e.id).cloned().flatten();
            (copy.id.clone(), copy)
        })
        .collect();

    // 5. Extract `memberships` (`project-templates.md` §3: kept whenever both ends are included).
    let all_memberships = book_view.memberships();
    let mut kept_domain_memberships = Vec::new();
    let mut extracted_memberships = Vec::new();
    for m in &all_memberships {
        let (Some(host_sym), Some(member_sym)) =
            (entry_refs.get(&m.host), entry_refs.get(&m.member))
        else {
            continue;
        };
        if !included_entries_map[&m.host].accepts_members(&live_templates) {
            continue;
        }
        let is_primary = live_entries_map
            .get(&m.member)
            .and_then(|e| e.primary.as_ref())
            == Some(&m.host);
        kept_domain_memberships.push(m.clone());
        extracted_memberships.push(TemplateMembership {
            host: host_sym.clone(),
            member: member_sym.clone(),
            primary: is_primary,
        });
    }

    // 6. Extract `views` (`lanes`, `placements`, `pins`).
    let mut extracted_views = Vec::with_capacity(live_views.len());
    for v in &live_views {
        let sym_ref = view_refs[&v.id].clone();
        let eff_lanes = effective_timeline_lanes(&v.lanes, &included_entries_map, &live_templates);
        let lanes: Vec<TemplateViewLane> = eff_lanes
            .iter()
            .filter_map(|l| {
                entry_refs.get(&l.entry).map(|esym| TemplateViewLane {
                    entry: esym.clone(),
                    act_track: l.act_track,
                })
            })
            .collect();

        let filtered_view_for_check = TimelineView {
            id: v.id.clone(),
            name: v.name.clone(),
            pos: v.pos.clone(),
            lanes: eff_lanes,
            placements: Vec::new(),
            pins: Vec::new(),
            deleted_at: None,
        };

        let eff_placements = effective_timeline_placements(
            v,
            &kept_domain_memberships,
            &included_entries_map,
            &live_templates,
        );
        let mut placements = Vec::new();
        for p in eff_placements {
            if check_timeline_placement_in_lane(
                &filtered_view_for_check,
                &p.entry,
                &kept_domain_memberships,
                &included_entries_map,
                &live_templates,
            )
            .is_ok()
                && let Some(esym) = entry_refs.get(&p.entry)
            {
                placements.push(TemplateViewPlacement {
                    entry: esym.clone(),
                    at: p.at,
                    span: p.span,
                });
            }
        }

        let mut pins = Vec::new();
        if selection.view_pins.contains(&v.id) {
            let mut sorted_pins = v.pins.clone();
            sort_timeline_pins(&mut sorted_pins);
            for pin in sorted_pins {
                if !pin.at.is_finite() || pin.label.trim().is_empty() {
                    continue;
                }
                let entry_sym = match &pin.entry {
                    None => None,
                    Some(eid) => match entry_refs.get(eid) {
                        Some(sym) => Some(sym.clone()),
                        // Bound entry was not included -> drop this pin (`project-templates.md` §3).
                        None => continue,
                    },
                };
                pins.push(TemplateViewPin {
                    at: pin.at,
                    label: pin.label,
                    color: pin.color,
                    entry: entry_sym,
                });
            }
        }

        extracted_views.push(TemplateView {
            sym_ref,
            name: v.name.clone(),
            lanes,
            placements,
            pins,
        });
    }

    let out = ProjectTemplateValue {
        format: PROJECT_TEMPLATE_FORMAT.into(),
        format_version: PROJECT_TEMPLATE_FORMAT_VERSION,
        made_with: meta.made_with.clone(),
        name: meta.name.trim().to_owned(),
        description: meta.description.clone(),
        locale: meta.locale.clone(),
        revision: meta.revision,
        credit,
        project: template_project,
        templates: tpl_list,
        relation_types,
        entries: extracted_entries,
        memberships: extracted_memberships,
        views: extracted_views,
        template_prose,
    };

    validate_project_template_value(&out)?;
    Ok(out)
}

fn extract_level_settings(
    s: &LevelSettingsOverride,
    live_templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    live_entries: &BTreeMap<EntryId, Entry>,
    entry_refs: &BTreeMap<EntryId, String>,
) -> std::result::Result<TemplateLevelSettings, ProjectTemplateError> {
    let default_template = match &s.default_template {
        None => None,
        Some(None) => Some(None),
        Some(Some(tid)) => {
            if live_templates.contains_key(tid) {
                Some(Some(tid.to_string()))
            } else {
                None
            }
        }
    };
    let display = s
        .display
        .as_ref()
        .map(TemplateDisplayMode::try_from)
        .transpose()
        .map_err(ProjectTemplateError::Invalid)?;
    let format_shortcuts = s
        .format_shortcuts
        .as_ref()
        .map(TemplateFormatShortcuts::try_from)
        .transpose()
        .map_err(ProjectTemplateError::Invalid)?;
    let home = match &s.home {
        None => None,
        Some(None) => Some(None),
        Some(Some(hid)) => {
            if live_entries.get(hid).is_some_and(Entry::is_level)
                && let Some(sym) = entry_refs.get(hid)
            {
                Some(Some(sym.clone()))
            } else {
                None
            }
        }
    };
    Ok(TemplateLevelSettings {
        default_template,
        display,
        auto_link: s.auto_link,
        accept: s.accept,
        home,
        format_shortcuts,
    })
}

fn extract_field_value(
    field_type: &FieldType,
    options: &[String],
    target_template: Option<&EntryTemplateId>,
    val: &FieldValue,
    live_entries: &BTreeMap<EntryId, Entry>,
    entry_refs: &BTreeMap<EntryId, String>,
) -> Option<FieldValue> {
    match (field_type, val) {
        (_, FieldValue::Null) | (FieldType::Image, _) => None,
        (FieldType::EntityRef, FieldValue::Text(raw)) => {
            let eid = EntryId::parse(raw).ok()?;
            let sym = entry_refs.get(&eid)?;
            if let Some(tt) = target_template
                && live_entries.get(&eid)?.template.as_ref() != Some(tt)
            {
                return None;
            }
            Some(FieldValue::Text(sym.clone()))
        }
        (FieldType::Select, FieldValue::Text(s)) => {
            options.contains(s).then(|| FieldValue::Text(s.clone()))
        }
        (FieldType::MultiSelect, FieldValue::List(xs)) => {
            let kept: Vec<String> = xs.iter().filter(|s| options.contains(s)).cloned().collect();
            Some(FieldValue::List(kept))
        }
        (FieldType::Number, FieldValue::Number(n)) => {
            n.is_finite().then_some(FieldValue::Number(*n))
        }
        (FieldType::Date, FieldValue::Text(s)) => {
            (s.is_ascii() && dr_model::Day::parse(s).is_some()).then(|| FieldValue::Text(s.clone()))
        }
        (FieldType::Text | FieldType::LongText, FieldValue::Text(s)) => {
            Some(FieldValue::Text(s.clone()))
        }
        (FieldType::Toggle, FieldValue::Bool(b)) => Some(FieldValue::Bool(*b)),
        (FieldType::Aliases, FieldValue::List(xs)) => Some(FieldValue::List(xs.clone())),
        _ => None,
    }
}

fn extract_entry_template(
    tpl: &EntryTemplate,
    live_templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
    live_entries: &BTreeMap<EntryId, Entry>,
    entry_refs: &BTreeMap<EntryId, String>,
) -> std::result::Result<TemplateEntryTemplate, ProjectTemplateError> {
    let mut modules = Vec::with_capacity(tpl.modules.len());
    for m in &tpl.modules {
        let kind = TemplateModuleKind::try_from(&m.kind).map_err(ProjectTemplateError::Invalid)?;
        let mut defs = Vec::with_capacity(m.config.defs.len());
        for d in &m.config.defs {
            let field_type = TemplateFieldType::try_from(&d.field_type)
                .map_err(ProjectTemplateError::Invalid)?;
            let target_template = d
                .target_template
                .as_ref()
                .filter(|tt| live_templates.contains_key(*tt))
                .map(ToString::to_string);
            let default_value = d.default_value.as_ref().and_then(|dv| {
                extract_field_value(
                    &d.field_type,
                    &d.options,
                    d.target_template
                        .as_ref()
                        .filter(|tt| live_templates.contains_key(*tt)),
                    dv,
                    live_entries,
                    entry_refs,
                )
            });
            defs.push(TemplateFieldDef {
                id: d.id.clone(),
                name: d.name.clone(),
                field_type,
                options: d.options.clone(),
                target_template,
                default_value,
            });
        }
        let initial_kv = m
            .config
            .initial_kv
            .iter()
            .filter(|r| !r.key.trim().is_empty())
            .map(|r| TemplateKvRow {
                key: r.key.clone(),
                value: r.value.clone(),
            })
            .collect();
        let arrangement = m
            .config
            .arrangement
            .as_ref()
            .map(TemplateMediaArrangement::try_from)
            .transpose()
            .map_err(ProjectTemplateError::Invalid)?;
        modules.push(TemplateModuleSpec {
            id: m.id.to_string(),
            kind,
            name: m.name.clone(),
            config: TemplateModuleConfig {
                show_outline: m.config.show_outline,
                task_todos: m.config.task_todos,
                in_book: m.config.in_book,
                defs,
                aliases_field: m.config.aliases_field.clone(),
                color_field: m.config.color_field.clone(),
                status_field: m.config.status_field.clone(),
                summary_field: m.config.summary_field.clone(),
                portrait_field: m.config.portrait_field.clone(),
                initial_kv,
                default_rows: m.config.default_rows.max(1),
                default_cols: m.config.default_cols.max(1),
                arrangement,
            },
            agent: m.agent.as_ref().map(Into::into),
        });
    }

    let verbs = tpl
        .verbs
        .iter()
        .map(|v| TemplateVerbSpec {
            id: v.id.clone(),
            name: v.name.clone(),
            description: v.description.clone(),
            target_template: v
                .target_template
                .as_ref()
                .filter(|tt| live_templates.contains_key(*tt))
                .map(ToString::to_string),
        })
        .collect();

    Ok(TemplateEntryTemplate {
        id: tpl.id.to_string(),
        name: tpl.name.clone(),
        mark: tpl.mark.clone(),
        color: tpl.color.clone(),
        agent: tpl.agent.as_ref().map(Into::into),
        modules,
        level: tpl.level,
        linkable: tpl.linkable,
        settings: extract_level_settings(&tpl.settings, live_templates, live_entries, entry_refs)?,
        verbs,
    })
}

// ---- Seed `ProjectTemplate` -> `ProjectTemplateValue` --------------------

/// Convert an in-memory [`ProjectTemplate`] seed (such as the built-in writing
/// template) into a canonical, validated [`ProjectTemplateValue`].
pub fn from_seed_template(
    pt: &ProjectTemplate,
    name: &str,
    description: &str,
    revision: i64,
) -> std::result::Result<ProjectTemplateValue, ProjectTemplateError> {
    let live_templates: BTreeMap<EntryTemplateId, EntryTemplate> = pt
        .templates
        .iter()
        .filter(|t| !t.is_trashed())
        .map(|t| (t.id.clone(), t.clone()))
        .collect();

    // Order seed entries in depth-first preorder, preserving sibling order.
    let mut children_by_parent: BTreeMap<Option<EntryId>, Vec<usize>> = BTreeMap::new();
    let known_ids: BTreeSet<EntryId> = pt.entries.iter().map(|e| e.id.clone()).collect();
    for (idx, e) in pt.entries.iter().enumerate() {
        if e.parent.as_ref().is_some_and(|p| !known_ids.contains(p)) {
            return Err(ProjectTemplateError::Invalid(format!(
                "seed entry {} parent {:?} does not exist",
                e.id, e.parent
            )));
        }
        children_by_parent
            .entry(e.parent.clone())
            .or_default()
            .push(idx);
    }
    let mut preorder_indices = Vec::with_capacity(pt.entries.len());
    fn visit_seed(
        parent: Option<EntryId>,
        pt: &ProjectTemplate,
        children_by_parent: &BTreeMap<Option<EntryId>, Vec<usize>>,
        visited: &mut BTreeSet<usize>,
        out: &mut Vec<usize>,
    ) -> std::result::Result<(), ProjectTemplateError> {
        if let Some(list) = children_by_parent.get(&parent) {
            for &idx in list {
                if !visited.insert(idx) {
                    return Err(ProjectTemplateError::Invalid(
                        "cycle in seed entries".into(),
                    ));
                }
                out.push(idx);
                visit_seed(
                    Some(pt.entries[idx].id.clone()),
                    pt,
                    children_by_parent,
                    visited,
                    out,
                )?;
            }
        }
        Ok(())
    }
    let mut visited = BTreeSet::new();
    visit_seed(
        None,
        pt,
        &children_by_parent,
        &mut visited,
        &mut preorder_indices,
    )?;
    if preorder_indices.len() != pt.entries.len() {
        return Err(ProjectTemplateError::Invalid(
            "cycle in seed entries".into(),
        ));
    }

    let mut entry_refs = BTreeMap::new();
    let mut live_entries_map = BTreeMap::new();
    for (rank, &idx) in preorder_indices.iter().enumerate() {
        let se = &pt.entries[idx];
        entry_refs.insert(se.id.clone(), format!("e{}", rank + 1));
        live_entries_map.insert(
            se.id.clone(),
            Entry {
                id: se.id.clone(),
                parent: se.parent.clone(),
                pos: String::new(),
                title: se.title.clone(),
                mark: se.mark.clone(),
                template: se.template.clone(),
                level: se.level,
                auto_link: false,
                overrides: se.overrides.clone(),
                fields: se.fields.clone(),
                kv: BTreeMap::new(),
                media: BTreeMap::new(),
                arrangements: BTreeMap::new(),
                primary: None,
                created_at: None,
                updated_at: None,
                deleted_at: None,
                name_conflict: None,
            },
        );
    }

    let live_views: Vec<&TimelineView> =
        pt.views.iter().filter(|v| v.deleted_at.is_none()).collect();
    let mut view_refs = BTreeMap::new();
    for (idx, v) in live_views.iter().enumerate() {
        view_refs.insert(v.id.clone(), format!("v{}", idx + 1));
    }

    let book = pt.project.book.as_ref().map(|b| TemplateProjectBook {
        word_target: b.word_target_set,
        daily_word_target: b.daily_word_target_set,
    });

    let mut tabs = Vec::with_capacity(pt.project.tabs.len());
    for tab in &pt.project.tabs {
        let mount = match &tab.mount {
            TabMount::Root => TemplateTabMount::Root,
            TabMount::Book => TemplateTabMount::Book,
            TabMount::Entry { entry } => TemplateTabMount::Entry {
                entry: entry_refs.get(entry).cloned().ok_or_else(|| {
                    ProjectTemplateError::Invalid(format!(
                        "tab {} entry {entry} missing from seed entries",
                        tab.id
                    ))
                })?,
            },
            TabMount::View { view } => {
                return Err(ProjectTemplateError::Invalid(format!(
                    "tab {} mounts view {view}: a tab cannot mount a view",
                    tab.id
                )));
            }
        };
        tabs.push(TemplateTab { mount });
    }

    let mut templates = Vec::with_capacity(live_templates.len());
    for tpl in live_templates.values() {
        // Check strictly that `default_template`, `home`, `target_template` resolve on direct seed inputs.
        if let Some(Some(dt)) = &tpl.settings.default_template
            && !live_templates.contains_key(dt)
        {
            return Err(ProjectTemplateError::Invalid(format!(
                "template {} default_template {dt} does not exist",
                tpl.id
            )));
        }
        if let Some(Some(hid)) = &tpl.settings.home
            && !live_entries_map.get(hid).is_some_and(Entry::is_level)
        {
            return Err(ProjectTemplateError::Invalid(format!(
                "template {} home {hid} is not a level entry",
                tpl.id
            )));
        }
        templates.push(extract_entry_template(
            tpl,
            &live_templates,
            &live_entries_map,
            &entry_refs,
        )?);
    }

    let mut entries = Vec::with_capacity(preorder_indices.len());
    for &idx in &preorder_indices {
        let se = &pt.entries[idx];
        if let Some(tid) = &se.template
            && !live_templates.contains_key(tid)
        {
            return Err(ProjectTemplateError::Invalid(format!(
                "seed entry {} template {tid} does not exist",
                se.id
            )));
        }
        let overrides = match &se.overrides {
            None => None,
            Some(ov) => {
                if let Some(Some(dt)) = &ov.default_template
                    && !live_templates.contains_key(dt)
                {
                    return Err(ProjectTemplateError::Invalid(format!(
                        "seed entry {} override default_template {dt} does not exist",
                        se.id
                    )));
                }
                if let Some(Some(hid)) = &ov.home
                    && !live_entries_map.get(hid).is_some_and(Entry::is_level)
                {
                    return Err(ProjectTemplateError::Invalid(format!(
                        "seed entry {} override home {hid} is not a level entry",
                        se.id
                    )));
                }
                let converted =
                    extract_level_settings(ov, &live_templates, &live_entries_map, &entry_refs)?;
                (!converted.is_empty()).then_some(converted)
            }
        };
        let mut fields = BTreeMap::new();
        let active_tpl = se.template.as_ref().and_then(|t| live_templates.get(t));
        for (mid, fmap) in &se.fields {
            let mut out_fmap = BTreeMap::new();
            for (fid, fv) in fmap {
                let is_eref = active_tpl
                    .and_then(|t| t.module(mid))
                    .and_then(|m| m.config.defs.iter().find(|d| &d.id == fid))
                    .is_some_and(|d| d.field_type == FieldType::EntityRef);
                let out_v = if is_eref {
                    match fv {
                        FieldValue::Text(raw) => {
                            let eid = EntryId::parse(raw)
                                .map_err(|e| ProjectTemplateError::Invalid(e.to_string()))?;
                            let sym = entry_refs.get(&eid).ok_or_else(|| {
                                ProjectTemplateError::Invalid(format!(
                                    "seed entry field entity_ref {eid} missing"
                                ))
                            })?;
                            FieldValue::Text(sym.clone())
                        }
                        other => other.clone(),
                    }
                } else {
                    fv.clone()
                };
                out_fmap.insert(fid.clone(), out_v);
            }
            if !out_fmap.is_empty() {
                fields.insert(mid.to_string(), out_fmap);
            }
        }
        entries.push(TemplateEntry {
            sym_ref: entry_refs[&se.id].clone(),
            parent: se.parent.as_ref().map(|p| entry_refs[p].clone()),
            title: se.title.clone(),
            template: se.template.as_ref().map(ToString::to_string),
            level: se.level,
            overrides,
            mark: se.mark.clone(),
            fields,
            kv: BTreeMap::new(),
            arrangements: BTreeMap::new(),
            prose: BTreeMap::new(),
        });
    }

    let mut views = Vec::with_capacity(live_views.len());
    for v in live_views {
        let mut lanes = Vec::with_capacity(v.lanes.len());
        for lane in &v.lanes {
            let sym = entry_refs.get(&lane.entry).ok_or_else(|| {
                ProjectTemplateError::Invalid(format!(
                    "view {} lane {} missing from seed entries",
                    v.id, lane.entry
                ))
            })?;
            lanes.push(TemplateViewLane {
                entry: sym.clone(),
                act_track: lane.act_track,
            });
        }
        let mut placements = Vec::with_capacity(v.placements.len());
        for p in &v.placements {
            let sym = entry_refs.get(&p.entry).ok_or_else(|| {
                ProjectTemplateError::Invalid(format!(
                    "view {} placement {} missing from seed entries",
                    v.id, p.entry
                ))
            })?;
            placements.push(TemplateViewPlacement {
                entry: sym.clone(),
                at: p.at,
                span: p.span,
            });
        }
        let mut pins = Vec::with_capacity(v.pins.len());
        for pin in &v.pins {
            let entry = match &pin.entry {
                None => None,
                Some(eid) => Some(
                    entry_refs
                        .get(eid)
                        .ok_or_else(|| {
                            ProjectTemplateError::Invalid(format!(
                                "view {} pin entry {eid} missing from seed entries",
                                v.id
                            ))
                        })?
                        .clone(),
                ),
            };
            pins.push(TemplateViewPin {
                at: pin.at,
                label: pin.label.clone(),
                color: pin.color.clone(),
                entry,
            });
        }
        views.push(TemplateView {
            sym_ref: view_refs[&v.id].clone(),
            name: v.name.clone(),
            lanes,
            placements,
            pins,
        });
    }

    let val = ProjectTemplateValue {
        format: PROJECT_TEMPLATE_FORMAT.into(),
        format_version: PROJECT_TEMPLATE_FORMAT_VERSION,
        made_with: String::new(),
        name: name.trim().to_owned(),
        description: description.to_owned(),
        locale: "zh-Hans".into(),
        revision: revision.max(1),
        credit: None,
        project: TemplateProject {
            agent: pt.project.agent.as_ref().map(Into::into),
            book,
            tabs,
        },
        templates,
        relation_types: Vec::new(),
        entries,
        memberships: Vec::new(),
        views,
        template_prose: BTreeMap::new(),
    };
    validate_project_template_value(&val)?;
    Ok(val)
}

// ---- Materialize `ProjectTemplateValue` into a new book -------------------

/// Materialized custom relation type with a fresh [`RelationTypeId`].
#[derive(Clone, Debug)]
pub struct MaterializedRelationType {
    pub id: RelationTypeId,
    pub name: String,
    pub description: LinkedText,
    pub direction: RelationDirection,
}

/// Materialized entry ready to be written into a new book (with fresh [`EntryId`]
/// and [`KvEntryId`]s).
#[derive(Clone, Debug)]
pub struct MaterializedEntry {
    pub id: EntryId,
    pub parent: Option<EntryId>,
    pub title: String,
    pub template: Option<EntryTemplateId>,
    pub level: bool,
    pub overrides: Option<LevelSettingsOverride>,
    pub mark: Option<String>,
    pub fields: BTreeMap<ModuleId, BTreeMap<String, FieldValue>>,
    pub kv: BTreeMap<ModuleId, Vec<KvEntry>>,
    pub arrangements: BTreeMap<ModuleId, MediaArrangement>,
    pub primary: Option<EntryId>,
    pub prose: BTreeMap<ModuleId, Vec<TemplateParagraph>>,
}

/// Complete new-project plan produced from a validated [`ProjectTemplateValue`]
/// with fresh UUIDv7s for every entry, view, tab, relation type, kv row and pin.
#[derive(Clone, Debug)]
pub struct MaterializedProjectTemplate {
    pub entry_map: BTreeMap<String, EntryId>,
    pub view_map: BTreeMap<String, TimelineViewId>,
    pub project: ProjectDefinition,
    pub templates: Vec<EntryTemplate>,
    pub relation_types: Vec<MaterializedRelationType>,
    pub entries: Vec<MaterializedEntry>,
    pub memberships: Vec<Membership>,
    pub views: Vec<TimelineView>,
    pub template_prose: BTreeMap<(EntryTemplateId, ModuleId), Vec<TemplateParagraph>>,
}

/// Validate `val` and materialize fresh UUIDv7 IDs and position keys for a new book.
pub fn materialize_project_template(
    val: &ProjectTemplateValue,
    source: Option<ProjectTemplateRef>,
) -> std::result::Result<MaterializedProjectTemplate, ProjectTemplateError> {
    validate_project_template_value(val)?;

    let mut entry_map = BTreeMap::new();
    for e in &val.entries {
        entry_map.insert(e.sym_ref.clone(), EntryId::new_v7());
    }
    let mut view_map = BTreeMap::new();
    for v in &val.views {
        view_map.insert(v.sym_ref.clone(), TimelineViewId::new_v7());
    }

    // Order entries in tree preorder (roots in array order, children of each parent in array order).
    let mut children_by_parent: BTreeMap<Option<String>, Vec<usize>> = BTreeMap::new();
    for (idx, e) in val.entries.iter().enumerate() {
        children_by_parent
            .entry(e.parent.clone())
            .or_default()
            .push(idx);
    }
    let mut preorder = Vec::with_capacity(val.entries.len());
    fn push_preorder(
        parent: Option<String>,
        entries: &[TemplateEntry],
        by_parent: &BTreeMap<Option<String>, Vec<usize>>,
        out: &mut Vec<usize>,
    ) {
        if let Some(indices) = by_parent.get(&parent) {
            for &idx in indices {
                out.push(idx);
                push_preorder(Some(entries[idx].sym_ref.clone()), entries, by_parent, out);
            }
        }
    }
    push_preorder(None, &val.entries, &children_by_parent, &mut preorder);

    // Project definition.
    let book = val.project.book.as_ref().map(|b| ProjectBook {
        word_target_set: b.word_target,
        daily_word_target_set: b.daily_word_target,
    });

    let mut tabs = Vec::with_capacity(val.project.tabs.len());
    let mut tab_pos = PosKey::first();
    for (idx, tab) in val.project.tabs.iter().enumerate() {
        if idx > 0 {
            tab_pos = tab_pos.after();
        }
        let mount = match &tab.mount {
            TemplateTabMount::Root => TabMount::Root,
            TemplateTabMount::Book => TabMount::Book,
            TemplateTabMount::Entry { entry } => TabMount::Entry {
                entry: entry_map[entry].clone(),
            },
        };
        tabs.push(ProjectTab {
            // 「全部」 keeps its fixed id, as in a built-in project.
            id: match mount {
                TabMount::Root => dr_model::v3::all_tab_id(),
                _ => TabId::new_v7(),
            },
            pos: Some(tab_pos.clone()),
            mount,
            gone_title: None,
        });
    }

    let project = ProjectDefinition {
        source,
        agent: val.project.agent.as_ref().map(Into::into),
        book,
        tabs,
    };

    // Entry templates.
    let mut templates = Vec::with_capacity(val.templates.len());
    let mut tpl_map: BTreeMap<EntryTemplateId, EntryTemplate> = BTreeMap::new();
    for tpl in &val.templates {
        let dt = tpl
            .to_domain(&entry_map)
            .map_err(ProjectTemplateError::Invalid)?;
        tpl_map.insert(dt.id.clone(), dt.clone());
        templates.push(dt);
    }

    // Custom relation types.
    let mut relation_types = Vec::with_capacity(val.relation_types.len());
    for rt in &val.relation_types {
        relation_types.push(MaterializedRelationType {
            id: RelationTypeId::new_v7(),
            name: rt.name.trim().to_owned(),
            description: rt
                .description
                .remap_links(|id| entry_map.get(id.as_str()).cloned()),
            direction: rt.direction,
        });
    }

    // Memberships & primary host map.
    let mut primary_by_member: BTreeMap<&str, EntryId> = BTreeMap::new();
    let mut pos_by_host: BTreeMap<&str, PosKey> = BTreeMap::new();
    let mut memberships = Vec::with_capacity(val.memberships.len());
    for m in &val.memberships {
        let host_id = entry_map[&m.host].clone();
        let member_id = entry_map[&m.member].clone();
        if m.primary {
            primary_by_member.insert(m.member.as_str(), host_id.clone());
        }
        let next_pos = match pos_by_host.get_mut(m.host.as_str()) {
            Some(cur) => {
                *cur = cur.after();
                cur.clone()
            }
            None => {
                let first = PosKey::first();
                pos_by_host.insert(m.host.as_str(), first.clone());
                first
            }
        };
        memberships.push(Membership {
            host: host_id,
            member: member_id,
            pos: Some(next_pos),
            created_at: None,
        });
    }

    // Entries.
    let mut entries = Vec::with_capacity(preorder.len());
    for idx in preorder {
        let e = &val.entries[idx];
        let id = entry_map[&e.sym_ref].clone();
        let parent = e.parent.as_ref().map(|p| entry_map[p].clone());
        let template = e
            .template
            .as_deref()
            .map(|t| EntryTemplateId::parse(t).expect("validated"));
        let active_tpl = template.as_ref().and_then(|t| tpl_map.get(t));
        let overrides = e
            .overrides
            .as_ref()
            .map(|ov| ov.to_domain(&entry_map))
            .transpose()
            .map_err(ProjectTemplateError::Invalid)?;

        let mut fields = BTreeMap::new();
        for (mod_str, fmap) in &e.fields {
            let mid = ModuleId::parse(mod_str).expect("validated");
            let mut out_fmap = BTreeMap::new();
            for (fid, fv) in fmap {
                let is_eref = active_tpl
                    .and_then(|t| t.module(&mid))
                    .and_then(|m| m.config.defs.iter().find(|d| &d.id == fid))
                    .is_some_and(|d| d.field_type == FieldType::EntityRef);
                let out_v = if is_eref {
                    rewrite_entity_ref_value(fv, &entry_map)
                        .map_err(ProjectTemplateError::Invalid)?
                } else {
                    fv.clone()
                };
                out_fmap.insert(fid.clone(), out_v);
            }
            fields.insert(mid, out_fmap);
        }

        let mut kv = BTreeMap::new();
        for (mod_str, rows) in &e.kv {
            let mid = ModuleId::parse(mod_str).expect("validated");
            let mut kpos = PosKey::first();
            let mut out_rows = Vec::with_capacity(rows.len());
            for (r_idx, r) in rows.iter().enumerate() {
                if r_idx > 0 {
                    kpos = kpos.after();
                }
                out_rows.push(KvEntry {
                    id: KvEntryId::new_v7(),
                    key: r.key.clone(),
                    value: r.value.clone(),
                    pos: Some(kpos.clone()),
                });
            }
            kv.insert(mid, out_rows);
        }

        let mut arrangements = BTreeMap::new();
        for (mod_str, arr) in &e.arrangements {
            let mid = ModuleId::parse(mod_str).expect("validated");
            arrangements.insert(mid, (*arr).into());
        }

        let mut prose = BTreeMap::new();
        for (mod_str, paras) in &e.prose {
            let mid = ModuleId::parse(mod_str).expect("validated");
            prose.insert(mid, paras.clone());
        }

        entries.push(MaterializedEntry {
            id,
            parent,
            title: e.title.trim().to_owned(),
            template,
            level: e.level,
            overrides,
            mark: e.mark.clone(),
            fields,
            kv,
            arrangements,
            primary: primary_by_member.get(e.sym_ref.as_str()).cloned(),
            prose,
        });
    }

    // Views.
    let mut views = Vec::with_capacity(val.views.len());
    let mut v_pos = PosKey::first();
    for (v_idx, v) in val.views.iter().enumerate() {
        if v_idx > 0 {
            v_pos = v_pos.after();
        }
        let mut l_pos = PosKey::first();
        let mut lanes = Vec::with_capacity(v.lanes.len());
        for (l_idx, l) in v.lanes.iter().enumerate() {
            if l_idx > 0 {
                l_pos = l_pos.after();
            }
            lanes.push(TimelineLane {
                entry: entry_map[&l.entry].clone(),
                pos: Some(l_pos.clone()),
                act_track: l.act_track,
            });
        }
        let placements = v
            .placements
            .iter()
            .map(|p| TimelinePlacement {
                entry: entry_map[&p.entry].clone(),
                at: p.at,
                span: p.span,
            })
            .collect();
        let pins = v
            .pins
            .iter()
            .map(|pin| TimelinePin {
                id: TimePinId::new_v7(),
                at: pin.at,
                label: pin.label.trim().to_owned(),
                color: pin.color.clone(),
                entry: pin.entry.as_ref().map(|sym| entry_map[sym].clone()),
            })
            .collect();
        views.push(TimelineView {
            id: view_map[&v.sym_ref].clone(),
            name: v.name.trim().to_owned(),
            pos: Some(v_pos.clone()),
            lanes,
            placements,
            pins,
            deleted_at: None,
        });
    }

    // Template prose.
    let mut template_prose = BTreeMap::new();
    for (key, paras) in &val.template_prose {
        let (tpl_str, mod_str) = key.split_once('/').expect("validated");
        let tid = EntryTemplateId::parse(tpl_str).expect("validated");
        let mid = ModuleId::parse(mod_str).expect("validated");
        template_prose.insert((tid, mid), paras.clone());
    }

    Ok(MaterializedProjectTemplate {
        entry_map,
        view_map,
        project,
        templates,
        relation_types,
        entries,
        memberships,
        views,
        template_prose,
    })
}

/// Write a [`MaterializedProjectTemplate`] into an empty book's [`BookTxnV3`].
pub fn apply_materialized_project_template(
    txn: &mut BookTxnV3<'_>,
    mat: &MaterializedProjectTemplate,
    created_at: Timestamp,
) -> Result<()> {
    txn.project().set_full(&mat.project)?;
    for tpl in &mat.templates {
        txn.template(&tpl.id)?.set_full(tpl)?;
    }
    for rt in &mat.relation_types {
        let w = txn.relation_type(&rt.id)?;
        w.name(&rt.name)?
            .description(&rt.description)?
            .direction(rt.direction)?
            .created_at(Some(created_at))?;
    }
    for entry in &mat.entries {
        let w = txn.entries().create(
            &entry.id,
            entry.parent.as_ref(),
            &entry.title,
            entry.template.as_ref(),
            entry.level,
        )?;
        w.created_at(Some(created_at))?
            .updated_at(Some(created_at))?;
        if entry.mark.is_some() {
            w.mark(entry.mark.as_deref())?;
        }
        if entry.overrides.is_some() {
            w.overrides(entry.overrides.as_ref())?;
        }
        for (mod_id, fmap) in &entry.fields {
            for (fid, val) in fmap {
                w.set_field(mod_id, fid, Some(val))?;
            }
        }
        for (mod_id, rows) in &entry.kv {
            for row in rows {
                w.put_kv(mod_id, row)?;
            }
        }
        for (mod_id, arr) in &entry.arrangements {
            w.arrangement(mod_id, Some(arr))?;
        }
        if entry.primary.is_some() {
            w.primary(entry.primary.as_ref())?;
        }
    }
    crate::v3::novel::start_auto_links(txn, mat.entries.iter().map(|e| &e.id))?;
    for m in &mat.memberships {
        txn.put_membership(&m.host, &m.member, m.pos.as_ref(), Some(created_at))?;
    }
    for view in &mat.views {
        let w = txn.timeline_view(&view.id)?;
        w.name(&view.name)?.pos(view.pos.as_ref())?;
        for lane in &view.lanes {
            w.put_lane(&lane.entry, lane.pos.as_ref())?
                .set_lane_act_track(&lane.entry, lane.act_track)?;
        }
        for p in &view.placements {
            w.put_placement(&p.entry, p.at, p.span)?;
        }
        for pin in &view.pins {
            w.put_pin(pin)?;
        }
    }
    Ok(())
}
