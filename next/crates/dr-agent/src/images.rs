//! Images the author attaches to a message (CM4a).
//!
//! - **What is accepted**: PNG, JPEG and WebP, the formats every route takes
//!   (Anthropic Messages, OpenAI Responses and ChatGPT, Ollama's and other
//!   servers' Chat Completions). GIF is left out: Ollama refuses it and
//!   OpenAI takes only still ones. At most [`MAX_IMAGE_BYTES`] and
//!   [`MAX_IMAGE_SIDE`] pixels a side each (Anthropic's per-image limits, the
//!   strictest), at most [`MAX_IMAGES_PER_MESSAGE`] in one message.
//! - **Where the bytes live**: on this device only, beside the library,
//!   `agent-images/<conversation>/<sha256>.<ext>`, written atomically; the
//!   same bytes twice in one conversation are one file. The synchronized
//!   conversation names each image by [`ImageRef`] (its digest, format, size
//!   in pixels and bytes) in the author message's payload (`images`), never
//!   the bytes. Another device that receives the conversation has no bytes:
//!   it shows a placeholder and tells the model the image is not included.
//!   A conversation's folder goes when the conversation (or its book) was
//!   purged, the next time the library opens ([`sweep`]).
//! - **What a request carries**: when the run's model can see images
//!   ([`crate::RunConfig::sees_images`]), the bytes of the newest images of
//!   the conversation, at most [`MAX_IMAGES_PER_REQUEST`] and
//!   [`MAX_REQUEST_IMAGE_BYTES`] together ([`RequestImages`]); the newest
//!   message always fits. An image left out is a line of text for the model.
//! - **A model that cannot see images**: a message with images is not sent;
//!   the Agent answers with the caller's sentence instead
//!   ([`ImageAttachments::unseen_reply`]).

use std::collections::HashMap;
use std::fmt;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use dr_model::id::ConversationId;
use dr_store::Library;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Largest image (bytes). Base64 makes it 9 786 712 bytes, under Anthropic's
/// 10 MB for one image on the Claude API.
pub const MAX_IMAGE_BYTES: u64 = 7 * 1024 * 1024;
/// Longest side in pixels (Anthropic's 8000 × 8000).
pub const MAX_IMAGE_SIDE: u32 = 8000;
/// Images in one author message.
pub const MAX_IMAGES_PER_MESSAGE: usize = 4;
/// Images one request carries, the newest first. Anthropic applies a
/// stricter size to every image of a request with more than 20.
pub const MAX_IMAGES_PER_REQUEST: usize = 20;
/// Bytes of images one request carries (base64 about 43 MiB, well under
/// Anthropic's 128 MB request). The newest message's four always fit.
pub const MAX_REQUEST_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// The folder beside the library that holds the images.
pub const DIR: &str = "agent-images";

/// Why an image cannot be attached.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ImageError {
    /// Not PNG, JPEG or WebP, or not readable as one.
    #[error("only PNG, JPEG and WebP images can be sent")]
    Unsupported,
    /// Over [`MAX_IMAGE_BYTES`] or [`MAX_IMAGE_SIDE`].
    #[error("the image is too large")]
    TooLarge,
    /// Over [`MAX_IMAGES_PER_MESSAGE`].
    #[error("too many images in one message")]
    TooMany,
}

/// An image as the synchronized conversation names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageRef {
    /// Lowercase hex SHA-256 of the bytes.
    pub sha256: String,
    /// `image/png`, `image/jpeg` or `image/webp`.
    pub mime: String,
    pub width: u32,
    pub height: u32,
    /// Bytes.
    pub size: u64,
}

