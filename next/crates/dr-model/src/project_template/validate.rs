//! Unified validator and canonical JSON serializer for [`ProjectTemplateValue`].

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::Deserialize;

use super::{
    MAX_PROJECT_TEMPLATE_AGENT_CHARS, MAX_PROJECT_TEMPLATE_BYTES, MAX_PROJECT_TEMPLATE_ENTRIES,
    MAX_PROJECT_TEMPLATE_TEMPLATES, PROJECT_TEMPLATE_FORMAT, PROJECT_TEMPLATE_FORMAT_VERSION,
    ProjectTemplateCredit, ProjectTemplateValue, TemplateBlockAttrs, TemplateEntry,
    TemplateFieldDef, TemplateFieldType, TemplateLevelSettings, TemplateModuleKind,
    TemplateParagraph, TemplateRun, TemplateTabMount, TemplateTable,
};
use crate::check::{Violation, non_empty_name};
use crate::id::{EntryId, EntryTemplateId, FieldId, ModuleId, TimePinId, TimelineViewId, check_id};
use crate::pos::PosKey;
use crate::prose::{MAX_INDENT, OBJECT_CHAR, PARAGRAPH_END};
use crate::shared::normalize_relation_type_name;
use crate::time::Day;
use crate::v3::{
    BookGraph, Entry, EntryTemplate, FieldValue, Membership, ModuleKind, TabMount, TimelineLane,
    TimelinePin, TimelinePlacement, TimelineView, check_entry_move, check_entry_template,
    check_membership, check_new_violations, check_parent_is_level, check_tab_mount,
    check_timeline_lane, check_timeline_placement_in_lane, check_timeline_target_live,
    is_valid_mark,
};

/// Why a project template failed parsing or validation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProjectTemplateError {
    /// Serialized bytes exceed [`MAX_PROJECT_TEMPLATE_BYTES`].
    TooLarge { bytes: usize, max: usize },
    /// Malformed JSON or unknown field/variant rejected by the closed schema.
    MalformedJson(String),
    /// Wrong `format` discriminator.
    InvalidFormat(String),
    /// Template comes from a newer `formatVersion` than this client supports.
    UnsupportedFormatVersion { found: i64, supported: i64 },
    /// Invalid (zero or negative) `formatVersion`.
    InvalidFormatVersion(i64),
    /// Structural, limit, or reference violation.
    Invalid(String),
}

