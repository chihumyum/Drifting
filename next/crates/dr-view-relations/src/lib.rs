//! dr-view-relations: relations and relation types (module M17), the 0.1
//! client's `ReferencesPanel` relations section, its link picker and
//! `RelationTypeField`, and the type management of `RelationKindMenu` with
//! `RelationTypeEditor` (desktop).
//!
//! - **「关联」** ([`Relations`]): one entity's relations as cards under its
//!   text (0.1 had it on the element page, under 「字段」). A card shows the
//!   other entity's mark and kind, which way the relation points, its name
//!   (a click opens its page), its type with the roles (a click chooses
//!   another; a type its ends fit only the other way turns it round) and,
//!   for a directed type its ends fit both ways, ⇄. × removes it. Newest
//!   first.
//! - **「＋ 关联实体」** opens the picker in place: the kinds (全部 / 要素 /
//!   章节 / 分类 / 故事线), a search, the book's entities not related yet
//!   (at most 50). The one chosen waits under the search with its
//!   direction (该实体 → 目标, ⇄ to turn it), a type that fits the pair, and
//!   「创建」. The type menu ends with 「新建关系类型」, a new type for that
//!   pair's kinds, chosen once saved (and the types close).
//! - **「编辑类型」** opens the book's relation types ([`TypeManager`]):
//!   each with its colour (the dash; a row of seven and 恢复默认色), its
//!   name and roles (a click edits them), how many relations it has, and
//!   the trash (only a type no relation uses, after a question; the
//!   built-in association is neither changed nor deleted). 「＋ 新建」 opens
//!   the editor: name, 有向 / 对称, the roles, a description, the kinds each
//!   end allows.
//!
//! Everything goes through F3's `relation.*` and `relation_type.*`, off the
//! main thread; F3's events read the lists again, so another window's or
//! an Agent's changes show. Names come from the shell's book snapshot.
//! docs/rust-rewrite/modules/m17-relations.md has the rules, the
//! differences from 0.1 and what the element page still needs to host it.

pub mod data;
pub mod look;
pub mod model;
mod section;
mod types;

pub use section::{MenuFor, Pending, Relations, RelationsEvent};
pub use types::{DeleteTypeDialog, TypeEvent, TypeManager};

use dr_workspace::dto::Target as End;
use gpui::{App, AppContext as _, Entity, WeakEntity, Window};

/// `owner`'s 「关联」 for the page of the window of `ws` (the element page
/// puts it under 「字段」).
pub fn relations(
    owner: End,
    ws: WeakEntity<dr_shell::Workspace>,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Relations> {
    cx.new(|cx| Relations::new(owner, ws, window, cx))
}