impl ImageRef {
    /// The file extension of its format; `None` for a format not accepted.
    pub fn extension(&self) -> Option<&'static str> {
        extension(&self.mime)
    }

    /// Whether every field is one this device would have written: a digest
    /// of 64 lowercase hex digits, an accepted format, a size within the
    /// limits. A record from another device that is not is left out.
    pub fn is_valid(&self) -> bool {
        self.sha256.len() == 64
            && self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && self.extension().is_some()
            && (1..=MAX_IMAGE_SIDE).contains(&self.width)
            && (1..=MAX_IMAGE_SIDE).contains(&self.height)
            && (1..=MAX_IMAGE_BYTES).contains(&self.size)
    }

    /// `PNG`, `JPEG` or `WebP`, for a line of text about it.
    pub fn format_name(&self) -> &'static str {
        match self.mime.as_str() {
            "image/png" => "PNG",
            "image/jpeg" => "JPEG",
            "image/webp" => "WebP",
            _ => "image",
        }
    }
}

fn extension(mime: &str) -> Option<&'static str> {
    Some(match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => return None,
    })
}

/// What these bytes are, if they can be attached: the format from the
/// bytes themselves (never a file name), the size from the header.
pub fn inspect(bytes: &[u8]) -> Result<ImageRef, ImageError> {
    let mime = match image::guess_format(bytes).map_err(|_| ImageError::Unsupported)? {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        _ => return Err(ImageError::Unsupported),
    };
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(ImageError::TooLarge);
    }
    let (width, height) = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| ImageError::Unsupported)?
        .into_dimensions()
        .map_err(|_| ImageError::Unsupported)?;
    if width == 0 || height == 0 {
        return Err(ImageError::Unsupported);
    }
    if width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE {
        return Err(ImageError::TooLarge);
    }
    Ok(ImageRef {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        mime: mime.into(),
        width,
        height,
        size: bytes.len() as u64,
    })
}

/// The images an author message brings to [`crate::Runtime::start_with_images`].
#[derive(Clone, Default)]
pub struct ImageAttachments {
    /// The bytes, in the order the author attached them.
    pub images: Vec<Arc<[u8]>>,
    /// What the Agent says, without asking the model, when this run's model
    /// cannot see images: the caller's sentence in the author's language.
    pub unseen_reply: String,
}

impl fmt::Debug for ImageAttachments {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ImageAttachments")
            .field("images", &self.images.len())
            .field("bytes", &self.images.iter().map(|b| b.len()).sum::<usize>())
            .field("unseen_reply", &self.unseen_reply)
            .finish()
    }
}

/// The image bytes one request carries: by the conversation entry that
/// names them and their place in it. An image without bytes here is one the
/// request leaves out.
#[derive(Clone, Default)]
pub struct RequestImages {
    by_entry: Arc<HashMap<EntryImage, Arc<[u8]>>>,
}

/// An image's place: the conversation entry naming it, and which of its
/// images it is.
type EntryImage = (String, usize);

impl RequestImages {
    pub fn get(&self, entry: &str, index: usize) -> Option<&[u8]> {
        self.by_entry
            .get(&(entry.to_owned(), index))
            .map(|bytes| &**bytes)
    }

    pub fn insert(&mut self, entry: impl Into<String>, index: usize, bytes: Arc<[u8]>) {
        Arc::make_mut(&mut self.by_entry).insert((entry.into(), index), bytes);
    }

    pub fn len(&self) -> usize {
        self.by_entry.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_entry.is_empty()
    }

    /// Bytes of all of them together.
    pub fn bytes(&self) -> u64 {
        self.by_entry.values().map(|b| b.len() as u64).sum()
    }
}

impl fmt::Debug for RequestImages {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "RequestImages({} images, {} bytes)",
            self.len(),
            self.bytes()
        )
    }
}

/// An author message's synchronized payload: `{"text": …}`, with `images`
/// only when there are some (so a message without images is what it always
/// was). The journal's projection and the panel's both use this.
pub fn user_payload(text: &str, images: &[ImageRef]) -> Value {
    if images.is_empty() {
        json!({ "text": text })
    } else {
        json!({ "text": text, "images": images })
    }
}

