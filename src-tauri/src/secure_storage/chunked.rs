//! Values longer than one Windows credential holds.
//!
//! Windows Credential Manager keeps at most 2560 bytes per credential
//! (`CRED_MAX_CREDENTIAL_BLOB_SIZE`), and `keyring` stores a password as
//! UTF-16, so one entry holds about 1280 characters. The ChatGPT subscription's
//! OAuth tokens and Hosted sessions are longer. A long value is split across
//! credentials `<key>#<generation>.<index>`, and the credential under `<key>`
//! names them: `drifting-chunks:v1:<generation>:<count>:<sha256>`. Every part
//! stays in the OS credential store; nothing falls back to a file.
//!
//! A write stores the new parts under a fresh generation before it replaces
//! the head, then removes the previous generation's parts, so an interrupted
//! write leaves either the old value or the new one. A missing or altered part
//! fails the read rather than returning a partial secret.

use sha2::{Digest, Sha256};

const MARKER: &str = "drifting-chunks:v1:";
/// UTF-16 code units per credential, under the 1280 Windows allows.
pub(crate) const MAX_UNITS: usize = 1200;
const MAX_PARTS: usize = 256;

/// One credential store, by key. `delete` succeeds when nothing is stored.
pub(crate) trait RawStore {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

struct Manifest {
    generation: String,
    count: usize,
    digest: String,
}

impl Manifest {
    fn parse(head: &str) -> Option<Self> {
        let rest = head.strip_prefix(MARKER)?;
        let mut fields = rest.split(':');
        let generation = fields.next()?;
        let count = fields.next()?.parse().ok()?;
        let digest = fields.next()?;
        let valid = fields.next().is_none()
            && !generation.is_empty()
            && generation.chars().all(|c| c.is_ascii_hexdigit())
            && (1..=MAX_PARTS).contains(&count)
            && digest.len() == 64
            && digest.chars().all(|c| c.is_ascii_hexdigit());
        valid.then(|| Self {
            generation: generation.into(),
            count,
            digest: digest.into(),
        })
    }

