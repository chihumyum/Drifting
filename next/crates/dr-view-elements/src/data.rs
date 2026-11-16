//! Canonical v3 level surface.
pub mod v3 {
    use std::cmp::Ordering;

    use dr_shell::{book::Book, pages::PageViewHost};
    use dr_workspace::{Actor, EffectAction, RecordKey, Workspace, WritePreconditions, WsError};
    use serde_json::{Value, json};

    pub fn fresh(host: &PageViewHost, cx: &gpui::App) -> Option<PageViewHost> {
        let ws = host.workspace.upgrade()?;
        let ws = ws.read(cx);
        if ws.book_id != host.book_id
            || ws.book.id != host.book_id
            || host.book.id != host.book_id
            || ws.book.v3().is_none()
            || !ws
                .library
                .as_ref()
                .is_some_and(|lib| std::ptr::eq(lib.library(), host.library.library()))
        {
            return None;
        }
        Some(PageViewHost {
            book: ws.book.clone(),
            ..host.clone()
        })
    }
    /// A sendable edit prepared from the exact snapshot shown to the author.
    pub struct Mutation {
        command: &'static str,
        input: Value,
        preconditions: WritePreconditions,
    }
    impl Mutation {
        pub fn commit(self, lib: &Workspace) -> Result<Value, WsError> {
            self.commit_answer(lib)
                .map(|answer| answer["output"].clone())
        }
        /// [`Mutation::commit`], returning the command's whole answer (its
        /// `journal` row too, for a notice's 「撤销」).
        pub fn commit_answer(self, lib: &Workspace) -> Result<Value, WsError> {
            lib.call_guarded(&Actor::User, self.command, self.input, self.preconditions)
        }
    }
    pub fn prepare(
        book: &Book,
        command: &'static str,
        mut input: Value,
    ) -> Result<Mutation, WsError> {
        let v = book
            .v3()
            .ok_or_else(|| WsError::Invalid("a book of the current format is required".into()))?;
        // Held to the records of this snapshot that the command replaces,
        // and to the entries, levels and templates its input names: what
        // the author was shown when choosing it. A change elsewhere in the
        // book is not a conflict.
        let preconditions = WritePreconditions {
            require_all: false,
            ..v.guard_for(&input)
        };
        input
            .as_object_mut()
            .ok_or_else(|| WsError::Invalid("object input required".into()))?
            .insert("book".into(), json!(book.id));
        Ok(Mutation {
            command,
            input,
            preconditions,
        })
    }
    pub fn prepare_edit(book: &Book, id: &str, mut changes: Value) -> Result<Mutation, WsError> {
        let v = book
            .v3()
            .ok_or_else(|| WsError::Invalid("a book of the current format is required".into()))?;
        if v.entry(id).is_none() {
            return Err(WsError::Invalid("entry is no longer live".into()));
        }
        let map = changes
            .as_object_mut()
            .ok_or_else(|| WsError::Invalid("entry changes required".into()))?;
        map.insert("id".into(), json!(id));
        prepare(book, "entry.update", changes)
    }
    pub fn prepare_override(
        book: &Book,
        id: &str,
        key: &str,
        value: Option<Value>,
    ) -> Result<Mutation, WsError> {
        if ![
            "default_template",
            "display",
            "auto_link",
            "accept",
            "home",
            "format_shortcuts",
        ]
        .contains(&key)
        {
            return Err(WsError::Invalid("unknown level setting".into()));
        }
        let v = book
            .v3()
            .ok_or_else(|| WsError::Invalid("a book of the current format is required".into()))?;
        let entry = v
            .entry(id)
            .filter(|_| v.has_below(id) || matches!(key, "accept" | "home"))
            .ok_or_else(|| WsError::Invalid("level is no longer live".into()))?;
        let mut overrides = entry
            .overrides
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|e| WsError::Internal(e.to_string()))?
            .unwrap_or(json!({}));
        let map = overrides.as_object_mut().expect("level settings object");
        if let Some(value) = value {
            map.insert(key.into(), value);
        } else {
            map.remove(key);
        }
        prepare_edit(book, id, json!({"overrides":overrides}))
    }
    use dr_model::v3 as model;
    use std::collections::BTreeMap;

    struct Graph {
        entries: BTreeMap<model::EntryId, model::Entry>,
        templates: BTreeMap<model::EntryTemplateId, model::EntryTemplate>,
    }
    impl Graph {
        fn of(book: &Book) -> Option<Self> {
            let v = book.v3()?;
            let entries: Vec<model::Entry> =
                serde_json::from_value(serde_json::to_value(&v.entries).ok()?).ok()?;
            let templates: Vec<model::EntryTemplate> =
                serde_json::from_value(serde_json::to_value(&v.templates).ok()?).ok()?;
            Some(Self {
                entries: entries.into_iter().map(|e| (e.id.clone(), e)).collect(),
                templates: templates.into_iter().map(|t| (t.id.clone(), t)).collect(),
            })
        }
    }
    pub struct Creation {
        pub context: Option<String>,
        pub home: Option<String>,
        pub templates: Vec<String>,
        pub default: Option<String>,
        /// entry.create's absent template means the context default. It can
        /// create a blank entry only when that default is itself absent.
        pub blank: bool,
        /// The new entry is attached to `context` (`entry.create` with
        /// `host`) rather than living under it (`parent`): `context` takes
        /// entries from elsewhere and is not a level. Creating on an entry
        /// that takes entries from elsewhere always attaches (`kernel-v5.md`
        /// §16 「挂到一个条目上新建时一定挂名」).
        pub attach: bool,
    }
    pub fn creation(book: &Book, origin: &str) -> Option<Creation> {
        let v = book.v3()?;
        v.entry(origin)?;
        let graph = Graph::of(book)?;
        let id = origin.parse().ok()?;
        let origin_entry = graph.entries.get(&id)?;
        let context = if origin_entry.has_below(&graph.templates) {
            Some(id)
        } else {
            model::effective_parent_id(origin_entry, &graph.entries)
        };
        let is_host_only = context
            .as_ref()
            .and_then(|cid| graph.entries.get(cid))
            .is_some_and(|e| !e.is_level() && e.accepts_members(&graph.templates));
        let home = match &context {
            Some(cid) if is_host_only => {
                model::resolve_host_residence(cid, &graph.entries, &graph.templates)
            }
            Some(cid) => Some(cid.clone()),
            None => None,
        };
        // Any template can be created where an entry can live at all.
        let allows = |_: Option<&model::EntryTemplateId>| {
            model::check_parent_is_level(home.as_ref(), &graph.entries).is_ok()
                && (is_host_only
                    || model::check_parent_is_level(context.as_ref(), &graph.entries).is_ok())
        };
        let templates: Vec<String> = v
            .templates
            .iter()
            .filter(|t| t.deleted_at.is_none())
            .filter(|t| t.id.parse().ok().is_some_and(|id| allows(Some(&id))))
            .map(|t| t.id.clone())
            .collect();
        let desired = context
            .as_ref()
            .and_then(|cid| {
                model::resolve_level_settings(Some(cid), &graph.entries, &graph.templates)
                    .default_template
            })
            .map(|t| t.to_string());
        let blank = desired.is_none() && allows(None);
        let default = desired.filter(|id| templates.contains(id));
        Some(Creation {
            context: context.map(|id| id.to_string()),
            home: home.map(|id| id.to_string()),
            templates,
            default,
            blank,
            attach: is_host_only,
        })
    }
    /// What a new entry attached to `origin` can be (`entry.create` with
    /// `host`, `kernel-v5.md` §16 「新建」): it lives where `origin`'s
    /// 「新条目住在」 says, under `origin` when that is unset or can no
    /// longer hold entries and `origin` is a level, else at the root.
    pub fn creation_attached(book: &Book, origin: &str) -> Option<Creation> {
        let v = book.v3()?;
        v.entry(origin)?;
        let graph = Graph::of(book)?;
        let id = origin.parse().ok()?;
        if !graph.entries.get(&id)?.accepts_members(&graph.templates) {
            return None;
        }
        let home = model::resolve_host_residence(&id, &graph.entries, &graph.templates);
        let allows = model::check_parent_is_level(home.as_ref(), &graph.entries).is_ok();
        let templates: Vec<String> = v
            .templates
            .iter()
            .filter(|t| allows && t.deleted_at.is_none())
            .map(|t| t.id.clone())
            .collect();
        let desired = model::resolve_level_settings(Some(&id), &graph.entries, &graph.templates)
            .default_template
            .map(|t| t.to_string());
        let blank = desired.is_none() && allows;
        let default = desired.filter(|id| templates.contains(id));
        Some(Creation {
            context: Some(origin.to_owned()),
            home: home.map(|id| id.to_string()),
            templates,
            default,
            blank,
            attach: true,
        })
    }
    pub fn switch_templates(book: &Book, entry: &str) -> Vec<String> {
        let Some(v) = book.v3() else { return vec![] };
        let Some(graph) = Graph::of(book) else {
            return vec![];
        };
        let Ok(entry_id) = entry.parse() else {
            return vec![];
        };
        v.templates
            .iter()
            .filter(|t| t.deleted_at.is_none())
            .filter(|t| {
                let Ok(id) = t.id.parse() else { return false };
                if model::check_entry_template(&graph.templates, Some(&id)).is_err() {
                    return false;
                }
                let mut entries = graph.entries.clone();
                let Some(e) = entries.get_mut(&entry_id) else {
                    return false;
                };
                e.template = Some(id);
                // Preserve every relationship active in the displayed snapshot.
                // Dormant raw records remain untouched by entry.update.
                if v.memberships.iter().any(|m| {
                    let (Ok(host), Ok(member)) = (m.host.parse(), m.member.parse()) else {
                        return true;
                    };
                    model::check_membership(&host, &member, &entries, &graph.templates).is_err()
                }) {
                    return false;
                }
                if v.timeline_views
                    .iter()
                    .flat_map(|v| &v.lanes)
                    .any(|l| l.entry == entry)
                    && model::check_timeline_lane(&entry_id, &entries, &graph.templates).is_err()
                {
                    return false;
                }
                true
            })
            .map(|t| t.id.clone())
            .collect()
    }
    pub fn membership_hosts(book: &Book, entry: &str) -> Vec<String> {
        let Some(v) = book.v3() else { return vec![] };
        let Some(graph) = Graph::of(book) else {
            return vec![];
        };
        let Ok(member) = entry.parse() else {
            return vec![];
        };
        v.entries
            .iter()
            .filter(|e| {
                e.id.parse().ok().is_some_and(|host| {
                    model::check_membership(&host, &member, &graph.entries, &graph.templates)
                        .is_ok()
                })
            })
            .map(|e| e.id.clone())
            .collect()
    }
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub enum SortOrder {
        #[default]
        Manual,
        Updated,
        Created,
        Name,
    }

    impl SortOrder {
        pub const ALL: [Self; 4] = [Self::Manual, Self::Updated, Self::Created, Self::Name];

        pub fn as_str(self) -> &'static str {
            match self {
                Self::Manual => "manual",
                Self::Updated => "updated",
                Self::Created => "created",
                Self::Name => "name",
            }
        }

        pub fn parse(value: &str) -> Option<Self> {
            match value {
                "manual" => Some(Self::Manual),
                "updated" => Some(Self::Updated),
                "created" => Some(Self::Created),
                "name" => Some(Self::Name),
                _ => None,
            }
        }

        pub fn index(self) -> usize {
            match self {
                Self::Manual => 0,
                Self::Updated => 1,
                Self::Created => 2,
                Self::Name => 3,
            }
        }

        pub fn from_index(index: usize) -> Self {
            Self::ALL.get(index).copied().unwrap_or(Self::Manual)
        }
    }

    pub fn sort_memory_key(level: &str) -> String {
        format!("v3.level.sort.{level}")
    }

    pub type UpdatedMap = BTreeMap<String, (i64, i64)>;

    /// Per-entry last-modified `(ts_ms, seq)` derived locally from stored
    /// entry timestamps, prose document heads and live journal mutations.
    /// Moving an entry (`EffectAction::Moved`) does not bump its modified time.
    pub fn updated_timestamps(lib: &Workspace, book: &Book) -> UpdatedMap {
        let Some(v) = book.v3() else {
            return BTreeMap::new();
        };
        let mut out = UpdatedMap::new();
        let mut record = |id: &str, stamp: (i64, i64)| {
            out.entry(id.to_owned())
                .and_modify(|cur| {
                    if stamp > *cur {
                        *cur = stamp;
                    }
                })
                .or_insert(stamp);
        };
        for e in &v.entries {
            if let Some(ts) = e.updated_at.or(e.created_at) {
                record(&e.id, (ts.saturating_mul(1000), 0));
            }
        }
        if let Ok(docs) = lib.library().docs(Some(&book.id), Some("body")) {
            for info in docs {
                let Ok(dr_model::DocId::Body(body)) = dr_model::DocId::parse(&info.doc_id) else {
                    continue;
                };
                let owner = body.entry().as_str();
                if v.entry(owner).is_some()
                    && let Ok(Some(head)) = lib.library().head(&info.doc_id)
                {
                    record(owner, (head.ts, head.seq));
                }
            }
        }
        if let Ok(rows) = lib.journal(None, dr_workspace::journal::KEEP as usize) {
            for row in rows {
                if row.state != "live" || row.book.as_deref() != Some(book.id.as_str()) {
                    continue;
                }
                for eff in &row.effects {
                    if eff.kind == "entry"
                        && matches!(
                            eff.action,
                            EffectAction::Created | EffectAction::Updated | EffectAction::Renamed
                        )
                        && v.entry(&eff.id).is_some()
                    {
                        record(&eff.id, (row.ts, row.seq));
                    }
                }
            }
        }
        out
    }

    pub fn natural_title_cmp(a: &str, b: &str) -> Ordering {
        use icu_collator::CollatorPreferences;
        use icu_collator::options::{CollatorOptions, Strength};
        use icu_collator::preferences::CollationNumericOrdering;
        use std::sync::OnceLock;
        static COLLATOR: OnceLock<Option<icu_collator::CollatorBorrowed<'static>>> =
            OnceLock::new();
        let collator = COLLATOR.get_or_init(|| {
            let zh = icu_locale_core::locale!("zh");
            let mut prefs: CollatorPreferences = (&zh).into();
            prefs.numeric_ordering = Some(CollationNumericOrdering::True);
            let mut options = CollatorOptions::default();
            options.strength = Some(Strength::Primary);
            icu_collator::Collator::try_new(prefs, options).ok()
        });
        match collator {
            Some(c) => c.compare(a, b).then_with(|| a.cmp(b)),
            None => a.cmp(b),
        }
    }

    pub fn compare_entries(
        v: &dr_shell::book::v3::BookV3,
        a: &str,
        b: &str,
        sort: SortOrder,
        updated: &UpdatedMap,
    ) -> Ordering {
        match sort {
            SortOrder::Manual => Ordering::Equal,
            SortOrder::Updated => {
                let stamp = |id: &str| {
                    updated.get(id).copied().or_else(|| {
                        v.entry(id)
                            .and_then(|e| e.updated_at.or(e.created_at))
                            .map(|ts| (ts.saturating_mul(1000), 0))
                    })
                };
                match (stamp(a), stamp(b)) {
                    (Some(x), Some(y)) => y.cmp(&x).then_with(|| b.cmp(a)),
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => b.cmp(a),
                }
            }
            SortOrder::Created => {
                let created = |id: &str| v.entry(id).and_then(|e| e.created_at);
                match (created(a), created(b)) {
                    (Some(x), Some(y)) => y.cmp(&x).then_with(|| b.cmp(a)),
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => b.cmp(a),
                }
            }
            SortOrder::Name => {
                let title = |id: &str| v.entry(id).map(|e| e.title.trim()).unwrap_or("");
                let (ta, tb) = (title(a), title(b));
                match (!ta.is_empty(), !tb.is_empty()) {
                    (true, true) => natural_title_cmp(ta, tb).then_with(|| a.cmp(b)),
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    (false, false) => a.cmp(b),
                }
            }
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum DropSlot {
        Before,
        Into,
        After,
    }

    pub fn drop_slot_at(
        bounds: gpui::Bounds<gpui::Pixels>,
        point: gpui::Point<gpui::Pixels>,
        is_level: bool,
        tile: bool,
        can_reorder: bool,
    ) -> DropSlot {
        if !can_reorder {
            return DropSlot::Into;
        }
        if is_level {
            let h = f32::from(bounds.size.height).max(1.0);
            let rel_y = f32::from(point.y - bounds.origin.y);
            if rel_y < h * 0.25 {
                DropSlot::Before
            } else if rel_y > h * 0.75 {
                DropSlot::After
            } else {
                DropSlot::Into
            }
        } else if tile {
            if point.x < bounds.center().x {
                DropSlot::Before
            } else {
                DropSlot::After
            }
        } else if point.y < bounds.center().y {
            DropSlot::Before
        } else {
            DropSlot::After
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum Drop {
        Residence {
            parent: Option<String>,
            anchor: Option<(String, bool)>,
        },
        Membership {
            host: String,
        },
        MoveMembership {
            from_host: String,
            to_host: String,
        },
    }

    /// Resolve a UI drop slot against `onto`, distinguishing same-folder
    /// manual reorder (`Before`/`After`) from moving into a folder or
    /// assigning membership (`Into`). When `can_reorder` is false (such as
    /// viewing by time/name, Islands, grouped by storyline, or a root header),
    /// same-folder reordering is refused while cross-folder moves and
    /// memberships remain available.
    pub fn resolve_drop(
        book: &Book,
        entry: &str,
        onto: &str,
        slot: DropSlot,
        can_reorder: bool,
        is_member: bool,
    ) -> Option<Drop> {
        resolve_drop_with(book, entry, onto, slot, can_reorder, is_member, false)
    }

    /// Whether dropping a living row onto `onto` attaches the entry rather than
    /// moving it in (`kernel-v5.md` §5, §16, `v5-tracks.md` T9.1): dragging in
    /// the left tree moves house only, refusing accept-only entries; onto an
    /// entry with both switches on it moves in, or attaches while ⌥ is held
    /// (`attach`); onto a plain level it moves in even with ⌥ held.
    pub fn drop_attaches(book: &Book, onto: &str, attach: bool) -> Option<bool> {
        let v = book.v3()?;
        let level = v.entry(onto)?.level;
        let accepts = v.accepts_members(onto);
        match (level, accepts) {
            (true, true) => Some(attach),
            (false, true) => None,
            (true, false) => Some(false),
            (false, false) => None,
        }
    }

    /// Resolves dragging a hung row (`from_host`) onto `onto` in the left tree
    /// (`W31Hung`, `v5-tracks.md` T9.1): moves the hang from `from_host` to
    /// `onto` when `onto` accepts members, leaving residence untouched;
    /// dropping onto a non-accepting entry, the same host, or the entry's own
    /// residence parent is refused.
    pub fn resolve_hung_drop(
        book: &Book,
        entry: &str,
        from_host: &str,
        onto: &str,
    ) -> Option<Drop> {
        if entry == onto || from_host == onto {
            return None;
        }
        let v = book.v3()?;
        if !v.accepts_members(onto) {
            return None;
        }
        let graph = Graph::of(book)?;
        let id = entry.parse().ok()?;
        let target = onto.parse().ok()?;
        v.entry(entry)?;
        let source_parent = model::effective_parent_id(graph.entries.get(&id)?, &graph.entries);
        if source_parent.as_ref() == Some(&target) {
            return None;
        }
        model::check_membership(&target, &id, &graph.entries, &graph.templates).ok()?;
        Some(Drop::MoveMembership {
            from_host: from_host.into(),
            to_host: onto.into(),
        })
    }

    /// [`resolve_drop`], with ⌥ held (`attach`) or not.
    #[allow(clippy::too_many_arguments)]
    pub fn resolve_drop_with(
        book: &Book,
        entry: &str,
        onto: &str,
        slot: DropSlot,
        can_reorder: bool,
        is_member: bool,
        attach: bool,
    ) -> Option<Drop> {
        if entry == onto {
            return None;
        }
        let v = book.v3()?;
        let graph = Graph::of(book)?;
        let id = entry.parse().ok()?;
        let target = onto.parse().ok()?;
        v.entry(entry)?;
        let source_parent = model::effective_parent_id(graph.entries.get(&id)?, &graph.entries);
        if is_member && (!v.levels.contains_key(onto) || slot != DropSlot::Into) {
            return None;
        }
        match slot {
            DropSlot::Into => {
                if v.levels.contains_key(onto) {
                    if drop_attaches(book, onto, attach)? {
                        model::check_membership(&target, &id, &graph.entries, &graph.templates)
                            .ok()?;
                        return Some(Drop::Membership { host: onto.into() });
                    }
                    if source_parent.as_ref() == Some(&target) {
                        return None;
                    }
                    model::check_entry_move(&graph.entries, &id, Some(&target)).ok()?;
                    model::check_parent_is_level(Some(&target), &graph.entries).ok()?;
                    Some(Drop::Residence {
                        parent: Some(onto.into()),
                        anchor: None,
                    })
                } else {
                    let parent =
                        model::effective_parent_id(graph.entries.get(&target)?, &graph.entries);
                    if source_parent == parent {
                        return None;
                    }
                    model::check_entry_move(&graph.entries, &id, parent.as_ref()).ok()?;
                    model::check_parent_is_level(parent.as_ref(), &graph.entries).ok()?;
                    Some(Drop::Residence {
                        parent: parent.map(|id| id.to_string()),
                        anchor: None,
                    })
                }
            }
            DropSlot::Before | DropSlot::After => {
                if !can_reorder || is_member {
                    return None;
                }
                let after = slot == DropSlot::After;
                let parent =
                    model::effective_parent_id(graph.entries.get(&target)?, &graph.entries);
                model::check_entry_move(&graph.entries, &id, parent.as_ref()).ok()?;
                model::check_parent_is_level(parent.as_ref(), &graph.entries).ok()?;
                Some(Drop::Residence {
                    parent: parent.map(|id| id.to_string()),
                    anchor: Some((onto.into(), after)),
                })
            }
        }
    }

    pub fn drop_target(book: &Book, entry: &str, onto: &str, after: bool) -> Option<Drop> {
        drop_target_with(book, entry, onto, after, false)
    }

    /// [`drop_target`], with ⌥ held (`attach`) or not.
    pub fn drop_target_with(
        book: &Book,
        entry: &str,
        onto: &str,
        after: bool,
        attach: bool,
    ) -> Option<Drop> {
        if entry == onto {
            return None;
        }
        let v = book.v3()?;
        let graph = Graph::of(book)?;
        let id = entry.parse().ok()?;
        let target = onto.parse().ok()?;
        v.entry(entry)?;
        let target_entry = graph.entries.get(&target)?;
        if drop_attaches(book, onto, attach) == Some(true) {
            model::check_membership(&target, &id, &graph.entries, &graph.templates).ok()?;
            Some(Drop::Membership { host: onto.into() })
        } else if target_entry.is_level() {
            model::check_entry_move(&graph.entries, &id, Some(&target)).ok()?;
            model::check_parent_is_level(Some(&target), &graph.entries).ok()?;
            Some(Drop::Residence {
                parent: Some(onto.into()),
                anchor: None,
            })
        } else if v.accepts_members(onto) {
            None
        } else {
            let parent = model::effective_parent_id(target_entry, &graph.entries);
            model::check_entry_move(&graph.entries, &id, parent.as_ref()).ok()?;
            model::check_parent_is_level(parent.as_ref(), &graph.entries).ok()?;
            Some(Drop::Residence {
                parent: parent.map(|id| id.to_string()),
                anchor: Some((onto.into(), after)),
            })
        }
    }
    pub struct DropMutation {
        edit: Mutation,
        moving: String,
        target: Drop,
    }
    pub fn prepare_resolved_drop(
        book: &Book,
        entry: &str,
        target: Drop,
    ) -> Result<DropMutation, WsError> {
        let v = book
            .v3()
            .ok_or_else(|| WsError::Invalid("a book of the current format is required".into()))?;
        let mut edit = match &target {
            Drop::Residence { parent, .. } => {
                prepare(book, "entry.move", json!({"id":entry,"parent":parent}))
            }
            Drop::Membership { host } => {
                prepare(book, "membership.add", json!({"member":entry,"host":host}))
            }
            Drop::MoveMembership { to_host, .. } => prepare(
                book,
                "membership.add",
                json!({"member":entry,"host":to_host}),
            ),
        }?;
        if let Drop::MoveMembership { from_host, .. } = &target
            && let Some(pre) = v.shown_precondition(&RecordKey::membership(from_host, entry))
            && !edit
                .preconditions
                .records
                .iter()
                .any(|r| !r.if_replaced && r.key == pre.key)
        {
            edit.preconditions.records.push(pre);
        }
        if let Drop::Residence {
            parent,
            anchor: Some((onto, _)),
        } = &target
        {
            let mut keys = vec![
                RecordKey::children_of(parent.as_deref()),
                RecordKey::entry(onto),
            ];
            if let Some(pid) = parent.as_deref() {
                keys.extend(
                    v.timeline_views
                        .iter()
                        .filter(|tv| {
                            tv.deleted_at.is_none() && tv.lanes.iter().any(|l| l.entry == pid)
                        })
                        .map(|tv| RecordKey::timeline_view(&tv.id)),
                );
            }
            for key in keys {
                if let Some(pre) = v.shown_precondition(&key)
                    && !edit
                        .preconditions
                        .records
                        .iter()
                        .any(|r| !r.if_replaced && r.key == pre.key)
                {
                    edit.preconditions.records.push(pre);
                }
            }
        }
        Ok(DropMutation {
            edit,
            moving: entry.into(),
            target,
        })
    }
    pub fn prepare_drop(
        book: &Book,
        entry: &str,
        onto: &str,
        after: bool,
    ) -> Result<DropMutation, WsError> {
        prepare_drop_with(book, entry, onto, after, false)
    }
    /// [`prepare_drop`], with ⌥ held (`attach`) or not.
    pub fn prepare_drop_with(
        book: &Book,
        entry: &str,
        onto: &str,
        after: bool,
        attach: bool,
    ) -> Result<DropMutation, WsError> {
        let target = drop_target_with(book, entry, onto, after, attach)
            .ok_or_else(|| WsError::Invalid("entry cannot be placed here".into()))?;
        prepare_resolved_drop(book, entry, target)
    }
    impl DropMutation {
        fn resolve_index(&mut self, lib: &Workspace) -> Result<bool, WsError> {
            if let Drop::Residence {
                parent,
                anchor: Some((onto, after)),
            } = &self.target
            {
                // The command's index counts raw tree siblings, including
                // logical trash, also in a folder that is a lane in a view
                // (its order is its manual order, DV 2026-11-16). Never use
                // the filtered sidebar row number.
                let entries = lib.call(
                    &Actor::User,
                    "entry.list",
                    json!({"book":self.edit.input["book"],"all":true,"trashed":true}),
                )?["output"]
                    .clone();
                let entries: Vec<dr_workspace::commands::v3::types::Entry> =
                    serde_json::from_value(entries)
                        .map_err(|e| WsError::Internal(e.to_string()))?;
                let siblings: Vec<_> = entries.iter().filter(|e| e.parent == *parent).collect();
                let current_pos = siblings.iter().position(|e| e.id == self.moving);
                let index = siblings
                    .iter()
                    .copied()
                    .filter(|e| e.id != self.moving)
                    .position(|e| e.id == *onto)
                    .ok_or_else(|| WsError::Invalid("drop anchor is no longer a sibling".into()))?
                    + usize::from(*after);
                self.edit.input["index"] = json!(index);
                return Ok(current_pos != Some(index));
            }
            Ok(true)
        }
        pub fn commit(mut self, lib: &Workspace) -> Result<Value, WsError> {
            self.resolve_index(lib)?;
            let book = self.edit.input["book"].clone();
            let moving = self.moving.clone();
            let remove_from = match &self.target {
                Drop::MoveMembership { from_host, .. } => Some(from_host.clone()),
                _ => None,
            };
            let out = self.edit.commit(lib)?;
            if let Some(from_host) = remove_from {
                lib.call(
                    &Actor::User,
                    "membership.remove",
                    json!({ "book": book, "host": from_host, "member": moving }),
                )?;
            }
            Ok(out)
        }
        pub fn commit_if_changed(mut self, lib: &Workspace) -> Result<Option<Value>, WsError> {
            if !self.resolve_index(lib)? {
                return Ok(None);
            }
            self.commit(lib).map(Some)
        }
    }
    pub fn prepare_board(
        book: &Book,
        scope: &str,
        entry: &str,
        position: (f64, f64),
    ) -> Result<Mutation, WsError> {
        let v = book
            .v3()
            .ok_or_else(|| WsError::Invalid("a book of the current format is required".into()))?;
        if v.entry(entry).is_none() {
            return Err(WsError::Invalid("entry is no longer live".into()));
        }
        prepare(
            book,
            "layout.put",
            json!({
                "scope": scope,
                "mode": "board",
                "positions": { entry: [position.0, position.1] },
            }),
        )
    }
}
