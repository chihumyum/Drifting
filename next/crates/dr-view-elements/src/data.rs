//! Canonical v3 level surface.
pub mod v3 {
    use dr_shell::{book::Book, pages::PageViewHost};
    use dr_workspace::{Actor, Workspace, WritePreconditions, WsError};
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
            lib.call_guarded(&Actor::User, self.command, self.input, self.preconditions)
                .map(|answer| answer["output"].clone())
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
            "is_manuscript",
            "lane",
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
            .filter(|_| v.levels.contains_key(id))
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
    }
    pub fn creation(book: &Book, origin: &str) -> Option<Creation> {
        let v = book.v3()?;
        v.entry(origin)?;
        let graph = Graph::of(book)?;
        let id = origin.parse().ok()?;
        let context = if v.levels.contains_key(origin) {
            Some(id)
        } else {
            model::effective_parent_id(graph.entries.get(&id)?, &graph.entries)
        };
        let home =
            model::resolve_new_entry_residence(context.as_ref(), &graph.entries, &graph.templates);
        // Any template can be created where an entry can live at all.
        let allows = |_: Option<&model::EntryTemplateId>| {
            model::check_parent_is_level(home.as_ref(), &graph.entries).is_ok()
                && model::check_parent_is_level(context.as_ref(), &graph.entries).is_ok()
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
            .and_then(|id| v.levels.get(id.as_str()))
            .and_then(|l| l.settings.default_template.clone());
        let blank = desired.is_none() && allows(None);
        let default = desired.filter(|id| templates.contains(id));
        Some(Creation {
            context: context.map(|id| id.to_string()),
            home: home.map(|id| id.to_string()),
            templates,
            default,
            blank,
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
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum Drop {
        Residence {
            parent: Option<String>,
            anchor: Option<(String, bool)>,
        },
        Membership {
            host: String,
        },
    }
    pub fn drop_target(book: &Book, entry: &str, onto: &str, after: bool) -> Option<Drop> {
        if entry == onto {
            return None;
        }
        let v = book.v3()?;
        let graph = Graph::of(book)?;
        let id = entry.parse().ok()?;
        let target = onto.parse().ok()?;
        v.entry(entry)?;
        if let Some(level) = v.levels.get(onto) {
            if level.settings.accept {
                model::check_membership(&target, &id, &graph.entries, &graph.templates).ok()?;
                return Some(Drop::Membership { host: onto.into() });
            }
            model::check_entry_move(&graph.entries, &id, Some(&target)).ok()?;
            model::check_parent_is_level(Some(&target), &graph.entries).ok()?;
            Some(Drop::Residence {
                parent: Some(onto.into()),
                anchor: None,
            })
        } else {
            let parent = model::effective_parent_id(graph.entries.get(&target)?, &graph.entries);
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
    pub fn prepare_drop(
        book: &Book,
        entry: &str,
        onto: &str,
        after: bool,
    ) -> Result<DropMutation, WsError> {
        let target = drop_target(book, entry, onto, after)
            .ok_or_else(|| WsError::Invalid("entry cannot be placed here".into()))?;
        let edit = match &target {
            Drop::Residence { parent, .. } => {
                prepare(book, "entry.move", json!({"id":entry,"parent":parent}))
            }
            Drop::Membership { host } => {
                prepare(book, "membership.add", json!({"member":entry,"host":host}))
            }
        }?;
        Ok(DropMutation {
            edit,
            moving: entry.into(),
            target,
        })
    }
    impl DropMutation {
        pub fn commit(mut self, lib: &Workspace) -> Result<Value, WsError> {
            if let Drop::Residence {
                parent,
                anchor: Some((onto, after)),
            } = &self.target
            {
                // The command's index counts raw tree siblings, including
                // logical trash. Never use the filtered sidebar row number.
                let entries = lib.call(
                    &Actor::User,
                    "entry.list",
                    json!({"book":self.edit.input["book"],"all":true,"trashed":true}),
                )?["output"]
                    .clone();
                let entries: Vec<dr_workspace::commands::v3::types::Entry> =
                    serde_json::from_value(entries)
                        .map_err(|e| WsError::Internal(e.to_string()))?;
                let index = entries
                    .iter()
                    .filter(|e| e.parent == *parent && e.id != self.moving)
                    .position(|e| e.id == *onto)
                    .ok_or_else(|| WsError::Invalid("drop anchor is no longer a sibling".into()))?
                    + usize::from(*after);
                self.edit.input["index"] = json!(index);
            }
            self.edit.commit(lib)
        }
    }
    pub fn prepare_board(
        book: &Book,
        entry: &str,
        position: (f64, f64),
    ) -> Result<Mutation, WsError> {
        let mut layout = book
            .v3()
            .and_then(|v| v.entry(entry))
            .ok_or_else(|| WsError::Invalid("entry is no longer live".into()))?
            .layout;
        layout.board = Some(position);
        prepare_edit(book, entry, json!({"layout":layout}))
    }
}
