//! Generic passwords in the login keychain: service `<service>`, account
//! `<key>`, the value as UTF-8. This is what `keyring` 3.6 (the 0.1 client's
//! `apple-native` store) writes, and the 0.1 client read it with the same
//! query as `get` below.
//!
//! Reads skip items that would need authentication instead of showing a
//! dialog, as the 0.1 client did (`skip_authenticated_items`), so a background
//! read never prompts. Apple documents that this only binds Data Protection
//! keychain items; a login-keychain item whose access list does not name this
//! app still prompts. The release build avoids that by keeping the 0.1
//! client's bundle id and Developer ID team, which is what the items' access
//! lists name.

use std::ptr::{self, NonNull};

use objc2_core_foundation::{CFData, CFDictionary, CFRetained, CFString, CFType, kCFBooleanTrue};
use objc2_security::{
    SecItemAdd, SecItemCopyMatching, SecItemDelete, SecItemUpdate, errSecAuthFailed,
    errSecInteractionNotAllowed, errSecItemNotFound, errSecSuccess, kSecAttrAccount,
    kSecAttrService, kSecClass, kSecClassGenericPassword, kSecMatchLimit, kSecMatchLimitOne,
    kSecReturnAttributes, kSecReturnData, kSecUseAuthenticationUI, kSecUseAuthenticationUISkip,
    kSecValueData,
};

use super::{RawStore, Result, SecretError};

pub(crate) struct Keychain {
    service: CFRetained<CFString>,
}

// SAFETY: CFString is immutable once created, and Core Foundation's retain
// and release are thread-safe.
unsafe impl Send for Keychain {}
// SAFETY: as above; `Keychain` never mutates the string.
unsafe impl Sync for Keychain {}

enum Want {
    Data,
    Attributes,
}

impl Keychain {
    pub(crate) fn new(service: &str) -> Self {
        Self {
            service: CFString::from_str(service),
        }
    }

    fn copy_matching(&self, key: &str, want: Want) -> Result<Option<CFRetained<CFType>>> {
        let account = CFString::from_str(key);
        let true_value = kCFBooleanTrue_value()?;
        // SAFETY: reading immutable constants exported by the Security framework.
        let (class, service, account_key, limit, limit_one, ui, skip, return_key) = unsafe {
            (
                kSecClass,
                kSecAttrService,
                kSecAttrAccount,
                kSecMatchLimit,
                kSecMatchLimitOne,
                kSecUseAuthenticationUI,
                kSecUseAuthenticationUISkip,
                match want {
                    Want::Data => kSecReturnData,
                    Want::Attributes => kSecReturnAttributes,
                },
            )
        };
        // SAFETY: as above.
        let generic = unsafe { kSecClassGenericPassword };
        let query = CFDictionary::<CFString, CFType>::from_slices(
            &[class, service, account_key, limit, ui, return_key],
            &[
                generic,
                &self.service,
                &account,
                limit_one,
                skip,
                true_value,
            ],
        );
        let mut result = ptr::null();
        // SAFETY: the query maps Security attribute keys to CF values and
        // `result` is a valid out-pointer.
        let status = unsafe { SecItemCopyMatching(query.as_opaque(), &mut result) };
        // Not found, or present but behind authentication: nothing to read
        // without a prompt, as in the 0.1 client.
        if [
            errSecItemNotFound,
            errSecInteractionNotAllowed,
            errSecAuthFailed,
        ]
        .contains(&status)
        {
            return Ok(None);
        }
        check(status, "read")?;
        let result = NonNull::new(result.cast_mut()).ok_or(SecretError::Platform {
            operation: "read",
            code: 0,
        })?;
        // SAFETY: SecItemCopyMatching follows the Create rule; we own it.
        Ok(Some(unsafe { CFRetained::from_raw(result) }))
    }

    fn item_query(&self, account: &CFString) -> CFRetained<CFDictionary<CFString, CFType>> {
        // SAFETY: reading immutable constants exported by the Security framework.
        let (class, generic, service, account_key) = unsafe {
            (
                kSecClass,
                kSecClassGenericPassword,
                kSecAttrService,
                kSecAttrAccount,
            )
        };
        CFDictionary::<CFString, CFType>::from_slices(
            &[class, service, account_key],
            &[generic, &self.service, account],
        )
    }
}

impl RawStore for Keychain {
    fn get(&self, key: &str) -> Result<Option<String>> {
        let Some(item) = self.copy_matching(key, Want::Data)? else {
            return Ok(None);
        };
        let data = item
            .downcast::<CFData>()
            .map_err(|_| SecretError::Encoding)?;
        String::from_utf8(data.to_vec())
            .map(Some)
            .map_err(|_| SecretError::Encoding)
    }

    fn exists(&self, key: &str) -> Result<bool> {
        self.copy_matching(key, Want::Attributes)
            .map(|item| item.is_some())
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        let account = CFString::from_str(key);
        let data = CFData::from_bytes(value.as_bytes());
        let query = self.item_query(&account);
        // SAFETY: reading an immutable constant exported by the Security framework.
        let data_key = unsafe { kSecValueData };
        let update = CFDictionary::<CFString, CFType>::from_slices(&[data_key], &[&data]);
        // SAFETY: both dictionaries map Security attribute keys to CF values.
        let status = unsafe { SecItemUpdate(query.as_opaque(), update.as_opaque()) };
        if status != errSecItemNotFound {
            return check(status, "write");
        }
        // SAFETY: reading immutable constants exported by the Security framework.
        let (class, generic, service, account_key) = unsafe {
            (
                kSecClass,
                kSecClassGenericPassword,
                kSecAttrService,
                kSecAttrAccount,
            )
        };
        let attributes = CFDictionary::<CFString, CFType>::from_slices(
            &[class, service, account_key, data_key],
            &[generic, &self.service, &account, &data],
        );
        // SAFETY: the dictionary maps Security attribute keys to CF values; a
        // null result pointer asks Security not to return the new item.
        check(
            unsafe { SecItemAdd(attributes.as_opaque(), ptr::null_mut()) },
            "write",
        )
    }

    fn delete(&self, key: &str) -> Result<()> {
        let account = CFString::from_str(key);
        let query = self.item_query(&account);
        // SAFETY: the query maps Security attribute keys to CF values.
        let status = unsafe { SecItemDelete(query.as_opaque()) };
        if status == errSecItemNotFound {
            return Ok(());
        }
        check(status, "delete")
    }
}

#[allow(non_snake_case)]
fn kCFBooleanTrue_value() -> Result<&'static CFType> {
    // SAFETY: reading an immutable constant exported by Core Foundation.
    unsafe { kCFBooleanTrue }
        .map(|value| -> &'static CFType { value })
        .ok_or(SecretError::Platform {
            operation: "read",
            code: 0,
        })
}

fn check(status: i32, operation: &'static str) -> Result<()> {
    if status == errSecSuccess {
        Ok(())
    } else {
        Err(SecretError::Platform {
            operation,
            code: i64::from(status),
        })
    }
}