    fn head(&self) -> String {
        format!("{MARKER}{}:{}:{}", self.generation, self.count, self.digest)
    }
}

fn part_key(key: &str, generation: &str, index: usize) -> String {
    format!("{key}#{generation}.{index}")
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn fits(value: &str) -> bool {
    value.encode_utf16().count() <= MAX_UNITS
}

/// Pieces of at most `MAX_UNITS` UTF-16 units, split between characters.
fn split(value: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut start, mut units) = (0, 0);
    for (offset, character) in value.char_indices() {
        let width = character.len_utf16();
        if units + width > MAX_UNITS {
            parts.push(&value[start..offset]);
            start = offset;
            units = 0;
        }
        units += width;
    }
    parts.push(&value[start..]);
    parts
}

fn delete_parts(store: &impl RawStore, key: &str, manifest: &Manifest) {
    for index in 0..manifest.count {
        let _ = store.delete(&part_key(key, &manifest.generation, index));
    }
}

pub(crate) fn read(store: &impl RawStore, key: &str) -> Result<Option<String>, String> {
    let Some(head) = store.get(key)? else {
        return Ok(None);
    };
    if !head.starts_with(MARKER) {
        return Ok(Some(head));
    }
    let manifest = Manifest::parse(&head).ok_or("secure storage value is damaged")?;
    let mut value = String::new();
    for index in 0..manifest.count {
        let part = store
            .get(&part_key(key, &manifest.generation, index))?
            .ok_or("secure storage value is incomplete")?;
        value.push_str(&part);
    }
    if digest(&value) != manifest.digest {
        return Err("secure storage value is incomplete".into());
    }
    Ok(Some(value))
}

pub(crate) fn write(
    store: &impl RawStore,
    key: &str,
    value: &str,
    generation: &str,
) -> Result<(), String> {
    let previous = store
        .get(key)
        .ok()
        .flatten()
        .and_then(|head| Manifest::parse(&head));
    if fits(value) && !value.starts_with(MARKER) {
        store.set(key, value)?;
    } else {
        let parts = split(value);
        if parts.len() > MAX_PARTS {
            return Err("secure storage value is too long".into());
        }
        let manifest = Manifest {
            generation: generation.into(),
            count: parts.len(),
            digest: digest(value),
        };
        for (index, part) in parts.iter().enumerate() {
            if let Err(error) = store.set(&part_key(key, generation, index), part) {
                delete_parts(store, key, &manifest);
                return Err(error);
            }
        }
        if let Err(error) = store.set(key, &manifest.head()) {
            delete_parts(store, key, &manifest);
            return Err(error);
        }
    }
    if let Some(previous) = previous.filter(|previous| previous.generation != generation) {
        delete_parts(store, key, &previous);
    }
    Ok(())
}

pub(crate) fn remove(store: &impl RawStore, key: &str) -> Result<(), String> {
    let previous = store
        .get(key)
        .ok()
        .flatten()
        .and_then(|head| Manifest::parse(&head));
    store.delete(key)?;
    if let Some(previous) = previous {
        delete_parts(store, key, &previous);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    /// Credential Manager's limit: 2560 bytes of UTF-16.
    #[derive(Default)]
    struct Windows {
        entries: RefCell<BTreeMap<String, String>>,
        fail_on: Option<&'static str>,
    }

    impl RawStore for Windows {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.entries.borrow().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            if value.encode_utf16().count() * 2 > 2560 {
                return Err("blob too large".into());
            }
            if self.fail_on.is_some_and(|fail| key.ends_with(fail)) {
                return Err("write failed".into());
            }
            self.entries.borrow_mut().insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.entries.borrow_mut().remove(key);
            Ok(())
        }
    }

    fn token(length: usize) -> String {
        "eyJhbGciOiJSUzI1NiJ9.片段🙂"
            .chars()
            .cycle()
            .take(length)
            .collect()
    }

    #[test]
    fn short_values_stay_in_one_credential() {
        let store = Windows::default();
        write(&store, "provider.deepseek", "sk-short", "a1").unwrap();
        assert_eq!(store.entries.borrow().len(), 1);
        assert_eq!(
            read(&store, "provider.deepseek").unwrap().as_deref(),
            Some("sk-short")
        );
    }

    #[test]
    fn a_long_session_round_trips_across_credentials_with_wide_characters() {
        let store = Windows::default();
        let session = token(9000);
        write(&store, "oauth.chatgpt", &session, "a1").unwrap();
        assert!(store.entries.borrow().len() > 2);
        for value in store.entries.borrow().values() {
            assert!(value.encode_utf16().count() <= MAX_UNITS);
        }
        assert_eq!(read(&store, "oauth.chatgpt").unwrap(), Some(session));
    }

    #[test]
    fn replacing_or_removing_a_long_value_leaves_no_parts_behind() {
        let store = Windows::default();
        write(&store, "oauth.chatgpt", &token(5000), "a1").unwrap();
        let newer = token(3000);
        write(&store, "oauth.chatgpt", &newer, "b2").unwrap();
        assert!(store
            .entries
            .borrow()
            .keys()
            .all(|key| !key.contains("#a1.")));
        assert_eq!(read(&store, "oauth.chatgpt").unwrap(), Some(newer));
        write(&store, "oauth.chatgpt", "short", "c3").unwrap();
        assert_eq!(store.entries.borrow().len(), 1);
        write(&store, "oauth.chatgpt", &token(4000), "d4").unwrap();
        remove(&store, "oauth.chatgpt").unwrap();
        assert!(store.entries.borrow().is_empty());
        assert_eq!(read(&store, "oauth.chatgpt").unwrap(), None);
    }

    #[test]
    fn an_interrupted_write_keeps_the_previous_value() {
        let mut store = Windows::default();
        let older = token(4000);
        write(&store, "oauth.chatgpt", &older, "a1").unwrap();
        store.fail_on = Some("#b2.2");
        assert!(write(&store, "oauth.chatgpt", &token(6000), "b2").is_err());
        assert!(store
            .entries
            .borrow()
            .keys()
            .all(|key| !key.contains("#b2.")));
        assert_eq!(read(&store, "oauth.chatgpt").unwrap(), Some(older));
    }

    #[test]
    fn a_missing_or_altered_part_fails_closed() {
        let store = Windows::default();
        write(&store, "oauth.chatgpt", &token(4000), "a1").unwrap();
        store
            .entries
            .borrow_mut()
            .insert("oauth.chatgpt#a1.1".into(), "tampered".into());
        assert!(read(&store, "oauth.chatgpt").is_err());
        store.entries.borrow_mut().remove("oauth.chatgpt#a1.1");
        assert!(read(&store, "oauth.chatgpt").is_err());
        store
            .entries
            .borrow_mut()
            .insert("oauth.chatgpt".into(), format!("{MARKER}zz:1:00"));
        assert!(read(&store, "oauth.chatgpt").is_err());
    }
}
