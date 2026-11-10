//! Stable canonical page targets carried by removal events.
use dr_model::id::{EntryId, MaterialId, ModuleId};
use dr_model::v3::EntryTemplateId;
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum NavTarget {
    Book,
    Entry {
        id: EntryId,
        module: Option<ModuleId>,
    },
    Template(EntryTemplateId),
    Material(MaterialId),
}
impl NavTarget {
    pub fn key(&self) -> String {
        match self {
            Self::Book => "book".into(),
            Self::Entry {
                id,
                module: Some(module),
            } => format!("entry:{id}/{module}"),
            Self::Entry { id, module: None } => format!("entry:{id}"),
            Self::Template(id) => format!("template:{id}"),
            Self::Material(id) => format!("material:{id}"),
        }
    }
}