/// The images an author message's payload names, in order. A record that
/// is not one this device would have written ([`ImageRef::is_valid`]) is
/// kept in place as `None`, so the places of the others do not move.
pub fn payload_images(payload: &Value) -> Vec<Option<ImageRef>> {
    payload
        .get("images")
        .and_then(Value::as_array)
        .map(|images| {
            images
                .iter()
                .map(|image| {
                    serde_json::from_value::<ImageRef>(image.clone())
                        .ok()
                        .filter(ImageRef::is_valid)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Which images of `conversation` a request carries: the newest first,
/// at most [`MAX_IMAGES_PER_REQUEST`] and [`MAX_REQUEST_IMAGE_BYTES`]
/// together, each one `read` finds bytes for (an older image that still
/// fits after a larger one did not may go along).
pub(crate) fn select(
    conversation: &[dr_model::conversation::ConversationEntry],
    mut read: impl FnMut(&ImageRef) -> Option<Arc<[u8]>>,
) -> RequestImages {
    let mut images = RequestImages::default();
    let (mut count, mut bytes) = (0_usize, 0_u64);
    for entry in conversation
        .iter()
        .rev()
        .filter(|entry| entry.kind == dr_model::conversation::ConversationEntryKind::User)
    {
        for (index, image) in payload_images(&entry.payload).into_iter().enumerate() {
            let Some(image) = image else { continue };
            if count >= MAX_IMAGES_PER_REQUEST
                || bytes.saturating_add(image.size) > MAX_REQUEST_IMAGE_BYTES
            {
                continue;
            }
            if let Some(data) = read(&image) {
                count += 1;
                bytes += image.size;
                images.insert(entry.id.clone(), index, data);
            }
        }
    }
    images
}

fn folder(lib: &Library) -> PathBuf {
    lib.paths().root.join(DIR)
}

fn path_of(lib: &Library, conversation: &ConversationId, image: &ImageRef) -> Option<PathBuf> {
    if !image.is_valid() {
        return None;
    }
    Some(folder(lib).join(conversation.as_str()).join(format!(
        "{}.{}",
        image.sha256,
        image.extension()?
    )))
}

/// Keeps `bytes` for `conversation` on this device; the same bytes are
/// written once.
pub(crate) fn put(
    lib: &Library,
    conversation: &ConversationId,
    bytes: &[u8],
) -> crate::Result<ImageRef> {
    let image = inspect(bytes).map_err(|e| crate::Error::Protocol(format!("image: {e}")))?;
    let path = path_of(lib, conversation, &image)
        .ok_or_else(|| crate::Error::Protocol("image: invalid record".into()))?;
    if read_path(&path, &image).is_some() {
        return Ok(image);
    }
    write_atomically(&path, bytes)
        .map_err(|e| crate::Error::Protocol(format!("image: cannot store: {e}")))?;
    Ok(image)
}

fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().expect("an image path has a folder");
    std::fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .expect("an image file name");
    let tmp = dir.join(format!(".{name}.{}.tmp", dr_model::id::new_uuid_v7()));
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)?;
        #[cfg(unix)]
        if let Ok(dir) = std::fs::File::open(dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn read_path(path: &Path, image: &ImageRef) -> Option<Vec<u8>> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() != image.size {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    (format!("{:x}", Sha256::digest(&bytes)) == image.sha256).then_some(bytes)
}

/// The bytes of `image` in `conversation`, when this device holds them
/// unchanged (the right size and digest).
pub fn read(lib: &Library, conversation: &ConversationId, image: &ImageRef) -> Option<Vec<u8>> {
    read_path(&path_of(lib, conversation, image)?, image)
}

/// Removes the folders of conversations purged on this device (with their
/// book or alone). Best effort: what cannot be removed now is tried again
/// the next time. Folders of conversations that still exist, or that this
/// device never stored, stay.
pub(crate) fn sweep(lib: &Library) {
    let Ok(entries) = std::fs::read_dir(folder(lib)) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|n| ConversationId::parse(n).ok()) else {
            continue;
        };
        let doc = dr_model::DocId::Conversation(id).to_string();
        if matches!(lib.purged(&doc), Ok(Some(_)))
            && matches!(lib.doc_info(&doc), Ok(None))
            && entry.file_type().is_ok_and(|t| t.is_dir())
        {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests;
