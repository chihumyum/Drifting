//! Names and positions shared by the commands.

use dr_model::pos::PosKey;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::{Result, WsError};

/// A name unique among `taken` (trimmed, case-insensitive): `base`, else
/// `base 2`, `base 3`, … (the old `makeUniqueNodeTitle`). An empty base
/// becomes `fallback`. Interface and Agent alike (`TITLE-SUFFIX`,
/// `DIV-DUP-TITLE`, `DIV-DUP-CATEGORY`).
pub fn unique_name<'a>(
    base: &str,
    fallback: &str,
    taken: impl IntoIterator<Item = &'a str>,
) -> String {
    let base = match base.trim() {
        "" => fallback.trim(),
        b => b,
    };
    let taken: std::collections::HashSet<String> =
        taken.into_iter().map(|t| t.trim().to_lowercase()).collect();
    if !taken.contains(&base.to_lowercase()) {
        return base.to_string();
    }
    (2u64..)
        .map(|i| format!("{base} {i}"))
        .find(|c| !taken.contains(&c.to_lowercase()))
        .expect("an unused suffix exists")
}

/// Where to put something in an ordered list.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Place {
    /// At the start.
    First,
    /// At the end.
    Last,
    /// Right after the item with this id.
    After(String),
    /// Right before the item with this id.
    Before(String),
}

/// A position key for `place` in a list sorted by position (each item's id
/// and key; the item being moved must already be left out).
pub fn pos_for(items: &[(String, Option<PosKey>)], place: &Place) -> Result<PosKey> {
    let idx = |id: &str| {
        items
            .iter()
            .position(|(i, _)| i == id)
            .ok_or_else(|| WsError::not_found("list item", id))
    };
    // Items without a usable key sort last; place relative to keyed ones.
    let keyed: Vec<&PosKey> = items.iter().filter_map(|(_, k)| k.as_ref()).collect();
    let (before, after): (Option<&PosKey>, Option<&PosKey>) = match place {
        Place::First => (None, keyed.first().copied()),
        Place::Last => (keyed.last().copied(), None),
        Place::After(id) => {
            let i = idx(id)?;
            let me = items[i].1.as_ref();
            let next = items[i + 1..].iter().find_map(|(_, k)| k.as_ref());
            match me {
                Some(k) => (Some(k), next),
                None => (keyed.last().copied(), None),
            }
        }
        Place::Before(id) => {
            let i = idx(id)?;
            let me = items[i].1.as_ref();
            let prev = items[..i].iter().rev().find_map(|(_, k)| k.as_ref());
            match me {
                Some(k) => (prev, Some(k)),
                None => (keyed.last().copied(), None),
            }
        }
    };
    // Equal neighbours (two devices inserted into one gap) leave no room
    // between them; go after both, ties break by id.
    let after = match (before, after) {
        (Some(b), Some(a)) if a <= b => None,
        _ => after,
    };
    PosKey::between(before, after).map_err(|e| WsError::Internal(format!("position key: {e:?}")))
}

/// Encode Loro frontiers for JSON (hex of `Frontiers::encode`).
pub fn frontiers_hex(f: &loro::Frontiers) -> String {
    f.encode().iter().map(|b| format!("{b:02x}")).collect()
}

pub fn frontiers_from_hex(s: &str) -> Result<loro::Frontiers> {
    if !s.len().is_multiple_of(2) {
        return Err(WsError::invalid("frontiers: odd hex length"));
    }
    let bytes = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16))
        .collect::<std::result::Result<Vec<u8>, _>>()
        .map_err(|_| WsError::invalid("frontiers: not hex"))?;
    loro::Frontiers::decode(&bytes).map_err(|e| WsError::invalid(format!("frontiers: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_get_suffixes() {
        assert_eq!(unique_name("Ch", "Untitled", ["a"]), "Ch");
        assert_eq!(unique_name(" ch ", "Untitled", ["CH"]), "ch 2");
        assert_eq!(unique_name("ch", "Untitled", ["ch", "Ch 2"]), "ch 3");
        assert_eq!(unique_name("  ", "Untitled", ["untitled"]), "Untitled 2");
    }

    #[test]
    fn positions_land_between_neighbours() {
        let a = PosKey::first();
        let b = a.after();
        let items = vec![
            ("a".to_string(), Some(a.clone())),
            ("b".into(), Some(b.clone())),
        ];
        let first = pos_for(&items, &Place::First).unwrap();
        assert!(first < a);
        let mid = pos_for(&items, &Place::After("a".into())).unwrap();
        assert!(a < mid && mid < b);
        let mid2 = pos_for(&items, &Place::Before("b".into())).unwrap();
        assert!(a < mid2 && mid2 < b);
        let last = pos_for(&items, &Place::Last).unwrap();
        assert!(last > b);
        assert!(pos_for(&[], &Place::First).is_ok());
        assert!(pos_for(&items, &Place::After("zz".into())).is_err());
    }

    #[test]
    fn frontiers_round_trip() {
        let doc = loro::LoroDoc::new();
        doc.get_text("t").insert(0, "x").unwrap();
        doc.commit();
        let f = doc.oplog_frontiers();
        assert_eq!(frontiers_from_hex(&frontiers_hex(&f)).unwrap(), f);
        assert!(frontiers_from_hex("zz").is_err());
    }
}
