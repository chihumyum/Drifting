//! Common review card display DTOs; canonical scopes live in v3.
use dr_workspace::dto::CommentInfo;
/// Which kinds are listed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Filter {
    #[default]
    All,
    Comments,
    Todos,
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
            Place::V3(crate::v3::Target::Entry { id, module }) => {
                format!("entry:{id}/{}", module.as_deref().unwrap_or_default())
            }
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
