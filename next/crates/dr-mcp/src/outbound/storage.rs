use std::collections::BTreeMap;

use dr_platform::secrets::SecretStore;
use dr_store::Library;
use serde::{Deserialize, Serialize};

use super::types::*;

pub(super) const SCOPE: &str = "mcp.outbound";

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Record {
    pub info: ServerInfo,
    pub catalog_revision: String,
}

pub(super) fn key(book: &str, id: &str) -> String {
    format!("{book}/{id}")
}
pub(super) fn read(lib: &Library, book: &str, id: &str) -> crate::Result<Option<Record>> {
    lib.local_read(|conn| {
        Ok(conn.query_row(
            "SELECT (SELECT value FROM local_state WHERE scope = ?1 AND key = ?2
             AND EXISTS (SELECT 1 FROM loro_doc WHERE doc_id = ?3 AND kind = 'book'))",
            [SCOPE, &key(book, id), &format!("book:{book}")],
            |row| row.get::<_, Option<String>>(0),
        )?)
    })
    .map_err(|_| "MCP configuration could not be read".to_owned())?
    .map(|raw| serde_json::from_str(&raw).map_err(|_| "invalid stored MCP configuration".into()))
    .transpose()
}

pub(super) fn list(lib: &Library, book: &str) -> crate::Result<Vec<Record>> {
    let _ = dr_model::id::BookId::parse(book).map_err(|_| "invalid MCP book")?;
    if lib
        .doc_info(&format!("book:{book}"))
        .map_err(|_| "MCP book could not be read")?
        .is_none()
    {
        return Err("MCP book is unavailable".into());
    }
    lib.local_entries(SCOPE, Some(book))
        .map_err(|_| "MCP configurations could not be read")?
        .into_iter()
        .map(|row| {
            serde_json::from_str(&row.value).map_err(|_| "invalid stored MCP configuration".into())
        })
        .collect()
}

pub(super) fn put(
    lib: &Library,
    book: &str,
    record: &Record,
    expected: Option<&str>,
) -> crate::Result<()> {
    let raw = serde_json::to_string(record).map_err(|_| "invalid MCP configuration")?;
    let mut conflict = false;
    lib.local_write(|tx| {
        // The book and CAS share a writer transaction, so a final purge cannot
        // be followed by an orphan configuration or catalog resurrection.
        let stored: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM loro_doc WHERE doc_id = ?1 AND kind = 'book')",
            [format!("book:{book}")],
            |row| row.get(0),
        )?;
        if !stored {
            return Err(dr_store::StoreError::NotFound(book.to_owned()));
        }
        let old = tx.get_state(SCOPE, &key(book, &record.info.id))?;
        let revision = old
            .as_deref()
            .and_then(|s| serde_json::from_str::<Record>(s).ok())
            .map(|r| r.info.revision);
        if revision.as_deref() != expected || (old.is_some() && revision.is_none()) {
            conflict = true;
            return Ok(());
        }
        tx.set_state(SCOPE, &key(book, &record.info.id), &raw, Some(book))
    })
    .map_err(|_| "MCP configuration could not be saved")?;
    if conflict {
        Err("MCP configuration changed; reload before editing".into())
    } else {
        Ok(())
    }
}

pub(super) fn save(
    lib: &Library,
    store: &SecretStore,
    book: &str,
    draft: ServerDraft,
) -> crate::Result<Record> {
    save_inner(lib, store, book, draft, |_| {})
}

fn save_inner(
    lib: &Library,
    store: &SecretStore,
    book: &str,
    draft: ServerDraft,
    before_commit: impl FnOnce(&Record),
) -> crate::Result<Record> {
    list(lib, book)?;
    let old = match &draft.id {
        Some(id) => read(lib, book, id)?,
        None => None,
    };
    if old.as_ref().map(|r| r.info.revision.as_str()) != draft.expected_revision.as_deref() {
        return Err("MCP configuration changed; reload before editing".into());
    }
    let (record, fresh) = build(store, draft, old.as_ref())?;
    before_commit(&record);
    if let Err(error) = put(
        lib,
        book,
        &record,
        old.as_ref().map(|r| r.info.revision.as_str()),
    ) {
        delete_secrets(store, &fresh);
        return Err(error);
    }
    if let Some(old) = old {
        let retained = refs(&record);
        let obsolete = refs(&old)
            .into_iter()
            .filter(|key| !retained.contains(key))
            .collect::<Vec<_>>();
        delete_secrets(store, &obsolete);
    }
    Ok(record)
}

