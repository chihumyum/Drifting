//! Common review card display DTOs; canonical scopes live in v3.
use dr_workspace::dto::CommentInfo;
/// Which kinds are listed (retained for multi-column hosts until T9).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Filter {
    #[default]
    All,
    Comments,
    Todos,
}
/// Row 1 status filter (`未解决`, `已解决`, `全部`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StatusFilter {
    #[default]
    Open,
    Resolved,
    All,
}
impl StatusFilter {
    pub const ALL: [Self; 3] = [Self::Open, Self::Resolved, Self::All];
    pub fn index(self) -> usize {
        Self::ALL.iter().position(|f| *f == self).unwrap_or(0)
    }
}
/// Row 2 origin filter (`全部`, `手写`, `标记`, `清单`, `Agent`, `读者`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OriginFilter {
    #[default]
    All,
    Manual,
    Marker,
    Task,
    Agent,
    Reader,
}
impl OriginFilter {
    pub const ALL: [Self; 6] = [
        Self::All,
        Self::Manual,
        Self::Marker,
        Self::Task,
        Self::Agent,
        Self::Reader,
    ];
    pub fn index(self) -> usize {
        Self::ALL.iter().position(|f| *f == self).unwrap_or(0)
    }
    pub fn matches(self, origin: &str) -> bool {
        match self {
            Self::All => true,
            Self::Manual => origin == "manual",
            Self::Marker => origin == "marker",
            Self::Task => origin == "task",
            Self::Agent => origin == "agent",
            Self::Reader => origin == "reader",
        }
    }
}
/// Where a group's items are.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Place {
    /// On an entity.
    /// V3 source identity stays separate from legacy DTO/navigation targets.
    V3(crate::v3::Target),
    /// On something that is gone (in the trash, deleted).
    Gone,
    /// On nothing.
    Floating,
}
#[derive(Clone, Debug)]
pub struct Group {
    pub place: Place,
    pub items: Vec<CommentInfo>,
}
impl Group {
    /// A key for the group's element ids.
    pub fn key(&self) -> String {
        match &self.place {
            Place::V3(crate::v3::Target::Entry { id, module }) => match module.as_deref() {
                Some(m) if !m.is_empty() => format!("entry:{id}/{m}"),
                _ => format!("entry:{id}"),
            },
            Place::V3(crate::v3::Target::Material(id)) => format!("material:{id}"),
            Place::Gone => "gone".into(),
            Place::Floating => "floating".into(),
        }
    }
}
/// The open and the resolved groups.
#[derive(Clone, Debug, Default)]
pub struct Listing {
    pub open: Vec<Group>,
    pub resolved: Vec<Group>,
    /// How many resolved items there are.
    pub resolved_count: usize,
}
impl Filter {
    pub const ALL: [Self; 3] = [Self::All, Self::Comments, Self::Todos];
    pub fn index(self) -> usize {
        Self::ALL.iter().position(|f| *f == self).unwrap_or(0)
    }
}
