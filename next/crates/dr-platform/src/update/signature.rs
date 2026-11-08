//! minisign signatures in Tauri's wrapping: the public key and every `.sig`
//! are the minisign file's text, base64-encoded once more. The 0.1 release
//! workflow signs with `tauri signer`, which always makes prehashed (`ED`)
//! signatures; unlike Tauri, this verifier refuses the legacy non-prehashed
//! form, and it reads the artifact in pieces instead of holding it in memory.
//!
//! A good signature also hands back its trusted comment, which the key
//! signed too: `tauri signer` and `update-tool sign` write
//! `timestamp:<seconds>\tfile:<file name>`, and the file name carries the
//! version ([`Verified::signed_file`]).

use std::fs::File;
use std::io::Read;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use minisign_verify::{PublicKey, Signature};

#[derive(Debug, thiserror::Error)]
pub enum SignatureError {
    #[error("the updater public key is not a minisign public key")]
    Key,
    #[error("the update signature is malformed")]
    Malformed,
    #[error("the update was signed with a different key")]
    WrongKey,
    #[error("the update does not match its signature")]
    Invalid,
    #[error("could not read the downloaded update: {0}")]
    Io(#[from] std::io::Error),
}

/// The updater public key a release build is compiled with, the same
/// variable and value the 0.1 release workflow uses
/// (`vars.DRIFTING_UPDATER_PUBLIC_KEY`). Builds without it cannot update.
pub fn compiled_in_key() -> Option<&'static str> {
    option_env!("DRIFTING_UPDATER_PUBLIC_KEY")
        .map(str::trim)
        .filter(|key| !key.is_empty())
}

pub struct UpdaterKey(PublicKey);

/// What a good signature vouches for besides the bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    /// The signed trusted comment.
    pub trusted_comment: String,
}

impl Verified {
    /// The `file:` the signer named in the trusted comment, if any.
    pub fn signed_file(&self) -> Option<&str> {
        self.trusted_comment
            .split('\t')
            .find_map(|field| field.strip_prefix("file:"))
            .map(str::trim)
            .filter(|name| !name.is_empty())
    }
}

impl std::fmt::Debug for UpdaterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("UpdaterKey(..)")
    }
}

/// Tauri's base64 wrapping, or the minisign text itself.
fn unwrap_text(value: &str) -> Option<String> {
    let value = value.trim();
    if value.starts_with("untrusted comment:") {
        return Some(value.to_owned());
    }
    let bytes = STANDARD.decode(value).ok()?;
    String::from_utf8(bytes).ok()
}

impl UpdaterKey {
    /// Takes Tauri's form (base64 of the `.pub` file), the `.pub` file's text,
    /// or the bare base64 key line.
    pub fn parse(value: &str) -> Result<Self, SignatureError> {
        if let Some(text) = unwrap_text(value)
            && let Ok(key) = PublicKey::decode(&text)
        {
            return Ok(Self(key));
        }
        PublicKey::from_base64(value.trim())
            .map(Self)
            .map_err(|_| SignatureError::Key)
    }

    pub fn verify_bytes(&self, bytes: &[u8], signature: &str) -> Result<Verified, SignatureError> {
        let signature = decode_signature(signature)?;
        self.0.verify(bytes, &signature, false).map_err(classify)?;
        Ok(Verified {
            trusted_comment: signature.trusted_comment().to_owned(),
        })
    }

    pub fn verify_file(&self, path: &Path, signature: &str) -> Result<Verified, SignatureError> {
        let signature = decode_signature(signature)?;
        let mut verifier = self.0.verify_stream(&signature).map_err(classify)?;
        let mut file = File::open(path)?;
        let mut buffer = vec![0; 256 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            verifier.update(&buffer[..read]);
        }
        verifier.finalize().map_err(classify)?;
        Ok(Verified {
            trusted_comment: signature.trusted_comment().to_owned(),
        })
    }
}

fn decode_signature(signature: &str) -> Result<Signature, SignatureError> {
    let text = unwrap_text(signature).ok_or(SignatureError::Malformed)?;
    Signature::decode(&text).map_err(|_| SignatureError::Malformed)
}