pub(super) fn remove(
    lib: &Library,
    book: &str,
    id: &str,
    expected: &str,
) -> crate::Result<Option<Record>> {
    let mut removed = None;
    lib.local_write(|tx| {
        let old = tx.get_state(SCOPE, &key(book, id))?;
        if let Some(old) = old.and_then(|s| serde_json::from_str::<Record>(&s).ok())
            && old.info.revision == expected
        {
            tx.remove_state(SCOPE, &key(book, id))?;
            removed = Some(old);
        }
        Ok(())
    })
    .map_err(|_| "MCP configuration could not be removed")?;
    if removed.is_none() {
        return Err("MCP configuration changed; reload before editing".into());
    }
    Ok(removed)
}

pub(super) fn values(config: &TransportConfig) -> &BTreeMap<String, ConfigValue> {
    match config {
        TransportConfig::Stdio { env, .. } => env,
        TransportConfig::Http { headers, .. } => headers,
    }
}

pub(super) fn materialize(
    store: &SecretStore,
    config: &TransportConfig,
) -> crate::Result<BTreeMap<String, String>> {
    values(config)
        .iter()
        .map(|(name, value)| {
            let value = match value {
                ConfigValue::Public(value) => value.clone(),
                ConfigValue::Secret { reference } => store
                    .get(reference)
                    .map_err(|_| "MCP credential could not be read")?
                    .ok_or("MCP credential is unavailable")?,
            };
            Ok((name.clone(), value))
        })
        .collect()
}

pub(super) fn build(
    store: &SecretStore,
    draft: ServerDraft,
    old: Option<&Record>,
) -> crate::Result<(Record, Vec<String>)> {
    if draft.name.trim().is_empty() || draft.name.len() > 200 {
        return Err("invalid MCP server name".into());
    }
    let id = draft.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err("invalid MCP server id".into());
    }
    let prior = old.map(|r| values(&r.info.transport));
    let mut fresh = Vec::new();
    let mut map =
        |inputs: BTreeMap<String, SecretInput>| -> crate::Result<BTreeMap<String, ConfigValue>> {
            if inputs.len() > 64 {
                return Err("MCP value limit exceeded".into());
            }
            let mut result = BTreeMap::new();
            for (name, value) in inputs {
                let value = match value {
                    SecretInput::Public(value) => ConfigValue::Public(value),
                    SecretInput::Keep => match prior.and_then(|values| values.get(&name)) {
                        Some(ConfigValue::Secret { reference }) => ConfigValue::Secret {
                            reference: reference.clone(),
                        },
                        _ => return Err("MCP credential cannot be retained at this key".into()),
                    },
                    SecretInput::Set(value) => {
                        let reference = format!("mcp.outbound.{}", uuid::Uuid::new_v4().simple());
                        fresh.push(reference.clone());
                        store
                            .set(&reference, &value)
                            .map_err(|_| "MCP credential could not be saved")?;
                        ConfigValue::Secret { reference }
                    }
                };
                result.insert(name, value);
            }
            Ok(result)
        };
    let built = (|| {
        let transport = match draft.transport {
            TransportDraft::Stdio {
                command,
                args,
                cwd,
                env,
            } => TransportConfig::Stdio {
                command,
                args,
                cwd,
                env: map(env)?,
            },
            TransportDraft::Http { url, headers } => TransportConfig::Http {
                url,
                headers: map(headers)?,
            },
        };
        let actual = materialize(store, &transport)?;
        match &transport {
            TransportConfig::Stdio {
                command, args, cwd, ..
            } => super::stdio::validate(command, args, cwd.as_deref(), &actual)?,
            TransportConfig::Http { url, .. } => {
                super::destination::validate_url(url)?;
                super::http::headers(&actual)?;
            }
        }
        Ok(Record {
            info: ServerInfo {
                id,
                name: draft.name,
                enabled: draft.enabled,
                revision: uuid::Uuid::new_v4().to_string(),
                transport,
                status: if draft.enabled {
                    Status::Disconnected
                } else {
                    Status::Disabled
                },
                tools: Vec::new(),
            },
            catalog_revision: uuid::Uuid::new_v4().to_string(),
        })
    })();
    match built {
        Ok(record) => Ok((record, fresh)),
        Err(error) => {
            delete_secrets(store, &fresh);
            Err(error)
        }
    }
}

