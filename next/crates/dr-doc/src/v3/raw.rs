//! Typed raw state for lossless checkpoint validation. Container identities
//! exposed by tree values and rich-text attributes are never normalized away.
use loro::{Container, LoroDoc, LoroValue, ValueOrContainer};
use std::collections::BTreeMap;

pub(super) fn raw_value(v: ValueOrContainer) -> serde_json::Value {
    use serde_json::json;
    match v {
        ValueOrContainer::Value(v) => json!({"value":v}),
        ValueOrContainer::Container(c) => match c {
            Container::Map(m) => {
                let mut values = BTreeMap::new();
                m.for_each(|key, v| {
                    values.insert(key.to_owned(), raw_value(v));
                });
                json!({"map":values})
            }
            Container::Text(t) => json!({"text":t.to_delta()}),
            Container::List(l) => {
                let mut values = Vec::new();
                l.for_each(|v| values.push(raw_value(v)));
                json!({"list":values})
            }
            Container::MovableList(l) => {
                let mut values = Vec::new();
                l.for_each(|v| values.push(raw_value(v)));
                json!({"movable_list":values})
            }
            Container::Tree(t) => {
                let mut meta = BTreeMap::new();
                for node in t.nodes() {
                    if let Ok(m) = t.get_meta(node) {
                        meta.insert(
                            node.to_string(),
                            raw_value(ValueOrContainer::Container(Container::Map(m))),
                        );
                    }
                }
                json!({"tree":t.get_value(),"meta":meta})
            }
            Container::Counter(c) => json!({"counter":c.get_value()}),
            Container::Unknown(c) => {
                use loro::ContainerTrait;
                json!({"unknown":c.id().to_string()})
            }
        },
    }
}
/// Complete typed body state, including every hidden/future root. Used to
/// refuse an atomic restore when the CRDT cannot faithfully reproduce data.
pub fn raw_document_state(doc: &LoroDoc) -> crate::Result<serde_json::Value> {
    let LoroValue::Map(roots) = doc.get_value() else {
        return Err(crate::DocError::NotInProfile(
            "document roots are not a map",
        ));
    };
    let mut values = std::collections::BTreeMap::new();
    for (name, value) in roots.iter() {
        let value = if let LoroValue::Container(id) = value {
            ValueOrContainer::Container(doc.get_container(id.clone()).ok_or(
                crate::DocError::NotInProfile("checkpoint root is unavailable"),
            )?)
        } else {
            ValueOrContainer::Value(value.clone())
        };
        values.insert(name.to_owned(), raw_value(value));
    }
    let mut result = serde_json::to_value(values).expect("raw JSON values");
    result.sort_all_objects();
    Ok(result)
}
