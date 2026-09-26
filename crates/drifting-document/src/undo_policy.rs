//! Equivalent to the old collaboration plugin's nonempty-parent protection,
//! extended to all XML containers and their metadata when the parent survives.
use yrs::{block::ItemContent, types::TypeRef, undo::DeleteFilterItem, TransactionMut};

pub(crate) fn allow_delete(_: &TransactionMut, item: DeleteFilterItem<'_>) -> bool {
    if let ItemContent::Type(branch) = item.content {
        if matches!(
            branch.type_ref(),
            TypeRef::Text | TypeRef::XmlText | TypeRef::XmlElement(_) | TypeRef::XmlFragment
        ) {
            return branch.content_len() == 0;
        }
    }
    // Undo visits children, then their attributes, then their parent. Keep a
    // protected node's ID, heading level and opaque attributes too; otherwise
    // surviving remote text would become identity-less/read-only. This applies
    // only when the node itself is a deletion candidate in this undo item.
    if item.key.is_some() && item.parent_scheduled {
        if let Some(parent) = item.parent {
            if matches!(parent.type_ref(), TypeRef::XmlElement(_)) && parent.content_len() > 0 {
                return false;
            }
        }
    }
    true
}