fn classify(error: minisign_verify::Error) -> SignatureError {
    match error {
        minisign_verify::Error::UnexpectedKeyId => SignatureError::WrongKey,
        minisign_verify::Error::InvalidSignature => SignatureError::Invalid,
        _ => SignatureError::Malformed,
    }
}

#[cfg(any(test, feature = "test-support"))]
pub mod test_keys {
    //! A throwaway key pair per test, in Tauri's wrapping. Nothing here is
    //! the release key. Other crates' tests get it with the `test-support`
    //! feature.

    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use std::io::Cursor;

    pub struct TestKey {
        pair: minisign::KeyPair,
    }

    impl TestKey {
        pub fn generate() -> Self {
            Self {
                pair: minisign::KeyPair::generate_unencrypted_keypair().unwrap(),
            }
        }

        /// What `DRIFTING_UPDATER_PUBLIC_KEY` holds: base64 of the `.pub` text.
        pub fn public_key(&self) -> String {
            STANDARD.encode(self.pair.pk.to_box().unwrap().into_string())
        }

        /// What a `.sig` file and a manifest's `signature` hold.
        pub fn sign(&self, bytes: &[u8]) -> String {
            self.sign_as(bytes, "test")
        }

        /// Signed with `file:<name>` in the trusted comment, as
        /// `tauri signer` and `update-tool sign` write it.
        pub fn sign_as(&self, bytes: &[u8], file: &str) -> String {
            let signature = minisign::sign(
                Some(&self.pair.pk),
                &self.pair.sk,
                Cursor::new(bytes),
                Some(&format!("timestamp:0\tfile:{file}")),
                None,
            )
            .unwrap();
            STANDARD.encode(signature.into_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_keys::TestKey;
    use super::*;

    #[test]
    fn verifies_what_the_matching_key_signed() {
        let key = TestKey::generate();
        let public = UpdaterKey::parse(&key.public_key()).unwrap();
        let artifact = b"a synthetic update".repeat(1000);
        let signature = key.sign_as(&artifact, "Drifting_0.2.1_aarch64.app.tar.gz");
        let verified = public.verify_bytes(&artifact, &signature).unwrap();
        assert_eq!(
            verified.signed_file(),
            Some("Drifting_0.2.1_aarch64.app.tar.gz")
        );

        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), &artifact).unwrap();
        assert_eq!(
            public.verify_file(file.path(), &signature).unwrap(),
            verified
        );
        assert_eq!(
            Verified {
                trusted_comment: "timestamp:1".into()
            }
            .signed_file(),
            None
        );
    }

    #[test]
    fn refuses_tampering_and_other_keys() {
        let key = TestKey::generate();
        let other = TestKey::generate();
        let public = UpdaterKey::parse(&key.public_key()).unwrap();
        let artifact = b"a synthetic update".to_vec();
        let mut tampered = artifact.clone();
        tampered[0] ^= 1;
        assert!(matches!(
            public.verify_bytes(&tampered, &key.sign(&artifact)),
            Err(SignatureError::Invalid)
        ));
        assert!(matches!(
            public.verify_bytes(&artifact, &other.sign(&artifact)),
            Err(SignatureError::WrongKey)
        ));
        assert!(matches!(
            public.verify_bytes(&artifact, "not base64!"),
            Err(SignatureError::Malformed)
        ));
    }

    #[test]
    fn refuses_an_edited_trusted_comment() {
        let key = TestKey::generate();
        let public = UpdaterKey::parse(&key.public_key()).unwrap();
        let artifact = b"payload".to_vec();
        let text = String::from_utf8(STANDARD.decode(key.sign(&artifact)).unwrap()).unwrap();
        let edited = text.replace("file:test", "file:evil");
        assert_ne!(text, edited);
        assert!(
            public
                .verify_bytes(&artifact, &STANDARD.encode(edited))
                .is_err()
        );
    }

    #[test]
    fn accepts_the_key_in_every_form_it_is_written() {
        let key = TestKey::generate();
        let wrapped = key.public_key();
        let text = String::from_utf8(STANDARD.decode(&wrapped).unwrap()).unwrap();
        let bare = text.lines().nth(1).unwrap().to_owned();
        for form in [wrapped.as_str(), text.as_str(), bare.as_str()] {
            UpdaterKey::parse(form).unwrap();
        }
        assert!(UpdaterKey::parse("nonsense").is_err());
    }
}
