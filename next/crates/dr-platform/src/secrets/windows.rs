//! Generic credentials in Windows Credential Manager, in `keyring` 3.6's
//! layout (the 0.1 client's `windows-native` store): target `<key>.<service>`,
//! user name `<key>`, the value as UTF-16LE, persisted per user
//! (`CRED_PERSIST_ENTERPRISE`). `chunked` splits values over 1200 UTF-16 units
//! before they reach this store.
//!
//! Only `cargo check --target x86_64-pc-windows-msvc` runs on a Mac; the CI
//! Windows job runs the tests, and the ignored integration test exercises the
//! real store.

use std::ffi::c_void;

use windows::Win32::Foundation::{ERROR_NOT_FOUND, FILETIME};
use windows::Win32::Security::Credentials::{
    CRED_FLAGS, CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_ENTERPRISE, CRED_TYPE_GENERIC,
    CREDENTIALW, CredDeleteW, CredFree, CredReadW, CredWriteW,
};
use windows::core::{PCWSTR, PWSTR};

use super::{RawStore, Result, SecretError};

pub(crate) struct CredentialManager {
    service: String,
}

impl CredentialManager {
    pub(crate) fn new(service: &str) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn target(&self, key: &str) -> Vec<u16> {
        wide(&format!("{key}.{}", self.service))
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn platform(operation: &'static str, error: windows::core::Error) -> SecretError {
    SecretError::Platform {
        operation,
        code: i64::from(error.code().0),
    }
}

fn is_not_found(error: &windows::core::Error) -> bool {
    error.code() == ERROR_NOT_FOUND.to_hresult()
}

impl RawStore for CredentialManager {
    fn get(&self, key: &str) -> Result<Option<String>> {
        let target = self.target(key);
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `target` is NUL-terminated and outlives the call; on success
        // `credential` points to a block CredFree releases below.
        let read = unsafe {
            CredReadW(
                PCWSTR::from_raw(target.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut credential,
            )
        };
        match read {
            Err(error) if is_not_found(&error) => return Ok(None),
            Err(error) => return Err(platform("read", error)),
            Ok(()) if credential.is_null() => return Ok(None),
            Ok(()) => {}
        }
        // SAFETY: CredReadW succeeded, so `credential` is valid until CredFree,
        // and its blob is readable for CredentialBlobSize bytes.
        let bytes = unsafe {
            let credential = &*credential;
            let bytes = if credential.CredentialBlob.is_null() {
                Vec::new()
            } else {
                std::slice::from_raw_parts(
                    credential.CredentialBlob,
                    credential.CredentialBlobSize as usize,
                )
                .to_vec()
            };
            CredFree(credential as *const CREDENTIALW as *const c_void);
            bytes
        };
        decode_utf16le(&bytes).map(Some)
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        let mut blob: Vec<u8> = value.encode_utf16().flat_map(u16::to_le_bytes).collect();
        if blob.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
            return Err(SecretError::TooLong);
        }
        let mut target = self.target(key);
        let mut user = wide(key);
        let mut comment = wide("Drifting");
        let credential = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR::from_raw(target.as_mut_ptr()),
            Comment: PWSTR::from_raw(comment.as_mut_ptr()),
            LastWritten: FILETIME::default(),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_ENTERPRISE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: PWSTR::null(),
            UserName: PWSTR::from_raw(user.as_mut_ptr()),
        };
        // SAFETY: every pointer in `credential` refers to a buffer above that
        // outlives the call.
        let written = unsafe { CredWriteW(&credential, 0) };
        blob.fill(0);
        written.map_err(|error| platform("write", error))
    }

    fn delete(&self, key: &str) -> Result<()> {
        let target = self.target(key);
        // SAFETY: `target` is NUL-terminated and outlives the call.
        match unsafe { CredDeleteW(PCWSTR::from_raw(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(error) if is_not_found(&error) => Ok(()),
            Err(error) => Err(platform("delete", error)),
        }
    }
}

/// keyring's decoding: an even number of bytes of valid UTF-16LE.
fn decode_utf16le(bytes: &[u8]) -> Result<String> {
    let (pairs, rest) = bytes.as_chunks::<2>();
    if !rest.is_empty() {
        return Err(SecretError::Encoding);
    }
    let units: Vec<u16> = pairs.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
    String::from_utf16(&units).map_err(|_| SecretError::Encoding)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_decode_as_keyring_writes_them() {
        let bytes: Vec<u8> = "sk-片段🙂"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(decode_utf16le(&bytes).unwrap(), "sk-片段🙂");
        assert_eq!(decode_utf16le(&[0x41]), Err(SecretError::Encoding));
        assert_eq!(decode_utf16le(&[0x00, 0xD8]), Err(SecretError::Encoding));
    }

    #[test]
    fn targets_are_key_dot_service() {
        let store = CredentialManager::new("Drifting");
        assert_eq!(store.target("byok.openai"), wide("byok.openai.Drifting"));
    }
}
