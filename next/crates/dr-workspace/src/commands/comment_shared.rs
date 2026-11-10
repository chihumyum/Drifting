//! Shared comment DTOs and anchor validation for canonical v3 commands.
use crate::dto::AnchorBytes;
use crate::{Result, WsError};
use dr_doc::anchor::Anchor;
use dr_model::DocId;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct CommentUpdateIn {
    pub book: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// `open` or `resolved`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub priority: Option<Option<String>>,
    /// `note` or `todo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The Agent conversation started from this TODO.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::commands::double_option"
    )]
    pub agent_conversation: Option<Option<String>>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CommentReanchorIn {
    pub book: String,
    pub id: String,
    /// The anchor as the editor holds it (dr-doc's encoding, base64);
    /// `null` removes the anchor (the comment stays on its paragraph or
    /// entity).
    #[serde(deserialize_with = "crate::commands::double_option")]
    #[schemars(with = "AnchorOrNull")]
    pub anchor: Option<Option<AnchorBytes>>,
}
/// The schema of a field that must be given and may be `null` (schemars
/// makes every `Option` optional).
struct AnchorOrNull;

impl JsonSchema for AnchorOrNull {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "AnchorOrNull".into()
    }
    fn inline_schema() -> bool {
        true
    }
    fn json_schema(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
        g.subschema_for::<Option<AnchorBytes>>()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct TodoMarkerIn {
    /// The paragraph's block id.
    pub block: String,
    /// The task text after the marker.
    #[serde(default)]
    pub task: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct TodoProjected {
    /// TODOs made for new markers.
    pub created: Vec<String>,
    /// Open TODOs whose marker or paragraph is gone, deleted.
    pub removed: Vec<String>,
    /// Open TODOs whose marker is missing here, kept because this device
    /// has not yet received the prose they were made from (sync brings the
    /// book and the prose separately).
    pub waiting: Vec<String>,
}
/// What a projected TODO keeps in its metadata: the version of the prose
/// it was made from (peer → operations seen), so another device deletes it
/// only once it has that prose too. (Round six also kept the seeded text,
/// to put back a body two devices had both seeded; dr-doc's seed change,
/// `BookTxn::project_todo`, makes that impossible, and a stored `seed` is
/// ignored.)
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct ProjectionMeta {
    #[serde(default)]
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) prose_vv: BTreeMap<String, i64>,
}
pub(crate) fn decode_anchor(bytes: &AnchorBytes) -> Result<Anchor> {
    let bad = || WsError::invalid("the anchor is not two cursors of dr-doc's encoding");
    let a = Anchor::decode(&bytes.bytes().ok_or_else(bad)?).ok_or_else(bad)?;
    let body = loro::ContainerID::new_root(dr_doc::schema::prose::BODY, loro::ContainerType::Text);
    for c in [&a.start, &a.end] {
        if c.container != body {
            return Err(WsError::invalid("the anchor is not in a prose body"));
        }
    }
    Ok(a)
}
pub(crate) fn anchor_known_in(vv: &loro::VersionVector, doc: &DocId, a: &Anchor) -> Result<()> {
    for c in [&a.start, &a.end] {
        if let Some(id) = c.id
            && !vv.includes_id(id)
        {
            return Err(WsError::invalid(format!("the anchor is not in {doc}")));
        }
    }
    Ok(())
}
pub(crate) fn has_seen(vv: &loro::VersionVector, meta: Option<&str>) -> bool {
    let Some(m) = meta.and_then(|m| serde_json::from_str::<ProjectionMeta>(m).ok()) else {
        return true;
    };
    m.prose_vv.iter().all(|(peer, end)| {
        peer.parse::<u64>()
            .is_ok_and(|p| i64::from(vv.get(&p).copied().unwrap_or(0)) >= *end)
    })
}
pub const EMPTY_MARKER_TASK: &str = "（此处待办）";
pub(crate) const MARKER_META_KIND: &str = "todo-autoparse";
