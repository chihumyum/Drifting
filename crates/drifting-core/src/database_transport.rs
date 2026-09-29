//! Compact JSON transport for the Tauri database adapter. The database owner
//! and the Apple bridge keep their existing `DatabaseValue` representation.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::database::{DatabaseQueryResult, DatabaseValue};

#[derive(Debug)]
pub struct CompactDatabaseValue(pub DatabaseValue);

impl Serialize for CompactDatabaseValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let DatabaseValue::Blob(bytes) = &self.0 {
            #[derive(Serialize)]
            struct Blob {
                r#type: &'static str,
                value: String,
            }
            Blob {
                r#type: "blobBase64",
                value: STANDARD.encode(bytes),
            }
            .serialize(serializer)
        } else {
            self.0.serialize(serializer)
        }
    }
}

impl<'de> Deserialize<'de> for CompactDatabaseValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "type", content = "value", rename_all = "camelCase")]
        enum Wire {
            Null,
            Integer(String),
            Real(f64),
            Text(String),
            Blob(Vec<u8>),
            BlobBase64(String),
        }
        Ok(Self(match Wire::deserialize(deserializer)? {
            Wire::Null => DatabaseValue::Null,
            Wire::Integer(value) => DatabaseValue::Integer(value),
            Wire::Real(value) => DatabaseValue::Real(value),
            Wire::Text(value) => DatabaseValue::Text(value),
            Wire::Blob(value) => DatabaseValue::Blob(value),
            Wire::BlobBase64(value) => {
                DatabaseValue::Blob(STANDARD.decode(value).map_err(serde::de::Error::custom)?)
            }
        }))
    }
}

#[derive(Serialize)]
pub struct CompactDatabaseQueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<CompactDatabaseValue>>,
}

impl From<DatabaseQueryResult> for CompactDatabaseQueryResult {
    fn from(result: DatabaseQueryResult) -> Self {
        Self {
            columns: result.columns,
            rows: result
                .rows
                .into_iter()
                .map(|row| row.into_iter().map(CompactDatabaseValue).collect())
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compact_roundtrip_preserves_all_bytes_and_existing_value_types() {
        for value in [
            DatabaseValue::Null,
            DatabaseValue::Integer(i64::MIN.to_string()),
            DatabaseValue::Integer(i64::MAX.to_string()),
            DatabaseValue::Real(-0.25),
            DatabaseValue::Text("合成🙂".into()),
            DatabaseValue::Blob(vec![]),
            DatabaseValue::Blob((0..=255).collect()),
        ] {
            let encoded = serde_json::to_value(CompactDatabaseValue(value.clone())).unwrap();
            let decoded: CompactDatabaseValue = serde_json::from_value(encoded).unwrap();
            assert_eq!(decoded.0, value);
        }
        assert_eq!(
            serde_json::to_value(CompactDatabaseValue(DatabaseValue::Blob(vec![0, 127, 255])))
                .unwrap(),
            json!({"type":"blobBase64","value":"AH//"})
        );
        // The existing native bridge wire contract is deliberately unchanged.
        assert_eq!(
            serde_json::to_value(DatabaseValue::Blob(vec![0, 255])).unwrap(),
            json!({"type":"blob","value":[0,255]})
        );
        assert_eq!(
            serde_json::from_value::<CompactDatabaseValue>(json!({"type":"blob","value":[0,255]}))
                .unwrap()
                .0,
            DatabaseValue::Blob(vec![0, 255])
        );
    }

    #[test]
    fn malformed_compact_blobs_are_rejected_before_database_execution() {
        for value in ["A", "AB==", "Zg", "Zg=", "Zg===", "Z g==", "Zg==\n", "__8="] {
            assert!(
                serde_json::from_value::<CompactDatabaseValue>(
                    json!({"type":"blobBase64","value":value})
                )
                .is_err(),
                "{value}"
            );
        }
    }
}