pub(super) fn refs(record: &Record) -> Vec<String> {
    values(&record.info.transport)
        .values()
        .filter_map(|value| match value {
            ConfigValue::Secret { reference } => Some(reference.clone()),
            _ => None,
        })
        .collect()
}
pub(super) fn delete_secrets(store: &SecretStore, refs: &[String]) {
    for reference in refs {
        let _ = store.delete(reference);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_testkit::seed::{self, Preset};

    fn draft() -> ServerDraft {
        ServerDraft {
            id: Some("synthetic".into()),
            expected_revision: None,
            name: "Synthetic".into(),
            enabled: false,
            transport: TransportDraft::Http {
                url: "http://127.0.0.1:1/mcp".into(),
                headers: BTreeMap::from([(
                    "authorization".into(),
                    SecretInput::Set("synthetic-secret".into()),
                )]),
            },
        }
    }

    #[test]
    fn book_purge_between_secret_creation_and_configuration_commit_rolls_back_fresh_refs() {
        let directory = tempfile::tempdir().unwrap();
        let library =
            Library::open(directory.path(), dr_store::LibraryOptions::new("m32-test")).unwrap();
        let seed = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seed.books[0].book_id().to_string();
        seed.write_to(&library).unwrap();
        let store = SecretStore::in_memory();
        let mut fresh = Vec::new();
        let result = save_inner(&library, &store, &book, draft(), |record| {
            fresh = refs(record);
            assert_eq!(fresh.len(), 1);
            assert!(store.get(&fresh[0]).unwrap().is_some());
            for doc in library.docs(Some(&book), None).unwrap() {
                library.purge_doc(&doc.doc_id).unwrap();
            }
        });
        assert!(result.is_err());
        assert!(
            library
                .local_entries(SCOPE, Some(&book))
                .unwrap()
                .is_empty()
        );
        assert!(store.get(&fresh[0]).unwrap().is_none());
        assert!(read(&library, &book, "synthetic").unwrap().is_none());
    }

    #[test]
    fn removed_book_rejects_catalog_and_status_updates_before_last_document_purge() {
        let directory = tempfile::tempdir().unwrap();
        let library =
            Library::open(directory.path(), dr_store::LibraryOptions::new("m32-test")).unwrap();
        let seed = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seed.books[0].book_id().to_string();
        seed.write_to(&library).unwrap();
        let store = SecretStore::in_memory();
        let record = save(&library, &store, &book, draft()).unwrap();
        let previous = library.local_entries(SCOPE, Some(&book)).unwrap()[0]
            .value
            .clone();
        library.purge_doc(&format!("book:{book}")).unwrap();
        let mut updated = record.clone();
        updated.catalog_revision = "new-catalog".into();
        updated.info.status = Status::Ready;
        assert!(put(&library, &book, &updated, Some(&record.info.revision)).is_err());
        assert_eq!(
            library.local_entries(SCOPE, Some(&book)).unwrap()[0].value,
            previous
        );
        assert!(read(&library, &book, &record.info.id).unwrap().is_none());
        assert!(list(&library, &book).is_err());
        delete_secrets(&store, &refs(&record));
    }
}