impl fmt::Display for ProjectTemplateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { bytes, max } => {
                write!(
                    f,
                    "project template is {bytes} bytes, exceeding the {max}-byte limit"
                )
            }
            Self::MalformedJson(msg) => write!(f, "invalid project template JSON: {msg}"),
            Self::InvalidFormat(found) => write!(
                f,
                "expected format {:?}, found {:?}",
                PROJECT_TEMPLATE_FORMAT, found
            ),
            Self::UnsupportedFormatVersion { found, supported } => write!(
                f,
                "project template uses newer formatVersion {found}; this client supports up to version {supported}"
            ),
            Self::InvalidFormatVersion(found) => {
                write!(f, "invalid project template formatVersion {found}")
            }
            Self::Invalid(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for ProjectTemplateError {}

impl From<Violation> for ProjectTemplateError {
    fn from(v: Violation) -> Self {
        Self::Invalid(v.to_string())
    }
}

fn inv<T>(msg: impl Into<String>) -> Result<T, ProjectTemplateError> {
    Err(ProjectTemplateError::Invalid(msg.into()))
}

/// Whether `s` is a valid symbolic entry reference (`e1`, `e2`, …).
/// Rejects UUIDs, asset IDs, leading zeros and non-numeric suffixes.
pub fn is_symbolic_entry_ref(s: &str) -> bool {
    is_symbolic_code(s, 'e')
}

/// Whether `s` is a valid symbolic view reference (`v1`, `v2`, …).
pub fn is_symbolic_view_ref(s: &str) -> bool {
    is_symbolic_code(s, 'v')
}

fn is_symbolic_code(s: &str, prefix: char) -> bool {
    let Some(rest) = s.strip_prefix(prefix) else {
        return false;
    };
    if rest.is_empty() || rest.len() > 6 || rest.starts_with('0') {
        return false;
    }
    rest.bytes().all(|b| b.is_ascii_digit())
}

fn has_bad_inline_control(s: &str) -> bool {
    s.chars().any(char::is_control)
}

fn has_bad_multiline_control(s: &str) -> bool {
    s.chars()
        .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
}

/// Serialize `value` into deterministic UTF-8 JSON (stable key order and 2-space indent),
/// enforcing [`MAX_PROJECT_TEMPLATE_BYTES`].
pub fn to_canonical_json(value: &ProjectTemplateValue) -> Result<String, ProjectTemplateError> {
    let mut json = serde_json::to_string_pretty(value)
        .map_err(|e| ProjectTemplateError::MalformedJson(e.to_string()))?;
    json.push('\n');
    if json.len() > MAX_PROJECT_TEMPLATE_BYTES {
        return Err(ProjectTemplateError::TooLarge {
            bytes: json.len(),
            max: MAX_PROJECT_TEMPLATE_BYTES,
        });
    }
    Ok(json)
}

#[derive(Deserialize)]
struct VersionHeader {
    #[serde(default)]
    format: Option<String>,
    #[serde(rename = "formatVersion", default)]
    format_version: Option<i64>,
}

/// Parse raw UTF-8 JSON into a [`ProjectTemplateValue`] and run [`validate_project_template_value`].
///
/// Checks byte size and `(format, formatVersion)` before running the closed-schema
/// deserializer so a template from a newer `formatVersion` always reports
/// [`ProjectTemplateError::UnsupportedFormatVersion`] even when that version adds fields.
pub fn parse_project_template_json(
    raw: &str,
) -> Result<ProjectTemplateValue, ProjectTemplateError> {
    if raw.len() > MAX_PROJECT_TEMPLATE_BYTES {
        return Err(ProjectTemplateError::TooLarge {
            bytes: raw.len(),
            max: MAX_PROJECT_TEMPLATE_BYTES,
        });
    }
    if let Ok(header) = serde_json::from_str::<VersionHeader>(raw) {
        if let Some(fmt) = &header.format
            && fmt != PROJECT_TEMPLATE_FORMAT
        {
            return Err(ProjectTemplateError::InvalidFormat(fmt.clone()));
        }
        if let Some(ver) = header.format_version {
            if ver > PROJECT_TEMPLATE_FORMAT_VERSION {
                return Err(ProjectTemplateError::UnsupportedFormatVersion {
                    found: ver,
                    supported: PROJECT_TEMPLATE_FORMAT_VERSION,
                });
            }
            if ver < 1 {
                return Err(ProjectTemplateError::InvalidFormatVersion(ver));
            }
        }
    }
    let value: ProjectTemplateValue = serde_json::from_str(raw)
        .map_err(|e| ProjectTemplateError::MalformedJson(e.to_string()))?;
    validate_project_template_value(&value)?;
    Ok(value)
}

/// Validate every limit, closed-schema invariant, symbolic reference, prose run
/// and structural graph rule on `val`.
pub fn validate_project_template_value(
    val: &ProjectTemplateValue,
) -> Result<(), ProjectTemplateError> {
    if val.format != PROJECT_TEMPLATE_FORMAT {
        return Err(ProjectTemplateError::InvalidFormat(val.format.clone()));
    }
    if val.format_version > PROJECT_TEMPLATE_FORMAT_VERSION {
        return Err(ProjectTemplateError::UnsupportedFormatVersion {
            found: val.format_version,
            supported: PROJECT_TEMPLATE_FORMAT_VERSION,
        });
    }
    if val.format_version < 1 {
        return Err(ProjectTemplateError::InvalidFormatVersion(
            val.format_version,
        ));
    }
    non_empty_name(&val.name)?;
    if has_bad_inline_control(&val.name)
        || has_bad_inline_control(&val.made_with)
        || has_bad_inline_control(&val.locale)
        || has_bad_multiline_control(&val.description)
    {
        return inv("template metadata contains control characters");
    }
    if val.revision < 1 {
        return inv(format!(
            "template revision must be >= 1 (found {})",
            val.revision
        ));
    }
    if let Some(credit) = &val.credit {
        validate_credit(credit)?;
    }

    if val.templates.len() > MAX_PROJECT_TEMPLATE_TEMPLATES {
        return inv(format!(
            "template has {} entry templates (limit {})",
            val.templates.len(),
            MAX_PROJECT_TEMPLATE_TEMPLATES
        ));
    }
    if val.entries.len() > MAX_PROJECT_TEMPLATE_ENTRIES {
        return inv(format!(
            "template has {} seed entries (limit {})",
            val.entries.len(),
            MAX_PROJECT_TEMPLATE_ENTRIES
        ));
    }

    let agent_chars = count_agent_chars(val);
    if agent_chars > MAX_PROJECT_TEMPLATE_AGENT_CHARS {
        return inv(format!(
            "Agent instructions total {agent_chars} characters (limit {MAX_PROJECT_TEMPLATE_AGENT_CHARS})"
        ));
    }

    // Check serialized payload size.
    let _ = to_canonical_json(val)?;

    if let Some(pa) = &val.project.agent
        && (has_bad_inline_control(&pa.name)
            || has_bad_multiline_control(&pa.description)
            || has_bad_multiline_control(&pa.instructions))
    {
        return inv("project.agent contains disallowed control characters");
    }

    // 1. Validate entry IDs (`e1`..) and view IDs (`v1`..) upfront so we can
    //    check symbolic references across templates, entries, memberships and views.
    let mut entry_sym_set = BTreeSet::new();
    let mut dummy_entry_map = BTreeMap::new();
    for entry in &val.entries {
        if !is_symbolic_entry_ref(&entry.sym_ref) {
            return inv(format!(
                "entry ref {:?} must be a symbolic code like \"e1\" (real entry or file IDs are not allowed)",
                entry.sym_ref
            ));
        }
        if !entry_sym_set.insert(entry.sym_ref.clone()) {
            return inv(format!("duplicate entry ref {:?}", entry.sym_ref));
        }
        dummy_entry_map.insert(
            entry.sym_ref.clone(),
            EntryId::parse(&entry.sym_ref)
                .map_err(|e| ProjectTemplateError::Invalid(e.to_string()))?,
        );
    }

    let mut view_sym_set = BTreeSet::new();
    for view in &val.views {
        if !is_symbolic_view_ref(&view.sym_ref) {
            return inv(format!(
                "view ref {:?} must be a symbolic code like \"v1\" (real view IDs are not allowed)",
                view.sym_ref
            ));
        }
        if !view_sym_set.insert(view.sym_ref.clone()) {
            return inv(format!("duplicate view ref {:?}", view.sym_ref));
        }
    }

    // 2. Validate entry templates (first pass: IDs, modules, fields; second pass: cross-template refs).
    let mut raw_tpl_ids = BTreeSet::new();
    for tpl in &val.templates {
        let tid = EntryTemplateId::parse(&tpl.id)
            .map_err(|e| ProjectTemplateError::Invalid(format!("template id {:?}: {e}", tpl.id)))?;
        if !raw_tpl_ids.insert(tid) {
            return inv(format!("duplicate entry template id {:?}", tpl.id));
        }
        non_empty_name(&tpl.name)?;
        if has_bad_inline_control(&tpl.name) {
            return inv(format!(
                "template {:?} name contains control characters",
                tpl.id
            ));
        }
        if let Some(mark) = &tpl.mark
            && !is_valid_mark(mark)
        {
            return inv(format!("template {:?} has invalid mark {mark:?}", tpl.id));
        }
        if let Some(color) = &tpl.color
            && (color.trim().is_empty() || has_bad_inline_control(color))
        {
            return inv(format!("template {:?} has invalid color", tpl.id));
        }
        if let Some(ta) = &tpl.agent
            && (has_bad_inline_control(&ta.name)
                || has_bad_multiline_control(&ta.description)
                || has_bad_multiline_control(&ta.instructions))
        {
            return inv(format!(
                "template {:?} agent config contains control characters",
                tpl.id
            ));
        }

        let mut mod_ids = BTreeSet::new();
        for module in &tpl.modules {
            let mid = ModuleId::parse(&module.id).map_err(|e| {
                ProjectTemplateError::Invalid(format!("module id {:?}: {e}", module.id))
            })?;
            if !mod_ids.insert(mid) {
                return inv(format!(
                    "duplicate module id {:?} on template {:?}",
                    module.id, tpl.id
                ));
            }
            non_empty_name(&module.name)?;
            if has_bad_inline_control(&module.name) {
                return inv(format!(
                    "module {:?} name contains control characters",
                    module.id
                ));
            }
            if module.config.default_rows == 0 || module.config.default_cols == 0 {
                return inv(format!(
                    "module {:?} plot dimensions must be >= 1",
                    module.id
                ));
            }
            if let Some(ma) = &module.agent {
                if let Some(rt) = &ma.read_tier
                    && (rt.trim().is_empty() || has_bad_inline_control(rt))
                {
                    return inv(format!(
                        "module {:?} has invalid agent read_tier",
                        module.id
                    ));
                }
                if has_bad_multiline_control(&ma.instructions) {
                    return inv(format!(
                        "module {:?} agent instructions contain control characters",
                        module.id
                    ));
                }
            }
            let mut field_ids = BTreeSet::new();
            for def in &module.config.defs {
                let _ = FieldId::parse(&def.id).map_err(|e| {
                    ProjectTemplateError::Invalid(format!("field id {:?}: {e}", def.id))
                })?;
                if !field_ids.insert(def.id.clone()) {
                    return inv(format!(
                        "duplicate field id {:?} in module {:?}",
                        def.id, module.id
                    ));
                }
                non_empty_name(&def.name)?;
                if has_bad_inline_control(&def.name) {
                    return inv(format!(
                        "field {:?} name contains control characters",
                        def.id
                    ));
                }
                let mut opts = BTreeSet::new();
                for opt in &def.options {
                    non_empty_name(opt)?;
                    if has_bad_inline_control(opt) || !opts.insert(opt) {
                        return inv(format!("invalid or duplicate option in field {:?}", def.id));
                    }
                }
            }
            for role_field in [
                &module.config.aliases_field,
                &module.config.color_field,
                &module.config.status_field,
                &module.config.summary_field,
                &module.config.portrait_field,
            ]
            .into_iter()
            .flatten()
            {
                if !field_ids.contains(role_field) {
                    return inv(format!(
                        "module {:?} role references undefined field {role_field:?}",
                        module.id
                    ));
                }
            }
            for row in &module.config.initial_kv {
                non_empty_name(&row.key)?;
                if has_bad_inline_control(&row.key) || has_bad_multiline_control(&row.value) {
                    return inv(format!("invalid initial_kv row in module {:?}", module.id));
                }
            }
        }

        let mut verb_ids = BTreeSet::new();
        for verb in &tpl.verbs {
            check_id(&verb.id).map_err(|e| {
                ProjectTemplateError::Invalid(format!("verb id {:?}: {e}", verb.id))
            })?;
            if !verb_ids.insert(verb.id.clone()) {
                return inv(format!(
                    "duplicate verb id {:?} on template {:?}",
                    verb.id, tpl.id
                ));
            }
            non_empty_name(&verb.name)?;
            if has_bad_inline_control(&verb.name) || has_bad_multiline_control(&verb.description) {
                return inv(format!("verb {:?} contains control characters", verb.id));
            }
        }

        validate_level_settings(
            &tpl.settings,
            &raw_tpl_ids_hint(&val.templates),
            &val.entries,
        )?;
    }

    // Build domain `EntryTemplate` map (now that symbolic home refs on templates are verified).
    let mut templates: BTreeMap<EntryTemplateId, EntryTemplate> = BTreeMap::new();
    let tpl_specs: BTreeMap<&str, &super::TemplateEntryTemplate> =
        val.templates.iter().map(|t| (t.id.as_str(), t)).collect();
    for tpl in &val.templates {
        for module in &tpl.modules {
            for def in &module.config.defs {
                if let Some(tt) = &def.target_template {
                    let ttid = EntryTemplateId::parse(tt).map_err(|e| {
                        ProjectTemplateError::Invalid(format!("field target_template: {e}"))
                    })?;
                    if !raw_tpl_ids.contains(&ttid) {
                        return inv(format!(
                            "field {:?} target_template {tt:?} does not exist in templates",
                            def.id
                        ));
                    }
                }
                if let Some(dv) = &def.default_value {
                    validate_field_value(def, dv, &val.entries)?;
                }
            }
        }
        for verb in &tpl.verbs {
            if let Some(tt) = &verb.target_template {
                let ttid = EntryTemplateId::parse(tt).map_err(|e| {
                    ProjectTemplateError::Invalid(format!("verb target_template: {e}"))
                })?;
                if !raw_tpl_ids.contains(&ttid) {
                    return inv(format!(
                        "verb {:?} target_template {tt:?} does not exist in templates",
                        verb.id
                    ));
                }
            }
        }
        let domain_tpl = tpl
            .to_domain(&dummy_entry_map)
            .map_err(ProjectTemplateError::Invalid)?;
        templates.insert(domain_tpl.id.clone(), domain_tpl);
    }

    // 3. Validate `relation_types`.
    let mut rt_names = BTreeSet::new();
    for rt in &val.relation_types {
        non_empty_name(&rt.name)?;
        if has_bad_inline_control(&rt.name) || has_bad_multiline_control(&rt.description.text) {
            return inv(format!(
                "relation {:?} contains control characters",
                rt.name
            ));
        }
        if !rt_names.insert(normalize_relation_type_name(&rt.name)) {
            return inv(format!("duplicate relation name {:?}", rt.name));
        }
        rt.description.validate()?;
        for link in &rt.description.links {
            if !entry_sym_set.contains(link.entry.as_str()) {
                return inv(format!(
                    "relation {:?} links to an unknown symbolic entry",
                    rt.name
                ));
            }
        }
    }

    // 4. Validate `entries` (structure, fields, kv, arrangements, prose).
    let mut entries: BTreeMap<EntryId, Entry> = BTreeMap::new();
    for entry in &val.entries {
        non_empty_name(&entry.title)?;
        if has_bad_inline_control(&entry.title) {
            return inv(format!(
                "entry {:?} title contains control characters",
                entry.sym_ref
            ));
        }
        if let Some(mark) = &entry.mark
            && !is_valid_mark(mark)
        {
            return inv(format!(
                "entry {:?} has invalid mark {mark:?}",
                entry.sym_ref
            ));
        }
        let tpl_id = entry
            .template
            .as_deref()
            .map(EntryTemplateId::parse)
            .transpose()
            .map_err(|e| {
                ProjectTemplateError::Invalid(format!("entry {:?} template id: {e}", entry.sym_ref))
            })?;
        check_entry_template(&templates, tpl_id.as_ref())?;

        let parent_id = match &entry.parent {
            None => None,
            Some(p) => {
                if !is_symbolic_entry_ref(p) || !entry_sym_set.contains(p) {
                    return inv(format!(
                        "entry {:?} parent {:?} does not resolve to an entry in templates",
                        entry.sym_ref, p
                    ));
                }
                Some(dummy_entry_map[p].clone())
            }
        };

        let overrides = match &entry.overrides {
            None => None,
            Some(ov) => {
                validate_level_settings(ov, &raw_tpl_ids_hint(&val.templates), &val.entries)?;
                Some(
                    ov.to_domain(&dummy_entry_map)
                        .map_err(ProjectTemplateError::Invalid)?,
                )
            }
        };

        validate_entry_modules(
            entry,
            tpl_specs
                .get(entry.template.as_deref().unwrap_or(""))
                .copied(),
            &val.entries,
            &templates,
        )?;

        let mut domain_fields = BTreeMap::new();
        let active_tpl = tpl_id.as_ref().and_then(|t| templates.get(t));
        for (mod_str, fmap) in &entry.fields {
            let mid = ModuleId::parse(mod_str)
                .map_err(|e| ProjectTemplateError::Invalid(e.to_string()))?;
            let mut df = BTreeMap::new();
            for (fid, fv) in fmap {
                let is_eref = active_tpl
                    .and_then(|t| t.module(&mid))
                    .and_then(|m| m.config.defs.iter().find(|d| &d.id == fid))
                    .is_some_and(|d| d.field_type == crate::v3::FieldType::EntityRef);
                let dv = if is_eref {
                    super::rewrite_entity_ref_value(fv, &dummy_entry_map)
                        .map_err(ProjectTemplateError::Invalid)?
                } else {
                    fv.clone()
                };
                df.insert(fid.clone(), dv);
            }
            domain_fields.insert(mid, df);
        }

        let eid = dummy_entry_map[&entry.sym_ref].clone();
        entries.insert(
            eid.clone(),
            Entry {
                id: eid,
                parent: parent_id,
                pos: String::new(),
                title: entry.title.trim().to_owned(),
                mark: entry.mark.clone(),
                template: tpl_id,
                level: entry.level,
                overrides,
                fields: domain_fields,
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

    // Check parent-is-level and no-cycles across all entries.
    for entry in &val.entries {
        let eid = &dummy_entry_map[&entry.sym_ref];
        let parent = entries[eid].parent.as_ref();
        check_parent_is_level(parent, &entries)?;
        check_entry_move(&entries, eid, parent)?;
    }

    // 5. Validate `memberships` and primary host assignments.
    let mut seen_memberships = BTreeSet::new();
    let mut seen_primary_for_member = BTreeSet::new();
    let mut domain_memberships = Vec::with_capacity(val.memberships.len());
    let mut m_pos = PosKey::first();
    for (idx, m) in val.memberships.iter().enumerate() {
        if idx > 0 {
            m_pos = m_pos.after();
        }
        if !is_symbolic_entry_ref(&m.host) || !entry_sym_set.contains(&m.host) {
            return inv(format!(
                "membership host {:?} does not resolve to an included entry",
                m.host
            ));
        }
        if !is_symbolic_entry_ref(&m.member) || !entry_sym_set.contains(&m.member) {
            return inv(format!(
                "membership member {:?} does not resolve to an included entry",
                m.member
            ));
        }
        if !seen_memberships.insert((m.host.clone(), m.member.clone())) {
            return inv(format!(
                "duplicate membership ({:?}, {:?})",
                m.host, m.member
            ));
        }
        let host_id = &dummy_entry_map[&m.host];
        let member_id = &dummy_entry_map[&m.member];
        check_membership(host_id, member_id, &entries, &templates)?;
        if m.primary {
            if !seen_primary_for_member.insert(m.member.clone()) {
                return inv(format!(
                    "entry {:?} has more than one primary membership",
                    m.member
                ));
            }
            if let Some(ent) = entries.get_mut(member_id) {
                ent.primary = Some(host_id.clone());
            }
        }
        domain_memberships.push(Membership {
            host: host_id.clone(),
            member: member_id.clone(),
            pos: Some(m_pos.clone()),
            created_at: None,
        });
    }

    // 6. Validate `views` (lanes, placements, pins). A lane takes entries
    // from elsewhere (`V3-TIMELINE-LANE-ENABLED`, DV 2026-11-16).
    let mut v_pos = PosKey::first();
    for (v_idx, v) in val.views.iter().enumerate() {
        if v_idx > 0 {
            v_pos = v_pos.after();
        }
        non_empty_name(&v.name)?;
        if has_bad_inline_control(&v.name) {
            return inv(format!(
                "view {:?} name contains control characters",
                v.sym_ref
            ));
        }
        let vid = TimelineViewId::parse(&v.sym_ref)
            .map_err(|e| ProjectTemplateError::Invalid(e.to_string()))?;

        let mut seen_lanes = BTreeSet::new();
        let mut lanes = Vec::with_capacity(v.lanes.len());
        let mut l_pos = PosKey::first();
        for (l_idx, lane) in v.lanes.iter().enumerate() {
            if l_idx > 0 {
                l_pos = l_pos.after();
            }
            if !is_symbolic_entry_ref(&lane.entry) || !entry_sym_set.contains(&lane.entry) {
                return inv(format!(
                    "view {:?} lane {:?} does not resolve to an included entry",
                    v.sym_ref, lane.entry
                ));
            }
            if !seen_lanes.insert(lane.entry.clone()) {
                return inv(format!(
                    "duplicate lane {:?} in view {:?}",
                    lane.entry, v.sym_ref
                ));
            }
            let lane_eid = &dummy_entry_map[&lane.entry];
            check_timeline_lane(lane_eid, &entries, &templates)?;
            lanes.push(TimelineLane {
                entry: lane_eid.clone(),
                pos: Some(l_pos.clone()),
                act_track: lane.act_track,
            });
        }

        let mut temp_view = TimelineView {
            id: vid,
            name: v.name.trim().to_owned(),
            pos: Some(v_pos.clone()),
            lanes,
            placements: Vec::new(),
            pins: Vec::new(),
            deleted_at: None,
        };

        let mut seen_placements = BTreeSet::new();
        for p in &v.placements {
            if !is_symbolic_entry_ref(&p.entry) || !entry_sym_set.contains(&p.entry) {
                return inv(format!(
                    "view {:?} placement {:?} does not resolve to an included entry",
                    v.sym_ref, p.entry
                ));
            }
            if !seen_placements.insert(p.entry.clone()) {
                return inv(format!(
                    "duplicate placement for {:?} in view {:?}",
                    p.entry, v.sym_ref
                ));
            }
            if !p.at.is_finite() {
                return inv(format!("non-finite placement `at` in view {:?}", v.sym_ref));
            }
            if let Some(span) = p.span
                && (!span.is_finite() || span < 0.0)
            {
                return inv(format!("invalid placement `span` in view {:?}", v.sym_ref));
            }
            let peid = &dummy_entry_map[&p.entry];
            check_timeline_placement_in_lane(
                &temp_view,
                peid,
                &domain_memberships,
                &entries,
                &templates,
            )?;
            temp_view.placements.push(TimelinePlacement {
                entry: peid.clone(),
                at: p.at,
                span: p.span,
            });
        }

        for (pin_idx, pin) in v.pins.iter().enumerate() {
            if !pin.at.is_finite() {
                return inv(format!("non-finite pin `at` in view {:?}", v.sym_ref));
            }
            non_empty_name(&pin.label)?;
            if has_bad_inline_control(&pin.label) {
                return inv(format!(
                    "pin label in view {:?} contains control characters",
                    v.sym_ref
                ));
            }
            if let Some(color) = &pin.color
                && (color.trim().is_empty() || has_bad_inline_control(color))
            {
                return inv(format!("pin in view {:?} has invalid color", v.sym_ref));
            }
            let pin_entry = match &pin.entry {
                None => None,
                Some(sym) => {
                    if !is_symbolic_entry_ref(sym) || !entry_sym_set.contains(sym) {
                        return inv(format!(
                            "pin in view {:?} references unknown entry {sym:?}",
                            v.sym_ref
                        ));
                    }
                    let peid = dummy_entry_map[sym].clone();
                    check_timeline_target_live(&peid, &entries)?;
                    Some(peid)
                }
            };
            temp_view.pins.push(TimelinePin {
                id: TimePinId::parse(&format!("pin-{}", pin_idx + 1)).expect("valid pin id"),
                at: pin.at,
                label: pin.label.trim().to_owned(),
                color: pin.color.clone(),
                entry: pin_entry,
            });
        }
    }

    // 7. Validate `project.book` and `project.tabs`.
    let has_book = val.project.book.is_some();
    if let Some(book) = &val.project.book
        && (book.word_target.is_some_and(|n| n < 0)
            || book.daily_word_target.is_some_and(|n| n < 0))
    {
        return inv("project.book word targets cannot be negative");
    }

    let mut mounted: Vec<&TemplateTabMount> = Vec::with_capacity(val.project.tabs.len());
    for tab in &val.project.tabs {
        let mount = &tab.mount;
        if mounted.contains(&mount) {
            return inv(format!(
                "tab mount {mount:?} appears twice: one tab per thing"
            ));
        }
        mounted.push(mount);
        let domain_mount = match mount {
            TemplateTabMount::Root => TabMount::Root,
            TemplateTabMount::Book => TabMount::Book,
            TemplateTabMount::Entry { entry } => {
                if !is_symbolic_entry_ref(entry) || !entry_sym_set.contains(entry) {
                    return inv(format!(
                        "tab mount entry {entry:?} does not resolve to an included entry"
                    ));
                }
                TabMount::Entry {
                    entry: dummy_entry_map[entry].clone(),
                }
            }
        };
        check_tab_mount(&domain_mount, has_book, &entries, &templates)?;
    }

    // 8. Validate `template_prose`.
    for (key, paragraphs) in &val.template_prose {
        let Some((tpl_str, mod_str)) = key.split_once('/') else {
            return inv(format!(
                "template_prose key {key:?} must be \"<template_id>/<module_id>\""
            ));
        };
        let Ok(tid) = EntryTemplateId::parse(tpl_str) else {
            return inv(format!("invalid template id in template_prose key {key:?}"));
        };
        let Ok(mid) = ModuleId::parse(mod_str) else {
            return inv(format!("invalid module id in template_prose key {key:?}"));
        };
        let Some(tpl) = templates.get(&tid) else {
            return inv(format!(
                "template_prose key {key:?} references unknown template {tpl_str:?}"
            ));
        };
        let Some(mspec) = tpl.module(&mid) else {
            return inv(format!(
                "template_prose key {key:?} references unknown module {mod_str:?}"
            ));
        };
        if mspec.kind != ModuleKind::Prose {
            return inv(format!(
                "template_prose key {key:?} references non-prose module {mod_str:?}"
            ));
        }
        validate_paragraphs(paragraphs, &val.entries, &templates)?;
    }

    // 9. Validate structural graph rules (`V3-AUTOLINK-NAME-UNIQUE`).
    let empty_entries = BTreeMap::new();
    let empty_templates = BTreeMap::new();
    check_new_violations(
        BookGraph {
            entries: &empty_entries,
            templates: &empty_templates,
        },
        BookGraph {
            entries: &entries,
            templates: &templates,
        },
    )?;

    Ok(())
}

fn validate_credit(credit: &ProjectTemplateCredit) -> Result<(), ProjectTemplateError> {
    if has_bad_inline_control(&credit.author) {
        return inv("credit.author contains control characters");
    }
    Ok(())
}

fn count_agent_chars(val: &ProjectTemplateValue) -> usize {
    let mut total = 0usize;
    if let Some(pa) = &val.project.agent {
        total += pa.name.chars().count()
            + pa.description.chars().count()
            + pa.instructions.chars().count();
    }
    for tpl in &val.templates {
        if let Some(ta) = &tpl.agent {
            total += ta.name.chars().count()
                + ta.description.chars().count()
                + ta.instructions.chars().count();
        }
        for module in &tpl.modules {
            if let Some(ma) = &module.agent {
                total += ma.instructions.chars().count();
            }
        }
        for verb in &tpl.verbs {
            total += verb.name.chars().count() + verb.description.chars().count();
        }
    }
    total
}

fn raw_tpl_ids_hint(templates: &[super::TemplateEntryTemplate]) -> BTreeSet<&str> {
    templates.iter().map(|t| t.id.as_str()).collect()
}

fn validate_level_settings(
    s: &TemplateLevelSettings,
    tpl_ids: &BTreeSet<&str>,
    entries: &[TemplateEntry],
) -> Result<(), ProjectTemplateError> {
    if let Some(Some(tid)) = &s.default_template
        && !tpl_ids.contains(tid.as_str())
    {
        return inv(format!(
            "settings.default_template {tid:?} does not exist in templates"
        ));
    }
    if let Some(Some(home_ref)) = &s.home {
        if !is_symbolic_entry_ref(home_ref) {
            return inv(format!(
                "settings.home {home_ref:?} must be a symbolic entry ref"
            ));
        }
        let Some(target) = entries.iter().find(|e| &e.sym_ref == home_ref) else {
            return inv(format!(
                "settings.home {home_ref:?} does not resolve to an included entry"
            ));
        };
        if !target.level {
            return inv(format!(
                "settings.home {home_ref:?} must point to an entry with level == true"
            ));
        }
    }
    Ok(())
}

fn validate_field_value(
    def: &TemplateFieldDef,
    value: &FieldValue,
    entries: &[TemplateEntry],
) -> Result<(), ProjectTemplateError> {
    use TemplateFieldType as T;
    if matches!(value, FieldValue::Null) {
        return Ok(());
    }
    let ok = match (def.field_type, value) {
        (T::Text, FieldValue::Text(s)) => !has_bad_inline_control(s),
        (T::LongText, FieldValue::Text(s)) => !has_bad_multiline_control(s),
        (T::Date, FieldValue::Text(s)) => s.is_ascii() && Day::parse(s).is_some(),
        (T::Number, FieldValue::Number(n)) => n.is_finite(),
        (T::Toggle, FieldValue::Bool(_)) => true,
        (T::Select, FieldValue::Text(s)) => def.options.contains(s),
        (T::MultiSelect, FieldValue::List(xs)) => xs.iter().all(|s| def.options.contains(s)),
        (T::Aliases, FieldValue::List(xs)) => xs.iter().all(|s| !has_bad_inline_control(s)),
        (T::EntityRef, FieldValue::Text(sym)) => {
            if !is_symbolic_entry_ref(sym) {
                return inv(format!(
                    "field {:?} entity_ref {sym:?} must be a symbolic entry ref (not a real ID)",
                    def.id
                ));
            }
            let Some(target) = entries.iter().find(|e| &e.sym_ref == sym) else {
                return inv(format!(
                    "field {:?} entity_ref {sym:?} does not resolve to an included entry",
                    def.id
                ));
            };
            if let Some(tt) = &def.target_template
                && target.template.as_deref() != Some(tt.as_str())
            {
                return inv(format!(
                    "field {:?} entity_ref {sym:?} does not match target_template {tt:?}",
                    def.id
                ));
            }
            true
        }
        (T::Image, _) => {
            return inv(format!(
                "field {:?} is an image field; Phase 1 project templates do not carry file IDs",
                def.id
            ));
        }
        _ => false,
    };
    if !ok {
        return inv(format!(
            "invalid value for field {:?} of type {:?}",
            def.id, def.field_type
        ));
    }
    Ok(())
}

fn validate_entry_modules(
    entry: &TemplateEntry,
    tpl: Option<&super::TemplateEntryTemplate>,
    all_entries: &[TemplateEntry],
    domain_templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Result<(), ProjectTemplateError> {
    let Some(tpl) = tpl else {
        if !entry.fields.is_empty()
            || !entry.kv.is_empty()
            || !entry.arrangements.is_empty()
            || !entry.prose.is_empty()
        {
            return inv(format!(
                "untemplated entry {:?} cannot carry module data",
                entry.sym_ref
            ));
        }
        return Ok(());
    };

    for (mod_id, fmap) in &entry.fields {
        let Some(mspec) = tpl.modules.iter().find(|m| &m.id == mod_id) else {
            return inv(format!(
                "entry {:?} fields references unknown module {mod_id:?}",
                entry.sym_ref
            ));
        };
        if mspec.kind != TemplateModuleKind::Fields {
            return inv(format!(
                "entry {:?} fields references non-fields module {mod_id:?}",
                entry.sym_ref
            ));
        }
        for (fid, fv) in fmap {
            let Some(def) = mspec.config.defs.iter().find(|d| &d.id == fid) else {
                return inv(format!(
                    "entry {:?} fields.{mod_id} references undefined field {fid:?}",
                    entry.sym_ref
                ));
            };
            validate_field_value(def, fv, all_entries)?;
        }
    }

    for (mod_id, rows) in &entry.kv {
        let Some(mspec) = tpl.modules.iter().find(|m| &m.id == mod_id) else {
            return inv(format!(
                "entry {:?} kv references unknown module {mod_id:?}",
                entry.sym_ref
            ));
        };
        if mspec.kind != TemplateModuleKind::KeyValue {
            return inv(format!(
                "entry {:?} kv references non-kv module {mod_id:?}",
                entry.sym_ref
            ));
        }
        for row in rows {
            non_empty_name(&row.key)?;
            if has_bad_inline_control(&row.key) || has_bad_multiline_control(&row.value) {
                return inv(format!(
                    "entry {:?} kv.{mod_id} contains control characters",
                    entry.sym_ref
                ));
            }
        }
    }

    for mod_id in entry.arrangements.keys() {
        let Some(mspec) = tpl.modules.iter().find(|m| &m.id == mod_id) else {
            return inv(format!(
                "entry {:?} arrangements references unknown module {mod_id:?}",
                entry.sym_ref
            ));
        };
        if mspec.kind != TemplateModuleKind::Media {
            return inv(format!(
                "entry {:?} arrangements references non-media module {mod_id:?}",
                entry.sym_ref
            ));
        }
    }

    for (mod_id, paragraphs) in &entry.prose {
        let Some(mspec) = tpl.modules.iter().find(|m| &m.id == mod_id) else {
            return inv(format!(
                "entry {:?} prose references unknown module {mod_id:?}",
                entry.sym_ref
            ));
        };
        if mspec.kind != TemplateModuleKind::Prose {
            return inv(format!(
                "entry {:?} prose references non-prose module {mod_id:?}",
                entry.sym_ref
            ));
        }
        validate_paragraphs(paragraphs, all_entries, domain_templates)?;
    }

    Ok(())
}

fn validate_paragraphs(
    paragraphs: &[TemplateParagraph],
    entries: &[TemplateEntry],
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Result<(), ProjectTemplateError> {
    for p in paragraphs {
        if let Some(table) = &p.table {
            if !p.attrs.is_plain() || !p.runs.is_empty() {
                return inv("table paragraph cannot carry block attrs or text runs");
            }
            validate_table(table, entries, templates)?;
        } else {
            validate_block_attrs(&p.attrs, p.runs.is_empty())?;
            validate_runs(&p.runs, entries, templates)?;
        }
    }
    Ok(())
}

fn validate_block_attrs(
    attrs: &TemplateBlockAttrs,
    is_empty_text: bool,
) -> Result<(), ProjectTemplateError> {
    if let Some(h) = attrs.heading
        && !(1..=3).contains(&h)
    {
        return inv(format!("invalid heading level {h} (expected 1, 2 or 3)"));
    }
    if attrs.indent > MAX_INDENT {
        return inv(format!(
            "paragraph indent {} exceeds maximum {}",
            attrs.indent, MAX_INDENT
        ));
    }
    if attrs.rule && !is_empty_text {
        return inv("horizontal rule paragraph cannot contain text");
    }
    if let Some(lang) = &attrs.code_block
        && has_bad_inline_control(lang)
    {
        return inv("code_block language contains control characters");
    }
    if let Some(callout) = &attrs.callout
        && (callout.trim().is_empty() || has_bad_inline_control(callout))
    {
        return inv("invalid callout kind");
    }
    Ok(())
}

fn validate_table(
    table: &TemplateTable,
    entries: &[TemplateEntry],
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Result<(), ProjectTemplateError> {
    if table.cols == 0 || table.cols > 64 {
        return inv(format!(
            "table cols must be between 1 and 64 (found {})",
            table.cols
        ));
    }
    if table.rows.is_empty() || table.rows.len() > 1_000 {
        return inv(format!(
            "table rows must be between 1 and 1000 (found {})",
            table.rows.len()
        ));
    }
    for row in &table.rows {
        if row.len() != table.cols as usize {
            return inv(format!(
                "table row has {} cells, expected {}",
                row.len(),
                table.cols
            ));
        }
        for cell_runs in row {
            validate_runs(cell_runs, entries, templates)?;
        }
    }
    Ok(())
}

fn validate_runs(
    runs: &[TemplateRun],
    entries: &[TemplateEntry],
    templates: &BTreeMap<EntryTemplateId, EntryTemplate>,
) -> Result<(), ProjectTemplateError> {
    for r in runs {
        if r.text.is_empty() {
            return inv("text run cannot be empty");
        }
        if r.text.contains(PARAGRAPH_END) || r.text.contains(OBJECT_CHAR) {
            return inv("text run cannot contain paragraph breaks or embed placeholders");
        }
        if r.text.chars().any(|c| c.is_control() && c != '\t') {
            return inv("text run contains disallowed control characters");
        }
        if let Some(link) = &r.link
            && (link.trim().is_empty() || has_bad_inline_control(link))
        {
            return inv("inline link URL cannot be empty or contain control characters");
        }
        if let Some(hl) = &r.highlight
            && (hl.trim().is_empty() || has_bad_inline_control(hl))
        {
            return inv("inline highlight cannot be empty or contain control characters");
        }
        let mut seen_targets = BTreeSet::new();
        for el in &r.entities {
            if !is_symbolic_entry_ref(&el.entry) {
                return inv(format!(
                    "prose entity link {:?} must use a symbolic entry ref (real entry or file IDs are not allowed)",
                    el.entry
                ));
            }
            let Some(target) = entries.iter().find(|e| e.sym_ref == el.entry) else {
                return inv(format!(
                    "prose entity link {:?} does not resolve to an included entry",
                    el.entry
                ));
            };
            if !seen_targets.insert(el.entry.clone()) {
                return inv(format!(
                    "duplicate entity link to {:?} on one run",
                    el.entry
                ));
            }
            if let Some(mod_str) = &el.module {
                let mid = ModuleId::parse(mod_str).map_err(|e| {
                    ProjectTemplateError::Invalid(format!("entity link module: {e}"))
                })?;
                let has_prose_mod = target
                    .template
                    .as_deref()
                    .and_then(|t| EntryTemplateId::parse(t).ok())
                    .and_then(|tid| templates.get(&tid))
                    .and_then(|tpl| tpl.module(&mid))
                    .is_some_and(|m| m.kind == ModuleKind::Prose);
                if !has_prose_mod {
                    return inv(format!(
                        "prose entity link {:?} references non-existent prose module {mod_str:?}",
                        el.entry
                    ));
                }
            }
        }
    }
    Ok(())
}
