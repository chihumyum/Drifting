//! Synthetic acceptance transport, not an application/service protocol.
use base64::{engine::general_purpose::STANDARD, Engine};
use drifting_document::{DocumentSession, Edit, NativeReplacement};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use yrs::{updates::decoder::Decode, Doc, ReadTxn, StateVector, Transact, Update};

fn bytes(request: &Value, key: &str) -> Result<Vec<u8>, String> {
    STANDARD
        .decode(request[key].as_str().ok_or("Missing binary input")?)
        .map_err(|e| e.to_string())
}
fn call(sessions: &mut HashMap<String, DocumentSession>, r: Value) -> Result<Value, String> {
    let name = r["session"].as_str().ok_or("Missing session")?;
    if r["command"] == "open" {
        if sessions.contains_key(name) {
            return Err("Session already exists".into());
        }
        let session = DocumentSession::with_test_client_id(
            r["clientId"].as_u64().ok_or("Missing client ID")?,
        )?;
        sessions.insert(name.into(), session);
        return Ok(json!({"yrs": drifting_document::YRS_VERSION}));
    }
    if r["command"] == "close" {
        sessions.remove(name);
        return Ok(Value::Null);
    }
    let session = sessions.get_mut(name).ok_or("Unknown session")?;
    let encoding = r["encoding"].as_u64().unwrap_or(1) as u8;
    match r["command"].as_str().ok_or("Missing command")? {
        "apply" => {
            session.apply_remote(&bytes(&r, "update")?, encoding)?;
            Ok(json!({"pending": session.has_pending()}))
        }
        "beginDraft" => {
            session.begin_draft(
                serde_json::from_value(r["start"].clone()).map_err(|e| e.to_string())?,
            )?;
            Ok(Value::Null)
        }
        "commitDraft" => {
            session.commit_draft(
                serde_json::from_value(r["commit"].clone()).map_err(|e| e.to_string())?,
            )?;
            Ok(json!(session.native_projection()?))
        }
        "cancelDraft" => {
            session.cancel_draft(r["key"].as_str().ok_or("Missing draft key")?);
            Ok(Value::Null)
        }
        "forkInput" => Ok(json!(session.fork_input(
            r["key"].as_str().ok_or("Missing input key")?.into(),
            r["source"].as_str()
        )?)),
        "replaceInput" => Ok(json!(session.replace_input(
            serde_json::from_value(r["edit"].clone()).map_err(|e| e.to_string())?
        )?)),
        "dropInput" => {
            session.drop_input(r["key"].as_str().ok_or("Missing input key")?);
            Ok(Value::Null)
        }
        "state" => Ok(
            json!({"semantic": session.semantic()?, "stateVector": STANDARD.encode(session.state_vector()), "pending": session.has_pending()}),
        ),
        "projection" => {
            serde_json::to_value(session.native_projection()?).map_err(|e| e.to_string())
        }
        "setComments" => {
            session.set_comment_anchors(
                serde_json::from_value(r["records"].clone()).map_err(|e| e.to_string())?,
            )?;
            Ok(json!(session.comment_anchor_records()))
        }
        "comments" => Ok(json!(session.comment_anchor_records())),
        "select" => {
            session.set_selection(
                serde_json::from_value(r["selection"].clone()).map_err(|e| e.to_string())?,
            )?;
            Ok(json!(session.native_projection()?.selections))
        }
        "dropSelection" => {
            session.drop_selection(r["viewId"].as_str().ok_or("Missing view identity")?);
            Ok(Value::Null)
        }
        "replace" => {
            let mapping = session.replace_native(
                serde_json::from_value::<NativeReplacement>(r["edit"].clone())
                    .map_err(|e| e.to_string())?,
            )?;
            let mut result =
                serde_json::to_value(session.native_projection()?).map_err(|e| e.to_string())?;
            result["mappedComments"] = json!(r["comments"].as_array().map(|anchors| anchors
                .iter()
                .map(|anchor| mapping.map_comment_anchor(anchor))
                .collect::<Vec<_>>()));
            result["mappedPoints"] = json!(r["points"].as_array().map(|points| points
                .iter()
                .map(|point| mapping.map_point(
                    point["block"].as_str().unwrap_or(""),
                    point["offset"]
                        .as_u64()
                        .unwrap_or(u64::MAX)
                        .try_into()
                        .unwrap_or(u32::MAX),
                    point["before"].as_bool().unwrap_or(false)
                ))
                .collect::<Vec<_>>()));
            result["mapping"] = json!(mapping);
            Ok(result)
        }
        "formatNative" => {
            session.format_native(
                serde_json::from_value(r["edit"].clone()).map_err(|e| e.to_string())?,
            )?;
            Ok(json!(session.native_projection()?))
        }
        "export" => {
            let vector = r
                .get("stateVector")
                .map(|_| bytes(&r, "stateVector"))
                .transpose()?;
            Ok(json!(
                STANDARD.encode(session.update(vector.as_deref(), encoding)?)
            ))
        }
        "probeUpstreamV2" => {
            // Test-only reproducer bypasses the production v1 emission guard.
            let doc = Doc::new();
            doc.transact_mut()
                .apply_update(
                    Update::decode_v1(&session.update(None, 1)?).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
            let bytes = doc
                .transact()
                .encode_state_as_update_v2(&StateVector::default());
            Ok(json!(STANDARD.encode(bytes)))
        }
        "edit" => {
            session.edit(
                serde_json::from_value::<Edit>(r["edit"].clone()).map_err(|e| e.to_string())?,
            )?;
            Ok(Value::Null)
        }
        "undo" => Ok(json!(session.undo())),
        "redo" => Ok(json!(session.redo())),
        "anchor" => Ok(json!(STANDARD.encode(session.anchor(
            r["block"].as_str().ok_or("Missing block")?,
            r["offset"].as_u64().ok_or("Missing offset")? as u32,
            r["before"].as_bool().unwrap_or(false)
        )?))),
        "resolve" => Ok(session
            .resolve_anchor(&bytes(&r, "anchor")?)?
            .unwrap_or(Value::Null)),
        _ => Err("Unknown command".into()),
    }
}
fn main() {
    let mut sessions = HashMap::new();
    for line in io::stdin().lock().lines() {
        let result = line
            .map_err(|e| e.to_string())
            .and_then(|line| serde_json::from_str(&line).map_err(|e| e.to_string()))
            .and_then(|request| call(&mut sessions, request));
        let reply = match result {
            Ok(value) => json!({"ok": true, "value": value}),
            Err(error) => json!({"ok": false, "error": error}),
        };
        println!("{reply}");
        io::stdout().flush().unwrap();
    }
}
